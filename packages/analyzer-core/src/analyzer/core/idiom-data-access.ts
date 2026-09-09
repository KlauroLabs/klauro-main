import type { CASCodebaseIdiom, CASExitPoint, CASIdiomEvidence, CASLibrary, CASNode } from '../../types/cas.types';

export function describeDataAccessMechanisms(
  dataNodes: readonly CASNode[],
  libraries: readonly CASLibrary[],
  exitPoints: readonly CASExitPoint[],
  sourceNodes: readonly CASNode[],
): {
  label: string;
  guidance: CASCodebaseIdiom['agent_guidance'];
  exitEvidence: CASIdiomEvidence[];
  exitFiles: string[];
} {
  const jsonStores = dataNodes.filter(node => storageAttribute(node, 'persistence') === 'json-file');
  const processStores = dataNodes.filter(node => storageAttribute(node, 'storage_scope') === 'process');
  const explicitStores = new Set([...jsonStores, ...processStores]);
  const declarations = dataNodes.filter(node => !explicitStores.has(node));
  const repositories = declarations.filter(node => /^(repository|repo|dao)$/.test(node.type));
  const labels: string[] = [];
  const guidance: CASCodebaseIdiom['agent_guidance'] = {
    do: [],
    avoid: ['Do not assume one data-access mechanism applies outside the cited scope or introduce a repository/ORM layer without evidence.'],
    validation: ['Check data-shape changes against the cited consumers and focused tests.', 'Trace the affected reads and writes before selecting a persistence boundary.'],
  };

  if (jsonStores.length > 0) {
    labels.push('JSON file stores');
    guidance.do.push('For JSON-file stores in the cited scope, preserve serialization formats and read/write behavior.');
  }
  if (processStores.length > 0) {
    labels.push('process-local record collections');
    guidance.do.push('For process-local collections in the cited scope, preserve record shape and process lifetime assumptions.');
  }
  if (libraries.length > 0) {
    const libraryNames = libraries.map(library => library.name).slice(0, 2).join('/');
    labels.push(`detected ${libraryNames}`);
    guidance.do.push(`For changes involving ${libraryNames}, inspect its existing calls and declarations in the affected scope.`);
  }
  if (repositories.length > 0) labels.push('repository declarations');
  if (declarations.length > repositories.length) labels.push('model/schema declarations');
  if (declarations.length > 0) {
    guidance.do.push('Preserve the contracts of the cited data-access declarations and their callers; declarations alone do not establish a repository boundary.');
  }
  if (exitPoints.length > 0) {
    labels.push('database calls');
    guidance.do.push('Preserve the observed database operations and their query, transaction, and error-handling behavior in the affected scope.');
  }

  const sourceIds = new Set(exitPoints.map(exitPoint => exitPoint.source_node));
  const sources = new Map(sourceNodes.filter(node => sourceIds.has(node.id)).map(node => [node.id, node]));
  const exitEvidence = exitPoints.slice(0, 3).map((exitPoint): CASIdiomEvidence => {
    const source = sources.get(exitPoint.source_node);
    return {
      kind: source ? 'node' : 'analysis-fact',
      node_id: source?.id,
      file: source?.source?.file,
      line: source?.source?.line,
      claim: `Database effect recorded: ${exitPoint.name} (exit ${exitPoint.id})${source ? '.' : '; source declaration is not linked.'}`,
      confidence: 0.78,
    };
  });
  const exitFiles = [...new Set([...sources.values()].flatMap(node => node.source?.file ? [node.source.file] : []))];
  return { label: labels.join(' and '), guidance, exitEvidence, exitFiles };
}

function storageAttribute(node: CASNode, name: string): unknown {
  return (node.metadata as Record<string, unknown> | undefined)?.[name] ?? node.metadata?.attributes?.[name];
}
