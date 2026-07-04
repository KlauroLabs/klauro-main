/**
 * Scratch measurement script for the token-efficiency audit (not part of the
 * shipped surface) — measures real response sizes for the 7 highest-traffic
 * MCP tools against an already-analyzed repo's stored CAS, using the exact
 * response builders in query.ts / agent-adoption.ts / semantic-search.ts.
 *
 *   npx tsx apps/mcp-server/scripts/measure-response-sizes.ts [path]
 */
import { getAnalysis } from '../src/analyzer';
import * as query from '../src/query';
import * as agentAdoption from '../src/agent-adoption';
import { semanticSearch } from '../src/semantic-search';

function byteSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
function tok(bytes: number) { return Math.round(bytes / 4); }

async function main() {
  const path = process.argv[2] || '/Users/michaelshattuck/dev/unravl/proof-of-concept';
  const cas = await getAnalysis(path);
  console.log(`nodes=${cas.nodes.length} edges=${cas.edges.length}`);

  const rows: Array<{ tool: string; bytes: number }> = [];

  rows.push({ tool: 'get_summary (default/compact)', bytes: byteSize(query.buildSummary(cas)) });
  rows.push({ tool: 'get_summary (full)', bytes: byteSize(query.buildSummary(cas, { detail: 'full' })) });

  const search = await semanticSearch(path, 'analyzer orchestrator', { getCas: async () => cas });
  rows.push({ tool: 'search_nodes (default)', bytes: byteSize(search) });

  const orchestratorNode = cas.nodes.find(n => n.name === 'AnalyzerOrchestrator') || cas.nodes.find(n => n.type === 'class');
  if (orchestratorNode) {
    const cc = query.getCodingContext(cas, orchestratorNode.id);
    rows.push({ tool: `get_coding_context (${orchestratorNode.name}, default limits)`, bytes: byteSize(cc) });
  }

  const routeTable = query.getRouteTable(cas);
  rows.push({ tool: `get_route_table (default) total=${routeTable.total}`, bytes: byteSize(routeTable) });

  const flowConcepts = query.getFlowConcepts(cas, {});
  rows.push({ tool: `get_flow_concepts (default, NO maxFlows cap) total=${flowConcepts.total}`, bytes: byteSize(flowConcepts) });

  if (orchestratorNode) {
    const callers = query.getCallers(cas, orchestratorNode.id, 2, 50);
    rows.push({ tool: `get_callers (${orchestratorNode.name}, depth2 limit50) total=${callers.total}`, bytes: byteSize(callers) });
  }

  try {
    const agentContext = await agentAdoption.getAgentContext(cas, path, { task_type: 'orient' } as any);
    rows.push({ tool: 'get_agent_context (task_type=orient, default profile)', bytes: byteSize(agentContext) });
    const agentContextCapsule = await agentAdoption.getAgentContext(cas, path, { task_type: 'orient', response_profile: 'capsule-only' } as any);
    rows.push({ tool: 'get_agent_context (capsule-only)', bytes: byteSize(agentContextCapsule) });
  } catch (e) {
    console.log('get_agent_context error:', (e as Error).message);
  }

  console.log('');
  for (const r of rows) {
    console.log(`${r.tool.padEnd(70)} ${String(r.bytes).padStart(8)}B  ~${tok(r.bytes)} tok`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
