import type {
  CASOutput,
  CASNode,
  CASEntityLineage,
  CASEntityLineageAccessor,
  CASChangeRisk,
  DeployableEvidence,
} from '../../types/cas.types';
import type { CommunicationSeamsResult } from './communication-seams';
import { CONTRACT_MODEL_NAME } from './flow-concepts';






















































export const ENTRENCHMENT_CONTRACT_MODEL = CONTRACT_MODEL_NAME;


export type EntrenchmentLevel =
  | 'leaf'
  | 'peripheral'
  | 'connected'
  | 'load-bearing'
  | 'foundational'
  | 'bedrock';

const LEVEL_ORDER: EntrenchmentLevel[] = [
  'leaf',
  'peripheral',
  'connected',
  'load-bearing',
  'foundational',
  'bedrock',
];



export interface FacetEntrenchment {

  output: number;

  state_changes: number;

  constraints: number;

  integrations: number;

  logic: number;
}


export interface NodeEntrenchment {
  node_id: string;

  score: number;
  level: EntrenchmentLevel;

  signals: {
    fan_in: number;
    blast_radius: number;
    centrality: number;
    flow_participation: number;
    facets: FacetEntrenchment;
    cross_boundary: number;
    runtime: number;
  };

  raw: {
    direct_dependents: number;
    transitive_dependents: number;
    flows: number;

    shared_state_readers: number;

    shared_state_entities: string[];
    cross_repo: boolean;
    cross_deployable_readers: number;
    request_count?: number;
  };


  evidence: string[];
}

export interface FileEntrenchment {
  file: string;
  score: number;
  level: EntrenchmentLevel;

  node_count: number;
  bedrock_nodes: number;
  top_node?: string;
}

export interface ModuleEntrenchment {
  module: string;
  score: number;
  level: EntrenchmentLevel;
  file_count: number;
}

export interface EntrenchmentSummary {
  contract_model: string;

  distribution: Record<EntrenchmentLevel, number>;

  repo_score: number;
  repo_level: EntrenchmentLevel;


  bedrock: Array<{
    node_id: string;
    name: string;
    file?: string;
    score: number;
    level: EntrenchmentLevel;
    evidence: string[];
  }>;

  files: FileEntrenchment[];
  modules: ModuleEntrenchment[];
  counts: { nodes_scored: number; files: number; modules: number };
}

export interface EntrenchmentResult {

  nodes: Record<string, NodeEntrenchment>;
  summary: EntrenchmentSummary;
}




const UNIT_NODE_TYPES = new Set([
  'function', 'method', 'controller', 'handler', 'route', 'resolver', 'gateway',
  'service', 'usecase', 'repository', 'dao', 'class', 'module', 'file',
  'component', 'functional_component', 'class_component', 'hook', 'custom_hook',
  'interface', 'type', 'entity', 'model', 'schema',
]);

function isUnitNode(node: CASNode): boolean {
  if (UNIT_NODE_TYPES.has(node.type)) return true;


  const cg = node.call_graph;
  return Boolean(cg && ((cg.called_by?.length || 0) > 0 || (cg.calls?.length || 0) > 0));
}




function saturate(count: number, k: number): number {
  if (count <= 0) return 0;
  return count / (count + k);
}



function componentForFile(
  file: string | undefined,
  deployableRoots: Array<{ root: string; name: string }>,
): string {
  if (!file) return 'unknown';
  let f = file.replace(/\\/g, '/');
  if (f.startsWith('/')) {
    const m = f.match(/\/((?:apps|libs|packages|src)\/.*)$/);
    if (m) f = m[1];
    else return 'unknown';
  }
  f = f.replace(/^\/+/, '');
  let best: { root: string; name: string } | undefined;
  for (const d of deployableRoots) {
    if (d.root === '' || d.root === '.') continue;
    if (f === d.root || f.startsWith(`${d.root}/`)) {
      if (!best || d.root.length > best.root.length) best = d;
    }
  }
  if (best) return best.name;
  const parts = f.split('/');
  if (parts.length >= 3 && (parts[0] === 'libs' || parts[0] === 'packages')) {
    return parts.slice(0, 3).join('/');
  }
  if (parts.length >= 2) return parts.slice(0, 2).join('/');
  return parts[0] || 'root';
}


