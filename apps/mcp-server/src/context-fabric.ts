


















import type {
  CASOutput,
  CASProductMapDeployableTopology,
} from '../../../packages/analyzer-core/src/types/cas.types';
import { partitionTasks, type PartitionCas, type PartitionTask } from './coordination/partitioner';
import type { WorkClaim } from './coordination/types';
import type { CrossCodebaseSystemGraph } from './cross-codebase-analysis';
import type { CoChangeIndex } from '../../../packages/analyzer-core/src/analyzer/core/co-change-index';





export interface CommunicationSeamSummary {

  counts: { sync: number; async: number; passive: number; total: number };

  headline: string;

  level: 'node' | 'deployable' | 'workspace';

  top_edges: Array<{
    source: string;
    target: string;
    modalities: string[];
    total: number;
  }>;
  detail_tool: 'get_communication_seams' | 'get_product_map';
}







export function buildCommunicationSeamSummary(
  cas: CASOutput,
  opts: { maxEdges?: number } = {},
): CommunicationSeamSummary | undefined {
  const seams = cas.communication_seams;
  if (!seams) return undefined;
  const inventory = seams.deployable_inventory && seams.deployable_inventory.counts.total > 0
    ? seams.deployable_inventory
    : seams.inventory;
  if (!inventory || inventory.counts.total === 0) return undefined;

  const maxEdges = opts.maxEdges ?? 3;
  const topEdges = [...(inventory.component_seams || [])]
    .sort((a, b) => b.total - a.total)
    .slice(0, maxEdges)
    .map(edge => ({
      source: edge.source,
      target: edge.target,
      modalities: edge.modalities,
      total: edge.total,
    }));

  const { sync, async, passive, total } = inventory.counts;
  return {
    counts: { sync, async, passive, total },
    headline: `${sync} sync / ${async} async / ${passive} passive`,
    level: inventory.level,
    top_edges: topEdges,
    detail_tool: 'get_communication_seams',
  };
}





export interface ConsistencyFlags {

  eventual_consistency_present: boolean;
  counts: {
    strong_stores: number;
    eventual_stores: number;
    tunable_stores: number;
    passive_replica: number;
    passive_streaming: number;
  };

  flags: string[];
  detail_tool: 'get_product_map';
}







export function buildConsistencyFlags(cas: CASOutput): ConsistencyFlags | undefined {
  const model = cas.consistency_model;
  if (!model) return undefined;
  const c = model.counts;
  const eventualPresent =
    c.eventual_stores > 0 || c.tunable_stores > 0 ||
    c.passive_replica > 0 || c.passive_streaming > 0;
  if (!eventualPresent) return undefined;

  const flags: string[] = [];
  if (c.eventual_stores > 0) flags.push(`${c.eventual_stores} eventual store(s) (staleness risk on reads)`);
  if (c.tunable_stores > 0) flags.push(`${c.tunable_stores} tunable store(s) (default consistency may read stale)`);
  if (c.passive_replica > 0) flags.push(`${c.passive_replica} read-replica seam(s) (replica lag)`);
  if (c.passive_streaming > 0) flags.push(`${c.passive_streaming} streaming/CDC seam(s) (async data propagation)`);

  return {
    eventual_consistency_present: true,
    counts: {
      strong_stores: c.strong_stores,
      eventual_stores: c.eventual_stores,
      tunable_stores: c.tunable_stores,
      passive_replica: c.passive_replica,
      passive_streaming: c.passive_streaming,
    },
    flags,
    detail_tool: 'get_product_map',
  };
}





export interface BundledDeployable {
  name: string;
  kind: string;

  bundles: string[];

  entrypoint_member?: string;
  ports?: number[];
}















function isPlausibleMember(token: string): boolean {
  const t = token.trim();
  if (t.length < 3) return false;

  if (/[a-z0-9._-]+:[a-z0-9._-]+/i.test(t)) return false;
  if (/\b(alpine|debian|ubuntu|distroless|scratch|buster|bookworm|slim)\b/i.test(t)) return false;
  if (/^(dumb-init|tini|bash|sh|node|npm|yarn|pnpm|git|curl|wget)$/i.test(t)) return false;

  if (/[.,;:]$/.test(t)) return false;

  if (/-(api|service|worker|web|app|server|client|gateway|fn|lambda|job)\b/i.test(t)) return true;

  if (t.includes('/')) return true;

  return false;
}

