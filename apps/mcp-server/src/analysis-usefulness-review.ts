#!/usr/bin/env tsx
import * as fs from 'fs-extra';
import * as path from 'path';
import pLimit from 'p-limit';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { dominantUnanalyzedLanguage, getAgentContext } from './agent-adoption';
import { classifyAnalysisProfile, type AnalysisProfile } from './analysis-profile';
import { discoverRealRepos, type RealRepoTarget } from './repo-discovery';
import { isDirectCliInvocation } from './cli-invocation';
import { withAnalysisFocus, type AnalysisFocus } from './analysis-focus';
import { isCommandShapedLabel, isHostnameLikeServiceName } from '../../../packages/analyzer-core/src/ai/external-service-plausibility';
import { computeFlowConcepts } from '../../../packages/analyzer-core/src/analyzer/core/flow-concepts';

type GateStatus = 'pass' | 'warn' | 'fail';

interface UsefulnessGate {
  id: string;
  status: GateStatus;
  score: number;
  detail: string;
}

export interface AnalysisUsefulnessReview {
  repo: string;
  path: string;
  profile: AnalysisProfile;
  status: GateStatus;
  score: number;
  duration_ms?: number;
  gates: UsefulnessGate[];
  summary: {
    architecture_system_type?: string;
    primary_domain?: string;
    description?: string;
    capability_count: number;
    workflow_count: number;
    idiom_count: number;
    invariant_count: number;
    architectural_pattern_count: number;
    agent_context_profile?: string;
    agent_context_files: number;
    agent_context_tokens: number;
    missing_agent_value: string[];
  };
}

export interface DescriptionEnrichmentTarget {
  target_kind: 'system' | 'node' | 'service' | 'entity' | 'capability' | 'entry_point' | 'exit_point' | 'flow';
  target: string;
  target_id?: string;
  priority: 'critical' | 'high' | 'medium';
  reasons: string[];
  current_source?: string;
  generation_status?: string;
  suggested_tool: 'run_analysis_layer' | 'generate_element_description';
  suggested_args: Record<string, unknown>;
}

interface ReviewTarget {
  name?: string;
  path: string;
}

interface ReviewOptions {
  repos?: ReviewTarget[];
  includeRealRepos?: boolean;
  devRoot?: string;
  maxTargets?: number;
  concurrency?: number;
  analysisFocus?: AnalysisFocus;
}

interface ParsedArgs {
  repos: ReviewTarget[];
  includeRealRepos: boolean;
  devRoot: string;
  maxTargets?: number;
  concurrency: number;
  analysisFocus: AnalysisFocus;
  outputPath: string;
  markdownPath: string;
}

const GENERIC_TERMS = new Set([
  'app',
  'application',
  'service',
  'services',
  'system',
  'main',
  'home',
  'settings',
  'config',
  'data',
  'test',
  'component',
  'components',
  'controller',
  'controllers',
  'handler',
  'handlers',
  'module',
  'modules',
  'route',
  'api',
  'apis',
  'client',
  'clients',
  'lib',
  'libs',
  'backend',
  'frontend',
  'business',
  'app',
  'apps',
  'users',
  'dev',
  'outcode',
  'personal',
  'asset',
  'assets',
  'generated',
  'gql',
  'graphql',
  'document',
  'documents',
  'initialize',
  'init',
  'start',
  'stop',
  'catch',
  'major',
  'minor',
  'next',
  'last',
  'check',
  'options',
  'property',
  'point',
  'window',
  'modal',
  'xaml',
  'step',
  'convert',
  'show',
  'display',
  'back',
  'snack',
  'setting',
  'load',
  'search',
  'render',
  'close',
  'focus',
  'normalize',
  'ensure',
  'path',
  'clamp',
  'install',
  'has',
  'manage',
  'lookup',
  'quick',
  'external',
  'account',
  'accounts',
  'superuser',
  'permission',
  'permissions',
  'serializer',
  'serializers',
]);

export async function runAnalysisUsefulnessReview(options: ReviewOptions = {}) {
  const startedAt = Date.now();
  const explicit = options.repos || [];
  let targets: ReviewTarget[] = explicit;
  let discovery: Awaited<ReturnType<typeof discoverRealRepos>> | null = null;

  if (options.includeRealRepos || explicit.length === 0) {
    discovery = await discoverRealRepos(options.devRoot || path.join(process.env.HOME || '', 'dev'));
    targets = [
      ...explicit,
      ...discovery.repos
        .filter(repo => repo.status === 'eligible')
        .map(repo => ({ name: repo.name, path: repo.path })),
    ];
  }

  const deduped = dedupeTargets(targets).slice(0, options.maxTargets || targets.length);
  const limit = pLimit(Math.max(1, options.concurrency || 1));
  const analysisFocus = options.analysisFocus || 'full';
  const reviews = await Promise.all(deduped.map(target => limit(() => reviewTarget(target, analysisFocus))));
  const report = {
    generated_at: new Date().toISOString(),
    benchmark_type: 'analysis-usefulness-review',
    analysis_focus: analysisFocus,
    duration_ms: Date.now() - startedAt,
    status: aggregateStatus(reviews.map(review => review.status)),
    score: Math.round(average(reviews.map(review => review.score))),
    discovery: discovery ? {
      total_repos: discovery.total_repos,
      eligible_repos: discovery.eligible_repos,
      unsupported_repos: discovery.unsupported_repos,
      skipped_repos: discovery.skipped_repos,
    } : null,
    summary: summarizeReviews(reviews),
    reviews,
  };
  return report;
}

export async function reviewAnalysisUsefulness(cas: CASOutput, projectPath: string, repoName = path.basename(projectPath), analysisFocus: AnalysisFocus = 'full'): Promise<AnalysisUsefulnessReview> {
  const profile = classifyAnalysisProfile(cas, projectPath);
  const agentContext = await getAgentContext(cas, projectPath, {
    task_type: 'modify',
    target: inferReviewTarget(cas),
    instructions: 'Make a small idiomatic change without duplicating existing behavior.',
    success_criteria: [
      'Use existing architecture and local idioms.',
      'Avoid duplicating an existing capability.',
      'Run or identify the narrowest relevant validation.',
    ],
  } as any);
  const gates = [
    scoreDomainPurpose(cas, profile),
    analysisFocus === 'agent-fast' ? scoreLayeredDescriptionPolicy(cas) : scoreDescriptionQuality(cas, profile),
    scoreCapabilityMap(cas, profile),
    scoreArchitectureMap(cas, profile),
    scoreCasOrganization(cas, profile),
    scoreAgentNavigation(agentContext, profile),
    scoreArchitectureAgentContext(agentContext, profile),
    scoreIdiomAndInvariantGuidance(cas, agentContext, profile),
    scoreDuplicationAvoidance(cas, agentContext, profile),
    scoreExternalIntegrationEvidence(cas, profile),
  ];
  const score = Math.round(average(gates.map(gate => gate.score)));
  const criticalFailure = gates.some(gate =>
    gate.status === 'fail' &&
    ['domain-purpose', 'description-quality', 'description-layering', 'external-integration-evidence', 'architecture-agent-context'].includes(gate.id)
  );
  const missing = gates
    .filter(gate => gate.status !== 'pass')
    .map(gate => `${gate.id}: ${gate.detail}`);

  return {
    repo: repoName,
    path: projectPath,
    profile,
    status: criticalFailure ? 'fail' : statusFromScore(score),
    score,
    gates,
    summary: {
      architecture_system_type: cas.architecture_summary?.system_type,
      primary_domain: cas.enhanced_system_purpose?.primary_domain,
      description: cas.enhanced_system_purpose?.inferred_description || cas.system?.description,
      capability_count: cas.system_capabilities?.length || 0,
      workflow_count: cas.workflows?.length || 0,
      idiom_count: cas.codebase_idioms?.length || 0,
      invariant_count: cas.behavioral_invariants?.length || 0,
      architectural_pattern_count: cas.architecture_summary?.architectural_patterns?.length || 0,
      agent_context_profile: (agentContext as any).context_profile,
      agent_context_files: Array.isArray((agentContext as any).file_read_plan) ? (agentContext as any).file_read_plan.length : 0,
      agent_context_tokens: estimateTokens(JSON.stringify(agentContext)),
      missing_agent_value: missing,
    },
  };
}

export function reviewAnalysisUsefulnessStatic(cas: CASOutput, projectPath: string, repoName = path.basename(projectPath), analysisFocus: AnalysisFocus = 'full'): AnalysisUsefulnessReview {
  const profile = classifyAnalysisProfile(cas, projectPath);
  const gates = [
    scoreDomainPurpose(cas, profile),
    analysisFocus === 'agent-fast' ? scoreLayeredDescriptionPolicy(cas) : scoreDescriptionQuality(cas, profile),
    scoreCapabilityMap(cas, profile),
    scoreArchitectureMap(cas, profile),
    scoreCasOrganization(cas, profile),
    scoreIdiomAndInvariantGuidance(cas, {}, profile),
    scoreDuplicationAvoidance(cas, {}, profile),
    scoreExternalIntegrationEvidence(cas, profile),
  ];
  const score = Math.round(average(gates.map(gate => gate.score)));
  const criticalFailure = gates.some(gate =>
    gate.status === 'fail' &&
    ['domain-purpose', 'description-quality', 'description-layering', 'external-integration-evidence', 'cas-organization'].includes(gate.id)
  );
  const missing = gates
    .filter(gate => gate.status !== 'pass')
    .map(gate => `${gate.id}: ${gate.detail}`);

  return {
    repo: repoName,
    path: projectPath,
    profile,
    status: criticalFailure ? 'fail' : statusFromScore(score),
    score,
    gates,
    summary: {
      architecture_system_type: cas.architecture_summary?.system_type,
      primary_domain: cas.enhanced_system_purpose?.primary_domain,
      description: cas.enhanced_system_purpose?.inferred_description || cas.system?.description,
      capability_count: cas.system_capabilities?.length || 0,
      workflow_count: cas.workflows?.length || 0,
      idiom_count: cas.codebase_idioms?.length || 0,
      invariant_count: cas.behavioral_invariants?.length || 0,
      architectural_pattern_count: cas.architecture_summary?.architectural_patterns?.length || 0,
      agent_context_files: 0,
      agent_context_tokens: 0,
      missing_agent_value: missing,
    },
  };
}

async function reviewTarget(target: ReviewTarget, analysisFocus: AnalysisFocus): Promise<AnalysisUsefulnessReview> {
  const startedAt = Date.now();
  const absolute = path.resolve(target.path);
  const cas = await withAnalysisFocus(analysisFocus, async () => {
    const { analyzeForBench } = await import('./gauntlet/product-analysis');
    return analyzeForBench(absolute);
  });
  const review = await reviewAnalysisUsefulness(cas, absolute, target.name || path.basename(absolute), analysisFocus);
  return {
    ...review,
    duration_ms: Date.now() - startedAt,
  };
}

