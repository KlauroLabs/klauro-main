#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptPackageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requiredGates = Object.freeze(['spec-purity', 'release-artifact-build']);

export function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

export function writeReleaseProofReceipt(packageRoot = scriptPackageRoot, environment = process.env) {
  const expected = expectedIdentity(environment);
  const paths = releasePaths(packageRoot);
  const manifestBytes = readFileSync(paths.manifest);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const tarballSha256 = sha256(readFileSync(paths.tarball));
  assertManifestIdentity(manifest, expected, tarballSha256);
  const proof = {
    schema_version: 1,
    version: expected.version,
    git_sha: expected.gitSha,
    tarball_sha256: tarballSha256,
    manifest_sha256: sha256(manifestBytes),
    passed_gates: [...requiredGates],
  };
  const receipt = { ...proof, proof_sha256: sha256(JSON.stringify(proof)) };
  writeAtomically(paths.receipt, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

export function verifyReleaseProofReceipt(packageRoot = scriptPackageRoot, environment = process.env) {
  const expected = expectedIdentity(environment);
  const paths = releasePaths(packageRoot);
  const manifestBytes = readFileSync(paths.manifest);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const tarballSha256 = sha256(readFileSync(paths.tarball));
  assertManifestIdentity(manifest, expected, tarballSha256);
  const receipt = JSON.parse(readFileSync(paths.receipt, 'utf8'));
  const proof = {
    schema_version: receipt.schema_version,
    version: receipt.version,
    git_sha: receipt.git_sha,
    tarball_sha256: receipt.tarball_sha256,
    manifest_sha256: receipt.manifest_sha256,
    passed_gates: receipt.passed_gates,
  };
  if (receipt.schema_version !== 1) throw new Error(`Unsupported release proof schema ${receipt.schema_version}.`);
  if (receipt.version !== expected.version || receipt.git_sha !== expected.gitSha) {
    throw new Error('Release proof identity does not match the requested version and commit.');
  }
  if (receipt.tarball_sha256 !== tarballSha256 || receipt.manifest_sha256 !== sha256(manifestBytes)) {
    throw new Error('Release proof artifact digests do not match the current candidate.');
  }
  if (JSON.stringify(receipt.passed_gates) !== JSON.stringify(requiredGates)) {
    throw new Error('Release proof does not contain the complete required gate set.');
  }
  if (receipt.proof_sha256 !== sha256(JSON.stringify(proof))) {
    throw new Error('Release proof digest is invalid.');
  }
  return { manifest, receipt };
}

function expectedIdentity(environment) {
  const version = String(environment.KLAURO_RELEASE_VERSION || '').trim();
  const gitSha = String(environment.KLAURO_RELEASE_SHA || '').trim().toLowerCase();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('KLAURO_RELEASE_VERSION must be an exact semantic version.');
  }
  if (!/^[0-9a-f]{40}$/.test(gitSha)) {
    throw new Error('KLAURO_RELEASE_SHA must be the exact 40-character release commit SHA.');
  }
  return { version, gitSha };
}

function assertManifestIdentity(manifest, expected, tarballSha256) {
  if (manifest.version !== expected.version || String(manifest.git_sha).toLowerCase() !== expected.gitSha) {
    throw new Error('Release manifest identity does not match the requested version and commit.');
  }
  if (!/^[0-9a-f]{64}$/.test(String(manifest.tarball_sha256 || ''))) {
    throw new Error('Release manifest is missing a valid tarball SHA-256 digest.');
  }
  if (manifest.tarball_sha256 !== tarballSha256) {
    throw new Error('Release manifest tarball digest does not match the current candidate.');
  }
}

function releasePaths(packageRoot) {
  const pack = path.join(packageRoot, '.pack');
  return {
    manifest: path.join(pack, 'latest.json'),
    receipt: path.join(pack, 'release-proof.json'),
    tarball: path.join(pack, 'klauro-latest.tgz'),
  };
}

function writeAtomically(destination, contents) {
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, contents, { flag: 'wx' });
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const operation = process.argv[2];
  if (operation === 'write') writeReleaseProofReceipt();
  else if (operation === 'verify') verifyReleaseProofReceipt();
  else throw new Error('Expected release-proof-receipt.mjs write|verify.');
  process.stdout.write(`Release proof ${operation === 'write' ? 'written' : 'verified'}.\n`);
}
