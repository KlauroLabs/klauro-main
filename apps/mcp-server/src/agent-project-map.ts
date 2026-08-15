import * as path from 'path';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { listAnalysesWithScope, type AnalysisEntry } from './storage';
import { getAnalysis } from './analyzer';
import { evaluateAgentReadiness, type AgentTask } from './agent-adoption';
import { classifyAnalysisProfile } from './analysis-profile';
import { clearFreshnessSummaryCache, summarizeAnalysisFreshness, type AnalysisFreshnessSummary } from './freshness';
import { excludeForeignWorkspaceEntries } from './analysis-scope';
import { resolveHostedProjectBinding } from './hosted-analysis';
import { syncWorkingTreeRemotely } from './remote-sync-client';

export interface AgentAnalysisCandidate {
  path: string;
  name: string;
  relation: 'exact' | 'descendant' | 'ancestor' | 'other';
  score: number;
  agent_context_ready: boolean;
  status: string;
  readiness_score: number;
  profile_kind: string;
  profile_confidence: number;
  nodes: number;
  edges: number;
  entry_points: number;
  gaps: string[];
  target_matches: Array<{
    node_id: string;
    name: string;
    type: string;
    file?: string;
    line?: number;
  }>;
}

export interface AgentProjectMap {
  generated_at: string;
  requested_path?: string;
  target?: string;
  total_analyses: number;
  candidate_count: number;
  candidates: AgentAnalysisCandidate[];
  selected?: AgentAnalysisCandidate;
  rule: string;
}

export async function getAgentProjectMap(input: {
  path?: string;
  task?: AgentTask;
  limit?: number;
} = {}): Promise<AgentProjectMap> {















  const { entries: scopedEntries, scope } = await listAnalysesWithScope({ scopeCwd: input.path });







  const entries = await excludeForeignWorkspaceEntries(scopedEntries, scope);
  const candidates: AgentAnalysisCandidate[] = [];
  const requestedPath = input.path ? normalizePath(input.path) : undefined;
  const target = input.task?.target;

  for (const entry of entries) {
    if (requestedPath && relationTo(requestedPath, entry.path) === 'other') continue;
    const candidate = await buildCandidate(entry, requestedPath, target);
    if (candidate) candidates.push(candidate);
  }

  candidates.sort((left, right) => right.score - left.score || left.path.length - right.path.length);
  const limit = input.limit || 50;

  return {
    generated_at: new Date().toISOString(),
    requested_path: input.path,
    target,
    total_analyses: entries.length,
    candidate_count: candidates.length,
    candidates: candidates.slice(0, limit),
    selected: candidates[0],
    rule: 'Use the selected path for subsequent agent tools when it is more specific than the requested path or when the requested path is not agent-context-ready ready.',
  };
}

export async function resolveAgentAnalysis(input: {
  path: string;
  task?: AgentTask;
  detail?: 'compact' | 'full';
}): Promise<{
  generated_at: string;
  requested_path: string;
  selected_path: string | null;
  analysis_freshness?: AnalysisFreshnessSummary;
  refreshed?: boolean;
  selected?: AgentAnalysisCandidate;
  candidates: AgentAnalysisCandidate[];
  recommendation: string;
}> {
  let refreshed = false;
  const initialMap = await getAgentProjectMap({ path: input.path, task: input.task, limit: 12 });
  const initialCas = initialMap.selected ? await getAnalysis(initialMap.selected.path) : null;
  const initialFreshness = initialMap.selected
    ? summarizeAnalysisFreshness(initialMap.selected.path, initialCas?.analysis_timestamp)
    : null;

  if (initialMap.selected && initialFreshness && initialFreshness.staleness !== 'fresh') {
    const selectedPath = initialMap.selected.path;
    const binding = await resolveHostedProjectBinding(selectedPath);
    if (!binding) {
      throw new Error(
        `Analysis for ${selectedPath} is ${initialFreshness.staleness}, but the repository is not bound to a signed-in hosted project. ` +
        `Refusing to serve stale agent context or run customer analysis locally; run \`klauro init\` or \`klauro login\`, then retry.`,
      );
    }
    const result = await syncWorkingTreeRemotely({
      projectPath: selectedPath,
      serverUrl: binding.serverUrl,
      analysisId: binding.projectId,
      token: binding.token,
      wait: true,
    });
    if (!result.cas) {
      throw new Error(
        `Hosted refresh for ${selectedPath} was accepted but did not return a completed in-flight CAS. ` +
        `Refusing to continue with stale agent context; retry after hosted analysis completes.`,
      );
    }
    refreshed = true;
    clearFreshnessSummaryCache();
  }

  const map = refreshed
    ? await getAgentProjectMap({ path: input.path, task: input.task, limit: 12 })
    : initialMap;
  const selected = map.selected;
  const selectedCas = selected
    ? (refreshed ? await getAnalysis(selected.path) : initialCas)
    : null;
  const freshness = selected
    ? summarizeAnalysisFreshness(selected.path, selectedCas?.analysis_timestamp)
    : null;
  if (refreshed && freshness?.staleness !== 'fresh') {
    throw new Error(
      `Hosted refresh for ${selected?.path || input.path} completed, but the returned in-flight CAS is still ${freshness?.staleness || 'unknown'}. ` +
      `Refusing to serve stale agent context.`,
    );
  }
  const baseRecommendation = selected
    ? selected.path === normalizePath(input.path)
      ? 'Continue with the requested path; it is the best matching analysis.'
      : `Use ${selected.path} for agent-start/work-context calls; it is the best matching analyzed subproject.`
    : 'No stored analysis matches this path. Run analyze_codebase on the repository or target subproject first.';
  const detail = input.detail || 'compact';




  const isExactMatch = selected?.relation === 'exact';
  const includeCandidates = detail === 'full' || !isExactMatch;
  return {
    generated_at: new Date().toISOString(),
    requested_path: input.path,
    selected_path: selected?.path || null,
    ...(freshness ? { analysis_freshness: freshness } : {}),
    refreshed,
    selected,
    candidates: includeCandidates ? map.candidates : [],
    recommendation: freshness && freshness.staleness !== 'fresh'
      ? `${baseRecommendation} ${freshness.recommendation}`
      : baseRecommendation,
  };
}