function scoreDomainPurpose(cas: CASOutput, profile: AnalysisProfile): UsefulnessGate {
  const domain = clean(cas.enhanced_system_purpose?.primary_domain);
  const description = clean(cas.enhanced_system_purpose?.inferred_description || cas.system?.description);
  const concepts = cas.enhanced_system_purpose?.core_concepts || [];
  const domainConcepts = cas.domain_concepts || [];
  const capabilityNames = (cas.system_capabilities || []).map(capability => capability.name).filter(Boolean);
  const weakDescriptionReasons = findWeakDescriptionReasons(cas, profile, description);
  const domainBreadthProblems = findDomainBreadthProblems(cas, profile, domain);
  let score = 0;
  const details: string[] = [];

  if (profile.kind === 'empty') return gate('domain-purpose', 100, 'empty analysis does not require domain purpose');
  if (domain && !GENERIC_TERMS.has(domain.toLowerCase())) score += 30; else details.push(`weak domain (${domain || 'missing'})`);
  if (description.length >= 80 && weakDescriptionReasons.length === 0) score += 25; else details.push(...(weakDescriptionReasons.length ? weakDescriptionReasons : ['description is too short for agent orientation']));
  if (concepts.length >= 2 || domainConcepts.length >= 2) score += 20; else details.push('few core/domain concepts');
  if (textMentionsAny(description, [domain, ...concepts, ...capabilityNames].filter(Boolean))) score += 15; else details.push('description does not name detected concepts or capabilities');
  if (!/^(this project|this repository|the application)\s+(contains|includes|provides)/i.test(description)) score += 10; else details.push('description reads like a file inventory');

  if (domainBreadthProblems.length > 0) details.push(...domainBreadthProblems);
  if (weakDescriptionReasons.length > 0) score = Math.min(score, 60);
  if (domainBreadthProblems.length > 0) score = Math.min(score, 65);
  return gate('domain-purpose', score, details.length ? details.join('; ') : `domain ${domain}`);
}

export function scoreDescriptionQuality(cas: CASOutput, profile: AnalysisProfile): UsefulnessGate {
  if (profile.kind === 'empty') return gate('description-quality', 100, 'empty analysis does not require AI narrative descriptions');

  const systemDescription = clean(cas.enhanced_system_purpose?.inferred_description || cas.system?.description);
  const systemSource = clean(cas.enhanced_system_purpose?.description_source);
  const systemGeneration = cas.enhanced_system_purpose?.description_generation;
  const capabilities = cas.system_capabilities || [];
  const relevantCapabilities = capabilities
    .filter(capability => isUsefulCapabilityName(capability.name))
    .sort((a, b) => capabilityPriority(b) - capabilityPriority(a))
    .slice(0, Math.min(12, Math.max(3, capabilities.length)));
  const requiredCapabilities = profile.kind === 'library-package' || profile.kind === 'test-package' || profile.kind === 'infrastructure'
    ? Math.min(1, relevantCapabilities.length)
    : Math.min(3, relevantCapabilities.length);
  const details: string[] = [];
  let score = 0;
  let hardCap = 100;

  const systemWeakReasons = findWeakDescriptionReasons(cas, profile, systemDescription);
  const dominantUnanalyzed = dominantUnanalyzedLanguage(cas);
  if (dominantUnanalyzed) {
    if (systemDescription.length >= 80) score += 25;
    else details.push('system description weak: too short for orientation');
    if (!descriptionAcknowledgesCoverageGap(systemDescription, dominantUnanalyzed.name)) {
      details.push(`description does not acknowledge that ${dominantUnanalyzed.name} (${dominantUnanalyzed.share_of_source}% of source) is not analyzed`);
    }
  } else if (systemDescription.length >= 120 && systemWeakReasons.length === 0) score += 25;
  else details.push(`system description weak: ${systemWeakReasons.join(', ') || 'too short for orientation'}`);

  if (isTrustedDescriptionSource(systemSource) || isAIReviewedDeterministicDescription(systemSource, systemGeneration)) score += 15;
  else if (systemGeneration?.attempted === false && systemSource === 'deterministic') {
    score += 5;
    details.push('system description is deterministic because AI was not attempted');
  } else {
    details.push(`system description source is ${systemSource || 'missing'}`);
  }

  if (systemGeneration && isBadDescriptionGeneration(systemGeneration)) {
    details.push(`system description generation ${systemGeneration.status}${systemGeneration.reason ? ` (${systemGeneration.reason})` : ''}`);
    hardCap = Math.min(hardCap, 50);
  }
  if (systemWeakReasons.some(reason => /inventory|framework-template|regurgitates/.test(reason))) {
    hardCap = Math.min(hardCap, 55);
  }

  if (relevantCapabilities.length === 0) {
    if (profile.kind === 'infrastructure' || profile.kind === 'library-package' || profile.kind === 'test-package') score += 45;
    else details.push('no useful capabilities available for description review');
  } else {
    const capabilityAssessments = relevantCapabilities.map(capability => ({
      capability,
      reasons: findWeakCapabilityDescriptionReasons(capability),
      source: clean(capability.description_source),
      generation: capability.description_generation,
    }));
    const usable = capabilityAssessments.filter(item => item.reasons.length === 0 && clean(item.capability.description).length >= 50);
    const trusted = capabilityAssessments.filter(item =>
      isTrustedDescriptionSource(item.source) ||
      isAIReviewedDeterministicDescription(item.source, item.generation)
    );
    const badGeneration = capabilityAssessments.filter(item => item.generation && isBadDescriptionGeneration(item.generation));
    const overNarrow = capabilityAssessments.filter(item =>
      item.reasons.some(reason => reason.includes('over-narrow source-area claim'))
    );
    const usableRequired = Math.max(requiredCapabilities, Math.ceil(relevantCapabilities.length * 0.6));
    const trustedRequired = Math.max(requiredCapabilities, Math.ceil(relevantCapabilities.length * 0.5));

    score += Math.min(30, (usable.length / Math.max(1, usableRequired)) * 30);
    score += Math.min(20, (trusted.length / Math.max(1, trustedRequired)) * 20);

    if (usable.length < usableRequired) {
      const weakExamples = capabilityAssessments
        .filter(item => item.reasons.length > 0 || clean(item.capability.description).length < 50)
        .slice(0, 5)
        .map(item => `${clean(item.capability.name) || item.capability.id}: ${item.reasons.join(', ') || 'too short'}`);
      details.push(`capability descriptions weak (${usable.length}/${usableRequired} usable): ${weakExamples.join('; ')}`);
    }
    if (trusted.length < trustedRequired) {
      const sourceExamples = capabilityAssessments
        .filter(item => !isTrustedDescriptionSource(item.source) && !isAIReviewedDeterministicDescription(item.source, item.generation))
        .slice(0, 5)
        .map(item => `${clean(item.capability.name) || item.capability.id}: ${item.source || 'missing-source'}`);
      details.push(`capability descriptions lack AI/manual/reused provenance (${trusted.length}/${trustedRequired}): ${sourceExamples.join('; ')}`);
    }
    if (badGeneration.length > 0) {
      const badExamples = badGeneration
        .slice(0, 5)
        .map(item => `${clean(item.capability.name) || item.capability.id}: ${item.generation!.status}${item.generation!.reason ? ` (${item.generation!.reason})` : ''}`);
      details.push(`capability AI generation failed or was rejected: ${badExamples.join('; ')}`);
      hardCap = Math.min(hardCap, badGeneration.length >= Math.max(1, requiredCapabilities) ? 60 : 70);
    }
    if (overNarrow.length > 0) {
      const examples = overNarrow
        .slice(0, 5)
        .map(item => clean(item.capability.name) || item.capability.id);
      details.push(`capability descriptions make over-narrow source-area claims: ${examples.join('; ')}`);
      hardCap = Math.min(hardCap, 65);
    }
  }

  score += 10;
  score = Math.min(score, hardCap);

  const aiNeverAttempted = systemGeneration?.attempted === false
    && !capabilities.some(capability => capability.description_generation?.attempted);
  if (aiNeverAttempted) {
    score = Math.min(score, 65);
    details.push('descriptions are deterministic by configuration (AI off); run ui-overview analysis or description enrichment for narrative quality');
  }

  return gate('description-quality', score, details.length ? details.join('; ') : 'AI-backed system and capability descriptions are useful');
}

export function getDescriptionEnrichmentTargets(cas: CASOutput, projectPath?: string): DescriptionEnrichmentTarget[] {
  const profile = classifyAnalysisProfile(cas, projectPath || cas.system?.root_path || cas.system?.name || '');
  const targets: DescriptionEnrichmentTarget[] = [];
  const systemDescription = clean(cas.enhanced_system_purpose?.inferred_description || cas.system?.description);
  const systemSource = clean(cas.enhanced_system_purpose?.description_source);
  const systemGeneration = cas.enhanced_system_purpose?.description_generation;
  const systemReasons = [
    ...findWeakDescriptionReasons(cas, profile, systemDescription),
    ...(!isTrustedDescriptionSource(systemSource) && !isAIReviewedDeterministicDescription(systemSource, systemGeneration)
      ? [`source is ${systemSource || 'missing'}`]
      : []),
    ...(systemGeneration && isBadDescriptionGeneration(systemGeneration)
      ? [`generation ${systemGeneration.status}${systemGeneration.reason ? ` (${systemGeneration.reason})` : ''}`]
      : []),
  ];

  if (systemReasons.length > 0) {
    targets.push({
      target_kind: 'system',
      target: 'system narrative',
      priority: systemReasons.some(reason => /deterministic|missing|regurgitates|inventory|framework-template|ai_failed|ai_rejected/.test(reason))
        ? 'critical'
        : 'high',
      reasons: Array.from(new Set(systemReasons)),
      current_source: systemSource || undefined,
      generation_status: systemGeneration?.status,
      suggested_tool: 'run_analysis_layer',
      suggested_args: {
        layer: 'agent-fast-refresh',
        force_full: false,
      },
    });
  }

  const capabilities = (cas.system_capabilities || [])
    .filter(capability => isUsefulCapabilityName(capability.name))
    .sort((a, b) => capabilityPriority(b) - capabilityPriority(a));
  for (const capability of capabilities) {
    const source = clean(capability.description_source);
    const generation = capability.description_generation;
    const reasons = [
      ...findWeakCapabilityDescriptionReasons(capability),
      ...(!isTrustedDescriptionSource(source) && !isAIReviewedDeterministicDescription(source, generation)
        ? [`source is ${source || 'missing'}`]
        : []),
      ...(generation && isBadDescriptionGeneration(generation)
        ? [`generation ${generation.status}${generation.reason ? ` (${generation.reason})` : ''}`]
        : []),
    ];
    if (reasons.length === 0) continue;
    targets.push({
      target_kind: 'capability',
      target: clean(capability.name) || capability.id,
      target_id: capability.id,
      priority: capability.category === 'core' || capability.criticality === 'critical'
        ? 'high'
        : 'medium',
      reasons: Array.from(new Set(reasons)),
      current_source: source || undefined,
      generation_status: generation?.status,
      suggested_tool: 'generate_element_description',
      suggested_args: {
        target: capability.id,
        target_kind: 'capability',
        instructions: 'Write a behavior-level description for human engineers and AI coding agents. Explain what this capability lets an agent, user, operator, or developer do. Do not mention files, helper functions, routes, graph counts, or ownership.',
      },
    });
    if (targets.length >= 12) break;
  }

  appendManualElementDescriptionTargets(cas, targets);

  return targets;
}

