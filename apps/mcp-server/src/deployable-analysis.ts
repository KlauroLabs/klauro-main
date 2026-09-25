import type {
  CASOutput,
  CASNode,
  CASExitPoint,
  CASDataEntity,
  CASEntityLineage,
  CASFlowGraph,
  FlowConcept,
  SystemCapability,
  DeployableEvidence,
} from '../../../packages/analyzer-core/src/types/cas.types';
import {
  buildDeployableRootEntries,
  matchDeployableRoot,
  extractEntryPointFilePath,
  type DeployableRoot,
} from '../../../packages/analyzer-core/src/analyzer/core/entry-point-deployable';
import { reachabilityEdgePairs } from '../../../packages/analyzer-core/src/analyzer/core/reachability-index';
import { assertValidCasTree } from '../../../packages/analyzer-core/src/analyzer/core/recursive-cas';
import { buildCasTerminality } from '../../../packages/analyzer-core/src/analyzer/core/terminality';
import { linkedCapabilities, partBornAt } from './engine-part';
import { deployableAnalysisCache } from './deployable-analysis-cache';
import { projectCasChild, type CASChildProjectedValues } from './cas-child-projection';













function isTier1ShipDeclaration(e: DeployableEvidence): boolean {
  return e.tier === 1;
}
























function isBuildTargetDeclaration(e: DeployableEvidence): boolean {
  return e.tier === 2 && e.kind === 'bin';
}






function normalizeShipToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.(exe|msi|dmg|pkg|deb|rpm|appimage)$/i, '')
    .replace(/[\s_-]+/g, '');
}




















function dedupeBuildTargetIdentities(units: DeployableEvidence[]): DeployableEvidence[] {
  const groups = new Map<string, DeployableEvidence[]>();
  const out: DeployableEvidence[] = [];
  for (const unit of units) {
    if (!isBuildTargetDeclaration(unit)) {
      out.push(unit);
      continue;
    }
    const key = normalizeShipToken(unit.name);
    if (!key) {
      out.push(unit);
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(unit);
  }
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    const ranked = [...group].sort((a, b) => {
      const aFile = evidenceDeclaredFiles(a).length > 0 ? 0 : 1;
      const bFile = evidenceDeclaredFiles(b).length > 0 ? 0 : 1;
      if (aFile !== bFile) return aFile - bFile;
      const aRoot = (a.root_path || '').length;
      const bRoot = (b.root_path || '').length;
      if (aRoot !== bRoot) return bRoot - aRoot;
      return units.indexOf(a) - units.indexOf(b);
    });
    out.push(ranked[0]);
  }


  return out.sort((a, b) => units.indexOf(a) - units.indexOf(b));
}







export function tierQualifiedShipUnits(evidence: DeployableEvidence[] | undefined): DeployableEvidence[] {
  const items = evidence || [];
  const standalone = items.filter(e => !e.bundled_into);
  const qualified = standalone.filter(e => isTier1ShipDeclaration(e) || isBuildTargetDeclaration(e));
  return dedupeBuildTargetIdentities(qualified);
}









const PROMOTION_THRESHOLD = 2;

const SEED_BASIS_SHOWN = 12;

export function shouldPromote(cas: Pick<CASOutput, 'deployable_evidence'>): boolean {
  return tierQualifiedShipUnits(cas.deployable_evidence).length >= PROMOTION_THRESHOLD;
}





function subCasNodeIds(cas: CASOutput, evidence: DeployableEvidence[]): string[] {
  return deployableRootsByEvidenceOrder(evidence).map(root => `${rootCasId(cas)}:${root.deployable_id.replace(/^dep:/, '')}`);
}

function deployableRootsByEvidenceOrder(evidence: DeployableEvidence[]): DeployableRoot[] {
  const rootsByEvidence = new Map(buildDeployableRootEntries(evidence).map(entry => [entry.evidence, entry.root]));
  return evidence.map(item => rootsByEvidence.get(item)!);
}












function bundledMembersOf(unit: DeployableEvidence, allEvidence: DeployableEvidence[]): DeployableEvidence[] {
  return allEvidence.filter(e => e !== unit && e.bundled_into === unit.name);
}
















function shipsPathMembers(
  unit: DeployableEvidence,
  allEvidence: DeployableEvidence[],
  allRoots: DeployableRoot[],
): Array<{ row: DeployableEvidence; root: DeployableRoot }> {









  const tokens = [...(unit.ships_paths || []), ...(unit.entrypoint_member ? [unit.entrypoint_member] : [])]
    .map(normalizeShipToken)
    .filter(Boolean);
  if (!tokens.length) return [];
  const tokenSet = new Set(tokens);
  const members: Array<{ row: DeployableEvidence; root: DeployableRoot }> = [];
  allEvidence.forEach((candidate, idx) => {
    if (candidate === unit || candidate.tier === 1) return;
    const root = allRoots[idx];
    if (!root || !root.rootPath || root.rootPath === '.') return;
    const nameMatches = tokenSet.has(normalizeShipToken(candidate.name));
    const rootBase = root.rootPath.split('/').filter(Boolean).pop() || '';
    const rootBaseMatches = rootBase && tokenSet.has(normalizeShipToken(rootBase));
    if (nameMatches || rootBaseMatches) members.push({ row: candidate, root });
  });
  return members;
}






function unitRoots(
  unit: DeployableEvidence,
  allEvidence: DeployableEvidence[],
  allRoots: DeployableRoot[],
): DeployableRoot[] {
  const idx = allEvidence.indexOf(unit);
  const own = allRoots[idx];
  const members = bundledMembersOf(unit, allEvidence);
  const memberRoots = members.map(m => allRoots[allEvidence.indexOf(m)]).filter(Boolean) as DeployableRoot[];


















  const shipsRoots = shipsPathMembers(unit, allEvidence, allRoots).map(m => m.root);
  const concreteMemberRoots = [...memberRoots, ...shipsRoots].filter(r => r.rootPath && r.rootPath !== '.');
  if (own && own.rootPath === '.' && concreteMemberRoots.length > 0) {
    return concreteMemberRoots;
  }
  return own ? [own, ...memberRoots] : memberRoots;
}

function exitPointFile(exit: CASExitPoint, nodesById: Map<string, CASNode>): string | undefined {
  return (exit.metadata as any)?.file || nodesById.get(exit.source_node)?.source?.file;
}

function normalizeEvidencePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}









const DECLARED_ENTRY_FILE_PATTERNS: RegExp[] = [
  /^src\/bin entry:\s*(\S.*)$/,
  /^src\/main\.rs present, no \[\[bin\]\] override\s*\((.+)\)$/,
  /^package main entry:\s*(\S.*)$/,
  /^HTTP entry point:.*\(([^()]+?)(?::\d+)?\)$/,
];


function evidenceDeclaredFiles(unit: DeployableEvidence): string[] {
  const out = (unit.entry_files || []).map(normalizeEvidencePath);
  for (const line of unit.evidence || []) {
    for (const pattern of DECLARED_ENTRY_FILE_PATTERNS) {
      const match = line.match(pattern);
      if (match?.[1]) {
        out.push(normalizeEvidencePath(match[1]));
        break;
      }
    }
  }
  return [...new Set(out)];
}







function identityTwins(unit: DeployableEvidence, allEvidence: DeployableEvidence[]): DeployableEvidence[] {
  const key = normalizeShipToken(unit.name);
  if (!key) return [];
  return allEvidence.filter(e => e !== unit && e.tier !== 1 && normalizeShipToken(e.name) === key);
}



