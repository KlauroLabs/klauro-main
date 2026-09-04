import * as fs from 'fs-extra';
import * as path from 'path';
import type { CASNode } from '../../types/cas.types';

export function defaultPackageIndexEntry(packageDir: string): string | undefined {
  return ['index.js', 'index.cjs', 'index.mjs', 'index.ts'].find(file => fs.existsSync(path.join(packageDir, file)));
}

export function libraryPublicApiSurfaceFiles(
nodes: CASNode[],
entryFile: string,
sourcePathMatches: (sourceFile: string, expectedRelativeFile: string) => boolean,
): string[] {
  const knownFiles = new Set(nodes
    .map(node => String(node.source?.file || '').replace(/\\/g, '/').replace(/^\.\//, ''))
    .filter(Boolean));
  const resolveSpecifier = (fromFile: string, specifier: string): string | undefined => {
    if (!specifier.startsWith('.')) return undefined;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
    const attempts = [base, ...['.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx'].map(ext => base + ext),
      ...['index.js', 'index.cjs', 'index.mjs', 'index.ts'].map(index => path.posix.join(base, index))];
    return attempts.find(candidate => knownFiles.has(candidate) || [...knownFiles].some(file => file.endsWith('/' + candidate)));
  };
  const surface: string[] = [];
  const queue = [entryFile];
  const seen = new Set<string>();
  while (queue.length > 0 && surface.length < 64) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    surface.push(file);
    const fileNode = nodes.find(node => node.type === 'file' && node.source?.file && sourcePathMatches(node.source.file, file));
    const reexports = fileNode?.metadata?.commonjs_reexports;
    if (!Array.isArray(reexports)) continue;
    for (const specifier of reexports) {
      const resolved = resolveSpecifier(file, String(specifier));
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return surface;
}
