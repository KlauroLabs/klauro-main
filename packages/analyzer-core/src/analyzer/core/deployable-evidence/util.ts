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
