import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  assertSdkArchiveInventory,
  readSdkArchiveInventory,
  installTelemetrySdkReleaseCandidate,
  verifyTelemetrySdkReleaseReceipt,
  writeTelemetrySdkReleaseReceipt,
} from '../../../scripts/telemetry-sdk-release-integrity.mjs';

const expected = {
  sourceSha: 'a'.repeat(40),
  javascriptVersion: '1.2.3',
  pythonVersion: '1.2.3',
};

async function fixture(options: {
  brokenJavascript?: boolean;
  javascriptVersion?: string;
  pythonVersion?: string;
  releasePythonVersion?: string;
  wheelTag?: string;
  rootIsPurelib?: boolean;
  foreignPayload?: boolean;
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-telemetry-sdk-release-'));
  const source = path.join(root, 'source');
  const jsPackage = path.join(source, 'package');
  const wheelRoot = path.join(source, 'wheel');
  await fs.mkdir(path.join(jsPackage, 'dist'), { recursive: true });
  const javascriptVersion = options.javascriptVersion || '1.2.3';
  const releasePythonVersion = options.releasePythonVersion || '1.2.3';
  const normalizedPythonVersion = releasePythonVersion.replace(/-alpha\.(\d+)$/i, 'a$1')
    .replace(/-beta\.(\d+)$/i, 'b$1').replace(/-rc\.(\d+)$/i, 'rc$1');
  const pythonVersion = options.pythonVersion || normalizedPythonVersion;
  await fs.writeFile(path.join(jsPackage, 'package.json'), `${JSON.stringify({ name: '@klauro/telemetry', version: javascriptVersion, license: 'SEE LICENSE IN LICENSE', main: 'dist/index.js' })}\n`);
  await fs.writeFile(path.join(jsPackage, 'README.md'), 'sdk\n');
  const authoritativeLicense = await fs.readFile(path.resolve(__dirname, '../../../LICENSE'));
  await fs.writeFile(path.join(jsPackage, 'LICENSE'), authoritativeLicense);
  await fs.writeFile(path.join(jsPackage, 'dist/index.js'), options.brokenJavascript ? 'throw new Error(\"broken artifact\");\n' : 'exports.init=()=>{};\n');
  const jsFilename = `klauro-telemetry-${javascriptVersion}.tgz`;
  const packed = execFileSync('npm', ['pack', jsPackage, '--pack-destination', root, '--silent'], { encoding: 'utf8' }).trim();
  assert.equal(path.basename(packed), jsFilename);

  const distInfo = path.join(wheelRoot, `klauro_telemetry-${normalizedPythonVersion}.dist-info`);
  await fs.mkdir(path.join(distInfo, 'licenses'), { recursive: true });
  await fs.mkdir(path.join(wheelRoot, 'klauro_telemetry'), { recursive: true });
  await fs.writeFile(path.join(wheelRoot, 'klauro_telemetry/__init__.py'), 'def init(): pass\n');
  await fs.writeFile(path.join(distInfo, 'METADATA'), `Metadata-Version: 2.4\nName: klauro-telemetry\nVersion: ${pythonVersion}\nLicense-File: LICENSE\n`);
  await fs.writeFile(path.join(distInfo, 'WHEEL'), `Wheel-Version: 1.0\nRoot-Is-Purelib: ${options.rootIsPurelib === false ? 'false' : 'true'}\nTag: ${options.wheelTag || 'py3-none-any'}\n`);
  await fs.writeFile(path.join(distInfo, 'RECORD'), '');
  await fs.writeFile(path.join(distInfo, 'top_level.txt'), 'klauro_telemetry\n');
  await fs.writeFile(path.join(distInfo, 'licenses/LICENSE'), authoritativeLicense);
  if (options.foreignPayload) {
    await fs.mkdir(path.join(wheelRoot, 'foreign_package'), { recursive: true });
    await fs.writeFile(path.join(wheelRoot, 'foreign_package/__init__.py'), 'foreign = True\n');
  }
  const pyFilename = `klauro_telemetry-${normalizedPythonVersion}-py3-none-any.whl`;
  execFileSync('python3', ['-c', 'import os,sys,zipfile; root,out=sys.argv[1:]; z=zipfile.ZipFile(out,"w"); [z.write(os.path.join(d,f),os.path.relpath(os.path.join(d,f),root)) for d,_,fs in os.walk(root) for f in fs]; z.close()', wheelRoot, path.join(root, pyFilename)]);

  const artifact = (kind: 'javascript' | 'python', filename: string) => {
    const bytes = execFileSync('sha256sum', [path.join(root, filename)], { encoding: 'utf8' }).split(' ')[0];
    const entries = kind === 'python' && options.foreignPayload
      ? execFileSync('python3', ['-c', 'import sys,zipfile; print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', path.join(root, filename)], { encoding: 'utf8' })
        .split('\n').filter(Boolean)
      : readSdkArchiveInventory(kind, path.join(root, filename));
    return {
      kind, filename, sha256: bytes,
      inventory_sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
      install_proof: {
        artifact_sha256: bytes,
        isolated: true,
        command: kind === 'javascript' ? ['npm', 'install', filename] : ['python3', '-m', 'pip', 'install', filename],
        smoke_command: kind === 'javascript' ? ['node', '-e', 'require("@klauro/telemetry")'] : ['python3', '-c', 'import klauro_telemetry'],
      },
    };
  };
  const manifest = {
    schema_version: 1,
    source_sha: expected.sourceSha,
    git_clean: true,
    javascript_version: expected.javascriptVersion,
    python_version: releasePythonVersion,
    install_smoke: true,
    license_sha256: createHash('sha256').update(authoritativeLicense).digest('hex'),
    local_installable: true,
    distributable: false,
    publishable: false,
    blockers: ['private_beta_license_requires_distribution_authorization'],
    artifacts: [artifact('javascript', jsFilename), artifact('python', pyFilename)],
  };
  await fs.writeFile(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, manifest };
}

test('telemetry SDK proof binds clean source, versions, inventories, artifacts, and install smoke', async () => {
  const candidate = await fixture();
  try {
    candidate.manifest.artifacts[0].install_proof.command = ['untrusted-manifest-command', candidate.manifest.artifacts[0].filename];
    await fs.writeFile(path.join(candidate.root, 'manifest.json'), `${JSON.stringify(candidate.manifest, null, 2)}\n`);
    const receipt = writeTelemetrySdkReleaseReceipt(candidate.root, expected);
    assert.equal(receipt.source_sha, expected.sourceSha);
    assert.equal(receipt.artifacts[0].install_proof.command[0], 'npm');
    assert.equal(receipt.artifacts[0].install_proof.artifact_sha256, receipt.artifacts[0].sha256);
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


test('verified candidate swap restores the exact last-known-good directory on injected publication failure', async () => {
  const prior = await fixture();
  const staged = await fixture();
  try {
    writeTelemetrySdkReleaseReceipt(prior.root, expected);
    writeTelemetrySdkReleaseReceipt(staged.root, expected);
    const priorReceipt = await fs.readFile(path.join(prior.root, 'release-proof.json'));
    assert.throws(
      () => installTelemetrySdkReleaseCandidate(staged.root, prior.root, expected, { injectFailureAfterBackup: true }),
      /Injected telemetry SDK candidate swap failure/,
    );
    assert.deepEqual(await fs.readFile(path.join(prior.root, 'release-proof.json')), priorReceipt);
    assert.equal(verifyTelemetrySdkReleaseReceipt(prior.root, expected).receipt.source_sha, expected.sourceSha);
  } finally {
    await fs.rm(prior.root, { recursive: true, force: true });
    await fs.rm(staged.root, { recursive: true, force: true });
  }
});


test('receipt issuance rejects a real allowlisted archive that installs but cannot import', async () => {
  const candidate = await fixture({ brokenJavascript: true });
  try {
    assert.throws(
      () => writeTelemetrySdkReleaseReceipt(candidate.root, expected),
      /clean-install execution failed/,
    );
    await assert.rejects(fs.access(path.join(candidate.root, 'release-proof.json')));
  } finally {
    await fs.rm(candidate.root, { recursive: true, force: true });
  }
});

test('receipt verification independently rejects forged clean-install evidence for a broken artifact', async () => {
  const candidate = await fixture({ brokenJavascript: true });
  try {
    const manifestBytes = await fs.readFile(path.join(candidate.root, 'manifest.json'));
    const proof = {
      schema_version: 1,
      source_sha: expected.sourceSha,
      javascript_version: expected.javascriptVersion,
      python_version: expected.pythonVersion,
      manifest_sha256: createHash('sha256').update(manifestBytes).digest('hex'),
      artifacts: candidate.manifest.artifacts.map((artifact: any) => ({
        kind: artifact.kind,
        filename: artifact.filename,
        sha256: artifact.sha256,
        inventory_sha256: artifact.inventory_sha256,
        install_proof: artifact.install_proof,
      })),
      passed_gates: ['sdk-build', 'archive-allowlist', 'clean-install-smoke'],
    };
    await fs.writeFile(path.join(candidate.root, 'release-proof.json'), `${JSON.stringify({
      ...proof,
      proof_sha256: createHash('sha256').update(JSON.stringify(proof)).digest('hex'),
    }, null, 2)}\n`);
    assert.throws(() => verifyTelemetrySdkReleaseReceipt(candidate.root, expected), /clean-install execution failed/);
  } finally {
    await fs.rm(candidate.root, { recursive: true, force: true });
  }
});

test('real archive package metadata must match the manifest versions exactly', async () => {
  for (const options of [{ javascriptVersion: '9.9.9' }, { pythonVersion: '9.9.9' }]) {
    const candidate = await fixture(options);
    if (options.javascriptVersion) {
      const artifact = candidate.manifest.artifacts.find((item: any) => item.kind === 'javascript')!;
      const canonicalFilename = 'klauro-telemetry-1.2.3.tgz';
      await fs.rename(path.join(candidate.root, artifact.filename), path.join(candidate.root, canonicalFilename));
      artifact.filename = canonicalFilename;
      artifact.install_proof.command = ['npm', 'install', canonicalFilename];
      await fs.writeFile(path.join(candidate.root, 'manifest.json'), `${JSON.stringify(candidate.manifest, null, 2)}\n`);
    }
    try {
      assert.throws(() => writeTelemetrySdkReleaseReceipt(candidate.root, expected), /package identity does not match/);
    } finally {
      await fs.rm(candidate.root, { recursive: true, force: true });
    }
  }
});

test('real archives retain canonical package names, versions, and supported wheel tags', async () => {
  const cases = [
    { kind: 'javascript', filename: 'renamed-telemetry-1.2.3.tgz' },
    { kind: 'python', filename: 'renamed_telemetry-1.2.3-py3-none-any.whl' },
    { kind: 'python', filename: 'foreign_telemetry-1.2.3-py3-none-any.whl' },
    { kind: 'python', filename: 'klauro_telemetry-1.2.3-cp311-cp311-manylinux_2_17_x86_64.whl' },
  ] as const;
  for (const selected of cases) {
    const candidate = await fixture();
    try {
      const artifact = candidate.manifest.artifacts.find((item: any) => item.kind === selected.kind)!;
      await fs.rename(path.join(candidate.root, artifact.filename), path.join(candidate.root, selected.filename));
      artifact.filename = selected.filename;
      artifact.install_proof.command = selected.kind === 'javascript'
        ? ['npm', 'install', selected.filename]
        : ['python3', '-m', 'pip', 'install', selected.filename];
      await fs.writeFile(path.join(candidate.root, 'manifest.json'), `${JSON.stringify(candidate.manifest, null, 2)}\n`);
      assert.throws(
        () => writeTelemetrySdkReleaseReceipt(candidate.root, expected),
        /filename does not match the canonical package identity, version, and supported tags/,
      );
    } finally {
      await fs.rm(candidate.root, { recursive: true, force: true });
    }
  }
});

test('wheel metadata and payload must agree with the canonical pure universal filename', async () => {
  for (const options of [
    { wheelTag: 'cp311-cp311-manylinux_2_17_x86_64' },
    { rootIsPurelib: false },
    { foreignPayload: true },
  ]) {
    const candidate = await fixture(options);
    try {
      assert.throws(
        () => writeTelemetrySdkReleaseReceipt(candidate.root, expected),
        /WHEEL metadata does not match|payload outside the canonical pure-Python package roots|archive contains disallowed entries/,
      );
    } finally {
      await fs.rm(candidate.root, { recursive: true, force: true });
    }
  }
});

test('PEP 440-normalized prerelease wheel identity matches its semantic release version', async () => {
  const candidate = await fixture({ releasePythonVersion: '1.2.3-beta.1' });
  try {
    const prereleaseExpected = { ...expected, pythonVersion: '1.2.3-beta.1' };
    const receipt = writeTelemetrySdkReleaseReceipt(candidate.root, prereleaseExpected);
    assert.equal(receipt.python_version, '1.2.3-beta.1');
    assert.equal(receipt.artifacts.find((artifact: any) => artifact.kind === 'python')?.filename,
      'klauro_telemetry-1.2.3b1-py3-none-any.whl');
    assert.equal(verifyTelemetrySdkReleaseReceipt(candidate.root, prereleaseExpected).receipt.proof_sha256,
      receipt.proof_sha256);
  } finally {
    await fs.rm(candidate.root, { recursive: true, force: true });
  }
});

test('first publication syncs the destination parent before candidate publication', async () => {
  const staged = await fixture();
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-telemetry-sdk-first-publication-'));
  const destination = path.join(parent, 'candidate');
  try {
    writeTelemetrySdkReleaseReceipt(staged.root, expected);
    assert.throws(
      () => installTelemetrySdkReleaseCandidate(staged.root, destination, expected, { injectFailureAfterDestinationParentSync: true }),
      /destination parent sync/,
    );
    assert.equal((await fs.stat(destination)).isDirectory(), true);
    await assert.rejects(fs.access(path.join(destination, 'current')));
    assert.equal((await fs.stat(staged.root)).isDirectory(), true);
    installTelemetrySdkReleaseCandidate(staged.root, destination, expected);
    assert.equal(verifyTelemetrySdkReleaseReceipt(destination, expected).receipt.source_sha, expected.sourceSha);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
    await fs.rm(staged.root, { recursive: true, force: true });
  }
});

test('a killed publisher leaves the prior candidate readable and a later publisher recovers the dead lock', async () => {
  const prior = await fixture();
  const staged = await fixture();
  try {
    writeTelemetrySdkReleaseReceipt(prior.root, expected);
    writeTelemetrySdkReleaseReceipt(staged.root, expected);
    const priorReceipt = await fs.readFile(path.join(prior.root, 'release-proof.json'));
    const modulePath = path.resolve(__dirname, '../../../scripts/telemetry-sdk-release-integrity.mjs');
    const script = `import { installTelemetrySdkReleaseCandidate as install } from ${JSON.stringify(`file://${modulePath}`)}; install(process.argv[1], process.argv[2], ${JSON.stringify(expected)}, { injectCrashBeforePublish: true });`;
    const killed = spawnSync(process.execPath, ['--input-type=module', '-e', script, staged.root, prior.root], { encoding: 'utf8' });
    assert.equal(killed.signal, 'SIGKILL');
    assert.deepEqual(await fs.readFile(path.join(prior.root, 'release-proof.json')), priorReceipt);
    assert.equal(verifyTelemetrySdkReleaseReceipt(prior.root, expected).receipt.source_sha, expected.sourceSha);

    const recovery = await fixture();
    writeTelemetrySdkReleaseReceipt(recovery.root, expected);
    installTelemetrySdkReleaseCandidate(recovery.root, prior.root, expected);
    assert.equal(verifyTelemetrySdkReleaseReceipt(prior.root, expected).receipt.source_sha, expected.sourceSha);
  } finally {
    await fs.rm(prior.root, { recursive: true, force: true });
    await fs.rm(staged.root, { recursive: true, force: true });
  }
});

test('concurrent publishers serialize and leave one complete verified current candidate', async () => {
  const destination = await fixture();
  const first = await fixture();
  const second = await fixture();
  try {
    for (const candidate of [destination, first, second]) writeTelemetrySdkReleaseReceipt(candidate.root, expected);
    const modulePath = path.resolve(__dirname, '../../../scripts/telemetry-sdk-release-integrity.mjs');
    const script = `import { installTelemetrySdkReleaseCandidate as install } from ${JSON.stringify(`file://${modulePath}`)}; install(process.argv[1], process.argv[2], ${JSON.stringify(expected)});`;
    const run = (staged: string) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, staged, destination.root], { stdio: 'pipe' });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(`publisher exited ${code}: ${stderr}`)));
    });
    await Promise.all([run(first.root), run(second.root)]);
    assert.equal(verifyTelemetrySdkReleaseReceipt(destination.root, expected).receipt.source_sha, expected.sourceSha);
    assert.equal((await fs.lstat(path.join(destination.root, 'current'))).isSymbolicLink(), true);
  } finally {
    const destinationParent = path.dirname(destination.root);
    const destinationName = path.basename(destination.root);
    for (const entry of await fs.readdir(destinationParent)) {
      if (entry.startsWith(`${destinationName}.publish.lock`)) {
        await fs.rm(path.join(destinationParent, entry), { recursive: true, force: true });
      }
    }
    await fs.rm(destination.root, { recursive: true, force: true });
    await fs.rm(first.root, { recursive: true, force: true });
    await fs.rm(second.root, { recursive: true, force: true });
  }
});