function moduleForFile(file: string): string {
  const f = file.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = f.split('/');
  if (parts.length >= 3 && (parts[0] === 'libs' || parts[0] === 'packages')) {
    return parts.slice(0, 3).join('/');
  }
  if (parts.length >= 2) return parts.slice(0, 2).join('/');
  return parts[0] || 'root';
}

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}






export function computeEntrenchment(
  output: { nodes: CASNode[] } & Partial<
    Pick<
      CASOutput,
      | 'edges'
      | 'entry_points'
      | 'exit_points'
      | 'data_lineage'
      | 'change_risks'
      | 'communication_seams'
      | 'deployable_evidence'
      | 'call_chains'
      | 'user_journeys'
      | 'repository_links'
      | 'cross_repository_links'
    >
  > & { runtimeMetrics?: Array<{ static_id?: string; node_id?: string; request_count?: number }> },
): EntrenchmentResult {
  const nodes = output.nodes || [];
  const emptyResult: EntrenchmentResult = {
    nodes: {},
    summary: {
      contract_model: ENTRENCHMENT_CONTRACT_MODEL,
      distribution: emptyDistribution(),
      repo_score: 0,
      repo_level: 'leaf',
      bedrock: [],
      files: [],
      modules: [],
      counts: { nodes_scored: 0, files: 0, modules: 0 },
    },
  };
  if (nodes.length === 0) return emptyResult;

  const byId = new Map<string, CASNode>();
  for (const n of nodes) byId.set(n.id, n);

  const deployables: DeployableEvidence[] = output.deployable_evidence || [];
  const deployableRoots = deployables
    .filter(d => d.kind !== 'server-entry')
    .map(d => ({
      root: d.root_path.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\/+/, ''),
      name: d.name,
    }));
  const nodeFile = new Map<string, string>();
  for (const n of nodes) if (n.source?.file) nodeFile.set(n.id, n.source.file);





  const dependents = new Map<string, Set<string>>();
  const addDependent = (unit: string, dep: string) => {
    if (!unit || !dep || unit === dep) return;
    let set = dependents.get(unit);
    if (!set) { set = new Set(); dependents.set(unit, set); }
    set.add(dep);
  };
  for (const n of nodes) {
    for (const cb of n.call_graph?.called_by || []) {
      if (cb.source_id) addDependent(n.id, cb.source_id);
    }
  }
  const DEPENDENCY_EDGE_TYPES = new Set([
    'CALLS', 'USES', 'DEPENDS_ON', 'RENDERS', 'IMPORTS', 'REFERENCES',
    'INSTANTIATES', 'EXTENDS', 'IMPLEMENTS', 'INJECTS',
  ]);
  for (const e of output.edges || []) {
    const type = String(e.type || '').toUpperCase();
    if (!DEPENDENCY_EDGE_TYPES.has(type)) continue;

    if (byId.has(e.source) && byId.has(e.target)) addDependent(e.target, e.source);
  }




  const changeRiskById = new Map<string, CASChangeRisk>();
  for (const cr of output.change_risks || []) changeRiskById.set(cr.node_id, cr);

  const traversalIds: string[] = [];
  const traversalOrdinalById = new Map<string, number>();
  const registerTraversalId = (id: string) => {
    if (traversalOrdinalById.has(id)) return;
    traversalOrdinalById.set(id, traversalIds.length);
    traversalIds.push(id);
  };
  for (const id of byId.keys()) registerTraversalId(id);
  for (const [unit, directDependents] of dependents) {
    registerTraversalId(unit);
    for (const dependent of directDependents) registerTraversalId(dependent);
  }
  const dependentOrdinals = Array.from({ length: traversalIds.length }, () => [] as number[]);
  for (const [unit, directDependents] of dependents) {
    const unitOrdinal = traversalOrdinalById.get(unit)!;
    for (const dependent of directDependents) dependentOrdinals[unitOrdinal].push(traversalOrdinalById.get(dependent)!);
  }
  const traversalMarks = new Uint32Array(traversalIds.length);
  const traversalQueue = new Uint32Array(traversalIds.length);
  let traversalGeneration = 0;
  const transitiveCache = new Map<string, number>();
  function transitiveDependentCount(unit: string): number {
    const cached = transitiveCache.get(unit);
    if (cached !== undefined) return cached;
    const cr = changeRiskById.get(unit);
    if (cr) {
      const n =
        (cr.downstream_impact.transitive_callers?.length || 0) +
        (cr.downstream_impact.direct_callers?.length || 0);

      const count = Math.max(
        cr.downstream_impact.transitive_callers?.length || 0,
        (cr.downstream_impact.direct_callers?.length || 0),
        n === 0 ? 0 : n - (cr.downstream_impact.direct_callers?.length || 0),
      );
      transitiveCache.set(unit, count);
      return count;
    }
    const start = traversalOrdinalById.get(unit);
    if (start === undefined) {
      transitiveCache.set(unit, 0);
      return 0;
    }
    traversalGeneration = (traversalGeneration + 1) >>> 0;
    if (traversalGeneration === 0) {
      traversalMarks.fill(0);
      traversalGeneration = 1;
    }
    traversalMarks[start] = traversalGeneration;
    traversalQueue[0] = start;
    let head = 0;
    let tail = 1;
    let count = 0;
    while (head < tail) {
      const current = traversalQueue[head++];
      for (const dependent of dependentOrdinals[current]) {
        if (traversalMarks[dependent] === traversalGeneration) continue;
        traversalMarks[dependent] = traversalGeneration;
        traversalQueue[tail++] = dependent;
        count++;
      }
    }
    transitiveCache.set(unit, count);
    return count;
  }




  const totalUnits = nodes.filter(isUnitNode).length || 1;






  const flowMembership = new Map<string, Set<string>>();
  const joinFlow = (nodeId: string | undefined, flowId: string) => {
    if (!nodeId) return;
    let set = flowMembership.get(nodeId);
    if (!set) { set = new Set(); flowMembership.set(nodeId, set); }
    set.add(flowId);
  };
  for (const chain of output.call_chains || []) {
    joinFlow(chain.entry_point?.node_id, chain.id);
    if (chain.exit_point?.node_id) joinFlow(chain.exit_point.node_id, chain.id);
    for (const step of chain.call_path || []) joinFlow(step.node_id, chain.id);
  }
  for (const j of output.user_journeys || []) {
    joinFlow(j.entry?.handler_node_id, j.id);
    for (const step of j.steps || []) joinFlow(step.node_id, j.id);
  }
  const flowCount = new Map<string, number>();
  for (const [id, set] of flowMembership) flowCount.set(id, set.size);





  const seams: CommunicationSeamsResult | undefined = output.communication_seams;





  const passiveEntities = new Set<string>();
  for (const s of seams?.seams || []) {
    if (s.modality === 'passive' && s.shared_resource) passiveEntities.add(s.shared_resource);
  }
  const gateOnSeams = Boolean(seams && seams.seams.length > 0);

  const lineage: CASEntityLineage[] = output.data_lineage || [];

  const sharedStateReaders = new Map<string, { readers: Set<string>; entities: Set<string>; crossDeployable: Set<string> }>();
  const deployableNames = new Set(deployableRoots.map(d => d.name));
  for (const entity of lineage) {




    if (gateOnSeams && !passiveEntities.has(entity.entity_name)) continue;
    const readerComponents = new Set<string>();
    for (const r of entity.readers || []) {
      const c = componentForFile((r as CASEntityLineageAccessor).file, deployableRoots);
      if (c && c !== 'unknown') readerComponents.add(c);
    }
    for (const w of entity.writers || []) {
      const writerId = (w as CASEntityLineageAccessor).node_id;
      if (!writerId) continue;
      const writerComponent = componentForFile((w as CASEntityLineageAccessor).file, deployableRoots);

      const others = new Set<string>();
      for (const rc of readerComponents) if (rc !== writerComponent) others.add(rc);
      if (others.size === 0) continue;
      let rec = sharedStateReaders.get(writerId);
      if (!rec) { rec = { readers: new Set(), entities: new Set(), crossDeployable: new Set() }; sharedStateReaders.set(writerId, rec); }
      for (const o of others) {
        rec.readers.add(o);
        if (deployableNames.has(o) && deployableNames.has(writerComponent) && o !== writerComponent) rec.crossDeployable.add(o);
      }
      rec.entities.add(entity.entity_name);
    }
  }




  const exitOwners = new Set<string>();
  for (const ex of output.exit_points || []) if (ex.source_node) exitOwners.add(ex.source_node);




  const constraintOwners = new Map<string, number>();
  for (const ep of output.entry_points || []) {




    const guardCount =
      (ep.security?.guards?.length || 0) + (ep.security?.authenticated ? 1 : 0);
    if (guardCount === 0) continue;
    const ownerId = ep.handler?.node_id || ep.source_node;
    if (!ownerId) continue;
    constraintOwners.set(ownerId, (constraintOwners.get(ownerId) || 0) + guardCount);
  }


  const crossRepoNodes = new Set<string>();
  for (const link of [...(output.repository_links || []), ...(output.cross_repository_links || [])]) {
    for (const nid of link.source_repository?.node_ids || []) crossRepoNodes.add(String(nid));
    for (const nid of link.target_repository?.node_ids || []) crossRepoNodes.add(String(nid));
  }


  const runtimeByNode = new Map<string, number>();
  for (const m of output.runtimeMetrics || []) {
    const id = m.node_id || m.static_id;
    if (id && typeof m.request_count === 'number') {
      runtimeByNode.set(id, Math.max(runtimeByNode.get(id) || 0, m.request_count));
    }
  }







  const unitNodes = nodes.filter(isUnitNode);
  const blastValues: number[] = unitNodes.map(n => transitiveDependentCount(n.id));
  const sortedBlast = [...blastValues].sort((a, b) => a - b);
  const percentileOf = (value: number): number => {
    if (sortedBlast.length === 0 || value <= 0) return 0;

    let lo = 0, hi = sortedBlast.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sortedBlast[mid] < value) lo = mid + 1; else hi = mid;
    }
    return lo / sortedBlast.length;
  };


  const nodeResults: Record<string, NodeEntrenchment> = {};
  for (const node of nodes) {
    if (!isUnitNode(node)) continue;
    const id = node.id;

    const directDeps = dependents.get(id)?.size ?? (node.call_graph?.called_by?.length || 0);
    const transitiveDeps = transitiveDependentCount(id);
    const flows = flowCount.get(id) || 0;
    const shared = sharedStateReaders.get(id);
    const sharedReaderCount = shared?.readers.size || 0;
    const sharedEntities = shared ? Array.from(shared.entities) : [];
    const crossDeployableReaders = shared?.crossDeployable.size || 0;
    const isCrossRepo = crossRepoNodes.has(id);
    const reqCount = runtimeByNode.get(id);






    const fanInSig = saturate(directDeps, 4);
    const blastSig = saturate(transitiveDeps, 12);
    const centralitySig = percentileOf(transitiveDeps);
    const flowSig = saturate(flows, 3);


    const outputSig = saturate(directDeps, 6);
    const stateSig = saturate(sharedReaderCount, 2);
    const constraintSig = saturate(constraintOwners.get(id) || 0, 2);
    const integrationSig = exitOwners.has(id) ? saturate(directDeps + 1, 6) : 0;
    const logicSig = saturate(directDeps, 8);
    const facets: FacetEntrenchment = {
      output: round(outputSig),
      state_changes: round(stateSig),
      constraints: round(constraintSig),
      integrations: round(integrationSig),
      logic: round(logicSig),
    };

    const crossBoundarySig = Math.max(
      isCrossRepo ? 0.9 : 0,
      crossDeployableReaders > 0 ? saturate(crossDeployableReaders, 1) : 0,
    );
    const runtimeSig = reqCount ? saturate(reqCount, 500) : 0;





    const score = clamp01(
      fanInSig * 0.27 +
      blastSig * 0.24 +
      centralitySig * 0.13 +
      flowSig * 0.11 +
      stateSig * 0.11 +
      constraintSig * 0.02 +
      integrationSig * 0.02 +
      crossBoundarySig * 0.06 +
      runtimeSig * 0.04,
    );


    const evidence: string[] = [];
    if (directDeps > 0) evidence.push(`${formatCount(directDeps)} dependent${directDeps === 1 ? '' : 's'}`);
    if (transitiveDeps > directDeps) evidence.push(`${formatCount(transitiveDeps)} in blast radius`);
    if (sharedReaderCount > 0) {
      const ent = sharedEntities.slice(0, 2).join(', ');
      evidence.push(`writes ${ent}${sharedEntities.length > 2 ? '…' : ''} read by ${sharedReaderCount} module${sharedReaderCount === 1 ? '' : 's'}`);
    }
    if (flows > 0) evidence.push(`in ${flows} flow${flows === 1 ? '' : 's'}`);
    if (exitOwners.has(id)) evidence.push('integration seam');
    if ((constraintOwners.get(id) || 0) > 0) evidence.push('enforces a guard/constraint');
    if (isCrossRepo) evidence.push('contract consumed cross-repo');
    if (crossDeployableReaders > 0) evidence.push(`shared state across ${crossDeployableReaders} deployable${crossDeployableReaders === 1 ? '' : 's'}`);
    if (reqCount) evidence.push(`${formatCount(reqCount)} req observed`);
    if (evidence.length === 0) evidence.push('no dependents — leaf');

    const level = scoreToLevel(score, {
      isCrossRepo,
      transitiveDeps,
      sharedReaderCount,
      totalUnits,
    });

    nodeResults[id] = {
      node_id: id,
      score: round(score),
      level,
      signals: {
        fan_in: round(fanInSig),
        blast_radius: round(blastSig),
        centrality: round(centralitySig),
        flow_participation: round(flowSig),
        facets,
        cross_boundary: round(crossBoundarySig),
        runtime: round(runtimeSig),
      },
      raw: {
        direct_dependents: directDeps,
        transitive_dependents: transitiveDeps,
        flows,
        shared_state_readers: sharedReaderCount,
        shared_state_entities: sharedEntities,
        cross_repo: isCrossRepo,
        cross_deployable_readers: crossDeployableReaders,
        ...(reqCount !== undefined ? { request_count: reqCount } : {}),
      },
      evidence,
    };
  }

  const summary = buildSummary(nodeResults, byId, nodeFile);
  return { nodes: nodeResults, summary };
}




