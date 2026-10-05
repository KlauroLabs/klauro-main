import type { SubProjectLinkCoverage } from './link-coverage';
import type {
  CASOutput,
  CASExitPoint,
  CASEntityLineage,
  CASEntityLineageAccessor,
  DeployableEvidence,
} from '../../types/cas.types';



























export type SeamModality = 'sync' | 'async' | 'passive';
export type SeamLevel = 'node' | 'deployable' | 'workspace';



export interface CommunicationSeam {
  id: string;
  modality: SeamModality;

  confidence: number;











  kind: 'exit_point' | 'messaging' | 'passive_state' | 'cross_repo_contract' | 'device_io' | 'shared_dependency';

  source: string;

  target: string;

  evidence: string;

  summary: string;

  shared_resource?: string;
  metadata?: Record<string, unknown>;
}

export interface CommunicationSeamInventory {
  level: SeamLevel;
  counts: { sync: number; async: number; passive: number; total: number };


  component_seams: Array<{
    source: string;
    target: string;
    modalities: SeamModality[];
    sync: number;
    async: number;
    passive: number;
    total: number;
  }>;
}

export interface CommunicationSeamsResult {
  link_coverage?: SubProjectLinkCoverage[];
  seams: CommunicationSeam[];

  inventory: CommunicationSeamInventory;

  deployable_inventory?: CommunicationSeamInventory;







  workspace_inventory?: CommunicationSeamInventory;
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `seam_${prefix}_${seq}`;
}















function isShipBoundary(d: DeployableEvidence): boolean {
  if (d.kind === 'server-entry' || d.bundled_into) return false;
  return d.tier === 1 || d.kind === 'container' || d.kind === 'compose-service' ||
    d.kind === 'k8s' || d.kind === 'serverless' || d.kind === 'installer' || d.kind === 'bin';
}








function exitModality(exit: CASExitPoint): { modality: SeamModality; confidence: number } | null {
  switch (exit.type) {
    case 'api':

      return { modality: 'sync', confidence: 0.9 };
    case 'database':



      return { modality: 'sync', confidence: 0.75 };
    case 'message':
    case 'event':

      return { modality: 'async', confidence: 0.9 };
    case 'webhook':

      return { modality: 'async', confidence: 0.85 };
    case 'sdk':

      return exit.operation?.async === false
        ? { modality: 'sync', confidence: 0.7 }
        : { modality: 'sync', confidence: 0.6 };
    case 'cache':
    case 'file':


      return { modality: 'sync', confidence: 0.55 };
    default:

      return null;
  }
}




















function isLibraryPlumbingExit(exit: CASExitPoint): boolean {
  if (exit.type !== 'sdk') return false;
  if (isDeviceIOExit(exit)) return false;
  if (!(exit.metadata as any)?.library) return false;
  if (exit.target?.service_id || exit.target?.resource) return false;
  const endpoint = exit.target?.endpoint;
  const action = exit.operation?.action;
  return !endpoint || endpoint === action;
}






















const DEVICE_IO_SIGNAL =
  /serial\s*port|system\.io\.ports|\bpyserial\b|\blibusb\b|\bwinusb\b|\bhidapi\b|\bhidsharp\b|\busb\b|\bhid\b/i;

function deviceIOSignalText(exit: CASExitPoint): string {
  const meta = exit.metadata as any;
  return [
    exit.target?.sdk,
    exit.target?.resource,
    exit.target?.endpoint,
    meta?.targetClass,
    meta?.library,
    exit.name,
    exit.description,
  ]
    .filter(Boolean)
    .join(' ');
}




function isDeviceIOExit(exit: CASExitPoint): boolean {
  if (exit.type !== 'sdk') return false;
  return DEVICE_IO_SIGNAL.test(deviceIOSignalText(exit));
}










