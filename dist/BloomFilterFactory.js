// @ts-check

import { BloomFilter } from './bloomfilter.js';

/**
 * BloomFilterFactory class
 */
export class BloomFilterFactory {
  /**
   * Create a new BloomFilter instance
   * @param {number} numItems - Number of items to store in the filter
   * @param {number} fpRate - False positive rate
   * @returns {BloomFilter} - A new BloomFilter instance
   */
  static create(numItems, fpRate) {
    return BloomFilter.withTargetError(numItems, fpRate);
  }

  /**
   * Create a new BloomFilter instance from buckets and k
   * @param {Int32Array} buckets - Array of buckets
   * @param {number} k - Number of hash functions
   * @returns {BloomFilter} - A new BloomFilter instance
   */
  static createFromBuckets(buckets, k) {
    return new BloomFilter(Array.from(buckets), k);
  }
}