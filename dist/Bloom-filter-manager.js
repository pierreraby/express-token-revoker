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
   * @type {NodeJS.Timeout | null}
   */
  backupInterval = null;

  /**
   * @private
   * @type {boolean}
   */
  backupEnabled;

  /**
   * @private
   * @type {number}
   */
  backupRatioTime;

  /**
   * @private
   * @type {string}
   */
  id;

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
   * @type {string}
   */
  backupDir;

  /**
   * @private
   * @type {string}
   */
  backupCurrentPath;

  /**
   * @private
   * @type {string}
  */
  backupPreviousPath;

  /**
   * @private
   * @type {string}
   */
  backupTempFilePath;

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

    /** @private */
    this.id = id;
    /** @private */
    this.numItems = numItems;
    /** @private */
    this.fpRate = fpRate;
    /** @private */
    this.rotateTime = rotateTime;
    /** @private */
    this.backupEnabled = backup ?? false;
    /** @private */
    this.backupRatioTime = backupRatioTime ?? 0;
    /** @private */
    this.logger = logger;
    /** @private */
    this.hasRotated = false;
    /** @private */
    this.mutex = new Mutex();

    this.logger.info(
      `Initializing BloomFilterManager with numItems=${this.numItems}, fpRate=${this.fpRate}, rotateTime=${this.rotateTime}`
    );

    this.current = this.#createBloomFilter();

    this.backupDir = options.backupDir || path.resolve(__dirname, '../backup');
    this.backupCurrentPath = path.join(this.backupDir, `current-${this.id}.blob`);
    this.backupPreviousPath = path.join(this.backupDir, `previous-${this.id}.blob`);
    this.backupTempFilePath = path.join(this.backupDir, `temp-${this.id}.txt`);

    try {
      this.#init();
    } catch (error) {
      throw new InternalError(`Initialization failed: ${error.message}`); 
    }

  }

  // Note: not testing private methods
  /* c8 ignore start */

  /**
  * Creates a new Bloom filter.
  * @returns {BloomFilter}
  */
  #createBloomFilter() {
    const newFilter = BloomFilter.withTargetError(this.numItems, this.fpRate);
    return newFilter;
  }

  /**
  * Initializes the Bloom filter manager.
  * @returns {void}
  * @throws {InternalError} If an error occurs during initialization.
  */
  #init() {
    try {
      if (this.backupEnabled) {
        if (this.#backupExists()) {
          this.#restore("all");
        } else {
          this.#ensureBackupDirExists();
        }
      }
      this.#startRotationAndBackupIntervals();
    } catch (error) {
      throw new InternalError(`Initialization failed: ${error.message}`);
    }
  }

  /**
   * Checks if backup files exist.
   * @returns {boolean} - `true` if backup files exist, `false` otherwise.
   */
  #backupExists() {
    try {
      return fs.existsSync(this.backupDir) && fs.readdirSync(this.backupDir).length > 0;
    } catch (error) {
      return false; // Consider that the backup does not exist in case of an error
    }
  }

  /**
  * Ensures that the backup directory exists.
  * @returns {void}
  * @throws {InternalError} If an error occurs while creating the backup directory.
  */
  #ensureBackupDirExists() {
    try {
      if (!fs.existsSync(this.backupDir)) {
        fs.mkdirSync(this.backupDir, { recursive: true });
        this.logger.debug('Backup directory created');
      } else {
        this.logger.debug('Backup directory already exists.');
      }
    } catch (error) {
      throw new InternalError(`Error accessing or creating backup directory: ${error.message}`);
    }
  }

 /**
  * Initializes the timer intervals for filter rotation and backup.
  * @returns {void}
  */
  #startRotationAndBackupIntervals() {
    this.rotationInterval = setInterval(async () => {
      await this.#rotateWithRetry();
    }, this.rotateTime);

    if (this.backupEnabled && this.backupRatioTime) {
      this.backupInterval = setInterval(async () => {
        await this.#backupWithRetry();
      }, this.rotateTime / this.backupRatioTime);
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
   * Backup the filter with retries.
   * @returns {Promise<void>}
   * @throws {InternalError} If an error occurs while backing up the filter.
   * @throws {InternalError} If the maximum number of retries is reached.
   */
  async #backupWithRetry() {
    const maxRetries = 3;
    const retryDelay = 5000; // 5 secondes
  
    for (let i = 0; i < maxRetries; i++) {
      try {
        await this.#backup();
        return;
      } catch (error) {
        this.logger.error(`Backup failed (attempt ${i + 1}/${maxRetries}):`, error);
        if (i < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
    }
    this.logger.error('Max retries reached. Stopping backup.');
    if (this.backupInterval) {
      clearInterval(this.backupInterval);
      this.backupInterval = null;
    }
  }

  /**
   * Checks if the temp file exists and is not empty.
   * @returns {boolean} - `true` if the temp file exists and is not empty, `false` otherwise.
   */
  #tempFileExistsAndNotEmpty() {
    try {
      return fs.existsSync(this.backupTempFilePath) && fs.statSync(this.backupTempFilePath).size > 0;
    } catch (error) {
      return false; // Consider that the file does not exist or is empty in case of error
    }
  }

 /**
  * Backup the filter to local storage.
  * @param {BloomFilter} filter - The filter to backup.
  * @param {string} filePath - The path to the backup file.
  * @returns {Promise<void>}
  * @throws {InternalError} If an error occurs while backing up the filter.
  */
  async #backupFilter(filter, filePath) {
    if (!filter) {
      throw new InternalError(`Filter is not defined.`); // Plus générique
    }
    try {
      // @ts-ignore
      const buffer = Buffer.from(filter.buckets.buffer);
      await fs.promises.writeFile(filePath, buffer);
      this.logger.debug(`Saved filter to: ${filePath}`);
    } catch (error) {
      throw new InternalError(`Failed to backup filter to ${filePath}: ${error.message}`);
    }
  }

  /**
  * Backup one or all filters to local storage.
  * @param {string} filterName - The name of the filter to backup: 'current', 'previous', or 'all' for both.
  * @returns {Promise<void>}
  * @throws {ValidationError} If filterName is invalid.
  * @throws {InternalError} If an error occurs while backing up the filter(s).
  */
  async #backupLocal(filterName = "all") {
    // Validation
    const validFilters = ["current", "previous", "all"];
    if (!validFilters.includes(filterName)) {
      throw new ValidationError("filterName parameter must be either 'current', 'previous', or 'all'");
    }

    const filtersToBackup = filterName === "all" ? ["current", "previous"] : [filterName];

    for (const name of filtersToBackup) {
      const filter = this[name];
      const filePath = name === "current" ? this.backupCurrentPath : this.backupPreviousPath;

      // Skip previous filter backup if not needed before first rotation
      if (name === "previous" && !filter && !this.hasRotated) {
        this.logger.debug('No previous filter to backup before first rotation');
        continue;
      }

      await this.#backupFilter(filter, filePath);

      if (name === "current") {
        await fs.promises.writeFile(this.backupTempFilePath, '');
        this.logger.debug(`Temp file cleared for instance ${this.id}`);
      }
    }
  }

  // /**
  //  * Backup one or all filters to local storage.
  //  * @param {string} filterName - The name of the filter to backup: 'current', 'previous', or 'all' for both.
  //  * @returns {Promise<void>}
  //  * @throws {ValidationError} If filterName is invalid.
  //  * @throws {InternalError} If an error occurs while backing up the filter(s).
  //  */
  // async #backupLocal(filterName = "all") {
  //   // Validation
  //   const validFilters = ["current", "previous", "all"];
  //   if (!validFilters.includes(filterName)) {
  //     throw new ValidationError("filterName parameter must be either 'current', 'previous', or 'all'");
  //   }

  //   const filtersToBackup = filterName === "all" ? ["current", "previous"] : [filterName];

  //   for (const name of filtersToBackup) {
  //     const filter = this[name];
  //     const filePath = name === "current" ? this.backupCurrentPath : this.backupPreviousPath;

  //     // Skip previous filter backup if not needed before first rotation
  //     if (name === "previous" && !filter && !this.hasRotated) {
  //       this.logger.debug('No previous filter to backup before first rotation');
  //       continue;
  //     }

  //     if (!filter) {
  //       throw new InternalError(`There is no ${name} filter to backup on instance : ${this.id}`);
  //     }

  //     try {
  //       const buffer = Buffer.from(filter.buckets.buffer);
  //       await fs.promises.writeFile(filePath, buffer);
  //       this.logger.debug(`Saved ${name} filter : id ${this.id}`);

  //       if (name === "current") {
  //         await fs.promises.writeFile(this.backupTempFilePath, '');
  //         this.logger.debug(`Temp file cleared for instance ${this.id}`);
  //       }
  //     } catch (error) {
  //       throw new InternalError(`Failed to backup ${name} filter: ${error.message}`);
  //     }
  //   }
  // }

  /**
   * Backup the current and previous filters.
   * @returns {Promise<void>}
   * @throws {InternalError} If an error occurs while backing up the filters.
   */
  async #backup() {
    const release = await this.mutex.acquire();
    try {
      await this.#backupLocal('all');
    } catch (error) {
      throw error;
    } finally {
      release();
    }
  }

  /**
   * Restores elements from the temporary file to the current filter.
   * @returns {void}
   * @throws {InternalError} If an error occurs while restoring the filter.
   */
  #restoreTemp() {
    try {
      const fileContent = fs.readFileSync(this.backupTempFilePath, 'utf8');
      const lines = fileContent.split('\n');

      for (const line of lines) {
        if (line.trim()) {
          try {
            if (this.current) {
              this.current.add(line);
            } else {
                // This situation should not occur as `current` is initialized
              throw new InternalError(`Cannot add '${line}' to current filter: filter not initialized.`);
            }
          } catch (error) {
            throw new InternalError(`Failed to add '${line}' to Bloom filter: ${error.message}`);
          }
        }
      }

      this.logger.debug(`Elements restored from temp file for instance : ${this.id}`);
    } catch (error) {
      throw new InternalError(`Restore temp file failed: ${error.message}`);
    }
  }

  /**
   * Restores one or all filters from backup files.
   * @param {string} filterName - The name of the filter to restore: 'current', 'previous', or 'all' for both.
   * @returns {void}
   * @throws {ValidationError} If filterName is invalid.
   * @throws {InternalError} If an error occurs while restoring the filter(s).
   */
  #restore(filterName) {
    // Validation
    const validFilters = ["current", "previous", "all"];
    if (!validFilters.includes(filterName)) {
      throw new ValidationError("filterName parameter must be either 'current', 'previous', or 'all'");
    }

    const filtersToRestore = filterName === "all" ? ["current", "previous"] : [filterName];

    if (!this.current) {
      this.logger.warn(`No current filter instance found for id ${this.id}. Creating a new one.`);
      this.current = this.#createBloomFilter();
    }

    for (const name of filtersToRestore) {
      const filePath = name === "current" ? this.backupCurrentPath : this.backupPreviousPath;

      if (fs.existsSync(filePath)) {
        try {
          const buffer = fs.readFileSync(filePath);
          const buckets = new Int32Array(buffer.buffer, buffer.byteOffset, buffer.length / Int32Array.BYTES_PER_ELEMENT);
          this[name] = new BloomFilter(Array.from(buckets), this.current.k);
          this.logger.debug(`Restored ${name} filter : id ${this.id}`);
        } catch (error) {
          throw new InternalError(`Restore failed for ${name} filter: ${error.message}`);
        }
      } else {
        this.logger.warn(`No ${name} backup to restore for instance : id ${this.id}`);
      }
    }

    if (this.#tempFileExistsAndNotEmpty()) {
      this.#restoreTemp();
    }
  }

  /**
   * Deletes a backup file if it exists.
   * @param {string} filePath The path to the backup file.
   * @param {string} fileType The type of backup file (e.g., 'Current', 'Previous').
   * @returns {void}
   * @throws {InternalError} If an error occurs while deleting the backup file.
   */
  #deleteBackupFile(filePath, fileType) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        this.logger.debug(`${fileType} backup file deleted for instance : id ${this.id}`);
      }
    } catch (error) {
      throw new InternalError(`Error deleting ${fileType} backup file: ${error.message}`);
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
      if (this.backupEnabled) {
        await this.#backupLocal('current');
        if (fs.existsSync(this.backupCurrentPath)) {
          fs.renameSync(this.backupCurrentPath, this.backupPreviousPath); // Vous pourriez envisager de gérer les erreurs ici également
        }
      }
      this.previous = this.current;
      this.current = this.#createBloomFilter();
    } catch (error) {
      throw new InternalError(`Failed to rotate filters: ${error.message}`);
    } finally {
      release();
    }
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
   * Stops the Bloom filter backup interval.
   * @returns {void}
   */
  #stopBackup() {
    if (this.backupInterval !== null) {
      clearInterval(this.backupInterval);
      this.backupInterval = null;
      this.logger.debug(`Backup stopped for id: ${this.id}`);
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
      if (this.backupEnabled) {
        // Synchronous append to the temporary file
        fs.appendFileSync(this.backupTempFilePath, `${filterItem}\n`);
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
      backupEnabled: this.backupEnabled,
      backupRatioTime: this.backupRatioTime
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
      this.current = this.#createBloomFilter();
      this.#stopRotation();
      this.#stopBackup();
      this.logger.debug('Bloom filters reset');
      this.#init();
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
    try {
      await this.#deleteBackupFile(this.backupCurrentPath, 'Current');
      await this.#deleteBackupFile(this.backupPreviousPath, 'Previous');
      await this.#deleteBackupFile(this.backupTempFilePath, 'Temporary');
      this.hasRotated = false;
      await this.resetAndRestore();
    } catch (error) {
      throw new InternalError(`Failed to reset and clear data: ${error.message}`);
    }
  }

  /**
   * Cleans up resources when the instance is destroyed.
   * @returns {void}
   */
  destroy() {
    this.#stopRotation();
    this.#stopBackup();
    this.previous = null;
    this.current = null;
    this.logger.debug('BloomFilterManager destroyed.');
  }
}