#!/usr/bin/env node
















import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import buildSourceIdentity from './build-source-identity.cjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
const baseUrl = (process.env.KLAURO_URL || 'https://mcp.klauro.com').replace(/\/+$/, '');












const seaManifestPath = path.join(packageRoot, 'dist-sea', 'manifest.json');
const binaries = {};
const flatBinaryFields = {};
if (existsSync(seaManifestPath)) {
  const seaManifest = JSON.parse(readFileSync(seaManifestPath, 'utf8'));
  for (const target of seaManifest.targets || []) {
    binaries[target.id] = { path: `/dist/${target.file}`, sha256: target.sha256 };
    const key = target.id.replace(/-/g, '_');
    flatBinaryFields[`bin_${key}_path`] = `/dist/${target.file}`;
    flatBinaryFields[`bin_${key}_sha256`] = target.sha256;
  }
}










const customerPackageJsonPath = path.join(packageRoot, '.customer-package', 'package.json');
if (!existsSync(customerPackageJsonPath)) {
  throw new Error(`write-release-manifest.mjs: ${customerPackageJsonPath} is missing — run "npm run build" first so the customer package.json (with its engines.node) exists to read from.`);
}
const customerPackageJson = JSON.parse(readFileSync(customerPackageJsonPath, 'utf8'));
const customerEngineRange = customerPackageJson.engines && customerPackageJson.engines.node;
const minNodeMatch = /(\d+)/.exec(String(customerEngineRange || ''));
if (!minNodeMatch) {
  throw new Error(`write-release-manifest.mjs: could not parse a Node minimum out of customer package.json engines.node (${JSON.stringify(customerEngineRange)}).`);
}
const minNode = Number(minNodeMatch[1]);

const manifest = {
  version,
  git_sha: buildSourceIdentity.resolveBuildGitSha(packageRoot),
  tarball: `${baseUrl}/dist/klauro-latest.tgz`,
  tarball_path: '/dist/klauro-latest.tgz',







  min_node: minNode,
  published_at: buildSourceIdentity.resolveBuildTime(),
  binaries,
  ...flatBinaryFields,



  update_command: 'klauro update',
  update_command_min_version: '1.0.128',
  install_command: `curl -fsSL ${baseUrl}/install.sh | sh`,
};

const dir = path.join(packageRoot, '.pack');
mkdirSync(dir, { recursive: true });
const versionedTarballPath = path.join(dir, `klauro-mcp-server-${version}.tgz`);
if (!existsSync(versionedTarballPath)) {
  throw new Error(`write-release-manifest.mjs: ${versionedTarballPath} is missing — run "npm pack" first.`);
}
const tarball = readFileSync(versionedTarballPath);
manifest.tarball_sha256 = createHash('sha256').update(tarball).digest('hex');
writeAtomically(path.join(dir, 'klauro-latest.tgz'), tarball);
writeAtomically(path.join(dir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`latest.json: version ${manifest.version} sha ${manifest.git_sha} published_at ${manifest.published_at}, ${Object.keys(binaries).length} platform binaries\n`);

function writeAtomically(destination, contents) {
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, contents);
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}