interface CasSliceContext {
  nodesById: Map<string, CASNode>;
  nodeIdsByFile: Map<string, string[]>;




  filesBySuffixKey: Map<string, string[]>;
  targetsBySource: Map<string, string[]>;
}

const sliceContexts = new WeakMap<CASOutput, CasSliceContext>();






























function sliceContextFor(cas: CASOutput): CasSliceContext {
  const cached = sliceContexts.get(cas);
  if (cached) return cached;

  const nodes = cas.nodes || [];
  const nodesById = new Map(nodes.map(n => [n.id, n]));
  const nodeIdsByFile = new Map<string, string[]>();
  for (const n of nodes) {
    const file = n.source?.file ? normalizeEvidencePath(n.source.file) : undefined;
    if (!file) continue;
    if (!nodeIdsByFile.has(file)) nodeIdsByFile.set(file, []);
    nodeIdsByFile.get(file)!.push(n.id);
  }
  const filesBySuffixKey = new Map<string, string[]>();
  for (const file of nodeIdsByFile.keys()) {
    const segments = file.split('/');




    for (let i = 1; i < segments.length; i++) {
      const key = segments.slice(i).join('/');
      if (!filesBySuffixKey.has(key)) filesBySuffixKey.set(key, []);
      filesBySuffixKey.get(key)!.push(file);
    }
  }

  const targetsBySource = new Map<string, string[]>();
  const pairs = reachabilityEdgePairs(cas);
  for (const edge of cas.edges || []) {
    if (['delegates_to', 'branches_to', 'continues_to'].includes(edge.type)) pairs.push([edge.source, edge.target]);
  }
  for (const [source, target] of pairs) {
    const targets = targetsBySource.get(source) || [];
    targets.push(target);
    targetsBySource.set(source, targets);
  }

  const context: CasSliceContext = { nodesById, nodeIdsByFile, filesBySuffixKey, targetsBySource };
  sliceContexts.set(cas, context);
  return context;
}

interface UnitSeed {
  seedNodeIds: Set<string>;



  basis: string[];









  hasDiscriminatingEvidence: boolean;
}






function unitDeclaredFiles(
  unit: DeployableEvidence,
  allEvidence: DeployableEvidence[],
  allRoots: DeployableRoot[],
): string[] {
  return [...new Set([
    ...evidenceDeclaredFiles(unit),
    ...identityTwins(unit, allEvidence).flatMap(evidenceDeclaredFiles),
    ...bundledMembersOf(unit, allEvidence).flatMap(evidenceDeclaredFiles),
    ...shipsPathMembers(unit, allEvidence, allRoots).map(m => m.row).flatMap(evidenceDeclaredFiles),
  ])];
}




function resolveDeclaredFile(declared: string, ctx: CasSliceContext): string[] {
  if (ctx.nodeIdsByFile.has(declared)) return [declared];
  return ctx.filesBySuffixKey.get(declared) || [];
}



























function seedsForUnit(
  unit: DeployableEvidence,
  allEvidence: DeployableEvidence[],
  roots: DeployableRoot[],
  allRoots: DeployableRoot[],
  ctx: CasSliceContext,
): UnitSeed {
  const seedNodeIds = new Set<string>();
  const basis: string[] = [];

  const ownFiles = new Set<string>();
  for (const declared of unitDeclaredFiles(unit, allEvidence, allRoots)) {
    const resolved = resolveDeclaredFile(declared, ctx);
    if (resolved.length === 0) continue;
    for (const file of resolved) {
      ownFiles.add(file);
      for (const id of ctx.nodeIdsByFile.get(file) || []) seedNodeIds.add(id);
    }
    basis.push(`entry-file:${declared}`);
  }

  const siblingFiles: string[] = [];
  for (const sibling of tierQualifiedShipUnits(allEvidence)) {
    if (sibling === unit) continue;
    for (const declared of unitDeclaredFiles(sibling, allEvidence, allRoots)) {
      for (const file of resolveDeclaredFile(declared, ctx)) {
        if (!ownFiles.has(file)) siblingFiles.push(file);
      }
    }
  }

  const concreteRoots = roots.filter(r => r.rootPath && r.rootPath !== '.');





  const discriminatingRoots = ownFiles.size === 0
    ? concreteRoots
    : concreteRoots.filter(root => !siblingFiles.some(file => matchDeployableRoot(file, [root])));














  const ownRootIsRepoRoot = roots.some(r => !r.rootPath || r.rootPath === '.');
  const entryFileAtRepoRoot = [...ownFiles].some(file => !file.includes('/'));
  const admitRepoRoot = ownRootIsRepoRoot
    && discriminatingRoots.length === 0
    && (entryFileAtRepoRoot || ownFiles.size === 0);

  const seedRoots = admitRepoRoot
    ? [...discriminatingRoots, { deployable_id: '', deployable_name: '', rootPath: '.' }]
    : discriminatingRoots;
  if (seedRoots.length > 0) {
    for (const [file, ids] of ctx.nodeIdsByFile) {
      if (!matchDeployableRoot(file, seedRoots)) continue;
      for (const id of ids) seedNodeIds.add(id);
    }
    for (const root of seedRoots) basis.push(`root:${root.rootPath}`);
  }

  if (seedNodeIds.size === 0) basis.push('no-resolvable-seed');




  const hasDiscriminatingEvidence = ownFiles.size > 0 || discriminatingRoots.length > 0;
  return { seedNodeIds, basis, hasDiscriminatingEvidence };
}































function closureForSeeds(seedNodeIds: Set<string>, ctx: CasSliceContext): Set<string> {
  const closure = new Set(seedNodeIds);
  const queue = [...closure];
  const files = new Set<string>();
  const include = (id: string) => {
    if (closure.has(id)) return;
    closure.add(id);
    queue.push(id);
  };
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const id = queue[cursor];
    for (const target of ctx.targetsBySource.get(id) || []) include(target);
    const sourceFile = ctx.nodesById.get(id)?.source?.file;
    if (!sourceFile) continue;
    const file = normalizeEvidencePath(sourceFile);
    if (files.has(file)) continue;
    files.add(file);
    for (const sibling of ctx.nodeIdsByFile.get(file) || []) include(sibling);
  }
  return closure;
}





export type SubCasNodeAttribution = 'exclusive' | 'owned' | 'shared';

interface NodeAttribution {
  attribution: 'exclusive' | 'shared';
  canonicalOwnerIndex: number;
  canonicalOwnerId: string;
  alsoUsedBy: string[];
}






function directOwnerIndex(
  file: string,
  rootsWithOwner: Array<{ root: DeployableRoot; unitIndex: number }>,
): number | undefined {
  let best: { len: number; unitIndex: number } | undefined;
  for (const { root, unitIndex } of rootsWithOwner) {



    if (!root.rootPath || root.rootPath === '.') continue;
    if (matchDeployableRoot(file, [root]) && root.rootPath.length > (best?.len ?? -1)) {
      best = { len: root.rootPath.length, unitIndex };
    }
  }
  return best?.unitIndex;
}

interface UnitReachability {
  index: number;
  id: string;
  name: string;
  reachable: Set<string>;
}











