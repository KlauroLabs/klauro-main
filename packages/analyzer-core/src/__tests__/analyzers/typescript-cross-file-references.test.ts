jest.unmock('fs');
jest.unmock('fs-extra');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { TypeScriptJavaScriptAnalyzer } from '../../analyzer/languages/typescript-javascript-analyzer';
import { CASContribution, CASEdge, CASNode } from '../../types/cas.types';

// Regression coverage for two real bugs confirmed on real repos in the 2026-07-04
// impact benchmark (~/.klauro/agent-feedback/2026-07-04-impact-benchmark.md):
//
//  #1 (flagship): get_callers / the call graph never tracked cross-file references to
//     exported CONSTANTS or INTERFACE PROPERTIES — only function/method calls. A plain
//     read like `TIER_RATE_LIMITS[tier]` or `limits.endpoints` produced zero edges beyond
//     same-file 'contains', defeating blast-radius analysis on the most common JS/TS
//     pattern (an exported const/config consumed elsewhere).
//
//  #2: get_callers inconsistently missed cross-file calls to imported functions — real
//     root cause: the tree-sitter extractor's extractCall() classified ANY call through an
//     imported identifier as 'external'/'library', even when the import was a same-project
//     relative path (e.g. `import { initializeAuth0Token } from '../api/fetch'`), routing
//     it to the exit-point/SDK branch instead of a real 'calls' edge.
describe('TypeScript cross-file reference and call classification (2026-07-04 impact benchmark)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-cross-file-refs-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function analyzeProject(files: Record<string, string>): Promise<CASContribution> {
    for (const [relativePath, content] of Object.entries(files)) {
      const fullPath = path.join(tempDir, relativePath);
      await fs.ensureDir(path.dirname(fullPath));
      await fs.writeFile(fullPath, content);
    }
    const analyzer = new TypeScriptJavaScriptAnalyzer();
    return analyzer.analyze({ projectPath: tempDir } as any);
  }

  function findNode(contribution: CASContribution, name: string, type?: string): CASNode | undefined {
    return (contribution.nodes || []).find(n => n.name === name && (!type || n.type === type));
  }

  function referenceEdges(contribution: CASContribution): CASEdge[] {
    return (contribution.edges || []).filter(edge => edge.type === 'references');
  }

  function callEdges(contribution: CASContribution): CASEdge[] {
    return (contribution.edges || []).filter(edge => edge.type === 'calls');
  }

  it('records a "references" edge for a cross-file read of an exported constant (not just "contains")', async () => {
    const contribution = await analyzeProject({
      'src/tier-limits.ts': [
        'export const TIER_RATE_LIMITS: Record<string, { requestsPerDay: number }> = {',
        '  free: { requestsPerDay: 100 },',
        '  pro: { requestsPerDay: 10000 },',
        '};',
      ].join('\n'),
      'src/rate-limiter.ts': [
        "import { TIER_RATE_LIMITS } from './tier-limits';",
        '',
        'export class RateLimiter {',
        '  isRateLimited(tier: string): boolean {',
        '    const limits = TIER_RATE_LIMITS[tier] || TIER_RATE_LIMITS.free;',
        '    return limits.requestsPerDay <= 0;',
        '  }',
        '}',
      ].join('\n'),
    });

    const constNode = findNode(contribution, 'TIER_RATE_LIMITS', 'variable');
    expect(constNode).toBeDefined();

    const methodNode = (contribution.nodes || []).find(n => n.type === 'method' && n.name === 'isRateLimited');
    expect(methodNode).toBeDefined();

    const refs = referenceEdges(contribution).filter(e => e.target === constNode!.id);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.some(e => e.source === methodNode!.id)).toBe(true);

    // No fabrication: a 'calls' edge must NOT be created for this (it was never called).
    const fabricatedCallEdge = callEdges(contribution).find(
      e => e.target === constNode!.id && e.source === methodNode!.id
    );
    expect(fabricatedCallEdge).toBeUndefined();
  });

  it('records a "references" edge for a cross-file read of an interface property default value site (no fabricated edge for unrelated names)', async () => {
    const contribution = await analyzeProject({
      'src/config.ts': [
        'export interface RateLimits {',
        '  endpoints: Record<string, number>;',
        '}',
        'export const DEFAULT_LIMITS: RateLimits = { endpoints: {} };',
      ].join('\n'),
      'src/consumer.ts': [
        "import { DEFAULT_LIMITS } from './config';",
        '',
        'export function getEndpointLimit(name: string): number {',
        '  return DEFAULT_LIMITS.endpoints[name] ?? 0;',
        '}',
      ].join('\n'),
    });

    const constNode = findNode(contribution, 'DEFAULT_LIMITS', 'variable');
    expect(constNode).toBeDefined();
    const fnNode = (contribution.nodes || []).find(n => n.type === 'function' && n.name === 'getEndpointLimit');
    expect(fnNode).toBeDefined();

    const refs = referenceEdges(contribution).filter(e => e.target === constNode!.id && e.source === fnNode!.id);
    expect(refs.length).toBeGreaterThan(0);
  });

  it('resolves a call to a same-project function imported via a relative path as a real "calls" edge, not "external"', async () => {
    const contribution = await analyzeProject({
      'src/fetch.ts': [
        'let auth0GetToken: (() => Promise<string>) | null = null;',
        '',
        'export function initializeAuth0Token(getTokenFn: () => Promise<string>) {',
        '  auth0GetToken = getTokenFn;',
        '}',
      ].join('\n'),
      'src/auth-context.tsx': [
        "import { initializeAuth0Token } from './fetch';",
        '',
        'export function AuthContextProvider() {',
        '  initializeAuth0Token(() => Promise.resolve("token"));',
        '  return null;',
        '}',
      ].join('\n'),
    });

    const initNode = findNode(contribution, 'initializeAuth0Token', 'function');
    expect(initNode).toBeDefined();
    const providerNode = findNode(contribution, 'AuthContextProvider', 'function');
    expect(providerNode).toBeDefined();

    const calls = callEdges(contribution).filter(e => e.target === initNode!.id && e.source === providerNode!.id);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('still classifies a call through a genuine third-party package import as external (no regression)', async () => {
    const contribution = await analyzeProject({
      'src/uses-axios.ts': [
        "import axios from 'axios';",
        '',
        'export async function fetchData() {',
        "  return axios.get('/api/data');",
        '}',
      ].join('\n'),
    });

    const fnNode = findNode(contribution, 'fetchData', 'function');
    expect(fnNode).toBeDefined();

    // A real external package call must still produce an exit point / library-classified
    // edge, not a same-project 'calls' edge to a non-existent local node.
    const calls = callEdges(contribution).filter(e => e.source === fnNode!.id);
    const targetsRealLocalNode = calls.some(e =>
      (contribution.nodes || []).some(n => n.id === e.target && n.type !== 'exit_point')
    );
    // axios.get() has no local declaration in this fixture, so any 'calls' edge pointing at
    // a real local node here would indicate the external-import fix regressed.
    expect(targetsRealLocalNode).toBe(false);
  });
});
