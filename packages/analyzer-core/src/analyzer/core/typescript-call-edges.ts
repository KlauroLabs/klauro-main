import type { CASEdge, CASNode } from '../../types/cas.types';
import { resolveTypeScriptMemberCalls, typeScriptResolutionEnabled } from './typescript-call-resolution';
import type { ResolvedMemberCall } from './typescript-call-resolution';

const CODE_NODE_TYPES = new Set(['function', 'method', 'constructor', 'getter', 'setter']);

interface Span {
  id: string;
  start: number;
  end: number;
}

function spansByFile(nodes: readonly CASNode[]): Map<string, Span[]> {
  const byFile = new Map<string, Span[]>();
  for (const node of nodes) {
    if (!CODE_NODE_TYPES.has(String(node.type))) continue;
    const file = node.source?.file;
    const start = node.source?.line;
    if (!file || typeof start !== 'number') continue;
    const end = typeof node.source?.end_line === 'number' ? node.source.end_line : start;
    const bucket = byFile.get(file);
    const span = { id: node.id, start, end };
    if (bucket) bucket.push(span);
    else byFile.set(file, [span]);
  }
  return byFile;
}

function lookupKey(file: string): string {
  const normalized = file.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts.slice(-3).join('/');
}

function tightestContaining(spans: readonly Span[] | undefined, line: number): string | undefined {
  if (!spans) return undefined;
  let best: Span | undefined;
  for (const span of spans) {
    if (line < span.start || line > span.end) continue;
    if (!best || (span.end - span.start) < (best.end - best.start)) best = span;
  }
  return best?.id;
}

function startingAt(spans: readonly Span[] | undefined, line: number): string | undefined {
  if (!spans) return undefined;
  let best: Span | undefined;
  for (const span of spans) {
    if (span.start !== line) continue;
    if (!best || (span.end - span.start) < (best.end - best.start)) best = span;
  }
  return best?.id;
}

export function buildTypeScriptCallEdges(
  nodes: readonly CASNode[],
  existingCallPairs: Set<string>,
  resolved: readonly ResolvedMemberCall[]
): CASEdge[] {
  const byFile = spansByFile(nodes);
  const bySuffix = new Map<string, Span[]>();
  for (const [file, spans] of byFile) {
    const key = lookupKey(file);
    const bucket = bySuffix.get(key);
    if (bucket) bucket.push(...spans);
    else bySuffix.set(key, [...spans]);
  }
  const spansFor = (file: string): Span[] | undefined => byFile.get(file) || bySuffix.get(lookupKey(file));

  const edges: CASEdge[] = [];
  const seen = new Set<string>();
  for (const call of resolved) {
    const source = tightestContaining(spansFor(call.fromFile), call.fromLine);
    if (!source) continue;
    const target = startingAt(spansFor(call.toFile), call.toLine)
      || tightestContaining(spansFor(call.toFile), call.toLine);
    if (!target || target === source) continue;
    const pair = `${source}\u0000${target}`;
    if (seen.has(pair) || existingCallPairs.has(pair)) continue;
    seen.add(pair);
    edges.push({
      id: `ts_type_calls_${source}_${target}`,
      source,
      target,
      type: 'calls',
      metadata: {
        attributes: {
          source_analyzer: 'typescript-type-resolution',
          contribution_scope: 'derived-rebuild',
          relationship: 'resolved_member_call',
          member: call.name
        }
      }
    });
  }
  return edges;
}

export function applyTypeScriptCallEdges(
  nodes: readonly CASNode[],
  edges: CASEdge[],
  report: (label: string, detail: Record<string, number>) => void,
  projectPath?: string
): void {
  if (!typeScriptResolutionEnabled()) return;
  const files = [...new Set(nodes.map(node => node.source?.file).filter((file): file is string => Boolean(file)))];
  const resolution = resolveTypeScriptMemberCalls(files, projectPath);
  const existingCallPairs = new Set<string>();
  for (const edge of edges) {
    if (edge.type === 'calls') existingCallPairs.add(`${edge.source}\u0000${edge.target}`);
  }
  const added = buildTypeScriptCallEdges(nodes, existingCallPairs, resolution.calls);
  edges.push(...added);
  report('[Klauro] typescript type resolution:', {
    files: resolution.filesConsidered,
    filesMissing: resolution.filesMissing,
    memberCalls: resolution.memberCallsSeen,
    inRepo: resolution.calls.length,
    external: resolution.resolvedExternal,
    unresolved: resolution.unresolved,
    edgesAdded: added.length
  });
}