function appendManualElementDescriptionTargets(cas: CASOutput, targets: DescriptionEnrichmentTarget[]): void {
  const existing = new Set(targets.map(target => `${target.target_kind}:${target.target_id || target.target}`));
  const add = (target: DescriptionEnrichmentTarget) => {
    const key = `${target.target_kind}:${target.target_id || target.target}`;
    if (existing.has(key)) return;
    existing.add(key);
    targets.push(target);
  };

  for (const node of highValueDescriptionNodes(cas)) {
    const reasons = elementDescriptionReasons(node);
    if (reasons.length === 0) continue;
    const kind = node.type === 'service' ? 'service' : 'node';
    add({
      target_kind: kind,
      target: clean(node.name) || node.id,
      target_id: node.id,
      priority: isHighValueNode(node) ? 'high' : 'medium',
      reasons,
      current_source: clean((node as any).description_source) || undefined,
      generation_status: (node as any).description_generation?.status,
      suggested_tool: 'generate_element_description',
      suggested_args: {
        target: node.id,
        target_kind: kind,
        instructions: 'Write a behavior-level drilldown description for this exact code element. Explain its responsibility in the product flow and how agents should think about changing it. Do not mention file names, graph counts, or parser internals.',
      },
    });
    if (targets.length >= 18) return;
  }

  for (const entity of highValueDescriptionEntities(cas)) {
    const reasons = elementDescriptionReasons(entity);
    if (reasons.length === 0) continue;
    add({
      target_kind: 'entity',
      target: clean(entity.name) || entity.id,
      target_id: entity.id,
      priority: entity.sensitive || entity.is_sensitive ? 'high' : 'medium',
      reasons,
      current_source: clean(entity.description_source) || undefined,
      generation_status: entity.description_generation?.status,
      suggested_tool: 'generate_element_description',
      suggested_args: {
        target: entity.id,
        target_kind: 'entity',
        instructions: 'Write a behavior-level data description. Explain what this entity represents, why it matters, and which changes should preserve its invariants. Do not list raw fields unless they clarify the product concept.',
      },
    });
    if (targets.length >= 22) return;
  }

  for (const entryPoint of highValueDescriptionEntryPoints(cas)) {
    const reasons = elementDescriptionReasons(entryPoint);
    if (reasons.length === 0) continue;
    add({
      target_kind: 'entry_point',
      target: clean(entryPoint.name) || clean(entryPoint.trigger?.path) || entryPoint.id,
      target_id: entryPoint.id,
      priority: entryPoint.security?.requires_auth === false ? 'high' : 'medium',
      reasons,
      current_source: clean(entryPoint.description_source) || undefined,
      generation_status: entryPoint.description_generation?.status,
      suggested_tool: 'generate_element_description',
      suggested_args: {
        target: entryPoint.id,
        target_kind: 'entry_point',
        instructions: 'Write a behavior-level entry-point description. Explain what action starts here, who or what calls it, and what downstream responsibility it protects. Do not restate route mechanics alone.',
      },
    });
    if (targets.length >= 24) return;
  }

  // FLOW targets — the interpretive half of the flow layer (ICELOT doctrine):
  // step/flow descriptions are deterministic labels until this AI pass runs.
  // Budget-bounded: only the TOP capability-linked flows (they realize a
  // named product capability — the flows agents/the UI actually drill), never
  // the full union set. The generated descriptions persist in the
  // element-description store and join back via get_flow_concepts.
  try {
    const flows = computeFlowConcepts(cas, { maxFlows: 60 })
      .filter(flow => Boolean(flow.capability_id))
      .slice(0, 5);
    for (const flow of flows) {
      if (flow.description_source === 'ai') continue;
      add({
        target_kind: 'flow',
        target: clean(flow.name) || flow.flow_id,
        target_id: flow.flow_id,
        priority: 'medium',
        reasons: ['flow description is a deterministic structural label (interpretive pass has not run)'],
        current_source: 'deterministic-label',
        suggested_tool: 'generate_element_description',
        suggested_args: {
          target: flow.flow_id,
          target_kind: 'flow',
          instructions: 'Write a behavior-level description of this flow: what request/job moves through it, what it validates/computes, and what it produces at its terminus. Ground every claim in the provided steps, entities, and side effects. Do not mention function names or files.',
        },
      });
      if (targets.length >= 30) return;
    }
  } catch {
    // Flow computation must never break the enrichment queue.
  }
}

function highValueDescriptionNodes(cas: CASOutput): any[] {
  const degree = new Map<string, number>();
  for (const edge of cas.edges || []) {
    degree.set(edge.source, (degree.get(edge.source) || 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) || 0) + 1);
  }
  const usefulTypes = new Set(['service', 'controller', 'component', 'model', 'repository', 'class', 'module']);
  return [...(cas.nodes || [])]
    .filter(node => usefulTypes.has(clean(node.type)))
    .filter(node => !/\b(test|spec|fixture|mock|generated|vendor|node_modules)\b/i.test(`${node.name || ''} ${node.source?.file || ''}`))
    .sort((left, right) => descriptionNodeScore(right, degree) - descriptionNodeScore(left, degree))
    .slice(0, 8);
}

function descriptionNodeScore(node: any, degree: Map<string, number>): number {
  let score = degree.get(node.id) || 0;
  if (isHighValueNode(node)) score += 8;
  if (node.type === 'service') score += 6;
  if (node.type === 'controller') score += 5;
  if (node.type === 'repository') score += 4;
  if (node.type === 'component') score += 3;
  // Structural importance (normalized [0,1], deterministic graph layer) is the
  // PRIMARY enrichment ordering when the CAS carries it: highest-importance
  // elements get described first. Ordering only — never a cutoff; the degree/
  // type terms remain the fallback and the tiebreaker for pre-layer analyses.
  if (typeof node.structural_importance === 'number') {
    score += node.structural_importance * 1000;
  }
  return score;
}

function isHighValueNode(node: any): boolean {
  return /\b(service|controller|repository|module)\b/i.test(clean(node.type));
}

function highValueDescriptionEntities(cas: CASOutput): any[] {
  return [...(cas.data_entities || [])]
    .filter(entity => clean(entity.name))
    .sort((left, right) => descriptionEntityScore(right) - descriptionEntityScore(left))
    .slice(0, 6);
}

function descriptionEntityScore(entity: any): number {
  return (entity.sensitive || entity.is_sensitive ? 20 : 0) +
    (Array.isArray(entity.relationships) ? entity.relationships.length * 2 : 0) +
    (Array.isArray(entity.fields) ? Math.min(10, entity.fields.length) : 0);
}

function highValueDescriptionEntryPoints(cas: CASOutput): any[] {
  // Structural importance of the entry point's handler/source node orders the
  // enrichment queue (ordering only, never a cutoff) — security/criticality
  // remain as secondary terms and the pre-layer fallback.
  const importanceById = new Map<string, number>();
  for (const node of cas.nodes || []) {
    if (typeof (node as any).structural_importance === 'number') {
      importanceById.set(node.id, (node as any).structural_importance);
    }
  }
  return [...(cas.entry_points || [])]
    .filter(entryPoint => clean(entryPoint.name) || clean(entryPoint.trigger?.path))
    .sort((left, right) => descriptionEntryPointScore(right, importanceById) - descriptionEntryPointScore(left, importanceById))
    .slice(0, 4);
}

function descriptionEntryPointScore(entryPoint: any, importanceById?: Map<string, number>): number {
  const importance = importanceById
    ? Math.max(importanceById.get(entryPoint.handler?.node_id) || 0, importanceById.get(entryPoint.source_node) || 0)
    : 0;
  return importance * 1000 +
    (entryPoint.security?.requires_auth === false ? 20 : 0) +
    (entryPoint.criticality === 'critical' ? 10 : entryPoint.criticality === 'high' ? 6 : 0) +
    (entryPoint.trigger?.type === 'http' ? 3 : 0);
}

function elementDescriptionReasons(element: any): string[] {
  const description = clean(element.description);
  const source = clean(element.description_source);
  const generation = element.description_generation;
  const reasons: string[] = [];
  if (description.length < 50) reasons.push(description ? 'description is too short for drilldown orientation' : 'description is missing');
  if (/\b[\w.-]+\.(?:ts|tsx|js|jsx|py|php|rb|go|rs|java|cs|dart|swift|kt|sql|tf|tfvars|hcl|yaml|yml|json)\b/i.test(description) ||
    /\borientation entry\b/i.test(description)) {
    reasons.push('source artifact restatement');
  }
  if (description && /\b(?:operations for|functionality|specific functions?|helper functions?|internal files?|graph structure|coordinates? operations|handles? operations|supports? tasks|[A-Z][a-z]+ Management covers)\b/i.test(description)) {
    reasons.push('description is structural or generic');
  }
  if (!isTrustedDescriptionSource(source)) reasons.push(`source is ${source || 'missing'}`);
  if (generation && isBadDescriptionGeneration(generation)) {
    reasons.push(`generation ${generation.status}${generation.reason ? ` (${generation.reason})` : ''}`);
  }
  return Array.from(new Set(reasons));
}

function descriptionAcknowledgesCoverageGap(description: string, languageName: string): boolean {
  const lower = description.toLowerCase();
  return lower.includes(languageName.toLowerCase()) && /analy[sz]|cover/.test(lower);
}

function scoreLayeredDescriptionPolicy(cas: CASOutput): UsefulnessGate {
  const capabilities = cas.system_capabilities || [];
  const systemGeneration = cas.enhanced_system_purpose?.description_generation;
  const capabilityGenerations = capabilities.map(capability => capability.description_generation).filter(Boolean);
  const aiApplied = [
    systemGeneration,
    ...capabilityGenerations,
  ].filter(generation => generation?.status === 'ai_applied').length;
  const attempted = [
    systemGeneration,
    ...capabilityGenerations,
  ].filter(generation => generation?.attempted).length;
  const requiredTargets = 1 + Math.min(capabilities.length, 8);
  const phases = cas.analysis_phases || [];
  const aiPhase = phases.find((phase: any) => phase.id === 'ai-enrichment' || phase.purpose === 'ai-enrichment');
  const details: string[] = [];
  let score = 0;

  if (clean(cas.enhanced_system_purpose?.inferred_description || cas.system?.description).length >= 40) score += 25;
  else details.push('missing compact system orientation');
  if (capabilities.length > 0) score += 25;
  else details.push('missing capabilities for fast agent orientation');
  if (aiApplied >= Math.min(requiredTargets, attempted || requiredTargets)) score += 25;
  else details.push(`required AI summary/capability pass incomplete (${aiApplied}/${requiredTargets} applied)`);
  if (aiPhase?.status === 'complete' || aiPhase?.status === 'partial' || attempted > 0) score += 25;
  else details.push('required AI summary/capability enrichment was not attempted or recorded');

  return gate('description-layering', score, details.length ? details.join('; ') : 'agent-fast includes required AI summary/capability descriptions while deferring deeper element descriptions');
}

