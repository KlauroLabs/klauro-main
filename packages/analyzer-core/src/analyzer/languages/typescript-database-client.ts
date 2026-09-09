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

export function isRepositoryLikeCaller(callerName: string): boolean {

  if (/^wrap\(/i.test(callerName)) return true;

  const parts = callerName.split('.');
  const exactMatchPatterns = new Set([
    'em', 'db', 'orm', 'repo', 'model', 'knex', 'table', 'schema', 'query'
  ]);
  const identifierPatterns = new Set([
    'repository', 'entity', 'collection', 'prisma', 'manager',
    'connection', 'sequelize', 'drizzle', 'database'
  ]);
  for (const identifier of parts) {
    const part = identifier.toLowerCase();
    if (exactMatchPatterns.has(part)) return true;
    const words = identifier.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/);
    if (words.some(word => identifierPatterns.has(word))) return true;

    if (/repo$/.test(part) && part !== 'repo' && !/forrepo$/.test(part)) return true;
  }
  return false;
}

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

export function isDeclaredDatabaseModelReceiver(
  callerName: string,
  sourceFile: string | undefined,
  nodesByName: ReadonlyMap<string, readonly CASNode[]>,
  importsByFile: ReadonlyMap<string, ReadonlyMap<string, string>>,
  aliases: ReadonlyMap<string, string>,
): boolean {
  if (!sourceFile) return false;
  const visited = new Set<string>();
  const declarations = (name: string, file: string): readonly CASNode[] => {
    const parts = name.split('.');
    const receiver = parts[parts.length - 1];
    const names = new Set([receiver, aliases.get(receiver) || receiver]);
    const candidates = [...names].flatMap(key => [...(nodesByName.get(key) || [])]);
    const local = candidates.filter(node => node.source?.file === file);
    if (parts.length === 1 && local.length) return local;
    const importedFile = importsByFile.get(file)?.get(parts[0]);
    return importedFile ? candidates.filter(node => node.source?.file === importedFile) : [];
  };
  const importedMember = (expression: string, file: string): { library: string; member: string } | undefined => {
    const parts = expression.split('.');
    const library = importsByFile.get(file)?.get(parts[0]);
    if (!library) return undefined;
    if (parts.length > 1) return { library, member: parts[parts.length - 1] };
    const imports = nodesByName.get(`import ${library}`) || [];
    for (const node of imports) {
      if (node.source?.file !== file) continue;
      const specifiers = (node.metadata as { specifiers?: Array<{ name?: string; imported?: string }> })?.specifiers;
      const specifier = specifiers?.find(spec => spec.name === expression);
      if (specifier) return { library, member: specifier.imported || expression };
    }
    return undefined;
  };
  const isModel = (node: CASNode): boolean => {
    if (visited.has(node.id) || !node.source?.file) return false;
    visited.add(node.id);
    const file = node.source.file;
    const metadata = node.metadata as { value?: unknown; attributes?: { extends?: unknown } } | undefined;
    const base = /^([A-Za-z_$][\w$.]*)/.exec(String(metadata?.attributes?.extends || ''))?.[1];
    if (base) {
      const imported = importedMember(base, file);
      if (imported && (
        (imported.member === 'BaseEntity' && imported.library === 'typeorm')
        || (imported.member === 'Model' && ['sequelize', 'sequelize-typescript', '@sequelize/core', 'objection'].includes(imported.library))
      )) return true;
      if (declarations(base, file).some(isModel)) return true;
    }
    const value = String(metadata?.value || '').trim();
    const factory = /^([A-Za-z_$][\w$.]*)(?:<[^;]*>)?\s*\(/.exec(value)?.[1];
    if (factory) {
      const imported = importedMember(factory, file);
      if (imported?.library === 'mongoose' && imported.member === 'model') return true;
      if (imported?.library === '@typegoose/typegoose' && ['getModelForClass', 'getDiscriminatorModelForClass'].includes(imported.member)) return true;
      const receiver = /^(.*)\.define$/.exec(factory)?.[1];
      if (receiver) {
        for (const instance of declarations(receiver, file)) {
          const constructor = /^new\s+([A-Za-z_$][\w$.]*)/.exec(String((instance.metadata as Record<string, unknown> | undefined)?.value || ''))?.[1];
          const origin = constructor && importedMember(constructor, instance.source?.file || file);
          if (origin && origin.member === 'Sequelize' && ['sequelize', '@sequelize/core'].includes(origin.library)) return true;
        }
      }
    }
    const constructor = /^new\s+([A-Za-z_$][\w$.]*)/.exec(value)?.[1];
    return Boolean(constructor && declarations(constructor, file).some(isModel));
  };
  return declarations(callerName, sourceFile).some(isModel);
}
