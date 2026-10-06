

















import * as path from 'path';
import { analyzeForBench } from './product-analysis';
import { semanticSearch } from '../semantic-search';
import type { CASOutput } from '../../../../packages/analyzer-core/src/types/cas.types';

export interface SearchQualityCase {

  query: string;

  expectedName: string;

  expectedFile?: string;
}

export interface SearchQualityCaseResult {
  query: string;
  expectedName: string;
  rank: number;
  top3: string[];
  top1: string | null;
  pass: boolean;
}

export interface SearchQualityReport {
  sourceDir: string;
  cases: SearchQualityCaseResult[];
  passCount: number;
  total: number;
  allPass: boolean;
}



export const SEARCH_QUALITY_CASES: SearchQualityCase[] = [
  { query: 'buildSummary', expectedName: 'buildSummary', expectedFile: 'query.ts' },
  { query: 'searchNodes', expectedName: 'searchNodes', expectedFile: 'query.ts' },
  { query: 'analyzeProjectLayered', expectedName: 'analyzeProjectLayered', expectedFile: 'analyzer.ts' },
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
  const getCas = async (): Promise<CASOutput> => cas;
  for (const c of cases) {
    const response = await semanticSearch(sourceDir, c.query, { detail: 'full', limit: 10, getCas });
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
