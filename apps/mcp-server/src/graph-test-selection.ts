import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

const DEPTH_LIMIT = 12;
const VISIT_LIMIT = 250_000;
const WALKED = new Set(['calls', 'instantiates']);

export interface GraphTestMatch {
  file: string;
  test: string;
  hops: number;
  basis: 'exact-by-graph' | 'graph-with-name-guess';
}

interface Reverse {
  exact: Map<string, string[]>;
  guessed: Map<string, string[]>;
}

const reverseIndexes = new WeakMap<CASOutput, Reverse>();

function reverseOf(cas: CASOutput): Reverse {
  const held = reverseIndexes.get(cas);
  if (held) return held;
  const built: Reverse = { exact: new Map(), guessed: new Map() };
  for (const edge of cas.edges ?? []) {
    if (!WALKED.has(edge.type)) continue;
    const guess = edge.metadata?.attributes?.via === 'name';
    const side = guess ? built.guessed : built.exact;
    const into = side.get(edge.target);
    if (into) into.push(edge.source);
    else side.set(edge.target, [edge.source]);
  }
  reverseIndexes.set(cas, built);
  return built;
}

function upstream(starts: string[], sides: Array<Map<string, string[]>>): Map<string, number> {
  const hops = new Map<string, number>(starts.map(id => [id, 0]));
  let frontier = starts;
  for (let depth = 1; depth <= DEPTH_LIMIT && frontier.length > 0 && hops.size < VISIT_LIMIT; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const side of sides) {
        for (const caller of side.get(id) ?? []) {
          if (hops.has(caller)) continue;
          hops.set(caller, depth);
          next.push(caller);
        }
      }
    }
    frontier = next;
  }
  return hops;
}

export function testsReaching(cas: CASOutput, targets: string[]): GraphTestMatch[] {
  const handlers = new Map<string, string>();
  for (const entry of cas.entry_points ?? []) {
    if (String(entry.type) !== 'test' || !entry.source_node) continue;
    const handler = cas.nodes.find(node => node.id === entry.source_node);
    if (handler?.source?.file) handlers.set(entry.source_node, handler.source.file);
  }
  if (handlers.size === 0 || targets.length === 0) return [];
  const { exact, guessed } = reverseOf(cas);
  const surely = upstream(targets, [exact]);
  const maybe = upstream(targets, [exact, guessed]);
  const found = new Map<string, GraphTestMatch>();
  const consider = (reached: Map<string, number>, basis: GraphTestMatch['basis']) => {
    for (const [handler, file] of handlers) {
      const hops = reached.get(handler);
      if (hops === undefined) continue;
      const held = found.get(file);
      if (held && (held.basis === 'exact-by-graph' || held.hops <= hops)) continue;
      found.set(file, { file, test: handler.split(':').pop() ?? handler, hops, basis });
    }
  };
  consider(surely, 'exact-by-graph');
  consider(maybe, 'graph-with-name-guess');
  return [...found.values()].sort((left, right) =>
    (left.basis === right.basis ? 0 : left.basis === 'exact-by-graph' ? -1 : 1) || left.hops - right.hops);
}
