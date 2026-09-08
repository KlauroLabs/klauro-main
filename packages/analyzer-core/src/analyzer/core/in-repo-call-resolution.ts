import type { CASEdge, CASExitPoint, CASNode, CASLibrary } from '../../types/cas.types';
import { appendAll, replaceArrayContents } from './bulk-array-ops';
import { TRACEABLE_NODE_TYPES } from './flow-concepts';
import { graphItemAnalyzers } from './incremental-contribution-refresh';




























































const CALLABLE_NODE_TYPES = new Set<string>([
  ...TRACEABLE_NODE_TYPES,
  'arrow_function', 'function_declaration', 'constructor',
  'interactor', 'command', 'job', 'task',
]);








const SYMBOL_BEARING_EXIT_TYPES = new Set(['sdk', 'api', 'database', 'cache', 'message']);




const SOURCE_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.swift', '.cs',
  '.php', '.scala', '.dart', '.vue', '.svelte', '.astro',
];

export interface InternalizeInput {
  nodes: CASNode[];
  edges: CASEdge[];
  exitPoints: CASExitPoint[];
  libraries?: CASLibrary[];
}

export interface InternalizeStats {

  candidates: number;

  internalized: number;

  edges_added: number;

  skipped_library_mapped: number;

  skipped_declared_dependency: number;

  skipped_ambiguous: number;


  unresolved: number;

  by_tier: Record<string, number>;


  edges_repointed: number;




  edges_dropped_orphaned: number;
}

function fileOf(node: CASNode): string | undefined {
  return (node as any).file_path || node.source?.file;
}



