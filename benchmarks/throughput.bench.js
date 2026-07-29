// Throughput benchmark: add() and has() on the raw BloomFilter vs the
// production BloomFilterManager.
//
// The raw BloomFilter isolates the pure data-structure cost. The
// BloomFilterManager adds everything the library ships with on top: input
// validation, saturation guard, metrics counters and the rotation mutex.
// Comparing the two tells you exactly what the production layer costs.
//
// Backup is intentionally disabled so we measure the core in-memory path, not
// disk I/O. Rotation is pushed far into the future so it never fires mid-bench.

import { ensureBuild, generateClaims, bench, noopLogger } from './_shared.js';

ensureBuild();

const { BloomFilter } = await import('../build/bloomfilter.js');
const { BloomFilterManager } = await import('../build/Bloom-filter-manager.js');

const NUM_ITEMS = 1_000_000; // 1M revoked tokens
const FP_RATE = 1e-6;

console.log(`Throughput benchmark — ${NUM_ITEMS.toLocaleString()} items, fpRate=${FP_RATE}`);

const claims = generateClaims(NUM_ITEMS);
// Distinct keys for the has() lookups so we exercise real hashing, not a hot
// single-key cache. We look up the inserted claims (all present → worst case
// for the hash path since every probe runs to completion).
const lookupClaims = claims;

// ---------------------------------------------------------------------------
// 1. Raw BloomFilter — pure data structure
// ---------------------------------------------------------------------------
{
  const filter = BloomFilter.withTargetError(NUM_ITEMS, FP_RATE);

  bench('raw BloomFilter.add()', NUM_ITEMS, (i) => filter.add(claims[i]));
  bench('raw BloomFilter.test()', NUM_ITEMS, (i) => filter.test(lookupClaims[i]));
}

// ---------------------------------------------------------------------------
// 2. BloomFilterManager — production layer (validation + metrics + mutex)
// ---------------------------------------------------------------------------
{
  const manager = new BloomFilterManager({
    id: 'bench',
    numItems: NUM_ITEMS,
    fpRate: FP_RATE,
    rotateTime: 60 * 60 * 1000, // 1h — never rotates during the bench
    logger: noopLogger,
  });

  try {
    bench('BloomFilterManager.add()', NUM_ITEMS, (i) => manager.add(claims[i]));
    bench('BloomFilterManager.has()', NUM_ITEMS, (i) => manager.has(lookupClaims[i]));
  } finally {
    // Stops the rotation interval so the process can exit cleanly.
    manager.destroy();
  }
}

console.log('\nDone.');