function scoreCapabilityMap(cas: CASOutput, profile: AnalysisProfile): UsefulnessGate {
  const capabilities = cas.system_capabilities || [];
  const workflows = cas.workflows || [];
  const required = profile.kind === 'library-package' || profile.kind === 'test-package' || profile.kind === 'infrastructure' ? 1 : 2;
  let score = 0;
  const details: string[] = [];

  if (capabilities.length >= required) score += 30; else details.push(`${capabilities.length}/${required} capabilities`);
  const named = capabilities.filter(capability => clean(capability.name) && !GENERIC_TERMS.has(clean(capability.name).toLowerCase())).length;
  const usableNamed = capabilities.filter(capability => isUsefulCapabilityName(capability.name)).length;
  if (named >= Math.min(required, capabilities.length || required) && usableNamed >= Math.ceil(capabilities.length * 0.5)) score += 20; else details.push('capability names are weak or generic');
  const described = capabilities.filter(capability => clean(capability.description).length >= 30).length;
  if (described >= Math.min(required, capabilities.length || required)) score += 20; else details.push('capability descriptions are too thin');
  const linked = capabilities.filter(capability =>
    (capability.related_entities || []).length > 0 ||
    (capability.related_domains || []).length > 0 ||
    (capability.operations || []).length > 0
  ).length;
  if (linked >= Math.min(required, capabilities.length || required)) score += 20; else details.push('capabilities lack entity/domain/operation links');
  if (workflows.length > 0 || profile.expectations.flow_coverage !== 'required') score += 10; else details.push('no workflows for behavior-level orientation');

  return gate('capability-map', score, details.length ? details.join('; ') : `${capabilities.length} capabilities`);
}