function cleanShipMembers(shipsPaths: string[] | undefined): string[] {
  if (!shipsPaths?.length) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of shipsPaths) {
    if (!isPlausibleMember(p)) continue;
    const key = p.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out.slice(0, 6);
}

export function buildBundledDeployables(
  cas: CASOutput,
  opts: { limit?: number; onlyBundled?: boolean } = {},
): BundledDeployable[] | undefined {
  const evidence = cas.deployable_evidence;
  if (!evidence || evidence.length === 0) return undefined;

  const limit = opts.limit ?? 8;
  const units: BundledDeployable[] = evidence
    .filter(e => (opts.onlyBundled ? (e.ships_paths?.length ?? 0) > 0 : true))
    .map(e => {
      const bundles = cleanShipMembers(e.ships_paths);
      return {
        name: e.name,
        kind: e.kind,
        bundles,
        ...(e.entrypoint_member && isPlausibleMember(e.entrypoint_member) ? { entrypoint_member: e.entrypoint_member } : {}),
        ...(e.ports && e.ports.length ? { ports: e.ports } : {}),
      };
    });


  units.sort((a, b) => (b.bundles.length - a.bundles.length));
  const trimmed = units.slice(0, limit);
  return trimmed.length ? trimmed : undefined;
}





export interface RuntimeTopologySummary {
  edge_count: number;
  deployables: Array<{
    name: string;
    exposes?: string[];
    routes_count?: number;
    databases?: string[];
    channels?: string[];
    depends_on?: string[];
  }>;
  detail_tool: 'get_product_map';
}

function compactTopoDeployable(d: CASProductMapDeployableTopology) {
  const out: RuntimeTopologySummary['deployables'][number] = { name: d.name };
  if (d.exposes?.length) out.exposes = d.exposes.slice(0, 4);
  if (d.routes?.length) out.routes_count = d.routes.length;
  if (d.databases?.length) out.databases = d.databases.slice(0, 4);
  if (d.channels?.length) out.channels = d.channels.slice(0, 4);
  if (d.depends_on?.length) out.depends_on = d.depends_on.slice(0, 6);
  return out;
}






export function buildRuntimeTopologySummary(
  cas: CASOutput,
  opts: { limit?: number } = {},
): RuntimeTopologySummary | undefined {
  const topo = cas.product_map?.runtime_topology;
  if (!topo || !topo.deployables?.length) return undefined;
  const limit = opts.limit ?? 6;
  return {
    edge_count: topo.edge_count,
    deployables: topo.deployables.slice(0, limit).map(compactTopoDeployable),
    detail_tool: 'get_product_map',
  };
}





export interface SystemFitSummary {

  headline: string;
  entry_points: { total: number; by_type: Record<string, number> };

  deployables?: BundledDeployable[];

  topology?: RuntimeTopologySummary;

  communication_seams?: CommunicationSeamSummary;

  consistency?: ConsistencyFlags;
  detail_tools: string[];
}

















export function buildSystemFitSummary(cas: CASOutput): SystemFitSummary | undefined {
  const deployables = buildBundledDeployables(cas, { limit: 6 });
  const topology = buildRuntimeTopologySummary(cas);
  const seams = buildCommunicationSeamSummary(cas);
  const consistency = buildConsistencyFlags(cas);


  if (!deployables && !topology && !seams && !consistency) return undefined;

  const entryTotal = cas.entry_points?.length || 0;
  const byType: Record<string, number> = {};
  for (const ep of cas.entry_points || []) byType[ep.type] = (byType[ep.type] || 0) + 1;


  const parts: string[] = [`${entryTotal} entry point(s)`];
  if (deployables) {
    const bundled = deployables.find(d => d.bundles.length > 0);
    parts.push(bundled
      ? `${deployables.length} deployable(s) (e.g. ${bundled.name} bundles ${bundled.bundles.join(', ')})`
      : `${deployables.length} deployable(s)`);
  }
  if (topology) parts.push(`${topology.deployables.length} in infra topology`);
  if (seams) parts.push(`seams ${seams.headline}`);
  if (consistency) parts.push('eventual-consistency risk present');

  const detailTools = new Set<string>();
  if (seams) detailTools.add('get_communication_seams');
  if (topology || consistency || deployables) detailTools.add('get_product_map');

  return {
    headline: parts.join(' -> '),
    entry_points: { total: entryTotal, by_type: byType },
    ...(deployables ? { deployables } : {}),
    ...(topology ? { topology } : {}),
    ...(seams ? { communication_seams: seams } : {}),
    ...(consistency ? { consistency } : {}),
    detail_tools: [...detailTools],
  };
}


















































































