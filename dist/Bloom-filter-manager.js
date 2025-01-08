// @ts-check

// Bloom filter manager class to manage multiple Bloom filters with rotation.
import { BloomFilter } from './bloomfilter.js';
import fs from 'fs';
import path from 'path';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

// Define __filename and __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * ExtendedBloomFilter extends the original BloomFilter type by including the static method withTargetError.
 * BloomFilter class does not define the withTargetError method.
 */
// /**
//  * @typedef {typeof import('bloomfilter').BloomFilter & {
//  *  k: number
// *   withTargetError: (numItems: number, fpRate: number) => import('bloomfilter').BloomFilter
// * }} ExtendedBloomFilter
// */


// /** @type {ExtendedBloomFilter} */
// const ExtendedBloomFilter = /** @type {ExtendedBloomFilter} */ (BloomFilter);

// /**
//  * @typedef {import('bloomfilter').BloomFilter & {
// *   k: number | undefined
// * }} BloomFilterWithK
// */


/**
 * @typedef {Object} BloomFilterOptions
 * @property {number} numItems - Number of items to store in the filter.
 * @property {number} fpRate - Target false positive rate.
 * @property {number} rotateTime - Filter rotation interval in milliseconds.
 * @property {import('pino').Logger} logger - Logger instance.
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
    instanceId = 0;

  /**
   * @private
   * @type {number}
   */
    static count = 0;

  /**
   * @private
   * @type {import('pino').Logger}
   */
  logger;

  /**
   * Creates an instance of BloomFilterManager.
   * @param {BloomFilterOptions} options - Bloom filter configuration.
   */
  constructor(options) {

    const { numItems, fpRate, rotateTime, logger } = options;

    if (!numItems || !Number.isInteger(numItems)  || numItems <= 0) {
      throw new Error('numItems must be a positive integer.');
    }
    if (!fpRate || fpRate <= 0 || fpRate >= 1) {
      throw new Error('fpRate must be a number between 0 and 1 (exclusive).');
    }
    if (!rotateTime || !Number.isInteger(rotateTime) || rotateTime <= 0) {
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

    this.logger.info(
      `Initializing BloomFilterManager with numItems=${this.numItems}, fpRate=${this.fpRate}, rotateTime=${this.rotateTime}`
    );

    this._ensureBackupDirExists();

    this.current = this._createBloomFilter();

    this.rotationInterval = setInterval(() => this.rotate(), this.rotateTime);
    this.backupInterval = setInterval(() => this.backup(), 5 * 60 * 1000); // Backup every 5 minutes

    this.restore();
  }

  /**
   * Creates a new Bloom filter.
   * @private
   * @returns {BloomFilter}
   */
  _createBloomFilter() {
    const newFilter = BloomFilter.withTargetError(this.numItems, this.fpRate);
    return newFilter;
  }

  /**
  * Ensures that the backup directory exists.
  * @private
  * @returns {void}
  */
   _ensureBackupDirExists() {
    const backupDir = path.join(__dirname, '../backup');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
      this.logger.debug('Dossier de sauvegarde créé');
    }
  }

  /**
   * Rotates the Bloom filters.
   * @private
   * @throws {Error} If an error occurs while rotating the filters.
   */
  rotate() {
    try {
      this.logger.debug('Rotating Bloom filters...');
      this.previous = this.current;
      this.current = this._createBloomFilter();
    } catch (error) {
      this.logger.error('Error rotating Bloom filters:', error);
    } 
  }

  /**
   * Adds a value to the current and next filters.
   * @param {string} value - The value to add.
   * @returns {void}
   * @throws {TypeError} If the value is not a string.
   */
  add(value) {
    if (typeof value !== 'string') {
      throw new TypeError('Value must be a string.');
    }
    try {
      this.current?.add(value);
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
      this.logger.error('Error in has:', error);
        return false;
    }
  }
  /**
   * Backup the current and previous filters.
   * @private
   * @returns {void}
   * @throws {Error} If an error occurs while backing up the filters.
   */
  backup() {
    try {
      if (this.current) {
        const buffer = Array.isArray(this.current.buckets)
          ? Buffer.from(this.current.buckets)
          : Buffer.from(this.current.buckets.buffer); // Convertir en buffer
        fs.writeFileSync('./backup/current.blob' + this.instanceId, buffer);
        this.logger.debug('Backup done for current filter :' + this.instanceId);
      }
      if (this.previous) {
        const buffer = Array.isArray(this.previous.buckets)
          ? Buffer.from(this.previous.buckets)
          : Buffer.from(this.previous.buckets.buffer);
        fs.writeFileSync('./backup/previous.blob' + this.instanceId, buffer);
        this.logger.debug('Backup done for previous filter :' + this.instanceId);
      }
    } catch (error) {
      this.logger.error('Backup failed:', error);
    }
  }

  /**
   * Restore the current and previous filters.
   * @private
   * @returns {void}
   * @throws {Error} If an error occurs while restoring the filters.
   */
  restore() {
    try {
      const currentPath = path.join(__dirname, '../backup', 'current.blob' + this.instanceId);
      const previousPath = path.join(__dirname, '../backup', 'previous.blob' + this.instanceId);

      if (fs.existsSync(currentPath)) {

      const buffer = fs.readFileSync(currentPath);
      const buckets = new Int32Array(buffer.buffer, buffer.byteOffset, buffer.length / Int32Array.BYTES_PER_ELEMENT);
      if (this.current) {
        this.current = new BloomFilter(Array.from(buckets), this.current.k);
      }
      } else {
        this.logger.info('No current backup to restore for instance ' + this.instanceId);
      }

      if (fs.existsSync(previousPath)) {
      const buffer2 = fs.readFileSync(previousPath);
      const buckets2 = new Int32Array(buffer2.buffer, buffer2.byteOffset, buffer2.length / Int32Array.BYTES_PER_ELEMENT);
      if (this.previous) {
        this.previous = new BloomFilter(Array.from(buckets2), this.previous.k);
      }
      } else {
        this.logger.info('No previous backup to restore for instance ' + this.instanceId);
      }
    } catch (error) {
      this.logger.error('Restore failed:', error);
    }
  }


  /**
   * Resets the Bloom filters.
   * @throws {Error} If an error occurs while resetting the filters.
   */
  reset() {
    try {
      this.previous = null;
      this.current = this._createBloomFilter();
      this.logger.debug('Bloom filters reset.');
    } catch (error) {
      this.logger.error('Error resetting Bloom filters:', error);
      throw error;
    } 
  }

  /**
   * Stops the Bloom filter rotation interval.
   * @returns {void}
   */
  stopRotation() {
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
  stopBackup() {
    if (this.backupInterval !== null) {
      clearInterval(this.backupInterval);
      this.backupInterval = null;
      this.logger.debug('Bloom filter backup stopped.');
    }
  }

  /**
   * Cleans up resources when the instance is destroyed.
   * @returns {void}
   */
  destroy() {
    this.stopRotation();
    this.stopBackup();
    this.previous = null;
    this.current = null;
    this.logger.debug('BloomFilterManager destroyed.');
  }
}


