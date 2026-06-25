/* Full-surface Klauro dogfood: run every single-CAS navigation/understanding
 * tool against Klauro's own analyzer-core, and triage each output. */
import { analyzeProject, getAnalysis } from './analyzer';
import * as q from './query';

const TARGET = '/Users/michaelshattuck/dev/unravl/proof-of-concept/packages/analyzer-core';

const NA_ON_LIBRARY = new Set(['getRouteTable', 'getWorkflows', 'getComponentParents', 'getComponentChildren', 'getComponentMetrics', 'getSharedComponents', 'getPerspectives']);
const NEEDS_GIT_HISTORY = new Set(['getHotSpots', 'getStability']);

function verdict(label: string, value: any): void {
  let v = 'OK', note = '';
  try {
    if (value === undefined || value === null) {
      v = NA_ON_LIBRARY.has(label) ? 'N/A' : NEEDS_GIT_HISTORY.has(label) ? 'N/A' : 'EMPTY';
      note = v === 'N/A' ? 'empty on this library/non-git target' : 'null';
    }
    else {
      const json = JSON.stringify(value);
      const len = json.length;
      // pull common emptiness signals
      const arrs = ['results', 'entities', 'routes', 'callers', 'callees', 'nodes', 'journeys', 'workflows', 'capabilities', 'patterns', 'behaviors', 'comments', 'todos', 'examples', 'guidance', 'conventions', 'libraries', 'packages', 'hooks', 'concepts', 'tests', 'parents', 'children', 'instances', 'hot_spots'];
      let primaryLen: number | undefined;
      for (const a of arrs) if (Array.isArray(value?.[a])) { primaryLen = value[a].length; break; }
      if (primaryLen === undefined && Array.isArray(value)) primaryLen = value.length;
      const total = typeof value?.total === 'number' ? value.total : undefined;
      // Tools that are legitimately empty on THIS target (a TS library with no
      // HTTP routes / React components / loaded git history) are verified to return
      // data on a web app + git repo, so empty here is correct, not a gap.
      if ((primaryLen === 0 || total === 0 || len < 40) && NA_ON_LIBRARY.has(label)) { v = 'N/A', note = 'empty (no routes/components on this library target)'; }
      else if (NEEDS_GIT_HISTORY.has(label) && len < 200) { v = 'N/A', note = 'needs git change-history'; }
      else if (primaryLen === 0 || total === 0) { v = 'EMPTY'; note = `total=${total ?? primaryLen}`; }
      else if (len < 40) { v = 'EMPTY'; note = json.slice(0, 40); }
      else if (len < 160) { v = 'THIN'; note = `${len}b`; }
      else { v = 'OK'; note = `${len}b${primaryLen !== undefined ? ` n=${primaryLen}` : ''}${total !== undefined ? ` total=${total}` : ''}`; }
      // key-field spot checks for the rich tools
      if (label === 'getCodingContext') note += ` ctx[${Object.keys(value).join(',')}]`.slice(0, 80);
      if (label === 'getNode' && value?.name) note = `name=${value.name} ${note}`;
      if (label === 'getIntent') note = `${JSON.stringify(value).slice(0, 90)}`;
    }
  } catch (e: any) { v = 'ERROR'; note = e?.message || String(e); }
  console.log(`${v.padEnd(6)} ${label.padEnd(26)} ${note}`);
}

async function run(label: string, fn: () => any): Promise<void> {
  try { verdict(label, await fn()); }
  catch (e: any) { console.log(`ERROR  ${label.padEnd(26)} ${(e?.message || e)?.toString().slice(0, 80)}`); }
}

