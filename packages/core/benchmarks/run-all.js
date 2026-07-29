// Runs the whole benchmark suite, one file per child process so each bench
// gets a clean heap (memory measurements stay meaningful).

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const suites = [
  ['JWT baseline', 'jwt-baseline.bench.js', []],
  ['Throughput', 'throughput.bench.js', []],
  ['False-positive rate', 'false-positive.bench.js', []],
  ['Memory footprint', 'memory.bench.js', ['--expose-gc']],
];

for (const [title, file, nodeFlags] of suites) {
  console.log(`\n${'#'.repeat(60)}`);
  console.log(`# ${title}`);
  console.log('#'.repeat(60));
  try {
    execSync(`node ${nodeFlags.join(' ')} ${join(__dirname, file)}`, { stdio: 'inherit' });
  } catch {
    console.error(`Benchmark "${title}" failed.`);
    process.exitCode = 1;
    break;
  }
}

console.log('\nAll benchmarks complete.');