export interface AdvisoryOverlapFinding {

  agent_id: string;
  claim_id: string;
  intent: string;


  overlapping_paths: string[];

  overlapping_symbols: string[];















  reason: 'path' | 'symbol' | 'blast-radius' | 'cross-repo-shared-code' | 'cross-repo-contract' | 'predicted-co-change';





  prediction?: { probability: number; support: number; file_a: string; file_b: string };


  cas_derived: boolean;



  was_derived: boolean;



  shared_surface?: string[];
}


export interface AdvisoryClaimProposal {
  agent_id: string;
  paths?: string[];
  symbols?: string[];
}

export interface AdvisoryOverlapOptions {




  includeBlastRadius?: boolean;



  limit?: number;




  coChangeThreshold?: number;
}

const REASON_RANK: Record<AdvisoryOverlapFinding['reason'], number> = {
  'cross-repo-contract': 0,
  'cross-repo-shared-code': 1,
  symbol: 2,
  'blast-radius': 3,
  path: 4,
  'predicted-co-change': 5,
};
















export function computeAdvisoryOverlap(
  proposal: AdvisoryClaimProposal,
  activeClaims: WorkClaim[],
  cas: PartitionCas | undefined,
  opts: AdvisoryOverlapOptions = {},
  was?: CrossCodebaseSystemGraph | undefined,
  coChangeIndex?: CoChangeIndex | undefined,
): AdvisoryOverlapFinding[] {
  const others = activeClaims.filter(
    (c) => c.status === 'active' && c.agent_id !== proposal.agent_id,
  );
  if (others.length === 0) return [];

  const byClaimId = new Map<string, WorkClaim>();
  for (const claim of others) {
    if (!byClaimId.has(claim.claim_id)) byClaimId.set(claim.claim_id, claim);
  }



  const findingsByClaim = new Map<string, AdvisoryOverlapFinding>();
  const record = (f: AdvisoryOverlapFinding) => {



    const existing = findingsByClaim.get(f.claim_id);
    if (!existing) {
      findingsByClaim.set(f.claim_id, f);
      return;
    }
    const merged: AdvisoryOverlapFinding =
      REASON_RANK[f.reason] < REASON_RANK[existing.reason] ? { ...f } : { ...existing };
    merged.overlapping_paths = [...new Set([...existing.overlapping_paths, ...f.overlapping_paths])];
    merged.overlapping_symbols = [...new Set([...existing.overlapping_symbols, ...f.overlapping_symbols])];
    merged.cas_derived = existing.cas_derived || f.cas_derived;
    merged.was_derived = existing.was_derived || f.was_derived;
    const surface = [...(existing.shared_surface ?? []), ...(f.shared_surface ?? [])];
    if (surface.length) merged.shared_surface = [...new Set(surface)];
    findingsByClaim.set(f.claim_id, merged);
  };


  try {
    const PROPOSAL_ID = '__advisory_proposal__';
    const tasks: PartitionTask[] = [
      {
        id: PROPOSAL_ID,
        intent: 'advisory overlap probe',
        target_symbols: proposal.symbols ?? [],
        target_paths: proposal.paths ?? [],
      },
    ];
    for (const claim of byClaimId.values()) {
      tasks.push({
        id: claim.claim_id,
        intent: claim.intent,
        target_symbols: claim.scope.symbols ?? [],
        target_paths: claim.scope.paths ?? [],
      });
    }




    const partitionCas: PartitionCas = cas ?? { nodes: [], edges: [] };
    const includeBlastRadius = opts.includeBlastRadius ?? true;
    const result = partitionTasks(tasks, partitionCas, { includeBlastRadius });

    for (const edge of result.conflict_edges) {
      const otherId = edge.a === PROPOSAL_ID ? edge.b : edge.b === PROPOSAL_ID ? edge.a : undefined;
      if (!otherId) continue;
      const claim = byClaimId.get(otherId);
      if (!claim) continue;
      record({
        agent_id: claim.agent_id,
        claim_id: claim.claim_id,
        intent: claim.intent,
        overlapping_paths: intersectPaths(proposal.paths ?? [], claim.scope.paths ?? []),
        overlapping_symbols: intersectExact(proposal.symbols ?? [], claim.scope.symbols ?? []),
        reason: edge.reason,
        cas_derived: edge.reason === 'blast-radius' || edge.reason === 'symbol',
        was_derived: false,
      });
    }
  } catch {

  }


  if (was) {
    try {
      for (const f of computeCrossRepoOverlap(proposal, [...byClaimId.values()], was)) {
        record(f);
      }
    } catch {

    }
  }


  if (coChangeIndex) {
    try {
      for (const f of computePredictedCoChangeOverlap(proposal, [...byClaimId.values()], coChangeIndex, opts.coChangeThreshold ?? 0.5)) {
        record(f);
      }
    } catch {

    }
  }

  const findings = [...findingsByClaim.values()];
  findings.sort((a, b) => REASON_RANK[a.reason] - REASON_RANK[b.reason]);
  const limit = opts.limit ?? 25;
  return findings.slice(0, limit);
}





















