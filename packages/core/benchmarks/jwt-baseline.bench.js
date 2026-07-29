// JWT baseline benchmark: how fast is jwt.verify() on its own?
//
// This is the reference point for the whole library's pitch — a revocation
// check only makes sense if it is cheap *relative to* the JWT verification the
// caller is already paying for. Run this alongside throughput.bench.js and
// compare ops/sec: the bloom has() should be orders of magnitude faster than
// jwt.verify().
//
// Uses the project's devDependency `jsonwebtoken` (same lib an Express app
// would use). On very recent Node runtimes (>=26) jsonwebtoken's transitive
// dep `buffer-equal-constant-time` breaks (SlowBuffer was removed); in that
// case the bench skips cleanly instead of failing the whole suite.

import { generateClaims, bench } from './_shared.js';

const SECRET = 'bench-secret-key-not-for-production';
const NUM_TOKENS = 10_000;

let jwt;
try {
  jwt = (await import('jsonwebtoken')).default;
} catch (error) {
  console.log('jwt-baseline: SKIPPED.');
  console.log(`  jsonwebtoken could not load on Node ${process.version}:`);
  console.log(`  ${error instanceof Error ? error.message : String(error)}`);
  console.log('  This is a known buffer-equal-constant-time / SlowBuffer issue on Node >=26.');
  console.log('  Re-run on Node 20–24 to get the jwt.verify() baseline.');
  process.exit(0);
}

console.log(`JWT baseline benchmark — ${NUM_TOKENS.toLocaleString()} tokens`);

// Pre-generate a pool of valid tokens (jti claim included, like a real payload)
// so signing cost is not part of the measurement.
const ids = generateClaims(NUM_TOKENS);
const tokens = ids.map((jti) => jwt.sign({ sub: 'user-123', jti }, SECRET, { expiresIn: '1h' }));

bench('jwt.verify()', NUM_TOKENS, (i) => {
  jwt.verify(tokens[i], SECRET);
});

console.log('\nDone.');
