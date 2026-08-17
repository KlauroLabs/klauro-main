import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import * as fs from 'fs-extra';
import { ensurePrivateDataRoot, restrictProcessFileCreation } from './hosted-storage-security';

test('hosted processes create owner-only files by default', () => {
  if (process.platform === 'win32') return;
  const previous = process.umask();
  try {
    restrictProcessFileCreation();
    assert.equal(process.umask(), 0o077);
  } finally {
    process.umask(previous);
  }
});

test('hosted data roots deny access to other operating-system users', () => {
  if (process.platform === 'win32') return;
  const parent = mkdtempSync(path.join(os.tmpdir(), 'klauro-hosted-storage-'));
  const dataDir = path.join(parent, 'data');
  try {
    ensurePrivateDataRoot(dataDir);
    assert.equal(statSync(dataDir).mode & 0o777, 0o700);
  } finally {
    fs.removeSync(parent);
  }
});

test('hosted data root hardening repairs an existing permissive directory', () => {
  if (process.platform === 'win32') return;
  const parent = mkdtempSync(path.join(os.tmpdir(), 'klauro-hosted-storage-'));
  const dataDir = path.join(parent, 'data');
  try {
    fs.ensureDirSync(dataDir);
    fs.chmodSync(dataDir, 0o755);
    ensurePrivateDataRoot(dataDir);
    assert.equal(statSync(dataDir).mode & 0o777, 0o700);
  } finally {
    fs.removeSync(parent);
  }
});