function computeAttribution(
  nodes: CASNode[],
  units: UnitReachability[],
  rootsWithOwner: Array<{ root: DeployableRoot; unitIndex: number }>,
): Map<string, NodeAttribution> {
  const nodesById = new Map(nodes.map(n => [n.id, n]));
  const reachingUnits = new Map<string, number[]>();
  for (const u of units) {
    for (const id of u.reachable) {
      if (!reachingUnits.has(id)) reachingUnits.set(id, []);
      reachingUnits.get(id)!.push(u.index);
    }
  }

  const fileUnitCounts = new Map<string, Map<number, number>>();
  for (const u of units) {
    for (const id of u.reachable) {
      const file = nodesById.get(id)?.source?.file;
      if (!file) continue;
      if (!fileUnitCounts.has(file)) fileUnitCounts.set(file, new Map());
      const m = fileUnitCounts.get(file)!;
      m.set(u.index, (m.get(u.index) || 0) + 1);
    }
  }

  const out = new Map<string, NodeAttribution>();
  for (const [nodeId, unitIdxs] of reachingUnits) {
    if (unitIdxs.length <= 1) {
      const idx = unitIdxs[0];
      out.set(nodeId, { attribution: 'exclusive', canonicalOwnerIndex: idx, canonicalOwnerId: units[idx].id, alsoUsedBy: [] });
      continue;
    }

    const file = nodesById.get(nodeId)?.source?.file;
    let ownerIdx = file ? directOwnerIndex(file, rootsWithOwner) : undefined;
    if (ownerIdx === undefined || !unitIdxs.includes(ownerIdx)) {
      const counts = file ? fileUnitCounts.get(file) : undefined;
      let best = unitIdxs[0];
      let bestCount = -1;
      for (const idx of unitIdxs) {
        const c = counts?.get(idx) ?? 0;
        if (c > bestCount) {
          bestCount = c;
          best = idx;
        }
      }
      ownerIdx = best;
    }

    out.set(nodeId, {
      attribution: 'shared',
      canonicalOwnerIndex: ownerIdx,
      canonicalOwnerId: units[ownerIdx].id,
      alsoUsedBy: unitIdxs.filter(i => i !== ownerIdx).map(i => units[i].id),
    });
  }
  return out;
}





function filterCapabilities(caps: SystemCapability[] | undefined, includedEntryPointIds: Set<string>): SystemCapability[] {
  return (caps || []).filter(cap => (cap.operations || []).some(op => includedEntryPointIds.has(op.entry_point_id)));
}












function scopeCapabilitiesToSlice<T extends SystemCapability>(
  caps: T[],
  includedEntryPointIds: Set<string>,
  survivingFlowIds: Set<string>,
): T[] {
  return caps.map(cap => {
    const operations = (cap.operations || []).filter(op => includedEntryPointIds.has(op.entry_point_id));
    const related = (cap.related_flows || []).filter(ref => survivingFlowIds.has(ref.flow_id));
    return {
      ...cap,
      operations,
      ...(cap.related_flows ? { related_flows: related } : {}),
    };
  });
}


interface ScopedFlowGraph {
  graph: CASFlowGraph | undefined;
  flowIds: Set<string>;
}

function filterFlowGraph(
  flowGraph: CASFlowGraph | undefined,
  includedEntryPointIds: Set<string>,
  reachable: Set<string>,
): ScopedFlowGraph {
  if (!flowGraph) return { graph: undefined, flowIds: new Set() };
  const survivingCaps = (flowGraph.capability_candidates || []).filter(cap =>
    (cap.entry_points || []).some(id => includedEntryPointIds.has(id)));
  const scopedFlowIds = new Set<string>();
  if (survivingCaps.length === 0) return { graph: undefined, flowIds: scopedFlowIds };
  const survivingIds = new Set(survivingCaps.map(c => c.id));
  const graph: CASFlowGraph = {
    capability_candidates: survivingCaps.map(cap => ({
      ...cap,
      entry_points: cap.entry_points.filter(id => includedEntryPointIds.has(id)),
    })),
    dependencies: (flowGraph.dependencies || []).filter(d => survivingIds.has(d.from_capability) && survivingIds.has(d.to_capability)),
    topology: {
      root_capabilities: (flowGraph.topology?.root_capabilities || []).filter(id => survivingIds.has(id)),
      leaf_capabilities: (flowGraph.topology?.leaf_capabilities || []).filter(id => survivingIds.has(id)),
      critical_path: (flowGraph.topology?.critical_path || []).filter(id => survivingIds.has(id)),
      max_depth: flowGraph.topology?.max_depth ?? 0,
    },
    primary_flow: {
      core_capability_id: flowGraph.primary_flow?.core_capability_id ?? '',
      value_chain: (flowGraph.primary_flow?.value_chain || []).filter(id => survivingIds.has(id)),
      supporting_capabilities: (flowGraph.primary_flow?.supporting_capabilities || []).filter(id => survivingIds.has(id)),
      infrastructure_capabilities: (flowGraph.primary_flow?.infrastructure_capabilities || []).filter(id => survivingIds.has(id)),
    },
    layers: (flowGraph.layers || [])
      .map(layer => ({ ...layer, capabilities: layer.capabilities.filter(id => survivingIds.has(id)) }))
      .filter(layer => layer.capabilities.length > 0),
    system_insights: flowGraph.system_insights,
  };
  return { graph, flowIds: scopedFlowIds };
}

function filterDataEntities(entities: CASDataEntity[] | undefined, reachable: Set<string>): CASDataEntity[] {
  return (entities || []).filter(e => {
    const lc = e.lifecycle || { created_by: [], read_by: [], updated_by: [], deleted_by: [] };
    return [...lc.created_by, ...lc.read_by, ...lc.updated_by, ...lc.deleted_by].some(id => reachable.has(id));
  });
}

function filterComprehensionFlows(
  flows: FlowConcept[] | undefined,
  includedEntryPointIds: Set<string>,
  reachable: Set<string>,
): FlowConcept[] {
  return (flows || [])
    .filter(flow => includedEntryPointIds.has(flow.entry_point) || reachable.has(flow.entry_point))
    .map(flow => {
      const steps = flow.steps
        .map(step => ({
          ...step,
          functions: step.functions.filter(fn => reachable.has(fn.function_id)),
          code_mappings: step.code_mappings?.filter(mapping => reachable.has(mapping.code_region.node_id)),
        }))
        .filter(step => step.functions.length > 0);
      const stepIds = new Set(steps.map(step => step.step_id));
      return {
        ...flow,
        steps,
        step_graph: flow.step_graph
          ? { edges: flow.step_graph.edges.filter(edge => stepIds.has(edge.from_step_id) && stepIds.has(edge.to_step_id)) }
          : undefined,
      };
    });
}

function filterDataLineage(lineage: CASEntityLineage[] | undefined, reachableFiles: Set<string>): CASEntityLineage[] {
  return (lineage || []).filter(entity =>
    (entity.writers || []).some(w => w.file && reachableFiles.has(w.file)) ||
    (entity.readers || []).some(r => r.file && reachableFiles.has(r.file)));
}

function intersects<T>(values: T[] | undefined, included: Set<T>): boolean {
  return (values || []).some(value => included.has(value));
}

