import * as path from 'node:path';

const CACHE_LIMIT = 250_000;
const cache = new Map<string, string>();

export function projectRelativeFile(projectPath: string, file: string): string {
  const key = `${projectPath}|${file}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const normalized = file.replace(/\\/g, '/');
  let value: string;
  if (path.isAbsolute(file)) {
    const relative = path.relative(projectPath, file).replace(/\\/g, '/');
    value = relative && !relative.startsWith('..') ? relative : normalized;
  } else {
    value = normalized.replace(/^\.\//, '');
  }
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, value);
  return value;
}

export function pathsReferToSameFile(projectPath: string, left?: string, right?: string): boolean {
  if (!left || !right) return false;
  const a = projectRelativeFile(projectPath, left);
  const b = projectRelativeFile(projectPath, right);
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

export function resetProjectRelativePathCache(): void {
  cache.clear();
}
