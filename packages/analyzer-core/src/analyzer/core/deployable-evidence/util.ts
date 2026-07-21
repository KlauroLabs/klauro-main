import { globSync as importedGlobSync } from 'glob';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Defensive glob resolution: under some CJS/ESM interop configurations (seen
 * under ts-jest) the named `globSync` import is not callable even though the
 * `glob` module exports it at runtime. Mirrors orchestrator.ts's
 * safeGlobSync fallback (require('glob').globSync / .sync).
 */
export function safeGlobSync(pattern: string | string[], options: Record<string, any>): string[] {
  try {
    if (typeof importedGlobSync === 'function') return importedGlobSync(pattern as any, options as any);
  } catch {
    // fall through to require-based resolution
  }
  try {
    const globModule = require('glob');
    const sync = globModule.globSync || globModule.sync;
    return typeof sync === 'function' ? sync(pattern as any, options as any) : [];
  } catch {
    return [];
  }
}

/**
 * Deployable evidence must never be minted from the analyzed repo's own test
 * scaffolding — a fixture directory that ships a sample Dockerfile,
 * build-installer.sh, or Cargo.toml (to exercise the analyzer's *own* deploy-
 * detection providers) is not a real deployable of the host repo. This is the
 * same shape class BaseAnalyzer.getIgnorePatterns() already denylists for
 * source walking (fixtures/, __fixtures__/, testdata/, cas-tests/), plus
 * __tests__/ (jest-convention test-colocation dirs that also carry fixture
 * assets). Unlike BaseAnalyzer.getPackageDirSafeIgnorePatterns(), there is no
 * JVM-package-dir exception here: that exception exists because JVM
 * reversed-domain package paths can legitimately contain a directory segment
 * literally named "samples"/"examples"/"fixtures"/"testdata" as SOURCE code
 * (see base-analyzer.ts), but a deployable manifest (Dockerfile, Cargo.toml,
 * package.json, install script, ...) living under such a path in THIS
 * provider's glob is still evidence-collection over the analyzed repo's own
 * fixtures, not source walking — so the exclusion applies unconditionally
 * here, for every ecosystem.
 */
export const IGNORE_GLOBS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/target/**',
  '**/.klauro*/**',
  '**/vendor/**',
  'fixtures/**',
  '**/fixtures/**',
  '__fixtures__/**',
  '**/__fixtures__/**',
  '__tests__/**',
  '**/__tests__/**',
  'testdata/**',
  '**/testdata/**',
  'cas-tests/**',
  '**/cas-tests/**',
];

export function arrayOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : [];
}

export function numericPorts(values: string[]): number[] | undefined {
  const ports = values
    .map(v => Number(String(v).replace(/\/tcp$|\/udp$/i, '').trim()))
    .filter(n => Number.isFinite(n) && n > 0 && n < 65536);
  return ports.length ? [...new Set(ports)] : undefined;
}

export function formatPort(port: { host?: string; container: string }): string {
  return port.host ? `${port.host}:${port.container}` : port.container;
}

/**
 * Hash/id-shaped tokens (content hashes, uuids, random ids, base36 blobs)
 * are never legitimate identity — they're plumbing artifacts (e.g. the
 * on-disk snapshot dir name derived from an analysisId hash: see
 * remote-analyzer-service.ts + orchestrator.ts systemName derivation).
 * Mirrors orchestrator.ts's private isHashOrIdShapedToken — kept in sync
 * manually since that one isn't exported.
 */
export function isHashOrIdShapedToken(token: string): boolean {
  const normalized = (token || '').toLowerCase();
  if (normalized.length < 8) return false;
  // Canonical UUID (with or without dashes).
  if (/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/.test(normalized)) return true;
  // Long pure-hex string (>=12 hex chars) — content hash / commit sha / hex id.
  if (normalized.length >= 12 && /^[0-9a-f]+$/.test(normalized)) return true;
  // Long alphanumeric blob with no vowels and a digit somewhere: random
  // base36/base62-ish id (e.g. "8f3k29xz1q"), not an English word.
  if (normalized.length >= 10 && /^[0-9a-z]+$/.test(normalized) && /[0-9]/.test(normalized) && !/[aeiou]/.test(normalized)) {
    return true;
  }
  return false;
}

