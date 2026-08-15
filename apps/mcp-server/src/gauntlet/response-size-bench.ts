

















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



export const RESPONSE_SIZE_BUDGETS: ResponseSizeBudget[] = [







  { tool: 'get_summary', budget_bytes: 1700 * 4 },
  { tool: 'search_nodes', budget_bytes: 1000 * 4 },
  { tool: 'resolve_agent_analysis', budget_bytes: 1000 * 4 },













  { tool: 'get_flow_concepts', budget_bytes: 16500 * 4 },
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


  const summary = query.buildSummary(cas);
  results.push(budgetResult('get_summary', byteSize(summary)));


  const search = await semanticSearch(projectPath, 'orchestrator analysis', {
    getCas: async () => cas,
  });
  results.push(budgetResult('search_nodes', byteSize(search)));


  const resolved = await agentProjectMap.resolveAgentAnalysis({ path: projectPath });
  results.push(budgetResult('resolve_agent_analysis', byteSize(resolved)));



  const flowConcepts = query.getFlowConcepts(cas, {});
  results.push(budgetResult('get_flow_concepts', byteSize(flowConcepts)));

  return { path: projectPath, skipped: false, results };
}

function budgetResult(tool: string, bytes: number): ResponseSizeResult {
  const budget = RESPONSE_SIZE_BUDGETS.find(b => b.tool === tool)!;
  return { tool, bytes, budget_bytes: budget.budget_bytes, within_budget: bytes <= budget.budget_bytes };
}
