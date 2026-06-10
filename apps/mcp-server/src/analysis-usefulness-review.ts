#!/usr/bin/env tsx
import * as fs from 'fs-extra';
import * as path from 'path';
import pLimit from 'p-limit';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { dominantUnanalyzedLanguage, getAgentWorkPacket } from './agent-adoption';
import { classifyAnalysisProfile, type AnalysisProfile } from './analysis-profile';
import { discoverRealRepos, type RealRepoTarget } from './repo-discovery';
import { isDirectCliInvocation } from './cli-invocation';

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
    work_packet_profile?: string;
    work_packet_files: number;
    work_packet_tokens: number;
    missing_agent_value: string[];
  };
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

type AnalysisFocus = 'agent-fast' | 'ui-overview' | 'deep-context' | 'full';

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
  const workPacket = await getAgentWorkPacket(cas, projectPath, {
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
    scoreAgentNavigation(workPacket, profile),
    scoreArchitectureAgentContext(workPacket, profile),
    scoreIdiomAndInvariantGuidance(cas, workPacket, profile),
    scoreDuplicationAvoidance(cas, workPacket, profile),
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
      work_packet_profile: (workPacket as any).packet_profile,
      work_packet_files: Array.isArray((workPacket as any).file_read_plan) ? (workPacket as any).file_read_plan.length : 0,
      work_packet_tokens: estimateTokens(JSON.stringify(workPacket)),
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
      work_packet_files: 0,
      work_packet_tokens: 0,
      missing_agent_value: missing,
    },
  };
}

async function reviewTarget(target: ReviewTarget, analysisFocus: AnalysisFocus): Promise<AnalysisUsefulnessReview> {
  const startedAt = Date.now();
  const absolute = path.resolve(target.path);
  const cas = await withAnalysisFocus(analysisFocus, async () => {
    const { getOrchestrator } = await import('./analyzer');
    return getOrchestrator().orchestrateAnalysis(absolute);
  });
  const review = await reviewAnalysisUsefulness(cas, absolute, target.name || path.basename(absolute), analysisFocus);
  return {
    ...review,
    duration_ms: Date.now() - startedAt,
  };
}

