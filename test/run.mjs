/* eslint-disable no-console */
/**
 * Runs every built test and reports which failed.
 *
 * Separate from `build.mjs` so a build error and a test failure are told
 * apart, and so adding a test is adding a file rather than editing a script.
 *
 * Usage:
 *   npm test
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const tests = fs.existsSync(dist)
  ? fs.readdirSync(dist).filter((name) => name.endsWith('.test.mjs')).sort()
  : [];

if (!tests.length) {
  console.error('no built tests found -- run test/build.mjs first');
  process.exit(1);
}

const failed = tests.filter((name) => {
  console.log(`\n=== ${name} ===`);
  return spawnSync(process.execPath, [path.join(dist, name)], { stdio: 'inherit' }).status !== 0;
});

console.log(failed.length
  ? `\n${failed.length} of ${tests.length} test files FAILED: ${failed.join(', ')}`
  : `\n${tests.length} test files passed`);
process.exit(failed.length ? 1 : 0);
