import { libraryPublicApiSurface } from '../../analyzer/core/library-public-api-surface';
import type { CASNode } from '../../types/cas.types';

function node(file: string, type: string, name: string, metadata: Record<string, unknown> = {}): CASNode {
  return { id: `${file}:${name}`, name, type, level: 2, source: { file, line: 1 }, metadata } as CASNode;
}
const matches = (sourceFile: string, expected: string) => sourceFile === expected;

describe('libraryPublicApiSurface', () => {
  it.each(['python', 'rust'] as const)('visits a large cyclic %s re-export graph completely', language => {
    const count = 193;
    const extension = language === 'python' ? 'py' : 'rs';
    const nodes = Array.from({ length: count }, (_, index) => node(
      'src/module_' + index + '.' + extension, 'import',
      language === 'python' ? 'item' : 'crate::module_' + ((index + 1) % count) + '::Item',
      language === 'python'
        ? { module: '.module_' + ((index + 1) % count), isRelative: true }
        : { reexport: true, visibility: 'public' },
    ));
    const surface = libraryPublicApiSurface(nodes, 'src/module_0.' + extension, matches);
    expect(surface.files).toHaveLength(count);
    expect(surface.nodes).toEqual(nodes);
  });

  it('preserves node order and honors the path matcher when suffixes are ambiguous', () => {
    const first = node('/repo/pkg/lib/first.js', 'function', 'first');
    const root = node('/repo/pkg/index.js', 'file', 'root', { commonjs_reexports: ['./lib/first', './lib/second'] });
    const unrelated = node('/other/pkg/index.js', 'file', 'other', { commonjs_reexports: ['./unrelated'] });
    const second = node('/repo/pkg/lib/second.js', 'function', 'second');
    const nodes = [first, unrelated, root, second, node('/other/pkg/unrelated.js', 'function', 'unrelated')];
    const original = JSON.stringify(nodes);
    const surface = libraryPublicApiSurface(nodes, 'pkg/index.js', (source, expected) => source === '/repo/' + expected);
    expect(surface.files).toEqual(['pkg/index.js', 'pkg/lib/first.js', 'pkg/lib/second.js']);
    expect(surface.nodes).toEqual([first, root, second]);
    expect(surface.nodes[0]).toBe(first);
    expect(JSON.stringify(nodes)).toBe(original);
  });

  it('indexes Windows source paths while returning the original node objects', () => {
    const root = node('C:\\repo\\pkg\\index.js', 'file', 'root', { commonjs_reexports: ['./child'] });
    const child = node('C:\\repo\\pkg\\child.js', 'function', 'child');
    const surface = libraryPublicApiSurface([child, root], 'pkg/index.js',
      (source, expected) => source.replace(/\\/g, '/') === 'C:/repo/' + expected);
    expect(surface.files).toEqual(['pkg/index.js', 'pkg/child.js']);
    expect(surface.nodes).toEqual([child, root]);
  });

  it('visits every reachable file beyond a small barrel window and terminates cycles', () => {
    const count = 193;
    const nodes = Array.from({ length: count }, (_, index) => node(
      'pkg/file-' + index + '.js', 'file', 'module-' + index,
      { commonjs_reexports: ['./file-' + ((index + 1) % count), './file-' + ((index + 1) % count)] },
    ));
    const { files } = libraryPublicApiSurface(nodes, 'pkg/file-0.js', matches);
    expect(files).toHaveLength(count);
    expect(new Set(files).size).toBe(count);
    expect(files[count - 1]).toBe('pkg/file-192.js');
  });

  it('matches source paths by file rather than rescanning every node for each export', () => {
    const count = 32;
    const nodes = Array.from({ length: count }, (_, index) => [
      node('pkg/file-' + index + '.js', 'file', 'module-' + index,
        { commonjs_reexports: ['./file-' + ((index + 1) % count)] }),
      ...Array.from({ length: 32 }, (_, member) => node('pkg/file-' + index + '.js', 'function', 'member-' + member)),
    ]).flat();
    const compare = jest.fn(matches);
    const surface = libraryPublicApiSurface(nodes, 'pkg/file-0.js', compare);
    expect(surface.files).toHaveLength(count);
    expect(surface.nodes).toEqual(nodes);
    expect(compare.mock.calls.length).toBeLessThanOrEqual(count);
  });

  it('follows Python relative from-imports out of a package __init__', () => {
    const nodes = [
      node('pkg/__init__.py', 'import', 'make_app', { module: '.core', isRelative: true, fromImport: 'make_app' }),
      node('pkg/__init__.py', 'import', 'os', { module: 'os', isRelative: false }),
      node('pkg/core.py', 'function', 'make_app', { isPrivate: false }),
      node('pkg/sub/__init__.py', 'function', 'x', {}),
      node('pkg/core.py', 'import', 'helpers', { module: '.sub', isRelative: true }),
    ];
    expect(libraryPublicApiSurface(nodes, 'pkg/__init__.py', matches).files).toEqual(['pkg/__init__.py', 'pkg/core.py', 'pkg/sub/__init__.py']);
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
    expect(libraryPublicApiSurface(nodes, 'src/lib.rs', matches).files).toEqual(['src/lib.rs', 'src/routing.rs', 'src/extract/mod.rs']);
  });

  it('follows CommonJS re-exports from a default index', () => {
    const nodes = [
      node('index.js', 'file', 'index.js', { commonjs_reexports: ['./lib/thing'] }),
      node('lib/thing.js', 'file', 'thing.js', { commonjs_reexports: ['serve-static'] }),
    ];
    expect(libraryPublicApiSurface(nodes, 'index.js', matches).files).toEqual(['index.js', 'lib/thing.js']);
  });
});
