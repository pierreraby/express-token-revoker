// Shared helpers for the benchmark suite.
//
// These benchmarks measure the *built* library (../build), i.e. the exact code
// that ships to npm. Run `pnpm build` (or `pnpm bench`, which builds first)
// before running them individually.

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Fails fast with a helpful message when the build output is missing.
 */
export function ensureBuild() {
  const probe = join(__dirname, '..', 'build', 'bloomfilter.js');
  if (!existsSync(probe)) {
    console.error('Build output not found. Run `pnpm build` (or `pnpm bench`) first.');
    process.exit(1);
  }
}

/**
 * A logger that satisfies GenericLogger but prints nothing, so benchmark
 * timings are not polluted by log I/O.
 */
export const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

/**
 * Generates `count` unique claim values shaped like real revocation items
 * (e.g. "jti-<uuid>"). Uses the native crypto.randomUUID() — no dependency.
 * @param {number} count
 * @returns {string[]}
 */
export function generateClaims(count) {
  const claims = new Array(count);
  for (let i = 0; i < count; i++) {
    claims[i] = `jti-${randomUUID()}`;
  }
  return claims;
}

/**
 * Times a synchronous loop, with a warm-up phase so V8 JIT optimizations are
 * already in place before measurement (same approach as the original POC).
 * @param {string} label - Human-readable name of the operation.
 * @param {number} iterations - Number of measured iterations.
 * @param {(i: number) => void} fn - The operation, called with the loop index.
 * @param {number} [warmup=1000] - Unmeasured warm-up iterations.
 * @returns {{ totalMs: number, avgMs: number, opsPerSec: number }}
 */
export function bench(label, iterations, fn, warmup = 1000) {
  for (let i = 0; i < warmup; i++) {
    fn(i % iterations);
  }

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn(i);
  }
  const totalMs = performance.now() - start;

  const avgMs = totalMs / iterations;
  const opsPerSec = 1000 / avgMs;

  console.log(`\n=== ${label} ===`);
  console.log(`iterations : ${iterations.toLocaleString()}`);
  console.log(`total      : ${totalMs.toFixed(2)} ms`);
  console.log(`average    : ${avgMs.toFixed(6)} ms/op`);
  console.log(`throughput : ${Math.round(opsPerSec).toLocaleString()} ops/sec`);

  return { totalMs, avgMs, opsPerSec };
}
