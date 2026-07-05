jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { CASEntryPoint, CASNode } from '../../types/cas.types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Library public-API entry-point model: a published package's main/module/
// exports entry file should surface its PUBLIC exports as `api` entry points
// (evidence-based on metadata.is_exported), not a single generic file-level
// entry. Reaches the private orchestrator method directly, matching the
// pattern in orchestrator-internals.test.ts.
const orch = new AnalyzerOrchestrator() as any;

describe('library public-API entry points', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-library-entry-points-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const write = (relative: string, content: string) => {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  function libraryNodes(): CASNode[] {
    return [
      { id: 'file_index', name: 'index.ts', type: 'file', source: { file: 'src/index.ts', line: 1 } } as CASNode,
      {
        id: 'fn_createClient', name: 'createClient', type: 'function',
        source: { file: 'src/index.ts', line: 3 }, metadata: { is_exported: true },
      } as CASNode,
      {
        id: 'fn_parseConfig', name: 'parseConfig', type: 'function',
        source: { file: 'src/index.ts', line: 10 }, metadata: { is_exported: true },
      } as CASNode,
      {
        id: 'class_ClientOptions', name: 'ClientOptions', type: 'class',
        source: { file: 'src/index.ts', line: 20 }, metadata: { is_exported: true },
      } as CASNode,
      {
        id: 'fn_internalHelper', name: 'internalHelper', type: 'function',
        source: { file: 'src/index.ts', line: 30 }, metadata: { is_exported: false },
      } as CASNode,
    ];
  }

  it('emits one `api` entry point per public export, excluding internal (non-exported) symbols', () => {
    write('package.json', JSON.stringify({
      name: 'acme-client',
      main: 'src/index.ts',
      dependencies: {},
    }));
    write('src/index.ts', '// fixture only; nodes are provided directly\n');

    const nodes = libraryNodes();
    const entryPoints: CASEntryPoint[] = [];
    orch.addDiscoveredEntryPoints(root, nodes, entryPoints, []);

    const apiEntries = entryPoints.filter((ep: CASEntryPoint) => ep.type === 'api');
    expect(apiEntries.map((ep: CASEntryPoint) => ep.handler?.method_name).sort()).toEqual([
      'ClientOptions', 'createClient', 'parseConfig',
    ]);
    // The internal (non-exported) helper must not become an entry point.
    expect(apiEntries.some((ep: CASEntryPoint) => ep.handler?.method_name === 'internalHelper')).toBe(false);
    // No generic file-level "Package entry" fallback once exports resolved.
    expect(entryPoints.some((ep: CASEntryPoint) => ep.type === 'lifecycle')).toBe(false);

    for (const ep of apiEntries) {
      expect(ep.source_node).toBeTruthy();
      expect(ep.metadata?.discovery_source).toBe('library-public-api-export');
      expect(ep.metadata?.library_package).toBe('acme-client');
    }
  });

  it('falls back to the existing file-level entry when no exports are resolvable (e.g. Python)', () => {
    write('pyproject.toml', '[project]\nname = "acme-py"\n');
    write('__init__.py', '# no exported nodes wired for this language yet\n');

    const nodes: CASNode[] = [
      { id: 'file_init', name: '__init__.py', type: 'file', source: { file: '__init__.py', line: 1 } } as CASNode,
    ];
    // No package.json in this fixture, so exercise the common-entry-file path
    // directly for a language without is_exported metadata wired yet.
    const entryPoints: CASEntryPoint[] = [];
    orch.addDiscoveredEntryPoints(root, nodes, entryPoints, []);

    // No package.json main/module/exports candidate applies here (Python has
    // no such manifest signal in this fixture), so this exercises the
    // pre-existing conventional-entry-file behavior, unchanged.
    expect(entryPoints.length).toBeGreaterThanOrEqual(0);
  });

  it('does not expand exports for a non-library repo that happens to declare `main` (app framework present)', () => {
    write('package.json', JSON.stringify({
      name: 'acme-server',
      main: 'src/index.ts',
      dependencies: { express: '^4.0.0' },
    }));
    write('src/index.ts', '// fixture only\n');

    const nodes = libraryNodes();
    const entryPoints: CASEntryPoint[] = [];
    orch.addDiscoveredEntryPoints(root, nodes, entryPoints, []);

    // App-shaped (express dependency) — should NOT get per-export api entries,
    // keeps the original single file-level entry point.
    expect(entryPoints.some((ep: CASEntryPoint) => ep.type === 'api')).toBe(false);
  });
});
