import * as fs from 'fs';
import * as path from 'path';

/**
 * Source roots a project DECLARES it ships, read from its manifest. Used to
 * separate the product from everything else that shares its folder — examples,
 * documentation source, benchmarks, scaffolding — so product-level derivation
 * (entry points, entities, system type, domain) is not driven by code the
 * project does not publish.
 *
 * Evidence-first: a root is recorded only on a positive declaration. With no
 * declaration the result is empty and callers apply no restriction. Never a
 * directory-name list — a repo whose product IS its examples must not lose them.
 */
export interface DeclaredProductRoots {
  /** Relative, forward-slash, no trailing slash. Files or directories. */
  roots: string[];
  /** Which manifest produced them, for provenance. */
  source?: 'package.json' | 'pyproject.toml' | 'Cargo.toml' | 'composer.json';
}

const EMPTY: DeclaredProductRoots = { roots: [] };

export function declaredProductRoots(projectPath: string): DeclaredProductRoots {
  return (
    fromPackageJson(projectPath) ||
    fromPyproject(projectPath) ||
    fromCargo(projectPath) ||
    fromComposer(projectPath) ||
    EMPTY
  );
}

/** True when `relativePath` lies inside (or is) one of the declared roots. */
export function isWithinDeclaredRoots(relativePath: string, roots: string[]): boolean {
  const normalized = normalize(relativePath);
  return roots.some(root => normalized === root || normalized.startsWith(`${root}/`));
}

function normalize(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function fromPackageJson(projectPath: string): DeclaredProductRoots | undefined {
  const raw = readText(path.join(projectPath, 'package.json'));
  if (!raw) return undefined;
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const roots = new Set<string>();
  // `files` is the publish allow-list — the strongest ship declaration npm has.
  if (Array.isArray(manifest.files)) {
    for (const entry of manifest.files) {
      if (typeof entry !== 'string') continue;
      const cleaned = normalize(entry).replace(/\/\*\*?$/, '');
      // Negations and globs are not roots.
      if (!cleaned || cleaned.startsWith('!') || /[*?{}]/.test(cleaned)) continue;
      roots.add(cleaned);
    }
  }
  // Entry files always ship, and so does the directory holding them.
  for (const key of ['main', 'module', 'browser']) {
    const value = manifest[key];
    if (typeof value === 'string' && value.trim()) roots.add(normalize(value));
  }
  const bin = manifest.bin;
  if (typeof bin === 'string') roots.add(normalize(bin));
  else if (bin && typeof bin === 'object') {
    for (const value of Object.values(bin as Record<string, unknown>)) {
      if (typeof value === 'string') roots.add(normalize(value));
    }
  }
  if (roots.size === 0) return undefined;
  return { roots: [...roots].sort(), source: 'package.json' };
}

function fromPyproject(projectPath: string): DeclaredProductRoots | undefined {
  const raw = readText(path.join(projectPath, 'pyproject.toml'));
  if (!raw) return undefined;
  const roots = new Set<string>();
  // Explicit declarations, any build backend: packages = ["pkg"], package-dir,
  // hatch `packages`/`only-include`, pdm `includes`.
  for (const match of raw.matchAll(/^\s*(?:packages|only-include|includes)\s*=\s*\[([^\]]*)\]/gm)) {
    for (const item of match[1].matchAll(/["']([^"']+)["']/g)) roots.add(normalize(item[1]));
  }
  for (const match of raw.matchAll(/^\s*package-dir\s*=\s*\{([^}]*)\}/gm)) {
    for (const item of match[1].matchAll(/=\s*["']([^"']+)["']/g)) roots.add(normalize(item[1]));
  }
  if (roots.size === 0) {
    // Default layout: the importable package named by the project, at the root or
    // under src/. Recorded only if the directory actually exists.
    const name = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(raw)?.[1];
    if (name) {
      const packageName = name.toLowerCase().replace(/-/g, '_');
      for (const candidate of [packageName, `src/${packageName}`]) {
        if (isDirectory(path.join(projectPath, candidate))) roots.add(candidate);
      }
    }
  }
  if (roots.size === 0) return undefined;
  return { roots: [...roots].sort(), source: 'pyproject.toml' };
}

function fromCargo(projectPath: string): DeclaredProductRoots | undefined {
  const raw = readText(path.join(projectPath, 'Cargo.toml'));
  if (!raw) return undefined;
  // A workspace-only manifest declares nothing to ship at this level.
  if (/^\s*\[workspace\]/m.test(raw) && !/^\s*\[package\]/m.test(raw)) return undefined;
  const roots = new Set<string>();
  for (const match of raw.matchAll(/^\s*path\s*=\s*["']([^"']+)["']/gm)) roots.add(normalize(match[1]));
  if (isDirectory(path.join(projectPath, 'src'))) roots.add('src');
  if (roots.size === 0) return undefined;
  return { roots: [...roots].sort(), source: 'Cargo.toml' };
}

function fromComposer(projectPath: string): DeclaredProductRoots | undefined {
  const raw = readText(path.join(projectPath, 'composer.json'));
  if (!raw) return undefined;
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return undefined;
  }
  // An application skeleton (`type: project`) ships routes, config, views and
  // more that autoload never names, so its autoload map is NOT a product
  // boundary. Only a library's autoload is.
  if (manifest.type !== 'library') return undefined;
  const autoload = manifest.autoload as Record<string, unknown> | undefined;
  const roots = new Set<string>();
  for (const key of ['psr-4', 'psr-0']) {
    const map = autoload?.[key];
    if (!map || typeof map !== 'object') continue;
    for (const value of Object.values(map as Record<string, unknown>)) {
      const entries = Array.isArray(value) ? value : [value];
      for (const entry of entries) if (typeof entry === 'string') roots.add(normalize(entry));
    }
  }
  if (roots.size === 0) return undefined;
  return { roots: [...roots].sort(), source: 'composer.json' };
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}
