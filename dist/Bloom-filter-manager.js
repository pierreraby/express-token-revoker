// @ts-check

// Bloom filter manager class to manage multiple Bloom filters with rotation.
import { BloomFilter } from 'bloomfilter';

/**
 * ExtendedBloomFilter extends the original BloomFilter type by including the static method withTargetError.
 * BloomFilter class does not define the withTargetError method.
 */
/**
 * @typedef {typeof import('bloomfilter').BloomFilter & {
*   withTargetError: (numItems: number, fpRate: number) => import('bloomfilter').BloomFilter
* }} ExtendedBloomFilter
*/

/** @type {ExtendedBloomFilter} */
const ExtendedBloomFilter = /** @type {ExtendedBloomFilter} */ (BloomFilter);

/**
 * @typedef {Object} BloomFilterOptions
 * @property {number} numItems - Number of items to store in the filter.
 * @property {number} fpRate - Target false positive rate.
 * @property {number} rotateTime - Filter rotation interval in milliseconds.
 */
export class BloomFilterManager {
  /**
   * Creates an instance of BloomFilterManager.
   * @param {BloomFilterOptions} options - Bloom filter configuration.
   */
  constructor(options) {

    const { numItems, fpRate, rotateTime } = options;

    if (!numItems || !Number.isInteger(numItems)  || numItems <= 0) {
      throw new Error('numItems must be a positive integer.');
    }
    if (!fpRate || fpRate <= 0 || fpRate >= 1) {
      throw new Error('fpRate must be a number between 0 and 1 (exclusive).');
    }
    if (!rotateTime || !Number.isInteger(rotateTime) || rotateTime <= 0) {
      throw new Error('rotateTime must be a positive integer.');
    }

    /** @private */
    this.numItems = numItems;
    /** @private */
    this.fpRate = fpRate;
    /** @private */
    this.rotateTime = rotateTime;

    console.log(
      `Initializing BloomFilterManager with numItems=${this.numItems}, fpRate=${this.fpRate}, rotateTime=${this.rotateTime}`
    );

    /**
     * @private
     * @type {BloomFilter | null}
     */
    this.previous = null; // Previous filter

    /**
     * @private
     * @type {BloomFilter | null}
     */
    this.current = this._createBloomFilter(); // Current filter

    /**
    /** @private
     * @type {NodeJS.Timeout | null}
     */
    this.rotationInterval = setInterval(() => this.rotate(), this.rotateTime);
  }

  /**
   * Creates a new Bloom filter.
   * @private
   * @returns {BloomFilter}
   */
  _createBloomFilter() {
    return ExtendedBloomFilter.withTargetError(this.numItems, this.fpRate);
  }

  /**
   * Rotates the Bloom filters.
   * @private
   */
  async rotate() {
    try {
      console.log('Rotating Bloom filters...');
      this.previous = this.current;
      this.current = this._createBloomFilter();
    } catch (error) {
      console.error('Error rotating Bloom filters:', error);
    } 
  }

  /**
   * Adds a value to the current and next filters.
   * @param {string} value - The value to add.
   * @throws {TypeError} If the value is not a string.
   */
  add(value) {
    if (typeof value !== 'string') {
      const error = new TypeError('Value must be a string.');
      console.error(error.message);
      throw error;
    }
    try {
      this.current?.add(value);
    } catch (error) {
      console.error('Error adding value to Bloom filter:', error);
      throw error;
    }
  }

  /**
   * Checks for the presence of a value in the current and previous Bloom filters.
   * @param {string} value - The value to check.
   * @returns {boolean} - `true` if the value might be present, `false` if it is definitely absent.
   */
  has(value) {
    return (
      (this.current ? this.current.test(value) : false) ||
      (this.previous ? this.previous.test(value) : false)
    );
  }

  /**
   * Resets the Bloom filters.
   */
  async reset() {
    try {
      this.previous = null;
      this.current = this._createBloomFilter();
      console.log('Bloom filters reset.');
    } catch (error) {
      console.error('Error resetting Bloom filters:', error);
      throw error;
    } 
  }

  /**
   * Stops the Bloom filter rotation interval.
   */
  stopRotation() {
    if (this.rotationInterval !== null) {
      clearInterval(this.rotationInterval);
      this.rotationInterval = null;
      console.log('Bloom filter rotation stopped.');
    }
  }

  /**
   * Cleans up resources when the instance is destroyed.
   */
  destroy() {
    this.stopRotation();
    this.previous = null;
    this.current = null;
    console.log('BloomFilterManager destroyed.');
  }
}