function computeCrossRepoOverlap(
  proposal: AdvisoryClaimProposal,
  others: WorkClaim[],
  was: CrossCodebaseSystemGraph,
): AdvisoryOverlapFinding[] {
  const out: AdvisoryOverlapFinding[] = [];
  const proposalSyms = new Set(proposal.symbols ?? []);
  const proposalPaths = proposal.paths ?? [];




  const claimTouches = (claim: WorkClaim | AdvisoryClaimProposal, token: string): boolean => {
    if (!token) return false;
    const syms = 'symbols' in claim ? (claim.symbols ?? []) : (claim as WorkClaim).scope.symbols ?? [];
    if (syms.includes(token)) return true;
    const paths = 'symbols' in claim ? (claim.paths ?? []) : (claim as WorkClaim).scope.paths ?? [];
    return paths.some((p) => p === token || p.includes(token) || token.includes(p));
  };
  const proposalTouches = (token: string) =>
    proposalSyms.has(token) || proposalPaths.some((p) => p === token || p.includes(token) || token.includes(p));


  for (const rollup of was.shared_code_rollup ?? []) {

    const surfaceSymbols = new Set<string>([
      ...(rollup.consumed_surface ?? []),
      ...((rollup.blast_radius ?? []).map((b) => b.symbol)),
    ]);
    const libTokens = [rollup.lib_name, rollup.path_hint].filter(Boolean) as string[];



    const proposalHitsSymbols = [...surfaceSymbols].filter((s) => proposalTouches(s));
    const proposalHitsLib = libTokens.some((t) => proposalTouches(t));
    if (proposalHitsSymbols.length === 0 && !proposalHitsLib) continue;

    for (const claim of others) {


      const claimHitsSymbols = [...surfaceSymbols].filter((s) => claimTouches(claim, s));
      const claimHitsLib = libTokens.some((t) => claimTouches(claim, t));
      if (claimHitsSymbols.length === 0 && !claimHitsLib) continue;

      const shared = [...new Set([...proposalHitsSymbols, ...claimHitsSymbols, ...(proposalHitsLib || claimHitsLib ? [rollup.lib_name] : [])])].filter(Boolean);
      out.push({
        agent_id: claim.agent_id,
        claim_id: claim.claim_id,
        intent: claim.intent,
        overlapping_paths: [],
        overlapping_symbols: intersectExact(proposalHitsSymbols, claimHitsSymbols),
        reason: 'cross-repo-shared-code',
        cas_derived: false,
        was_derived: true,
        shared_surface: shared,
      });
    }
  }


  const interfaceById = new Map<string, (typeof was.interfaces)[number]>();
  for (const iface of was.interfaces ?? []) interfaceById.set(iface.id, iface);

  const interfaceTokens = (ifaceId: string): string[] => {
    const iface = interfaceById.get(ifaceId);
    if (!iface) return [];
    const toks: string[] = [];
    for (const r of iface.refs ?? []) {
      if (r.name) toks.push(r.name);
      if (r.file) toks.push(r.file);
    }
    for (const t of [iface.endpoint, iface.topic, iface.resource, iface.name, iface.key]) {
      if (t) toks.push(t);
    }
    return [...new Set(toks)];
  };

  for (const link of was.links ?? []) {
    const srcTokens = interfaceTokens(link.source_interface_id);
    const dstTokens = interfaceTokens(link.target_interface_id);
    if (srcTokens.length === 0 && dstTokens.length === 0) continue;

    const proposalOnSrc = srcTokens.some((t) => proposalTouches(t));
    const proposalOnDst = dstTokens.some((t) => proposalTouches(t));
    if (!proposalOnSrc && !proposalOnDst) continue;

    for (const claim of others) {
      const claimOnSrc = srcTokens.some((t) => claimTouches(claim, t));
      const claimOnDst = dstTokens.some((t) => claimTouches(claim, t));



      if (!claimOnSrc && !claimOnDst) continue;
      const sameContract = (proposalOnSrc || proposalOnDst) && (claimOnSrc || claimOnDst);
      if (!sameContract) continue;

      const shared = [...new Set([
        ...(proposalOnSrc || claimOnSrc ? srcTokens : []),
        ...(proposalOnDst || claimOnDst ? dstTokens : []),
      ])].slice(0, 8);
      out.push({
        agent_id: claim.agent_id,
        claim_id: claim.claim_id,
        intent: claim.intent,
        overlapping_paths: [],
        overlapping_symbols: [],
        reason: 'cross-repo-contract',
        cas_derived: false,
        was_derived: true,
        shared_surface: [`${link.kind}:${link.id}`, ...shared],
      });
    }
  }

  return out;
}

