async function withAnalysisFocus<T>(focus: AnalysisFocus, fn: () => Promise<T>): Promise<T> {
  const previous = {
    interpretation: process.env.KLAURO_AI_INTERPRETATION,
    interpretationForce: process.env.KLAURO_AI_INTERPRETATION_FORCE,
    deterministicKeep: process.env.KLAURO_AI_INTERPRETATION_ALLOW_DETERMINISTIC_KEEP,
    interpretationBudget: process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS,
    elementBudget: process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BUDGET_MS,
    elementBatchSize: process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BATCH_SIZE,
    elementLimit: process.env.KLAURO_AI_ELEMENT_DESCRIPTION_LIMIT,
    elements: process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS,
    embeddings: process.env.KLAURO_EMBEDDING_ENABLED,
    ollamaAuto: process.env.KLAURO_OLLAMA_AUTO,
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
    ollamaModel: process.env.OLLAMA_MODEL,
  };

  try {
    if (focus === 'agent-fast') {
      process.env.KLAURO_AI_INTERPRETATION = 'false';
      process.env.KLAURO_AI_INTERPRETATION_FORCE = 'false';
      process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS = 'false';
      process.env.KLAURO_EMBEDDING_ENABLED = 'false';
    } else if (focus === 'ui-overview') {
      process.env.KLAURO_AI_INTERPRETATION = 'true';
      process.env.KLAURO_AI_INTERPRETATION_FORCE = 'true';
      process.env.KLAURO_AI_INTERPRETATION_ALLOW_DETERMINISTIC_KEEP = 'false';
      process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS = process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS || '90000';
      process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BUDGET_MS = process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BUDGET_MS || '150000';
      process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BATCH_SIZE = process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BATCH_SIZE || '4';
      process.env.KLAURO_AI_ELEMENT_DESCRIPTION_LIMIT = process.env.KLAURO_AI_ELEMENT_DESCRIPTION_LIMIT || '8';
      process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS = 'true';
      process.env.KLAURO_EMBEDDING_ENABLED = 'false';
      process.env.KLAURO_OLLAMA_AUTO = process.env.KLAURO_OLLAMA_AUTO || 'true';
      process.env.OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
      process.env.OLLAMA_MODEL = process.env.OLLAMA_MODEL || process.env.KLAURO_LOCAL_AI_MODEL || 'qwen3:8b';
    } else if (focus === 'deep-context') {
      process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS = process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS || 'false';
    }

    return await fn();
  } finally {
    restoreEnv('KLAURO_AI_INTERPRETATION', previous.interpretation);
    restoreEnv('KLAURO_AI_INTERPRETATION_FORCE', previous.interpretationForce);
    restoreEnv('KLAURO_AI_INTERPRETATION_ALLOW_DETERMINISTIC_KEEP', previous.deterministicKeep);
    restoreEnv('KLAURO_AI_INTERPRETATION_BUDGET_MS', previous.interpretationBudget);
    restoreEnv('KLAURO_AI_ELEMENT_DESCRIPTION_BUDGET_MS', previous.elementBudget);
    restoreEnv('KLAURO_AI_ELEMENT_DESCRIPTION_BATCH_SIZE', previous.elementBatchSize);
    restoreEnv('KLAURO_AI_ELEMENT_DESCRIPTION_LIMIT', previous.elementLimit);
    restoreEnv('KLAURO_AI_ELEMENT_DESCRIPTIONS', previous.elements);
    restoreEnv('KLAURO_EMBEDDING_ENABLED', previous.embeddings);
    restoreEnv('KLAURO_OLLAMA_AUTO', previous.ollamaAuto);
    restoreEnv('OLLAMA_BASE_URL', previous.ollamaBaseUrl);
    restoreEnv('OLLAMA_MODEL', previous.ollamaModel);
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
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

  if (isTrustedDescriptionSource(systemSource)) score += 15;
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
    const trusted = capabilityAssessments.filter(item => isTrustedDescriptionSource(item.source));
    const badGeneration = capabilityAssessments.filter(item => item.generation && isBadDescriptionGeneration(item.generation));
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
        .filter(item => !isTrustedDescriptionSource(item.source))
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
  }

  score += 10;
  score = Math.min(score, hardCap);
  return gate('description-quality', score, details.length ? details.join('; ') : 'AI-backed system and capability descriptions are useful');
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
  const phases = cas.analysis_phases || [];
  const aiPhase = phases.find((phase: any) => phase.id === 'ai-enrichment' || phase.purpose === 'ai-enrichment');
  const details: string[] = [];
  let score = 0;

  if (clean(cas.enhanced_system_purpose?.inferred_description || cas.system?.description).length >= 40) score += 25;
  else details.push('missing compact deterministic system orientation');
  if (capabilities.length > 0) score += 25;
  else details.push('missing capabilities for fast agent orientation');
  if (aiApplied === 0) score += 25;
  else details.push(`agent-fast applied ${aiApplied} AI descriptions instead of deferring UI narrative work`);
  if (attempted === 0 || aiPhase?.status === 'deferred' || aiPhase?.status === 'skipped') score += 25;
  else details.push('AI enrichment was not clearly deferred for agent-fast focus');

  return gate('description-layering', score, details.length ? details.join('; ') : 'agent-fast defers AI descriptions while preserving compact orientation');
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

function scoreAgentNavigation(workPacket: any, profile: AnalysisProfile): UsefulnessGate {
  const filePlan = Array.isArray(workPacket?.file_read_plan) ? workPacket.file_read_plan : [];
  const nextCalls = Array.isArray(workPacket?.next_mcp_calls) ? workPacket.next_mcp_calls : [];
  const tokenEstimate = estimateTokens(JSON.stringify(workPacket || {}));
  let score = 0;
  const details: string[] = [];
  const sourceNeeded = !['empty', 'infrastructure'].includes(profile.kind);

  if (workPacket?.default_use === true) score += 20; else details.push('work packet is not default-use ready');
  if (!sourceNeeded || filePlan.length > 0) score += 25; else details.push('no concrete file-read plan');
  if (filePlan.length <= 8) score += 15; else details.push(`file-read plan is too broad (${filePlan.length} files)`);
  if (workPacket?.selected_node || profile.kind === 'empty' || profile.kind === 'infrastructure') score += 15; else details.push('no selected target node');
  if (nextCalls.length > 0) score += 10; else details.push('no recommended MCP follow-up calls');
  if (tokenEstimate <= 10000) score += 15; else details.push(`work packet too large (${tokenEstimate} tokens)`);

  return gate('agent-navigation', score, details.length ? details.join('; ') : `${filePlan.length} files, ${tokenEstimate} tokens`);
}

export function scoreArchitectureAgentContext(workPacket: any, profile: AnalysisProfile): UsefulnessGate {
  if (profile.kind === 'empty' || profile.kind === 'infrastructure' || profile.kind === 'test-package') {
    return gate('architecture-agent-context', 100, `${profile.kind} does not require architecture placement guidance`);
  }

  const context = workPacket?.work_context?.architecture_context;
  const details: string[] = [];
  let score = 0;

  if (context && typeof context === 'object') score += 15; else details.push('missing architecture_context in work packet');
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

  const scopeProblems = findArchitectureContextScopeProblems(workPacket);
  if (scopeProblems.length > 0) {
    details.push(...scopeProblems);
    score = Math.min(score, 70);
  }
  if (missingMatrix) score = Math.min(score, 65);
  return gate('architecture-agent-context', score, details.length ? details.join('; ') : `${patterns.length} patterns, ${matrix.length} decision rows`);
}

function findArchitectureContextScopeProblems(workPacket: any): string[] {
  const selectedFile = clean(workPacket?.selected_node?.file || workPacket?.selected_node?.source?.file);
  const planFiles = Array.isArray(workPacket?.file_read_plan)
    ? workPacket.file_read_plan
      .filter((item: any) => !/task hint/i.test(clean(item?.reason)))
      .map((item: any) => clean(item?.file))
      .filter(Boolean)
    : [];
  const anchorFiles = uniqueReviewStrings([selectedFile, ...planFiles].filter(Boolean));
  if (anchorFiles.length === 0) return [];

  const context = workPacket?.work_context?.architecture_context;
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

function scoreIdiomAndInvariantGuidance(cas: CASOutput, workPacket: any, profile: AnalysisProfile): UsefulnessGate {
  const idioms = cas.codebase_idioms || [];
  const invariants = cas.behavioral_invariants || [];
  const packetIdioms = workPacket?.work_context?.idiom_context;
  const packetInvariants = workPacket?.work_context?.behavioral_invariants;
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
  if (packetIdioms || idioms.length === 0) score += 15; else details.push('work packet omits idiom context');
  if (!behaviorRequired || invariants.length > 0) score += 20; else details.push('no behavioral invariants for app/service repo');
  if (!behaviorRequired || packetInvariants || invariants.length === 0) score += 15; else details.push('work packet omits invariant context');

  return gate('idiom-invariant-guidance', score, details.length ? details.join('; ') : `${idioms.length} idioms, ${invariants.length} invariants`);
}

export function scoreDuplicationAvoidance(cas: CASOutput, workPacket: any, profile: AnalysisProfile): UsefulnessGate {
  const capabilities = cas.system_capabilities || [];
  const workflows = cas.workflows || [];
  const concepts = cas.domain_concepts || [];
  const selected = workPacket?.selected_node;
  const contextText = JSON.stringify({
    target: workPacket?.target_resolution,
    selected,
    entry_context: workPacket?.work_context?.entry_context,
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
  if (selected || profile.kind === 'infrastructure') score += 20; else details.push('work packet cannot anchor the requested change to existing code');
  if (/capabilit|workflow|entry|selected|idiom|existing/i.test(contextText)) score += 20; else details.push('work packet does not expose existing behavior context');
  if ((cas.edges || []).length > 0 || (cas.method_calls || []).length > 0 || profile.kind === 'library-package') score += 15; else details.push('relationship graph is too thin for duplicate-work avoidance');

  return gate('duplication-avoidance', score, details.length ? details.join('; ') : 'existing behavior context present');
}

function scoreExternalIntegrationEvidence(cas: CASOutput, profile: AnalysisProfile): UsefulnessGate {
  if (profile.kind === 'empty') return gate('external-integration-evidence', 100, 'empty analysis has no integration surface');
  const services: string[] = ((cas as any).external_services || [])
    .map((service: any) => clean(service?.name || service?.service || service))
    .filter((name: string) => Boolean(name) && !isRuntimeIntegrationNoise(name));
  const weakNames = services.filter(name => looksLikeInternalMemberAccess(name));
  if (services.length === 0) return gate('external-integration-evidence', 100, 'no external integrations claimed');
  if (weakNames.length === 0) return gate('external-integration-evidence', 100, `${services.length} external integration claims look service-like`);
  const score = Math.max(0, 100 - Math.ceil((weakNames.length / services.length) * 100));
  return gate(
    'external-integration-evidence',
    score,
    `external integration names look like internal member access: ${weakNames.slice(0, 5).join(', ')}`
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
    average_work_packet_tokens: Math.round(average(reviews.map(review => review.summary.work_packet_tokens))),
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
    `Average work packet tokens: ${report.summary.average_work_packet_tokens}`,
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
  lines.push('', '## Reviews', '', '| Repo | Status | Score | Profile | Domain | Capabilities | Idioms | Packet Tokens |', '| --- | --- | ---: | --- | --- | ---: | ---: | ---: |');
  for (const review of report.reviews) {
    lines.push(`| ${review.repo} | ${review.status} | ${review.score} | ${review.profile.kind} | ${review.summary.primary_domain || ''} | ${review.summary.capability_count} | ${review.summary.idiom_count} | ${review.summary.work_packet_tokens} |`);
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

function findWeakCapabilityDescriptionReasons(capability: any): string[] {
  const reasons: string[] = [];
  const name = clean(capability?.name);
  const description = clean(capability?.description);
  const lower = description.toLowerCase();

  if (!description || description.length < 50) {
    reasons.push('too short');
    return reasons;
  }
  if (description.length < 85 && /\b(?:covers|handles|manages|supports|coordinates|processes|reads|writes)\b/i.test(description)) {
    reasons.push('short generic capability phrasing');
  }
  if (/\b(?:operations for|functionality|centers on|graph endpoint|graph structure|coordinat(?:e|es|ing) operations|internal files?|supports? tasks|agent-driven operations|operations and insights|structured data and insights|better understanding|insights into|enhanc(?:e|es|ing)|robust|various|efficient|business value|streamline)\b/i.test(description)) {
    reasons.push('generic structural or marketing phrase');
  }
  if (/\b(?:read|process|coordinate|analyze|delete) behavior\b/i.test(description) ||
    /\b(?:read|process|analyze|delete) paths?\b/i.test(description) ||
    /\b(?:reads?|processes?|coordinates?) internal files?\b/i.test(description)) {
    reasons.push('describes parser operations instead of product behavior');
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
  if (description.includes('[object Object]')) {
    reasons.push('contains unserialized object output');
  }

  return Array.from(new Set(reasons));
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
  const haystack = JSON.stringify({
    domain: cas.enhanced_system_purpose?.primary_domain,
    concepts: cas.enhanced_system_purpose?.core_concepts,
    capabilities: (cas.system_capabilities || []).map(capability => capability.name),
    entries: (cas.entry_points || []).map(entry => `${entry.name} ${entry.type}`),
    integrations: ((cas as any).external_services || []).map((service: any) => `${service?.name || ''} ${service?.service || ''} ${service?.type || ''}`),
    frameworks: ((cas as any).frameworks || []).map((framework: any) => `${framework?.name || framework}`),
    dependencies: ((cas as any).dependencies || []).map((dependency: any) => `${dependency?.name || dependency}`),
    nodes: (cas.nodes || []).slice(0, 200).map(node => `${node.name} ${node.type} ${node.source?.file || ''}`),
  }).toLowerCase();
  return haystack.includes(normalized);
}

function isLikelyTestPath(file: string): boolean {
  return /(^|\/)(__tests__|test|tests|spec|cypress|fixtures)(\/|$)|\.(test|spec)\./i.test(file);
}

function isUsefulCapabilityName(name: string): boolean {
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
  return score;
}

function countInventoryNodes(inventory: Record<string, any>): number {
  return Object.values(inventory).reduce<number>((sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0);
}

function looksLikeInternalMemberAccess(name: string): boolean {
  const value = clean(name);
  if (!value.includes('.')) return false;
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
  console.log(`Reviews: ${report.summary.review_count} | Pass ${report.summary.pass} | Warn ${report.summary.warn} | Fail ${report.summary.fail} | Packet tokens ${report.summary.average_work_packet_tokens}`);
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
