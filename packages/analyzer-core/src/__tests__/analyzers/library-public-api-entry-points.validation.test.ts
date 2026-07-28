jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { TypeScriptJavaScriptAnalyzer } from '../../analyzer/languages/typescript-javascript-analyzer';
import { CASEntryPoint } from '../../types/cas.types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// End-to-end check of the library public-API entry-point path: runs the REAL
// TypeScript analyzer (real tree parsing, real is_exported tagging) against a
// small library fixture, then feeds those real nodes through
// addDiscoveredEntryPoints — proving the whole path, not just hand-built node
// fixtures.
//
// The fixture is written here at run time. It previously lived at a hardcoded
// scratchpad path belonging to one agent session, with `describe.skip` when
// that path was absent — so it ran on no machine at all, and silently masked
// the exported-variable defect asserted below.
describe('validation: real TS analyzer + library entry-point expansion', () => {
  let fixtureDir: string;

  beforeAll(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'library-public-api-'));
    fs.writeFileSync(
      path.join(fixtureDir, 'package.json'),
      JSON.stringify({ name: 'fixture-lib', version: '1.0.0', main: 'index.ts' }, null, 2)
    );
    fs.writeFileSync(
      path.join(fixtureDir, 'index.ts'),
      [
        'export const PI_APPROX = 3.14;',
        '',
        'function internalRound(value: number): number {',
        '  return Math.round(value * 100) / 100;',
        '}',
        '',
        'export function add(left: number, right: number): number {',
        '  return internalRound(left + right);',
        '}',
        '',
        'export function subtract(left: number, right: number): number {',
        '  return internalRound(left - right);',
        '}',
        '',
        'export class Calculator {',
        '  total = 0;',
        '  addTo(value: number): number {',
        '    this.total = add(this.total, value);',
        '    return this.total;',
        '  }',
        '}',
        ''
      ].join('\n')
    );
  });

  afterAll(() => {
    if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('surfaces public exports as api entry points, excludes the internal helper', async () => {
    const analyzer = new TypeScriptJavaScriptAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: fixtureDir });
    const nodes = contribution.nodes || [];

    const orch = new AnalyzerOrchestrator() as any;
    const entryPoints: CASEntryPoint[] = [];
    orch.addDiscoveredEntryPoints(fixtureDir, nodes, entryPoints, contribution.edges || []);

    const apiEntries = entryPoints.filter(ep => ep.type === 'api');
    const exported = apiEntries.map(ep => ep.handler?.method_name).sort();

    // Exported function, class AND const all belong to the public surface.
    // PI_APPROX used to go missing because the tree-sitter variable path
    // stamped camelCase `isExported` instead of the `is_exported` contract
    // field that buildLibraryPublicApiEntryPoints reads.
    expect(exported).toEqual(['Calculator', 'PI_APPROX', 'add', 'subtract']);
    expect(apiEntries.some(ep => ep.handler?.method_name === 'internalRound')).toBe(false);
    expect(entryPoints.some(ep => ep.type === 'lifecycle')).toBe(false);
  }, 30000);

  it('tags exported variables with the is_exported CAS contract field', async () => {
    const analyzer = new TypeScriptJavaScriptAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: fixtureDir });
    const piNode = (contribution.nodes || []).find(node => node.name === 'PI_APPROX');

    expect(piNode).toBeDefined();
    expect(piNode?.metadata?.is_exported).toBe(true);
    expect(piNode?.metadata).not.toHaveProperty('isExported');
  }, 30000);
});
