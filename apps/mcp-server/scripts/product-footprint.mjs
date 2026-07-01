#!/usr/bin/env node
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  formatCheck,
  inspectProductFootprint,
} from './environment-checks.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs(process.argv.slice(2));
const checks = inspectProductFootprint({
  packageRoot,
  includeStorage: !args.noStorage,
});

if (args.json) {
  process.stdout.write(`${JSON.stringify({
    generated_at: new Date().toISOString(),
    package_root: packageRoot,
    checks,
  }, null, 2)}\n`);
} else {
  process.stdout.write([
    'Klauro product footprint',
    `Package: ${packageRoot}`,
    '',
    ...checks.map(formatCheck),
    '',
  ].join('\n'));
}

const blocking = checks.some(check => check.status === 'fail');
const warning = checks.some(check => check.status === 'warn');
if (blocking || (args.strict && warning)) {
  process.exitCode = 1;
}

function parseArgs(argv) {
  const parsed = { json: false, strict: false, noStorage: false };
  for (const arg of argv) {
    if (arg === '--json') parsed.json = true;
    else if (arg === '--strict') parsed.strict = true;
    else if (arg === '--no-storage') parsed.noStorage = true;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return parsed;
}

function printHelp() {
  process.stdout.write([
    'Usage: node scripts/product-footprint.mjs [options]',
    '',
    'Checks the thin local Klauro product path, not gauntlet/dev artifacts.',
    '',
    'Options:',
    '  --json        Print JSON.',
    '  --strict      Treat warnings as failures.',
    '  --no-storage  Skip local ~/.klauro storage budget warning.',
    '',
    'Budgets can be overridden with:',
    '  KLAURO_PRODUCT_BUNDLE_MAX_BYTES',
    '  KLAURO_PRODUCT_INSTALL_MAX_BYTES',
    '  KLAURO_PRODUCT_STORAGE_WARN_BYTES',
    '',
  ].join('\n'));
}