function filterBehavioralInvariants(
  invariants: CASOutput['behavioral_invariants'],
  reachable: Set<string>,
  entryPoints: Set<string>,
  entities: Set<string>,
  files: Set<string>,
): NonNullable<CASOutput['behavioral_invariants']> {
  return (invariants || [])
    .filter(invariant =>
      intersects(invariant.scope.node_ids, reachable) ||
      intersects(invariant.scope.entry_point_ids, entryPoints) ||
      intersects(invariant.scope.entity_names, entities) ||
      intersects(invariant.scope.file_paths, files) ||
      invariant.enforcement.some(item => Boolean(item.node_id && reachable.has(item.node_id)) || Boolean(item.file && files.has(item.file))) ||
      invariant.evidence.some(item => Boolean(item.id && (reachable.has(item.id) || entryPoints.has(item.id))) || Boolean(item.file && files.has(item.file))),
    )
    .map(invariant => ({
      ...invariant,
      scope: {
        ...invariant.scope,
        node_ids: invariant.scope.node_ids?.filter(id => reachable.has(id)),
        entry_point_ids: invariant.scope.entry_point_ids?.filter(id => entryPoints.has(id)),
        entity_names: invariant.scope.entity_names?.filter(name => entities.has(name)),
        file_paths: invariant.scope.file_paths?.filter(file => files.has(file)),
      },
      enforcement: invariant.enforcement.filter(item =>
        Boolean(item.node_id && reachable.has(item.node_id)) || Boolean(item.file && files.has(item.file)) || (!item.node_id && !item.file),
      ),
      evidence: invariant.evidence.filter(item =>
        Boolean(item.id && (reachable.has(item.id) || entryPoints.has(item.id))) || Boolean(item.file && files.has(item.file)) || (!item.id && !item.file),
      ),
    }));
}

function summarizeBehavioralInvariants(
  invariants: NonNullable<CASOutput['behavioral_invariants']>,
  parent: CASOutput['behavioral_invariant_summary'],
): CASOutput['behavioral_invariant_summary'] {
  if (invariants.length === 0) return undefined;
  const ids = new Set(invariants.map(invariant => invariant.id));
  const byType: Record<string, number> = {};
  const byConfidence: Record<string, number> = {};
  let enforced = 0;
  let inferred = 0;
  let missing = 0;
  for (const invariant of invariants) {
    byType[invariant.invariant_type] = (byType[invariant.invariant_type] || 0) + 1;
    byConfidence[invariant.confidence] = (byConfidence[invariant.confidence] || 0) + 1;
    for (const item of invariant.enforcement) {
      if (item.confidence === 'enforced') enforced += 1;
      else if (item.confidence === 'inferred') inferred += 1;
      else missing += 1;
    }
  }
  const gaps = (parent?.gaps || []).filter(gap => ids.has(gap.invariant_id));
  const byGapSeverity: Record<'high' | 'medium' | 'low', number> = { high: 0, medium: 0, low: 0 };
  for (const gap of gaps) byGapSeverity[gap.severity] += 1;
  return { total: invariants.length, by_type: byType, by_confidence: byConfidence, by_gap_severity: byGapSeverity, enforced, inferred, missing, gaps };
}

function filterSecurityBoundaries(
  boundaries: CASOutput['security_boundaries'],
  reachable: Set<string>,
): NonNullable<CASOutput['security_boundaries']> {
  return (boundaries || [])
    .map(boundary => ({ ...boundary, enforcement_points: boundary.enforcement_points.filter(point => reachable.has(point.node_id)) }))
    .filter(boundary => boundary.enforcement_points.length > 0);
}

function summarizeSecurityBoundaries(
  boundaries: NonNullable<CASOutput['security_boundaries']>,
): CASOutput['security_summary'] {
  if (boundaries.length === 0) return undefined;
  const counts = { enforced: 0, assumed: 0, missing: 0 };
  const unprotected = new Set<string>();
  for (const boundary of boundaries) {
    for (const point of boundary.enforcement_points) counts[point.confidence] += 1;
    if (boundary.enforcement_points.some(point => point.confidence === 'missing')) {
      for (const operation of boundary.sensitive_operations) unprotected.add(operation);
    }
  }
  return { boundaries, unprotected_sensitive_ops: [...unprotected], assumed_vs_enforced: counts };
}

function filterFlowCoverage(
  coverage: CASOutput['flow_coverage'],
  reachable: Set<string>,
  callChains: Set<string>,
): NonNullable<CASOutput['flow_coverage']> {
  return (coverage || [])
    .filter(item => callChains.has(item.call_chain_id) || item.tested_segments.some(segment => reachable.has(segment.node_id)) || item.untested_segments.some(segment => reachable.has(segment.node_id)))
    .map(item => ({
      ...item,
      tested_segments: item.tested_segments.filter(segment => reachable.has(segment.node_id)),
      untested_segments: item.untested_segments.filter(segment => reachable.has(segment.node_id)),
    }));
}

function filterTestSuites(
  suites: CASOutput['test_suites'],
  reachable: Set<string>,
  files: Set<string>,
): NonNullable<CASOutput['test_suites']> {
  return (suites || [])
    .filter(suite => files.has(suite.file_path) || intersects(suite.coverage?.nodes_tested, reachable) || suite.tests.some(testCase => intersects(testCase.targets, reachable)))
    .map(suite => ({
      ...suite,
      tests: suite.tests.filter(testCase => intersects(testCase.targets, reachable) || Boolean(testCase.source?.file && files.has(testCase.source.file))),
      coverage: suite.coverage ? { ...suite.coverage, nodes_tested: suite.coverage.nodes_tested.filter(id => reachable.has(id)) } : undefined,
    }));
}

function filterIdiomViolations(
  violations: CASOutput['idiom_violations'],
  reachable: Set<string>,
  files: Set<string>,
): NonNullable<CASOutput['idiom_violations']> {
  return (violations || []).filter(violation =>
    Boolean(violation.node_id && reachable.has(violation.node_id)) || Boolean(violation.file && files.has(violation.file)),
  );
}

function scopedModuleHealth(moduleHealth: CASOutput['module_health'], files: Set<string>): CASOutput['module_health'] {
  if (!moduleHealth) return undefined;
  const fileStats = moduleHealth.file_stats.filter(stat => files.has(stat.file));
  if (fileStats.length === 0) return undefined;
  const findings = moduleHealth.findings.filter(finding => files.has(finding.file));
  const totalLines = fileStats.reduce((sum, stat) => sum + stat.lines, 0);
  const totalCommits = fileStats.reduce((sum, stat) => sum + stat.commits_90d, 0);
  const sizeFiles = new Set(findings.filter(finding => finding.kind === 'size-outlier').map(finding => finding.file));
  const churnFiles = new Set(findings.filter(finding => finding.kind === 'change-concentration').map(finding => finding.file));
  return {
    ...moduleHealth,
    files_analyzed: fileStats.length,
    total_lines: totalLines,
    total_commits_90d: totalCommits,
    findings,
    file_stats: fileStats,
    concentration: {
      size_outlier_file_count: sizeFiles.size,
      size_outlier_share_of_lines: totalLines === 0 ? 0 : fileStats.filter(stat => sizeFiles.has(stat.file)).reduce((sum, stat) => sum + stat.lines, 0) / totalLines,
      churn_outlier_file_count: churnFiles.size,
      churn_outlier_share_of_commits: totalCommits === 0 ? 0 : fileStats.filter(stat => churnFiles.has(stat.file)).reduce((sum, stat) => sum + stat.commits_90d, 0) / totalCommits,
    },
  };
}







