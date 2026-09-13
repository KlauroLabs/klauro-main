import type { CASEdge, CASEntryPoint, CASNode } from '../../types/cas.types';

const MAX_LINE_DRIFT = 2;

export const ROUTE_LINKABLE_ENTRY_TYPES = new Set(['http', 'websocket', 'message', 'event', 'cli']);

function registrationLine(entryPoint: CASEntryPoint): number | undefined {
  const attributes = (entryPoint.metadata || {}) as Record<string, unknown>;
  const line = attributes.line;
  return typeof line === 'number' && line > 0 ? line : undefined;
}

function handlerFile(entryPoint: CASEntryPoint): string | undefined {
  const file = entryPoint.handler?.file;
  if (typeof file === 'string' && file.length > 0) return file;
  const attributes = (entryPoint.metadata || {}) as Record<string, unknown>;
  return typeof attributes.file === 'string' ? attributes.file : undefined;
}

export function resolveRegistrationHandlerByLine(
  entryPoint: CASEntryPoint,
  nodeById: Map<string, CASNode>,
  functionNodesByFile: Map<string, CASNode[]>,
  edges: CASEdge[],
  existingEdgeIds: Set<string>
): boolean {
  const current = entryPoint.handler?.node_id ? nodeById.get(entryPoint.handler.node_id) : undefined;
  if (!current || current.type !== 'file') return false;

  const line = registrationLine(entryPoint);
  const file = handlerFile(entryPoint);
  if (line === undefined || !file) return false;

  const candidates: CASNode[] = [];
  const exact = functionNodesByFile.get(file);
  if (exact) candidates.push(...exact);
  else {
    const suffix = `/${file}`;
    for (const [candidateFile, group] of functionNodesByFile) {
      if (candidateFile.endsWith(suffix) || file.endsWith(`/${candidateFile}`)) candidates.push(...group);
    }
  }

  let best: CASNode | undefined;
  for (const candidate of candidates) {
    const start = candidate.source?.line;
    if (typeof start !== 'number') continue;
    if (start < line || start > line + MAX_LINE_DRIFT) continue;
    const bestStart = best?.source?.line ?? Number.MAX_SAFE_INTEGER;
    const bestSpan = (best?.source?.end_line ?? 0) - bestStart;
    const span = (candidate.source?.end_line ?? start) - start;
    if (start < bestStart || (start === bestStart && span < bestSpan)) best = candidate;
  }
  if (!best || best.id === current.id) return false;

  entryPoint.handler = {
    ...(entryPoint.handler || {}),
    node_id: best.id,
    method_name: best.name,
    file,
    line: best.source?.line ?? line
  };

  const edgeId = `registration_calls_${current.id}_${best.id}`;
  if (!existingEdgeIds.has(edgeId)) {
    edges.push({
      id: edgeId,
      source: current.id,
      target: best.id,
      type: 'calls',
      metadata: {
        attributes: {
          source_analyzer: 'orchestrator',
          contribution_scope: 'derived-rebuild',
          relationship: 'registration_handler',
          entry_point_type: entryPoint.type
        }
      }
    });
    existingEdgeIds.add(edgeId);
  }
  return true;
}
