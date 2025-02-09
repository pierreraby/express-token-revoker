// @ts-check

import fs from 'fs';
import path from 'path';
import { InternalError, ValidationError } from './errors.js';
import { Mutex } from 'async-mutex';
import { BloomFilterFactory } from './BloomFilterFactory.js';

/**
 * @typedef {import('#dist/types.js').GenericLogger} GenericLogger
 */

/**
 * BloomFilterBackupManager class
 * @class
 * @classdesc Manages backup and restoration of Bloom filters.
 * 
 */
export class BloomFilterBackupManager {
  /**
   * @private
   * @type {string}
   */
  id;

  /**
   * @private
   * @type {NodeJS.Timeout | null}
   */
  backupInterval = null;

  /**
   * @type {boolean}
   */
  backupEnabled;

  /**
   * @type {number}
   */
  backupRatioTime;

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
   * @type {string}
   */
  backupCurrentPath;

  /**
   * @type {string}
  */
  backupPreviousPath;

  /**
   * @type {string}
   */
  backupTempFilePath;

   /**
   * @private
   * @type {Mutex}
   */
   mutex
    constructor(options, logger) {
        this.id = options.id;
        this.backupEnabled = options.backupEnabled ?? false;
        this.backupRatioTime = options.backupRatioTime ?? 0;
        this.rotateTime = options.rotateTime;
        this.logger = logger;
        this.backupDir = options.backupDir || path.resolve(__dirname, '../backup'); //Utiliser resolve
        this.backupCurrentPath = path.join(this.backupDir, `current-${this.id}.blob`);
        this.backupPreviousPath = path.join(this.backupDir, `previous-${this.id}.blob`);
        this.backupTempFilePath = path.join(this.backupDir, `temp-${this.id}.txt`);
        this.mutex = new Mutex();
        this.backupInterval = null;
        this.writeBuffer = []; // Pour l'écriture asynchrone par lots
        this.writeInterval = null;
        this.bufferFlushInterval = 1000;
        this.hasRotated = false; // Sera géré par le BloomFilterManager
        this.#ensureBackupDirExists();
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

 /**
  * Backup the filter 
  * @param {string} filterItem - The value to add.
  * @returns {void}
  */
  backupItem(filterItem) {
    fs.appendFileSync(this.backupTempFilePath, `${filterItem}\n`);
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
  async backupLocal(filterName = "all") {
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
  * Restores a single filter from a file.
  * @param {string} filterName - The name of the filter ('current' or 'previous').
  * @param {string} filePath - The path to the backup file.
  * @param {number} k - Number of hash functions.
  * @returns {void}
  * @throws {InternalError} If an error occurs during restoration.
  */
  #restoreFilterFromFile(filterName, filePath, k) {
    if (fs.existsSync(filePath)) {
      try {
        const buffer = fs.readFileSync(filePath);
        const buckets = new Int32Array(buffer.buffer, buffer.byteOffset, buffer.length / Int32Array.BYTES_PER_ELEMENT);
        this[filterName] = BloomFilterFactory.createFromBuckets(buckets, k);
        this.logger.debug(`Restored ${filterName} filter : id ${this.id}`);
      } catch (error) {
        throw new InternalError(`Restore failed for ${filterName} filter: ${error.message}`);
      }
    } else {
      this.logger.warn(`No ${filterName} backup to restore for instance : id ${this.id}`);
    }
  }

 /**
  * Restores one or all filters from backup files.
  * @param {string} filterName - The name of the filter to restore: 'current', 'previous', or 'all' for both.
  * @returns {void}
  * @throws {ValidationError} If filterName is invalid.
  */
  #restore(filterName) {
    // Validation
    const validFilters = ["current", "previous", "all"];
    if (!validFilters.includes(filterName)) {
      throw new ValidationError("filterName parameter must be either 'current', 'previous', or 'all'");
    }

    const filtersToRestore = filterName === "all" ? ["current", "previous"] : [filterName];
    const filterPaths = {
      "current": this.backupCurrentPath,
      "previous": this.backupPreviousPath
    };

    if (!this.current) {
      this.logger.warn(`No current filter instance found for id ${this.id}. Creating a new one.`);
      this.current = this.#createBloomFilter();
    }

    for (const name of filtersToRestore) {
      const filePath = filterPaths[name];
      this.#restoreFilterFromFile(name, filePath, this.current.k);
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
  deleteBackupFile(filePath, fileType) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        this.logger.debug(`${fileType} backup file deleted for instance : id ${this.id}`);
      }
    } catch (error) {
      throw new InternalError(`Error deleting ${fileType} backup file: ${error.message}`);
    }
  }

    // ... (Toutes les méthodes liées à la sauvegarde et à la restauration) ...
    // #backup, #backupLocal, #restore, #restoreTemp, #deleteBackupFile,
    // #ensureBackupDirExists, #tempFileExistsAndNotEmpty, #flushWriteBuffer (pour l'écriture bufferisée)

    async #flushWriteBuffer() { /* ... */ } // Implémentation de l'écriture asynchrone par lots
    startBackupInterval() { /* ... */ } // Méthode pour démarrer l'intervalle de backup
    stopBackup() { /* ... */ } // Méthode pour arrêter l'intervalle de backup
    async appendToTempFile(data) { /* ... */ } // Méthode pour ajouter des données au buffer
}