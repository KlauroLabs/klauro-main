import * as path from 'node:path';
import type { CASAnalyzerContribution, CASContribution, CASNode } from '../../types/cas.types';

export function countDistinctContributionSourceFiles(nodes: CASNode[] | undefined, projectPath?: string): number {
  const files = new Set<string>();
  for (const node of nodes || []) {
    const file = node.source?.file;
    if (!file) continue;
    const key = projectPath && path.isAbsolute(file)
      ? path.relative(projectPath, file).replace(/\\/g, '/')
      : file.replace(/\\/g, '/');
    files.add(key);
  }
  return files.size;
}

interface ContributionSummaryInput {
  registration: { id: string; name: string; version?: string; type: CASAnalyzerContribution['contribution_type'] };
  result: CASContribution;
  executionTime: number;
  filesCreated: number;
  cacheStatus?: CASAnalyzerContribution['cache_status'];
}

export function buildAnalyzerContributionSummary(input: ContributionSummaryInput): CASAnalyzerContribution {
  const { registration, result } = input;
  const metadata = result.analyzer_metadata || {};
  return {
    analyzer_id: registration.id,
    analyzer_name: registration.name,
    analyzer_version: registration.version,
    analyzer_type: registration.type,
    contribution_type: registration.type,
    execution_time_ms: input.executionTime,
    cache_status: input.cacheStatus,
    nodes_created: result.nodes?.length || 0,
    files_created: input.filesCreated,
    edges_created: result.edges?.length || 0,
    confidence: 1.0,
    contributed_categories: [...new Set(Object.values(result.categories || {}).flatMap(categories => Object.keys(categories || {})))].sort(),
    provided_perspectives: result.provided_perspectives || [],
    framework_specific: metadata.frameworks_detected || metadata.crates || undefined,
    application_type: metadata.application_type,
    project_name: metadata.project_name,
    project_version: metadata.project_version,
    analysis_scope: metadata.analysis_scope,
    source_inputs: metadata.source_inputs,
    warnings: Array.isArray(metadata.warnings) && metadata.warnings.length > 0 ? metadata.warnings : undefined,
  };
}

export function invalidateIncrementalSourceInputs(contributions: CASAnalyzerContribution[]): CASAnalyzerContribution[] {
  return contributions.map(contribution => contribution.source_inputs ? {
    ...contribution,
    source_inputs: {
      version: 1,
      coverage: 'unavailable',
      digest_algorithm: 'sha256',
      reason: 'incremental-input-identities-not-refreshed',
      files: [],
      outside_root_reads: 0,
    },
  } : contribution);
}
