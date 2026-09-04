import type { CASEntryPoint, CASNode } from '../../types/cas.types';

export function productEntryPoints(
  entryPoints: CASEntryPoint[],
  nodes: CASNode[],
  isProductNode: (node: CASNode) => boolean,
  isProductPath: (filePath: string) => boolean,
): CASEntryPoint[] {
  const productNodeIds = new Set(nodes.filter(isProductNode).map(node => node.id));
  return entryPoints.filter(ep =>
    (!ep.source_node || productNodeIds.has(ep.source_node)) &&
    (!ep.handler?.file || isProductPath(ep.handler.file)));
}

function identifierWords(value: string | undefined): string[] {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map(word => word.toLowerCase())
    .filter(word => word.length >= 3);
}

export function libraryApiEvidenceExamples(
  entryPoints: CASEntryPoint[],
  nodeById: Map<string, CASNode>,
): string[] {
  const examples = new Set<string>();
  for (const ep of entryPoints) {
    if (ep.type !== 'api' && ep.type !== 'rpc') continue;
    const node = nodeById.get(ep.handler?.node_id || '') || nodeById.get(ep.source_node || '');
    if (!node) continue;
    const attributes = ((node.metadata as Record<string, unknown> | undefined)?.attributes || {}) as Record<string, unknown>;
    const attributeParameters = Array.isArray(attributes.parameters) ? attributes.parameters as Array<{ name?: string; annotation?: string }> : [];
    const words = [
      ...identifierWords(node.name),
      ...(node.signature?.parameters || []).flatMap(parameter => identifierWords(parameter.name)),
      ...attributeParameters.flatMap(parameter => [...identifierWords(parameter.name), ...identifierWords(parameter.annotation)]),
      ...identifierWords(node.signature?.return_type),
      ...identifierWords(typeof attributes.returnAnnotation === 'string' ? attributes.returnAnnotation : undefined),
      ...identifierWords(node.documentation?.summary || node.documentation?.raw?.split(/\n/)[0]),
    ];
    if (words.length > 0) examples.add(`${node.name}: ${[...new Set(words)].join(' ')}`);
  }
  return [...examples];
}

export function libraryApiEvidenceFields(
  entryPoints: CASEntryPoint[],
  nodeById: Map<string, CASNode>,
): { evidence_examples?: string[] } {
  const examples = libraryApiEvidenceExamples(entryPoints, nodeById);
  return examples.length > 0 ? { evidence_examples: examples } : {};
}
