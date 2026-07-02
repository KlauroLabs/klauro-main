/**
 * search-quality-bench — the search-reliability proof.
 *
 * Real dogfood finding: querying search_nodes with an actual symbol name from
 * this repo (buildSummary, searchNodes, AnalyzerOrchestrator, ...) frequently
 * failed to surface that symbol at all in the top results, even with the
 * hybrid mode's embedding index active — because RRF-fused semantic/lexical
 * scores plus a structural re-rank can out-rank a genuine exact-name match
 * with an unrelated node that merely embeds "close" under the local hash
 * embedding provider. Search is the primary navigation primitive; if a query
 * for the exact function name doesn't return that function first, agents fall
 * back to grep and Klauro's code-intelligence value is capped.
 *
 * BLACKBOX like the rest of the gauntlet: goes through analyzeForBench (the
 * product's own analyzer-server) and the real search_nodes/semanticSearch
 * code path — no engine import, no AI env, no shortcuts.
 */

import * as path from 'path';
import { analyzeForBench } from './product-analysis';
import { semanticSearch } from '../semantic-search';
import type { CASOutput } from '../../../../packages/analyzer-core/src/types/cas.types';

export interface SearchQualityCase {
  /** A real symbol name that exists in the analyzed source tree. */
  query: string;
  /** The exact node name we expect back. */
  expectedName: string;
  /** Optional: narrow to a specific file when the name is ambiguous. */
  expectedFile?: string;
}

export interface SearchQualityCaseResult {
  query: string;
  expectedName: string;
  rank: number; // 1-based; -1 if not found in returned results
  top3: string[];
  top1: string | null;
  pass: boolean; // expected node in top-3
}

export interface SearchQualityReport {
  sourceDir: string;
  cases: SearchQualityCaseResult[];
  passCount: number;
  total: number;
  allPass: boolean;
}

// Real symbols from apps/mcp-server/src, the same source tree this bench
// analyzes (see runSearchQualityBench's default sourceDir).
export const SEARCH_QUALITY_CASES: SearchQualityCase[] = [
  { query: 'buildSummary', expectedName: 'buildSummary', expectedFile: 'query.ts' },
  { query: 'searchNodes', expectedName: 'searchNodes', expectedFile: 'query.ts' },
  { query: 'getFreshAnalysisForAgent', expectedName: 'getFreshAnalysisForAgent', expectedFile: 'server.ts' },
  { query: 'fuseAndRank', expectedName: 'fuseAndRank', expectedFile: 'semantic-search.ts' },
  { query: 'semanticSearch', expectedName: 'semanticSearch', expectedFile: 'semantic-search.ts' },
  { query: 'getSecurityOverview', expectedName: 'getSecurityOverview', expectedFile: 'query.ts' },
];

function matchesExpected(nodeName: string, nodeFile: string | undefined, c: SearchQualityCase): boolean {
  if (nodeName !== c.expectedName) return false;
  if (c.expectedFile && !(nodeFile || '').replace(/\\/g, '/').endsWith(c.expectedFile)) return false;
  return true;
}

export async function evaluateSearchQuality(
  cas: CASOutput,
  sourceDir: string,
  cases: SearchQualityCase[] = SEARCH_QUALITY_CASES,
): Promise<SearchQualityCaseResult[]> {
  const results: SearchQualityCaseResult[] = [];
  for (const c of cases) {
    // Go through the real hybrid search path (default mode, same as the live
    // MCP tool), reading the CAS we just saved via analyzeForBench.
    const response = await semanticSearch(sourceDir, c.query, { detail: 'full', limit: 10 });
    const names = response.results.map(r => r.name);
    const matchIndex = response.results.findIndex(r => matchesExpected(r.name, r.file, c));
    const rank = matchIndex === -1 ? -1 : matchIndex + 1;
    results.push({
      query: c.query,
      expectedName: c.expectedName,
      rank,
      top3: names.slice(0, 3),
      top1: names[0] ?? null,
      pass: rank !== -1 && rank <= 3,
    });
  }
  return results;
}

export async function runSearchQualityBench(
  sourceDir: string = path.resolve(__dirname, '..'),
): Promise<SearchQualityReport> {
  const cas = await analyzeForBench(sourceDir);
  const cases = await evaluateSearchQuality(cas, sourceDir);
  const passCount = cases.filter(c => c.pass).length;
  return {
    sourceDir,
    cases,
    passCount,
    total: cases.length,
    allPass: passCount === cases.length,
  };
}
