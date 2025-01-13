// @ts-check

// Bloom filter manager class to manage multiple Bloom filters with rotation.
import { BloomFilter } from './bloomfilter.js';
import fs from 'fs';
import path from 'path';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { Mutex } from 'async-mutex';

// Define __filename and __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename)

/**
 * @typedef {Object} GenericLogger
 * @property {function(...any): void} error - Log an error message
 * @property {function(...any): void} warn - Log a warning message
 * @property {function(...any): void} info - Log an info message
 * @property {function(...any): void} debug - Log a debug message
 * @property {function(...any): void} trace - Log a trace message
 */

/**
 * @typedef {Object} BloomFilterOptions
 * @property {number} numItems - Number of items to store in the filter.
 * @property {number} fpRate - Target false positive rate.
 * @property {number} rotateTime - Filter rotation interval in milliseconds.
 * @property {GenericLogger} logger - Any logger implementing the basic logging methods
 * @property {'import("./index.js").GenericLogger'} logger - Any logger implementing the basic logging methods
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
   * @type {NodeJS.Timeout | null}
   */
  backupInterval = null;

  /**
   * @private
   * @type {number}
   */
  instanceId;

  /**
   * @private
   * @type {GenericLogger}
   */
  logger;

  /**
   * @private
   * @type {boolean}
   * */
  previousDone

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
   * @private
   * @type {number}
   */
    static count = 1;

  /**
   * Creates an instance of BloomFilterManager.
   * @param {BloomFilterOptions} options - Bloom filter configuration.
   */
  constructor(options) {

    const { numItems, fpRate, rotateTime, logger } = options;

    if (!numItems || !Number.isInteger(numItems)  || numItems <= 0) {
      logger.error('numItems must be a positive integer.');
      throw new Error('numItems must be a positive integer.');
    }
    if (!fpRate || fpRate <= 0 || fpRate >= 1) {
      logger.error('fpRate must be a number between 0 and 1 (exclusive).');
      throw new Error('fpRate must be a number between 0 and 1 (exclusive).');
    }
    if (!rotateTime || !Number.isInteger(rotateTime) || rotateTime <= 0) {
      logger.error('rotateTime must be a positive integer.');
      throw new Error('rotateTime must be a positive integer.');
    }

    this.instanceId = BloomFilterManager.count++;

    /** @private */
    this.numItems = numItems;
    /** @private */
    this.fpRate = fpRate;
    /** @private */
    this.rotateTime = rotateTime;
    /** @private */
    this.logger = logger;
    /** @private */
    this.previousDone = false;
    /** @private */
    this.mutex = new Mutex();

    this.logger.info(
      `Initializing BloomFilterManager with numItems=${this.numItems}, fpRate=${this.fpRate}, rotateTime=${this.rotateTime}`
    );

    this.current = this.#createBloomFilter();

    this.backupDir = path.join(__dirname, '../backup');
    this.backupCurrentPath = path.join(this.backupDir, `current-${this.instanceId}.blob`);
    this.backupPreviousPath = path.join(this.backupDir, `previous-${this.instanceId}.blob`);
    this.backupTempFilePath = path.join(this.backupDir, `temp-${this.instanceId}.txt`);

    this.#init();

  }

  // Note: not testing private methods
  /* c8 ignore start */

  /**
   * 
   */
  async #init() {
    // asynchrone initialization
    await this.#ensureBackupDirExists();
    const isFirstStart = await this.#isFirstStart();
    if (!isFirstStart) {
      await this.#restore();
    }
    this.#startRotationAndBackupIntervals();
  }

  /**
   * Initializes the timer intervals for filter rotation and backup.
   * @returns {void}
   * */
  #startRotationAndBackupIntervals() {
    this.rotationInterval = setInterval(() => this.#rotate(), this.rotateTime);
    this.backupInterval = setInterval(() => this.#backup(), 5 * 60 * 1000); // Backup every 5 minutes
  }

  async #isFirstStart() {
    try {
      const files = await fs.promises.readdir(this.backupDir);
        return files.length === 0; // Si le répertoire est vide, c'est le premier démarrage
    } catch (error) {
        this.logger.error('Error checking if first start:', error);
        return false; // En cas d'erreur, on considère que ce n'est pas le premier démarrage
    }
  }

  /**
   * Creates a new Bloom filter.
   * @returns {BloomFilter}
   */
  #createBloomFilter() {
    const newFilter = BloomFilter.withTargetError(this.numItems, this.fpRate);
    return newFilter;
  }

  /**
  * Ensures that the backup directory exists.
  * @returns {Promise<void>}
  */
  async #ensureBackupDirExists() {
    try {
      await fs.promises.access(this.backupDir);
      this.logger.debug('Backup directory already exists.');
    } catch (error) {
      if (error.code === 'ENOENT') {
        await fs.promises.mkdir(this.backupDir, { recursive: true });
        this.logger.debug('Backup directory created.');
      } else {
        this.logger.error('Error accessing or creating backup directory:', error);
        throw error;
      }
    }
  }

  /**
   * Checks if the temp file exists and is not empty.   *
   * @returns {Promise<boolean>} - `true` if the temp file exists and is not empty, `false` otherwise.
   */
  async #tempFileExistsAndNotEmpty() {
    try {
      const stats = await fs.promises.stat(this.backupTempFilePath);
      return stats.size > 0;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return false;
      }
      this.logger.error('Error checking if temp file exists and is not empty:', error);
      return false;
    }
  }

  /**
   * Backup one or all filters to local storage.
   * @param {string} filterName - The name of the filter to backup: 'current', 'previous', or 'all' for both.
   * @returns {Promise<void>}
   * @throws {Error} If an error occurs while backing up the filter(s).
   */
  async #backupLocal(filterName = "all") {
    try {
      // Validate filterName parameter
      const validFilters = ["current", "previous", "all"];
      if (!validFilters.includes(filterName)) {
        throw new Error("filterName parameter must be either 'current', 'previous', or 'all'");
      }

      const filtersToBackup = filterName === "all" ? ["current", "previous"] : [filterName];

      for (const name of filtersToBackup) {
        const filter = this[name];
        const filePath = name === "current" ? this.backupCurrentPath : this.backupPreviousPath;

        // Skip previous filter backup if not needed before first rotation
        if (name === "previous" && !filter) {
          this.logger.debug('No previous filter to backup.');
          continue;
        }

        if (!filter) {
          throw new Error(`There is no ${name} filter to backup on instance : ${this.instanceId}`);
        }

        // @ts-ignore
        const buffer = Buffer.from(filter.buckets.buffer);
        await fs.promises.writeFile(filePath, buffer);

        this.logger.debug(`Saved ${name} filter : id ${this.instanceId}`);
      }

      await fs.promises.writeFile(this.backupTempFilePath, '');
      this.logger.debug(`Temp file cleared for instance : id ${this.instanceId}`);
    } catch (error) {
      this.logger.error(`Backup failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Backup the current and previous filters.
   * @returns {Promise<void>}
   * @throws {Error} If an error occurs while backing up the filters.
   */
  async #backup() {
    const release = await this.mutex.acquire();
    try {
      this.#backupLocal('all');
    } finally {
      release();
    }
  }

    /**
   * Restaure les éléments depuis le fichier temporaire vers le filtre actuel.
   * @returns {Promise<void>}
   */
  async #restoreTemp() {
    try {
      const fileContent = await fs.promises.readFile(this.backupTempFilePath, 'utf8');
      const lines = fileContent.split('\n');
      
      for (const line of lines) {
        if (line.trim()) {
          try {
            if (this.current) {
              this.current.add(line);
            } else {
              this.logger.error(`Cannot add '${line}' to current filter: filter not initialized.`);
            }
          } catch (error) {
            this.logger.error(`Erreur lors de l'ajout de '${line}' : ${error.message}`);
          }
        }
      }

      this.logger.debug(`Éléments restaurés depuis le fichier temp pour l'instance ${this.instanceId}`);
    } catch (error) {
      this.logger.error('Erreur lors de la lecture du fichier temp:', error);
      throw error;
    }
  }

  /**
   * Restore one or all filters from backup files.
   * @param {string} filterName - The name of the filter to restore: 'current', 'previous', or 'all' for both.
   * @returns {Promise<void>}
   * @throws {Error} If an error occurs while restoring the filter(s).
   */
  async #restoreLocal(filterName) {
    // Validate filterName parameter
    const validFilters = ["current", "previous", "all"];
    if (!validFilters.includes(filterName)) {
      throw new Error("filterName parameter must be either 'current', 'previous', or 'all'");
    }

    const filtersToRestore =filterName === "all" ? ["current", "previous"] : [filterName];

    // current filter already init in constructor but is mandatory
    // jsdoc is not able to understand that
    if (!this.current) {
      this.logger.warn(`No current filter instance found for id ${this.instanceId}. Creating a new one.`);
      this.current = this.#createBloomFilter();
    }

    for (const name of filtersToRestore) {
      const filePath = name === "current" ? this.backupCurrentPath : this.backupPreviousPath

      if (fs.existsSync(filePath)) {
        const buffer = await fs.promises.readFile(filePath);
        const buckets = new Int32Array(buffer.buffer, buffer.byteOffset, buffer.length / Int32Array.BYTES_PER_ELEMENT);

        try {
          this[name] = new BloomFilter(Array.from(buckets), this.current.k);
          this.logger.debug(`Restored ${name} filter : id ${this.instanceId}`);
        } catch (error) {
            this.logger.error(`Restore failed for ${name} filter: ${error.message}`);
            this[name] = this.#createBloomFilter();
        }
      } else {
        this.logger.warn(`No ${name} backup to restore for instance : id ${this.instanceId}`);
      }
    }
    if (await this.#tempFileExistsAndNotEmpty()) {
        await this.#restoreTemp();
    }
  }


  /**
  * Restore the current and previous filters.
  * @returns {Promise<void>}
  * @throws {Error} If an error occurs while restoring the filters.
  */
  async #restore() {
    await this.#restoreLocal('all');
  }

  /**
   * Deletes a backup file if it exists.
   * @param {string} filePath The path to the backup file.
   * @param {string} fileType The type of backup file (e.g., 'Current', 'Previous').
   * @throws {Error} If an error occurs while deleting the backup file.
   */
  async #deleteBackupFile(filePath, fileType) {
    try {
      if (await fs.promises.stat(filePath).then(() => true).catch(() => false)) {
        await fs.promises.unlink(filePath);
        this.logger.debug(`${fileType} backup file deleted.`);
      }
    } catch (error) {
      this.logger.error(`Error deleting ${fileType} backup file:`, error);
    }
  }

  /**
   * Rotates the Bloom filters.
   * @throws {Error} If an error occurs while rotating the filters.
   */
  async #rotate() {
    const release = await this.mutex.acquire();
    try {
      if (!this.previousDone) {
        this.previousDone = true;
      }
      this.logger.debug('Rotating Bloom filters...');
      this.previous = this.current;
      this.current = this.#createBloomFilter();
    } catch (error) {
      this.logger.error('Error rotating Bloom filters:', error);
      throw error;
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
      this.logger.debug('Bloom filter rotation stopped. Interval is now:', this.rotationInterval);
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
      this.logger.debug('Bloom filter backup stopped.');
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
   * @throws {TypeError} If the value is not a string.
   * @throws {Error} If an error occurs while writing to the temporary file.
   */
  add(filterItem) {
    if (typeof filterItem !== 'string' || filterItem.trim() === '') {
      throw new Error('Value must be a string');
    }
    try {
      // Synchronous append to the temporary file
      fs.appendFileSync(this.backupTempFilePath, `${filterItem}\n`);
      this.current?.add(filterItem);
    } catch (error) {
      this.logger.error('Error adding value to Bloom filter:', error);
      throw error;
    }
  }

  /**
   * Checks for the presence of a value in the current and previous Bloom filters.
   * @param {string} value - The value to check.
   * @returns {boolean} - `true` if the value might be present, `false` if it is definitely absent.
   * @throws {TypeError} If the value is not a string.
   */
  has(value) {
    try {
        return (
          (this.current ? this.current.test(value) : false) ||
          (this.previous ? this.previous.test(value) : false)
        );
    } catch (error) {
      this.logger.warn('Error in has:', error);
      return false;
    }
  }

  /**
   * Resets the Bloom filters.
   * @returns {Promise<void>}
   * @throws {Error} If an error occurs while resetting the filters.
   */
  async reset() {
    const release = await this.mutex.acquire();
    try {
      this.previous = null;
      this.current = this.#createBloomFilter();
      this.previousDone = false;
      this.logger.debug('Bloom filters reset.');
      this.#init();
    } catch (error) {
      this.logger.error('Error resetting Bloom filters:', error);
      throw error;
    } finally {
      release();
    }
  }

  /**
   * Resets the Bloom filters and deletes the backup files.
   *
   */
  async resetAndClearData() {
    this.reset();
    await this.#deleteBackupFile(this.backupCurrentPath, 'Current');
    await this.#deleteBackupFile(this.backupPreviousPath, 'Previous');
    await this.#deleteBackupFile(this.backupTempFilePath, 'Temporary');
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