function computePredictedCoChangeOverlap(
  proposal: AdvisoryClaimProposal,
  others: WorkClaim[],
  coChangeIndex: CoChangeIndex,
  threshold: number,
): AdvisoryOverlapFinding[] {
  const out: AdvisoryOverlapFinding[] = [];
  const proposalPaths = proposal.paths ?? [];
  if (proposalPaths.length === 0) return out;

  const bestPartnerAbove = (file: string, candidates: string[]): { file: string; probability: number; support: number } | undefined => {
    let best: { file: string; probability: number; support: number } | undefined;
    for (const partner of coChangeIndex[file] ?? []) {
      if (partner.probability < threshold) continue;
      if (!candidates.includes(partner.file)) continue;
      if (!best || partner.probability > best.probability) {
        best = { file: partner.file, probability: partner.probability, support: partner.support };
      }
    }
    return best;
  };

  for (const claim of others) {
    const claimPaths = claim.scope.paths ?? [];
    if (claimPaths.length === 0) continue;

    let best: { fileA: string; fileB: string; probability: number; support: number } | undefined;


    for (const pFile of proposalPaths) {
      const hit = bestPartnerAbove(pFile, claimPaths);
      if (hit && (!best || hit.probability > best.probability)) {
        best = { fileA: pFile, fileB: hit.file, probability: hit.probability, support: hit.support };
      }
    }

    for (const cFile of claimPaths) {
      const hit = bestPartnerAbove(cFile, proposalPaths);
      if (hit && (!best || hit.probability > best.probability)) {
        best = { fileA: cFile, fileB: hit.file, probability: hit.probability, support: hit.support };
      }
    }

    if (!best) continue;
    out.push({
      agent_id: claim.agent_id,
      claim_id: claim.claim_id,
      intent: claim.intent,
      overlapping_paths: [],
      overlapping_symbols: [],
      reason: 'predicted-co-change',
      cas_derived: false,
      was_derived: false,
      prediction: { probability: best.probability, support: best.support, file_a: best.fileA, file_b: best.fileB },
    });
  }

  return out;
}



function intersectPaths(a: string[], b: string[]): string[] {
  const out = new Set<string>();
  for (const p of a) {
    const np = p.replace(/\/+$/, '');
    for (const q of b) {
      const nq = q.replace(/\/+$/, '');
      if (np === nq || np.startsWith(nq + '/') || nq.startsWith(np + '/')) out.add(nq);
    }
  }
  return [...out];
}


function intersectExact(a: string[], b: string[]): string[] {
  const setB = new Set(b);
  return [...new Set(a.filter((x) => setB.has(x)))];
}
