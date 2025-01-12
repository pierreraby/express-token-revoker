// @ts-check

// Bloom filter manager class to manage multiple Bloom filters with rotation.
import { BloomFilter } from './bloomfilter.js';
import fs from 'fs';
import path from 'path';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

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

// @property {GenericLogger} logger - Any logger implementing the basic logging methods

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
   * @type {number}
   */
    static count = 1;

  /**
   * Enum representing the possible filter names.
   * @readonly
   * @type {{current: 'current', previous: 'previous', all: 'all'}}
   */
    filterName = Object.freeze({
      current: 'current',
      previous: 'previous',
      all: 'all',
    });

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


    this.logger.info(
      `Initializing BloomFilterManager with numItems=${this.numItems}, fpRate=${this.fpRate}, rotateTime=${this.rotateTime}`
    );

    this.current = this.#createBloomFilter();

    this.rotationInterval = setInterval(() => this.#rotate(), this.rotateTime);
    this.backupInterval = setInterval(() => this.#backup(), 60 * 60 * 1000); // Backup every 5 minutes

    this.backupDir = path.join(__dirname, '../backup');
    this.backupCurrentPath = path.join(this.backupDir, `current-${this.instanceId}.blob`);
    this.backupPreviousPath = path.join(this.backupDir, `previous-${this.instanceId}.blob`);
    this.backupTempFilePath = path.join(this.backupDir, `temp-${this.instanceId}.txt`);

    this.#ensureBackupDirExists();

    const isFirstStart = this.#isFirstStart();

    this.#restore(isFirstStart);
  }

  // Note: not testing private methods
  /* c8 ignore start */

  #isFirstStart() {
    try {
        const files = fs.readdirSync(this.backupDir);
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
  * @returns {void}
  */
   #ensureBackupDirExists() {
    //const backupDir = path.join(__dirname, '../backup');
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir);
      this.logger.debug('Backup directory created');
    }
  }

  /**
   * Backup one or all filters to local storage.
   * @param {keyof typeof this.filterName} filterName - The name of the filter to restore: 'current', 'previous', or 'all' for both.
   * @returns {Promise<void>}
   * @throws {Error} If an error occurs while backing up the filter(s).
   */
  async #backupLocal(filterName = this.filterName.all) {
    try {
      // Validate filterName parameter
      const validFilters = [this.filterName.current, this.filterName.previous, this.filterName.all];
      if (!validFilters.includes(filterName)) {
        throw new Error("filterName parameter must be either 'current', 'previous', or 'all'");
      }

      /** @type {(keyof typeof this.filterName)[]} */
      const filtersToBackup = 
        filterName === this.filterName.all
        ? [this.filterName.current, this.filterName.previous]
        : [filterName];

      for (const name of filtersToBackup) {
        const filter = this[name];
        const filePath =
          name === this.filterName.current
            ? this.backupCurrentPath
            : this.backupPreviousPath;


        // Skip previous filter backup if not needed
        if (name === this.filterName.previous && !filter && !this.previousDone) {
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
      if (this.backupTempFilePath && fs.existsSync(this.backupTempFilePath)) {
        fs.unlinkSync(this.backupTempFilePath);
      }
    } catch (error) {
      this.logger.error(`Backup failed: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Backup the current and previous filters.
   * @returns {void}
   * @throws {Error} If an error occurs while backing up the filters.
   */
  #backup() {
    // this.backupLocal('current');
    // this.backupLocal('previous');
    this.#backupLocal('all');
  }
  
  /**
   * Restore items from temp file to current filter.
   * @returns {Promise<void>}
   * @throws {Error} If an error occurs while restoring the items.
   */
  async #restoreTemp() {
    try {
      const data = await fs.promises.readFile(this.backupTempFilePath, 'utf8');
      const restoredItems = data.split('\n');
      // Add each item to the current filter
      restoredItems.forEach((item) => {
        if (item.trim() !== '') {
            try {
                this.current?.add(item);
            } catch (error) {
                this.logger.error(`Error adding item '${item}' to filter: ${error.message}`);
            }
        }
      });
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`Backup file not found: ${this.backupTempFilePath}`);
            } else if (error instanceof TypeError) {
        throw new Error(`'current' is not defined or does not have an 'add' method`);
            } else {
        throw new Error(`Error restoring filters: ${error.message}`);
      }
    }
  }
  
  /**
   * Restore one or all filters from backup files.
   * @param {keyof typeof this.filterName} filterName - The name of the filter to restore: 'current', 'previous', or 'all' for both.
   * @param {boolean} isFirstStart - Flag indicating if this is the first start.
   * @returns {Promise<void>}
   * @throws {Error} If an error occurs while restoring the filter(s).
   */
  async #restoreLocal(filterName = 'all', isFirstStart = false) {
    // Validate filterName parameter
    const validFilters = [this.filterName.current, this.filterName.previous, this.filterName.all];
    if (!validFilters.includes(filterName)) {
      throw new Error("filterName parameter must be either 'current', 'previous', or 'all'");
    }

    /** @type {(keyof typeof this.filterName)[]} */
    const filtersToRestore =
      filterName === this.filterName.all
        ? [this.filterName.current, this.filterName.previous]
        : [filterName];

      if (!this.current) {
        this.logger.warn(`No current filter instance found for id ${this.instanceId}. Creating a new one.`);
        this.current = this.#createBloomFilter();
      }

    for (const name of filtersToRestore) {
      const filePath =
        name === this.filterName.current
          ? this.backupCurrentPath
          : this.backupPreviousPath

      if (!fs.existsSync(filePath)) {
        if (isFirstStart) {
        this.logger.warn(`No ${name} backup to restore for instance : id ${this.instanceId} (first start)`);
        } else {
          this.logger.error(`No ${name} backup to restore for instance : id ${this.instanceId}`);
        }
        continue;
      }

      const buffer = await fs.promises.readFile(filePath);
      const buckets = new Int32Array(
        buffer.buffer, 
        buffer.byteOffset, 
        buffer.length / Int32Array.BYTES_PER_ELEMENT
      );

      try {
        this[name] = new BloomFilter(Array.from(buckets), this.current.k);
        this.logger.debug(`Restored ${name} filter : id ${this.instanceId}`);
        if (!isFirstStart) {
          this.#restoreTemp();
          this.#backupLocal(name);
        }
      } catch (error) {
          this.logger.error(`Restore failed for ${name} filter: ${error.message}`);
          this[name] = this.#createBloomFilter();
          if (!isFirstStart) {
            throw error;
          }
      }
    }
  }

  /**
  * Restore the current and previous filters.
  * @param {boolean} isFirstStart - Flag indicating if this is the first start.
  * @returns {void}
  * @throws {Error} If an error occurs while restoring the filters.
  */
  #restore(isFirstStart) {
    this.#restoreLocal('all',isFirstStart);
  }


  /**
   * Deletes a backup file if it exists.
   * 
   * @param {string} filePath The path to the backup file.
   * @param {string} fileType The type of backup file (e.g., 'Current', 'Previous').
   * throws {Error} If an error occurs while deleting the backup file.
   */
  #deleteBackupFile(filePath, fileType) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
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
  #rotate() {
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
      this.logger.debug('Bloom filter rotation stopped.');
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
   * Adds a value to the current and next filters.
   * @param {string} filterItem - The value to add.
   * @returns {Promise<void>}
   * @throws {TypeError} If the value is not a string.
   */
  async add(filterItem) {
    if (typeof filterItem !== 'string' || filterItem.trim() === '') {
      throw new Error('Value must be a string');
    }
    try {
      await fs.promises.appendFile(this.backupTempFilePath, `${filterItem}\n`); // Asynchrone maintenant
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
   * @throws {Error} If an error occurs while resetting the filters.
   */
  reset() {
    try {
      this.#stopRotation(); // Stop the Itervals
      this.#stopBackup();

      this.previous = null;
      this.current = this.#createBloomFilter();
      this.previousDone = false;
      this.logger.debug('Bloom filters reset.');

      this.rotationInterval = setInterval(() => this.#rotate(), this.rotateTime);
      this.backupInterval = setInterval(() => this.#backup(), 5 * 60 * 1000);
    } catch (error) {
      this.logger.error('Error resetting Bloom filters:', error);
      throw error;
    } 
  } 

  /**
   * Resets the Bloom filters and deletes the backup files.
   * 
   */
  resetAndClearData() {
    this.reset();
    this.#deleteBackupFile(this.backupCurrentPath, 'Current');
    this.#deleteBackupFile(this.backupPreviousPath, 'Previous');
    this.#deleteBackupFile(this.backupTempFilePath, 'Temporary');
  }



  /**
   * Cleans up resources when the instance is destroyed.
   * @returns {Promise<void>}
   */
  async destroy() {
    this.#stopRotation();
    this.#stopBackup();
    await new Promise((resolve) => setTimeout(resolve, 10)); // 5 ms, à ajuster si besoin
    this.previous = null;
    this.current = null;
    this.logger.debug('BloomFilterManager destroyed.');
  }
}


