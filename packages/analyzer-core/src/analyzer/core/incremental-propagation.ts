import * as path from 'path';
import type { CASEdge, CASEntryPoint, CASExitPoint, CASNode, FileAnalysisResult, IncrementalState } from '../../types/cas.types';
import { isGraphDependencyEdge, resolveImportedFileReferences } from './incremental-impact';
import { localizedNodeFingerprint } from './incremental-locality';

function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

export interface IncrementalSurface {
  imports: readonly string[];
  exports: readonly string[];
  nodes: readonly unknown[];
  edges: readonly unknown[];
  entryPoints: readonly unknown[];
  exitPoints: readonly unknown[];
}

function normalizedValues(values: readonly unknown[]): string[] {
  return values.map(value => JSON.stringify(value) ?? 'undefined').sort();
}

export function incrementalSurfacesMatch(
  previous: IncrementalSurface,
  current: IncrementalSurface
): boolean {
  for (const key of ['imports', 'exports', 'nodes', 'edges', 'entryPoints', 'exitPoints'] as const) {
    const left = normalizedValues(previous[key]);
    const right = normalizedValues(current[key]);
    if (left.length !== right.length || left.some((value, index) => value !== right[index])) return false;
  }
  return true;
}

export function sameIncrementalFingerprints<T>(
  previousItems: readonly T[],
  currentItems: readonly T[],
  fingerprint: (item: T) => unknown
): boolean {
  return incrementalSurfacesMatch(
    { imports: [], exports: [], nodes: previousItems.map(fingerprint), edges: [], entryPoints: [], exitPoints: [] },
    { imports: [], exports: [], nodes: currentItems.map(fingerprint), edges: [], entryPoints: [], exitPoints: [] },
  );
}

export function incrementalNodeFingerprint(node: CASNode): unknown {
  return {
    id: node.id, name: node.name, type: node.type, parent: node.parent, children: node.children,
    category: node.category, subcategories: node.subcategories, level: node.level,
    level_name: node.level_name, analyzers: node.analyzers, primaryAnalyzer: node.primaryAnalyzer,
    source: node.source ? {
      file: node.source.file, line: node.source.line, column: node.source.column,
      end_column: node.source.end_column,
    } : undefined,
    metadata: node.metadata, signature: node.signature, implementation: node.implementation,
    description: node.description,
  };
}

export function incrementalEdgeFingerprint(edge: CASEdge): unknown {
  return {
    id: edge.id, source: edge.source, target: edge.target, type: edge.type,
    category: edge.category, metadata: edge.metadata,
  };
}

export function incrementalEntryPointFingerprint(entryPoint: CASEntryPoint): unknown {
  return {
    id: entryPoint.id, source_node: entryPoint.source_node, type: entryPoint.type,
    name: entryPoint.name, trigger: entryPoint.trigger, handler: entryPoint.handler,
    security: entryPoint.security, metadata: entryPoint.metadata,
  };
}

export function incrementalExitPointFingerprint(exitPoint: CASExitPoint): unknown {
  return {
    id: exitPoint.id, source_node: exitPoint.source_node, type: exitPoint.type,
    name: exitPoint.name, target: exitPoint.target, operation: exitPoint.operation,
    metadata: exitPoint.metadata,
  };
}

export function incrementalFileSurfacesMatch(input: {
  filePath: string;
  previousState: IncrementalState;
  current: FileAnalysisResult;
  previousNodesById: ReadonlyMap<string, CASNode>;
  previousEdgesById: ReadonlyMap<string, CASEdge>;
  previousEntryPointsById: ReadonlyMap<string, CASEntryPoint>;
  previousExitPointsById: ReadonlyMap<string, CASExitPoint>;
}): boolean {
  const record = input.previousState.files[input.filePath];
  if (!record) return false;
  const defined = <T>(value: T | undefined): value is T => value !== undefined;
  return incrementalSurfacesMatch({
    imports: record.importedFiles || [],
    exports: record.exportedSymbols || [],
    nodes: record.nodeIds.map(id => input.previousNodesById.get(id)).filter(defined).map(localizedNodeFingerprint),
    edges: record.edgeIds.map(id => input.previousEdgesById.get(id)).filter(defined).map(incrementalEdgeFingerprint),
    entryPoints: record.entryPointIds.map(id => input.previousEntryPointsById.get(id)).filter(defined).map(incrementalEntryPointFingerprint),
    exitPoints: record.exitPointIds.map(id => input.previousExitPointsById.get(id)).filter(defined).map(incrementalExitPointFingerprint),
  }, {
    imports: resolveImportedFileReferences(input.filePath, input.current.imports || [], new Set(Object.keys(input.previousState.files))),
    exports: input.current.exports || [],
    nodes: input.current.nodes.map(localizedNodeFingerprint),
    edges: input.current.edges.map(incrementalEdgeFingerprint),
    entryPoints: input.current.entryPoints.map(incrementalEntryPointFingerprint),
    exitPoints: input.current.exitPoints.map(incrementalExitPointFingerprint),
  });
}