function filterCommunicationSeams(
  seams: CASOutput['communication_seams'],
  includedEntryPointIds: Set<string>,
  includedExitPointIds: Set<string>,
  includedEntityIds: Set<string>,
): CASOutput['communication_seams'] {
  if (!seams) return undefined;
  const kept = seams.seams.filter(s => {
    const meta = s.metadata || {};
    if (typeof meta.exit_point === 'string') return includedExitPointIds.has(meta.exit_point);
    if (typeof meta.entry_point === 'string') return includedEntryPointIds.has(meta.entry_point);
    if (typeof meta.entity_id === 'string') return includedEntityIds.has(meta.entity_id);
    return false;
  });
  if (kept.length === 0) return undefined;

  const counts = { sync: 0, async: 0, passive: 0, total: 0 };
  const byEdge = new Map<string, { source: string; target: string; sync: number; async: number; passive: number }>();
  for (const s of kept) {
    counts[s.modality] += 1;
    counts.total += 1;
    const key = `${s.source}=>${s.target}`;
    if (!byEdge.has(key)) byEdge.set(key, { source: s.source, target: s.target, sync: 0, async: 0, passive: 0 });
    byEdge.get(key)![s.modality] += 1;
  }
  const component_seams = Array.from(byEdge.values())
    .map(e => {
      const modalities: Array<'sync' | 'async' | 'passive'> = [];
      if (e.sync > 0) modalities.push('sync');
      if (e.async > 0) modalities.push('async');
      if (e.passive > 0) modalities.push('passive');
      return { ...e, modalities, total: e.sync + e.async + e.passive };
    })
    .sort((a, b) => b.total - a.total || a.source.localeCompare(b.source));

  return { seams: kept, inventory: { level: 'node', counts, component_seams } };
}





export interface SubCasNodeIndexEntry {


  id: string;
  name: string;
  root_path: string;
  member_root_paths: string[];
  tier: 1 | 2 | 3;
  kind: DeployableEvidence['kind'];



  node_count: number;
  size_disclosure?: {
    edge_count: number;
    root_node_ratio: number;
    root_edge_ratio: number;
    large_scope_threshold: number;
    large_scope: boolean;
    note: string;
  };

  exclusive_node_count: number;


  shared_node_count: number;




  owned_shared_node_count: number;
  capabilities?: string[];
  entry_point_count: number;
  exit_point_count: number;




  seed_node_count: number;
  seed_basis: string[];
  seed_basis_total?: number;
  boundary_evidence: string[];
}

export interface SubCasNodeIndex {
  promoted: boolean;
  units: SubCasNodeIndexEntry[];





  qualified_unit_count: number;
  promotion_threshold: number;


  reason: string;

  graph_node_count: number;

  covered_node_count: number;

  coverage_ratio: number;


  exclusive_node_count: number;
  shared_node_count: number;



  sum_of_unit_node_counts: number;




  orphan_node_count: number;
  orphan_node_ids: string[];
  counts_note: string;












  duplicate_units_collapsed: Array<{ dropped_id: string; dropped_name: string; kept_id: string; kept_name: string; overlap_ratio: number }>;






  orphan_node_id_duplicate_count: number;
}











const SUB_CAS_COUNTS_NOTE =
  'Unit node_counts include shared code and so may sum to more than graph_node_count; '
  + 'exclusive_node_count + shared_node_count + orphan_node_count === graph_node_count, and '
  + 'each shared node has exactly one canonical owner (owned_shared_node_count).';

export interface SubCasNodeSlice {
  sub_cas_node_id: string;
  unit_name: string;
  root_path: string;
  member_root_paths: string[];

  seed_node_count: number;
  seed_basis: string[];




  has_discriminating_evidence: boolean;






  slice: CASOutput;
}

export interface BuildDeployableAnalysesResult {
  promoted: boolean;
  sub_cas_nodes: SubCasNodeIndex;
  units: SubCasNodeSlice[];
}

function rootCasId(cas: CASOutput): string {
  if (cas.id) return cas.id;
  return `cas:${cas.system.id || cas.analysis_id}`;
}

function buildDeployableChildCas(parent: CASOutput, unit: SubCasNodeSlice): CASOutput {
  return {
    ...unit.slice,
    parent_id: rootCasId(parent),
  };
}

export function materializeDeployableCasTree(cas: CASOutput, id = rootCasId(cas)): CASOutput {
  const projection = prepareDeployableCasProjection(cas, id);
  const root = projection.root;
  const children = [...iterateDeployableChildCas(cas, projection)];
  if (children.length > 0) root.children = children;
  assertValidCasTree(root);
  return root;
}

export function materializeDeployableCasRoot(cas: CASOutput, id = rootCasId(cas)): CASOutput {
  return prepareDeployableCasProjection(cas, id).root;
}

export interface PreparedDeployableCasProjection {
  root: CASOutput;
  analysis: BuildDeployableAnalysesResult;
  children: readonly CASOutput[];
}

export function prepareDeployableCasProjection(cas: CASOutput, id = rootCasId(cas)): PreparedDeployableCasProjection {
  const { children: _children, composition_mode: _compositionMode, ...base } = cas;
  const root: CASOutput = {
    ...base,
    id,
    parent_id: null,
    label: cas.label || cas.system.name,
  };
  const result = getCachedDeployableAnalyses(root);
  if (cas.children && cas.children.length > 0) {
    root.composition_mode = cas.composition_mode;
    return {
      root,
      analysis: result,
      children: cas.children.map(child => ({ ...child, parent_id: id })),
    };
  }
  if (!result.promoted) {
    return { root, analysis: result, children: [] };
  }
  root.composition_mode = 'derived';
  return {
    root,
    analysis: result,
    children: result.units.map(unit => buildDeployableChildCas(root, unit)),
  };
}

