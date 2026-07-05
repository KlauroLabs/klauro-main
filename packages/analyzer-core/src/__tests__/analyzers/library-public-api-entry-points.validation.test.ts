jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { TypeScriptJavaScriptAnalyzer } from '../../analyzer/languages/typescript-javascript-analyzer';
import { CASEntryPoint } from '../../types/cas.types';
import * as fs from 'fs';

// Manual validation (not part of the enforced suite) — runs the REAL
// TypeScript analyzer (real tree parsing, real is_exported tagging) against
// a small library fixture, then feeds those real nodes through
// addDiscoveredEntryPoints to prove the library public-API entry-point path
// end-to-end, not just against hand-built node fixtures. Skips if the
// scratch fixture isn't present so this never affects a plain `jest` run.
const FIXTURE_DIR = '/private/tmp/claude-502/-Users-michaelshattuck-dev-personal/752cda05-4b18-4e71-9d99-3abd87ca92ac/scratchpad/fixture-lib';
const describeIfFixture = fs.existsSync(FIXTURE_DIR) ? describe : describe.skip;

describeIfFixture('validation: real TS analyzer + library entry-point expansion', () => {
  it('surfaces public exports as api entry points, excludes the internal helper', async () => {
    const analyzer = new TypeScriptJavaScriptAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: FIXTURE_DIR });
    const nodes = contribution.nodes || [];

    // eslint-disable-next-line no-console
    console.log('=== real TS analyzer nodes ===');
    for (const node of nodes) {
      // eslint-disable-next-line no-console
      console.log(`${node.type} ${node.name} is_exported=${node.metadata?.is_exported}`);
    }

    const orch = new AnalyzerOrchestrator() as any;
    const entryPoints: CASEntryPoint[] = [];
    orch.addDiscoveredEntryPoints(FIXTURE_DIR, nodes, entryPoints, contribution.edges || []);

    // eslint-disable-next-line no-console
    console.log('=== BEFORE/AFTER entry points ===');
    for (const ep of entryPoints) {
      // eslint-disable-next-line no-console
      console.log(`[${ep.type}] ${ep.name} -> ${ep.handler?.method_name}`);
    }

    // KNOWN GAP (pre-existing, not introduced by this change): the TS
    // analyzer's variable path (processTreeSitterVariables in
    // typescript-javascript-analyzer.ts) sets metadata.isExported (camelCase,
    // an ad-hoc attribute) but not metadata.is_exported (the CASNode
    // contract field functions/classes use) — so an exported top-level
    // `const` like PI_APPROX does not surface as an api entry point today.
    // This test documents actual current coverage rather than asserting
    // behavior the analyzer doesn't yet provide; fixing the variable path's
    // metadata is a separate, disjoint change (feedback filed).
    const apiEntries = entryPoints.filter(ep => ep.type === 'api');
    expect(apiEntries.map(ep => ep.handler?.method_name).sort()).toEqual([
      'Calculator', 'add', 'subtract',
    ]);
    expect(apiEntries.some(ep => ep.handler?.method_name === 'internalRound')).toBe(false);
    expect(apiEntries.some(ep => ep.handler?.method_name === 'PI_APPROX')).toBe(false);
    expect(entryPoints.some(ep => ep.type === 'lifecycle')).toBe(false);
  }, 30000);
});
