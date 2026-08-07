jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { CASEntryPoint, CASNode } from '../../types/cas.types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Task #115: the generic entry-point backfill (addDiscoveredEntryPoints) and
// its fallback orientation-entry path both copied `handler.file` from the
// backing node's `source.file` (or, in the fallback's case, from the raw
// pre-relativization `file` local rather than the `relativeFile` it had
// already computed a line above) — so an analyzer that records an absolute
// `source.file` leaked it straight into customer-visible `handler.file`.
// Reaches the private orchestrator methods directly, matching the pattern in
// library-public-api-entry-points.test.ts.
const orch = new AnalyzerOrchestrator() as any;

describe('discovered entry points always carry a repo-relative handler.file', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-discovered-entry-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const write = (relative: string, content: string) => {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  it('rewrites an absolute backing-node source.file to repo-relative in the manifest/common-entry-file path', () => {
    write('package.json', JSON.stringify({ name: 'acme-cli', bin: 'src/cli.ts', dependencies: {} }));
    write('src/cli.ts', '#!/usr/bin/env node\nconsole.log("hi");\n');

    // Simulate an analyzer (one of the 34) that recorded source.file as
    // absolute, same shape as `fullPath = path.join(projectPath, file)`.
    const absoluteFile = path.join(root, 'src/cli.ts');
    const nodes: CASNode[] = [
      { id: 'file_cli', name: 'cli.ts', type: 'file', source: { file: absoluteFile, line: 1 } } as CASNode,
    ];
    const entryPoints: CASEntryPoint[] = [];
    orch.addDiscoveredEntryPoints(root, nodes, entryPoints, []);

    const cliEntry = entryPoints.find((ep: CASEntryPoint) => ep.type === 'cli');
    expect(cliEntry).toBeDefined();
    expect(cliEntry!.handler!.file).toBe('src/cli.ts');
    expect(path.isAbsolute(cliEntry!.handler!.file!)).toBe(false);
  });

  it('rewrites an absolute backing-node source.file to repo-relative in the orientation fallback path', () => {
    write('README.md', '# no framework, route, or CLI detected\n');
    write('src/util.ts', 'export function noop() {}\n');

    const absoluteFile = path.join(root, 'src/util.ts');
    const nodes: CASNode[] = [
      { id: 'fn_noop', name: 'noop', type: 'function', source: { file: absoluteFile, line: 1 } } as CASNode,
    ];
    const entryPoints: CASEntryPoint[] = [];
    orch.addDiscoveredEntryPoints(root, nodes, entryPoints, []);

    const orientationEntry = entryPoints.find((ep: CASEntryPoint) => ep.id.startsWith('entry_orientation_'));
    expect(orientationEntry).toBeDefined();
    expect(orientationEntry!.handler!.file).toBe('src/util.ts');
    expect(path.isAbsolute(orientationEntry!.handler!.file!)).toBe(false);
    // metadata.file was already correct before this fix; handler.file was the
    // field that leaked — assert both stay in sync now.
    expect(orientationEntry!.metadata!.file).toBe('src/util.ts');
  });
});
