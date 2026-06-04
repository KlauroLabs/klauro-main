import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { analyzeProjectIncremental, getAnalysis } from './analyzer';
import { validateBehavioralInvariants } from './invariant-validation';
import { validateCodebaseIdioms } from './idiom-query';
import {
  loadProposalPreviewPayload,
  saveProposalPreviewArtifact,
  type ProposalPreviewArtifact,
} from './storage';

export interface ProposedFileInput {
  path: string;
  content?: string;
  status?: 'added' | 'modified' | 'deleted';
}

export interface ProposalPreviewOptions {
  path?: string;
  planText: string;
  title?: string;
  diffText?: string;
  proposedFiles?: ProposedFileInput[];
  organizationId?: string;
  projectId?: string;
  codebaseId?: string;
  createdBy?: string;
  previewBaseUrl?: string;
}

type PreviewStatus = 'fits' | 'fits_with_warnings' | 'needs_revision' | 'high_risk' | 'insufficient_evidence';

interface AnalysisComparison {
  baseline_analysis_id?: string;
  proposed_analysis_id: string;
  graph_delta: {
    nodes_added: number;
    nodes_removed: number;
    nodes_retained: number;
    edges_added: number;
    edges_removed: number;
    edges_retained: number;
    entry_points_added: number;
    entry_points_removed: number;
    exit_points_added: number;
    exit_points_removed: number;
  };
  changed_contracts: Array<{ id: string; type: string; name: string; change: 'added' | 'removed' }>;
  impacted_files: string[];
  required_checks: string[];
  idiom_validation?: unknown;
  invariant_validation?: unknown;
}

export async function previewCodebaseIteration(options: ProposalPreviewOptions) {
  if (!options.path) throw new Error('previewCodebaseIteration requires path');
  if (!options.diffText && !options.proposedFiles?.length) {
    throw new Error('Existing codebase preview requires diffText or proposedFiles');
  }
  const projectPath = path.resolve(options.path);
  const baseline = await loadOrAnalyzeBaseline(projectPath);
  const workspace = await copyProjectToTempWorkspace(projectPath);
  let applyFailure: string | undefined;

  try {
    if (options.diffText) applyDiff(workspace, options.diffText);
    if (options.proposedFiles?.length) await applyProposedFiles(workspace, options.proposedFiles);
  } catch (error) {
    applyFailure = error instanceof Error ? error.message : String(error);
  }

  if (applyFailure) {
    return persistPreview({
      type: 'existing_codebase_iteration',
      options,
      baseline,
      proposed: baseline,
      proposedPath: workspace,
      comparison: comparisonWithPatchFailure(baseline, applyFailure),
      status: 'needs_revision',
      reasons: [`Proposed changes could not be applied in an ephemeral workspace: ${applyFailure}`],
      tempWorkspace: workspace,
    });
  }

  const proposed = (await analyzeProjectIncremental(workspace)).output;
  const comparison = compareAnalyses(baseline, proposed, {
    diffText: options.diffText,
    changedFiles: options.proposedFiles?.map(file => file.path),
    projectPath,
  });
  const verdict = buildVerdict(comparison);

  return persistPreview({
    type: 'existing_codebase_iteration',
    options,
    baseline,
    proposed,
    proposedPath: workspace,
    comparison,
    status: verdict.status,
    reasons: verdict.reasons,
    tempWorkspace: workspace,
  });
}

export async function previewGreenfieldCodebase(options: ProposalPreviewOptions) {
  if (!options.proposedFiles?.length) {
    return {
      status: 'needs_revision' as PreviewStatus,
      error: 'Greenfield preview requires proposedFiles with at least a minimal project skeleton.',
      required_input: {
        proposed_files: [
          'package.json/pyproject.toml/Cargo.toml/etc.',
          'one or more source entrypoints',
          'representative route/component/service files',
          'initial test file when available',
        ],
      },
    };
  }

  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-greenfield-preview-'));
  await applyProposedFiles(workspace, options.proposedFiles);
  const proposed = (await analyzeProjectIncremental(workspace)).output;
  const comparison = compareAnalyses(undefined, proposed, {
    changedFiles: options.proposedFiles.map(file => file.path),
  });
  const verdict = buildGreenfieldVerdict(proposed, comparison);

  return persistPreview({
    type: 'greenfield_codebase',
    options,
    proposed,
    proposedPath: workspace,
    comparison,
    status: verdict.status,
    reasons: verdict.reasons,
    tempWorkspace: workspace,
  });
}

