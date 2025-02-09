// @ts-check

// BloomFilterManager.js
import { InternalError, ValidationError } from './errors.js';
import { BloomFilter } from './bloomfilter.js';
import fs from 'fs';
import path from 'path';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { Mutex } from 'async-mutex';
import { filterInputSchema } from './Inputs-validation.js';
import { BloomFilterFactory } from './BloomFilterFactory.js';
import { BloomFilterBackupManager } from './BloomFilterBackupManager.js';

// Define __filename and __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Redefinition of the GenericLogger type to keep the BloomFilterManager class independent
/**
 * @typedef {Object} GenericLogger
 * @property {function(...any): void} error - Log an error message
 * @property {function(...any): void} warn - Log a warning message
 * @property {function(...any): void} info - Log an info message
 * @property {function(...any): void} debug - Log a debug message
 */

/**
 * @typedef {Object} BloomFilterOptions
 * @property {number} numItems - Number of items to store in the filter.
 * @property {number} fpRate - Target false positive rate.
 * @property {number} rotateTime - Filter rotation interval in milliseconds.
 * @property {string} id - The id of the bloom filter (same as the revoker id).
 * @property {boolean} [backup] - whether to enable backup.
 * @property {number} [backupRatioTime] - Ratio of the rotation time for backups (e.g., 4 for backup every rotateTime / 4).  Defaults to no backups.
 * @property {string} [backupDir] - The absolute path to the backup directory.  Defaults to a 'backup' directory relative to the current file.
 * @property {GenericLogger} logger - Any logger implementing the basic logging methods
 */

export class BloomFilterManager {

   /**
   * @private
   * @type {string}
   */
   id;

  /**
   * @private
   * @type {BloomFilter | null}
   */
  previous = null;

  /**
   * @private
   * @type {BloomFilter | null}
   */
  current = null;

  /**
   * @private
   * @type {NodeJS.Timeout | null}
   */
  rotationInterval = null;

  /**
   * @private
   * @type {number}
   */
  rotateTime;

  /**
   * @private
   * @type {GenericLogger}
   */
  logger;

  /**
   * @private
   * @type {boolean}
   * */
  hasRotated

 /**
  * @private
  * @type {Mutex}
  */
  mutex

  /**
   * Creates an instance of BloomFilterManager.
   * @param {BloomFilterOptions} options - Bloom filter configuration.
   * @throws {ValidationError} If the input is invalid.
   * @throws {InternalError} If an error occurs during initialization.
   */
  constructor(options) {

    // Validate input
    const { error } = filterInputSchema.validate(options);
    if (error) {
      throw new ValidationError(`Invalid input: ${error.message}`);
    }

    const { numItems, fpRate, rotateTime, id, backup, backupRatioTime, logger } = options;

    this.id = id;
    this.numItems = numItems;
    this.fpRate = fpRate;
    this.rotateTime = rotateTime;
    this.logger = logger;
    this.hasRotated = false;
    this.mutex = new Mutex();

    this.logger.info(
      `Initializing BloomFilterManager with numItems=${this.numItems}, fpRate=${this.fpRate}, rotateTime=${this.rotateTime}`
    );

    this.current = BloomFilterFactory.create(this.numItems, this.fpRate);
    this.backupManager = new BloomFilterBackupManager(options, this.logger);

    this.#startRotationInterval();
    if (this.backupManager.backupEnabled) {
      this.#startBackup();
    }

  }

  // Note: not testing private methods
  /* c8 ignore start */

