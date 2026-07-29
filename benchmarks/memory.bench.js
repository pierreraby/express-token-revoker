// Memory benchmark: real footprint of the 3-filter rotation scheme vs theory.
//
// The library keeps three filters alive at all times (previous, current, next)
// so that revocations survive one rotation window. This bench allocates three
// filters exactly like the manager does and measures the actual external
// memory (ArrayBuffer) growth, then compares it against the theoretical size
// m = ceil(-n * log2(p) / ln2) bits.
//
// Adapted from the original express-bloom-guard POC (bench-memory.js).

import { ensureBuild } from './_shared.js';

ensureBuild();

const { BloomFilter } = await import('../build/bloomfilter.js');

const NUM_ITEMS = 1_000_000; // 1M items per filter
const FP_RATE = 1e-9; // tight rate → larger filters, easier to measure
const NUM_FILTERS = 3; // previous + current + next

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

function snapshot(label) {
  const u = process.memoryUsage();
  console.log(`\n${label}`);
  console.log(`  rss          : ${mb(u.rss)}`);
  console.log(`  heapUsed     : ${mb(u.heapUsed)}`);
  console.log(`  external     : ${mb(u.external)}`);
  console.log(`  arrayBuffers : ${mb(u.arrayBuffers)}`);
  return u;
}

console.log(
  `Memory benchmark — ${NUM_FILTERS} filters × ${NUM_ITEMS.toLocaleString()} items, fpRate=${FP_RATE}`
);

const before = snapshot('Before initialization:');

// Force V8/GC to settle so the diff is not polluted by pending garbage.
global.gc?.();

const filters = [];
for (let i = 0; i < NUM_FILTERS; i++) {
  filters.push(BloomFilter.withTargetError(NUM_ITEMS, FP_RATE));
}

const after = snapshot('After initialization:');

const externalDiff = after.external - before.external;
console.log('\n=== Results ===');
console.log(`external memory growth : ${mb(externalDiff)} (total)`);
console.log(`per filter (measured)  : ${mb(externalDiff / NUM_FILTERS)}`);

// Theoretical size: m bits, where m = ceil(-n * log2(p) / ln2).
const bits = Math.ceil((-NUM_ITEMS * Math.log2(FP_RATE)) / Math.LN2);
const theoreticalPerFilter = bits / 8;
console.log(`per filter (theory)    : ${mb(theoreticalPerFilter)}`);
console.log(`bits per filter        : ${bits.toLocaleString()}`);

// Keep the filters reachable so they are not collected before measurement.
if (filters.length !== NUM_FILTERS) {
  throw new Error('unreachable');
}
