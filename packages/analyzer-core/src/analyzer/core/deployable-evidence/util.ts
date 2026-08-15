import { globSync as importedGlobSync } from 'glob';
import * as fs from 'fs';
import * as path from 'path';
import { SCAFFOLD_GLOBS } from '../scaffold-paths';







export function safeGlobSync(pattern: string | string[], options: Record<string, any>): string[] {
  try {
    if (typeof importedGlobSync === 'function') return importedGlobSync(pattern as any, options as any);
  } catch {

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



  ...SCAFFOLD_GLOBS,
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









export function isHashOrIdShapedToken(token: string): boolean {
  const normalized = (token || '').toLowerCase();
  if (normalized.length < 8) return false;

  if (/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/.test(normalized)) return true;

  if (normalized.length >= 12 && /^[0-9a-f]+$/.test(normalized)) return true;


  if (normalized.length >= 10 && /^[0-9a-z]+$/.test(normalized) && /[0-9]/.test(normalized) && !/[aeiou]/.test(normalized)) {
    return true;
  }
  return false;
}












export function isIdentifierShapedRepoBasename(basename: string): boolean {
  const raw = (basename || '').trim();
  if (!raw) return false;
  if (/^(prj|wsp|acct|org|usr|tok|ana)_/i.test(raw)) return true;
  if (isHashOrIdShapedToken(raw)) return true;
  return raw.split(/[_\-.]+/).some(token => isHashOrIdShapedToken(token));
}































export const UNNAMED_SERVICE_PLACEHOLDER = 'unnamed-service';

export function safeDeployableName(basename: string): string {
  if (isIdentifierShapedRepoBasename(basename)) return UNNAMED_SERVICE_PLACEHOLDER;
  return basename;
}













const GENERIC_STRUCTURAL_DIR_NAMES = new Set([
  'src', 'source', 'sources', 'scripts', 'script', 'lib', 'libs', 'app', 'apps',
  'bin', 'cmd', 'dist', 'build', 'out', 'server', 'client', 'backend', 'frontend',
  'main', 'core', 'internal', 'pkg',
]);

export function isGenericStructuralDirName(name: string): boolean {
  return GENERIC_STRUCTURAL_DIR_NAMES.has((name || '').trim().toLowerCase());
}















export function resolveManifestProjectName(projectPath: string, fallback: string): string {
  const packageJsonPath = path.join(projectPath, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const json = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      if (typeof json.name === 'string' && json.name.trim()) return json.name.trim();
    } catch {

    }
  }

  const pyprojectPath = path.join(projectPath, 'pyproject.toml');
  if (fs.existsSync(pyprojectPath)) {
    try {
      const content = fs.readFileSync(pyprojectPath, 'utf8');
      const name = content.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
      if (name) return name;
    } catch {

    }
  }

  const cargoTomlPath = path.join(projectPath, 'Cargo.toml');
  if (fs.existsSync(cargoTomlPath)) {
    try {
      const content = fs.readFileSync(cargoTomlPath, 'utf8');
      const name = content.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
      if (name) return name;
    } catch {

    }
  }

  const goModPath = path.join(projectPath, 'go.mod');
  if (fs.existsSync(goModPath)) {
    try {
      const content = fs.readFileSync(goModPath, 'utf8');
      const module = content.match(/^module\s+(\S+)/m)?.[1];
      if (module) return module;
    } catch {

    }
  }

  return fallback;
}