export interface IncrementalPropagationWorklist {
  takeBatch(limit: number): Array<{ filePath: string; depth: number }>;
  complete(filePath: string, surfaceChanged: boolean): void;
  fallbackReason(): string | undefined;
  scheduledFiles(): string[];
  changedSurfaceFiles(): string[];
}

export function createIncrementalPropagationWorklist(input: {
  projectPath: string;
  files: IncrementalState['files'];
  nodes: readonly CASNode[];
  edges: readonly CASEdge[];
  changedFiles: Iterable<string>;
  deletedFiles?: Iterable<string>;
  maxDepth: number;
}): IncrementalPropagationWorklist {
  const records = new Map<string, IncrementalState['files'][string]>();
  let fallback: string | undefined;
  for (const [rawFilePath, record] of Object.entries(input.files)) {
    const filePath = normalizeFilePath(rawFilePath);
    if (records.has(filePath)) fallback ||= `ambiguous incremental ownership for ${filePath}`;
    records.set(filePath, record);
  }
  const normalizeSource = (filePath?: string): string => {
    if (!filePath) return '';
    const relative = path.isAbsolute(filePath) ? path.relative(input.projectPath, filePath) : filePath;
    return normalizeFilePath(relative);
  };
  const dependents = new Map<string, Set<string>>();
  const addDependency = (dependency: string, dependent: string) => {
    if (!records.has(dependency) || !records.has(dependent) || dependency === dependent) return;
    const current = dependents.get(dependency) || new Set<string>();
    current.add(dependent);
    dependents.set(dependency, current);
  };
  for (const [filePath, record] of records) {
    for (const importedFile of record.importedFiles || []) {
      addDependency(normalizeFilePath(importedFile), filePath);
    }
  }
  const fileByNode = new Map<string, string>();
  for (const node of input.nodes) {
    const filePath = normalizeSource(node.source?.file);
    if (!filePath) continue;
    const existing = fileByNode.get(node.id);
    if (existing && existing !== filePath) fallback ||= `ambiguous source ownership for node ${node.id}`;
    fileByNode.set(node.id, filePath);
  }
  for (const edge of input.edges) {
    if (!isGraphDependencyEdge(edge)) continue;
    const dependent = fileByNode.get(edge.source);
    const dependency = fileByNode.get(edge.target);
    if (dependent && dependency) addDependency(dependency, dependent);
  }

  const deleted = new Set([...(input.deletedFiles || [])].map(normalizeFilePath));
  const depths = new Map<string, number>();
  const pending: string[] = [];
  const completed = new Set<string>();
  const changedSurfaces = new Set<string>();
  const schedule = (filePath: string, depth: number) => {
    const normalized = normalizeFilePath(filePath);
    if (deleted.has(normalized) || completed.has(normalized) || depths.has(normalized)) return;
    if (depth > input.maxDepth) {
      fallback ||= `incremental propagation exceeded depth ${input.maxDepth} at ${normalized}`;
      return;
    }
    if (!records.has(normalized) && depth > 0) {
      fallback ||= `incremental propagation reached untracked file ${normalized}`;
      return;
    }
    depths.set(normalized, depth);
    pending.push(normalized);
  };
  for (const filePath of input.changedFiles) {
    const normalized = normalizeFilePath(filePath);
    if (!records.has(normalized)) fallback ||= `incremental propagation cannot prove ownership for ${normalized}`;
    schedule(normalized, 0);
  }

  const propagate = (filePath: string) => {
    const depth = depths.get(filePath) || 0;
    for (const dependent of [...(dependents.get(filePath) || [])].sort()) schedule(dependent, depth + 1);
  };
  for (const filePath of deleted) {
    changedSurfaces.add(filePath);
    propagate(filePath);
  }

  return {
    takeBatch: limit => pending.splice(0, Math.max(1, limit)).map(filePath => ({
      filePath,
      depth: depths.get(filePath) || 0,
    })),
    complete: (rawFilePath, surfaceChanged) => {
      const filePath = normalizeFilePath(rawFilePath);
      completed.add(filePath);
      if (!surfaceChanged) return;
      changedSurfaces.add(filePath);
      propagate(filePath);
    },
    fallbackReason: () => fallback,
    scheduledFiles: () => [...depths.keys()].sort(),
    changedSurfaceFiles: () => [...changedSurfaces].sort(),
  };
}
