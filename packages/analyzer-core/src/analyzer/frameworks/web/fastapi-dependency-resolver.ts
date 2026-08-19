import { generateNodeId } from '../../../types/cas.types';

export interface FastAPIDependencyDefinition {
  name: string;
  filePath: string;
  nodeId: string;
  dependencies: string[];
}

export interface FastAPIDependencySource {
  nodeId: string;
  filePath: string;
  dependencies: string[];
}

export interface FastAPIDependencyLink {
  sourceId: string;
  targetId: string;
  targetName: string;
  targetFile: string;
  resolved: boolean;
}

export function fastApiDependencyNodeId(filePath: string, name: string): string {
  return generateNodeId('dependency', filePath, name);
}

export function planFastAPIDependencyLinks(sources: FastAPIDependencySource[], definitions: FastAPIDependencyDefinition[]): FastAPIDependencyLink[] {
  const byName = new Map<string, FastAPIDependencyDefinition[]>();
  for (const definition of definitions) {
    const candidates = byName.get(definition.name) || [];
    candidates.push(definition);
    byName.set(definition.name, candidates);
  }
  const links: FastAPIDependencyLink[] = [];
  for (const source of sources) {
    for (const targetName of source.dependencies) {
      const target = selectDefinition(byName.get(targetName) || [], source.filePath);
      links.push(target ? {
        sourceId: source.nodeId, targetId: target.nodeId, targetName, targetFile: target.filePath, resolved: true
      } : {
        sourceId: source.nodeId,
        targetId: generateNodeId('dependency_reference', source.filePath, targetName),
        targetName,
        targetFile: source.filePath,
        resolved: false
      });
    }
  }
  return links;
}

function selectDefinition(candidates: FastAPIDependencyDefinition[], sourceFile: string): FastAPIDependencyDefinition | undefined {
  const sameFile = candidates.find(candidate => candidate.filePath === sourceFile);
  if (sameFile) return sameFile;
  if (candidates.length === 1) return candidates[0];
  const ranked = candidates.map(candidate => ({ candidate, score: commonPrefix(candidate.filePath, sourceFile) }))
    .sort((left, right) => right.score - left.score || left.candidate.nodeId.localeCompare(right.candidate.nodeId));
  return ranked[0] && (!ranked[1] || ranked[0].score > ranked[1].score) ? ranked[0].candidate : undefined;
}

function commonPrefix(left: string, right: string): number {
  const a = left.replace(/\\/g, '/').split('/');
  const b = right.replace(/\\/g, '/').split('/');
  let count = 0;
  while (count < a.length && count < b.length && a[count] === b[count]) count++;
  return count;
}
