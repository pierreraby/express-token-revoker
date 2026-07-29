import { BloomFilter } from './bloomfilter.js';

/**
 * BloomFilterFactory class
 */
export class BloomFilterFactory {
  /**
   * Create a new BloomFilter instance
   * @param numItems - Number of items to store in the filter
   * @param fpRate - False positive rate
   * @returns A new BloomFilter instance
   */
  static create(numItems: number, fpRate: number): BloomFilter {
    return BloomFilter.withTargetError(numItems, fpRate);
  }

  /**
   * Create a new BloomFilter instance from buckets and k
   * @param buckets - Array of buckets
   * @param k - Number of hash functions
   * @returns A new BloomFilter instance
   */
  static createFromBuckets(buckets: Int32Array, k: number): BloomFilter {
    return new BloomFilter(Array.from(buckets), k);
  }
}
