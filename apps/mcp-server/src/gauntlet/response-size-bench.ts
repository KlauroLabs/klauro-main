/**
 * Response-size bench for docs/SPEC-RESPONSE-BUDGET.md — asserts that the
 * DEFAULT (compact) response of the high-traffic onboarding tools stays
 * under its target byte budget on a genuinely large, already-analyzed repo.
 *
 * This does not call the analyzer engine or re-run analysis: it reads the
 * already-stored CAS for the given project path via getAnalysis (the same
 * path the MCP tools themselves use), then calls the same response
 * builders the tools call (query.buildSummary, semanticSearch,
 * agentProjectMap.resolveAgentAnalysis) with their default (compact)
 * options and measures the serialized JSON byte size.
 *
 * If no stored analysis exists for the target repo (e.g. a CI box that
 * never ran analyze_codebase against itself), the bench reports
 * `skipped: true` instead of failing — this is a size regression guard,
 * not a coverage requirement.
 */

import { getAnalysis } from '../analyzer';
import * as query from '../query';
import { semanticSearch } from '../semantic-search';
import * as agentProjectMap from '../agent-project-map';

export interface ResponseSizeBudget {
  tool: string;
  budget_bytes: number;
}

export interface ResponseSizeResult {
  tool: string;
  bytes: number;
  budget_bytes: number;
  within_budget: boolean;
}

export interface ResponseSizeBenchReport {
  path: string;
  skipped: boolean;
  skip_reason?: string;
  results: ResponseSizeResult[];
}

// Targets from docs/SPEC-RESPONSE-BUDGET.md §4 ("New default target"),
// converted from the ~4-bytes-per-token estimate used throughout that spec.
export const RESPONSE_SIZE_BUDGETS: ResponseSizeBudget[] = [
  { tool: 'get_summary', budget_bytes: 1500 * 4 },
  { tool: 'search_nodes', budget_bytes: 1000 * 4 },
  { tool: 'resolve_agent_analysis', budget_bytes: 1000 * 4 },
];

function byteSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export async function runResponseSizeBench(projectPath: string): Promise<ResponseSizeBenchReport> {
  let cas;
  try {
    cas = await getAnalysis(projectPath);
  } catch (error) {
    return {
      path: projectPath,
      skipped: true,
      skip_reason: error instanceof Error ? error.message : String(error),
      results: [],
    };
  }

  const results: ResponseSizeResult[] = [];

  // get_summary — default (no detail passed) is compact.
  const summary = query.buildSummary(cas);
  results.push(budgetResult('get_summary', byteSize(summary)));

  // search_nodes — default mode is hybrid, default detail is compact.
  const search = await semanticSearch(projectPath, 'orchestrator analysis', {
    getCas: async () => cas,
  });
  results.push(budgetResult('search_nodes', byteSize(search)));

  // resolve_agent_analysis — default detail is compact.
  const resolved = await agentProjectMap.resolveAgentAnalysis({ path: projectPath });
  results.push(budgetResult('resolve_agent_analysis', byteSize(resolved)));

  return { path: projectPath, skipped: false, results };
}

function budgetResult(tool: string, bytes: number): ResponseSizeResult {
  const budget = RESPONSE_SIZE_BUDGETS.find(b => b.tool === tool)!;
  return { tool, bytes, budget_bytes: budget.budget_bytes, within_budget: bytes <= budget.budget_bytes };
}
