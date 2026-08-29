#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import * as path from 'node:path';

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const REQUIRED_GATES = Object.freeze(['sdk-build', 'archive-allowlist', 'clean-install-smoke']);
const JS_ALLOWED = /^(?:package\/)?(?:package\.json|README\.md|LICENSE|dist\/.+)$/;
const PY_ALLOWED = /^(?:klauro_telemetry\/.+|klauro_telemetry-[^/]+\.dist-info\/(?:METADATA|WHEEL|RECORD|top_level\.txt|licenses\/LICENSE))$/;

function normalizePythonDistribution(value) {
  return String(value).trim().toLowerCase().replace(/[-_.]+/g, '-');
}

function normalizePythonVersion(value) {
  const match = String(value).trim().toLowerCase().match(/^(\d+)\.(\d+)\.(\d+)(?:[-_.]?(a|alpha|b|beta|rc)[-_.]?(\d+)?)?$/);
  if (!match) throw new Error(`Python SDK version is not a supported PEP 440 release or prerelease: ${value}`);
  const base = `${match[1]}.${match[2]}.${match[3]}`;
  if (!match[4]) return base;
  const phase = match[4] === 'alpha' ? 'a' : match[4] === 'beta' ? 'b' : match[4];
  return `${base}${phase}${match[5] || '0'}`;
}

