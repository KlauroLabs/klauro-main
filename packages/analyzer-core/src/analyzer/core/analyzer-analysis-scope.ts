import * as path from 'node:path';
import type { CASAnalyzerContribution, CASContribution } from '../../types/cas.types';
import type { AnalysisContext, BaseAnalyzer } from './base-analyzer';
import { withAnalyzerFileReadTracking } from './analyzer-file-read-cache';

interface ScopeRegistration {
  id: string;
  analyzer: Pick<BaseAnalyzer, 'getClaimedFiles' | 'getRelevantFiles'>;
}

function normalizeFile(root: string, file: string): string | undefined {
  const absolute = path.resolve(root, file);
  const relative = path.relative(root, absolute).replace(/\\/g, '/');
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) return undefined;
  return relative;
}

function contributionFiles(root: string, contribution: CASContribution): string[] {
  const files = new Set<string>();
  for (const node of contribution.nodes || []) {
    const source = node.source?.file;
    if (!source) continue;
    const normalized = normalizeFile(root, source);
    if (normalized) files.add(normalized);
  }
  return [...files].sort();
}

function omittedPaths(metadata: CASAnalyzerContribution | undefined, root: string): string[] {
  const frameworkSpecific = metadata?.framework_specific as Record<string, unknown> | undefined;
  const omitted = frameworkSpecific?.omitted_source_files;
  if (!Array.isArray(omitted)) return [];
  const paths = new Set<string>();
  for (const entry of omitted) {
    const file = typeof entry === 'string'
      ? entry
      : entry && typeof entry === 'object' && 'file' in entry
        ? String((entry as { file: unknown }).file)
        : '';
    if (!file) continue;
    const normalized = normalizeFile(root, file);
    if (normalized) paths.add(normalized);
  }
  return [...paths].sort();
}

function completeSuppliedScope(
  scope: NonNullable<CASAnalyzerContribution['analysis_scope']>,
  omitted: string[]
): NonNullable<CASAnalyzerContribution['analysis_scope']> {
  const eligible = Number(scope.files_eligible);
  const analyzed = Number(scope.files_analyzed);
  const skipped = Number(scope.files_skipped);
  if (Number.isFinite(eligible) && Number.isFinite(analyzed) && Number.isFinite(skipped)) {
    return {
      ...scope,
      applicability: scope.applicability || 'file-coverage',
      complete: scope.complete !== false && analyzed >= eligible && skipped === 0,
      ...(omitted.length > 0 ? { omitted_paths: omitted } : {}),
    };
  }
  return {
    ...scope,
    applicability: scope.applicability || 'file-coverage',
    complete: false,
    incomplete_reason: scope.incomplete_reason || 'Analyzer supplied non-numeric source coverage counts',
    ...(omitted.length > 0 ? { omitted_paths: omitted } : {}),
  };
}

export async function analyzeWithCompleteScope(
  registration: ScopeRegistration,
  context: AnalysisContext,
  run: () => Promise<CASContribution>
): Promise<CASContribution> {
  const root = path.resolve(context.projectPath);
  const listFiles = registration.analyzer.getClaimedFiles?.bind(registration.analyzer)
    || registration.analyzer.getRelevantFiles?.bind(registration.analyzer);
  let declaredFiles: string[] | undefined;
  let discoveryError: string | undefined;
  if (listFiles) {
    try {
      declaredFiles = await listFiles(root, context);
    } catch (error) {
      discoveryError = error instanceof Error ? error.message : String(error);
    }
  }

  const tracked = await withAnalyzerFileReadTracking(run);
  const contribution = tracked.result;
  contribution.analyzer_metadata.source_inputs = tracked.sourceInputs.snapshot(
    context.analysisRootPath || root,
    contributionFiles(root, contribution).map(file => path.resolve(root, file)),
  );
  const omitted = omittedPaths(contribution.analyzer_metadata, root);
  const suppliedScope = contribution.analyzer_metadata?.analysis_scope;
  if (suppliedScope) {
    contribution.analyzer_metadata.analysis_scope = completeSuppliedScope(suppliedScope, omitted);
    return contribution;
  }

  const readFiles = tracked.files.flatMap(file => {
    const normalized = normalizeFile(root, file);
    return normalized ? [normalized] : [];
  });
  const analyzed = new Set([...readFiles, ...contributionFiles(root, contribution)]);
  const eligible = new Set((declaredFiles || []).flatMap(file => {
    const normalized = normalizeFile(root, file);
    return normalized ? [normalized] : [];
  }));
  for (const file of analyzed) eligible.add(file);
  for (const file of omitted) eligible.add(file);

  if (!listFiles && eligible.size === 0 && !discoveryError) {
    contribution.analyzer_metadata.analysis_scope = {
      applicability: 'not-applicable',
      files_eligible: 0,
      files_analyzed: 0,
      files_skipped: 0,
      complete: true,
    };
    return contribution;
  }

  const inferredOmitted = [...eligible].filter(file => !analyzed.has(file));
  const skippedPaths = [...new Set([...omitted, ...inferredOmitted])].sort();
  const complete = !discoveryError && skippedPaths.length === 0;
  contribution.analyzer_metadata.analysis_scope = {
    applicability: 'file-coverage',
    files_eligible: eligible.size,
    files_analyzed: analyzed.size,
    files_skipped: skippedPaths.length,
    complete,
    ...(skippedPaths.length > 0 ? { omitted_paths: skippedPaths } : {}),
    ...(!complete ? {
      incomplete_reason: discoveryError
        ? `Eligible source discovery failed: ${discoveryError}`
        : `${skippedPaths.length} eligible source file(s) were not read or represented in analyzer output`,
    } : {}),
  };
  return contribution;
}
