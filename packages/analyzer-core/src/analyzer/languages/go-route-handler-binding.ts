import * as path from 'path';
import type { CASEntryPoint, CASNode } from '../../types/cas.types';

export function bindGoHttpRouteHandlers(nodes: CASNode[], entryPoints: CASEntryPoint[]): void {
  const candidatesByPackageAndName = new Map<string, CASNode[]>();
  for (const node of nodes) {
    if ((node.type !== 'function' && node.type !== 'method') || !node.source?.file) continue;
    const key = `${path.posix.dirname(node.source.file)}::${node.name}`;
    const candidates = candidatesByPackageAndName.get(key) || [];
    candidates.push(node);
    candidatesByPackageAndName.set(key, candidates);
  }

  for (const entryPoint of entryPoints) {
    if (entryPoint.metadata?.framework !== 'go' || entryPoint.metadata?.kind !== 'route') continue;
    if (!entryPoint.handler?.method_name || entryPoint.handler.node_id) continue;
    const file = entryPoint.handler.file || entryPoint.metadata?.file;
    if (!file) continue;
    const packagePath = path.posix.dirname(String(file).replace(/\\/g, '/'));
    const candidates = candidatesByPackageAndName.get(`${packagePath}::${entryPoint.handler.method_name}`) || [];
    const candidatesByDeclaration = new Map<string, CASNode[]>();
    for (const candidate of candidates) {
      const line = candidate.source?.line;
      if (line === undefined) continue;
      const declarationKey = `${candidate.source!.file}::${line}`;
      const sameDeclaration = candidatesByDeclaration.get(declarationKey) || [];
      sameDeclaration.push(candidate);
      candidatesByDeclaration.set(declarationKey, sameDeclaration);
    }
    if (candidatesByDeclaration.size !== 1) continue;
    const sameDeclaration = [...candidatesByDeclaration.values()][0];
    const resolved = sameDeclaration.find(candidate => candidate.type === 'method') || sameDeclaration[0];
    entryPoint.handler = {
      ...entryPoint.handler,
      node_id: resolved.id,
      file: resolved.source!.file,
      ...(resolved.source?.line !== undefined ? { line: resolved.source.line } : {}),
    };
  }
}
