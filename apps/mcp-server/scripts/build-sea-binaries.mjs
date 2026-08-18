#!/usr/bin/env node





























import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const seaDir = path.join(packageRoot, 'dist-sea');
const entryBundle = path.join(seaDir, 'klauro-sea-entry.cjs');




const NODE_VERSION = process.env.KLAURO_SEA_NODE_VERSION || '22.22.0';

const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';





const TARGETS = [
  { id: 'macos-arm64', nodeDist: 'darwin-arm64', archiveExt: 'tar.gz', exeName: 'node', outExe: 'klauro-macos-arm64', macho: true, platform: 'darwin', arch: 'arm64' },
  { id: 'macos-x64', nodeDist: 'darwin-x64', archiveExt: 'tar.gz', exeName: 'node', outExe: 'klauro-macos-x64', macho: true, platform: 'darwin', arch: 'x64' },
  { id: 'linux-x64', nodeDist: 'linux-x64', archiveExt: 'tar.gz', exeName: 'node', outExe: 'klauro-linux-x64', macho: false, platform: 'linux', arch: 'x64' },
  { id: 'linux-arm64', nodeDist: 'linux-arm64', archiveExt: 'tar.gz', exeName: 'node', outExe: 'klauro-linux-arm64', macho: false, platform: 'linux', arch: 'arm64' },
  { id: 'win-x64', nodeDist: 'win-x64', archiveExt: 'zip', exeName: 'node.exe', outExe: 'klauro-win-x64.exe', macho: false, platform: 'win32', arch: 'x64' },
];

function sh(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${result.status})`);
}

function shCapture(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${result.status}): ${result.stderr}`);
  return result.stdout;
}

function downloadNode(target) {
  const dir = path.join(seaDir, `node-v${NODE_VERSION}-${target.nodeDist}`);
  if (existsSync(path.join(dir, 'bin', target.exeName)) || existsSync(path.join(dir, target.exeName))) return dir;
  mkdirSync(dir, { recursive: true });
  const archiveName = `node-v${NODE_VERSION}-${target.nodeDist}.${target.archiveExt}`;
  const archivePath = path.join(seaDir, archiveName);
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${archiveName}`;
  console.log(`[${target.id}] downloading ${url}`);
  sh('curl', ['-fsSL', '-o', archivePath, url]);
  if (target.archiveExt === 'zip') {
    sh('unzip', ['-q', '-o', archivePath, '-d', dir]);

    const nested = path.join(dir, `node-v${NODE_VERSION}-${target.nodeDist}`);
    if (existsSync(nested)) sh('bash', ['-c', `mv "${nested}"/* "${dir}"/ && rmdir "${nested}"`]);
  } else {
    sh('tar', ['-xzf', archivePath, '-C', dir, '--strip-components=1']);
  }
  return dir;
}

function nodeVersionGenerator(target, nodeDir) {





  const own = path.join(nodeDir, target.exeName === 'node.exe' ? 'node.exe' : 'bin/node');
  return own;
}

mkdirSync(seaDir, { recursive: true });
if (!existsSync(entryBundle)) {
  throw new Error(`Missing ${entryBundle} — run \`npm run build\` first (it builds dist-sea/klauro-sea-entry.cjs alongside the npm dist/ bundle).`);
}

const results = [];
const selectedTargets = TARGETS.filter(target => target.platform === process.platform && target.arch === process.arch);
if (selectedTargets.length !== 1) {
  throw new Error(`No natively verifiable SEA target for ${process.platform}/${process.arch}. The npm-distributed client remains available for this platform.`);
}
const generatorTarget = selectedTargets[0];
const generatorDir = downloadNode(generatorTarget);
const generatorNode = path.join(generatorDir, generatorTarget.exeName === 'node.exe' ? 'node.exe' : 'bin/node');

for (const target of selectedTargets) {
  console.log(`\n=== ${target.id} ===`);
  const nodeDir = downloadNode(target);
  const seaConfigPath = path.join(seaDir, `sea-config-${target.id}.json`);
  const blobPath = path.join(seaDir, `klauro-${target.id}.blob`);
  writeFileSync(seaConfigPath, JSON.stringify({
    main: path.relative(packageRoot, entryBundle),
    output: path.relative(packageRoot, blobPath),
    disableExperimentalSEAWarning: true,
  }, null, 2));
  rmSync(blobPath, { force: true });
  sh(generatorNode, ['--experimental-sea-config', path.relative(packageRoot, seaConfigPath)], { cwd: packageRoot });

  const outPath = path.join(seaDir, target.outExe);
  const srcBinary = path.join(nodeDir, target.exeName === 'node.exe' ? 'node.exe' : 'bin/node');
  copyFileSync(srcBinary, outPath);
  chmodSync(outPath, 0o755);
  if (target.macho) {
    sh('codesign', ['--remove-signature', outPath]);
  }
  const postjectCli = require.resolve('postject/dist/cli.js');
  const postjectArgs = [postjectCli, outPath, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', SENTINEL_FUSE];
  if (target.macho) postjectArgs.push('--macho-segment-name', 'NODE_SEA');
  sh(process.execPath, postjectArgs);
  if (target.macho) {
    sh('codesign', ['--sign', '-', '--force', outPath]);
  }

  const bytes = readFileSync(outPath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(`${outPath}.sha256`, `${sha256}  ${target.outExe}\n`);
  const verification = spawnSync(outPath, ['version'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: process.platform === 'win32' ? process.env.SystemRoot || '' : '/usr/bin:/bin' },
  });
  if (verification.status !== 0) {
    throw new Error(`${target.outExe} failed native verification (exit ${verification.status}): ${verification.stderr || verification.error || ''}`);
  }
  const verifiedBy = `executed natively on ${process.platform}/${process.arch} with Node and npm absent from PATH`;
  results.push({ id: target.id, file: target.outExe, bytes: bytes.length, sha256, verifiedBy });
  console.log(`[${target.id}] built ${outPath} (${(bytes.length / 1048576).toFixed(1)} MiB) sha256=${sha256}`);
}

writeFileSync(path.join(seaDir, 'manifest.json'), JSON.stringify({ node_version: NODE_VERSION, sentinel_fuse: SENTINEL_FUSE, targets: results }, null, 2));
console.log(`\nBuilt ${results.length} platform binaries in ${seaDir}. Verification status per platform:`);
for (const r of results) console.log(`  ${r.id}: ${r.verifiedBy}`);
