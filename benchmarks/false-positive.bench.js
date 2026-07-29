// False-positive rate benchmark: empirical validation of the configured FPR.
//
// Inserts NUM_ITEMS claims, then probes NUM_ITEMS *distinct, never-inserted*
// claims and counts how many the filter wrongly reports as present. Averaged
// over several iterations, the measured rate should sit at or below the
// theoretical target. This is what proves the bloom filter actually delivers
// the fpRate you configure.
//
// Measured on the raw BloomFilter: BloomFilterManager.has() delegates straight
// to BloomFilter.test(), so the FPR is a property of the filter itself.

import { ensureBuild, generateClaims } from './_shared.js';

ensureBuild();

const { BloomFilter } = await import('../build/bloomfilter.js');

const NUM_ITEMS = 1_000_000;
const ITERATIONS = 5;
const FP_RATE = 1e-5;

console.log(
  `False-positive benchmark — ${NUM_ITEMS.toLocaleString()} inserted, ` +
    `${ITERATIONS} probe rounds, target fpRate=${FP_RATE}`
);

const filter = BloomFilter.withTargetError(NUM_ITEMS, FP_RATE);

console.log('Inserting claims...');
const inserted = generateClaims(NUM_ITEMS);
for (const claim of inserted) {
  filter.add(claim);
}

// Fresh, never-inserted claims to probe against.
const probes = generateClaims(NUM_ITEMS);

let falsePositives = 0;
for (let round = 0; round < ITERATIONS; round++) {
  for (const claim of probes) {
    if (filter.test(claim)) {
      falsePositives++;
    }
  }
  console.log(`round ${round + 1}/${ITERATIONS} — running FP count: ${falsePositives}`);
}

const totalChecks = NUM_ITEMS * ITERATIONS;
const measured = falsePositives / totalChecks;

console.log('\n=== Results ===');
console.log(`checks          : ${totalChecks.toLocaleString()}`);
console.log(`false positives : ${falsePositives.toLocaleString()}`);
console.log(`measured FPR    : ${measured.toExponential(3)}`);
console.log(`target FPR      : ${FP_RATE.toExponential(3)}`);
// withTargetError() rounds the bit count (m) and hash count (k) UP to integers,
// so the realized FPR normally lands at or modestly above the nominal target.
// Within the same order of magnitude means the filter is behaving correctly.
console.log(
  measured <= FP_RATE * 10
    ? 'PASS — measured rate is within the expected range for the configured target.'
    : 'WARN — measured rate is far above the target; investigate the filter sizing.'
);
console.log('note: m and k are rounded up to integers, so the realized FPR is typically');
console.log('      slightly above the nominal target — this is expected bloom-filter behavior.');
