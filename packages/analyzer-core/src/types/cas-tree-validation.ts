import type { CASOutput } from './cas.types';

export interface CASTreeValidationIssue {
  code:
    | 'missing-id'
    | 'duplicate-id'
    | 'root-parent'
    | 'parent-mismatch'
    | 'cycle'
    | 'missing-composition-mode'
    | 'leaf-composition-mode'
    | 'empty-children'
    | 'missing-graph';
  cas_id?: string;
  path: string[];
  message: string;
}

export interface CASTreeValidationResult {
  valid: boolean;
  node_count: number;
  max_depth: number;
  issues: CASTreeValidationIssue[];
}

export function hasCasChildren(cas: CASOutput): boolean {
  return Array.isArray(cas.children) && cas.children.length > 0;
}

export function walkCasTree(root: CASOutput): Array<{ cas: CASOutput; depth: number; path: string[] }> {
  const visited = new Set<CASOutput>();
  const rows: Array<{ cas: CASOutput; depth: number; path: string[] }> = [];
  const stack: Array<{ cas: CASOutput; depth: number; path: string[] }> = [{
    cas: root,
    depth: 0,
    path: [root.id || '<missing-id>'],
  }];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current.cas)) continue;
    visited.add(current.cas);
    rows.push(current);
    const children = current.cas.children || [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      stack.push({ cas: child, depth: current.depth + 1, path: [...current.path, child.id || '<missing-id>'] });
    }
  }

  return rows;
}

export function validateCasTree(root: CASOutput): CASTreeValidationResult {
  const issues: CASTreeValidationIssue[] = [];
  const ids = new Set<string>();
  const activeObjects = new Set<CASOutput>();
  const visitedObjects = new Set<CASOutput>();
  let nodeCount = 0;
  let maxDepth = 0;

  const visit = (cas: CASOutput, expectedParentId: string | null, depth: number, path: string[]): void => {
    nodeCount += 1;
    maxDepth = Math.max(maxDepth, depth);
    const casId = cas.id;
    const currentPath = [...path, casId || '<missing-id>'];

    if (activeObjects.has(cas)) {
      issues.push({ code: 'cycle', cas_id: casId, path: currentPath, message: 'CAS children contain an object cycle.' });
      return;
    }
    if (visitedObjects.has(cas)) {
      issues.push({ code: 'cycle', cas_id: casId, path: currentPath, message: 'The same CAS object is reachable through more than one parent.' });
      return;
    }
    visitedObjects.add(cas);
    activeObjects.add(cas);

    if (!casId) issues.push({ code: 'missing-id', path: currentPath, message: 'Every CAS in the tree requires a stable id.' });
    else if (ids.has(casId)) issues.push({ code: 'duplicate-id', cas_id: casId, path: currentPath, message: `CAS id ${casId} occurs more than once.` });
    else ids.add(casId);

    if (depth === 0) {
      if (cas.parent_id !== null && cas.parent_id !== undefined) {
        issues.push({ code: 'root-parent', cas_id: casId, path: currentPath, message: 'The root CAS cannot declare a parent id.' });
      }
    } else if (cas.parent_id !== expectedParentId) {
      issues.push({
        code: 'parent-mismatch', cas_id: casId, path: currentPath,
        message: `CAS parent_id ${String(cas.parent_id)} does not match its containing parent ${String(expectedParentId)}.`,
      });
    }

    if (!Array.isArray(cas.nodes) || !Array.isArray(cas.edges)) {
      issues.push({ code: 'missing-graph', cas_id: casId, path: currentPath, message: 'Every CAS requires its own nodes and edges arrays.' });
    }
    if (Array.isArray(cas.children) && cas.children.length === 0) {
      issues.push({ code: 'empty-children', cas_id: casId, path: currentPath, message: 'A leaf omits children instead of emitting an empty array.' });
    }
    if (hasCasChildren(cas) && !cas.composition_mode) {
      issues.push({ code: 'missing-composition-mode', cas_id: casId, path: currentPath, message: 'A non-leaf CAS requires composition_mode.' });
    }
    if (!hasCasChildren(cas) && cas.composition_mode) {
      issues.push({ code: 'leaf-composition-mode', cas_id: casId, path: currentPath, message: 'A leaf CAS cannot declare composition_mode.' });
    }

    for (const child of cas.children || []) visit(child, casId || null, depth + 1, currentPath);
    activeObjects.delete(cas);
  };

  visit(root, null, 0, []);
  return { valid: issues.length === 0, node_count: nodeCount, max_depth: maxDepth, issues };
}

export function assertValidCasTree(root: CASOutput): void {
  const result = validateCasTree(root);
  if (result.valid) return;
  const detail = result.issues.map(issue => `${issue.code} at ${issue.path.join(' > ')}: ${issue.message}`).join('\n');
  throw new Error(`Recursive CAS conformance failed with ${result.issues.length} issue(s):\n${detail}`);
}
