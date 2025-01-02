// @ts-check

// Bloom filter manager class to manage multiple Bloom filters with rotation.
import { Mutex } from 'async-mutex';
import { BloomFilter } from 'bloomfilter';

// Default configuration (can be overridden during instantiation)
const DEFAULT_ROTATE_TIME = 5 * 60 * 1000; // 30 minutes in milliseconds
const DEFAULT_NUM_ITEMS = 1000000; // 1 million items
const DEFAULT_FP_RATE = 0.000001; // 1e-6

/**
 * @typedef {typeof import('bloomfilter').BloomFilter & {
*   withTargetError: (numItems: number, fpRate: number) => import('bloomfilter').BloomFilter
* }} ExtendedBloomFilter
*/

/** @type {ExtendedBloomFilter} */
const ExtendedBloomFilter = /** @type {ExtendedBloomFilter} */ (BloomFilter);


export class BloomFilterManager {
  /**
   * Constructor to initialize the Bloom filter manager.
   * @param {Object} options - Configuration options.
   * @param {number} [options.numItems=DEFAULT_NUM_ITEMS] - Number of items to store.
   * @param {number} [options.fpRate=DEFAULT_FP_RATE] - Target false positive rate.
   * @param {number} [options.rotateTime=DEFAULT_ROTATE_TIME] - Filter rotation interval in ms.
   */

  constructor({ numItems = DEFAULT_NUM_ITEMS, fpRate = DEFAULT_FP_RATE, rotateTime = DEFAULT_ROTATE_TIME }) {
    this.numItems = numItems;
    this.fpRate = fpRate;
    this.rotateTime = rotateTime;

    this.mutex = new Mutex(); // Create a lock

    console.log(`Initializing BloomFilterManager with numItems=${numItems}, fpRate=${fpRate}, rotateTime=${rotateTime}`);

    // Initialize the filters
    this.filterClear();

    // Start the rotation interval
    this.rotationInterval = setInterval(() => this.rotate(), this.rotateTime);
  }
  /**
   * Rotates the Bloom filters.
   * @returns {Promise<void>}
   */
  async rotate() {
    const release = await this.mutex.acquire(); // Acquire a lock for rotation
    try {
      this.previous = this.current; // The current filter becomes the previous one
      this.current = this.next; // The next filter becomes the active one
      this.next = ExtendedBloomFilter.withTargetError(this.numItems, this.fpRate); // Initialize the new filter
      console.log('Bloom filters rotated.');
    } catch (error) {
      console.error('Error during Bloom filter rotation:', error);
    } finally {
      release(); // Release the lock
    }
  }

  /**
   * Resets all Bloom filters.
   */
  filterClear() {
  this.previous = ExtendedBloomFilter.withTargetError(this.numItems, this.fpRate);
  this.current = ExtendedBloomFilter.withTargetError(this.numItems, this.fpRate);
  this.next = ExtendedBloomFilter.withTargetError(this.numItems, this.fpRate);
  console.log('Bloom filters cleared.');
  }

  /**
   * Adds a value to the current and next Bloom filters.
   * @param {string} value - The value to add.
   */
  filterAdd(value) {
    if (this.current) {
      this.current.add(value);
    }
    if (this.next) {
      this.next.add(value);
    }
  }

  /**
   * Checks for the presence of a value in the current and previous Bloom filters.
   * @param {string} value - The value to check.
   * @returns {boolean} - `true` if the value might be present, `false` if it is definitely absent.
   */
  filterHas(value) {
    return (this.current ? this.current.test(value) : false) || (this.previous ? this.previous.test(value) : false);
  }

  /**
   * Stops the Bloom filter rotation interval.
   */
  stopRotation() {
    clearInterval(this.rotationInterval);
    console.log('Bloom filter rotation stopped.');
  }
}
