import { describe, it, expect } from 'vitest';
import { BloomFilter } from '../../dist/bloomfilter.js';

describe('BloomFilter static methods', () => {
  it('withTargetError creates a filter with correct dimensions', () => {
    const filter = BloomFilter.withTargetError(1000, 0.01);
    expect(filter.k).toBeGreaterThan(0);
    expect(filter.m).toBeGreaterThan(0);
  });

  it('withTargetError creates a working filter', () => {
    const filter = BloomFilter.withTargetError(1000, 0.01);
    filter.add('hello');
    expect(filter.test('hello')).toBe(true);
    expect(filter.test('world')).toBe(false);
  });

  it('union merges two filters', () => {
    const a = BloomFilter.withTargetError(100, 0.01);
    const b = BloomFilter.withTargetError(100, 0.01);
    a.add('foo');
    b.add('bar');

    const u = BloomFilter.union(a, b);
    expect(u.test('foo')).toBe(true);
    expect(u.test('bar')).toBe(true);
    expect(u.test('baz')).toBe(false);
  });

  it('union throws when filters have different m or k', () => {
    const a = BloomFilter.withTargetError(100, 0.01);
    const b = BloomFilter.withTargetError(200, 0.01);
    expect(() => BloomFilter.union(a, b)).toThrow('Bloom filters must have identical {m, k}.');
  });

  it('intersection merges two filters', () => {
    const a = BloomFilter.withTargetError(100, 0.01);
    const b = BloomFilter.withTargetError(100, 0.01);
    a.add('foo');
    a.add('common');
    b.add('bar');
    b.add('common');

    const inter = BloomFilter.intersection(a, b);
    expect(inter.test('common')).toBe(true);
    // foo and bar may or may not be present since AND collapses bits
  });

  it('intersection throws when filters have different m or k', () => {
    const a = BloomFilter.withTargetError(100, 0.01);
    const b = BloomFilter.withTargetError(200, 0.01);
    expect(() => BloomFilter.intersection(a, b)).toThrow(
      'Bloom filters must have identical {m, k}.'
    );
  });
});

describe('BloomFilter metrics', () => {
  it('size returns 0 for an empty filter', () => {
    const filter = BloomFilter.withTargetError(1000, 0.01);
    expect(filter.size()).toBeCloseTo(0);
  });

  it('size grows after adding items', () => {
    const filter = BloomFilter.withTargetError(1000, 0.01);
    for (let i = 0; i < 100; i++) {
      filter.add(`item-${i}`);
    }
    const s = filter.size();
    expect(s).toBeGreaterThan(80);
    expect(s).toBeLessThan(120);
  });

  it('error returns a rate between 0 and 1', () => {
    const filter = BloomFilter.withTargetError(1000, 0.01);
    expect(filter.error()).toBe(0);
    filter.add('hello');
    const e = filter.error();
    expect(e).toBeGreaterThan(0);
    expect(e).toBeLessThan(1);
  });

  it('countBits increases after adding items', () => {
    const filter = BloomFilter.withTargetError(1000, 0.01);
    const before = filter.countBits();
    filter.add('hello');
    const after = filter.countBits();
    expect(after).toBeGreaterThan(before);
  });
});

describe('BloomFilter construction', () => {
  it('constructs from a number of bits', () => {
    const filter = new BloomFilter(1024, 3);
    expect(filter.m).toBe(1024);
    expect(filter.k).toBe(3);
    filter.add('test');
    expect(filter.test('test')).toBe(true);
  });

  it('constructs from an array of buckets', () => {
    // Create a first filter, add some items, extract its buckets
    const original = BloomFilter.withTargetError(100, 0.01);
    original.add('hello');
    original.add('world');
    const buckets = original.buckets;

    // Reconstruct from the same buckets
    const clone = new BloomFilter(buckets, original.k);
    expect(clone.test('hello')).toBe(true);
    expect(clone.test('world')).toBe(true);
    expect(clone.test('nope')).toBe(false);
  });
});