function normalizeModulePath(p: string): string {
  let out = p.replace(/\\/g, '/');
  for (const ext of SOURCE_EXTENSIONS) {
    if (out.endsWith(ext)) { out = out.slice(0, -ext.length); break; }
  }
  if (out.endsWith('/index')) out = out.slice(0, -'/index'.length);
  if (out.endsWith('/mod')) out = out.slice(0, -'/mod'.length);
  return out.replace(/^\.\/+/, '').replace(/^(\.\.\/)+/, '').replace(/^[@~]\//, '').replace(/^\/+/, '');
}



function packageRootOf(filePath: string): string {
  const parts = filePath.split('/');

  return parts.slice(0, Math.min(2, parts.length)).join('/');
}



function ownerOf(node: CASNode): string | undefined {
  const md: any = node.metadata || {};
  const direct = md.implType || md.class || md.className || md.owner
    || md.attributes?.implType || md.attributes?.class || md.attributes?.className;
  if (typeof direct === 'string' && direct) return direct;



  const segs = node.id.split(':');
  if (segs.length >= 4 && segs[segs.length - 1] === node.name) return segs[segs.length - 2];
  return undefined;
}




function calleeNameOf(ep: CASExitPoint): string | undefined {
  const md: any = ep.metadata || {};
  if (typeof md.function === 'string' && md.function) return md.function;
  if (typeof ep.target?.endpoint === 'string' && /^[A-Za-z_$][\w$]*$/.test(ep.target.endpoint)) {
    return ep.target.endpoint;
  }
  if (typeof ep.operation?.action === 'string' && /^[A-Za-z_$][\w$]*$/.test(ep.operation.action)) {
    return ep.operation.action;
  }
  const m = /(?:^Call to |::)([A-Za-z_$][\w$]*)$/.exec(ep.name || '');
  return m ? m[1] : undefined;
}


function moduleOf(ep: CASExitPoint): string | undefined {
  const md: any = ep.metadata || {};
  const raw = (typeof md.module === 'string' && md.module) ? md.module : ep.target?.sdk;
  return typeof raw === 'string' && raw ? raw : undefined;
}





function declaredThirdPartyNames(libraries: CASLibrary[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const lib of libraries || []) {
    const version = (lib as any).version;
    const isWorkspacePath = typeof version === 'string' && (version.includes('/') || version.startsWith('.'));
    if (isWorkspacePath) continue;
    if (lib.name) out.add(lib.name);
  }
  return out;
}

interface ResolutionIndex {
  byOwnerName: Map<string, CASNode[]>;
  byFileName: Map<string, CASNode[]>;
  byName: Map<string, CASNode[]>;

  filesByNormalizedTail: Map<string, Set<string>>;
}

function buildResolutionIndex(nodes: CASNode[]): ResolutionIndex {
  const byOwnerName = new Map<string, CASNode[]>();
  const byFileName = new Map<string, CASNode[]>();
  const byName = new Map<string, CASNode[]>();
  const filesByNormalizedTail = new Map<string, Set<string>>();
  const seenFiles = new Set<string>();

  const push = (map: Map<string, CASNode[]>, key: string, node: CASNode) => {
    const list = map.get(key);
    if (list) list.push(node); else map.set(key, [node]);
  };

  for (const node of nodes) {
    const file = fileOf(node);
    if (file && !seenFiles.has(file)) {
      seenFiles.add(file);
      const norm = normalizeModulePath(file);



      const segs = norm.split('/');
      for (let i = 0; i < segs.length; i++) {
        const tail = segs.slice(i).join('/');
        let set = filesByNormalizedTail.get(tail);
        if (!set) { set = new Set(); filesByNormalizedTail.set(tail, set); }
        set.add(file);
      }
    }
    if (!CALLABLE_NODE_TYPES.has(node.type)) continue;
    if (!node.name) continue;
    push(byName, node.name, node);
    if (file) push(byFileName, `${file} ${node.name}`, node);
    const owner = ownerOf(node);
    if (owner) push(byOwnerName, `${owner} ${node.name}`, node);
  }
  return { byOwnerName, byFileName, byName, filesByNormalizedTail };
}




function disambiguate(candidates: CASNode[], callerFile: string | undefined): CASNode | undefined {
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  if (!callerFile) return undefined;
  const sameFile = candidates.filter(c => fileOf(c) === callerFile);
  if (sameFile.length === 1) return sameFile[0];
  if (sameFile.length > 1) return undefined;
  const root = packageRootOf(callerFile);
  const samePkg = candidates.filter(c => { const f = fileOf(c); return f !== undefined && packageRootOf(f) === root; });
  if (samePkg.length === 1) return samePkg[0];
  return undefined;
}






type Resolution = { node: CASNode; tier: string } | 'ambiguous' | undefined;

function resolveCallee(
  ep: CASExitPoint,
  index: ResolutionIndex,
  callerFile: string | undefined
): Resolution {
  const moduleSpec = moduleOf(ep);
  const callee = calleeNameOf(ep);
  if (!moduleSpec || !callee) return undefined;

  const looksLikePath = moduleSpec.includes('/') || moduleSpec.startsWith('.');



  if (looksLikePath) {








    const segs = normalizeModulePath(moduleSpec).split('/').filter(Boolean);
    for (let start = 0; start < segs.length; start++) {
      const files = index.filesByNormalizedTail.get(segs.slice(start).join('/'));
      if (!files || files.size === 0) continue;
      const hits: CASNode[] = [];
      for (const file of files) {
        for (const n of index.byFileName.get(`${file} ${callee}`) || []) hits.push(n);
      }
      const hit = disambiguate(hits, callerFile);
      if (hit) return { node: hit, tier: 'module_path' };



      return hits.length > 1 ? 'ambiguous' : undefined;
    }
    return undefined;
  }



  const ownerSpec = moduleSpec.split(/::|\./).filter(Boolean).pop();
  if (ownerSpec) {
    const owned = index.byOwnerName.get(`${ownerSpec} ${callee}`) || [];
    const hit = disambiguate(owned, callerFile);
    if (hit) return { node: hit, tier: 'type_member' };
    if (owned.length > 1) return 'ambiguous';
  }





  const segs = moduleSpec.split(/::/).filter(s => s && s !== 'crate' && s !== 'self' && s !== 'super');
  if (segs.length > 0) {
    const byName = index.byName.get(callee) || [];
    const moduleTail = segs[segs.length - 1];
    const withModuleInPath = byName.filter(n => {
      const f = fileOf(n);
      return f !== undefined && normalizeModulePath(f).split('/').includes(moduleTail);
    });
    if (withModuleInPath.length === 1) return { node: withModuleInPath[0], tier: 'module_free_function' };
  }

  return undefined;
}




















function inheritCallOwnership(edge: CASEdge, owners: readonly string[]): void {
  const analyzers = [...new Set([...graphItemAnalyzers(edge), ...owners])];
  if (!analyzers.length) return;
  edge.metadata = {
    ...edge.metadata,
    source_analyzer: analyzers[0],
    ...(analyzers.length > 1 ? { merged_from_analyzers: analyzers } : {}),
  } as CASEdge['metadata'];
}

export function internalizeInRepoCalls(input: InternalizeInput): InternalizeStats {
  const { nodes, edges, exitPoints } = input;
  const stats: InternalizeStats = {
    candidates: 0, internalized: 0, edges_added: 0,
    skipped_library_mapped: 0, skipped_declared_dependency: 0,
    skipped_ambiguous: 0, unresolved: 0, by_tier: {},
    edges_repointed: 0, edges_dropped_orphaned: 0,
  };
  if (!Array.isArray(nodes) || !Array.isArray(edges) || !Array.isArray(exitPoints)) return stats;

  const index = buildResolutionIndex(nodes);
  const nodesById = new Map(nodes.map(n => [n.id, n]));
  const thirdParty = declaredThirdPartyNames(input.libraries);

  const existingCallEdges = new Map<string, CASEdge>();
  for (const e of edges) {
    if (e.type === 'calls' || e.type === 'invokes') existingCallEdges.set(`${e.source} ${e.target}`, e);
  }

  const removed = new Set<CASExitPoint>();
  const added: CASEdge[] = [];


  const resolvedTargetByExitId = new Map<string, string>();
  const resolutionTierByExitId = new Map<string, string>();
  const declaredModuleByExitId = new Map<string, string>();
  const ownersByExitId = new Map<string, string[]>();

  for (const ep of exitPoints) {
    if (!SYMBOL_BEARING_EXIT_TYPES.has(ep.type)) continue;
    const moduleSpec = moduleOf(ep);
    const callee = calleeNameOf(ep);
    if (!moduleSpec || !callee) continue;
    stats.candidates++;




    const library = (ep.metadata as any)?.library;
    if (typeof library === 'string' && library && library !== moduleSpec) {
      stats.skipped_library_mapped++;
      continue;
    }





    if (thirdParty.has(moduleSpec) || thirdParty.has(moduleSpec.split('/').slice(0, 2).join('/'))) {
      stats.skipped_declared_dependency++;
      continue;
    }

    const source = nodesById.get(ep.source_node);
    const callerFile = source ? fileOf(source) : undefined;
    const resolved = resolveCallee(ep, index, callerFile);
    if (resolved === 'ambiguous') {
      stats.skipped_ambiguous++;
      continue;
    }
    if (!resolved) {
      stats.unresolved++;
      continue;
    }

    if (resolved.node.id === ep.source_node) { stats.unresolved++; continue; }

    stats.internalized++;
    stats.by_tier[resolved.tier] = (stats.by_tier[resolved.tier] || 0) + 1;
    removed.add(ep);
    resolvedTargetByExitId.set(ep.id, resolved.node.id);
    resolutionTierByExitId.set(ep.id, resolved.tier);
    declaredModuleByExitId.set(ep.id, moduleSpec);
    const owners = graphItemAnalyzers(ep);
    ownersByExitId.set(ep.id, owners);

    const key = `${ep.source_node} ${resolved.node.id}`;
    const existing = existingCallEdges.get(key);
    if (existing) {
      inheritCallOwnership(existing, owners);
      continue;
    }
    const line = (ep.metadata as any)?.call_line ?? (ep.metadata as any)?.line;
    const edge = {
      id: `calls:internalized:${ep.source_node}:${resolved.node.id}${line !== undefined ? `:${line}` : ''}`,
      source: ep.source_node,
      target: resolved.node.id,
      type: 'calls',
      metadata: {
        confidence: 1,
        ...(line !== undefined ? { locations: [{ file: callerFile, line }] } : {}),
        attributes: {


          internalized_from_exit_point: ep.id,
          resolution: resolved.tier,
          declared_module: moduleSpec,
        },
      },
    } as CASEdge;
    inheritCallOwnership(edge, owners);
    existingCallEdges.set(key, edge);
    added.push(edge);
    stats.edges_added++;
  }

  if (removed.size > 0) {
    replaceArrayContents(exitPoints, exitPoints.filter(ep => !removed.has(ep)));
  }



  if (added.length > 0) appendAll(edges, added);
  if (removed.size > 0) {
    reconcileEdgesToRemovedExitPoints(
      edges,
      { resolvedTargetByExitId, resolutionTierByExitId, declaredModuleByExitId, ownersByExitId },
      stats
    );
  }

  return stats;
}















function reconcileEdgesToRemovedExitPoints(
  edges: CASEdge[],
  tables: {
    resolvedTargetByExitId: Map<string, string>;
    resolutionTierByExitId: Map<string, string>;
    declaredModuleByExitId: Map<string, string>;
    ownersByExitId: Map<string, string[]>;
  },
  stats: InternalizeStats
): void {
  const { resolvedTargetByExitId, resolutionTierByExitId, declaredModuleByExitId, ownersByExitId } = tables;



  const callPairs = new Map<string, CASEdge>();
  for (const e of edges) {
    if (e.type !== 'calls' && e.type !== 'invokes') continue;
    if (resolvedTargetByExitId.has(e.target)) continue;
    callPairs.set(`${e.source} ${e.target}`, e);
  }

  const survivors: CASEdge[] = [];
  for (const e of edges) {
    const removedEndpoint = resolvedTargetByExitId.has(e.target) || resolvedTargetByExitId.has(e.source);
    if (!removedEndpoint) {
      survivors.push(e);
      continue;
    }


    if (resolvedTargetByExitId.has(e.source)) {
      stats.edges_dropped_orphaned++;
      continue;
    }

    const exitId = e.target;
    const newTarget = resolvedTargetByExitId.get(exitId)!;
    const pair = `${e.source} ${newTarget}`;
    const owners = ownersByExitId.get(exitId) || [];
    const existing = callPairs.get(pair);
    if (newTarget === e.source || existing) {
      if (existing) inheritCallOwnership(existing, [...graphItemAnalyzers(e), ...owners]);
      stats.edges_dropped_orphaned++;
      continue;
    }

    callPairs.set(pair, e);
    inheritCallOwnership(e, owners);
    e.target = newTarget;
    const metadata = (e.metadata || {}) as Record<string, unknown>;
    const attributes = (metadata.attributes || {}) as Record<string, unknown>;
    e.metadata = {
      ...metadata,
      attributes: {
        ...attributes,
        internalized_from_exit_point: exitId,
        resolution: resolutionTierByExitId.get(exitId),
        declared_module: declaredModuleByExitId.get(exitId),
      },
    } as CASEdge['metadata'];
    stats.edges_repointed++;
    survivors.push(e);
  }

  if (survivors.length !== edges.length) {
    replaceArrayContents(edges, survivors);
  }
}
