import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  CASOutput,
  ChangeSet,
  FileAnalysisRecord,
  FileAnalysisResult,
  IncrementalState,
  INCREMENTAL_STATE_VERSION,
} from '../../types/cas.types';
import { normalizeIncrementalStateImports } from './incremental-impact';

interface IncrementalStateRefreshInput {
  projectPath: string;
  output: CASOutput;
  previousState: IncrementalState;
  fileResults: ReadonlyMap<string, FileAnalysisResult>;
  changeSet: ChangeSet;
  gitCommitHash?: string;
  analyzerRegistryFingerprint: string;
  fallbackRecord?: (filePath: string) => FileAnalysisRecord | undefined;
}

interface GraphOwnership {
  nodeIds: string[];
  edgeIds: string[];
  entryPointIds: string[];
  exitPointIds: string[];
}

function relativeSourcePath(projectPath: string, sourceFile: string): string {
  return (path.isAbsolute(sourceFile) ? path.relative(projectPath, sourceFile) : sourceFile).replace(/\\/g, '/');
}

function append(map: Map<string, string[]>, filePath: string, id: string): void {
  const values = map.get(filePath);
  if (values) values.push(id);
  else map.set(filePath, [id]);
}

function graphOwnershipByFile(projectPath: string, output: CASOutput): Map<string, GraphOwnership> {
  const nodeFiles = new Map<string, string>();
  const nodeIds = new Map<string, string[]>();
  const edgeIds = new Map<string, string[]>();
  const entryPointIds = new Map<string, string[]>();
  const exitPointIds = new Map<string, string[]>();

  for (const node of output.nodes) {
    if (!node.source?.file) continue;
    const filePath = relativeSourcePath(projectPath, node.source.file);
    nodeFiles.set(node.id, filePath);
    append(nodeIds, filePath, node.id);
  }
  for (const edge of output.edges) {
    const filePath = nodeFiles.get(edge.source);
    if (filePath) append(edgeIds, filePath, edge.id);
  }
  for (const entryPoint of output.entry_points || []) {
    const filePath = nodeFiles.get(entryPoint.source_node);
    if (filePath) append(entryPointIds, filePath, entryPoint.id);
  }
  for (const exitPoint of output.exit_points || []) {
    const filePath = nodeFiles.get(exitPoint.source_node);
    if (filePath) append(exitPointIds, filePath, exitPoint.id);
  }

  const ownership = new Map<string, GraphOwnership>();
  for (const filePath of new Set([...nodeIds.keys(), ...edgeIds.keys(), ...entryPointIds.keys(), ...exitPointIds.keys()])) {
    ownership.set(filePath, {
      nodeIds: nodeIds.get(filePath) || [],
      edgeIds: edgeIds.get(filePath) || [],
      entryPointIds: entryPointIds.get(filePath) || [],
      exitPointIds: exitPointIds.get(filePath) || [],
    });
  }
  return ownership;
}

function readFallbackRecord(projectPath: string, filePath: string): FileAnalysisRecord | undefined {
  try {
    const fullPath = path.join(projectPath, filePath);
    const stat = fs.statSync(fullPath);
    const contentHash = crypto.createHash('sha256').update(fs.readFileSync(fullPath, 'utf-8')).digest('hex').substring(0, 16);
    return {
      filePath,
      contentHash,
      mtimeMs: stat.mtimeMs,
      lastAnalyzed: new Date().toISOString(),
      analyzerId: 'unknown',
      nodeIds: [],
      edgeIds: [],
      entryPointIds: [],
      exitPointIds: [],
      importedFiles: [],
      exportedSymbols: [],
    };
  } catch {
    return undefined;
  }
}

export function refreshIncrementalStateFromGraph(input: IncrementalStateRefreshInput): IncrementalState {
  const ownership = graphOwnershipByFile(input.projectPath, input.output);
  const deleted = new Set(input.changeSet.deleted);
  const paths = new Set([
    ...Object.keys(input.previousState.files),
    ...input.fileResults.keys(),
    ...ownership.keys(),
  ]);
  const files: Record<string, FileAnalysisRecord> = {};
  const analyzedAt = new Date().toISOString();

  for (const filePath of paths) {
    if (deleted.has(filePath)) continue;
    const previous = input.previousState.files[filePath];
    const result = input.fileResults.get(filePath);
    const fallback = !previous && !result
      ? (input.fallbackRecord || (candidate => readFallbackRecord(input.projectPath, candidate)))(filePath)
      : undefined;
    const metadata = result ? {
      filePath,
      contentHash: result.contentHash,
      mtimeMs: result.mtimeMs,
      lastAnalyzed: analyzedAt,
      analyzerId: result.nodes.find(node => node.primaryAnalyzer)?.primaryAnalyzer ||
        result.nodes.find(node => node.analyzers?.length)?.analyzers?.[0] ||
        previous?.analyzerId || 'unknown',
      importedFiles: result.imports,
      exportedSymbols: result.exports,
    } : previous || fallback;
    if (!metadata) continue;
    const graph = ownership.get(filePath);
    files[filePath] = {
      ...metadata,
      nodeIds: graph?.nodeIds || [],
      edgeIds: graph?.edgeIds || [],
      entryPointIds: graph?.entryPointIds || [],
      exitPointIds: graph?.exitPointIds || [],
    };
  }

  const analyzerVersions: Record<string, string> = {};
  for (const contribution of input.output.analyzer_contributions || []) {
    analyzerVersions[contribution.analyzer_id] = contribution.analyzer_version || '1.0.0';
  }
  normalizeIncrementalStateImports(files);
  return {
    version: INCREMENTAL_STATE_VERSION,
    projectPath: input.projectPath,
    lastFullAnalysis: input.previousState.lastFullAnalysis,
    lastAnalysisTimestamp: Date.now(),
    gitCommitHash: input.gitCommitHash,
    files,
    analyzerVersions,
    analyzerRegistryFingerprint: input.analyzerRegistryFingerprint,
    config: input.previousState.config,
  };
}
