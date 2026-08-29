#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertSdkArchiveInventory,
  expectedTelemetrySdkIdentity as coreExpectedIdentity,
  installTelemetrySdkReleaseCandidate as coreInstall,
  readSdkArchiveInventory,
  resolveTelemetrySdkReleaseCandidateRoot,
  sha256,
  verifyTelemetrySdkReleaseReceipt as coreVerify,
  writeTelemetrySdkReleaseReceipt as coreWrite,
} from '../apps/mcp-server/src/telemetry-sdk-release-integrity.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const authoritativeLicenseSha256 = sha256(readFileSync(path.join(REPO_ROOT, 'LICENSE')));
const withLicense = expected => ({ ...expected, authoritativeLicenseSha256 });

export { assertSdkArchiveInventory, readSdkArchiveInventory, resolveTelemetrySdkReleaseCandidateRoot, sha256 };
export const expectedTelemetrySdkIdentity = environment => withLicense(coreExpectedIdentity(environment));
export const writeTelemetrySdkReleaseReceipt = (candidateDir, expected) => coreWrite(candidateDir, withLicense(expected));
export const verifyTelemetrySdkReleaseReceipt = (candidateDir, expected) => coreVerify(candidateDir, withLicense(expected));
export const installTelemetrySdkReleaseCandidate = (stagedDir, destinationDir, expected, options) =>
  coreInstall(stagedDir, destinationDir, withLicense(expected), options);

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const operation = process.argv[2];
  const candidateDir = path.resolve(process.argv[3] || '.telemetry-sdk-release');
  const expected = expectedTelemetrySdkIdentity();
  if (operation === 'write') writeTelemetrySdkReleaseReceipt(candidateDir, expected);
  else if (operation === 'verify') verifyTelemetrySdkReleaseReceipt(candidateDir, expected);
  else if (operation === 'install') installTelemetrySdkReleaseCandidate(candidateDir, path.resolve(process.argv[4]), expected, {
    injectFailureAfterBackup: process.env.KLAURO_RELEASE_FAIL_AFTER_BACKUP === '1',
  });
  else throw new Error('Expected telemetry-sdk-release-integrity.mjs write|verify [candidate-dir], or install [staged-dir] [destination-dir].');
  process.stdout.write(`Telemetry SDK release proof ${operation}.\n`);
}