export function* iterateDeployableChildCas(cas: CASOutput, prepared?: PreparedDeployableCasProjection): Generator<CASOutput> {
  const { children } = prepared || prepareDeployableCasProjection(cas);
  yield* children;
}
export function sliceDeployableAnalysis(cas: CASOutput, deployable: DeployableEvidence): SubCasNodeSlice {
  const allEvidence = cas.deployable_evidence || [];
  const allRoots = deployableRootsByEvidenceOrder(allEvidence);
  const ctx = sliceContextFor(cas);
  const nodesById = ctx.nodesById;

  const roots = unitRoots(deployable, allEvidence, allRoots);
  const { seedNodeIds, basis, hasDiscriminatingEvidence } = seedsForUnit(deployable, allEvidence, roots, allRoots, ctx);
  const reachable = closureForSeeds(seedNodeIds, ctx);

  const idx = allEvidence.indexOf(deployable);
  const unitId = subCasNodeIds(cas, allEvidence)[idx] ?? `${rootCasId(cas)}:${deployable.kind}:${deployable.name}`;

  const nodes = cas.nodes.filter(n => reachable.has(n.id));
  const edges = (cas.edges || []).filter(e => reachable.has(e.source) && reachable.has(e.target));
  const reachableFiles = new Set(nodes.map(n => n.source?.file).filter((f): f is string => Boolean(f)));






  const inClosure = (nodeId: string | undefined): boolean => Boolean(nodeId && reachable.has(nodeId));
  const seedEntryPoints = (cas.entry_points || []).filter(ep => {
    if (inClosure(ep.handler?.node_id) || inClosure(ep.source_node)) return true;
    const file = extractEntryPointFilePath(ep, nodesById);
    return Boolean(file && reachableFiles.has(file));
  });
  const seedExitPoints = (cas.exit_points || []).filter(exit => {
    if (inClosure(exit.source_node)) return true;
    const file = exitPointFile(exit, nodesById);
    return Boolean(file && reachableFiles.has(file));
  });

  const includedEntryPointIds = new Set(seedEntryPoints.map(e => e.id));
  const includedExitPointIds = new Set(seedExitPoints.map(e => e.id));
  const dataEntities = filterDataEntities(cas.entities, reachable);
  const includedEntityIds = new Set(dataEntities.map(e => e.id));
  const includedEntityNames = new Set(dataEntities.map(e => e.name));
  const scopedFlowGraph = filterFlowGraph(cas.flow_graph, includedEntryPointIds, reachable);
  const comprehensionFlows = filterComprehensionFlows(cas.flows, includedEntryPointIds, reachable);
  const containedFlowIds = comprehensionFlows.length > 0
    ? new Set(comprehensionFlows.map(flow => flow.flow_id))
    : scopedFlowGraph.flowIds;
  const bornHere = partBornAt(cas, deployable.root_path);
  const ownFlows = bornHere?.capabilities?.length && bornHere.flows?.length ? bornHere.flows : comprehensionFlows;
  const methodCalls = (cas.method_calls || []).filter(call => reachable.has(call.caller_node));
  const callChains = (cas.call_chains || []).filter(chain =>
    reachable.has(chain.entry_point.node_id) || chain.call_path.some(segment => reachable.has(segment.node_id)),
  );
  const callChainIds = new Set(callChains.map(chain => chain.id));
  const behavioralInvariants = filterBehavioralInvariants(
    cas.behavioral_invariants,
    reachable,
    includedEntryPointIds,
    includedEntityNames,
    reachableFiles,
  );
  const securityBoundaries = filterSecurityBoundaries(cas.security_boundaries, reachable);
  const testSuites = filterTestSuites(cas.test_suites, reachable, reachableFiles);
  const changeRisks = (cas.change_risks || []).filter(risk => reachable.has(risk.node_id));
  const temporalStability = (cas.temporal_stability || []).filter(stability => reachable.has(stability.node_id));
  const testGaps = (cas.test_gaps || []).filter(gap =>
    Boolean(gap.location.node_id && reachable.has(gap.location.node_id)) ||
    Boolean(gap.location.call_chain_id && callChainIds.has(gap.location.call_chain_id)),
  );
  const idiomViolations = filterIdiomViolations(cas.idiom_violations, reachable, reachableFiles);
  const projected: CASChildProjectedValues = {
    nodes,
    edges,
    entry_points: seedEntryPoints,
    exit_points: seedExitPoints,
    entities: dataEntities,
    data_lineage: filterDataLineage(cas.data_lineage, reachableFiles),
    capabilities: bornHere?.capabilities?.length ? bornHere.capabilities : scopeCapabilitiesToSlice(
      linkedCapabilities(cas, ownFlows) ?? filterCapabilities(cas.capabilities, includedEntryPointIds),
      includedEntryPointIds,
      containedFlowIds,
    ),
    behavior_surfaces: scopeCapabilitiesToSlice(
      filterCapabilities(cas.behavior_surfaces, includedEntryPointIds),
      includedEntryPointIds,
      containedFlowIds,
    ),
    flows: ownFlows.length > 0 ? ownFlows : undefined,
    steps: ownFlows.length > 0 ? ownFlows.flatMap(flow => flow.steps) : undefined,
    flow_graph: scopedFlowGraph.graph,
    user_journeys: undefined,
    communication_seams: filterCommunicationSeams(cas.communication_seams, includedEntryPointIds, includedExitPointIds, includedEntityIds),
    method_calls: methodCalls.length > 0 ? methodCalls : undefined,
    call_chains: callChains.length > 0 ? callChains : undefined,
    intents: (cas.intents || []).filter(intent => reachable.has(intent.node_id)),
    change_risks: changeRisks,
    change_risk_summary: changeRisks.length > 0 ? {
      high_risk_nodes: changeRisks.filter(risk => risk.risk_level === 'critical' || risk.risk_level === 'high').map(risk => risk.node_id),
      untested_critical_paths: (cas.change_risk_summary?.untested_critical_paths || []).filter(id => callChainIds.has(id) || reachable.has(id)),
      recent_hotspots: (cas.change_risk_summary?.recent_hotspots || []).filter(id => reachable.has(id)),
    } : undefined,
    behavioral_invariants: behavioralInvariants,
    behavioral_invariant_summary: summarizeBehavioralInvariants(behavioralInvariants, cas.behavioral_invariant_summary),
    security_boundaries: securityBoundaries,
    security_summary: summarizeSecurityBoundaries(securityBoundaries),
    security_contexts: (cas.security_contexts || []).filter(context =>
      Boolean(context.node_id && reachable.has(context.node_id)) ||
      intersects(context.scope?.node_ids, reachable) ||
      intersects(context.scope?.entry_points, includedEntryPointIds) ||
      intersects(context.scope?.paths, reachableFiles),
    ),
    flow_coverage: filterFlowCoverage(cas.flow_coverage, reachable, callChainIds),
    test_gaps: testGaps,
    temporal_stability: temporalStability,
    stability_summary: temporalStability.length > 0 ? {
      by_stability_class: temporalStability.reduce<Record<string, number>>((counts, item) => {
        counts[item.stability_class] = (counts[item.stability_class] || 0) + 1;
        return counts;
      }, {}),
      hotspots: (cas.stability_summary?.hotspots || []).filter(hotspot => reachable.has(hotspot.node_id)),
      legacy_areas: (cas.stability_summary?.legacy_areas || []).filter(file => reachableFiles.has(file)),
    } : undefined,
    test_suites: testSuites,
    idiom_violations: idiomViolations,
    principle_violations: (cas.principle_violations || []).filter(violation => reachable.has(violation.node_id) || reachableFiles.has(violation.file)),
    module_health: scopedModuleHealth(cas.module_health, reachableFiles),
    analysis_facts: (cas.analysis_facts || []).filter(fact =>
      reachable.has(fact.subject_id) || includedEntryPointIds.has(fact.subject_id) || includedExitPointIds.has(fact.subject_id) || containedFlowIds.has(fact.subject_id),
    ),
    runtime_static_links: (cas.runtime_static_links || []).filter(link =>
      reachable.has(link.static_id) || includedEntryPointIds.has(link.static_id) || includedExitPointIds.has(link.static_id) || callChainIds.has(link.static_id),
    ),
    deployable_evidence: [deployable, ...bundledMembersOf(deployable, allEvidence)],
    terminality: undefined,
      units: undefined,
  };
  const scopedSlice = projectCasChild(cas, {
    id: unitId,
    parent_id: rootCasId(cas),
    label: deployable.name,
    analysis_id: `${cas.analysis_id}:${unitId}`,
    system: {
      ...cas.system,
      id: `${cas.system.id || rootCasId(cas)}:${unitId}`,
      name: deployable.name,
      root_path: deployable.root_path,
    },
  }, projected);
  scopedSlice.terminality = buildCasTerminality(scopedSlice);

  return {
    sub_cas_node_id: unitId,
    unit_name: deployable.name,
    root_path: deployable.root_path,
    member_root_paths: bundledMembersOf(deployable, allEvidence).map(m => m.root_path),
    seed_node_count: seedNodeIds.size,
    seed_basis: basis,
    has_discriminating_evidence: hasDiscriminatingEvidence,
    slice: scopedSlice,
  };
}
















const DUPLICATE_CLOSURE_OVERLAP_RATIO = 0.95;





const MIN_CLOSURE_SIZE_FOR_OVERLAP = 2;




















const BARE_TOOLING_NOUNS = new Set([
  'docker', 'dockerfile', 'container', 'containers', 'compose', 'image', 'images',
  'build', 'builder', 'dist', 'bin', 'artifact', 'artifacts', 'deploy', 'deployment',
  'k8s', 'kubernetes', 'package', 'pkg', 'app', 'service', 'services',
]);

