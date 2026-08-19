import type { CASNode, CASEdge, CASExitPoint } from '../../types/cas.types';

const REPOSITORY_TYPES = new Set([
  'Repository',
  'CrudRepository',
  'ListCrudRepository',
  'PagingAndSortingRepository',
  'ListPagingAndSortingRepository',
  'JpaRepository',
]);

const INHERITED_OPERATIONS = new Set([
  'save',
  'saveAll',
  'saveAndFlush',
  'findById',
  'findAll',
  'findAllById',
  'getReferenceById',
  'existsById',
  'count',
  'delete',
  'deleteById',
  'deleteAll',
  'deleteAllById',
  'flush',
]);

export function simpleJavaType(type: string): string {
  return type.replace(/<.*$/, '').replace(/\[\]/g, '').replace(/\.\.\.$/, '').trim().split('.').pop() || type;
}

function repositoryBase(node: CASNode): string | undefined {
  const attributes = (node.metadata?.attributes || node.metadata || {}) as Record<string, unknown>;
  const extendedTypes = Array.isArray(attributes.extends)
    ? attributes.extends.filter((type): type is string => typeof type === 'string')
    : [];
  return extendedTypes.map(simpleJavaType).find(type => REPOSITORY_TYPES.has(type));
}

export function inheritedSpringDataOperation(
  repositoryNode: CASNode,
  methodName: string,
  existingMethods: CASNode[],
): { node: CASNode; edge: CASEdge; exitPoint: CASExitPoint } | undefined {
  const inheritedFrom = repositoryBase(repositoryNode);
  if (!inheritedFrom || !INHERITED_OPERATIONS.has(methodName)) return undefined;
  const methodId = `method_${repositoryNode.id}_inherited_${methodName.replace(/[^a-zA-Z0-9]/g, '_')}`;
  if (existingMethods.some(node => node.id === methodId)) return undefined;
  const node: CASNode = {
    id: methodId,
    name: methodName,
    type: 'repository_operation',
    level: 4,
    level_name: 'Method/Function',
    category: 'repository',
    subcategories: ['database', 'spring-data', 'inherited-operation'],
    source: repositoryNode.source,
    parent: repositoryNode.id,
    analyzers: ['java'],
    metadata: {
      framework: 'spring-data',
      attributes: { inherited_from: inheritedFrom, repository: repositoryNode.name },
    },
  };
  return {
    node,
    edge: {
      id: `${repositoryNode.id}_declares_${methodId}`,
      source: repositoryNode.id,
      target: methodId,
      type: 'declares',
      category: 'structural',
      metadata: { attributes: { inherited_from: inheritedFrom } },
    },
    exitPoint: {
      id: `exit_${methodId}`,
      source_node: methodId,
      source_analyzer: 'java',
      type: 'database',
      name: `${repositoryNode.name}.${methodName}`,
      description: `Spring Data ${inheritedFrom} persistence operation`,
      target: { resource: repositoryNode.name },
      operation: { action: methodName },
      metadata: { framework: 'spring-data', inherited_from: inheritedFrom },
    },
  };
}
