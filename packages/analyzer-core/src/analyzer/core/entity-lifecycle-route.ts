import type { CASNode } from '../../types/cas.types';

export type EntityLifecycleOperation = 'create' | 'read' | 'update' | 'delete';

export interface RouteLifecycleAttribution {
  operation: EntityLifecycleOperation;
  resource?: string;
}

export function routeLifecycleAttribution(
  node: CASNode,
  knownDataNouns: Set<string>,
  singularize: (value: string) => string
): RouteLifecycleAttribution | undefined {
  if (node.type !== 'route') return undefined;
  const attributes = node.metadata?.attributes as Record<string, unknown> | undefined;
  const operation = routeOperation(String(attributes?.method || ''));
  if (!operation) return undefined;
  const resource = String(attributes?.path || node.name || '')
    .split(/[/?#]/)
    .filter(segment => segment && !segment.startsWith(':'))
    .map(segment => singularize(segment.toLowerCase()))
    .filter(segment => knownDataNouns.has(segment))
    .pop();
  return { operation, resource };
}

function routeOperation(method: string): EntityLifecycleOperation | undefined {
  switch (method.toLowerCase()) {
    case 'post': return 'create';
    case 'get':
    case 'head':
    case 'options': return 'read';
    case 'put':
    case 'patch': return 'update';
    case 'delete': return 'delete';
    default: return undefined;
  }
}
