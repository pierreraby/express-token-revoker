// BloomFilterManager.ts
import { InternalError, ValidationError } from './errors.js';
import type { BloomFilter } from './bloomfilter.js';
import { Mutex } from 'async-mutex';
import { filterInputSchema } from './Inputs-validation.js';
import { BloomFilterFactory } from './BloomFilterFactory.js';
import { BloomFilterBackupManager } from './BloomFilterBackupManager.js';
import type { GenericLogger, HealthStatus } from './types.js';

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
  /** Maximum number of tokens to hold in the write buffer before rejecting new additions. Defaults to numItems * 2. */
  bufferMaxSize?: number;
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
  /** Counters since startup (reset on resetAndClearData). */
  counters: {
    /** Successful add() calls. */
    addSucceeded: number;
    /** Failed add() calls. */
    addFailed: number;
    /** has() calls. */
    checks: number;
    /** has() calls that returned true (token found in filter). */
    hits: number;
    /** Completed rotations. */
    rotations: number;
    /** Failed rotation cycles (after all retries). */
    rotationsFailed: number;
  };
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
  /** Counter of insertions into the current filter since last rotation. */
  #currentInsertions = 0;
  /** Maximum ratio of insertions / numItems before add() refuses new tokens. */
  static readonly MAX_SATURATION_RATIO = 10;
  /** Whether the manager is shutting down — add() will be rejected. */
  #shuttingDown = false;
  /** Counters for metrics. */
  #counters = {
    addSucceeded: 0,
    addFailed: 0,
    checks: 0,
    hits: 0,
    rotations: 0,
    rotationsFailed: 0,
  };

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
        this.#counters.rotations++;
        return;
      } catch (error) {
        this.logger.error(`Rotation failed (attempt ${i + 1}/${maxRetries}):`, error);
        if (i < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
        }
      }
    }
    // Never stop the interval — the next tick will retry naturally.
    this.#counters.rotationsFailed++;
    this.logger.error(
      `Max retries reached for this rotation cycle. Will retry on next interval in ${this.rotateTime}ms.`
    );
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

      // Try to persist current filter, but do not abort rotation on failure.
      // Memory rotation continues so that expired tokens are evicted and the
      // false-positive rate stays under control. The health check will report
      // storage as unhealthy.
      if (this.backupManager && this.current) {
        try {
          await this.backupManager.backupRotate(this.current);
        } catch (backupError) {
          this.logger.error(
            `Backup during rotation failed, continuing with memory-only rotation: ${(backupError as Error).message}`
          );
        }
      }

      this.previous = this.current;
      this.current = BloomFilterFactory.create(this.numItems, this.fpRate);
      this.#currentInsertions = 0;

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

    if (this.#shuttingDown) {
      throw new InternalError('Cannot add token: revoker is shutting down.');
    }

    // Reject additions when the filter is critically saturated — adding more
    // tokens to an already-saturated filter only deepens the false-positive
    // problem without providing meaningful revocation guarantees.
    if (this.#currentInsertions > this.numItems * BloomFilterManager.MAX_SATURATION_RATIO) {
      this.#counters.addFailed++;
      throw new InternalError(
        `Cannot add token: filter critically saturated ` +
          `(${this.#currentInsertions} insertions, ${this.numItems} capacity). ` +
          `Token NOT revoked. Check health endpoint.`
      );
    }

    try {
      this.backupManager?.backupItem(filterItem);
      this.current?.add(filterItem);
    } catch (error) {
      this.#counters.addFailed++;
      const err = error as Error;
      throw new InternalError(`Failed to add value to Bloom filter: ${err.message}`);
    }
    this.#currentInsertions++;
    this.#counters.addSucceeded++;
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

    this.#counters.checks++;
    const result =
      (this.current ? this.current.test(value) : false) ||
      (this.previous ? this.previous.test(value) : false);
    if (result) {
      this.#counters.hits++;
    }
    return result;
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
      previousFpRate: 0,
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
      backupRatioTime: this.backupManager?.backupRatioTime ?? 0,
    };
    return { estimatedMetrics, configuration, counters: { ...this.#counters } };
  }

  /**
   * Checks the health of the Bloom filter system.
   *
   * Verifies three components:
   * - **storage**: whether the backup directory is writable (skipped when backup is disabled).
   * - **filter**: whether the current bloom filter is initialized.
   * - **rotation**: whether the rotation interval is running.
   *
   * @returns A structured health status object.
   */
  healthCheck(): HealthStatus {
    const insertionRatio = this.#currentInsertions / this.numItems;

    let filterStatus: HealthStatus['checks']['filter'];
    if (!this.current) {
      filterStatus = { healthy: false, error: 'Current filter is null' };
    } else if (insertionRatio > BloomFilterManager.MAX_SATURATION_RATIO) {
      filterStatus = {
        healthy: false,
        error:
          `Filter critically saturated: ${this.#currentInsertions} insertions ` +
          `(${insertionRatio.toFixed(1)}x capacity). ` +
          `FPR severely degraded, add() is blocked.`,
      };
    } else if (insertionRatio > 2) {
      filterStatus = {
        healthy: true,
        error:
          `Filter moderately saturated: ${this.#currentInsertions} insertions ` +
          `(${insertionRatio.toFixed(1)}x capacity). ` +
          `FPR may be elevated — rotation may be failing.`,
      };
    } else {
      filterStatus = { healthy: true };
    }

    const checks: HealthStatus['checks'] = {
      storage: this.backupManager ? this.backupManager.healthCheckStorage() : { healthy: true },
      filter: filterStatus,
      rotation:
        this.rotationInterval === null
          ? { healthy: false, error: 'Rotation interval is not running' }
          : { healthy: true },
    };

    const healthy = Object.values(checks).every((c) => c.healthy);
    return { healthy, checks };
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
      this.#currentInsertions = 0;
      this.#counters = {
        addSucceeded: 0,
        addFailed: 0,
        checks: 0,
        hits: 0,
        rotations: 0,
        rotationsFailed: 0,
      };
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
      this.#currentInsertions = 0;
      await this.resetAndRestore(); // Reuse resetAndRestore
    } catch (error) {
      const err = error as Error;
      throw new InternalError(`Failed to reset and clear data: ${err.message}`);
    }
  }

  /**
   * Gracefully shuts down the Bloom filter manager.
   *
   * 1. Marks the instance as shutting down so new add() calls are rejected.
   * 2. Waits for any in-progress rotation to complete.
   * 3. Flushes the write buffer one last time (if buffer is enabled).
   * 4. Destroys all resources.
   */
  async shutdown(): Promise<void> {
    this.logger.info(`Shutting down BloomFilterManager ${this.id}...`);
    this.#shuttingDown = true;

    // Wait for in-progress rotation to complete
    const release = await this.mutex.acquire();
    release();

    // Flush buffer one last time
    if (this.backupManager?.bufferEnabled) {
      await this.backupManager.flushWriteBuffer();
    }

    this.destroy();
    this.logger.info(`BloomFilterManager ${this.id} shut down.`);
  }

  /**
   * Cleans up resources when the instance is destroyed.
   */
  destroy(): void {
    this.#stopRotationInterval();
    this.backupManager?.stopBackupInterval();
    this.backupManager?.stopWriteInterval();
    this.backupManager = null;
    this.previous = null;
    this.current = null;
    this.logger.debug('BloomFilterManager destroyed.');
  }
}