function isBareToolingNoun(name: string): boolean {
  return BARE_TOOLING_NOUNS.has(name.trim().toLowerCase());
}







function richerUnit(a: DeployableEvidence, b: DeployableEvidence, allEvidence: DeployableEvidence[]): DeployableEvidence {
  const aConcrete = a.root_path && a.root_path !== '.' ? 1 : 0;
  const bConcrete = b.root_path && b.root_path !== '.' ? 1 : 0;
  if (aConcrete !== bConcrete) return aConcrete > bConcrete ? a : b;
  if (a.evidence.length !== b.evidence.length) return a.evidence.length > b.evidence.length ? a : b;
  return allEvidence.indexOf(a) <= allEvidence.indexOf(b) ? a : b;
}











function collapseDuplicateClosureUnits(
  qualified: DeployableEvidence[],
  rawSlices: SubCasNodeSlice[],
): {
  qualified: DeployableEvidence[];
  rawSlices: SubCasNodeSlice[];
  duplicatesCollapsed: Array<{ dropped_id: string; dropped_name: string; kept_id: string; kept_name: string; overlap_ratio: number }>;
} {
  const closures = rawSlices.map(s => new Set(s.slice.nodes.map(n => n.id)));
  const dropped = new Set<number>();
  const duplicatesCollapsed: Array<{ dropped_id: string; dropped_name: string; kept_id: string; kept_name: string; overlap_ratio: number }> = [];

  for (let i = 0; i < qualified.length; i++) {
    if (dropped.has(i)) continue;
    for (let j = i + 1; j < qualified.length; j++) {
      if (dropped.has(j)) continue;








      if (!rawSlices[i].has_discriminating_evidence || !rawSlices[j].has_discriminating_evidence) continue;

      const a = closures[i];
      const b = closures[j];
      const smaller = Math.min(a.size, b.size);
      if (smaller < MIN_CLOSURE_SIZE_FOR_OVERLAP) continue;
      let intersection = 0;
      const [small, large] = a.size <= b.size ? [a, b] : [b, a];
      for (const id of small) if (large.has(id)) intersection++;
      const overlapRatio = intersection / smaller;
      if (overlapRatio < DUPLICATE_CLOSURE_OVERLAP_RATIO) continue;

      const survivor = richerUnit(qualified[i], qualified[j], qualified);




      if (isBareToolingNoun(survivor.name)) continue;
      const loserIdx = survivor === qualified[i] ? j : i;
      const keptIdx = survivor === qualified[i] ? i : j;
      dropped.add(loserIdx);
      duplicatesCollapsed.push({
        dropped_id: rawSlices[loserIdx].sub_cas_node_id,
        dropped_name: qualified[loserIdx].name,
        kept_id: rawSlices[keptIdx].sub_cas_node_id,
        kept_name: qualified[keptIdx].name,
        overlap_ratio: Math.round(overlapRatio * 10000) / 10000,
      });
      if (loserIdx === i) break;
    }
  }

  if (!dropped.size) return { qualified, rawSlices, duplicatesCollapsed: [] };

  const keptIndices = qualified.map((_, idx) => idx).filter(idx => !dropped.has(idx));
  return {
    qualified: keptIndices.map(idx => qualified[idx]),
    rawSlices: keptIndices.map(idx => rawSlices[idx]),
    duplicatesCollapsed,
  };
}













