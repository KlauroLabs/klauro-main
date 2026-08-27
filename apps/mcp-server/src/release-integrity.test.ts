import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { publishReleaseArtifacts } from '../scripts/publish-release-artifacts.mjs';
import { verifyReleaseProofReceipt, writeReleaseProofReceipt } from '../scripts/release-proof-receipt.mjs';

const version = '9.8.7';
const gitSha = 'a'.repeat(40);
const environment = { KLAURO_RELEASE_VERSION: version, KLAURO_RELEASE_SHA: gitSha };

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-release-integrity-'));
  const pack = path.join(root, '.pack');
  const sea = path.join(root, 'dist-sea');
  const destination = path.join(root, 'published');
  await fs.mkdir(pack, { recursive: true });
  await fs.mkdir(sea, { recursive: true });
  await fs.mkdir(destination, { recursive: true });
  const tarball = Buffer.from('verified release tarball');
  const tarballSha256 = createHash('sha256').update(tarball).digest('hex');
  await fs.writeFile(path.join(pack, 'klauro-latest.tgz'), tarball);
  await fs.writeFile(path.join(pack, 'latest.json'), `${JSON.stringify({
    version,
    git_sha: gitSha,
    tarball_sha256: tarballSha256,
  })}\n`);
  await fs.writeFile(path.join(sea, 'manifest.json'), '{"targets":[]}\n');
  return { root, pack, destination, tarball };
}

test('release proof binds the exact version, commit, manifest, and tarball before publication', async () => {
  const candidate = await fixture();
  try {
    const receipt = writeReleaseProofReceipt(candidate.root, environment);
    assert.equal(receipt.version, version);
    assert.equal(receipt.git_sha, gitSha);
    assert.match(receipt.proof_sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(receipt.passed_gates, ['spec-purity', 'release-artifact-build']);
    assert.equal(verifyReleaseProofReceipt(candidate.root, environment).receipt.proof_sha256, receipt.proof_sha256);
    publishReleaseArtifacts(candidate.destination, candidate.root, environment);
    assert.deepEqual(await fs.readFile(path.join(candidate.destination, 'klauro-latest.tgz')), candidate.tarball);
  } finally {
    await fs.rm(candidate.root, { recursive: true, force: true });
  }
});

test('publication rejects a missing or stale proof without replacing the prior channel', async () => {
  const candidate = await fixture();
  try {
    const oldManifest = Buffer.from('{"version":"1.0.0"}\n');
    const oldTarball = Buffer.from('prior valid tarball');
    await fs.writeFile(path.join(candidate.destination, 'latest.json'), oldManifest);
    await fs.writeFile(path.join(candidate.destination, 'klauro-latest.tgz'), oldTarball);
    assert.throws(
      () => publishReleaseArtifacts(candidate.destination, candidate.root, environment),
      /release-proof\.json/,
    );
    writeReleaseProofReceipt(candidate.root, environment);
    assert.throws(
      () => publishReleaseArtifacts(candidate.destination, candidate.root, {
        ...environment,
        KLAURO_RELEASE_SHA: 'b'.repeat(40),
      }),
      /does not match/,
    );
    assert.deepEqual(await fs.readFile(path.join(candidate.destination, 'latest.json')), oldManifest);
    assert.deepEqual(await fs.readFile(path.join(candidate.destination, 'klauro-latest.tgz')), oldTarball);
  } finally {
    await fs.rm(candidate.root, { recursive: true, force: true });
  }
});

test('tarball corruption after proof generation fails closed and preserves rollback target', async () => {
  const candidate = await fixture();
  try {
    writeReleaseProofReceipt(candidate.root, environment);
    const oldManifest = Buffer.from('{"version":"1.0.0"}\n');
    const oldTarball = Buffer.from('prior valid tarball');
    await fs.writeFile(path.join(candidate.destination, 'latest.json'), oldManifest);
    await fs.writeFile(path.join(candidate.destination, 'klauro-latest.tgz'), oldTarball);
    await fs.appendFile(path.join(candidate.pack, 'klauro-latest.tgz'), 'corruption');
    assert.throws(
      () => publishReleaseArtifacts(candidate.destination, candidate.root, environment),
      /digest does not match|digests do not match/,
    );
    assert.deepEqual(await fs.readFile(path.join(candidate.destination, 'latest.json')), oldManifest);
    assert.deepEqual(await fs.readFile(path.join(candidate.destination, 'klauro-latest.tgz')), oldTarball);
  } finally {
    await fs.rm(candidate.root, { recursive: true, force: true });
  }
});

test('tampered proof and non-full source identity are rejected', async () => {
  const candidate = await fixture();
  try {
    const receipt = writeReleaseProofReceipt(candidate.root, environment);
    await fs.writeFile(path.join(candidate.pack, 'release-proof.json'), `${JSON.stringify({ ...receipt, proof_sha256: '0'.repeat(64) })}\n`);
    assert.throws(() => verifyReleaseProofReceipt(candidate.root, environment), /proof digest is invalid/);
    assert.throws(
      () => verifyReleaseProofReceipt(candidate.root, { ...environment, KLAURO_RELEASE_SHA: gitSha.slice(0, 12) }),
      /40-character/,
    );
  } finally {
    await fs.rm(candidate.root, { recursive: true, force: true });
  }
});
