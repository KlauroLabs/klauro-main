import { libraryPublicApiSurfaceFiles } from '../../analyzer/core/library-public-api-surface';
import type { CASNode } from '../../types/cas.types';

function node(file: string, type: string, name: string, metadata: Record<string, unknown> = {}): CASNode {
  return { id: `${file}:${name}`, name, type, level: 2, source: { file, line: 1 }, metadata } as CASNode;
}
const matches = (sourceFile: string, expected: string) => sourceFile === expected;

describe('libraryPublicApiSurfaceFiles', () => {
  it('follows Python relative from-imports out of a package __init__', () => {
    const nodes = [
      node('pkg/__init__.py', 'import', 'make_app', { module: '.core', isRelative: true, fromImport: 'make_app' }),
      node('pkg/__init__.py', 'import', 'os', { module: 'os', isRelative: false }),
      node('pkg/core.py', 'function', 'make_app', { isPrivate: false }),
      node('pkg/sub/__init__.py', 'function', 'x', {}),
      node('pkg/core.py', 'import', 'helpers', { module: '.sub', isRelative: true }),
    ];
    expect(libraryPublicApiSurfaceFiles(nodes, 'pkg/__init__.py', matches)).toEqual(['pkg/__init__.py', 'pkg/core.py', 'pkg/sub/__init__.py']);
  });

  it('follows Rust pub use and pub mod out of lib.rs', () => {
    const nodes = [
      node('src/lib.rs', 'import', 'routing::Router', { reexport: true, visibility: 'public' }),
      node('src/lib.rs', 'import', 'std::fmt', { reexport: false }),
      node('src/lib.rs', 'module', 'extract', { visibility: 'public' }),
      node('src/lib.rs', 'module', 'internal', { visibility: 'private' }),
      node('src/routing.rs', 'function', 'route', { visibility: 'public' }),
      node('src/extract/mod.rs', 'function', 'extract', { visibility: 'public' }),
      node('src/internal.rs', 'function', 'hidden', { visibility: 'private' }),
    ];
    expect(libraryPublicApiSurfaceFiles(nodes, 'src/lib.rs', matches)).toEqual(['src/lib.rs', 'src/routing.rs', 'src/extract/mod.rs']);
  });

  it('follows CommonJS re-exports from a default index', () => {
    const nodes = [
      node('index.js', 'file', 'index.js', { commonjs_reexports: ['./lib/thing'] }),
      node('lib/thing.js', 'file', 'thing.js', { commonjs_reexports: ['serve-static'] }),
    ];
    expect(libraryPublicApiSurfaceFiles(nodes, 'index.js', matches)).toEqual(['index.js', 'lib/thing.js']);
  });
});
