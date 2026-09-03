import type { CASContribution, CASNode } from '../../../types/cas.types';

const EXECUTABLE_NODE_TYPES = new Set([
  'function',
  'method',
  'constructor',
  'handler',
  'resolver',
  'command',
  'job',
  'task',
]);

function normalizedPath(value: string | undefined): string {
  return (value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

export function findEnclosingExecutableNodeId(
  relativePath: string,
  line: number,
  existingAnalysis: readonly CASContribution[] | undefined,
): string | undefined {
  const expectedPath = normalizedPath(relativePath);
  const candidates: Array<{ node: CASNode; span: number }> = [];
  for (const contribution of existingAnalysis || []) {
    for (const node of contribution.nodes || []) {
      const start = node.source?.line;
      const end = node.source?.end_line ?? start;
      if (!EXECUTABLE_NODE_TYPES.has(node.type) || start == null || end == null) continue;
      if (normalizedPath(node.source?.file) !== expectedPath || line < start || line > end) continue;
      candidates.push({ node, span: end - start });
    }
  }
  candidates.sort((left, right) => left.span - right.span || left.node.id.localeCompare(right.node.id));
  return candidates[0]?.node.id;
}
