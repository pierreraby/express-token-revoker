/**
 * @typedef {number | number[]} MParam
 * A number specifying the total bits of the filter, or an array-like object of 32-bit integers.
 */

/**
 * A modern BloomFilter implementation with JSDoc-based type annotations.
 */
export class BloomFilter {
  /**
   * Creates a new BloomFilter.
   * @param {MParam} m - Number of bits or array of 32-bit integers.
   * @param {number} k - Number of hash functions.
   */
  constructor(m, k) {
    this.typedArrays = typeof ArrayBuffer !== "undefined";

    let arrayLike;
    if (typeof m !== "number") {
      arrayLike = m;
      m = arrayLike.length * 32;
    }

    const n = Math.ceil(m / 32);
    this.m = n * 32;
    this.k = k;

    if (this.typedArrays) {
      const kbytes = 1 << Math.ceil(Math.log2(Math.ceil(Math.log2(this.m) / 8))); 
      const ArrayType = kbytes === 1 ? Uint8Array : kbytes === 2 ? Uint16Array : Uint32Array;
      const kbuffer = new ArrayBuffer(kbytes * k);
      const buckets = new Int32Array(n);

      if (arrayLike) {
        for (let i = 0; i < n; i++) {
          buckets[i] = arrayLike[i];
        }
      }
      this.buckets = buckets;
      this._locations = new ArrayType(kbuffer);
    } else {
      const buckets = [];
      if (arrayLike) {
        for (let i = 0; i < n; i++) {
          buckets[i] = arrayLike[i];
        }
      } else {
        for (let i = 0; i < n; i++) {
          buckets[i] = 0;
        }
      }
      this.buckets = buckets;
      this._locations = [];
    }
  }

  /**
   * Calculates the bit positions for a given string (double-hashing strategy).
   * @param {string} v - The string to be hashed.
   * @returns {number[]}
   */
  locations(v) {
    const { k, m, _locations } = this;
    let a;
    let b;

    // FNV-1a 64-bit hash
    {
      const fnv64PrimeX = 0x01b3;
      const length = v.length;
      let t0 = 0, t1 = 0, t2 = 0, t3 = 0;
      let v0 = 0x2325, v1 = 0x8422, v2 = 0x9ce4, v3 = 0xcbf2;

      for (let i = 0; i < length; i++) {
        v0 ^= v.charCodeAt(i);
        t0 = v0 * fnv64PrimeX;
        t1 = v1 * fnv64PrimeX;
        t2 = v2 * fnv64PrimeX;
        t3 = v3 * fnv64PrimeX;
        t2 += v0 << 8;
        t3 += v1 << 8;
        t1 += t0 >>> 16;
        v0 = t0 & 0xffff;
        t2 += t1 >>> 16;
        v1 = t1 & 0xffff;
        v3 = (t3 + (t2 >>> 16)) & 0xffff;
        v2 = t2 & 0xffff;
      }

      a = (v3 << 16) | v2;
      b = (v1 << 16) | v0;
    }

    // Make sure they're within range
    a = (a % m + m) % m;
    b = (b % m + m) % m;

    // Enhanced double hashing
    _locations[0] = a;
    for (let i = 1; i < k; i++) {
      a = (a + b) % m;
      b = (b + i) % m;
      _locations[i] = a;
    }
    return _locations;
  }

  /**
   * Adds a value to the filter.
   * @param {string} v
   * @returns {void}
   */
  add(v) {
    const locs = this.locations(String(v));
    for (let i = 0; i < this.k; i++) {
      this.buckets[locs[i] >> 5] |= 1 << (locs[i] & 0x1f);
    }
  }

  /**
   * Checks if a value is possibly in the filter.
   * @param {string} v
   * @returns {boolean}
   */
  test(v) {
    const locs = this.locations(String(v));
    for (let i = 0; i < this.k; i++) {
      if (!(this.buckets[locs[i] >> 5] & (1 << (locs[i] & 0x1f)))) {
        return false;
      }
    }
    return true;
  }

  /**
   * Approximates the number of elements in the filter.
   * @returns {number}
   */
  size() {
    return -this.m * Math.log(1 - this.countBits() / this.m) / this.k;
  }

  /**
   * Counts the number of bits set to 1.
   * @returns {number}
   */
  countBits() {
    const { buckets } = this;
    let bits = 0;
    for (let i = 0; i < buckets.length; i++) {
      bits += popcnt(buckets[i]);
    }
    return bits;
  }

  /**
   * Approximates the current false-positive error rate.
   * @returns {number}
   */
  error() {
    return (this.countBits() / this.m) ** this.k;
  }

  /**
   * Merges two BloomFilters into a new one, doing a union of their bits.
   * @param {BloomFilter} a
   * @param {BloomFilter} b
   * @returns {BloomFilter}
   */
  static union(a, b) {
    if (a.m === b.m && a.k === b.k) {
      const typedArrays = typeof ArrayBuffer !== "undefined";
      const l = a.m >> 5;
      const c = typedArrays ? new Int32Array(l) : new Array(l);
      for (let i = 0; i < l; i++) {
        c[i] = a.buckets[i] | b.buckets[i];
      }
      return new BloomFilter(c, a.k);
    }
    throw new Error("Bloom filters must have identical {m, k}.");
  }

  /**
   * Intersects two BloomFilters into a new one.
   * @param {BloomFilter} a
   * @param {BloomFilter} b
   * @returns {BloomFilter}
   */
  static intersection(a, b) {
    if (a.m === b.m && a.k === b.k) {
      const typedArrays = typeof ArrayBuffer !== "undefined";
      const l = a.m >> 5;
      const c = typedArrays ? new Int32Array(l) : new Array(l);
      for (let i = 0; i < l; i++) {
        c[i] = a.buckets[i] & b.buckets[i];
      }
      return new BloomFilter(c, a.k);
    }
    throw new Error("Bloom filters must have identical {m, k}.");
  }

  /**
   * Creates a BloomFilter based on target error rate.
   * @param {number} n - Expected number of items.
   * @param {number} error - Desired false-positive rate.
   * @returns {BloomFilter}
   */
  static withTargetError(n, error) {
    const m = Math.ceil((-n * Math.log2(error)) / Math.LN2);
    const k = Math.ceil((Math.LN2 * m) / n);
    return new BloomFilter(m, k);
  }
}

/**
 * Counts bits set to 1 in a 32-bit integer.
 * @param {number} v 
 * @returns {number}
 */
function popcnt(v) {
  // http://graphics.stanford.edu/~seander/bithacks.html#CountBitsSetParallel
  v -= (v >> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
  return ((v + (v >> 4) & 0xf0f0f0f) * 0x1010101) >> 24;
}