function parseUniversalWheelFilename(filename, expectedVersion) {
  const match = filename.match(/^([A-Za-z0-9_.]+)-([A-Za-z0-9_.]+)-(py3)-(none)-(any)\.whl$/);
  if (!match
    || normalizePythonDistribution(match[1]) !== 'klauro-telemetry'
    || match[2] !== normalizePythonVersion(expectedVersion)) {
    throw new Error('python SDK artifact filename does not match the canonical package identity, version, and supported tags.');
  }
  return { distribution: match[1], version: match[2], tag: `${match[3]}-${match[4]}-${match[5]}` };
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function readSdkArchiveInventory(kind, archivePath) {
  let output;
  if (kind === 'javascript') output = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8' });
  else if (kind === 'python') output = execFileSync('python3', ['-c',
    'import sys,zipfile; print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', archivePath], { encoding: 'utf8' });
  else throw new Error(`Unsupported SDK artifact kind ${kind}.`);
  return assertSdkArchiveInventory(kind, output.split('\n'));
}

function readSdkArchiveEntry(kind, archivePath, entry) {
  if (kind === 'javascript') return execFileSync('tar', ['-xOzf', archivePath, entry]);
  return execFileSync('python3', ['-c',
    'import sys,zipfile; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))', archivePath, entry]);
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
  candidateDir = resolveTelemetrySdkReleaseCandidateRoot(candidateDir);
  const paths = candidatePaths(candidateDir);
  const manifestBytes = readFileSync(paths.manifest);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  validateManifest(candidateDir, manifest, expected);
  const executedInstalls = executeIsolatedArtifactSmokes(candidateDir, manifest);
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
      inventory_sha256: artifact.inventory_sha256,
      install_proof: executedInstalls[artifact.kind],
    })),
    passed_gates: [...REQUIRED_GATES],
  };
  const receipt = { ...proof, proof_sha256: sha256(JSON.stringify(proof)) };
  writeAtomically(paths.receipt, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

export function verifyTelemetrySdkReleaseReceipt(candidateDir, expected) {
  candidateDir = resolveTelemetrySdkReleaseCandidateRoot(candidateDir);
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
  const executedInstalls = executeIsolatedArtifactSmokes(candidateDir, manifest);
  const expectedArtifacts = manifest.artifacts.map(artifact => ({
    kind: artifact.kind,
    filename: artifact.filename,
    sha256: artifact.sha256,
    inventory_sha256: artifact.inventory_sha256,
    install_proof: executedInstalls[artifact.kind],
  }));
  if (JSON.stringify(receipt.artifacts) !== JSON.stringify(expectedArtifacts)) {
    throw new Error('Telemetry SDK proof artifacts or executed clean-install evidence do not match the candidate.');
  }
  return { manifest, receipt };
}

export function installTelemetrySdkReleaseCandidate(stagedDir, destinationDir, expected, options = {}) {
  const staged = resolveTelemetrySdkReleaseCandidateRoot(stagedDir);
  verifyTelemetrySdkReleaseReceipt(staged, expected);
  const lock = acquirePublicationLock(`${destinationDir}.publish.lock`, options);
  let publishedVersion;
  try {
    const destinationExisted = existsSync(destinationDir);
    mkdirSync(destinationDir, { recursive: true });
    if (!destinationExisted) syncDirectory(path.dirname(destinationDir));
    if (options.injectFailureAfterDestinationParentSync) {
      throw new Error('Injected failure after telemetry SDK destination parent sync.');
    }
    const versionsDir = path.join(destinationDir, '.versions');
    mkdirSync(versionsDir, { recursive: true });
    const versionName = `${expected.sourceSha}-${process.pid}-${Date.now()}`;
    publishedVersion = path.join(versionsDir, versionName);
    syncTree(staged);
    renameSync(staged, publishedVersion);
    syncDirectory(versionsDir);
    verifyTelemetrySdkReleaseReceipt(publishedVersion, expected);
    if (options.injectFailureAfterBackup) throw new Error('Injected telemetry SDK candidate swap failure.');
    if (options.injectCrashBeforePublish) process.kill(process.pid, 'SIGKILL');
    const pendingLink = path.join(destinationDir, `.current-${process.pid}-${Date.now()}`);
    symlinkSync(path.relative(destinationDir, publishedVersion), pendingLink, 'dir');
    syncDirectory(destinationDir);
    renameSync(pendingLink, path.join(destinationDir, 'current'));
    syncDirectory(destinationDir);
  } catch (error) {
    if (publishedVersion && existsSync(publishedVersion)) rmSync(publishedVersion, { recursive: true, force: true });
    throw error;
  } finally {
    releasePublicationLock(lock);
  }
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

function executeIsolatedArtifactSmokes(candidateDir, manifest) {
  const root = mkdtempSync(path.join(tmpdir(), 'klauro-sdk-receipt-install-'));
  const javascript = manifest.artifacts.find(artifact => artifact.kind === 'javascript');
  const python = manifest.artifacts.find(artifact => artifact.kind === 'python');
  try {
    const jsRoot = path.join(root, 'javascript');
    mkdirSync(jsRoot);
    execFileSync('npm', ['install', '--prefix', jsRoot, '--ignore-scripts', '--no-audit', '--no-fund', path.join(candidateDir, javascript.filename)], { stdio: 'pipe' });
    execFileSync(process.execPath, ['-e', `const sdk=require(${JSON.stringify(path.join(jsRoot, 'node_modules/@klauro/telemetry'))}); if(typeof sdk.init!=='function') process.exit(1)`], { stdio: 'pipe' });
    const pyRoot = path.join(root, 'python');
    mkdirSync(pyRoot);
    execFileSync('python3', ['-m', 'pip', 'install', '--no-deps', '--target', pyRoot, path.join(candidateDir, python.filename)], { stdio: 'pipe' });
    execFileSync('python3', ['-c', 'import sys; sys.path.insert(0, sys.argv[1]); import klauro_telemetry; assert callable(klauro_telemetry.init)', pyRoot], { stdio: 'pipe' });
    return {
      javascript: {
        artifact_sha256: javascript.sha256,
        isolated: true,
        command: ['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund', javascript.filename],
        smoke_command: ['node', '-e', "require('@klauro/telemetry').init"],
      },
      python: {
        artifact_sha256: python.sha256,
        isolated: true,
        command: ['python3', '-m', 'pip', 'install', '--no-deps', '--target', '<isolated>', python.filename],
        smoke_command: ['python3', '-c', 'import klauro_telemetry'],
      },
    };
  } catch (error) {
    throw new Error(`Telemetry SDK receipt clean-install execution failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function validateManifest(candidateDir, manifest, expected) {
  if (manifest.schema_version !== 1 || manifest.source_sha !== expected.sourceSha || manifest.git_clean !== true) {
    throw new Error('Telemetry SDK manifest is not bound to the exact clean release source.');
  }
  if (manifest.javascript_version !== expected.javascriptVersion || manifest.python_version !== expected.pythonVersion) {
    throw new Error('Telemetry SDK manifest version does not match package versions.');
  }
  if (manifest.install_smoke !== true || manifest.local_installable !== true) throw new Error('Telemetry SDK clean-install smoke was not completed.');
  if (manifest.distributable !== false || manifest.publishable !== false
    || !Array.isArray(manifest.blockers) || !manifest.blockers.includes('private_beta_license_requires_distribution_authorization')) {
    throw new Error('Telemetry SDK candidate must remain non-distributable under the private-beta license.');
  }
  if (!SHA256.test(String(expected.authoritativeLicenseSha256))
    || manifest.license_sha256 !== expected.authoritativeLicenseSha256) {
    throw new Error('Telemetry SDK candidate license is not bound to the authoritative root private-beta license.');
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 2) {
    throw new Error('Telemetry SDK manifest must contain exactly the JavaScript and Python artifacts.');
  }
  const kinds = new Set();
  for (const artifact of manifest.artifacts) {
    if (kinds.has(artifact.kind)) throw new Error('Telemetry SDK manifest contains duplicate artifact kinds.');
    kinds.add(artifact.kind);
    if (!['javascript', 'python'].includes(artifact.kind)) throw new Error('Telemetry SDK manifest contains an unknown artifact kind.');
    if (path.basename(artifact.filename) !== artifact.filename) throw new Error('Telemetry SDK artifact filename must be a basename.');
    const canonicalFilename = artifact.kind === 'javascript'
      ? `klauro-telemetry-${expected.javascriptVersion}.tgz`
      : null;
    const wheelIdentity = artifact.kind === 'python'
      ? parseUniversalWheelFilename(artifact.filename, expected.pythonVersion)
      : null;
    if (canonicalFilename && artifact.filename !== canonicalFilename) {
      throw new Error(`${artifact.kind} SDK artifact filename does not match the canonical package identity, version, and supported tags.`);
    }
    const digest = sha256(readFileSync(path.join(candidateDir, artifact.filename)));
    if (!SHA256.test(String(artifact.sha256)) || digest !== artifact.sha256) {
      throw new Error(`${artifact.kind} SDK artifact digest does not match the candidate.`);
    }
    const archivePath = path.join(candidateDir, artifact.filename);
    const entries = readSdkArchiveInventory(artifact.kind, archivePath);
    if (wheelIdentity) {
      const distInfoRoot = `${wheelIdentity.distribution}-${wheelIdentity.version}.dist-info`;
      const invalidRoots = entries.filter(entry =>
        !entry.startsWith('klauro_telemetry/') && !entry.startsWith(`${distInfoRoot}/`));
      if (invalidRoots.length > 0 || entries.some(entry => /\.(?:so|pyd|dll|dylib)$/i.test(entry))) {
        throw new Error(`python SDK archive contains payload outside the canonical pure-Python package roots: ${invalidRoots.join(', ')}`);
      }
      const wheelEntry = `${distInfoRoot}/WHEEL`;
      if (!entries.includes(wheelEntry)) throw new Error('Python SDK archive is missing canonical WHEEL metadata.');
      const wheelMetadata = readSdkArchiveEntry('python', archivePath, wheelEntry).toString('utf8');
      const purelib = wheelMetadata.match(/^Root-Is-Purelib:\s*(\S+)\s*$/mi)?.[1]?.toLowerCase();
      const tags = [...wheelMetadata.matchAll(/^Tag:\s*(\S+)\s*$/gmi)].map(match => match[1]).sort();
      if (purelib !== 'true' || JSON.stringify(tags) !== JSON.stringify([wheelIdentity.tag])) {
        throw new Error('Python SDK WHEEL metadata does not match the accepted pure universal wheel tags.');
      }
    }
    const inventoryDigest = sha256(JSON.stringify(entries));
    if (!SHA256.test(String(artifact.inventory_sha256)) || artifact.inventory_sha256 !== inventoryDigest) {
      throw new Error(`${artifact.kind} SDK archive inventory digest does not match the real artifact.`);
    }
    const installProof = artifact.install_proof;
    if (!installProof || installProof.isolated !== true || installProof.artifact_sha256 !== artifact.sha256
      || !Array.isArray(installProof.command) || installProof.command.length === 0
      || installProof.command.some(part => typeof part !== 'string' || part.length === 0)
      || !installProof.command.includes(artifact.filename)
      || !Array.isArray(installProof.smoke_command) || installProof.smoke_command.length === 0) {
      throw new Error(`${artifact.kind} SDK clean-install proof is not bound to the exact artifact digest and command.`);
    }
    const licenseEntry = entries.find(entry => /(?:^|\/)LICENSE$/.test(entry));
    const licenseBytes = readSdkArchiveEntry(artifact.kind, archivePath, licenseEntry);
    if (sha256(licenseBytes) !== expected.authoritativeLicenseSha256) {
      throw new Error(`${artifact.kind} SDK does not bundle the authoritative private-beta LICENSE.`);
    }
    const metadataEntry = entries.find(entry => artifact.kind === 'javascript'
      ? /(?:^|\/)package\.json$/.test(entry)
      : /\.dist-info\/METADATA$/.test(entry));
    if (!metadataEntry) throw new Error(`${artifact.kind} SDK archive is missing package metadata.`);
    const metadata = readSdkArchiveEntry(artifact.kind, archivePath, metadataEntry).toString('utf8');
    if (artifact.kind === 'javascript') {
      const packageMetadata = JSON.parse(metadata);
      if (packageMetadata.name !== '@klauro/telemetry' || packageMetadata.version !== expected.javascriptVersion) {
        throw new Error('JavaScript SDK package identity does not match the manifest.');
      }
      if (packageMetadata.license !== 'SEE LICENSE IN LICENSE') throw new Error('JavaScript SDK license metadata is not private-beta authoritative.');
    } else {
      const packageName = metadata.match(/^Name:\s*(.+)$/mi)?.[1]?.trim();
      const packageVersion = metadata.match(/^Version:\s*(.+)$/mi)?.[1]?.trim();
      if (normalizePythonDistribution(packageName) !== 'klauro-telemetry'
        || normalizePythonVersion(packageVersion) !== normalizePythonVersion(expected.pythonVersion)) {
        throw new Error('Python SDK package identity does not match the manifest.');
      }
      if (!/^License-File: LICENSE$/m.test(metadata) || /^License: MIT$/m.test(metadata)) {
        throw new Error('Python SDK license metadata is not private-beta authoritative.');
      }
    }
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

export function resolveTelemetrySdkReleaseCandidateRoot(candidateDir) {
  const current = path.join(candidateDir, 'current');
  return existsSync(current) ? realpathSync(current) : candidateDir;
}

function syncDirectory(directory) {
  const fd = openSync(directory, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function syncTree(root) {
  for (const entry of readdirSync(root)) {
    const item = path.join(root, entry);
    const stat = lstatSync(item);
    if (stat.isDirectory()) syncTree(item);
    else if (stat.isFile()) {
      const fd = openSync(item, 'r');
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
  }
  syncDirectory(root);
}

function processStart(pid) {
  try {
    const value = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return value.slice(value.lastIndexOf(') ') + 2).trim().split(/\s+/)[19];
  } catch (error) {
    return error?.code === 'ENOENT' ? null : undefined;
  }
}

function bootId() {
  try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || undefined; } catch { return undefined; }
}

function acquirePublicationLock(lockDir, options = {}) {
  const instance = process.env.KLAURO_RELEASE_LOCK_INSTANCE?.trim() || hostname();
  const boot = bootId();
  const start = processStart(process.pid);
  const deadline = Date.now() + 30_000;
  while (true) {
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const pending = `${lockDir}.pending-${token}`;
    mkdirSync(pending);
    writeFileSync(path.join(pending, 'owner.json'), `${JSON.stringify({ token, pid: process.pid, instance, boot_id: boot, process_start: start })}\n`, { flag: 'wx' });
    syncTree(pending);
    try {
      renameSync(pending, lockDir);
      syncDirectory(path.dirname(lockDir));
      return { lockDir, token };
    } catch (error) {
      rmSync(pending, { recursive: true, force: true });
      if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw error;
      let owner;
      try { owner = JSON.parse(readFileSync(path.join(lockDir, 'owner.json'), 'utf8')); } catch { throw new Error(`Release publication lock has unknown ownership: ${lockDir}`); }
      const sameInstance = owner.instance === instance;
      const priorBoot = sameInstance && boot && owner.boot_id && owner.boot_id !== boot;
      const ownerStart = sameInstance && boot && owner.boot_id === boot && Number.isInteger(owner.pid) ? processStart(owner.pid) : undefined;
      const deadOrReused = ownerStart === null || (typeof ownerStart === 'string' && ownerStart !== owner.process_start);
      if (!priorBoot && !deadOrReused) {
        if (Date.now() >= deadline) throw new Error(`Release publication lock is held or ownership is unknown: ${lockDir}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        continue;
      }
      options.beforeStaleRecovery?.(owner);
      const stale = `${lockDir}.stale-${sha256(String(owner.token || 'unknown'))}`;
      try {
        renameSync(lockDir, stale);
      } catch (recoveryError) {
        if (['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(recoveryError?.code)) continue;
        throw recoveryError;
      }
      syncDirectory(path.dirname(lockDir));
    }
  }
}

function releasePublicationLock(lock) {
  let owner;
  try { owner = JSON.parse(readFileSync(path.join(lock.lockDir, 'owner.json'), 'utf8')); } catch { return; }
  if (owner.token !== lock.token) return;
  const released = `${lock.lockDir}.released-${lock.token}`;
  renameSync(lock.lockDir, released);
  rmSync(released, { recursive: true, force: true });
  syncDirectory(path.dirname(lock.lockDir));
}
