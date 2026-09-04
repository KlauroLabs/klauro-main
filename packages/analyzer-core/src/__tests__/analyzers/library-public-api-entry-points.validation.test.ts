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

  it('follows CommonJS re-exports from a default index entry and surfaces prototype-object members as api entry points', async () => {
    const cjsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-cjs-lib-'));
    try {
      fs.mkdirSync(path.join(cjsDir, 'lib'));
      fs.writeFileSync(path.join(cjsDir, 'package.json'), JSON.stringify({ name: 'tinyweb', version: '1.0.0', description: 'Minimal web toolkit', dependencies: {} }));
      fs.writeFileSync(path.join(cjsDir, 'index.js'), "module.exports = require('./lib/tinyweb');\n");
      fs.writeFileSync(path.join(cjsDir, 'lib', 'tinyweb.js'), [
        "var app = exports = module.exports = {};",
        "app.use = function use(fn) { return fn; };",
        "app.listen = function listen(port) { return port; };",
        "function privateHelper() { return 1; }",
        "exports.Router = require('./router');",
      ].join('\n'));
      fs.writeFileSync(path.join(cjsDir, 'lib', 'router.js'), [
        "function Router() {}",
        "Router.prototype.route = function route(path) { return path; };",
        "module.exports = Router;",
      ].join('\n'));
      const analyzer = new TypeScriptJavaScriptAnalyzer();
      const contribution = await analyzer.analyze({ projectPath: cjsDir } as any);
      const orch = new AnalyzerOrchestrator() as any;
      const entryPoints: CASEntryPoint[] = [];
      orch.addDiscoveredEntryPoints(cjsDir, contribution.nodes, entryPoints, contribution.edges || []);
      const apiNames = entryPoints.filter(ep => ep.type === 'api').map(ep => ep.name).sort();
      expect(apiNames).toEqual(expect.arrayContaining(['tinyweb.use', 'tinyweb.listen', 'tinyweb.Router']));
      expect(apiNames.some(name => name.endsWith('.privateHelper'))).toBe(false);
    } finally {
      fs.rmSync(cjsDir, { recursive: true, force: true });
    }
  });

  it('surfaces a Python package re-export and a Rust crate pub item as api entry points', async () => {
    const { PythonAnalyzer } = await import('../../analyzer/languages/python-analyzer');
    const { RustAnalyzer } = await import('../../analyzer/languages/rust-analyzer');
    const pyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-py-lib-'));
    const rsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-rs-lib-'));
    try {
      fs.writeFileSync(path.join(pyDir, 'pyproject.toml'), '[project]\nname = "tinyapi"\nversion = "0.1.0"\n');
      fs.mkdirSync(path.join(pyDir, 'tinyapi'));
      fs.writeFileSync(path.join(pyDir, 'tinyapi', '__init__.py'), 'from .core import make_app\n');
      fs.writeFileSync(path.join(pyDir, 'tinyapi', 'core.py'), 'def make_app(name):\n    return name\n\ndef _helper():\n    return 1\n');
      const pyContribution = await new PythonAnalyzer().analyze({ projectPath: pyDir } as any);
      const pyOrch = new AnalyzerOrchestrator() as any;
      const pyEntries: CASEntryPoint[] = [];
      pyOrch.addDiscoveredEntryPoints(pyDir, pyContribution.nodes, pyEntries, pyContribution.edges || []);
      const pyApi = pyEntries.filter(ep => ep.type === 'api').map(ep => ep.name);
      expect(pyApi).toContain('tinyapi.make_app');
      expect(pyApi.some(name => name.endsWith('._helper'))).toBe(false);

      fs.writeFileSync(path.join(rsDir, 'Cargo.toml'), '[package]\nname = "tinyweb"\nversion = "0.1.0"\n');
      fs.mkdirSync(path.join(rsDir, 'src'));
      fs.writeFileSync(path.join(rsDir, 'src', 'lib.rs'), 'pub mod routing;\npub use routing::Router;\n');
      fs.writeFileSync(path.join(rsDir, 'src', 'routing.rs'), 'pub struct Router;\npub fn route(path: &str) -> Router { Router }\nfn hidden() {}\n');
      const rsContribution = await new RustAnalyzer().analyze({ projectPath: rsDir } as any);
      const rsOrch = new AnalyzerOrchestrator() as any;
      const rsEntries: CASEntryPoint[] = [];
      rsOrch.addDiscoveredEntryPoints(rsDir, rsContribution.nodes, rsEntries, rsContribution.edges || []);
      const rsApi = rsEntries.filter(ep => ep.type === 'api').map(ep => ep.name);
      expect(rsApi).toEqual(expect.arrayContaining(['tinyweb.route', 'tinyweb.Router']));
      expect(rsApi.some(name => name.endsWith('.hidden'))).toBe(false);
    } finally {
      fs.rmSync(pyDir, { recursive: true, force: true });
      fs.rmSync(rsDir, { recursive: true, force: true });
    }
  });

  it('tags exported variables with the is_exported CAS contract field', async () => {
    const analyzer = new TypeScriptJavaScriptAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: fixtureDir });
    const piNode = (contribution.nodes || []).find(node => node.name === 'PI_APPROX');

    expect(piNode).toBeDefined();
    expect(piNode?.metadata?.is_exported).toBe(true);
    expect(piNode?.metadata).not.toHaveProperty('isExported');
  }, 30000);
});