export async function getPreviewAnalysis(id = 'latest') {
  const payload = await loadProposalPreviewPayload(id);
  if (!payload) throw new Error(`No proposal preview found for id=${id}`);
  return payload;
}

export async function compareAnalysisIterations(options: {
  baselinePath?: string;
  proposedPath?: string;
  previewId?: string;
  diffText?: string;
  files?: string[];
}) {
  if (options.previewId) {
    const payload = await getPreviewAnalysis(options.previewId);
    return payload.comparison;
  }
  if (!options.proposedPath) throw new Error('compareAnalysisIterations requires proposedPath or previewId');
  const proposed = await getAnalysis(path.resolve(options.proposedPath));
  const baseline = options.baselinePath ? await getAnalysis(path.resolve(options.baselinePath)) : undefined;
  return compareAnalyses(baseline, proposed, {
    diffText: options.diffText,
    changedFiles: options.files,
    projectPath: options.baselinePath,
  });
}

export function compareAnalyses(
  baseline: CASOutput | undefined,
  proposed: CASOutput,
  context: { diffText?: string; changedFiles?: string[]; projectPath?: string } = {}
): AnalysisComparison {
  const baselineNodeIds = new Set((baseline?.nodes || []).map(node => node.id));
  const proposedNodeIds = new Set(proposed.nodes.map(node => node.id));
  const baselineEdgeIds = new Set((baseline?.edges || []).map(edge => edge.id || `${edge.source}:${edge.type}:${edge.target}`));
  const proposedEdgeIds = new Set(proposed.edges.map(edge => edge.id || `${edge.source}:${edge.type}:${edge.target}`));
  const baselineEntryIds = new Set((baseline?.entry_points || []).map(point => point.id));
  const proposedEntryIds = new Set((proposed.entry_points || []).map(point => point.id));
  const baselineExitIds = new Set((baseline?.exit_points || []).map(point => point.id));
  const proposedExitIds = new Set((proposed.exit_points || []).map(point => point.id));
  const changedFiles = unique([
    ...(context.changedFiles || []),
    ...filesFromDiff(context.diffText || ''),
    ...[...proposedNodeIds]
      .filter(id => !baselineNodeIds.has(id))
      .map(id => proposed.nodes.find(node => node.id === id)?.source?.file)
      .filter((file): file is string => Boolean(file)),
  ]);
  const idiomValidation = baseline && context.projectPath
    ? validateCodebaseIdioms(baseline, context.projectPath, {
      diffText: context.diffText,
      files: changedFiles,
      includeWorkingTree: false,
    })
    : undefined;
  const invariantValidation = baseline && context.projectPath
    ? validateBehavioralInvariants(baseline, context.projectPath, {
      diffText: context.diffText,
      files: changedFiles,
      includeWorkingTree: false,
    })
    : undefined;

  const changedContracts = [
    ...contractChanges('entry-point', baseline?.entry_points || [], proposed.entry_points || []),
    ...contractChanges('exit-point', baseline?.exit_points || [], proposed.exit_points || []),
  ];
  const requiredChecks = unique([
    ...checksFromCas(proposed),
    ...((idiomValidation as any)?.required_checks || []),
    ...((invariantValidation as any)?.required_checks || []),
  ]);

  return {
    baseline_analysis_id: baseline?.analysis_id,
    proposed_analysis_id: proposed.analysis_id,
    graph_delta: {
      nodes_added: countDifference(proposedNodeIds, baselineNodeIds),
      nodes_removed: countDifference(baselineNodeIds, proposedNodeIds),
      nodes_retained: countIntersection(baselineNodeIds, proposedNodeIds),
      edges_added: countDifference(proposedEdgeIds, baselineEdgeIds),
      edges_removed: countDifference(baselineEdgeIds, proposedEdgeIds),
      edges_retained: countIntersection(baselineEdgeIds, proposedEdgeIds),
      entry_points_added: countDifference(proposedEntryIds, baselineEntryIds),
      entry_points_removed: countDifference(baselineEntryIds, proposedEntryIds),
      exit_points_added: countDifference(proposedExitIds, baselineExitIds),
      exit_points_removed: countDifference(baselineExitIds, proposedExitIds),
    },
    changed_contracts: changedContracts,
    impacted_files: changedFiles,
    required_checks: requiredChecks,
    idiom_validation: idiomValidation,
    invariant_validation: invariantValidation,
  };
}