async function main() {
  process.env.KLAURO_AI_INTERPRETATION ||= 'false';
  process.env.KLAURO_AI_INTERPRETATION_ENABLED ||= 'false';
  const cas: any = await analyzeProject(TARGET); // always fresh so new code is present
  // bootstrap target ids from broad searches; take the first node that exists
  const firstHit = (query: string, type?: string) => {
    const res = q.searchNodes(cas, query, { limit: 8 } as any) as any;
    const r: any[] = Array.isArray(res) ? res : (res?.results || []);
    return (type ? r.find((x: any) => x.type === type) : r[0]) || r[0];
  };
  const classHit = firstHit('analyzer orchestrator', 'class') || firstHit('analyzer', 'class');
  const fnHit = firstHit('build data entities', 'method') || firstHit('analyze', 'method') || firstHit('build', 'function');
  const classId = classHit?.id; const fnId = fnHit?.id;
  const filePath = classHit?.file || fnHit?.file || 'src/analyzer/core/orchestrator.ts';
  const patternId = (q.getPatterns(cas) as any)?.patterns?.[0]?.id || (q.getPatterns(cas) as any)?.[0]?.id;
  const behaviorId = (q.getBehaviors(cas, { limit: 2 } as any) as any)?.behaviors?.[0]?.id;
  const chainId = (q.getCallChain(cas, { limit: 2 }) as any)?.chains?.[0]?.id;
  console.log(`# bootstrap: classId=${!!classId} fnId=${!!fnId} patternId=${!!patternId} behaviorId=${!!behaviorId} chainId=${!!chainId}\n`);

  // ORIENTATION
  await run('getSystemOverview', () => q.getSystemOverview(cas));
  await run('getSummary', () => q.buildSummary(cas));
  await run('getLevel(1)', () => q.getLevel(cas, 1, { limit: 20 }));
  await run('getPerspectives', () => q.getPerspectives(cas));
  // SEARCH / NODE
  await run('searchNodes', () => q.searchNodes(cas, 'rust analyzer', { limit: 8 } as any));
  await run('getNode', () => classId ? q.getNode(cas, classId) : null);
  await run('getFileNodes', () => q.getFileNodes(cas, filePath));
  await run('getIntent', () => classId ? q.getIntent(cas, classId) : null);
  await run('findSimilarCode', () => classId ? q.findSimilarCode(cas, { node_id: classId, limit: 5 }) : null);
  await run('getUsageExamples', () => fnId ? q.getUsageExamples(cas, fnId, { limit: 5 }) : null);
  // MODIFY
  await run('getCodingContext', () => q.getCodingContext(cas, 'extractAxumRoutes', { task_type: 'refactor' }));
  await run('getModificationGuide', () => fnId ? q.getModificationGuide(cas, fnId, 'signature') : null);
  await run('getCallers', () => fnId ? q.getCallers(cas, fnId) : null);
  await run('getCallees', () => fnId ? q.getCallees(cas, fnId) : null);
  await run('getMethodCalls', () => fnId ? q.getMethodCalls(cas, fnId) : null);
  await run('getCallChain', () => q.getCallChain(cas, { limit: 5 }));
  await run('getErrorContracts', () => fnId ? q.getErrorContracts(cas, fnId, 'both') : null);
  await run('assessChangeRisk', () => fnId ? q.assessChangeRisk(cas, fnId) : null);
  await run('getStability', () => q.getStability(cas));
  await run('findTests', () => fnId ? q.findTests(cas, { nodeId: fnId, limit: 5 }) : q.findTests(cas, { limit: 5 }));
  // CONVENTIONS / PATTERNS
  await run('getConventions', () => q.getConventions(cas, {}));
  await run('getPatterns', () => q.getPatterns(cas));
  await run('getPatternExamples', () => patternId ? q.getPatternExamples(cas, patternId, { limit: 3 }) : null);
  await run('getPatternInstances', () => patternId ? q.getPatternInstances(cas, patternId, { limit: 3 }) : null);
  await run('getFrameworkGuidance', () => q.getFrameworkGuidance(cas, {}));
  await run('getDomainConcepts', () => q.getDomainConcepts(cas, { limit: 10 }));
  // ENTRY / EXIT / ROUTES / DATA
  await run('getEntryPoints', () => q.getEntryPoints(cas, { limit: 10 }));
  await run('getExitPoints', () => q.getExitPoints(cas, { limit: 10 }));
  await run('getRouteTable', () => q.getRouteTable(cas, { limit: 10 }));
  await run('getExternalServices', () => q.getExternalServices(cas));
  await run('getDataEntities', () => q.getDataEntities(cas, { limit: 10 }));
  await run('getDataLineage', () => q.getDataLineage(cas, { limit: 10 }));
  await run('getDatabaseSchema', () => q.getDatabaseSchema(cas));
  // FLOWS / BEHAVIORS / JOURNEYS
  await run('getUserJourneys', () => q.getUserJourneys(cas, { limit: 10 } as any));
  await run('getWorkflows', () => q.getWorkflows(cas));
  await run('getFlowGraph', () => q.getFlowGraph(cas));
  await run('getFlowCoverage', () => q.getFlowCoverage(cas));
  await run('getBehaviors', () => q.getBehaviors(cas, { limit: 10 } as any));
  await run('getBehaviorDetail', () => behaviorId ? q.getBehaviorDetail(cas, behaviorId) : null);
  await run('getBehavioralInvariants', () => q.getBehavioralInvariants(cas, {} as any));
  await run('getLifecycleHooks', () => q.getLifecycleHooks(cas, {} as any));
  await run('getParadigmConformance', () => q.getParadigmConformance(cas, {} as any));
  // COMPONENTS
  await run('getComponentParents', () => classId ? q.getComponentParents(cas, classId) : null);
  await run('getComponentChildren', () => classId ? q.getComponentChildren(cas, classId) : null);
  await run('getComponentMetrics', () => classId ? q.getComponentMetrics(cas, classId) : null);
  await run('getSharedComponents', () => (q as any).getSharedComponents(cas, {}));
  // QUALITY / META
  await run('getSecurityOverview', () => q.getSecurityOverview(cas));
  await run('getImplementationHealth', () => q.getImplementationHealth(cas));
  await run('getSystemHealth', () => q.getSystemHealth(cas));
  await run('getTestSummary', () => q.getTestSummary(cas, {} as any));
  await run('getDocumentationCoverage', () => q.getDocumentationCoverage(cas));
  await run('getComments', () => q.getComments(cas, { scope: 'all', limit: 10 } as any));
  await run('getTodos', () => q.getTodos(cas));
  await run('getDependencies', () => q.getDependencies(cas));
  await run('getLibraries', () => q.getLibraries(cas, { limit: 10 }));
  await run('getConfiguration', () => q.getConfiguration(cas));
  await run('getHotSpots', () => q.getHotSpots(cas, TARGET, { metric: 'change-count' } as any));
  await run('getProductMap', () => q.getProductMap(cas, {} as any));
  await run('getAnalysisFacts', () => q.getAnalysisFacts(cas));
}
main().catch(e => { console.error('FATAL', e?.stack || e?.message || e); process.exit(1); });
