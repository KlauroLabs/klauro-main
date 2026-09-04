import * as fs from 'fs-extra';
import * as path from 'path';
import type { CASEntryPoint, CASNode } from '../../types/cas.types';
import { declaredProductRoots } from './product-roots';

export interface LibraryEntryCandidate {
  file: string;
  type: CASEntryPoint['type'];
  name: string;
  description: string;
  trigger?: CASEntryPoint['trigger'];
  libraryPublicApi?: { packageName: string; field: string };
}

export function defaultPackageIndexEntry(packageDir: string): string | undefined {
  return ['index.js', 'index.cjs', 'index.mjs', 'index.ts'].find(file => fs.existsSync(path.join(packageDir, file)));
}

export function libraryManifestEntries(projectPath: string): LibraryEntryCandidate[] {
  const entries: LibraryEntryCandidate[] = [];
  const cargoFile = path.join(projectPath, 'Cargo.toml');
  if (fs.existsSync(cargoFile)) {
    const cargo = fs.readFileSync(cargoFile, 'utf8');
    const name = /^\s*\[package\][\s\S]*?^\s*name\s*=\s*"([^"]+)"/m.exec(cargo)?.[1] || path.basename(projectPath);
    const libPath = /^\s*\[lib\][\s\S]*?^\s*path\s*=\s*"([^"]+)"/m.exec(cargo)?.[1] || 'src/lib.rs';
    const hasBin = /^\s*\[\[bin\]\]/m.test(cargo) || fs.existsSync(path.join(projectPath, 'src/main.rs'));
    if (!hasBin && fs.existsSync(path.join(projectPath, libPath))) {
      entries.push({
        file: libPath, type: 'lifecycle', name: `${name} lib`,
        description: 'Cargo library target declared by the crate manifest.',
        trigger: { pattern: 'lib' }, libraryPublicApi: { packageName: name, field: 'lib' },
      });
    }
  }
  const roots = declaredProductRoots(projectPath);
  if (roots.source === 'pyproject.toml') {
    for (const root of roots.roots) {
      const init = path.posix.join(root, '__init__.py');
      if (!fs.existsSync(path.join(projectPath, init))) continue;
      const packageName = path.posix.basename(root);
      entries.push({
        file: init, type: 'lifecycle', name: `${packageName} package`,
        description: 'Python package declared by the project manifest.',
        trigger: { pattern: 'package' }, libraryPublicApi: { packageName, field: 'package' },
      });
    }
  }
  return entries;
}

export function libraryApiResourceKey(entryPoint: CASEntryPoint): string {
  const file = String(entryPoint.handler?.file || '').replace(/\\/g, '/');
  const stem = path.posix.basename(file).replace(/\.[^.]+$/, '');
  const module = stem === 'index' || stem === '__init__' || stem === 'mod' || stem === 'lib'
    ? path.posix.basename(path.posix.dirname(file)) || stem
    : stem;
  const packageName = String(entryPoint.name || '').split('.')[0] || 'library';
  return `${packageName}-${module}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function languageOf(file: string): 'python' | 'rust' | 'javascript' {
  if (/\.py$/i.test(file)) return 'python';
  if (/\.rs$/i.test(file)) return 'rust';
  return 'javascript';
}

function reexportSpecifiers(fileNodes: CASNode[], language: ReturnType<typeof languageOf>): string[] {
  const specs: string[] = [];
  for (const node of fileNodes) {
    const metadata = (node.metadata || {}) as Record<string, unknown>;
    if (language === 'javascript' && Array.isArray(metadata.commonjs_reexports)) specs.push(...metadata.commonjs_reexports.map(String));
    if (language === 'python' && node.type === 'import' && metadata.isRelative && typeof metadata.module === 'string') specs.push(metadata.module);
    if (language === 'rust' && node.type === 'import' && metadata.reexport === true) {
      const head = String(node.name || '').replace(/^(?:crate|self|super)::/, '').split('::')[0];
      if (head && !head.startsWith('{')) specs.push(head);
    }
    if (language === 'rust' && node.type === 'module' && metadata.visibility === 'public') specs.push(String(node.name || ''));
  }
  return specs;
}

function candidatePaths(fromFile: string, specifier: string, language: ReturnType<typeof languageOf>): string[] {
  const dir = path.posix.dirname(fromFile);
  if (language === 'python') {
    const dots = specifier.match(/^\.+/)?.[0].length || 0;
    if (dots === 0) return [];
    let base = dir;
    for (let level = 1; level < dots; level += 1) base = path.posix.dirname(base);
    const rest = specifier.slice(dots).split('.').filter(Boolean).join('/');
    const target = rest ? path.posix.join(base, rest) : base;
    return rest ? [target + '.py', path.posix.join(target, '__init__.py')] : [path.posix.join(target, '__init__.py')];
  }
  if (language === 'rust') {
    const target = path.posix.join(dir, specifier);
    return [target + '.rs', path.posix.join(target, 'mod.rs')];
  }
  if (!specifier.startsWith('.')) return [];
  const base = path.posix.normalize(path.posix.join(dir, specifier));
  return [base, ...['.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx'].map(ext => base + ext),
    ...['index.js', 'index.cjs', 'index.mjs', 'index.ts'].map(index => path.posix.join(base, index))];
}

export function libraryPublicApiSurfaceFiles(
  nodes: CASNode[],
  entryFile: string,
  sourcePathMatches: (sourceFile: string, expectedRelativeFile: string) => boolean,
): string[] {
  const knownFiles = new Set(nodes
    .map(node => String(node.source?.file || '').replace(/\\/g, '/').replace(/^\.\//, ''))
    .filter(Boolean));
  const resolve = (candidates: string[]): string | undefined =>
    candidates.find(candidate => knownFiles.has(candidate) || [...knownFiles].some(file => file.endsWith('/' + candidate)));
  const surface: string[] = [];
  const queue = [entryFile];
  const seen = new Set<string>();
  while (queue.length > 0 && surface.length < 64) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    surface.push(file);
    const language = languageOf(file);
    const fileNodes = nodes.filter(node => node.source?.file && sourcePathMatches(node.source.file, file));
    for (const specifier of reexportSpecifiers(fileNodes, language)) {
      const resolved = resolve(candidatePaths(file, specifier, language));
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return surface;
}
