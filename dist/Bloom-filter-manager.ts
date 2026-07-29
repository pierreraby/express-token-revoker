// BloomFilterManager.ts
import { InternalError, ValidationError } from './errors.js';
import type { BloomFilter } from './bloomfilter.js';
import { Mutex } from 'async-mutex';
import { filterInputSchema } from './Inputs-validation.js';
import { BloomFilterFactory } from './BloomFilterFactory.js';
import { BloomFilterBackupManager } from './BloomFilterBackupManager.js';
import type { GenericLogger } from './types.js';

/**
 * Configuration options for the Bloom filter manager.
 */
export interface BloomFilterOptions {
  /** Number of items to store in the filter. */
  numItems: number;
  /** Target false positive rate. */
  fpRate: number;
  /** Filter rotation interval in milliseconds. */
  rotateTime: number;
  /** The id of the bloom filter (same as the revoker id). */
  id: string;
  /** whether to enable backup. */
  backup?: boolean;
  /** Ratio of the rotation time for backups (e.g., 4 for backup every rotateTime / 4). Defaults to no backups. */
  backupRatioTime?: number;
  /** The absolute path to the backup directory. Defaults to a 'backup' directory relative to the current file. */
  backupDir?: string;
  /** Whether to enable the buffer for backup writes. Defaults to false */
  bufferEnabled?: boolean;
  /** Any logger implementing the basic logging methods */
  logger: GenericLogger;
}

export interface EstimatedMetrics {
  /** Estimated number of items in current filter (0 if no filter) */
  currentCount: number;
  /** Estimated number of items in previous filter (0 if no filter) */
  previousCount: number;
  /** Estimated false positive rate of current filter (0 if no filter) */
  currentFpRate: number;
  /** Estimated false positive rate of previous filter (0 if no filter) */
  previousFpRate: number;
}

export interface Configuration {
  /** Number of items to store in the filter */
  numItems: number;
  /** Target false positive rate */
  fpRate: number;
  /** Filter rotation interval in milliseconds */
  rotateTime: number;
  /** Whether backup is enabled */
  backupEnabled: boolean;
  /** Ratio of the rotation time for backups */
  backupRatioTime: number;
}

export interface Metrics {
  /** Estimated metrics of the current and previous filters */
  estimatedMetrics: EstimatedMetrics;
  /** Configuration of the Bloom filter manager */
  configuration: Configuration;
}

/**
 * Manages the bloom filters and their rotation.
 */
export class BloomFilterManager {
  id: string;
  numItems: number;
  InitialNumItems: number;
  fpRate: number;
  previous: BloomFilter | null = null;
  current: BloomFilter | null = null;
  rotationInterval: NodeJS.Timeout | null = null;
  rotateTime: number;
  logger: GenericLogger;
  backupManager: BloomFilterBackupManager | null = null;
  hasRotated: boolean;
  mutex: Mutex;

  /**
   * Creates an instance of BloomFilterManager.
   * @param options - Bloom filter configuration.
   * @throws {ValidationError} If the input is invalid.
   * @throws {InternalError} If an error occurs during initialization.
   */
  constructor(options: BloomFilterOptions) {

    // Validate input
    const { error } = filterInputSchema.validate(options);
    if (error) {
      throw new ValidationError(`Invalid input: ${error.message}`);
    }

    const { numItems, fpRate, rotateTime, id, logger, backup } = options;

    this.id = id;
    this.numItems = numItems;
    this.InitialNumItems = numItems;
    this.fpRate = fpRate;
    this.rotateTime = rotateTime;
    this.logger = logger;
    this.hasRotated = false;
    this.mutex = new Mutex();

    this.logger.info(
      `Initializing BloomFilterManager with numItems=${this.numItems}, fpRate=${this.fpRate}, rotateTime=${this.rotateTime}`
    );

    this.current = BloomFilterFactory.create(this.numItems, this.fpRate);

    if (backup) {
      this.backupManager = new BloomFilterBackupManager(
        options,
        { numItems: this.numItems, fpRate: this.fpRate, k: this.current.k },
        this.logger
      );

      this.#restoreBackup();
      if (this.backupManager.backupRatioTime) {
        this.backupManager.startBackupInterval(this.current);
      }
    }

    this.#startRotationInterval();

  }

