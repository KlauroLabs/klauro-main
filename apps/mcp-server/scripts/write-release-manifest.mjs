#!/usr/bin/env node
/**
 * Writes .pack/latest.json — the manifest every `klauro update` reads, and the
 * only thing that tells an installed client a newer build exists.
 *
 * Extracted from the inline `pack:tarball` one-liner because the manifest
 * actually SERVED at https://mcp.klauro.com/dist/latest.json had drifted from
 * what the pack step produced: prod carried `tarball` and `update_command`
 * fields the generator never emitted (hand-patched on the VPS at some point),
 * while `published_at` still read 2026-07-24 days after the server had moved
 * on. A hand-maintained distribution manifest is how a release channel goes
 * stale without anyone noticing, so it is generated here, in one place, from
 * the package version and HEAD.
 *
 * `git_sha` is recorded so the published artifact can be matched against the
 * deployed server build instead of being taken on trust.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
const baseUrl = (process.env.KLAURO_URL || 'https://mcp.klauro.com').replace(/\/+$/, '');

function headSha() {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: packageRoot, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: packageRoot, encoding: 'utf8' }).trim();
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return 'unknown';
  }
}

// Self-contained per-platform binaries (Node SEA — scripts/build-sea-binaries.mjs)
// are the PRIMARY install path as of this release (see install.sh); the npm
// tarball above is now the emergency fallback for a platform with no binary.
// build-sea-binaries.mjs writes dist-sea/manifest.json with each target's
// sha256; fold that into latest.json as both a nested `binaries` map (for
// JSON consumers — self-update.ts's binary self-update) and flat
// `bin_<platform>_path`/`bin_<platform>_sha256` fields (so install.sh, a
// POSIX-sh script with no JSON parser, can read them with sed). Absent
// gracefully if scripts/build-sea-binaries.mjs was not run before packaging
// — install.sh and self-update.ts both fall back to the npm tarball when no
// binary fields are present for a platform.
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

const manifest = {
  version,
  git_sha: headSha(),
  tarball: `${baseUrl}/dist/klauro-latest.tgz`,
  tarball_path: '/dist/klauro-latest.tgz',
  // min_node/max_node/supported_node_range are kept ONLY for backward
  // compatibility with CLIs older than this release that still read them —
  // no code on the current client reads max_node as a refusal boundary
  // anymore (see self-update.ts's §NODE-GATE-PHANTOM). min_node reflects
  // package.json's declared `engines`.
  min_node: 18,
  published_at: new Date().toISOString(),
  binaries,
  ...flatBinaryFields,
  // Remediation strings served to clients. `update_command` is only correct
  // for clients that HAVE the command — every release through 1.0.127 did not
  // (see self-update.ts), so the reinstall one-liner ships alongside it.
  update_command: 'klauro update',
  update_command_min_version: '1.0.128',
  install_command: `curl -fsSL ${baseUrl}/install.sh | sh`,
};

const dir = path.join(packageRoot, '.pack');
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`latest.json: version ${manifest.version} sha ${manifest.git_sha} published_at ${manifest.published_at}, ${Object.keys(binaries).length} platform binaries\n`);
