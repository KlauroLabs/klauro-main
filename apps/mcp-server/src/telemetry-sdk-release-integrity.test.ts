import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  assertSdkArchiveInventory,
  verifyTelemetrySdkReleaseReceipt,
  writeTelemetrySdkReleaseReceipt,
} from '../../../scripts/telemetry-sdk-release-integrity.mjs';

const expected = {
  sourceSha: 'a'.repeat(40),
  javascriptVersion: '1.2.3',
  pythonVersion: '1.2.3',
};

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-telemetry-sdk-release-'));
  const javascript = Buffer.from('javascript sdk archive');
  const python = Buffer.from('python sdk wheel');
  await fs.writeFile(path.join(root, 'klauro-telemetry-1.2.3.tgz'), javascript);
  await fs.writeFile(path.join(root, 'klauro_telemetry-1.2.3-py3-none-any.whl'), python);
  const manifest = {
    schema_version: 1,
    source_sha: expected.sourceSha,
    git_clean: true,
    javascript_version: expected.javascriptVersion,
    python_version: expected.pythonVersion,
    install_smoke: true,
    publishable: false,
    blockers: ['license_metadata_review'],
    artifacts: [
      {
        kind: 'javascript',
        filename: 'klauro-telemetry-1.2.3.tgz',
        sha256: createHash('sha256').update(javascript).digest('hex'),
        entries: ['package/package.json', 'package/README.md', 'package/LICENSE', 'package/dist/index.js'],
      },
      {
        kind: 'python',
        filename: 'klauro_telemetry-1.2.3-py3-none-any.whl',
        sha256: createHash('sha256').update(python).digest('hex'),
        entries: [
          'klauro_telemetry/__init__.py',
          'klauro_telemetry-1.2.3.dist-info/METADATA',
          'klauro_telemetry-1.2.3.dist-info/WHEEL',
          'klauro_telemetry-1.2.3.dist-info/RECORD',
          'klauro_telemetry-1.2.3.dist-info/licenses/LICENSE',
        ],
      },
    ],
  };
  await fs.writeFile(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, manifest };
}

test('telemetry SDK proof binds clean source, versions, inventories, artifacts, and install smoke', async () => {
  const candidate = await fixture();
  try {
    const receipt = writeTelemetrySdkReleaseReceipt(candidate.root, expected);
    assert.equal(receipt.source_sha, expected.sourceSha);
    assert.match(receipt.proof_sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(receipt.passed_gates, ['sdk-build', 'archive-allowlist', 'clean-install-smoke']);
    assert.equal(verifyTelemetrySdkReleaseReceipt(candidate.root, expected).receipt.proof_sha256, receipt.proof_sha256);
  } finally {
    await fs.rm(candidate.root, { recursive: true, force: true });
  }
});

test('corrupt or stale candidates fail before replacing the prior proof receipt', async () => {
  const candidate = await fixture();
  try {
    await fs.writeFile(path.join(candidate.root, 'release-proof.json'), 'prior-valid-receipt\n');
    const prior = await fs.readFile(path.join(candidate.root, 'release-proof.json'));
    await fs.appendFile(path.join(candidate.root, 'klauro-telemetry-1.2.3.tgz'), 'corrupt');
    assert.throws(() => writeTelemetrySdkReleaseReceipt(candidate.root, expected), /digest does not match/);
    assert.deepEqual(await fs.readFile(path.join(candidate.root, 'release-proof.json')), prior);

    await assert.rejects(async () => {
      const fresh = await fixture();
      try {
        writeTelemetrySdkReleaseReceipt(fresh.root, expected);
        verifyTelemetrySdkReleaseReceipt(fresh.root, { ...expected, sourceSha: 'b'.repeat(40) });
      } finally {
        await fs.rm(fresh.root, { recursive: true, force: true });
      }
    }, /does not match|not bound/);
  } finally {
    await fs.rm(candidate.root, { recursive: true, force: true });
  }
});

test('archive allowlists reject traversal, executable extras, and missing private-beta license', () => {
  assert.throws(
    () => assertSdkArchiveInventory('javascript', ['package/package.json', 'package/../../secret', 'package/LICENSE']),
    /disallowed/,
  );
  assert.throws(
    () => assertSdkArchiveInventory('python', ['klauro_telemetry/__init__.py', 'klauro_telemetry-1.2.3.dist-info/METADATA']),
    /LICENSE/,
  );
  assert.throws(
    () => assertSdkArchiveInventory('javascript', ['package/package.json', 'package/LICENSE', 'package/install.sh']),
    /disallowed/,
  );
});
