import * as path from 'path';
import * as fs from 'fs-extra';
import { generateNodeId } from '../../../types/cas.types';

export interface PrismaModelIdentity {
  name: string;
  schemaPath: string;
  rootPath: string;
  nodeId: string;
}

export function createPrismaModelIdentity(schemaPath: string, name: string): PrismaModelIdentity {
  const normalizedSchema = normalizePath(schemaPath);
  const schemaDirectory = path.posix.dirname(normalizedSchema);
  const rootPath = path.posix.basename(schemaDirectory) === 'prisma'
    ? path.posix.dirname(schemaDirectory)
    : schemaDirectory;
  return {
    name,
    schemaPath: normalizedSchema,
    rootPath: rootPath === '.' ? '' : rootPath,
    nodeId: generateNodeId('entity', normalizedSchema, `prisma_${name}`)
  };
}

export function prismaSchemaNodeId(schemaPath: string): string {
  const normalizedSchema = normalizePath(schemaPath);
  return generateNodeId('schema', normalizedSchema, 'prisma');
}

export async function loadPrismaModelIdentities(projectPath: string, schemaPaths: string[]): Promise<PrismaModelIdentity[]> {
  const identities: PrismaModelIdentity[] = [];
  const modelPattern = /model\s+(\w+)\s*\{/g;
  for (const schemaPath of schemaPaths) {
    const content = await fs.readFile(path.join(projectPath, schemaPath), 'utf-8');
    let match: RegExpExecArray | null;
    while ((match = modelPattern.exec(content)) !== null) identities.push(createPrismaModelIdentity(schemaPath, match[1]));
    modelPattern.lastIndex = 0;
  }
  return identities;
}

export function selectPrismaModelIdentity(candidates: PrismaModelIdentity[], sourceFile: string, importSource?: string): PrismaModelIdentity | undefined {
  if (candidates.length === 1) return candidates[0];
  const normalizedSource = normalizePath(sourceFile);
  const resolvedImport = importSource?.startsWith('.')
    ? normalizePath(path.posix.join(path.posix.dirname(normalizedSource), importSource))
    : undefined;
  const ranked = candidates.map(candidate => ({
    candidate,
    score: affinityScore(candidate.rootPath, normalizedSource, resolvedImport)
  })).sort((left, right) => right.score - left.score || left.candidate.nodeId.localeCompare(right.candidate.nodeId));
  if (!ranked[0] || (ranked[1] && ranked[0].score === ranked[1].score)) return undefined;
  return ranked[0].candidate;
}

function affinityScore(rootPath: string, sourceFile: string, resolvedImport?: string): number {
  const rootSegments = segments(rootPath);
  const sourceSegments = segments(sourceFile);
  const importSegments = segments(resolvedImport || '');
  const sourceAncestry = isAncestor(rootSegments, sourceSegments) ? 100000 : 0;
  const importAncestry = resolvedImport && (isAncestor(rootSegments, importSegments) || isAncestor(importSegments, rootSegments)) ? 200000 : 0;
  return importAncestry + sourceAncestry + commonPrefix(rootSegments, sourceSegments) * 100 + rootSegments.length;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function segments(value: string): string[] {
  return value.split('/').filter(Boolean);
}

function isAncestor(ancestor: string[], descendant: string[]): boolean {
  return ancestor.length > 0 && ancestor.length <= descendant.length && ancestor.every((segment, index) => descendant[index] === segment);
}

function commonPrefix(left: string[], right: string[]): number {
  let count = 0;
  while (count < left.length && count < right.length && left[count] === right[count]) count++;
  return count;
}
