import type { CASEdge, CASEntryPoint, CASNode } from '../../types/cas.types';

const MAX_LINE_DRIFT = 2;

export const ROUTE_LINKABLE_ENTRY_TYPES = new Set(['http', 'websocket', 'message', 'event', 'cli']);

const UNLINKED_HANDLER_TYPES = new Set(['file', 'route', 'application', 'component']);

function registrationLine(entryPoint: CASEntryPoint, current: CASNode): number | undefined {
  const attributes = (entryPoint.metadata || {}) as Record<string, unknown>;
  for (const candidate of [attributes.line, entryPoint.handler?.line, current.source?.line]) {
    if (typeof candidate === 'number' && candidate > 0) return candidate;
  }
  return undefined;
}

function handlerFile(entryPoint: CASEntryPoint, current: CASNode): string | undefined {
  const file = entryPoint.handler?.file;
  if (typeof file === 'string' && file.length > 0) return file;
  const attributes = (entryPoint.metadata || {}) as Record<string, unknown>;
  if (typeof attributes.file === 'string' && attributes.file.length > 0) return attributes.file;
  return current.source?.file;
}

export function resolveRegistrationHandlerByLine(
  entryPoint: CASEntryPoint,
  nodeById: Map<string, CASNode>,
  functionNodesByFile: Map<string, CASNode[]>,
  edges: CASEdge[],
  existingEdgeIds: Set<string>
): boolean {
  const current = entryPoint.handler?.node_id ? nodeById.get(entryPoint.handler.node_id) : undefined;
  if (!current || !UNLINKED_HANDLER_TYPES.has(current.type)) return false;

  const line = registrationLine(entryPoint, current);
  const file = handlerFile(entryPoint, current);
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