export function buildDeployableAnalyses(cas: CASOutput): BuildDeployableAnalysesResult {
  const allEvidence = cas.deployable_evidence || [];
  let qualified = tierQualifiedShipUnits(allEvidence);

  if (qualified.length < PROMOTION_THRESHOLD) {
    return {
      promoted: false,
      sub_cas_nodes: {
        promoted: false,
        units: [],
        qualified_unit_count: qualified.length,
        promotion_threshold: PROMOTION_THRESHOLD,
        reason: qualified.length === 0
          ? 'No tier-qualified ship unit found: no deployable_evidence row declares a ship or build artifact of its own.'
          : `${qualified.length} tier-qualified ship unit found (${qualified.map(u => u.name).join(', ')}) — below the promotion threshold of ${PROMOTION_THRESHOLD}, so this CAS is its own single deployable and needs no per-unit slicing. Coverage and orphan counts describe slices and are therefore zero here, not "nothing found".`,
        graph_node_count: (cas.nodes || []).length,
        covered_node_count: 0,
        coverage_ratio: 0,
        exclusive_node_count: 0,
        shared_node_count: 0,
        sum_of_unit_node_counts: 0,
        orphan_node_count: 0,
        orphan_node_ids: [],
        counts_note: SUB_CAS_COUNTS_NOTE,
        duplicate_units_collapsed: [],
        orphan_node_id_duplicate_count: 0,
      },
      units: [],
    };
  }

  const allRoots = deployableRootsByEvidenceOrder(allEvidence);



  const rawSlicesBeforeDedup = qualified.map(unit => sliceDeployableAnalysis(cas, unit));

  const { qualified: qualifiedDeduped, rawSlices, duplicatesCollapsed } =
    collapseDuplicateClosureUnits(qualified, rawSlicesBeforeDedup);
  qualified = qualifiedDeduped;





  if (qualified.length < PROMOTION_THRESHOLD) {
    const collapsedNote = duplicatesCollapsed.length
      ? ` (collapsed ${duplicatesCollapsed.length} duplicate-closure unit(s) that were the same shipped artifact counted more than once: ${duplicatesCollapsed.map(d => `"${d.dropped_name}" -> "${d.kept_name}"`).join(', ')})`
      : '';
    return {
      promoted: false,
      sub_cas_nodes: {
        promoted: false,
        units: [],
        qualified_unit_count: qualified.length,
        promotion_threshold: PROMOTION_THRESHOLD,
        reason: `${qualified.length} tier-qualified ship unit found after duplicate-closure collapse — below the promotion threshold of ${PROMOTION_THRESHOLD}, so this CAS is its own single deployable and needs no per-unit slicing.${collapsedNote}`,
        graph_node_count: (cas.nodes || []).length,
        covered_node_count: 0,
        coverage_ratio: 0,
        exclusive_node_count: 0,
        shared_node_count: 0,
        sum_of_unit_node_counts: 0,
        orphan_node_count: 0,
        orphan_node_ids: [],
        counts_note: SUB_CAS_COUNTS_NOTE,
        duplicate_units_collapsed: duplicatesCollapsed,
        orphan_node_id_duplicate_count: 0,
      },
      units: [],
    };
  }

  const unitsReachability: UnitReachability[] = qualified.map((unit, i) => ({
    index: i,
    id: rawSlices[i].sub_cas_node_id,
    name: unit.name,
    reachable: new Set(rawSlices[i].slice.nodes.map(n => n.id)),
  }));

  const rootsWithOwner = qualified.map((unit, i) => {
    const idx = allEvidence.indexOf(unit);
    return { root: allRoots[idx], unitIndex: i };
  }).filter((r): r is { root: DeployableRoot; unitIndex: number } => Boolean(r.root));

  const attribution = computeAttribution(cas.nodes, unitsReachability, rootsWithOwner);

  const units: SubCasNodeSlice[] = rawSlices.map((raw, i) => {
    const thisUnitId = unitsReachability[i].id;
    const nodes = raw.slice.nodes.map(n => {
      const info = attribution.get(n.id);
      if (!info || info.attribution !== 'shared') return n;
      const isOwner = info.canonicalOwnerId === thisUnitId;
      const taggedMetadata: Record<string, unknown> = {
        ...n.metadata,
        attribution: (isOwner ? 'owned' : 'shared') as SubCasNodeAttribution,
        ...(isOwner
          ? { also_used_by: info.alsoUsedBy }
          : { canonical_owner_sub_cas_node_id: info.canonicalOwnerId }),
      };
      return {
        ...n,
        metadata: taggedMetadata as unknown as CASNode['metadata'],
      };
    });
    return { ...raw, slice: { ...raw.slice, nodes } };
  });





  const reachedAnywhere = new Set<string>();
  for (const u of unitsReachability) for (const id of u.reachable) reachedAnywhere.add(id);
  const rawOrphanIds = (cas.nodes || []).filter(n => !reachedAnywhere.has(n.id)).map(n => n.id);
  const orphanIds = [...new Set(rawOrphanIds)];




  const orphanNodeIdDuplicateCount = rawOrphanIds.length - orphanIds.length;

  const perUnitCounts = unitsReachability.map(() => ({ exclusive: 0, shared: 0, ownedShared: 0 }));
  let exclusiveTotal = 0;
  let sharedTotal = 0;
  for (const [, info] of attribution) {
    if (info.attribution === 'exclusive') {
      exclusiveTotal += 1;
      perUnitCounts[info.canonicalOwnerIndex].exclusive += 1;
      continue;
    }
    sharedTotal += 1;
    perUnitCounts[info.canonicalOwnerIndex].ownedShared += 1;
  }
  for (const u of unitsReachability) {
    for (const id of u.reachable) {
      if (attribution.get(id)?.attribution === 'shared') perUnitCounts[u.index].shared += 1;
    }
  }

  const graphNodeCount = (cas.nodes || []).length;
  const coveredNodeCount = reachedAnywhere.size;
  const sumOfUnitNodeCounts = units.reduce((sum, u) => sum + u.slice.nodes.length, 0);

  const sub_cas_nodes: SubCasNodeIndex = {
    promoted: true,
    units: qualified.map((unit, i) => ({
      id: unitsReachability[i].id,
      name: unit.name,
      root_path: unit.root_path,
      member_root_paths: bundledMembersOf(unit, allEvidence).map(m => m.root_path),
      tier: unit.tier,
      kind: unit.kind,
      node_count: units[i].slice.nodes.length,
      size_disclosure: {
        edge_count: units[i].slice.edges.length,
        root_node_ratio: graphNodeCount ? units[i].slice.nodes.length / graphNodeCount : 0,
        root_edge_ratio: cas.edges.length ? units[i].slice.edges.length / cas.edges.length : 0,
        large_scope_threshold: 0.5,
        large_scope: units[i].slice.nodes.length > graphNodeCount * 0.5 || units[i].slice.edges.length > cas.edges.length * 0.5,
        note: 'Ratios describe retained graph records, not serialized bytes. Above one half of either root collection is a large scope; all required records remain included.',
      },
      exclusive_node_count: perUnitCounts[i].exclusive,
      shared_node_count: perUnitCounts[i].shared,
      owned_shared_node_count: perUnitCounts[i].ownedShared,
      capabilities: unit.capabilities?.length ? unit.capabilities : (units[i].slice.capabilities || []).map(capability => capability.name),
      entry_point_count: (units[i].slice.entry_points || []).length,
      exit_point_count: (units[i].slice.exit_points || []).length,
      seed_node_count: units[i].seed_node_count,
      seed_basis: units[i].seed_basis.slice(0, SEED_BASIS_SHOWN),
      ...(units[i].seed_basis.length > SEED_BASIS_SHOWN ? { seed_basis_total: units[i].seed_basis.length } : {}),
      boundary_evidence: unit.evidence,
    })),
    qualified_unit_count: qualified.length,
    promotion_threshold: PROMOTION_THRESHOLD,
    reason: `${qualified.length} tier-qualified ship units resolved (>= ${PROMOTION_THRESHOLD}), so this CAS has promoted sub-CAS nodes.`
      + (duplicatesCollapsed.length
        ? ` (collapsed ${duplicatesCollapsed.length} duplicate-closure unit(s) before counting: ${duplicatesCollapsed.map(d => `"${d.dropped_name}" -> "${d.kept_name}"`).join(', ')})`
        : ''),
    graph_node_count: graphNodeCount,
    covered_node_count: coveredNodeCount,
    coverage_ratio: graphNodeCount === 0 ? 0 : Math.round((coveredNodeCount / graphNodeCount) * 10000) / 10000,
    exclusive_node_count: exclusiveTotal,
    shared_node_count: sharedTotal,
    sum_of_unit_node_counts: sumOfUnitNodeCounts,
    orphan_node_count: orphanIds.length,
    orphan_node_ids: orphanIds.slice(0, 50),
    counts_note: SUB_CAS_COUNTS_NOTE,
    duplicate_units_collapsed: duplicatesCollapsed,
    orphan_node_id_duplicate_count: orphanNodeIdDuplicateCount,
  };

  return { promoted: true, sub_cas_nodes, units };
}














export function resolveSubCasNodeScope(cas: CASOutput, subCasNodeId: string): SubCasNodeSlice | undefined {
  const { units } = buildDeployableAnalyses(cas);
  return units.find(u => u.sub_cas_node_id === subCasNodeId);
}


















function subCasCacheKey(cas: CASOutput): string {
  const layerGeneration = cas.layers_ready?.generated_at || '';
  const capabilityCount = (cas.capabilities || []).length + (cas.behavior_surfaces || []).length;
  const flowCount = cas.flows?.length || 0;
  return [
    cas.id || '',
    cas.analysis_id,
    cas.derived_fingerprint || '',
    layerGeneration,
    cas.nodes?.length || 0,
    cas.edges?.length || 0,
    cas.entry_points?.length || 0,
    cas.exit_points?.length || 0,
    capabilityCount,
    flowCount,
  ].join(':');
}

export function getCachedDeployableAnalyses(cas: CASOutput): BuildDeployableAnalysesResult {
  const key = subCasCacheKey(cas);
  const cached = deployableAnalysisCache.get(key);
  if (cached) return cached;
  const result = buildDeployableAnalyses(cas);
  deployableAnalysisCache.set(key, result);
  return result;
}

export interface SubCasNodeScopeParam {
  sub_cas_node_id: string;
}











export function scopeCasToSubCasNode(cas: CASOutput, scope: SubCasNodeScopeParam | undefined): CASOutput {
  if (!scope) return cas;
  const materialized = cas.children?.find(child => child.id === scope.sub_cas_node_id);
  if (materialized) return materialized;
  const { promoted, sub_cas_nodes, units } = getCachedDeployableAnalyses(cas);
  if (!promoted) {
    throw new Error(
      'This analysis has not promoted any sub-CAS nodes (it resolves fewer than 2 tier-qualified ship units), so scope.sub_cas_node_id does not apply. Omit scope to query the whole repo.'
    );
  }
  const unit = units.find(u => u.sub_cas_node_id === scope.sub_cas_node_id);
  if (!unit) {
    const available = sub_cas_nodes.units.map(u => `${u.id} (${u.name})`).join(', ') || 'none';
    throw new Error(`Unknown scope.sub_cas_node_id '${scope.sub_cas_node_id}'. Available sub-CAS-node units for this analysis: ${available}.`);
  }
  return buildDeployableChildCas(cas, unit);
}
