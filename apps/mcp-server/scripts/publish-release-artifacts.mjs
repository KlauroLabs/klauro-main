#!/usr/bin/env node

import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyReleaseProofReceipt } from './release-proof-receipt.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function publishReleaseArtifacts(destination, root = packageRoot, environment = process.env) {
  const { manifest: releaseManifest } = verifyReleaseProofReceipt(root, environment);
  const seaManifest = JSON.parse(readFileSync(path.join(root, 'dist-sea', 'manifest.json'), 'utf8'));
  mkdirSync(destination, { recursive: true });

  for (const target of seaManifest.targets || []) {
    copyFileSync(path.join(root, 'dist-sea', target.file), path.join(destination, target.file));
    copyFileSync(path.join(root, 'dist-sea', `${target.file}.sha256`), path.join(destination, `${target.file}.sha256`));
  }

  const tarballSource = path.join(root, '.pack', 'klauro-latest.tgz');
  copyFileSync(tarballSource, path.join(destination, `klauro-${releaseManifest.version}.tgz`));
  replace(path.join(destination, 'klauro-latest.tgz'), tarballSource);
  replace(path.join(destination, 'latest.json'), path.join(root, '.pack', 'latest.json'));
}

function replace(target, source) {
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    copyFileSync(source, temporary);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2]) throw new Error('A release destination directory is required.');
  publishReleaseArtifacts(path.resolve(process.argv[2]));
}