 /**
  * Initializes the timer intervals for filter rotation and backup.
  * @returns {void}
  */
  #startRotationInterval() {
  this.rotationInterval = setInterval(async () => {
      await this.#rotateWithRetry(); // Utiliser une méthode de rotation avec retry
    }, this.rotateTime);
  }

 /**
   * Stops the Bloom filter rotation interval.
   * @returns {void}
   */
 #stopRotation() {
  if (this.rotationInterval !== null) {
    clearInterval(this.rotationInterval);
    this.rotationInterval = null;
    this.logger.debug(`Rotation stopped for id: ${this.id}`);
  }
}

  /**
   * Rotates the Bloom filter with retries.
   * @returns {Promise<void>}
   * @throws {InternalError} If an error occurs while rotating the filter.
   * @throws {InternalError} If the maximum number of retries is reached.
   */
  async #rotateWithRetry() {
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
   * @returns {Promise<void>}
   * @throws {InternalError} If an error occurs while rotating the filters.
   */
  async #rotate() {
    const release = await this.mutex.acquire();
    try {
      if (!this.hasRotated) {
        this.hasRotated = true;
      }
      this.logger.debug('Rotating Bloom filters...');
      if (this.backupManager.backupEnabled) {
        await this.backupManager.backupLocal('current');
        if (fs.existsSync(this.backupManager.backupCurrentPath)) {
          fs.renameSync(this.backupManager.backupCurrentPath, this.backupManager.backupPreviousPath); // Vous pourriez envisager de gérer les erreurs ici également
        }
      }
      this.previous = this.current;
      this.current = BloomFilterFactory.create(this.numItems, this.fpRate);
    } catch (error) {
      throw new InternalError(`Failed to rotate filters: ${error.message}`);
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
   * @param {string} filterItem - The value to add.
   * @returns {void}
   * @throws {ValidationError} If filterItem is invalid.
   * @throws {InternalError} If writing to the temp file fails.
   */
  add(filterItem) {
    if (typeof filterItem !== 'string' || filterItem.trim() === '') {
      throw new ValidationError('Value must be a non-empty string');
    }
    try {
      if (this.backupManager.backupEnabled) {
        this.backupManager.backupItem(filterItem);
      }
      this.current?.add(filterItem);
    } catch (error) {
      throw new InternalError(`Failed to add value to Bloom filter: ${error.message}`);
    }
  }

  /**
   * Checks for the presence of a value in the current and previous Bloom filters.
   * @param {string} value - The value to check.
   * @returns {boolean} - `true` if the value might be present, `false` if it is definitely absent.
   * @throws {ValidationError} If the value is not a string.
   */
  has(value) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ValidationError('Value must be a non-empty string');
    }
      
    return (
      (this.current ? this.current.test(value) : false) ||
      (this.previous ? this.previous.test(value) : false)
    );
  }

  /**
   * @typedef {Object} EstimatedMetrics
   * @property {number} currentCount - Estimated number of items in current filter (0 if no filter)
   * @property {number} previousCount - Estimated number of items in previous filter (0 if no filter)
   * @property {number} currentFpRate - Estimated false positive rate of current filter (0 if no filter)
   * @property {number} previousFpRate - Estimated false positive rate of previous filter (0 if no filter)
   */ 
  /**
   * Get the estimated metrics of the current and previous Bloom filter.
   * @returns {EstimatedMetrics} - Estimated metrics of the current and previous filters.
   */
  #getEstimatedMetrics() {
    const metrics = {
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
   * @typedef {Object} Configuration
   * @property {number} numItems - Number of items to store in the filter
   * @property {number} fpRate - Target false positive rate
   * @property {number} rotateTime - Filter rotation interval in milliseconds
   * @property {boolean} backupEnabled - Whether backup is enabled
   * @property {number} backupRatioTime - Ratio of the rotation time for backups
   */
  /**
   * @typedef {Object} Metrics
   * @property {EstimatedMetrics} estimatedMetrics - Estimated metrics of the current and previous filters
   * @property {Configuration} configuration - Configuration of the Bloom filter manager
   * 
  /**
   * Get metrics of the current and previous Bloom filter.
   * @returns {Metrics} - Metrics of the current and previous filters.
   */
  getMetrics() {
    const estimatedMetrics = this.#getEstimatedMetrics();
    const configuration = {
      numItems: this.numItems,
      fpRate: this.fpRate,
      rotateTime: this.rotateTime,
      backupEnabled: this.backupManager.backupEnabled,
      backupRatioTime: this.backupManager.backupRatioTime
    };
    return { estimatedMetrics, configuration };
  }

  /**
   * Resets and restores the Bloom filters.
   * @returns {Promise<void>}
   * @throws {InternalError} If an error occurs while resetting the filters
   */
  async resetAndRestore() {
    const release = await this.mutex.acquire();
    try {
      this.previous = null;
      this.current = BloomFilterFactory.create(this.numItems, this.fpRate);
      this.#stopRotation();
      this.backupManager.stopBackup();
      this.logger.debug('Bloom filters reset');
      this.#startRotationInterval();
      if (this.backupManager.backupEnabled) {
        this.backupManager.startBackup();
      }
    } catch (error) {
      throw new InternalError(`Failed to reset and restore: ${error.message}`);
    } finally {
      release();
    }
  }

  /**
   * Resets the Bloom filters and deletes the backup files.
   * @returns {Promise<void>}
   * @throws {InternalError} If an error occurs while resetting the filters.
   */
  async resetAndClearData() {
    const release = await this.mutex.acquire();
    try {
        await this.backupManager.deleteBackupFile(this.backupManager.backupCurrentPath, 'Current');
        await this.backupManager.deleteBackupFile(this.backupManager.backupPreviousPath, 'Previous');
        await this.backupManager.deleteBackupFile(this.backupManager.backupTempFilePath, 'Temporary');
        this.hasRotated = false;
        await this.resetAndRestore(); // Réutiliser resetAndRestore
    } catch (error) {
        throw new InternalError(`Failed to reset and clear data: ${error.message}`);
    } finally {
        release();
    }
}

  /**
   * Cleans up resources when the instance is destroyed.
   * @returns {void}
   */
  destroy() {
    this.#stopRotation();
    this.backupManager.stopBackup();
    this.previous = null;
    this.current = null;
    this.logger.debug('BloomFilterManager destroyed.');
  }
}