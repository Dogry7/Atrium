#!/usr/bin/env node
// Cross-version test runner: collects *.test.js files and hands them to `node --test`.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const suites = process.argv.slice(2).length ? process.argv.slice(2) : ['unit', 'integration'];
const files = [];
for (const s of suites) {
  const dir = path.join(here, s);
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    for (const f of fs.readdirSync(dir).sort()) if (f.endsWith('.test.js')) files.push(path.join(dir, f));
  } else if (fs.existsSync(s)) files.push(path.resolve(s));
}
if (!files.length) { console.error('No test files found'); process.exit(1); }
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