async function buildCandidate(entry: AnalysisEntry, requestedPath: string | undefined, target?: string): Promise<AgentAnalysisCandidate | null> {
  let cas: CASOutput;
  try {
    cas = await getAnalysis(entry.path);
  } catch {
    return null;
  }

  const readiness = evaluateAgentReadiness(cas, entry.path);
  const profile = classifyAnalysisProfile(cas, entry.path);
  const relation = requestedPath ? relationTo(requestedPath, entry.path) : 'other';
  const targetMatches = findTargetMatches(cas, target);
  const score = candidateScore({ relation, readiness, profile, targetMatches, target, entry });

  return {
    path: entry.path,
    name: entry.name,
    relation,
    score,
    agent_context_ready: readiness.agent_context_ready,
    status: readiness.status,
    readiness_score: readiness.score,
    profile_kind: profile.kind,
    profile_confidence: profile.confidence,
    nodes: cas.nodes?.length || 0,
    edges: cas.edges?.length || 0,
    entry_points: cas.entry_points?.length || 0,
    gaps: readiness.adoption_gaps,
    target_matches: targetMatches.slice(0, 8),
  };
}

function candidateScore(input: {
  relation: AgentAnalysisCandidate['relation'];
  readiness: ReturnType<typeof evaluateAgentReadiness>;
  profile: ReturnType<typeof classifyAnalysisProfile>;
  targetMatches: AgentAnalysisCandidate['target_matches'];
  target?: string;
  entry: AnalysisEntry;
}): number {
  let score = input.readiness.score;
  if (input.readiness.agent_context_ready) score += 25;
  if (input.relation === 'exact') score += 25;
  if (input.relation === 'descendant') score += 18;
  if (input.relation === 'ancestor') score -= 10;
  if (input.target && input.targetMatches.length > 0) score += Math.min(35, input.targetMatches.length * 8);
  if (input.profile.kind === 'empty' || input.profile.kind === 'infrastructure') score -= 20;
  if (input.entry.node_count === 0 || input.entry.edge_count === 0) score -= 25;




  if (/(^|\/)(fixtures?|__fixtures__|test[-_]?fixtures|analysis-truth|testdata)(\/|$)/.test(input.entry.path.replace(/\\/g, '/'))) {
    score -= 60;
  }



  if (input.relation === 'ancestor' && input.readiness.status === 'pass' && (input.entry.node_count || 0) >= 500) {
    score += 14;
  }
  return Math.round(score);
}

function findTargetMatches(cas: CASOutput, target?: string): AgentAnalysisCandidate['target_matches'] {
  if (!target) return [];
  const query = target.toLowerCase();
  return (cas.nodes || [])
    .filter(node => {
      const text = [
        node.id,
        node.name,
        node.qualified_name,
        node.type,
        node.source?.file,
        ...(node.tags || []),
      ].filter(Boolean).join(' ').toLowerCase();
      return text.includes(query);
    })
    .slice(0, 12)
    .map(node => ({
      node_id: node.id,
      name: node.name,
      type: node.type,
      file: node.source?.file,
      line: node.source?.line,
    }));
}

function relationTo(requestedPath: string, analysisPath: string): AgentAnalysisCandidate['relation'] {
  const requested = normalizePath(requestedPath);
  const analyzed = normalizePath(analysisPath);
  if (requested === analyzed) return 'exact';
  if (isDescendant(analyzed, requested)) return 'descendant';
  if (isDescendant(requested, analyzed)) return 'ancestor';
  return 'other';
}

function isDescendant(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizePath(value: string): string {
  return path.resolve(value).replace(/\\/g, '/').replace(/\/$/, '');
}
