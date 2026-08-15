import type { CASEntryPoint, CASNode } from '../../types/cas.types';

export function rankHandlerCandidateFiles(
  candidateFiles: Iterable<string>,
  locations: ReadonlyArray<string | undefined>,
): string[] {
  const targets = locations.map(normalizePath).filter(Boolean);
  return [...candidateFiles]
    .map(file => ({ file, score: Math.max(0, ...targets.map(target => pathMatchScore(normalizePath(file), target))) }))
    .filter(candidate => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file))
    .map(candidate => candidate.file);
}

export function permitsGlobalHandlerFallback(entryType: string, handlerName: string): boolean {
  return entryType !== 'cli' || !/^(?:main|application|server|index)(?:\.[a-z0-9]+)?$/i.test(handlerName);
}

export function anchorUnresolvedCliHandler(
  entryPoint: CASEntryPoint,
  sourceNode: CASNode | undefined,
  unresolvedCandidate: string,
): void {
  if (entryPoint.type !== 'cli' || !sourceNode) return;
  entryPoint.handler = {
    ...(entryPoint.handler || {}),
    node_id: sourceNode.id,
    method_name: entryPoint.handler?.method_name || entryPoint.name,
    file: entryPoint.handler?.file || sourceNode.source?.file,
    line: entryPoint.handler?.line || sourceNode.source?.line,
  };
  entryPoint.metadata = {
    ...entryPoint.metadata,
    handler_resolution: 'registration-node',
    unresolved_handler_candidate: unresolvedCandidate,
  };
}

function normalizePath(value: string | undefined): string {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function pathMatchScore(candidate: string, target: string): number {
  if (!candidate || !target) return 0;
  if (candidate === target) return 3;
  if (candidate.endsWith(`/${target}`) || target.endsWith(`/${candidate}`)) return 2;
  return 0;
}