test('simultaneous stale-lock recovery cannot evict the first successor owner', async () => {
  const destination = await fixture();
  const crashed = await fixture();
  const first = await fixture();
  const second = await fixture();
  const barrier = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-telemetry-sdk-recovery-barrier-'));
  try {
    for (const candidate of [destination, crashed, first, second]) writeTelemetrySdkReleaseReceipt(candidate.root, expected);
    const modulePath = path.resolve(__dirname, '../../../scripts/telemetry-sdk-release-integrity.mjs');
    const crashScript = `import { installTelemetrySdkReleaseCandidate as install } from ${JSON.stringify(`file://${modulePath}`)}; install(process.argv[1], process.argv[2], ${JSON.stringify(expected)}, { injectCrashBeforePublish: true });`;
    const killed = spawnSync(process.execPath, ['--input-type=module', '-e', crashScript, crashed.root, destination.root], { encoding: 'utf8' });
    assert.equal(killed.signal, 'SIGKILL');

    const recoveryScript = `import fs from 'node:fs'; import path from 'node:path'; import { installTelemetrySdkReleaseCandidate as install } from ${JSON.stringify(`file://${modulePath}`)}; const barrier=process.argv[3]; install(process.argv[1], process.argv[2], ${JSON.stringify(expected)}, { beforeStaleRecovery: () => { fs.writeFileSync(path.join(barrier, String(process.pid)), 'ready'); while (fs.readdirSync(barrier).length < 2) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); } });`;
    const run = (staged: string) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', recoveryScript, staged, destination.root, barrier], { stdio: 'pipe' });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(`recovering publisher exited ${code}: ${stderr}`)));
    });
    await Promise.all([run(first.root), run(second.root)]);
    assert.equal(verifyTelemetrySdkReleaseReceipt(destination.root, expected).receipt.source_sha, expected.sourceSha);
    const tombstones = (await fs.readdir(path.dirname(`${destination.root}.publish.lock`)))
      .filter(entry => entry.startsWith(`${path.basename(destination.root)}.publish.lock.stale-`));
    assert.equal(tombstones.length, 1);
  } finally {
    const destinationParent = path.dirname(destination.root);
    const destinationName = path.basename(destination.root);
    for (const entry of await fs.readdir(destinationParent)) {
      if (entry.startsWith(`${destinationName}.publish.lock`)) {
        await fs.rm(path.join(destinationParent, entry), { recursive: true, force: true });
      }
    }
    await fs.rm(destination.root, { recursive: true, force: true });
    await fs.rm(crashed.root, { recursive: true, force: true });
    await fs.rm(first.root, { recursive: true, force: true });
    await fs.rm(second.root, { recursive: true, force: true });
    await fs.rm(barrier, { recursive: true, force: true });
  }
});
