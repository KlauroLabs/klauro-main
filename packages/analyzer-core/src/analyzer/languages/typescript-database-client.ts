import type { ExtractedCall } from '../enhanced-call-graph-extractor';
import type { CASEdge, CASExitPoint, CASNode } from '../../types/cas.types';

const DATABASE_CLIENT_PACKAGES = /^(?:pg|pg-promise|mysql2?|sqlite3|better-sqlite3|oracledb|tedious)$/;
const FILESYSTEM_WRITE_METHODS = new Set([
  'appendFile',
  'appendFileSync',
  'createWriteStream',
  'outputFile',
  'outputFileSync',
  'write',
  'writeFile',
  'writeFileSync',
]);

export function isImportedDatabaseClientReceiver(
  callerName: string,
  nodesByName: ReadonlyMap<string, readonly CASNode[]>,
  importSourceByName: ReadonlyMap<string, string>,
): boolean {
  const receiver = callerName.split('.').pop() || callerName;
  return (nodesByName.get(receiver) || []).some(node => {
    if (!['variable', 'constant', 'property', 'field'].includes(node.type)) return false;
    const value = String((node.metadata as Record<string, unknown> | undefined)?.value || '');
    const constructor = /^new\s+([A-Za-z_$][\w$]*)\s*\(/.exec(value)?.[1];
    return Boolean(constructor && DATABASE_CLIENT_PACKAGES.test(importSourceByName.get(constructor) || ''));
  });
}

export function buildImportedFilesystemWriteEvidence(
  sourceNodeId: string,
  functionName: string,
  call: ExtractedCall,
  importSourceByName: ReadonlyMap<string, string>,
): { exitPoint: CASExitPoint; edge: CASEdge } | undefined {
  const parts = call.target.split('.');
  const method = parts.pop() || '';
  const receiver = parts.pop() || '';
  const library = importSourceByName.get(receiver) || '';
  if (!FILESYSTEM_WRITE_METHODS.has(method) || !/^(?:node:)?fs(?:\/promises)?$/.test(library)) {
    return undefined;
  }

  const exitPointId = `exit_file_${functionName}_${call.target}_${call.line}`
    .replace(/[^a-zA-Z0-9_]/g, '_');
  return {
    exitPoint: {
      id: exitPointId,
      source_node: sourceNodeId,
      type: 'file',
      name: `Write file via ${call.target}`,
      target: { service_id: 'filesystem', resource: '(runtime-resolved)' },
      operation: { action: method, async: call.isAsync },
      metadata: { line: call.line, library, call_expression: call.callExpression },
    },
    edge: {
      id: `call_${sourceNodeId}_${exitPointId}`,
      source: sourceNodeId,
      target: exitPointId,
      type: 'calls',
      category: 'behavior',
      metadata: {
        attributes: {
          call_type: 'method',
          resolution_type: 'external',
          target_type: 'file',
          method_name: method,
          library,
          is_async: call.isAsync,
          is_conditional: call.isConditional,
          is_in_loop: call.isInLoop,
          line: call.line,
          call_expression: call.callExpression,
        },
      },
    },
  };
}