  // Note: not testing private methods
  /* c8 ignore start */

  /**
   * Initializes the backup manager and restores the filters from the backup if it exists.
   */
  #restoreBackup(): void {
    if (this.backupManager?.backupExists()) {
      const restoredFilters = this.backupManager.restore('all');
      if (restoredFilters) {
        this.current = restoredFilters.current ?? this.current;
        this.previous = restoredFilters.previous ?? this.previous;
      }
    }
  }

  /**
   * Initializes the timer intervals for filter rotation
   */
  #startRotationInterval(): void {
    this.rotationInterval = setInterval(async () => {
      await this.#rotateWithRetry(); // Utiliser une méthode de rotation avec retry
    }, this.rotateTime);
  }

  /**
   * Stops the Bloom filter rotation interval.
   */
  #stopRotationInterval(): void {
    if (this.rotationInterval !== null) {
      clearInterval(this.rotationInterval);
      this.rotationInterval = null;
      this.logger.debug(`Rotation stopped for id: ${this.id}`);
    }
  }

  /**
   * Rotates the Bloom filter with retries.
   * @throws {InternalError} If an error occurs while rotating the filter.
   * @throws {InternalError} If the maximum number of retries is reached.
   */
  async #rotateWithRetry(): Promise<void> {
    const maxRetries = 3;
    const retryDelay = 5000; // 5 secondes

    for (let i = 0; i < maxRetries; i++) {
      try {
        await this.#rotate();
        return;
      } catch (error) {
        this.logger.error(`Rotation failed (attempt ${i + 1}/${maxRetries}):`, error);
        if (i < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
    }
    this.logger.error('Max retries reached. Stopping rotation.');
    if (this.rotationInterval) {
      clearInterval(this.rotationInterval);
      this.rotationInterval = null;
    }
  }

  /**
   * Rotates the Bloom filters.
   * @throws {InternalError} If an error occurs while rotating the filters.
   */
  async #rotate(): Promise<void> {
    const release = await this.mutex.acquire();
    try {
      if (!this.hasRotated) {
        this.hasRotated = true;
      }
      this.logger.debug('Rotating Bloom filters...');
      if (this.backupManager && this.current) {
        await this.backupManager.backupRotate(this.current);
      }
      this.previous = this.current;
      this.current = BloomFilterFactory.create(this.numItems, this.fpRate);
      // reinitialize the backup interval with the new filter if needed
      if (this.backupManager?.backupRatioTime) {
        this.backupManager.stopBackupInterval();
        this.backupManager.startBackupInterval(this.current);
      }

    } catch (error) {
      const err = error as Error;
      throw new InternalError(`Failed to rotate filters: ${err.message}`);
    } finally {
      release();
    }
  }

  /* c8 ignore stop */

  /**
   * Adds a value to the current Bloom filter and synchronously appends it to the temporary backup file.
   *
   * IMPORTANT: This method uses synchronous file writing (fs.appendFileSync) to ensure that no tokens are lost in case of a crash.
   * This is a deliberate choice made after careful consideration of the following factors:
   *
   * - Low data volume: Only about 50 characters are added per token.
   * - Measured and acceptable synchronous write time: Tests have shown an average write time of 9 µs on my old sata ssd, which has a negligible impact on performance.
   * - No concurrency (currently): There are no other concurrent operations on the temporary file or the filters.
   * - Priority to data integrity: It is crucial to guarantee that no tokens are lost in the event of a crash.
   * - Append-only writes: Simplifies management and reduces risks.
   * - No queue, batching, or mutex: To avoid data loss in memory and maintain simplicity.
   *
   * This approach is a trade-off between performance and data integrity. It is acceptable in this specific case, but should be reevaluated if the
   * data volume, frequency of additions, or complexity of the application increases significantly.
   *
   * @param filterItem - The value to add.
   * @throws {ValidationError} If filterItem is invalid.
   * @throws {InternalError} If writing to the temp file fails.
   */
  add(filterItem: string): void {
    if (typeof filterItem !== 'string' || filterItem.trim() === '') {
      throw new ValidationError('Value must be a non-empty string');
    }
    try {
      this.backupManager?.backupItem(filterItem);
      this.current?.add(filterItem);
    } catch (error) {
      const err = error as Error;
      throw new InternalError(`Failed to add value to Bloom filter: ${err.message}`);
    }
  }

  /**
   * Checks for the presence of a value in the current and previous Bloom filters.
   * @param value - The value to check.
   * @returns `true` if the value might be present, `false` if it is definitely absent.
   * @throws {ValidationError} If the value is not a string.
   */
  has(value: string): boolean {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ValidationError('Value must be a non-empty string');
    }

    return (
      (this.current ? this.current.test(value) : false) ||
      (this.previous ? this.previous.test(value) : false)
    );
  }

  /**
   * Get the estimated metrics of the current and previous Bloom filter.
   * @returns Estimated metrics of the current and previous filters.
   */
  #getEstimatedMetrics(): EstimatedMetrics {
    const metrics: EstimatedMetrics = {
      currentCount: 0,
      previousCount: 0,
      currentFpRate: 0,
      previousFpRate: 0
    };

    if (this.current) {
      metrics.currentCount = this.current.size();
      metrics.currentFpRate = this.current.error();
    }

    if (this.previous && this.hasRotated) {
      metrics.previousCount = this.previous.size();
      metrics.previousFpRate = this.previous.error();
    } else if (!this.hasRotated) {
      this.logger.debug('No previous filter to get metrics before first rotation');
    }
    this.logger.info(`Estimated metrics: ${JSON.stringify(metrics)}`);

    return metrics;
  }

  /**
   * Get metrics of the current and previous Bloom filter.
   * @returns Metrics of the current and previous filters.
   */
  getMetrics(): Metrics {
    const estimatedMetrics = this.#getEstimatedMetrics();
    const configuration: Configuration = {
      numItems: this.numItems,
      fpRate: this.fpRate,
      rotateTime: this.rotateTime,
      backupEnabled: !!this.backupManager,
      backupRatioTime: this.backupManager?.backupRatioTime ?? 0
    };
    return { estimatedMetrics, configuration };
  }

  /**
   * Resets and restores the Bloom filters.
   * @throws {InternalError} If an error occurs while resetting the filters
   */
  async resetAndRestore(): Promise<void> {
    const release = await this.mutex.acquire();
    try {
      this.#stopRotationInterval();
      this.previous = null;
      this.current = BloomFilterFactory.create(this.numItems, this.fpRate);
      this.#startRotationInterval();
      this.logger.debug('Bloom filters reset');
      if (this.backupManager) {
        this.backupManager.stopBackupInterval();
        this.#restoreBackup();
        if (this.backupManager.backupRatioTime) {
          this.backupManager.startBackupInterval(this.current);
        }
      }
    } catch (error) {
      const err = error as Error;
      throw new InternalError(`Failed to reset and restore: ${err.message}`);
    } finally {
      release();
    }
  }

  /**
   * Resets the Bloom filters and deletes the backup files.
   * @throws {InternalError} If an error occurs while resetting the filters.
   */
  async resetAndClearData(): Promise<void> {
    try {
      if (this.backupManager) {
        this.backupManager.deleteBackupFile(this.backupManager.backupCurrentPath, 'Current');
        this.backupManager.deleteBackupFile(this.backupManager.backupPreviousPath, 'Previous');
        this.backupManager.deleteBackupFile(this.backupManager.backupTempFilePath, 'Temporary');
      }
      this.hasRotated = false;
      await this.resetAndRestore(); // Reuse resetAndRestore
    } catch (error) {
      const err = error as Error;
      throw new InternalError(`Failed to reset and clear data: ${err.message}`);
    }
  }

  /**
   * Cleans up resources when the instance is destroyed.
   */
  destroy(): void {
    this.#stopRotationInterval();
    this.backupManager?.stopBackupInterval();
    this.backupManager?.stoptWriteInterval();
    this.backupManager = null;
    this.previous = null;
    this.current = null;
    this.logger.debug('BloomFilterManager destroyed.');
  }
}
