#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const REQUIRED_GATES = Object.freeze(['sdk-build', 'archive-allowlist', 'clean-install-smoke']);
const JS_ALLOWED = /^(?:package\/)?(?:package\.json|README\.md|LICENSE|dist\/.+)$/;
const PY_ALLOWED = /^(?:klauro_telemetry\/.+|klauro_telemetry-[^/]+\.dist-info\/(?:METADATA|WHEEL|RECORD|top_level\.txt|licenses\/LICENSE))$/;

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function assertSdkArchiveInventory(kind, entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error(`${kind} archive inventory is empty.`);
  const allowed = kind === 'javascript' ? JS_ALLOWED : kind === 'python' ? PY_ALLOWED : null;
  if (!allowed) throw new Error(`Unsupported SDK artifact kind ${kind}.`);
  const normalized = entries
    .map(entry => String(entry).replace(/^\.\//, ''))
    .filter(entry => entry.length > 0 && !entry.endsWith('/'));
  const invalid = normalized.filter(entry => !allowed.test(entry));
  if (invalid.length > 0) throw new Error(`${kind} archive contains disallowed entries: ${invalid.join(', ')}`);
  const hasLicense = normalized.some(entry => /(?:^|\/)LICENSE$/.test(entry));
  if (!hasLicense) throw new Error(`${kind} archive is missing the private-beta LICENSE.`);
  return normalized;
}

export function writeTelemetrySdkReleaseReceipt(candidateDir, expected) {
  const paths = candidatePaths(candidateDir);
  const manifestBytes = readFileSync(paths.manifest);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  validateManifest(candidateDir, manifest, expected);
  const proof = {
    schema_version: 1,
    source_sha: expected.sourceSha,
    javascript_version: expected.javascriptVersion,
    python_version: expected.pythonVersion,
    manifest_sha256: sha256(manifestBytes),
    artifacts: manifest.artifacts.map(artifact => ({
      kind: artifact.kind,
      filename: artifact.filename,
      sha256: artifact.sha256,
    })),
    passed_gates: [...REQUIRED_GATES],
  };
  const receipt = { ...proof, proof_sha256: sha256(JSON.stringify(proof)) };
  writeAtomically(paths.receipt, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

export function verifyTelemetrySdkReleaseReceipt(candidateDir, expected) {
  const paths = candidatePaths(candidateDir);
  const manifestBytes = readFileSync(paths.manifest);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  validateManifest(candidateDir, manifest, expected);
  const receipt = JSON.parse(readFileSync(paths.receipt, 'utf8'));
  const proof = {
    schema_version: receipt.schema_version,
    source_sha: receipt.source_sha,
    javascript_version: receipt.javascript_version,
    python_version: receipt.python_version,
    manifest_sha256: receipt.manifest_sha256,
    artifacts: receipt.artifacts,
    passed_gates: receipt.passed_gates,
  };
  if (receipt.schema_version !== 1) throw new Error('Unsupported telemetry SDK proof schema.');
  if (receipt.source_sha !== expected.sourceSha
    || receipt.javascript_version !== expected.javascriptVersion
    || receipt.python_version !== expected.pythonVersion) {
    throw new Error('Telemetry SDK proof identity does not match the requested source and versions.');
  }
  if (receipt.manifest_sha256 !== sha256(manifestBytes)) throw new Error('Telemetry SDK manifest digest changed after proof.');
  if (JSON.stringify(receipt.passed_gates) !== JSON.stringify(REQUIRED_GATES)) {
    throw new Error('Telemetry SDK proof is missing required gates.');
  }
  if (receipt.proof_sha256 !== sha256(JSON.stringify(proof))) throw new Error('Telemetry SDK proof digest is invalid.');
  return { manifest, receipt };
}

export function expectedTelemetrySdkIdentity(environment = process.env) {
  const sourceSha = String(environment.KLAURO_RELEASE_SHA || '').trim().toLowerCase();
  const javascriptVersion = String(environment.KLAURO_JS_SDK_VERSION || '').trim();
  const pythonVersion = String(environment.KLAURO_PY_SDK_VERSION || '').trim();
  if (!GIT_SHA.test(sourceSha)) throw new Error('KLAURO_RELEASE_SHA must be the exact 40-character source commit SHA.');
  if (!SEMVER.test(javascriptVersion) || !SEMVER.test(pythonVersion)) {
    throw new Error('Both telemetry SDK versions must be exact semantic versions.');
  }
  return { sourceSha, javascriptVersion, pythonVersion };
}

function validateManifest(candidateDir, manifest, expected) {
  if (manifest.schema_version !== 1 || manifest.source_sha !== expected.sourceSha || manifest.git_clean !== true) {
    throw new Error('Telemetry SDK manifest is not bound to the exact clean release source.');
  }
  if (manifest.javascript_version !== expected.javascriptVersion || manifest.python_version !== expected.pythonVersion) {
    throw new Error('Telemetry SDK manifest version does not match package versions.');
  }
  if (manifest.install_smoke !== true) throw new Error('Telemetry SDK clean-install smoke was not completed.');
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 2) {
    throw new Error('Telemetry SDK manifest must contain exactly the JavaScript and Python artifacts.');
  }
  const kinds = new Set();
  for (const artifact of manifest.artifacts) {
    if (kinds.has(artifact.kind)) throw new Error('Telemetry SDK manifest contains duplicate artifact kinds.');
    kinds.add(artifact.kind);
    if (!['javascript', 'python'].includes(artifact.kind)) throw new Error('Telemetry SDK manifest contains an unknown artifact kind.');
    if (path.basename(artifact.filename) !== artifact.filename) throw new Error('Telemetry SDK artifact filename must be a basename.');
    const digest = sha256(readFileSync(path.join(candidateDir, artifact.filename)));
    if (!SHA256.test(String(artifact.sha256)) || digest !== artifact.sha256) {
      throw new Error(`${artifact.kind} SDK artifact digest does not match the candidate.`);
    }
    assertSdkArchiveInventory(artifact.kind, artifact.entries);
  }
  if (!kinds.has('javascript') || !kinds.has('python')) throw new Error('Telemetry SDK manifest is missing an artifact kind.');
}

function candidatePaths(candidateDir) {
  return {
    manifest: path.join(candidateDir, 'manifest.json'),
    receipt: path.join(candidateDir, 'release-proof.json'),
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
  const candidateDir = path.resolve(process.argv[3] || '.telemetry-sdk-release');
  const expected = expectedTelemetrySdkIdentity();
  if (operation === 'write') writeTelemetrySdkReleaseReceipt(candidateDir, expected);
  else if (operation === 'verify') verifyTelemetrySdkReleaseReceipt(candidateDir, expected);
  else throw new Error('Expected telemetry-sdk-release-integrity.mjs write|verify [candidate-dir].');
  process.stdout.write(`Telemetry SDK release proof ${operation === 'write' ? 'written' : 'verified'}.\n`);
}
