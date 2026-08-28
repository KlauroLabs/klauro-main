import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { writeTelemetrySdkReleaseReceipt } from '../../../scripts/telemetry-sdk-release-integrity.mjs';
import { getRuntimeSdkPackage, isRuntimeSdkPackageReady } from './runtime-sdk';

function cas(): CASOutput {
  return {
    cas_version: '1.11.0',
    analysis_id: 'analysis_sdk_readiness',
    analysis_timestamp: new Date().toISOString(),
    system: {
      id: 'system',
      name: 'service',
      type: 'service',
      root_path: '/service',
      technologies: { frameworks: [{ name: 'Express' }], languages: [{ name: 'TypeScript' }] },
    },
    nodes: [],
    edges: [],
    analyzer_contributions: [],
  } as unknown as CASOutput;
}

test('runtime SDK becomes installable only with a matching source-bound artifact receipt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-sdk-ready-'));
  const sourceSha = 'a'.repeat(40);
  const artifact = Buffer.from('verified javascript package');
  const filename = 'klauro-telemetry-0.1.0.tgz';
  try {
    fs.writeFileSync(path.join(root, filename), artifact);
    fs.writeFileSync(path.join(root, 'python.whl'), 'python artifact');
    const manifest = {
      schema_version: 1,
      source_sha: sourceSha,
      git_clean: true,
      javascript_version: '0.1.0',
      python_version: '0.1.0',
      install_smoke: true,
      artifacts: [
        {
          kind: 'javascript',
          filename,
          sha256: createHash('sha256').update(artifact).digest('hex'),
          entries: ['package/package.json', 'package/README.md', 'package/LICENSE', 'package/dist/index.js'],
        },
        {
          kind: 'python',
          filename: 'python.whl',
          sha256: createHash('sha256').update('python artifact').digest('hex'),
          entries: [
            'klauro_telemetry/__init__.py',
            'klauro_telemetry-0.1.0.dist-info/METADATA',
            'klauro_telemetry-0.1.0.dist-info/WHEEL',
            'klauro_telemetry-0.1.0.dist-info/RECORD',
            'klauro_telemetry-0.1.0.dist-info/licenses/LICENSE',
          ],
        },
      ],
    };
    fs.writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
    writeTelemetrySdkReleaseReceipt(root, {
      sourceSha,
      javascriptVersion: '0.1.0',
      pythonVersion: '0.1.0',
    });

    const ready = getRuntimeSdkPackage(cas(), { releaseCandidateDir: root, releaseSourceSha: sourceSha });
    assert.equal(ready.proof.release_status, 'installable');
    assert.equal(isRuntimeSdkPackageReady(ready), true);

    const stale = getRuntimeSdkPackage(cas(), { releaseCandidateDir: root, releaseSourceSha: 'b'.repeat(40) });
    assert.equal(stale.proof.release_status, 'release_candidate');
    assert.equal(isRuntimeSdkPackageReady(stale), false);

    fs.appendFileSync(path.join(root, filename), 'corruption');
    const corrupt = getRuntimeSdkPackage(cas(), { releaseCandidateDir: root, releaseSourceSha: sourceSha });
    assert.equal(corrupt.proof.release_status, 'release_candidate');
    assert.equal(isRuntimeSdkPackageReady(corrupt), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
