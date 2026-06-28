import * as path from 'node:path';
import {
  allSourceExcludePatterns,
  loadKlauroConfig,
  sourcePatternListMatches,
} from './klauro-config';
import { listAnalyses } from './storage';

export interface WorkspaceInputResolutionOptions {
  paths?: string[];
  workspaceRoot?: string;
  exclude?: string[];
}

export interface WorkspaceSkippedInput {
  path: string;
  reason: string;
  matched_pattern?: string;
}

export interface WorkspaceInputResolution {
  includedPaths: string[];
  skippedInputs: WorkspaceSkippedInput[];
  workspaceRoot?: string;
  policy?: {
    config_file?: string;
    ignore_file?: string;
    exclude_patterns: string[];
  };
}

export async function resolveWorkspaceInputPaths(options: WorkspaceInputResolutionOptions = {}): Promise<WorkspaceInputResolution> {
  const workspaceRoot = options.workspaceRoot ? path.resolve(options.workspaceRoot) : undefined;
  const loaded = workspaceRoot ? await loadKlauroConfig(workspaceRoot) : undefined;
  const policyPatterns = loaded ? allSourceExcludePatterns(loaded, options.exclude || []) : (options.exclude || []);
  const selectedPaths = await selectCandidatePaths(options.paths, workspaceRoot);
  const seen = new Set<string>();
  const includedPaths: string[] = [];
  const skippedInputs: WorkspaceSkippedInput[] = [];

  for (const candidate of selectedPaths) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const skip = shouldSkipWorkspaceInput(resolved, workspaceRoot, policyPatterns);
    if (skip) {
      skippedInputs.push({ path: resolved, ...skip });
      continue;
    }
    includedPaths.push(resolved);
  }

  includedPaths.sort((left, right) => left.localeCompare(right));
  skippedInputs.sort((left, right) => left.path.localeCompare(right.path));
  return {
    includedPaths,
    skippedInputs,
    workspaceRoot,
    policy: loaded ? {
      config_file: loaded.configPath,
      ignore_file: loaded.ignorePath,
      exclude_patterns: policyPatterns,
    } : policyPatterns.length > 0 ? {
      exclude_patterns: policyPatterns,
    } : undefined,
  };
}

export function shouldSkipWorkspaceInput(
  candidatePath: string,
  workspaceRoot: string | undefined,
  excludePatterns: string[]
): { reason: string; matched_pattern?: string } | null {
  const resolved = path.resolve(candidatePath);
  if (workspaceRoot) {
    const relative = normalizeWorkspaceRelativePath(path.relative(workspaceRoot, resolved));
    if (relative.startsWith('../') || path.isAbsolute(relative)) {
      return { reason: 'outside workspace root' };
    }
    if (relative && relative !== '.') {
      const matched = firstMatchingWorkspacePattern(relative, excludePatterns);
      if (matched) return { reason: 'excluded by workspace source policy', matched_pattern: matched };
    }
  } else if (excludePatterns.length > 0) {
    const matched = firstMatchingWorkspacePattern(path.basename(resolved), excludePatterns);
    if (matched) return { reason: 'excluded by workspace source policy', matched_pattern: matched };
  }
  return null;
}

async function selectCandidatePaths(paths: string[] | undefined, workspaceRoot: string | undefined): Promise<string[]> {
  if (paths && paths.length > 0) return paths;
  const analyses = await listAnalyses();
  if (!workspaceRoot) return analyses.map(analysis => analysis.path);
  return analyses
    .map(analysis => path.resolve(analysis.path))
    .filter(analysisPath => analysisPath === workspaceRoot || analysisPath.startsWith(`${workspaceRoot}${path.sep}`));
}

function firstMatchingWorkspacePattern(relativePath: string, patterns: string[]): string | undefined {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  if (!normalized || normalized === '.') return undefined;
  for (const pattern of patterns) {
    if (
      sourcePatternListMatches(normalized, [pattern]) ||
      sourcePatternListMatches(`${normalized}/`, [pattern]) ||
      sourcePatternListMatches(`${normalized}/index`, [pattern])
    ) {
      return pattern;
    }
  }
  return undefined;
}

function normalizeWorkspaceRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\/+/, '');
}