function scoreArchitectureMap(cas: CASOutput, profile: AnalysisProfile): UsefulnessGate {
  const patterns = cas.architecture_summary?.architectural_patterns || [];
  const inventory = cas.architecture_summary?.architectural_inventory || {};
  const nodes = cas.nodes || [];
  const systemTypeProblems = findArchitectureSystemTypeProblems(cas, profile);
  let score = 0;
  const details: string[] = [];

  if (profile.kind === 'empty' || profile.kind === 'infrastructure') {
    return gate('architecture-map', 100, `${profile.kind} does not require application architecture inventory`);
  }

  if (systemTypeProblems.length === 0) score += 15; else details.push(...systemTypeProblems);
  if (patterns.length > 0 || nodes.length < 30 || profile.kind === 'library-package') score += 20; else details.push('no architectural patterns for non-trivial app');
  if (patterns.length <= 10) score += 10; else details.push(`pattern splurge (${patterns.length} patterns)`);
  const evidenceBacked = patterns.filter(pattern => (pattern.evidence || []).length > 0 && (pattern.node_ids || []).length > 0).length;
  if (patterns.length === 0 || evidenceBacked >= Math.ceil(patterns.length * 0.75)) score += 20; else details.push('patterns lack evidence-backed node ids');
  const inventoryCount = Object.values(inventory as Record<string, unknown>).reduce<number>((sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0);
  if (inventoryCount > 0 || nodes.length < 30) score += 15; else details.push('architecture inventory is empty');
  if (patternInventoryIsConsistent(patterns, inventory)) score += 15; else details.push('named patterns do not have matching inventory');
  if (cas.architecture_summary?.pattern_balance?.status !== 'over-patterned') score += 10; else details.push('pattern balance reports over-patterning');

  if (systemTypeProblems.length > 0) score = Math.min(score, 65);
  return gate('architecture-map', score, details.length ? details.join('; ') : `${patterns.length} patterns, ${inventoryCount} inventory items`);
}

function scoreCasOrganization(cas: CASOutput, profile: AnalysisProfile): UsefulnessGate {
  const nodes = cas.nodes || [];
  const edges = cas.edges || [];
  const entryPoints = cas.entry_points || [];
  const capabilities = cas.system_capabilities || [];
  const domains = cas.domain_concepts || [];
  const facts = cas.analysis_facts || [];
  const validation = cas.validation;
  const details: string[] = [];
  let score = 0;

  if (profile.kind === 'empty') {
    return gate('cas-organization', 100, 'empty analysis does not require graph organization');
  }

  if (nodes.length > 0) score += 10; else details.push('no graph nodes');
  if (edges.length > 0 || profile.kind === 'infrastructure' || profile.kind === 'library-package') score += 15; else details.push('no graph edges');

  const nodesWithSource = nodes.filter(node => node.source?.file).length;
  const sourceCoverage = nodes.length > 0 ? nodesWithSource / nodes.length : 0;
  if (sourceCoverage >= 0.65 || nodes.length < 20) score += 15; else details.push(`low node source coverage (${Math.round(sourceCoverage * 100)}%)`);

  if (cas.index && Object.keys(cas.index).length > 0) score += 10; else details.push('missing CAS index');
  if (!validation?.graph_integrity || validation.graph_integrity.dangling_edges === 0) score += 10;
  else details.push(`graph validation reports ${validation.graph_integrity.dangling_edges} dangling edges`);
  if (facts.length > 0 || profile.kind === 'infrastructure') score += 10; else details.push('missing analysis facts for traceability');

  const linkedCapabilities = capabilities.filter(capability =>
    (capability.related_entities || []).length > 0 ||
    (capability.related_domains || []).length > 0 ||
    (capability.operations || []).length > 0
  ).length;
  if (capabilities.length === 0 || linkedCapabilities >= Math.ceil(capabilities.length * 0.5)) score += 10;
  else details.push('capabilities are not linked to domains, entities, or operations');

  const domainEvidence = domains.filter(domain =>
    (domain.appears_in?.nodes || []).length > 0 ||
    (domain.appears_in?.entry_points || []).length > 0 ||
    (domain.appears_in?.entities || []).length > 0
  ).length;
  if (domains.length === 0 || domainEvidence >= Math.ceil(domains.length * 0.5)) score += 10;
  else details.push('domain concepts lack node, entry point, or data-entity evidence');

  const pollutedNodes = nodes.filter(node => {
    const file = String(node.source?.file || '').replace(/\\/g, '/').toLowerCase();
    return /(^|\/)(fixtures?|__fixtures__|\.klauro[^/]*|\.agents|\.claude\/worktrees|\.codex|node_modules|\.next|dist|build|coverage)\//.test(file);
  }).length;
  const pollutionRatio = nodes.length > 0 ? pollutedNodes / nodes.length : 0;
  if (pollutionRatio <= 0.05) score += 15; else details.push(`generated/fixture pollution in graph (${Math.round(pollutionRatio * 100)}%)`);

  return gate('cas-organization', score, details.length ? details.join('; ') : `${nodes.length} nodes, ${edges.length} edges, ${facts.length} facts`);
}

export function findArchitectureSystemTypeProblems(cas: CASOutput, profile: AnalysisProfile): string[] {
  const problems: string[] = [];
  const systemType = clean(cas.architecture_summary?.system_type);
  const lower = systemType.toLowerCase();
  if (!systemType && !['empty', 'infrastructure'].includes(profile.kind)) {
    problems.push('architecture system_type is missing');
    return problems;
  }
  if (!systemType) return problems;

  if (/\b(jest|vitest|mocha|jasmine|cypress|playwright|testing-library)\b/i.test(systemType)) {
    problems.push(`architecture system_type "${systemType}" is a test framework, not the product architecture`);
  }

  const productFiles = (cas.nodes || [])
    .filter(node => node.source?.file && !isLikelyTestPath(node.source.file))
    .map(node => String(node.source!.file).replace(/\\/g, '/').toLowerCase());
  const pathText = productFiles.join('\n');
  const hasAppsAndPackages = productFiles.some(file => /(^|\/)apps\//.test(file)) &&
    productFiles.some(file => /(^|\/)(packages|libs)\//.test(file));
  const hasMcpAnalyzerShape = (/\bmcp-server\b|modelcontextprotocol|(^|\/)mcp(\/|-)/.test(pathText)) &&
    (/\banalyzer-core\b|(^|\/)analyzers?\//.test(pathText) ||
      (cas.nodes || []).some(node => /analy[sz]er/i.test(`${node.name} ${node.type}`)));
  const frameworkOnlyType = /^(express(?:\.js)?|nestjs|fastapi|django|flask|next(?:\.js)?|react|vue(?:\.js)?|angular|spring boot|asp\.net core)$/i.test(systemType);

  if (hasMcpAnalyzerShape && hasAppsAndPackages && frameworkOnlyType) {
    problems.push(`architecture system_type "${systemType}" misses the MCP analyzer monorepo shape`);
  }
  if (profile.kind === 'frontend-app' && /^(express(?:\.js)?|nestjs|fastapi|django|flask|spring boot|asp\.net core)$/i.test(systemType)) {
    problems.push(`architecture system_type "${systemType}" conflicts with frontend-app profile`);
  }
  if (profile.kind === 'backend-service' && /^(react|next(?:\.js)?|vue(?:\.js)?|angular)$/i.test(systemType)) {
    problems.push(`architecture system_type "${systemType}" conflicts with backend-service profile`);
  }
  if (profile.kind === 'mobile-app' && !/\b(mobile|flutter|dart|ios|android)\b/i.test(systemType)) {
    problems.push(`architecture system_type "${systemType}" does not reflect mobile-app profile`);
  }
  if (profile.kind === 'desktop-app' && !/\b(desktop|electron|tauri|wpf|winforms)\b/i.test(systemType)) {
    problems.push(`architecture system_type "${systemType}" does not reflect desktop-app profile`);
  }
  if (profile.kind === 'infrastructure' && !/\b(infrastructure|terraform|opentofu|cloud|platform)\b/i.test(systemType)) {
    problems.push(`architecture system_type "${systemType}" does not reflect infrastructure shape`);
  }
  if (profile.kind === 'backend-service' && /\bmcp server\b/i.test(systemType) && hasAppsAndPackages && !hasMcpAnalyzerShape) {
    problems.push(`architecture system_type "${systemType}" over-focuses on one MCP-named app instead of the backend monorepo shape`);
  }
  if (/\b(wpf|winforms|xaml|desktop)\b/i.test(pathText) && /\bcli\b/i.test(systemType)) {
    problems.push(`architecture system_type "${systemType}" mislabels a desktop application as CLI`);
  }
  if (profile.kind === 'cli-tool' && frameworkOnlyType && !/\bcli|command|tool|mcp|analyzer\b/i.test(systemType) && productFiles.some(file => /(^|\/)(cli|bin|commands?)\//.test(file))) {
    problems.push(`architecture system_type "${systemType}" conflicts with CLI-oriented product shape`);
  }

  return Array.from(new Set(problems));
}

function scoreAgentNavigation(agentContext: any, profile: AnalysisProfile): UsefulnessGate {
  const filePlan = Array.isArray(agentContext?.file_read_plan) ? agentContext.file_read_plan : [];
  const nextCalls = Array.isArray(agentContext?.next_mcp_calls) ? agentContext.next_mcp_calls : [];
  const tokenEstimate = estimateTokens(JSON.stringify(agentContext || {}));
  let score = 0;
  const details: string[] = [];
  const sourceNeeded = !['empty', 'infrastructure'].includes(profile.kind);

  if (agentContext?.agent_context_ready === true) score += 20; else details.push('agent context is not agent-context-ready ready');
  if (!sourceNeeded || filePlan.length > 0) score += 25; else details.push('no concrete file-read plan');
  if (filePlan.length <= 8) score += 15; else details.push(`file-read plan is too broad (${filePlan.length} files)`);
  if (agentContext?.selected_node || profile.kind === 'empty' || profile.kind === 'infrastructure') score += 15; else details.push('no selected target node');
  if (nextCalls.length > 0) score += 10; else details.push('no recommended MCP follow-up calls');
  if (tokenEstimate <= 10000) score += 15; else details.push(`agent context too large (${tokenEstimate} tokens)`);

  return gate('agent-navigation', score, details.length ? details.join('; ') : `${filePlan.length} files, ${tokenEstimate} tokens`);
}

export function scoreArchitectureAgentContext(agentContext: any, profile: AnalysisProfile): UsefulnessGate {
  if (profile.kind === 'empty' || profile.kind === 'infrastructure' || profile.kind === 'test-package') {
    return gate('architecture-agent-context', 100, `${profile.kind} does not require architecture placement guidance`);
  }

  const context = agentContext?.work_context?.architecture_context;
  const details: string[] = [];
  let score = 0;

  if (context && typeof context === 'object') score += 15; else details.push('missing architecture_context in agent context');
  if (clean(context?.system_type) && clean(context.system_type) !== 'unknown') score += 10; else details.push('missing architecture system type');

  const budget = Array.isArray(context?.architecture_budget) ? context.architecture_budget : [];
  const patterns = Array.isArray(context?.patterns) ? context.patterns : [];
  const matrix = Array.isArray(context?.pattern_decision_matrix) ? context.pattern_decision_matrix : [];
  const inventoryCounts = context?.inventory_counts && typeof context.inventory_counts === 'object' ? context.inventory_counts : {};
  const inventoryExamples = context?.inventory_examples && typeof context.inventory_examples === 'object' ? context.inventory_examples : {};
  const relevantInventory = context?.relevant_inventory && typeof context.relevant_inventory === 'object' ? context.relevant_inventory : {};

  if (budget.length > 0 || profile.kind === 'library-package') score += 15; else details.push('missing architecture budget');
  if (patterns.length > 0 || profile.kind === 'library-package') score += 15; else details.push('missing detected architecture patterns');

  const inventoryCount = Object.values(inventoryCounts).reduce<number>((sum, value) => sum + (typeof value === 'number' ? value : 0), 0);
  const exampleCount = countInventoryNodes(inventoryExamples);
  const relevantCount = countInventoryNodes(relevantInventory);
  if (inventoryCount > 0 || exampleCount > 0 || relevantCount > 0 || profile.kind === 'library-package') score += 15;
  else details.push('missing architecture inventory owners');

  const matrixWithGuidance = matrix.filter((item: any) =>
    clean(item?.pattern) &&
    clean(item?.use_when) &&
    (Array.isArray(item?.owner_categories) ? item.owner_categories.length > 0 : false)
  ).length;
  let missingMatrix = false;
  if (matrix.length === 0 && patterns.length === 0 && profile.kind === 'library-package') score += 20;
  else if (matrixWithGuidance >= Math.min(2, Math.max(1, Math.ceil(patterns.length * 0.4)))) score += 20;
  else {
    missingMatrix = true;
    details.push('missing actionable pattern decision matrix');
  }

  const rules = Array.isArray(context?.agent_rules) ? context.agent_rules : [];
  if (rules.some((rule: string) => /pattern|architecture|owner|boundary|style/i.test(rule))) score += 10;
  else details.push('missing architecture preservation rules');

  const scopeProblems = findArchitectureContextScopeProblems(agentContext);
  if (scopeProblems.length > 0) {
    details.push(...scopeProblems);
    score = Math.min(score, 70);
  }
  if (missingMatrix) score = Math.min(score, 65);
  return gate('architecture-agent-context', score, details.length ? details.join('; ') : `${patterns.length} patterns, ${matrix.length} decision rows`);
}

function findArchitectureContextScopeProblems(agentContext: any): string[] {
  const selectedFile = clean(agentContext?.selected_node?.file || agentContext?.selected_node?.source?.file);
  const planFiles = Array.isArray(agentContext?.file_read_plan)
    ? agentContext.file_read_plan
      .filter((item: any) => !/task hint/i.test(clean(item?.reason)))
      .map((item: any) => clean(item?.file))
      .filter(Boolean)
    : [];
  const anchorFiles = uniqueReviewStrings([selectedFile, ...planFiles].filter(Boolean));
  if (anchorFiles.length === 0) return [];

  const context = agentContext?.work_context?.architecture_context;
  const examples = collectArchitectureContextExampleFiles(context)
    .filter(file => !/^(?:node_modules|dist|build|coverage|\.klauro|\.agents|\.claude|\.codex)(?:\/|$)/i.test(file));
  if (examples.length === 0) return [];

  const offScope = examples.filter(file => !anchorFiles.some(anchor => sameReviewArchitectureScope(anchor, file)));
  if (offScope.length === 0) return [];
  const ratio = offScope.length / examples.length;
  if (ratio <= 0.5 && offScope.length <= 2) return [];
  return [`architecture context examples are mostly outside selected file scope: ${uniqueReviewStrings(offScope).slice(0, 4).join(', ')}`];
}

function collectArchitectureContextExampleFiles(context: any): string[] {
  const files: string[] = [];
  const add = (item: any) => {
    const file = clean(item?.file || item?.source?.file);
    if (file) files.push(normalizeReviewPath(file));
  };
  for (const row of Array.isArray(context?.pattern_decision_matrix) ? context.pattern_decision_matrix : []) {
    for (const example of Array.isArray(row?.examples) ? row.examples : []) add(example);
  }
  const beforeRelevant = files.length;
  for (const group of Object.values(context?.relevant_inventory || {})) {
    for (const item of Array.isArray(group) ? group : []) add(item);
  }
  if (files.length === beforeRelevant) {
    for (const group of Object.values(context?.inventory_examples || {})) {
      for (const item of Array.isArray(group) ? group : []) add(item);
    }
  }
  return uniqueReviewStrings(files);
}

function scoreIdiomAndInvariantGuidance(cas: CASOutput, agentContext: any, profile: AnalysisProfile): UsefulnessGate {
  const idioms = cas.codebase_idioms || [];
  const invariants = cas.behavioral_invariants || [];
  const contextIdioms = agentContext?.work_context?.idiom_context;
  const contextInvariants = agentContext?.work_context?.behavioral_invariants;
  let score = 0;
  const details: string[] = [];
  const behaviorRequired = profile.expectations.behavioral_invariants === 'required';

  if (idioms.length > 0) score += 25; else details.push('no repo-local idioms');
  const usableIdioms = idioms.filter(idiom =>
    idiom.confidence >= 0.5 &&
    (idiom.evidence || []).length > 0 &&
    (idiom.positive_examples || []).length > 0 &&
    ((idiom.agent_guidance?.do || []).length > 0 || (idiom.agent_guidance?.avoid || []).length > 0)
  ).length;
  if (idioms.length === 0 || usableIdioms >= Math.ceil(idioms.length * 0.6)) score += 25; else details.push('idioms lack evidence, examples, or agent guidance');
  if (contextIdioms || idioms.length === 0) score += 15; else details.push('agent context omits idiom context');
  if (!behaviorRequired || invariants.length > 0) score += 20; else details.push('no behavioral invariants for app/service repo');
  if (!behaviorRequired || contextInvariants || invariants.length === 0) score += 15; else details.push('agent context omits invariant context');

  return gate('idiom-invariant-guidance', score, details.length ? details.join('; ') : `${idioms.length} idioms, ${invariants.length} invariants`);
}

export function scoreDuplicationAvoidance(cas: CASOutput, agentContext: any, profile: AnalysisProfile): UsefulnessGate {
  const capabilities = cas.system_capabilities || [];
  const workflows = cas.workflows || [];
  const concepts = cas.domain_concepts || [];
  const selected = agentContext?.selected_node;
  const contextText = JSON.stringify({
    target: agentContext?.target_resolution,
    selected,
    entry_context: agentContext?.work_context?.entry_context,
    capabilities: capabilities.slice(0, 8).map(capability => capability.name),
    workflows: workflows.slice(0, 8).map(workflow => workflow.name),
  });
  let score = 0;
  const details: string[] = [];

  if (profile.kind === 'empty') return gate('duplication-avoidance', 100, 'empty analysis has no duplication surface');
  if (profile.kind === 'infrastructure') {
    const infraInventory = cas.architecture_summary?.architectural_inventory;
    const infraOwners = Object.values(infraInventory || {}).reduce<number>((sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0);
    if (infraOwners > 0 || (cas.codebase_idioms || []).length > 0) {
      return gate('duplication-avoidance', 100, 'infrastructure duplication guidance comes from resource/module inventory and idioms');
    }
  }
  if (capabilities.length >= 2 || profile.kind === 'library-package') score += 25; else details.push('too few capabilities to warn against duplicate work');
  if (workflows.length > 0 || concepts.length >= 2 || profile.kind === 'library-package') score += 20; else details.push('few workflows/domain concepts for overlap detection');
  if (selected || profile.kind === 'infrastructure') score += 20; else details.push('agent context cannot anchor the requested change to existing code');
  if (/capabilit|workflow|entry|selected|idiom|existing/i.test(contextText)) score += 20; else details.push('agent context does not expose existing behavior context');
  if ((cas.edges || []).length > 0 || (cas.method_calls || []).length > 0 || profile.kind === 'library-package') score += 15; else details.push('relationship graph is too thin for duplicate-work avoidance');

  return gate('duplication-avoidance', score, details.length ? details.join('; ') : 'existing behavior context present');
}

function scoreExternalIntegrationEvidence(cas: CASOutput, profile: AnalysisProfile): UsefulnessGate {
  if (profile.kind === 'empty') return gate('external-integration-evidence', 100, 'empty analysis has no integration surface');
  const services: string[] = ((cas as any).external_services || [])
    .map((service: any) => clean(service?.name || service?.service || service))
    .filter((name: string) => Boolean(name) && !isRuntimeIntegrationNoise(name));
  // An "external integration" whose name is command-shaped (a leaked CI/shell
  // fragment, e.g. `dotnet pack "Foo.csproj" -p:Version=$VER`) is not evidence
  // of a real integration. Score it as an unexplained claim using the SAME lens
  // the product path uses to reject such labels (isCommandShapedLabel), so the
  // referee and the product agree and this gate can catch regressions of the
  // class it exists to catch.
  const weakNames = services.filter(name => looksLikeInternalMemberAccess(name) || isCommandShapedLabel(name));
  if (services.length === 0) return gate('external-integration-evidence', 100, 'no external integrations claimed');
  if (weakNames.length === 0) return gate('external-integration-evidence', 100, `${services.length} external integration claims look service-like`);
  const score = Math.max(0, 100 - Math.ceil((weakNames.length / services.length) * 100));
  return gate(
    'external-integration-evidence',
    score,
    `external integration names look like internal member access or command fragments: ${weakNames.slice(0, 5).join(', ')}`
  );
}

function patternInventoryIsConsistent(patterns: any[], inventory: any): boolean {
  const names = patterns.map(pattern => String(pattern.name || '').toLowerCase());
  if (names.some(name => name.includes('mvc')) && (!inventory.controllers?.length || !inventory.models?.length)) return false;
  if (names.some(name => name.includes('mvvm')) && (!inventory.views?.length || !inventory.view_models?.length || !inventory.models?.length)) return false;
  if (names.some(name => name.includes('repository')) && !inventory.repositories?.length) return false;
  if (names.some(name => name.includes('mediator')) && !inventory.mediators?.length) return false;
  if (names.some(name => name.includes('unit of work')) && !inventory.unit_of_work?.length) return false;
  if (names.some(name => name.includes('singleton')) && !inventory.singletons?.length) return false;
  return true;
}

function inferReviewTarget(cas: CASOutput): string {
  const capability = (cas.system_capabilities || []).find(item => item.category === 'core') || (cas.system_capabilities || [])[0];
  if (capability?.name) return capability.name;
  const domain = cas.enhanced_system_purpose?.primary_domain;
  if (domain) return domain;
  const node = (cas.nodes || []).find(item => item.source?.file && !isLikelyTestPath(item.source.file));
  return node?.name || 'main behavior';
}

function summarizeReviews(reviews: AnalysisUsefulnessReview[]) {
  const pass = reviews.filter(review => review.status === 'pass').length;
  const warn = reviews.filter(review => review.status === 'warn').length;
  const fail = reviews.filter(review => review.status === 'fail').length;
  const gateIds = Array.from(new Set(reviews.flatMap(review => review.gates.map(gate => gate.id))));
  const gates = Object.fromEntries(gateIds.map(id => {
    const matching = reviews.flatMap(review => review.gates.filter(gate => gate.id === id));
    return [id, {
      average_score: Math.round(average(matching.map(gate => gate.score))),
      pass: matching.filter(gate => gate.status === 'pass').length,
      warn: matching.filter(gate => gate.status === 'warn').length,
      fail: matching.filter(gate => gate.status === 'fail').length,
    }];
  }));
  return {
    review_count: reviews.length,
    pass,
    warn,
    fail,
    average_score: Math.round(average(reviews.map(review => review.score))),
    average_agent_context_tokens: Math.round(average(reviews.map(review => review.summary.agent_context_tokens))),
    average_duration_ms: Math.round(average(reviews.map(review => review.duration_ms || 0))),
    gate_summary: gates,
    weakest_repos: [...reviews]
      .sort((a, b) => a.score - b.score)
      .slice(0, 10)
      .map(review => ({
        repo: review.repo,
        score: review.score,
        status: review.status,
        profile: review.profile.kind,
        missing_agent_value: review.summary.missing_agent_value,
      })),
  };
}

function formatMarkdown(report: Awaited<ReturnType<typeof runAnalysisUsefulnessReview>>): string {
  const lines = [
    '# Klauro Analysis Usefulness Review',
    '',
    `Generated: ${report.generated_at}`,
    `Analysis focus: ${report.analysis_focus}`,
    `Status: ${report.status}`,
    `Score: ${report.score}/100`,
    `Duration: ${formatDuration(report.duration_ms)}`,
    '',
    '## Summary',
    '',
    `Reviews: ${report.summary.review_count}`,
    `Pass: ${report.summary.pass}`,
    `Warn: ${report.summary.warn}`,
    `Fail: ${report.summary.fail}`,
    `Average agent context tokens: ${report.summary.average_agent_context_tokens}`,
    `Average review duration: ${formatDuration(report.summary.average_duration_ms)}`,
    '',
    '## Gate Summary',
    '',
    '| Gate | Avg Score | Pass | Warn | Fail |',
    '| --- | ---: | ---: | ---: | ---: |',
  ];
  for (const [id, summary] of Object.entries(report.summary.gate_summary) as any) {
    lines.push(`| ${id} | ${summary.average_score} | ${summary.pass} | ${summary.warn} | ${summary.fail} |`);
  }
  lines.push('', '## Weakest Repos', '', '| Repo | Status | Score | Profile | Missing Agent Value |', '| --- | --- | ---: | --- | --- |');
  for (const repo of report.summary.weakest_repos) {
    lines.push(`| ${repo.repo} | ${repo.status} | ${repo.score} | ${repo.profile} | ${repo.missing_agent_value.join('<br>') || 'none'} |`);
  }
  lines.push('', '## Reviews', '', '| Repo | Status | Score | Profile | Domain | Capabilities | Idioms | Context Tokens |', '| --- | --- | ---: | --- | --- | ---: | ---: | ---: |');
  for (const review of report.reviews) {
    lines.push(`| ${review.repo} | ${review.status} | ${review.score} | ${review.profile.kind} | ${review.summary.primary_domain || ''} | ${review.summary.capability_count} | ${review.summary.idiom_count} | ${review.summary.agent_context_tokens} |`);
  }
  return `${lines.join('\n')}\n`;
}

function formatDuration(ms: number | undefined): string {
  if (!Number.isFinite(ms) || !ms) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

function parseArgs(argv: string[]): ParsedArgs {
  const repos: ReviewTarget[] = [];
  let includeRealRepos = false;
  let devRoot = path.join(process.env.HOME || '', 'dev');
  let maxTargets: number | undefined;
  let concurrency = 1;
  let analysisFocus: AnalysisFocus = 'full';
  let outputPath = path.join(process.cwd(), '.klauro-analysis-usefulness-review', 'latest-report.json');
  let markdownPath = path.join(process.cwd(), '.klauro-analysis-usefulness-review', 'latest-report.md');

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo') {
      const value = argv[++i];
      if (!value) throw new Error('--repo requires a path or name=path value');
      const [namePart, repoPathPart] = value.includes('=') ? value.split('=') : [undefined, value];
      repos.push({ name: namePart || path.basename(repoPathPart), path: path.resolve(repoPathPart) });
    } else if (arg === '--real-repos') includeRealRepos = true;
    else if (arg === '--dev-root') devRoot = path.resolve(argv[++i]);
    else if (arg === '--max-targets') maxTargets = Number(argv[++i]);
    else if (arg === '--concurrency') concurrency = Number(argv[++i]);
    else if (arg === '--analysis-focus') {
      const value = argv[++i] as AnalysisFocus | undefined;
      if (!value || !['agent-fast', 'ui-overview', 'deep-context', 'full'].includes(value)) {
        throw new Error('--analysis-focus must be one of agent-fast, ui-overview, deep-context, full');
      }
      analysisFocus = value;
    }
    else if (arg === '--output') outputPath = path.resolve(argv[++i]);
    else if (arg === '--markdown') markdownPath = path.resolve(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return { repos, includeRealRepos, devRoot, maxTargets, concurrency, analysisFocus, outputPath, markdownPath };
}

function printHelp(): void {
  console.log([
    'Usage: npm run analysis-usefulness-review -- [options]',
    '',
    'Options:',
    '  --repo name=/path/to/repo       Review a specific repo. May be repeated.',
    '  --real-repos                   Review eligible repos discovered under --dev-root.',
    '  --dev-root /path               Root used for real repo discovery. Default ~/dev.',
    '  --max-targets n                Limit reviewed repos.',
    '  --concurrency n                Number of concurrent analyses. Default 1.',
    '  --analysis-focus focus         agent-fast, ui-overview, deep-context, or full. Default full.',
    '  --output /path/report.json     Write JSON report.',
    '  --markdown /path/report.md     Write Markdown report.',
  ].join('\n'));
}

function gate(id: string, score: number, detail: string): UsefulnessGate {
  const bounded = Math.max(0, Math.min(100, Math.round(score)));
  return { id, score: bounded, status: statusFromScore(bounded), detail };
}

function statusFromScore(score: number): GateStatus {
  if (score >= 85) return 'pass';
  if (score >= 70) return 'warn';
  return 'fail';
}

function aggregateStatus(statuses: GateStatus[]): GateStatus {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'warn';
  return 'pass';
}

function average(values: number[]): number {
  if (values.length === 0) return 100;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function clean(value: unknown): string {
  return String(value || '').trim();
}

function uniqueReviewStrings(values: string[]): string[] {
  return Array.from(new Set(values.map(value => clean(value)).filter(Boolean)));
}

function normalizeReviewPath(value: string): string {
  let normalized = clean(value).replace(/\\/g, '/').toLowerCase().replace(/^\/+/, '');
  normalized = normalized.replace(/(^|\/)src\/app\/features\//, 'features/');
  normalized = normalized.replace(/(^|\/)app\/features\//, 'features/');
  normalized = normalized.replace(/(^|\/)src\/app\/defs-api\//, 'defs-api/');
  normalized = normalized.replace(/(^|\/)app\/defs-api\//, 'defs-api/');
  normalized = normalized.replace(/(^|\/)app\/assets\//, 'assets/');
  normalized = normalized.replace(/(^|\/)app\/javascript\//, 'javascript/');
  normalized = normalized.replace(/(^|\/)vrs_system\/apps\//, 'apps/');
  normalized = normalized.replace(/(^|\/)modules\//, 'modules/');
  for (const marker of ['packages', 'apps', 'legacy', 'src', 'features', 'defs-api', 'modules', 'components', 'core', 'assets', 'javascript']) {
    const index = normalized.indexOf(`${marker}/`);
    if (index > 0) {
      normalized = normalized.slice(index);
      break;
    }
  }
  if (normalized.startsWith('modules/')) normalized = normalized.slice('modules/'.length);
  return normalized;
}

function sameReviewArchitectureScope(a: string, b: string): boolean {
  const left = normalizeReviewPath(a).toLowerCase().split('/').filter(Boolean);
  const right = normalizeReviewPath(b).toLowerCase().split('/').filter(Boolean);
  if (left.length === 0 || right.length === 0) return false;
  if (sameTrailingReviewPath(left, right)) return true;
  if (left[0] !== right[0]) return false;
  const shared = Math.min(left.length, right.length);
  if (left[0] === 'features') return shared >= 3 && left[1] === right[1] && left[2] === right[2];
  if (left[0] === 'defs-api') return shared >= 1;
  if (left[0] === 'assets' && left[1] === 'javascript' && right[1] === 'javascript') return shared >= 3 && left[2] === right[2];
  if (left[0] === 'src') return sameSrcReviewArchitectureScope(left, right, shared);
  if ((left[0] === 'apps' || left[0] === 'packages') && left[2] === 'src' && right[2] === 'src') {
    return shared >= 4 && left[1] === right[1] && left[3] === right[3];
  }
  if (left[0] === 'apps' || left[0] === 'packages') return shared >= 3 && left[1] === right[1] && left[2] === right[2];
  if (left[0] === 'legacy') return shared >= 3 && left[1] === right[1] && left[2] === right[2];
  return shared >= 2 && left[1] === right[1];
}

function sameSrcReviewArchitectureScope(left: string[], right: string[], shared: number): boolean {
  if (left[1] !== right[1]) return false;
  const featureScopedBuckets = new Set([
    'business',
    'components',
    'controllers',
    'features',
    'modules',
    'pages',
    'routes',
    'services',
    'stores',
  ]);
  if (!featureScopedBuckets.has(left[1])) return shared >= 2;
  if (shared < 3 || left[2] !== right[2]) return false;
  if (left[1] === 'services' && /^(?:adapter|adapters|external|external-sources|integrations?)$/.test(left[2])) {
    return shared >= 4 && left[3] === right[3];
  }
  return true;
}

function sameTrailingReviewPath(left: string[], right: string[]): boolean {
  const shared = Math.min(left.length, right.length);
  if (shared === 1) return left[left.length - 1] === right[right.length - 1];
  if (shared < 2) return false;
  return left[left.length - 1] === right[right.length - 1] &&
    left[left.length - 2] === right[right.length - 2];
}

function textMentionsAny(text: string, values: string[]): boolean {
  const lower = text.toLowerCase();
  return values.some(value => value && value.length > 2 && lower.includes(value.toLowerCase()));
}

export function findWeakDescriptionReasons(cas: CASOutput, profile: AnalysisProfile, description: string): string[] {
  const reasons: string[] = [];
  const text = clean(description);
  const lower = text.toLowerCase();
  if (!text || text.length < 80) {
    reasons.push('description is too short for agent orientation');
    return reasons;
  }

  const concepts = [
    ...(cas.enhanced_system_purpose?.core_concepts || []),
    ...(cas.domain_concepts || []).map(concept => concept.name),
    ...(cas.system_capabilities || []).map(capability => capability.name),
  ].map(value => clean(value).toLowerCase()).filter(Boolean);
  const distinctiveConcepts = concepts.filter(value => isDistinctiveDescriptionTerm(value));

  if (/project text identifies the main concepts as/i.test(text) && distinctiveConcepts.length < 3) {
    reasons.push('description is a weak project-text fallback without enough distinctive concepts');
  }
  if (looksLikeCasInventorySummary(text)) {
    reasons.push('description regurgitates CAS inventory instead of explaining system behavior');
  }
  if (/^a\s+\S+\s+system built with\b/i.test(text) && /key capabilities:/i.test(text)) {
    reasons.push('description uses a framework-template summary instead of a product paragraph');
  }
  if (/\b(access|network|data|app|page|component|service|route|user|settings)\b(?:,\s*\b(access|network|data|app|page|component|service|route|user|settings)\b){0,3}\.?$/i.test(text)) {
    reasons.push('description ends with generic concepts rather than product behavior');
  }
  if (/\b(seamless(?:ly)?|indispensable|unified experience|robust api|complex queries|large datasets|crucial role|underlying platform|wide range of clients|high-quality [a-z ]+ experience|regulatory requirements?|best practices|designed for managing|facilitates|various applications|robust [a-z ]*framework|enhances (?:the )?[a-z ]*(?:security|efficiency)|allowing developers to focus|complex tasks)\b/i.test(text)) {
    reasons.push('description contains generic AI marketing language');
  }
  if (/\b(has|serializers?|lookup|manage) management\b|\bsuperuser capability\b/i.test(text)) {
    reasons.push('description includes parser artifact capabilities such as has/serializer management');
  }
  if (/\b(method|queryset|graphql|generated|generator|select|authenticated?|verify|put|patch|pull|fetch|allow|for|ld|quick|external|services?|str|autenticacion|links?) management\b|\b(authenticated?|superuser|manage) capability\b|[<>{}()[\]'"]\s*management\b/i.test(text)) {
    reasons.push('description includes HTTP/parser/helper artifact capability labels');
  }
  if (/\b[a-z]+s handlers\b/i.test(text)) {
    reasons.push('description uses generated handler labels instead of human capability language');
  }
  if (/\bprimary interface for interacting with (?:the )?(?:application'?s )?database\b/i.test(text) ||
    /\bintermediary between the frontend ui and the server-side logic\b/i.test(text)) {
    reasons.push('description describes a generic backend role instead of this codebase');
  }
  const unsupportedClaim = text.match(/\b(command-line interface|coupons?|discounts?)\b/i)?.[1];
  if (unsupportedClaim &&
    !descriptionClaimIsSupportedByProfile(profile, unsupportedClaim) &&
    !descriptionTermIsGrounded(cas, unsupportedClaim)) {
    reasons.push(`description claims unsupported ${unsupportedClaim} behavior`);
  }
  if (/\b[A-Z][a-z]{1,3}\b/.test(text) &&
    [...text.matchAll(/\b[A-Z][a-z]{1,3}\b/g)].some(match => !descriptionTermIsGrounded(cas, match[0]) && !/^(A|An|The|This|It|Its|Key|Data|Entry|REST|API|UI|SQL|AWS|GPO)$/.test(match[0]))) {
    reasons.push('description includes unexplained short proper-noun claims');
  }
  if (profile.kind !== 'infrastructure' && lower.includes('evidence:') && distinctiveConcepts.length < 2) {
    reasons.push('evidence-backed summary lacks distinctive product concepts');
  }
  return Array.from(new Set(reasons));
}

function looksLikeCasInventorySummary(description: string): boolean {
  const labels = [
    /\bKey capabilities:/i,
    /\bData model:/i,
    /\bEntry points:/i,
    /\bIntegrations:/i,
    /\bSystem Health\b/i,
    /\bSee Diagram\b/i,
  ];
  const labelCount = labels.filter(pattern => pattern.test(description)).length;
  if (labelCount >= 2) return true;
  return /\bbuilt with [^.]+\. Key capabilities:/i.test(description);
}

function findWeakCapabilityDescriptionReasons(capability: any): string[] {
  const reasons: string[] = [];
  const name = clean(capability?.name);
  const description = clean(capability?.description);
  const lower = description.toLowerCase();

  if (!description || description.length < 50) {
    reasons.push('too short');
    return reasons;
  }
  if (/\b(?:mutation|query|handler|controller|route|page|component|command|function|method|file|event|message|http|api|graphql|click|submit|select|input|change|hover|mouse|keyboard|keypress|keydown|keyup)\s+management\b/i.test(name) &&
    description.toLowerCase().startsWith(name.toLowerCase())) {
    reasons.push('generic analyzer-derived capability name restatement');
  }
  if (description.length < 85 && /\b(?:covers|handles|manages|supports|coordinates|processes|reads|writes)\b/i.test(description)) {
    reasons.push('short generic capability phrasing');
  }
  if (/\b(?:operations for|functionality|centers on|graph endpoint|graph structure|coordinat(?:e|es|ing) operations|internal files?|supports? tasks|agent-driven operations|operations and insights|structured data and insights|better understanding|insights into|enhanc(?:e|es|ing)|robust|various|efficient|business value|streamline|codebase decision|specific codebase decision|before a codebase decision|within the platform interactions?|system components?|different system components?|executing tasks?|execute tasks?|runtime behavior)\b/i.test(description)) {
    reasons.push('generic structural or marketing phrase');
  }
  if (/\b(?:read|process|coordinate|analyze|delete) behavior\b/i.test(description) ||
    /\b(?:read|process|analyze|delete) paths?\b/i.test(description) ||
    /\b(?:reads?|processes?|coordinates?) internal files?\b/i.test(description)) {
    reasons.push('describes parser operations instead of product behavior');
  }
  if (/\b(?:specific functions?|helper functions?|parseArgs|formatTable|renderRow|argument parsing|table formatting|row rendering|process and structure data|structured data handling)\b/i.test(description)) {
    reasons.push('implementation-function-restatement');
  }
  if (/\b[a-z][a-z0-9]+[A-Z][A-Za-z0-9]*\b/.test(description) || /\bcoordinates?\s+(?:scripts?|functions?|helpers?|files?|modules?|operations?)\b/i.test(description)) {
    reasons.push('implementation detail restatement');
  }
  if (/\bthrough\s+[^.]{0,140}\b(?:handlers?|controllers?|routes?|pages?|components?|ws operations)\b/i.test(description) ||
    /\bacross\s+(?:pages?|routes?|handlers?|controllers?|components?)\b/i.test(description) ||
    /\bacross\s+[^.]{0,120}\b(?:pages?|routes?|handlers?|controllers?|components?|connectors?)\b/i.test(description) ||
    /\bmutating\s+state\s+through\s+(?:api\s+)?integrations?\b/i.test(description) ||
    /\bclick events?\b|\bnavigate and interact\b|\bpages?\s+[A-Z][A-Za-z0-9 ]+\b/i.test(description) ||
    /\b[A-Za-z][A-Za-z0-9 ]+\s+WS operations\b/i.test(description)) {
    reasons.push('implementation surface restatement');
  }
  if (/\b(?:terms and conditions|legal agreements?|commercial contracts?|contractual obligations?|agreements? between systems)\b/i.test(description) &&
    !/\b(?:legal|commercial|billing|subscription|customer contract|terms of service)\b/i.test(`${name} ${capability?.related_domains?.join(' ') || ''}`)) {
    reasons.push('unsupported legal-contract interpretation');
  }
  if (/^(?:supports?|coordinates?|reads?|processes?|handles?|manages?)\b/i.test(description)) {
    reasons.push('starts with a generic verb');
  }
  if (/^(?:handles?|manages?|supports?|coordinates?|covers?)\s+(?:operations|tasks|files|routes|handlers|commands|components)\b/i.test(description)) {
    reasons.push('describes code structure instead of user or agent value');
  }
  if (/\b(?:commands|handlers|controllers|services|routes|files|components)\b/i.test(name) &&
    /\b(?:operations|paths|tasks|files|routes|handlers|commands|components)\b/i.test(lower) &&
    !/\b(?:briefs|guidance|analysis|planning|storage|validation|preview|benchmark|review|evidence|risk|telemetry|architecture|idiom|invariant)\b/i.test(lower)) {
    reasons.push('capability label and description are both structural');
  }
  if (/\b(?:bin\/console|events handlers|message handlers|http handlers)\b/i.test(`${name} ${description}`)) {
    reasons.push('generated framework bucket masquerades as a primary capability');
  }
  if (hasOverNarrowCapabilitySourceClaim(description, capability)) {
    reasons.push('over-narrow source-area claim for broad capability');
  }
  if (description.includes('[object Object]')) {
    reasons.push('contains unserialized object output');
  }

  return Array.from(new Set(reasons));
}

function hasOverNarrowCapabilitySourceClaim(description: string, capability: any): boolean {
  const operations = Array.isArray(capability?.operations) ? capability.operations : [];
  if (operations.length < 4) return false;

  const extensionNames = new Set<string>();
  for (const operation of operations) {
    const command = clean(operation?.path_or_command).replace(/\\/g, '/').toLowerCase();
    const match = command.match(/(?:^|\/)extensions\/([^/]+)/);
    if (match?.[1]) extensionNames.add(match[1].replace(/[^a-z0-9]+/g, ''));
  }
  if (extensionNames.size < 4) return false;

  const lowerDescription = clean(description).toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const subjectText = [
    capability?.name,
    ...(Array.isArray(capability?.related_domains) ? capability.related_domains : []),
  ].join(' ').toLowerCase().replace(/[^a-z0-9]+/g, ' ');

  for (const extensionName of extensionNames) {
    if (extensionName.length < 4) continue;
    if (subjectText.includes(extensionName)) continue;
    if (lowerDescription.includes(extensionName)) return true;
  }
  return false;
}

export function findDomainBreadthProblems(cas: CASOutput, profile: AnalysisProfile, domain: string): string[] {
  if (!domain || !['backend-service', 'frontend-app', 'mobile-app', 'worker-service', 'cli-tool'].includes(profile.kind)) return [];
  const normalizedDomain = domain.toLowerCase();
  if (!/^(auth|authentication|login|user|users|session|sessions|identity|account|accounts)$/.test(normalizedDomain)) return [];

  const nonAuthCapabilities = (cas.system_capabilities || [])
    .map(capability => clean(capability.name).toLowerCase())
    .filter(name => name && isNonAuthProductTerm(name));
  const nonAuthEntities = [
    ...((cas.data_entities || []) as any[]).map(entity => clean(entity.name).toLowerCase()),
    ...((cas.database_schema?.entities || []) as any[]).map(entity => clean(entity.name).toLowerCase()),
    ...((cas.domain_concepts || []) as any[]).map(concept => clean(concept.name).toLowerCase()),
  ].filter(name => name && isNonAuthProductTerm(name));

  if (nonAuthCapabilities.length >= 3 || nonAuthEntities.length >= 2) {
    const evidence = [...new Set([...nonAuthCapabilities, ...nonAuthEntities])]
      .slice(0, 5)
      .join(', ');
    return [`primary domain "${domain}" is too narrow for broader product evidence (${evidence})`];
  }
  return [];
}

function isNonAuthProductTerm(value: string): boolean {
  const tokens = value.split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.some(token =>
    token.length > 3 &&
    !GENERIC_TERMS.has(token) &&
    !/^(auth|login|logout|user|users|session|sessions|identity|account|accounts|password|token|tokens|jwt|oauth|permission|permissions|role|roles)$/.test(token)
  );
}

function isDistinctiveDescriptionTerm(value: string): boolean {
  const tokens = value.split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.some(token => token.length > 3 && !GENERIC_TERMS.has(token) && !/^(access|network|data|user|users|page|pages|component|components|route|routes|service|services)$/.test(token));
}

function descriptionClaimIsSupportedByProfile(profile: AnalysisProfile, term: string): boolean {
  const normalized = clean(term).toLowerCase();
  if (normalized === 'command-line interface') {
    return profile.kind === 'cli-tool';
  }
  return false;
}

function descriptionTermIsGrounded(cas: CASOutput, term: string): boolean {
  const normalized = clean(term).toLowerCase();
  if (!normalized) return false;
  if (normalized === 'command-line interface') {
    return (cas.entry_points || []).some(entry => entry.type === 'cli');
  }
  const technologies = (cas.system as any)?.technologies || {};
  const haystack = JSON.stringify({
    system: cas.system?.name,
    domain: cas.enhanced_system_purpose?.primary_domain,
    concepts: cas.enhanced_system_purpose?.core_concepts,
    domainConcepts: (cas.domain_concepts || []).map(concept => concept.name),
    capabilities: (cas.system_capabilities || []).map(capability => capability.name),
    entities: [
      ...((cas.database_schema?.entities || []).map((entity: any) => entity?.name || '')),
      ...((cas.data_entities || []).map(entity => entity.name)),
    ],
    entries: (cas.entry_points || []).map(entry => `${entry.name} ${entry.type}`),
    integrations: ((cas as any).external_services || []).map((service: any) => `${service?.name || ''} ${service?.service || ''} ${service?.type || ''}`),
    languages: (technologies.languages || []).map((language: any) => `${language?.name || language}`),
    frameworks: [
      ...((technologies.frameworks || []).map((framework: any) => `${framework?.name || framework}`)),
      ...(((cas as any).frameworks || []).map((framework: any) => `${framework?.name || framework}`)),
    ],
    packages: [
      ...((cas.libraries || []).map(library => library?.name || '')),
      ...((cas.dependencies?.packages || []).map(pkg => pkg?.name || '')),
      ...(Array.isArray((cas as any).dependencies) ? ((cas as any).dependencies as any[]).map(dependency => `${dependency?.name || dependency}`) : []),
    ],
    nodes: (cas.nodes || []).slice(0, 200).map(node => `${node.name} ${node.type} ${node.source?.file || ''}`),
  }).toLowerCase();
  return haystack.includes(normalized);
}

function isLikelyTestPath(file: string): boolean {
  return /(^|\/)(__tests__|test|tests|spec|cypress|fixtures)(\/|$)|\.(test|spec)\./i.test(file);
}

function isUsefulCapabilityName(name: string): boolean {
  if (/\b(?:mutation|query|handler|controller|route|page|component|command|function|method|file|event|message|http|api|graphql|click|submit|select|input|change|hover|mouse|keyboard|keypress|keydown|keyup)\s+management\b/i.test(clean(name))) {
    return false;
  }
  const subject = clean(name)
    .toLowerCase()
    .replace(/\b(management|capability|authentication|reporting|commands|handlers|tasks)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!subject) return false;
  const tokens = subject.split(/\s+/);
  return tokens.some(token => !GENERIC_TERMS.has(token) && !/^(toggle|success|failure|misc|root|read|write|use|used|using|home|page|pages)$/.test(token));
}

function isTrustedDescriptionSource(source: string): boolean {
  return source === 'ai' || source === 'manual' || source === 'reused';
}

function isAIReviewedDeterministicDescription(source: string, generation: any): boolean {
  return source === 'deterministic'
    && generation?.attempted === true
    && generation?.status === 'deterministic_kept'
    && (
      generation?.reason === 'deterministic-retained-stronger' ||
      generation?.reason === 'ai-rejected-deterministic-usable' ||
      /^curated-(?:self-)?product-capability-description\b/.test(String(generation?.reason || '')) ||
      /^ai-rejected-deterministic-usable\b/.test(String(generation?.reason || ''))
    );
}

function isBadDescriptionGeneration(generation: any): boolean {
  return generation?.status === 'ai_rejected' || generation?.status === 'ai_failed';
}

function capabilityPriority(capability: any): number {
  let score = 0;
  if (capability?.category === 'core') score += 40;
  else if (capability?.category === 'admin') score += 20;
  else if (capability?.category === 'supporting') score += 10;
  if (capability?.criticality === 'critical') score += 30;
  else if (capability?.criticality === 'high') score += 20;
  else if (capability?.criticality === 'medium') score += 10;
  const links = [
    ...(Array.isArray(capability?.operations) ? capability.operations : []),
    ...(Array.isArray(capability?.related_entities) ? capability.related_entities : []),
    ...(Array.isArray(capability?.related_domains) ? capability.related_domains : []),
  ].length;
  score += Math.min(20, links);
  // Structural-importance mass (signals.centrality_score, 0-100, computed by
  // the deterministic graph layer via flow-scorer) breaks capability ordering
  // toward what the call graph says matters — ordering only, never a cutoff.
  score += Math.round((capability?.signals?.centrality_score || 0) / 2);
  return score;
}

function countInventoryNodes(inventory: Record<string, any>): number {
  return Object.values(inventory).reduce<number>((sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0);
}

function looksLikeInternalMemberAccess(name: string): boolean {
  const value = clean(name);
  if (!value.includes('.')) return false;
  // Real hostnames (auth0.com, api.stripe.com, sentry.io) are external services,
  // not member-access chains — accept them via the shared product lens so the
  // referee and the product agree on what a domain is.
  if (isHostnameLikeServiceName(value)) return false;
  if (/^[a-z]+:\/\//i.test(value) || /[\/@]/.test(value)) return false;
  if (/^[a-z0-9-]+\.[a-z0-9-]+\.[a-z]{2,}$/i.test(value)) return false;
  if (/[()[\]{}]|=>/.test(value)) return true;
  return /^(?:this\.)?[a-z_$][\w$]*(?:\??\.[a-z_$][\w$]*(?:\(\))?)+$/i.test(value);
}

function isRuntimeIntegrationNoise(name: string): boolean {
  return /^(object|array|string|number|boolean|date|math|json|promise|map|set|error|regexp|function|process|global)\./i.test(name);
}

function dedupeTargets(targets: ReviewTarget[]): ReviewTarget[] {
  const seen = new Set<string>();
  const result: ReviewTarget[] = [];
  for (const target of targets) {
    const absolute = path.resolve(target.path);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    result.push({ ...target, path: absolute });
  }
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await runAnalysisUsefulnessReview({
    repos: args.repos,
    includeRealRepos: args.includeRealRepos || args.repos.length === 0,
    devRoot: args.devRoot,
    maxTargets: args.maxTargets,
    concurrency: args.concurrency,
    analysisFocus: args.analysisFocus,
  });
  await fs.ensureDir(path.dirname(args.outputPath));
  await fs.writeJson(args.outputPath, report, { spaces: 2 });
  await fs.ensureDir(path.dirname(args.markdownPath));
  await fs.writeFile(args.markdownPath, formatMarkdown(report), 'utf8');
  console.log(`Analysis usefulness review: ${report.status.toUpperCase()} (${report.score}/100)`);
  console.log(`Reviews: ${report.summary.review_count} | Pass ${report.summary.pass} | Warn ${report.summary.warn} | Fail ${report.summary.fail} | Context tokens ${report.summary.average_agent_context_tokens}`);
  console.log(`Report: ${args.outputPath}`);
  console.log(`Markdown: ${args.markdownPath}`);
  if (report.status === 'fail') process.exitCode = 1;
}

if (isDirectCliInvocation('analysis-usefulness-review')) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
