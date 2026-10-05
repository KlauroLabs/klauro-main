import type { CASNode, CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { isContainer, refOfNode, viewOf, type GraphView, type NodeRef } from './analysis-graph-view';

export type RenameBasis = 'signature+callees' | 'signature+callers+size' | 'members' | 'follows-renamed-container';

export interface MatchedRename {
  kind: string;
  from: NodeRef;
  to: NodeRef;
  basis: RenameBasis;
}

export interface AmbiguousRename {
  kind: string;
  removed: string[];
  added: string[];
}

export interface RenameMatch {
  renames: MatchedRename[];
  ambiguous: AmbiguousRename[];
  idMap: Map<string, string>;
}

const PASSES = 4;
const AMBIGUOUS_LIMIT = 10;

function shapeOf(node: CASNode): string | undefined {
  const signature = node.signature;
  if (signature === undefined) return undefined;
  const parameters = (signature.parameters ?? [])
    .map(parameter => `${(parameter.type ?? '_').replace(/\s+/g, '')}${parameter.optional || parameter.default_value !== undefined ? '?' : ''}`)
    .join(',');
  const modifiers = `${node.metadata?.is_async ? 'async' : ''}${node.metadata?.is_static ? 'static' : ''}`;
  return `(${parameters})->${(signature.return_type ?? '_').replace(/\s+/g, '')}<${(signature.type_parameters ?? []).length}>${modifiers}`;
}

function span(node: CASNode): number {
  return (node.source?.end_line ?? node.source?.line ?? 0) - (node.source?.line ?? 0);
}

interface Keyed {
  key: string;
  basis: RenameBasis;
}

function fingerprint(view: GraphView, node: CASNode, mapped: (id: string) => string): Keyed | undefined {
  if (isContainer(node)) {
    const members = view.members(node.id).map(member => `${member.type}:${member.name}`).sort();
    return members.length === 0 ? undefined : { key: `members=${members.join(',')}`, basis: 'members' };
  }
  const shape = shapeOf(node);
  if (shape === undefined) return undefined;
  const callees = view.callees(node.id).map(mapped).sort();
  if (callees.length > 0) return { key: `sig=${shape};callees=${callees.join(',')}`, basis: 'signature+callees' };
  const callers = view.callers(node.id).map(mapped).sort();
  if (callers.length === 0) return undefined;
  return { key: `sig=${shape};lines=${span(node)};callers=${callers.join(',')}`, basis: 'signature+callers+size' };
}

function bucket<T>(held: Map<string, T[]>, key: string, value: T): void {
  const list = held.get(key) ?? [];
  list.push(value);
  held.set(key, list);
}

export function matchRenames(baseline: CASOutput, proposed: CASOutput): RenameMatch {
  const before = viewOf(baseline);
  const after = viewOf(proposed);
  const removed = before.declarations.filter(node => after.node(node.id) === undefined);
  const added = after.declarations.filter(node => before.node(node.id) === undefined);
  const idMap = new Map<string, string>();
  const taken = new Set<string>();
  const renames: MatchedRename[] = [];
  const mapped = (id: string) => idMap.get(id) ?? id;
  const accept = (from: CASNode, to: CASNode, basis: RenameBasis) => {
    idMap.set(from.id, to.id);
    taken.add(to.id);
    renames.push({ kind: from.type, from: refOfNode(from, from.id), to: refOfNode(to, to.id), basis });
  };
  const open = <T extends CASNode>(nodes: T[], side: 'from' | 'to') =>
    nodes.filter(node => (side === 'from' ? !idMap.has(node.id) : !taken.has(node.id)));
  let ambiguous: AmbiguousRename[] = [];
  for (let pass = 0; pass < PASSES; pass++) {
    const matched = renames.length;
    const gone = new Map<string, CASNode[]>();
    const came = new Map<string, CASNode[]>();
    const follows = new Map<string, { gone: CASNode[]; came: CASNode[] }>();
    for (const node of open(removed, 'from')) {
      const container = node.parent === undefined ? '' : mapped(node.parent);
      if (node.parent !== undefined && container !== node.parent) {
        const held = follows.get(`${node.type}|${container}|${node.name}`) ?? { gone: [], came: [] };
        held.gone.push(node);
        follows.set(`${node.type}|${container}|${node.name}`, held);
      }
      const print = fingerprint(before, node, mapped);
      if (print !== undefined) bucket(gone, `${node.type}|${container}|${print.key}`, node);
    }
    for (const node of open(added, 'to')) {
      const held = follows.get(`${node.type}|${node.parent ?? ''}|${node.name}`);
      if (held !== undefined) held.came.push(node);
      const print = fingerprint(after, node, id => id);
      if (print !== undefined) bucket(came, `${node.type}|${node.parent ?? ''}|${print.key}`, node);
    }
    for (const held of follows.values()) {
      if (held.gone.length === 1 && held.came.length === 1) accept(held.gone[0], held.came[0], 'follows-renamed-container');
    }
    ambiguous = [];
    for (const [key, list] of gone) {
      const arrived = (came.get(key) ?? []).filter(node => !taken.has(node.id));
      const leaving = list.filter(node => !idMap.has(node.id));
      if (arrived.length === 0 || leaving.length === 0) continue;
      if (leaving.length === 1 && arrived.length === 1) {
        const print = fingerprint(before, leaving[0], mapped);
        accept(leaving[0], arrived[0], print?.basis ?? 'signature+callees');
      } else if (ambiguous.length < AMBIGUOUS_LIMIT) {
        ambiguous.push({ kind: leaving[0].type, removed: leaving.map(node => node.id), added: arrived.map(node => node.id) });
      }
    }
    if (renames.length === matched) break;
  }
  const settled = ambiguous.filter(held => held.removed.every(id => !idMap.has(id)) && held.added.every(id => !taken.has(id)));
  return { renames, ambiguous: settled, idMap };
}
