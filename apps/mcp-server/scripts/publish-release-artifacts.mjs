#!/usr/bin/env node

import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('A release destination directory is required.');

const releaseManifest = JSON.parse(readFileSync(path.join(packageRoot, '.pack', 'latest.json'), 'utf8'));
const seaManifest = JSON.parse(readFileSync(path.join(packageRoot, 'dist-sea', 'manifest.json'), 'utf8'));
mkdirSync(destination, { recursive: true });

for (const target of seaManifest.targets || []) {
  copyFileSync(path.join(packageRoot, 'dist-sea', target.file), path.join(destination, target.file));
  copyFileSync(path.join(packageRoot, 'dist-sea', `${target.file}.sha256`), path.join(destination, `${target.file}.sha256`));
}

const tarballSource = path.join(packageRoot, '.pack', 'klauro-latest.tgz');
copyFileSync(tarballSource, path.join(destination, `klauro-${releaseManifest.version}.tgz`));
replace(path.join(destination, 'klauro-latest.tgz'), tarballSource);
replace(path.join(destination, 'latest.json'), path.join(packageRoot, '.pack', 'latest.json'));

function replace(target, source) {
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    copyFileSync(source, temporary);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}