/**
 * Identifier-shaped directory basenames (hosted ids like prj_/wsp_/acct_,
 * uuid/hash-named snapshot dirs, or names containing hash-shaped path
 * segments) must NEVER enter user-facing labels. Production analyze calls
 * snapshot sources into dirs named after the project/analysis id — e.g.
 * "prj_jGNMsl_nmy8Lauen" — and a label fallback that humanizes the basename
 * turned that into the capability "Prj J GNMsl Nmy8 Lauen Operations"
 * (2026-07 cold-customer audit; the known hash-token-leak class). Checks the
 * RAW basename (before any dash/underscore-to-space humanization): known
 * hosted-id prefixes, whole-name hash shape, and per-token hash shape.
 */
export function isIdentifierShapedRepoBasename(basename: string): boolean {
  const raw = (basename || '').trim();
  if (!raw) return false;
  if (/^(prj|wsp|acct|org|usr|tok|ana)_/i.test(raw)) return true;
  if (isHashOrIdShapedToken(raw)) return true;
  return raw.split(/[_\-.]+/).some(token => isHashOrIdShapedToken(token));
}

/**
 * Deployable/service-name fallback used across evidence providers whenever a
 * manifest doesn't declare an explicit name. Historically this fell back
 * straight to `path.basename(projectPath)` — but production analyze calls
 * snapshot the source to an on-disk dir named after the analysisId HASH, so
 * that basename is frequently hash-shaped and leaks into user-facing
 * identity (deployable_evidence[].name, service_aliases, etc). Guard it:
 * reject a hash-shaped basename and fall back to a stable, honest
 * placeholder instead of fabricating or emitting the hash.
 *
 * Uses `isIdentifierShapedRepoBasename` (not the narrower
 * `isHashOrIdShapedToken` alone): a real-workspace defect (2026-07 hosted
 * reanalysis of a Rust multi-binary repo) showed a root Dockerfile's
 * deployable NAME landing as the literal storage id "prj_wbW33m-wfETn1N41".
 * That token is NOT pure-hex/UUID/no-vowel-blob shaped as a WHOLE string —
 * `isHashOrIdShapedToken` alone (which only tests the raw string as one
 * unit) missed it — but it IS a known hosted-id-prefixed, dash-segmented
 * identifier, which `isIdentifierShapedRepoBasename` catches via its
 * `prj_`/`wsp_`/... prefix check and per-token (dash/underscore-split) hash
 * check. Every caller of this function inherits the fix for free.
 */
export function safeDeployableName(basename: string): string {
  if (isIdentifierShapedRepoBasename(basename)) return 'unnamed-service';
  return basename;
}

/**
 * Project display-name resolution: prefer the ecosystem manifest's declared
 * name (package.json "name", Cargo.toml [package] name, go.mod module,
 * pyproject.toml [project]/[tool.poetry] name) over the bare directory
 * basename. Cold-customer feedback (2026-07-06): naming a project after the
 * checkout dir (e.g. a hash-named snapshot dir, or a clone folder that
 * doesn't match the package name) reads as unpolished/wrong — the manifest
 * name is the deterministic, evidence-backed ground truth when present.
 * Falls back to `fallback` (typically path.basename(projectPath)) only when
 * no manifest declares a name, or the declared name is unreadable/empty.
 * Mirrors the same regex-based TOML field extraction already used by the
 * package-manifest and python deployable-evidence providers (no toml
 * dependency) — kept in sync manually since those aren't exported for reuse.
 */
export function resolveManifestProjectName(projectPath: string, fallback: string): string {
  const packageJsonPath = path.join(projectPath, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const json = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      if (typeof json.name === 'string' && json.name.trim()) return json.name.trim();
    } catch {
      // unreadable/invalid manifest — fall through to other ecosystems
    }
  }

  const pyprojectPath = path.join(projectPath, 'pyproject.toml');
  if (fs.existsSync(pyprojectPath)) {
    try {
      const content = fs.readFileSync(pyprojectPath, 'utf8');
      const name = content.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
      if (name) return name;
    } catch {
      // unreadable manifest contributes nothing
    }
  }

  const cargoTomlPath = path.join(projectPath, 'Cargo.toml');
  if (fs.existsSync(cargoTomlPath)) {
    try {
      const content = fs.readFileSync(cargoTomlPath, 'utf8');
      const name = content.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
      if (name) return name;
    } catch {
      // unreadable manifest contributes nothing
    }
  }

  const goModPath = path.join(projectPath, 'go.mod');
  if (fs.existsSync(goModPath)) {
    try {
      const content = fs.readFileSync(goModPath, 'utf8');
      const module = content.match(/^module\s+(\S+)/m)?.[1];
      if (module) return module;
    } catch {
      // unreadable manifest contributes nothing
    }
  }

  return fallback;
}