async function persistPreview(input: {
  type: ProposalPreviewArtifact['type'];
  options: ProposalPreviewOptions;
  baseline?: CASOutput;
  proposed: CASOutput;
  proposedPath: string;
  comparison: AnalysisComparison;
  status: PreviewStatus;
  reasons: string[];
  tempWorkspace: string;
}) {
  const id = `preview_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const previewUrl = buildPreviewUrl(input.options, input.type, id);
  const visualization = buildVisualizationPayload(input.baseline, input.proposed, input.comparison);
  const preview = await saveProposalPreviewArtifact({
    preview: {
      id,
      type: input.type,
      title: input.options.title || inferTitle(input.options.planText, input.type),
      plan_text: input.options.planText,
      organization_id: input.options.organizationId,
      project_id: input.options.projectId,
      codebase_id: input.options.codebaseId,
      baseline_analysis_id: input.baseline?.analysis_id,
      baseline_path: input.options.path ? path.resolve(input.options.path) : undefined,
      proposed_analysis_id: input.proposed.analysis_id,
      proposed_path: input.proposedPath,
      verdict: {
        status: input.status,
        reasons: input.reasons,
        advisory: true,
        generated_at: new Date().toISOString(),
      },
      preview_url: previewUrl,
      created_by: input.options.createdBy || 'agent',
      created_at: new Date().toISOString(),
    },
    planText: input.options.planText,
    diffText: input.options.diffText,
    proposedFiles: input.options.proposedFiles,
    baselineCas: input.baseline,
    proposedCas: input.proposed,
    comparison: input.comparison,
    visualization,
  });

  return {
    status: input.status,
    preview,
    comparison: input.comparison,
    visualization_summary: {
      baseline_nodes: input.baseline?.nodes.length || 0,
      proposed_nodes: input.proposed.nodes.length,
      proposed_edges: input.proposed.edges.length,
      changed_contracts: input.comparison.changed_contracts.length,
      impacted_files: input.comparison.impacted_files.length,
    },
    next_steps: nextStepsForStatus(input.status),
  };
}

async function loadOrAnalyzeBaseline(projectPath: string): Promise<CASOutput> {
  try {
    return await getAnalysis(projectPath);
  } catch {
    return (await analyzeProjectIncremental(projectPath)).output;
  }
}

async function copyProjectToTempWorkspace(projectPath: string): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-iteration-preview-'));
  await fs.copy(projectPath, workspace, {
    filter: source => {
      const relative = path.relative(projectPath, source).replace(/\\/g, '/');
      if (!relative) return true;
      const parts = relative.split('/');
      return !parts.some(part => [
        '.git',
        '.klauro',
        'node_modules',
        'dist',
        'build',
        'coverage',
        '.next',
        '.cache',
        'target',
        '__pycache__',
        '.venv',
      ].includes(part));
    },
  });
  return workspace;
}

function applyDiff(workspace: string, diffText: string): void {
  execFileSync('git', ['apply', '--whitespace=nowarn', '-'], {
    cwd: workspace,
    input: diffText,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 20,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

async function applyProposedFiles(workspace: string, files: ProposedFileInput[]): Promise<void> {
  for (const file of files) {
    const destination = safeDestination(workspace, file.path);
    if ((file.status || 'modified') === 'deleted') {
      await fs.remove(destination);
      continue;
    }
    if (typeof file.content !== 'string') {
      throw new Error(`Proposed file ${file.path} requires content unless status=deleted`);
    }
    await fs.ensureDir(path.dirname(destination));
    await fs.writeFile(destination, file.content, 'utf8');
  }
}

function safeDestination(root: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const destination = path.resolve(root, normalized);
  if (!(destination === root || destination.startsWith(`${root}${path.sep}`))) {
    throw new Error(`Refusing to write path outside workspace: ${relativePath}`);
  }
  return destination;
}

function comparisonWithPatchFailure(baseline: CASOutput, failure: string): AnalysisComparison {
  return {
    baseline_analysis_id: baseline.analysis_id,
    proposed_analysis_id: baseline.analysis_id,
    graph_delta: {
      nodes_added: 0,
      nodes_removed: 0,
      nodes_retained: baseline.nodes.length,
      edges_added: 0,
      edges_removed: 0,
      edges_retained: baseline.edges.length,
      entry_points_added: 0,
      entry_points_removed: 0,
      exit_points_added: 0,
      exit_points_removed: 0,
    },
    changed_contracts: [],
    impacted_files: [],
    required_checks: [`Revise proposal patch so it applies cleanly: ${failure}`],
  };
}

function buildVerdict(comparison: AnalysisComparison): { status: PreviewStatus; reasons: string[] } {
  const reasons: string[] = [];
  const idiomStatus = (comparison.idiom_validation as any)?.status;
  const invariantStatus = (comparison.invariant_validation as any)?.status;
  if (comparison.graph_delta.entry_points_removed > 0 || comparison.graph_delta.exit_points_removed > 0) {
    reasons.push('Proposal removes public contracts.');
  }
  if (idiomStatus === 'fail') reasons.push('Proposal violates repo-local idioms.');
  if (invariantStatus === 'fail') reasons.push('Proposal violates behavioral invariant checks.');
  if (reasons.length > 0) return { status: 'high_risk', reasons };
  if (idiomStatus === 'warn' || invariantStatus === 'warn' || comparison.changed_contracts.length > 0) {
    return { status: 'fits_with_warnings', reasons: ['Proposal fits structurally but has warnings to review before implementation.'] };
  }
  if (comparison.graph_delta.nodes_added === 0 && comparison.graph_delta.nodes_removed === 0 && comparison.graph_delta.edges_added === 0 && comparison.graph_delta.edges_removed === 0) {
    return { status: 'insufficient_evidence', reasons: ['Proposal did not produce a meaningful CAS graph delta.'] };
  }
  return { status: 'fits', reasons: ['Proposal fits the analyzed codebase shape.'] };
}

function buildGreenfieldVerdict(proposed: CASOutput, comparison: AnalysisComparison): { status: PreviewStatus; reasons: string[] } {
  const reasons: string[] = [];
  if ((proposed.entry_points || []).length === 0) reasons.push('No entry points were detected in the proposed codebase.');
  if ((proposed.test_summary?.total_tests || 0) === 0) reasons.push('No tests were detected in the proposed codebase.');
  if (proposed.nodes.length < 3) reasons.push('Proposed file bundle is too small for strong architecture confidence.');
  if (reasons.length > 0) return { status: 'fits_with_warnings', reasons };
  return {
    status: comparison.graph_delta.nodes_added > 0 ? 'fits' : 'insufficient_evidence',
    reasons: ['Greenfield proposal produced a normal CAS analysis.'],
  };
}

function buildVisualizationPayload(baseline: CASOutput | undefined, proposed: CASOutput, comparison: AnalysisComparison) {
  return {
    generated_at: new Date().toISOString(),
    baseline: baseline ? graphSummary(baseline) : null,
    proposed: graphSummary(proposed),
    diff_overlay: {
      graph_delta: comparison.graph_delta,
      changed_contracts: comparison.changed_contracts,
      impacted_files: comparison.impacted_files,
    },
    focus_views: [
      'baseline',
      'proposed',
      'diff-overlay',
      'changed-contracts',
      'idiom-and-invariant-warnings',
      'required-tests',
    ],
    agent_guidance: {
      required_checks: comparison.required_checks,
      advisory: true,
    },
  };
}

function graphSummary(cas: CASOutput) {
  return {
    analysis_id: cas.analysis_id,
    system: cas.system,
    counts: {
      nodes: cas.nodes.length,
      edges: cas.edges.length,
      entry_points: cas.entry_points?.length || 0,
      exit_points: cas.exit_points?.length || 0,
      tests: cas.test_summary?.total_tests || 0,
    },
    nodes: cas.nodes.slice(0, 500).map(node => ({
      id: node.id,
      name: node.name,
      type: node.type,
      file: node.source?.file,
    })),
    edges: cas.edges.slice(0, 1000).map(edge => ({
      id: edge.id || `${edge.source}:${edge.type}:${edge.target}`,
      source: edge.source,
      target: edge.target,
      type: edge.type,
    })),
  };
}

function buildPreviewUrl(options: ProposalPreviewOptions, type: ProposalPreviewArtifact['type'], previewId: string): string {
  const base = (options.previewBaseUrl || process.env.KLAURO_APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const workspaceId = options.organizationId || 'local';
  if (type === 'existing_codebase_iteration') {
    const codebaseId = options.codebaseId || options.projectId || 'local-codebase';
    return `${base}/workspaces/${encodeURIComponent(workspaceId)}/codebases/${encodeURIComponent(codebaseId)}/previews/${encodeURIComponent(previewId)}`;
  }
  return `${base}/workspaces/${encodeURIComponent(workspaceId)}/previews/${encodeURIComponent(previewId)}`;
}

function contractChanges(type: string, baseline: Array<{ id: string; name?: string }>, proposed: Array<{ id: string; name?: string }>) {
  const baselineById = new Map(baseline.map(item => [item.id, item]));
  const proposedById = new Map(proposed.map(item => [item.id, item]));
  return [
    ...[...proposedById.entries()]
      .filter(([id]) => !baselineById.has(id))
      .map(([id, item]) => ({ id, type, name: item.name || id, change: 'added' as const })),
    ...[...baselineById.entries()]
      .filter(([id]) => !proposedById.has(id))
      .map(([id, item]) => ({ id, type, name: item.name || id, change: 'removed' as const })),
  ];
}

function checksFromCas(cas: CASOutput): string[] {
  const checks = new Set<string>();
  if ((cas.test_summary?.total_tests || 0) > 0) checks.add('Run the focused tests related to changed files or entry points.');
  return [...checks];
}

function filesFromDiff(diffText: string): string[] {
  const files: string[] = [];
  for (const line of diffText.split(/\r?\n/)) {
    const match = line.match(/^\+\+\+ b\/(.+)$/) || line.match(/^--- a\/(.+)$/);
    if (match && match[1] !== '/dev/null') files.push(match[1]);
  }
  return unique(files);
}

function inferTitle(planText: string, type: ProposalPreviewArtifact['type']): string {
  const firstLine = planText.split(/\r?\n/).map(line => line.trim()).find(Boolean);
  return firstLine?.slice(0, 80) || (type === 'greenfield_codebase' ? 'Greenfield proposal preview' : 'Codebase iteration preview');
}

function countDifference(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const value of left) if (!right.has(value)) count += 1;
  return count;
}

function countIntersection(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const value of left) if (right.has(value)) count += 1;
  return count;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
}

function nextStepsForStatus(status: PreviewStatus): string[] {
  if (status === 'needs_revision') return ['Revise the proposal patch or file bundle, then run proposal preview again.'];
  if (status === 'high_risk') return ['Review changed contracts, idiom validation, and invariant validation before implementation.'];
  if (status === 'fits_with_warnings') return ['Include the preview link and warnings in the agent plan before implementing.'];
  if (status === 'insufficient_evidence') return ['Add more proposed files or a more concrete diff so CAS can analyze the intended iteration.'];
  return ['Include the Klauro preview link and advisory verdict in the plan output.'];
}