function deviceIOModality(exit: CASExitPoint): { modality: SeamModality; confidence: number } {
  return exit.operation?.async === true
    ? { modality: 'async', confidence: 0.75 }
    : { modality: 'sync', confidence: 0.65 };
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


function fileForNode(nodeId: string, nodeFile: Map<string, string>): string | undefined {
  return nodeFile.get(nodeId);
}


function accessorFile(acc: CASEntityLineageAccessor): string | undefined {
  return acc.file;
}





export function classifyCommunicationSeams(
  output: Pick<
    CASOutput,
    'nodes' | 'exit_points' | 'entry_points' | 'data_lineage' | 'entities' | 'deployable_evidence'
  >,
): CommunicationSeamsResult {
  seq = 0;
  const seams: CommunicationSeam[] = [];

  const deployables: DeployableEvidence[] = output.deployable_evidence || [];







  const deployableRoots = deployables
    .filter(d => isShipBoundary(d))
    .map(d => ({
      root: d.root_path.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\/+/, ''),
      name: d.name,
    }));


  const nodeFile = new Map<string, string>();
  for (const n of output.nodes || []) {
    if (n.source?.file) nodeFile.set(n.id, n.source.file);
  }

  const componentOf = (file: string | undefined) => componentForFile(file, deployableRoots);



  for (const exit of output.exit_points || []) {
    if (isLibraryPlumbingExit(exit)) continue;
    const isDevice = isDeviceIOExit(exit);
    const verdict = isDevice ? deviceIOModality(exit) : exitModality(exit);
    if (!verdict) continue;
    const file = (exit.metadata as any)?.file || fileForNode(exit.source_node, nodeFile);
    const source = componentOf(file);
    const target =
      exit.target?.service_id ||
      exit.target?.resource ||
      exit.target?.sdk ||
      exit.target?.endpoint ||
      exit.name ||
      'external';
    const typeLabel = isDevice ? 'device' : exit.type;
    seams.push({
      id: nextId(isDevice ? 'device' : exit.type),
      modality: verdict.modality,
      confidence: verdict.confidence,
      kind: isDevice ? 'device_io' : (exit.type === 'message' || exit.type === 'event' ? 'messaging' : 'exit_point'),
      source,
      target: String(target),
      evidence: `exit:${exit.id} type=${exit.type} async=${exit.operation?.async ?? 'n/a'}`,
      summary: `${source} --${verdict.modality}--> ${String(target)} (${typeLabel})`,
      metadata: { exit_type: exit.type, exit_point: exit.id, ...(isDevice ? { device_io: true } : {}) },
    });
  }



  for (const ep of output.entry_points || []) {
    if (ep.type !== 'message' && ep.type !== 'event') continue;










    const epMeta = (ep.metadata || {}) as Record<string, unknown>;
    const triggerEvent = String(ep.trigger?.event || ep.name || '');
    const isUiEventHandler =
      epMeta.entry_type === 'ui_event_handler' ||
      /^(?:on)?(?:Click|DoubleClick|Loaded|Unloaded|Closing|Closed|MouseDown|MouseUp|MouseMove|MouseEnter|MouseLeave|MouseWheel|SelectionChanged|TextChanged|ValueChanged|Checked|Unchecked|GotFocus|LostFocus|KeyDown|KeyUp|KeyPress|Drop|DragEnter|DragLeave|DragOver|Scroll|Resize|Submit|Change|Input|Focus|Blur|Hover)$/i.test(triggerEvent);
    if (isUiEventHandler) continue;
    const file = ep.handler?.file || fileForNode(ep.source_node, nodeFile);
    const consumer = componentOf(file);
    const channel = ep.trigger?.event || ep.name || 'channel';
    seams.push({
      id: nextId('consume'),
      modality: 'async',
      confidence: 0.9,
      kind: 'messaging',
      source: String(channel),
      target: consumer,
      evidence: `entry:${ep.id} type=${ep.type}`,
      summary: `${String(channel)} --async--> ${consumer} (consume)`,
      metadata: { entry_type: ep.type, entry_point: ep.id },
    });
  }











  const lineage: CASEntityLineage[] = output.data_lineage || [];
  const passiveSeen = new Set<string>();
  for (const entity of lineage) {
    const writerComponents = new Set<string>();
    const readerComponents = new Set<string>();
    for (const w of entity.writers || []) {
      const c = componentOf(accessorFile(w));
      if (c && c !== 'unknown') writerComponents.add(c);
    }
    for (const r of entity.readers || []) {
      const c = componentOf(accessorFile(r));
      if (c && c !== 'unknown') readerComponents.add(c);
    }
    if (writerComponents.size === 0) continue;
    for (const writer of writerComponents) {
      for (const reader of readerComponents) {
        if (writer === reader) continue;



        const [a, b] = writer < reader ? [writer, reader] : [reader, writer];
        const key = `${a}|${b}|${entity.entity_name}`;
        if (passiveSeen.has(key)) continue;
        passiveSeen.add(key);
        seams.push({
          id: nextId('passive'),
          modality: 'passive',
          confidence: 0.7,
          kind: 'passive_state',
          source: writer,
          target: reader,
          evidence: `entity:${entity.entity_id} writer=${writer} reader=${reader}`,
          summary: `${writer} --passive(${entity.entity_name})--> ${reader} (shared state)`,
          shared_resource: entity.entity_name,
          metadata: { entity_id: entity.entity_id },
        });
      }
    }
  }

  const inventory = buildSeamInventory(seams, 'node');

  const result: CommunicationSeamsResult = { seams, inventory };



















  const distinctShipRoots = new Set(deployableRoots.map(r => r.root || '.'));
  if (distinctShipRoots.size >= 2) {
    result.deployable_inventory = buildSeamInventory(seams, 'deployable');
  }

  return result;
}















export function mergeSeams(
  base: CommunicationSeamsResult,
  extra: CommunicationSeam[],
): CommunicationSeamsResult {
  const seen = new Set(base.seams.map(s => s.id));
  const merged = [...base.seams];
  for (const s of extra) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    merged.push(s);
  }
  const result: CommunicationSeamsResult = {
    seams: merged,
    inventory: buildSeamInventory(merged, base.inventory.level),
  };
  if (base.deployable_inventory) {
    result.deployable_inventory = buildSeamInventory(merged, base.deployable_inventory.level);
  }
  return result;
}








export function buildSeamInventory(seams: CommunicationSeam[], level: SeamLevel): CommunicationSeamInventory {
  const counts = { sync: 0, async: 0, passive: 0, total: 0 };
  const byEdge = new Map<
    string,
    { source: string; target: string; sync: number; async: number; passive: number }
  >();
  for (const s of seams) {
    counts[s.modality] += 1;
    counts.total += 1;
    const key = `${s.source}=>${s.target}`;
    let edge = byEdge.get(key);
    if (!edge) {
      edge = { source: s.source, target: s.target, sync: 0, async: 0, passive: 0 };
      byEdge.set(key, edge);
    }
    edge[s.modality] += 1;
  }
  const component_seams = Array.from(byEdge.values())
    .map(e => {
      const modalities: SeamModality[] = [];
      if (e.sync > 0) modalities.push('sync');
      if (e.async > 0) modalities.push('async');
      if (e.passive > 0) modalities.push('passive');
      return { ...e, modalities, total: e.sync + e.async + e.passive };
    })
    .sort((a, b) => b.total - a.total || a.source.localeCompare(b.source));
  return { level, counts, component_seams };
}