function scoreToLevel(
  score: number,
  ctx: { isCrossRepo: boolean; transitiveDeps: number; sharedReaderCount: number; totalUnits: number },
): EntrenchmentLevel {




  const systemWide = ctx.transitiveDeps >= Math.min(150, Math.max(20, ctx.totalUnits * 0.02));
  if (score >= 0.75 && (ctx.isCrossRepo || systemWide)) return 'bedrock';
  if (score >= 0.6) return 'foundational';
  if (score >= 0.4) return 'load-bearing';
  if (score >= 0.2) return 'connected';
  if (score > 0.05) return 'peripheral';
  return 'leaf';
}

function buildSummary(
  nodeResults: Record<string, NodeEntrenchment>,
  byId: Map<string, CASNode>,
  nodeFile: Map<string, string>,
): EntrenchmentSummary {
  const all = Object.values(nodeResults);
  const distribution = emptyDistribution();
  for (const n of all) distribution[n.level]++;




  const scores = all.map(n => n.score).sort((a, b) => a - b);
  const avg = scores.length ? scores.reduce((s, v) => s + v, 0) / scores.length : 0;
  const p90 = scores.length ? scores[Math.floor(scores.length * 0.9)] : 0;
  const repoScore = round(avg * 0.5 + p90 * 0.5);
  const repoLevel = scoreToLevel(repoScore, { isCrossRepo: false, transitiveDeps: 0, sharedReaderCount: 0, totalUnits: 1 });


  const bedrock = all
    .filter(n => LEVEL_ORDER.indexOf(n.level) >= LEVEL_ORDER.indexOf('load-bearing'))
    .sort((a, b) => b.score - a.score)
    .map(n => {
      const node = byId.get(n.node_id);
      return {
        node_id: n.node_id,
        name: node?.name || n.node_id,
        file: node?.source?.file,
        score: n.score,
        level: n.level,
        evidence: n.evidence,
      };
    });


  const byFile = new Map<string, NodeEntrenchment[]>();
  for (const n of all) {
    const f = nodeFile.get(n.node_id);
    if (!f) continue;
    (byFile.get(f) || byFile.set(f, []).get(f)!).push(n);
  }
  const files: FileEntrenchment[] = Array.from(byFile.entries()).map(([file, ns]) => {
    const top = ns.reduce((a, b) => (b.score > a.score ? b : a));
    const avgF = ns.reduce((s, v) => s + v.score, 0) / ns.length;


    const fscore = round(Math.min(1, top.score * 0.7 + avgF * 0.3 + Math.min(0.1, (ns.filter(x => x.score >= 0.4).length - 1) * 0.02)));
    return {
      file,
      score: fscore,
      level: scoreToLevel(fscore, { isCrossRepo: false, transitiveDeps: 0, sharedReaderCount: 0, totalUnits: 1 }),
      node_count: ns.length,
      bedrock_nodes: ns.filter(x => LEVEL_ORDER.indexOf(x.level) >= LEVEL_ORDER.indexOf('load-bearing')).length,
      top_node: top.node_id,
    };
  }).sort((a, b) => b.score - a.score);


  const byModule = new Map<string, FileEntrenchment[]>();
  for (const f of files) {
    const m = moduleForFile(f.file);
    (byModule.get(m) || byModule.set(m, []).get(m)!).push(f);
  }
  const modules: ModuleEntrenchment[] = Array.from(byModule.entries()).map(([module, fs]) => {
    const top = fs.reduce((a, b) => (b.score > a.score ? b : a));
    const avgM = fs.reduce((s, v) => s + v.score, 0) / fs.length;
    const mscore = round(Math.min(1, top.score * 0.6 + avgM * 0.4));
    return {
      module,
      score: mscore,
      level: scoreToLevel(mscore, { isCrossRepo: false, transitiveDeps: 0, sharedReaderCount: 0, totalUnits: 1 }),
      file_count: fs.length,
    };
  }).sort((a, b) => b.score - a.score);

  return {
    contract_model: ENTRENCHMENT_CONTRACT_MODEL,
    distribution,
    repo_score: repoScore,
    repo_level: repoLevel,
    bedrock,
    files,
    modules,
    counts: { nodes_scored: all.length, files: byFile.size, modules: byModule.size },
  };
}

function emptyDistribution(): Record<EntrenchmentLevel, number> {
  return { leaf: 0, peripheral: 0, connected: 0, 'load-bearing': 0, foundational: 0, bedrock: 0 };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
