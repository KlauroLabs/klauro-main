import { globSync as importedGlobSync } from 'glob';

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

export const IGNORE_GLOBS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/target/**',
  '**/.klauro*/**',
  '**/vendor/**',
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
 * Deployable/service-name fallback used across evidence providers whenever a
 * manifest doesn't declare an explicit name. Historically this fell back
 * straight to `path.basename(projectPath)` — but production analyze calls
 * snapshot the source to an on-disk dir named after the analysisId HASH, so
 * that basename is frequently hash-shaped and leaks into user-facing
 * identity (deployable_evidence[].name, service_aliases, etc). Guard it:
 * reject a hash-shaped basename and fall back to a stable, honest
 * placeholder instead of fabricating or emitting the hash.
 */
export function safeDeployableName(basename: string): string {
  if (isHashOrIdShapedToken(basename)) return 'unnamed-service';
  return basename;
}
