// @ts-check

// Bloom filter manager class to manage multiple Bloom filters with rotation.
import { Mutex } from 'async-mutex';
import { BloomFilter } from 'bloomfilter';

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
    /** @private */
    this.numItems = options.numItems;
    /** @private */
    this.fpRate = options.fpRate;
    /** @private */
    this.rotateTime = options.rotateTime;

    /** @private */
    this.mutex = new Mutex(); // Create a lock for synchronization

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
     * @private
     * @type {BloomFilter | null}
     */
    this.next = this._createBloomFilter(); // Next filter

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
    const release = this.mutex.acquire();
    release.then((releaseFn) => {
      try {
        console.log('Rotating Bloom filters...');
        this.previous = this.current;
        this.current = this.next;
        this.next = this._createBloomFilter();
      } catch (error) {
        console.error('Error rotating Bloom filters:', error);
      } finally {
        releaseFn();
      }
    });
  }

  /**
   * Adds a value to the current and next filters.
   * @param {string} value - The value to add.
   */
  async add(value) {
    const release = await this.mutex.acquire();
    try {
      this.current?.add(value);
      this.next?.add(value);
    } catch (error) {
      console.error('Error adding value to Bloom filter:', error);
    } finally {
      release();
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
  reset() {
    const release = this.mutex.acquire();
    release.then((releaseFn) => {
      try {
        this.previous = null;
        this.current = this._createBloomFilter();
        this.next = this._createBloomFilter();
        console.log('Bloom filters reset.');
      } catch (error) {
        console.error('Error resetting Bloom filters:', error);
      } finally {
        releaseFn();
      }
    });
  }

  /**
   * Stops the Bloom filter rotation interval.
   */
  stopRotation() {
    clearInterval(this.rotationInterval);
    console.log('Bloom filter rotation stopped.');
  }

  /**
   * Cleans up resources when the instance is destroyed.
   */
  destroy() {
    clearInterval(this.rotationInterval);
    this.previous = null;
    this.current = null;
    this.next = null;
    console.log('BloomFilterManager destroyed.');
  }
}


