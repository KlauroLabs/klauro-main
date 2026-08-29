import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { readSdkArchiveInventory, writeTelemetrySdkReleaseReceipt } from '../../../scripts/telemetry-sdk-release-integrity.mjs';
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
  const filename = 'klauro-telemetry-0.1.0.tgz';
  const pythonFilename = 'klauro_telemetry-0.1.0-py3-none-any.whl';
  try {
    const source = path.join(root, 'source');
    const jsPackage = path.join(source, 'package');
    const wheelRoot = path.join(source, 'wheel');
    fs.mkdirSync(path.join(jsPackage, 'dist'), { recursive: true });
    const license = fs.readFileSync(path.resolve(__dirname, '../../../LICENSE'));
    fs.writeFileSync(path.join(jsPackage, 'package.json'), '{"name":"@klauro/telemetry","version":"0.1.0","license":"SEE LICENSE IN LICENSE","main":"dist/index.js"}\n');
    fs.writeFileSync(path.join(jsPackage, 'README.md'), 'sdk\n');
    fs.writeFileSync(path.join(jsPackage, 'LICENSE'), license);
    fs.writeFileSync(path.join(jsPackage, 'dist/index.js'), 'exports.init=()=>{};\n');
    const packed = execFileSync('npm', ['pack', jsPackage, '--pack-destination', root, '--silent'], { encoding: 'utf8' }).trim();
    assert.equal(path.basename(packed), filename);
    const distInfo = path.join(wheelRoot, 'klauro_telemetry-0.1.0.dist-info');
    fs.mkdirSync(path.join(distInfo, 'licenses'), { recursive: true });
    fs.mkdirSync(path.join(wheelRoot, 'klauro_telemetry'), { recursive: true });
    fs.writeFileSync(path.join(wheelRoot, 'klauro_telemetry/__init__.py'), 'def init(): pass\n');
    fs.writeFileSync(path.join(distInfo, 'METADATA'), 'Metadata-Version: 2.4\nName: klauro-telemetry\nVersion: 0.1.0\nLicense-File: LICENSE\n');
    fs.writeFileSync(path.join(distInfo, 'WHEEL'), 'Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n');
    fs.writeFileSync(path.join(distInfo, 'RECORD'), '');
    fs.writeFileSync(path.join(distInfo, 'top_level.txt'), 'klauro_telemetry\n');
    fs.writeFileSync(path.join(distInfo, 'licenses/LICENSE'), license);
    execFileSync('python3', ['-c', 'import os,sys,zipfile; root,out=sys.argv[1:]; z=zipfile.ZipFile(out,"w"); [z.write(os.path.join(d,f),os.path.relpath(os.path.join(d,f),root)) for d,_,fs in os.walk(root) for f in fs]; z.close()', wheelRoot, path.join(root, pythonFilename)]);
    const artifact = (kind: 'javascript' | 'python', artifactFilename: string) => {
      const bytes = fs.readFileSync(path.join(root, artifactFilename));
      const sha = createHash('sha256').update(bytes).digest('hex');
      const entries = readSdkArchiveInventory(kind, path.join(root, artifactFilename));
      return { kind, filename: artifactFilename, sha256: sha, inventory_sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex'), install_proof: { artifact_sha256: sha, isolated: true, command: ['install', artifactFilename], smoke_command: ['import'] } };
    };
    const manifest = {
      schema_version: 1,
      source_sha: sourceSha,
      git_clean: true,
      javascript_version: '0.1.0',
      python_version: '0.1.0',
      install_smoke: true,
      license_sha256: createHash('sha256').update(license).digest('hex'),
      local_installable: true,
      distributable: false,
      publishable: false,
      blockers: ['private_beta_license_requires_distribution_authorization'],
      artifacts: [artifact('javascript', filename), artifact('python', pythonFilename)],
    };
    fs.writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
    writeTelemetrySdkReleaseReceipt(root, {
      sourceSha,
      javascriptVersion: '0.1.0',
      pythonVersion: '0.1.0',
    });

    const ready = getRuntimeSdkPackage(cas(), { releaseCandidateDir: root, releaseSourceSha: sourceSha });
    assert.equal(ready.proof.release_status, 'release_candidate');
    assert.equal(ready.proof.installable, true);
    assert.equal((ready.proof as any).publishable, false);
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
