import type { CASNode, CASPerspective } from '../../types/cas.types';

export function buildPerspectiveHierarchy(node: CASNode, perspective: CASPerspective): string[] {
  const hierarchy: string[] = [];

  if (perspective.type === 'flow') {
    hierarchy.push('flow');
    if (node.category) hierarchy.push(node.category);
    hierarchy.push(node.type);
  } else if (perspective.type === 'structure') {
    hierarchy.push('structure');
    if (node.category) hierarchy.push(node.category);
    if (node.subcategories?.[0]) hierarchy.push(node.subcategories[0]);
  } else if (perspective.type === 'security') {
    hierarchy.push('security');
    hierarchy.push(node.type);
  } else {
    hierarchy.push(perspective.type);
    if (node.category) hierarchy.push(node.category);
  }

  hierarchy.push(node.name);
  return hierarchy;
}

export function calculatePerspectivePriority(node: CASNode, perspective: CASPerspective): number {
  let priority = 50;

  if (node.metadata?.is_exported) priority += 20;
  if (node.type === 'class' || node.type === 'module') priority += 10;
  if (node.type === 'function' || node.type === 'method') priority += 5;

  if (perspective.type === 'flow' && (node.type === 'controller' || node.type === 'route' || node.type === 'endpoint')) {
    priority += 30;
  }
  if (perspective.type === 'data' && (node.type === 'entity' || node.type === 'model' || node.type === 'schema')) {
    priority += 30;
  }

  return Math.min(100, priority);
}
