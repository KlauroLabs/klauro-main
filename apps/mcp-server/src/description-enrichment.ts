import * as fs from 'fs-extra';
import * as path from 'path';
import * as crypto from 'crypto';
import { aiService } from '../../../packages/analyzer-core/src/ai/ai-service';
import { setAICacheProjectScope } from '../../../packages/analyzer-core/src/ai/ai-cache';
import { getAIConfig } from '../../../packages/analyzer-core/src/config/ai.config';
import { validateElementDescription } from '../../../packages/analyzer-core/src/ai/element-description-validator';
import type { CASOutput, CASNode } from '../../../packages/analyzer-core/src/types/cas.types';
import { getProjectStorageDir, loadAnalysis, saveAnalysis } from './storage';

export type DescriptionTargetKind = 'node' | 'service' | 'entity' | 'capability' | 'entry_point' | 'exit_point';

interface StoredDescription {
  key: string;
  target_kind: DescriptionTargetKind;
  target_id: string;
  target_name: string;
  description: string;
  generated_at: string;
  analysis_id: string;
  fingerprint: string;
  source: 'ai';
  invalidated_at?: string;
  invalidation_reason?: string;
}

interface DescriptionStore {
  version: string;
  project_path: string;
  updated_at: string;
  entries: Record<string, StoredDescription>;
}

interface ResolvedTarget {
  kind: DescriptionTargetKind;
  id: string;
  name: string;
  target: any;
  file?: string;
  line?: number;
  fingerprint: string;
  context: Record<string, unknown>;
}

export async function generateElementDescription(input: {
  projectPath: string;
  target: string;
  targetKind?: DescriptionTargetKind;
  instructions?: string;
}): Promise<{
  status: 'success';
  target: Omit<ResolvedTarget, 'target' | 'fingerprint' | 'context'>;
  description: string;
  generated_at: string;
  stored: boolean;
}> {
  if (!hasAIProviderConfigured()) {
    throw new Error('AI descriptions require hosted Klauro AI enrichment: configure DEEPINFRA_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, Azure OpenAI, or a non-local OPENAI_BASE_URL on the hosted analyzer service.');
  }

  const cas = await loadAnalysis(input.projectPath);
  if (!cas) throw new Error(`No analysis found for: ${input.projectPath}. Run analyze_codebase first.`);

  const resolved = await resolveTarget(input.projectPath, cas, input.target, input.targetKind);
  if (!resolved) {
    throw new Error(`Could not find ${input.targetKind || 'analysis element'} matching: ${input.target}`);
  }

  setAICacheProjectScope(input.projectPath);
  const generated = await generateUsefulDescription(cas, resolved, input.instructions);
  const { description } = generated;

  const generatedAt = new Date().toISOString();
  const key = descriptionKey(resolved.kind, resolved.id);
  const store = await loadDescriptionStore(input.projectPath);
  store.entries[key] = {
    key,
    target_kind: resolved.kind,
    target_id: resolved.id,
    target_name: resolved.name,
    description,
    generated_at: generatedAt,
    analysis_id: cas.analysis_id,
    fingerprint: resolved.fingerprint,
    source: 'ai',
  };
  store.updated_at = generatedAt;
  await saveDescriptionStore(input.projectPath, store);

  applyDescriptionToTarget(resolved.target, description, generatedAt, generated.attempts > 1 ? 'manual-trigger-repaired' : 'manual-trigger');
  await saveAnalysis(input.projectPath, cas);

  return {
    status: 'success',
    target: {
      kind: resolved.kind,
      id: resolved.id,
      name: resolved.name,
      file: resolved.file,
      line: resolved.line,
    },
    description,
    generated_at: generatedAt,
    stored: true,
  };
}

async function generateUsefulDescription(
  cas: CASOutput,
  resolved: ResolvedTarget,
  instructions?: string,
): Promise<{ description: string; attempts: number }> {
  let lastDescription = '';
  let lastReason: string | undefined;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const raw = await aiService.generateComponentDescription({
      additionalContext: descriptionPromptContext(cas, resolved, instructions, attempt === 1 ? undefined : {
        rejected_description: lastDescription,
        rejection_reason: lastReason,
      }),
    });
    const description = repairGenericDescriptionPhrasing(cleanDescription(raw), resolved);
    const validation = validateDescription(description, resolved, cas);
    if (validation.ok) return { description, attempts: attempt };
    lastDescription = description;
    lastReason = validation.reason;
  }

  const structurallyRepaired = repairGenericAnalyzerNameRestatement(lastDescription, resolved, cas);
  if (structurallyRepaired) return { description: structurallyRepaired, attempts: 2 };

  const rejectedDescriptionRepair = repairRejectedDescription(lastDescription, lastReason, resolved, cas);
  if (rejectedDescriptionRepair) return { description: rejectedDescriptionRepair, attempts: 3 };

  throw new Error(`AI generated a low-quality or ungrounded description (${lastReason}); no description was stored. Rejected text: "${lastDescription.slice(0, 220)}"`);
}

function repairRejectedDescription(description: string, reason: string | undefined, resolved: ResolvedTarget, cas?: CASOutput): string | undefined {
  if (resolved.kind !== 'capability') return undefined;
  let repaired = cleanDescription(description);
  if (!repaired) return undefined;

  if (reason === 'over-narrow-source-area-claim') {
    repaired = repaired
      .replace(/^[^.]{0,90}?\s+lets\b/i, `${resolved.name} lets`)
      .replace(/\bdownload\s+(?!management\b)[^.]{0,180}?\s+when\b/i, 'download documents and media attachments when')
      .replace(/\b(?:send|route|deliver)\s+[^.]{0,180}?\s+when\b/i, 'handle messages and delivery payloads when')
      .replace(/\b(?:in|for|within|through|via|with|interacting with)\s+(?:the\s+)?[A-Z][A-Za-z0-9 ]{0,80}?\s+(?:channel|connector|integration)\b/gi, 'for configured communication channels')
      .replace(/\bBlue\s?Bubbles\b/gi, 'configured messaging');
  }

  if (reason === 'generic-structural-phrase' || reason === 'implementation-surface-restatement') {
    repaired = repaired
      .replace(/\s+(?:through|via|across)\s+[^.]{0,160}?\b(?:HTTP endpoints?|API endpoints?|handlers?|controllers?|routes?|pages?|components?|connectors?|communication channels)\b/gi, '')
      .replace(/\s+across platforms?\b/gi, '')
      .replace(/\s+by\s+(?:reading|processing|coordinating|handling)\s+/gi, ' by managing ')
      .replace(/\s+and\s+format(?:ting)?\s+[^.]{0,80}?(?= when|\.|$)/gi, '');
  }

  if (reason === 'missing-subject') {
    repaired = repaired.replace(/^[^.]{0,90}?\s+lets\b/i, `${resolved.name} lets`);
  }

  if (reason?.startsWith('unsupported-marketing-language')) {
    repaired = repaired
      .replace(/\bcompliance\b/gi, 'conformance')
      .replace(/\breliable\b/gi, 'validated')
      .replace(/,\s+enabling\s+[^.]{0,180}(?=\.|$)/gi, '')
      .replace(/\s+enabling\s+[^.]{0,180}(?=\.|$)/gi, '');
  }

  repaired = repaired
    .replace(/,\s+providing\s+[^.]{0,180}(?=\.|$)/gi, '')
    .replace(/\s+providing\s+[^.]{0,180}(?=\.|$)/gi, '');

  if (/^Function Call Management\b/i.test(repaired)) {
    const subject = genericCapabilityReplacementSubject(resolved.target, cas);
    if (subject) {
      repaired = cleanDescription(repaired.replace(/^Function Call Management\s+lets\b/i, `${subject} let`));
    }
  }

  repaired = repairGenericDescriptionPhrasing(repaired, resolved)
    .replace(/\bvarious\b/gi, 'supported')
    .replace(/\bstate mutations?\b/gi, 'state changes')
    .replace(/\bwhen for\b/gi, 'for')
    .replace(/\s+/g, ' ')
    .trim();

  return validateDescription(repaired, resolved, cas).ok ? repaired : undefined;
}

function repairGenericAnalyzerNameRestatement(description: string, resolved: ResolvedTarget, cas?: CASOutput): string | undefined {
  if (resolved.kind !== 'capability' || !isGenericAnalyzerCapabilityName(resolved.name)) return undefined;
  const validation = validateDescription(description, resolved, cas);
  if (validation.reason !== 'generic-analyzer-name-restatement') return undefined;

  const subject = genericCapabilityReplacementSubject(resolved.target, cas);
  if (!subject) return undefined;

  const escapedName = escapeRegExp(resolved.name);
  const repaired = cleanDescription(description
    .replace(new RegExp(`^${escapedName}\\s+lets\\b`, 'i'), `${subject} let`)
    .replace(new RegExp(`^${escapedName}\\s+(?:allows|enables)\\b`, 'i'), `${subject} let`)
    .replace(new RegExp(`^${escapedName}\\s+`, 'i'), `${subject} `));

  return validateDescription(repaired, resolved, cas).ok ? repaired : undefined;
}

function genericCapabilityReplacementSubject(target: any, cas?: CASOutput): string | undefined {
  const concepts = capabilityOperationConcepts(target, cas)
    .map(concept => humanizeEvidenceName(concept))
    .filter(concept => concept && !/^(mutation|query|function|handler|controller|page|component|click|submit|select|input|change|hover|mouse|keyboard)$/i.test(concept))
    .slice(0, 4);
  if (concepts.length === 0) return undefined;
  const nouns = concepts.map(concept => concept.toLowerCase().replace(/s$/i, ''));
  return `${formatNaturalList(nouns)} actions`;
}

function formatNaturalList(items: string[]): string {
  const unique = Array.from(new Set(items));
  if (unique.length === 1) return unique[0];
  if (unique.length === 2) return `${unique[0]} and ${unique[1]}`;
  return `${unique.slice(0, -1).join(', ')}, and ${unique[unique.length - 1]}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function descriptionPromptContext(
  cas: CASOutput,
  resolved: ResolvedTarget,
  instructions?: string,
  repair?: { rejected_description: string; rejection_reason?: string },
): Record<string, unknown> {
  return {
    task: repair
      ? 'Rewrite the rejected description for this exact codebase element. Use only facts present in the target and system context. Return one grounded sentence about its product responsibility. If the rejected text guessed from the name, replace it with a fact-grounded description from behavior_hints, operation_concepts, evidence terms, related domains, entities, and source excerpts. If the rejection says implementation-surface-restatement or generic-structural-phrase, remove wording about APIs, pages, routes, components, interfaces, handlers, connectors-as-code, mutation functions, source surfaces, parsing, processing, normalizing, platform spread, or generic cross-platform support and explain the user/operator/agent behavior instead. If the rejection says over-narrow-source-area-claim, describe the broader capability and do not name only one connector or integration.'
      : 'Describe this exact codebase element in one or two useful sentences. Be specific about its product responsibility and role in this codebase. Do not invent behavior outside the provided CAS facts. For capability targets, base the description on operation_concepts, evidence terms, related domains, entities, and source excerpts rather than the title alone.',
    style: 'Return exactly one sentence. No markdown. Start with the subject name only when it is a product concept; if the subject is an orientation entry, file path, route, source artifact, or generic analyzer-derived capability such as Mutation Management, Query Management, Handler Management, Controller Management, Page Management, Component Management, Command Management, Function Management, Click Management, Select Management, Submit Management, Input Management, or Change Management, choose a concrete subject from behavior_hints or operation_concepts instead. Prefer the shape: "<Subject or concept> lets <specific actor> <specific action> <domain objects> when <concrete engineering task or product workflow>." Do not use the phrase "codebase decision". No generic or promotional phrases like "helps engineers or agents", "across different", "before/while", "plays a crucial role", "robust", "various", "efficient", "compliant", "productivity", "business value", "streamline", "functionality", "system components", "executing tasks", or "operations for". Never cite graph statistics, endpoint counts, parent signals, entry-point mechanics, source files, file names, module names, helper functions, handlers, controllers, routes, pages, components, web interfaces, APIs, click events, UI events, implementation surfaces, or analyzer internals; translate them into what the element lets a user, operator, or engineer do. For capability targets with behavior_hints or operation_concepts, synthesize those concepts into product responsibility instead of listing verbs. Do not use the word "coordinate" unless the facts describe product-level coordination between real domain actors. Avoid implementation verbs such as process, generate functions, parse, format, estimate, mutate state, navigate, interact, or call APIs unless they are the product behavior. Do not describe creation, coordination, generation, or organization of files. Do not mention outcomes, compliance, security, scale, cost, or user experience unless the provided facts explicitly say so. If the subject says contract, infer API/schema/data contract only when the facts support it; never describe legal agreements, terms and conditions, or business contracts unless the facts explicitly mention legal/commercial contracts.',
    instructions,
    repair,
    system: {
      name: cas.system?.name,
      description: cas.enhanced_system_purpose?.inferred_description || cas.system?.description,
      domain: cas.enhanced_system_purpose?.primary_domain,
      concepts: cas.enhanced_system_purpose?.core_concepts || [],
    },
    target: resolved.context,
  };
}

export async function getElementDescription(input: {
  projectPath: string;
  target: string;
  targetKind?: DescriptionTargetKind;
}): Promise<{
  status: 'valid' | 'missing' | 'invalidated';
  target?: Omit<ResolvedTarget, 'target' | 'fingerprint' | 'context'>;
  description?: string;
  generated_at?: string;
  invalidated_at?: string;
  invalidation_reason?: string;
}> {
  const cas = await loadAnalysis(input.projectPath);
  if (!cas) throw new Error(`No analysis found for: ${input.projectPath}. Run analyze_codebase first.`);
  const resolved = await resolveTarget(input.projectPath, cas, input.target, input.targetKind);
  if (!resolved) return { status: 'missing' };
  const store = await loadDescriptionStore(input.projectPath);
  const stored = store.entries[descriptionKey(resolved.kind, resolved.id)];
  if (!stored) return { status: 'missing', target: publicTarget(resolved) };
  if (stored.fingerprint !== resolved.fingerprint || stored.invalidated_at) {
    return {
      status: 'invalidated',
      target: publicTarget(resolved),
      description: stored.description,
      generated_at: stored.generated_at,
      invalidated_at: stored.invalidated_at,
      invalidation_reason: stored.invalidation_reason || 'target-fingerprint-changed',
    };
  }
  const validation = validateDescription(stored.description, resolved, cas);
  if (!validation.ok) {
    invalidateStoredDescription(stored, `description-validation-${validation.reason || 'failed'}`);
    store.updated_at = new Date().toISOString();
    await saveDescriptionStore(input.projectPath, store);
    return {
      status: 'invalidated',
      target: publicTarget(resolved),
      description: stored.description,
      generated_at: stored.generated_at,
      invalidated_at: stored.invalidated_at,
      invalidation_reason: stored.invalidation_reason,
    };
  }
  return {
    status: 'valid',
    target: publicTarget(resolved),
    description: stored.description,
    generated_at: stored.generated_at,
  };
}

export async function applyStoredElementDescriptions(projectPath: string, cas: CASOutput): Promise<CASOutput> {
  const store = await loadDescriptionStore(projectPath);
  const keys = Object.keys(store.entries);
  if (keys.length === 0) return cas;

  let changed = false;
  for (const key of keys) {
    const entry = store.entries[key];
    const resolved = await resolveTarget(projectPath, cas, entry.target_id, entry.target_kind);
    if (!resolved || resolved.fingerprint !== entry.fingerprint) {
      if (!entry.invalidated_at) {
        invalidateStoredDescription(entry, !resolved ? 'target-not-found' : 'target-fingerprint-changed');
        changed = true;
      }
      continue;
    }
    const validation = validateDescription(entry.description, resolved, cas);
    if (!validation.ok) {
      invalidateStoredDescription(entry, `description-validation-${validation.reason || 'failed'}`);
      changed = true;
      continue;
    }
    applyDescriptionToTarget(resolved.target, entry.description, entry.generated_at, 'stored-manual-description');
  }

  if (changed) await saveDescriptionStore(projectPath, store);
  return cas;
}

function hasAIProviderConfigured(): boolean {
  const config = getAIConfig();
  return Boolean(config.openai.apiKey || config.anthropic.apiKey);
}

async function resolveTarget(
  projectPath: string,
  cas: CASOutput,
  target: string,
  targetKind?: DescriptionTargetKind,
): Promise<ResolvedTarget | null> {
  const candidateKinds: DescriptionTargetKind[] = targetKind
    ? [targetKind]
    : ['node', 'entity', 'capability', 'entry_point', 'exit_point'];
  for (const kind of candidateKinds) {
    const resolved = await resolveTargetByKind(projectPath, cas, target, kind);
    if (resolved) return resolved;
  }
  return null;
}

async function resolveTargetByKind(projectPath: string, cas: CASOutput, target: string, kind: DescriptionTargetKind): Promise<ResolvedTarget | null> {
  const lower = target.toLowerCase();
  const matches = (value?: string) => value?.toLowerCase() === lower || value?.toLowerCase().includes(lower);
  if (kind === 'node' || kind === 'service') {
    const node = cas.nodes.find(n => (kind !== 'service' || n.type === 'service') && (n.id === target || matches(n.name) || matches(n.qualified_name)));
    return node ? buildNodeTarget(projectPath, cas, node, kind === 'service' ? 'service' : 'node') : null;
  }
  if (kind === 'entity') {
    const entity = (cas.data_entities || []).find(e => e.id === target || matches(e.name));
    return entity ? buildGenericTarget(projectPath, 'entity', entity.id, entity.name, entity, entity.schema_source) : null;
  }
  if (kind === 'capability') {
    const capability = (cas.system_capabilities || []).find(c => c.id === target || matches(c.name));
    return capability ? buildGenericTarget(projectPath, 'capability', capability.id, capability.name, capability, undefined, cas) : null;
  }
  if (kind === 'entry_point') {
    const entryPoint = (cas.entry_points || []).find(ep => ep.id === target || matches(ep.name) || matches(ep.trigger?.path));
    return entryPoint ? buildGenericTarget(projectPath, 'entry_point', entryPoint.id, entryPoint.name, entryPoint, entryPoint.handler?.file) : null;
  }
  const exitPoint = (cas.exit_points || []).find(ep => ep.id === target || matches(ep.name));
  return exitPoint ? buildGenericTarget(projectPath, 'exit_point', exitPoint.id, exitPoint.name, exitPoint, undefined) : null;
}

async function buildNodeTarget(projectPath: string, cas: CASOutput, node: CASNode, kind: DescriptionTargetKind): Promise<ResolvedTarget> {
  const incoming = cas.edges.filter(edge => edge.target === node.id).slice(0, 8);
  const outgoing = cas.edges.filter(edge => edge.source === node.id).slice(0, 8);
  const sourceExcerpt = await readSourceExcerpt(projectPath, node.source?.file, node.source?.line);
  const context = {
    kind,
    id: node.id,
    name: node.name,
    type: node.type,
    qualified_name: node.qualified_name,
    file: node.source?.file,
    line: node.source?.line,
    current_description: node.description,
    source_excerpt: sourceExcerpt,
    incoming: incoming.map(edge => ({ type: edge.type, source: nodeName(cas, edge.source) })),
    outgoing: outgoing.map(edge => ({ type: edge.type, target: nodeName(cas, edge.target) })),
  };
  return {
    kind,
    id: node.id,
    name: node.name,
    target: node,
    file: node.source?.file,
    line: node.source?.line,
    fingerprint: await fingerprintTarget(projectPath, context, node.source?.file),
    context,
  };
}

async function buildGenericTarget(
  projectPath: string,
  kind: DescriptionTargetKind,
  id: string,
  name: string,
  target: any,
  file?: string,
  cas?: CASOutput,
): Promise<ResolvedTarget> {
  const sourceExcerpt = await readSourceExcerpt(projectPath, file, target.source?.line || target.handler?.line);
  const context = {
    kind,
    id,
    name: promptDisplayName(kind, name, file),
    stored_name: name,
    file,
    source_excerpt: sourceExcerpt,
    facts: await promptFacts(projectPath, kind, target, cas),
  };
  return {
    kind,
    id,
    name,
    target,
    file,
    line: target.source?.line || target.handler?.line,
    fingerprint: await fingerprintTarget(projectPath, context, file),
    context,
  };
}

function promptDisplayName(kind: DescriptionTargetKind, name: string, file?: string): string {
  if (kind !== 'entry_point') return name;
  const text = String(name || '');
  const source = file || text;
  if (!/\borientation entry\b/i.test(text) && !/\.(?:tf|tfvars|hcl|yaml|yml|json)\b/i.test(text)) return name;

  const normalized = source.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  const filename = parts[parts.length - 1] || '';
  const parent = parts.length > 1 ? parts[parts.length - 2] : '';
  const grandparent = parts.length > 2 ? parts[parts.length - 3] : '';

  if (/variables\.tf$/i.test(filename) && parent) return `Terraform ${humanizeEvidenceName(parent)} input surface`;
  if (/main\.tf$/i.test(filename) && /environments?/i.test(grandparent)) return `Terraform ${humanizeEvidenceName(parent)} environment`;
  if (/main\.tf$/i.test(filename) && parent) return `Terraform ${humanizeEvidenceName(parent)} module`;
  if (/\.tf$/i.test(filename)) return `Terraform ${humanizeEvidenceName(parent || filename)} infrastructure entry`;
  return humanizeEvidenceName(parent || filename || name);
}

async function promptFacts(projectPath: string, kind: DescriptionTargetKind, target: any, cas?: CASOutput): Promise<Record<string, unknown>> {
  if (kind === 'capability') {
    const operations = (target.operations || [])
      .map((operation: any) => compactCapabilityOperation(operation, cas))
      .filter((operation: string | undefined): operation is string => Boolean(operation))
      .slice(0, 10);
    const evidenceTerms = capabilityEvidenceTerms(target, cas);
    const behaviorHints = capabilityBehaviorHints(target, cas);
    const sourceExcerpts = await capabilitySourceExcerpts(projectPath, target);
    const genericName = isGenericAnalyzerCapabilityName(target.name);
    return {
      category: target.category,
      criticality: target.criticality,
      name_quality: genericName ? 'generic-analyzer-derived-name' : 'domain-name',
      name_guidance: genericName
        ? 'Do not repeat the target name as the subject. Choose a concrete behavior subject from behavior_hints, operation_concepts, or evidence_terms.'
        : undefined,
      operations,
      operation_concepts: capabilityOperationConcepts(target, cas),
      behavior_hints: behaviorHints,
      evidence_terms: evidenceTerms,
      glossary: capabilityGlossary(target),
      related_entities: target.related_entities,
      related_domains: target.related_domains,
      source_excerpts: sourceExcerpts,
      description_guardrails: [
        'Describe the product or agent-facing behavior implied by the evidence.',
        'Do not summarize scripts, helper functions, test helpers, file organization, parser internals, or implementation mechanics.',
        'If evidence includes tests or e2e helpers, ignore them unless the capability itself is testing.',
      ],
    };
  }
  if (kind === 'entity') {
    return {
      fields: (target.fields || []).slice(0, 15).map((field: any) => field.name),
      relationships: (target.relationships || []).slice(0, 10),
      schema_source: target.schema_source,
    };
  }
  return target;
}

function isGenericAnalyzerCapabilityName(name: unknown): boolean {
  return /\b(?:mutation|query|handler|controller|route|page|component|command|function(?:\s+call)?|method|file|event|message|http|api|graphql|click|submit|select|input|change|hover|mouse|keyboard|keypress|keydown|keyup)\s+management\b/i.test(String(name || ''));
}

function compactCapabilityOperation(operation: any, cas?: CASOutput): string | undefined {
  if (operation.entry_point_type === 'internal') return undefined;
  const node = operationNode(operation, cas);
  if (node?.name) {
    return [operation.action, humanizeEvidenceName(node.name), node.type === 'function' ? undefined : node.type]
      .filter(Boolean)
      .join(' ');
  }
  const command = String(operation.path_or_command || '');
  if (/\.(?:ts|tsx|js|jsx|py|php|rb|go|rs|java|cs|dart|swift|kt|sql)$|[/\\]/i.test(command)) {
    return String(operation.action || 'touches code');
  }
  return [operation.action, command].filter(Boolean).join(' ');
}

function capabilityOperationConcepts(target: any, cas?: CASOutput): string[] {
  const concepts = new Set<string>();
  for (const operation of target.operations || []) {
    if (isTestOrHelperOperation(operation) && !capabilityIsTesting(target)) continue;
    const node = operationNode(operation, cas);
    const concept = humanizeEvidenceName(publicOperationConcept(operation, node))
      .replace(/\b(get|set|create|update|delete|read|write|handle|process|run|execute|resolve|normalize|validate|match|build)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!concept || concept.length < 3) continue;
    if (/^(src|app|apps|lib|index|main|scripts?|helpers?|functions?|tests?|e2e test helpers?)$/i.test(concept)) continue;
    concepts.add(concept);
  }
  return [...concepts].slice(0, 12);
}

function capabilityBehaviorHints(target: any, cas?: CASOutput): string[] {
  const hints = new Set<string>();
  const text = [
    target.name,
    ...(target.related_domains || []),
    ...(target.operations || []).map((operation: any) => publicOperationConcept(operation, operationNode(operation, cas))),
  ].join(' ').toLowerCase();

  const addIf = (pattern: RegExp, hint: string) => {
    if (pattern.test(text)) hints.add(hint);
  };

  addIf(/\bskill\b/, 'reusable agent skill discovery, configuration, filtering, validation, and invocation policy');
  addIf(/\bfrontmatter\b|\binvocation\b|\bpolicy\b/, 'skill metadata and invocation policy');
  addIf(/\bfilter\b|\bmatch\b/, 'selection rules for which skills apply to a request');
  addIf(/\btool(?:s)?\b|\btools dir\b/, 'tool-directory discovery for skill execution');
  addIf(/\bconfig\b|\bconfiguration\b/, 'runtime configuration for agent skills');
  addIf(/\bvalidat\b|\bquick validate\b/, 'validation before a skill is trusted');
  addIf(/\bauth\b|\bsession\b|\btenant\b/, 'authentication, session, or tenant boundary preservation');
  addIf(/\bmessage\b|\bchannel\b|\brealtime\b|\bsocket\b/, 'message and realtime communication flow');
  addIf(/\bdocument\b|\breport\b|\bexport\b/, 'document/report workflow');
  addIf(/\bmarket\b|\bprice\b|\btrade\b|\border\b/, 'market, trade, or order workflow');
  addIf(/\buser\b|\baccount\b|\bprofile\b/, 'user/account lifecycle');
  addIf(/\bapproval\b|\bapprovals\b|\breject\b|\bapprove\b/, 'approval decision workflow');
  addIf(/\bconnector\b|\bconnectors\b/, 'external connector setup and status changes');
  addIf(/\bcontent\b|\bpublish\b/, 'content publishing and review flow');
  addIf(/\boperations\b|\bpause\b|\bresume\b/, 'operational status changes such as pause and resume');

  return [...hints].slice(0, 8);
}

function capabilityEvidenceTerms(target: any, cas?: CASOutput): string[] {
  const terms = new Set<string>();
  for (const domain of target.related_domains || []) addEvidenceTerm(terms, domain);
  for (const entityId of target.related_entities || []) {
    const entity = (cas?.data_entities || []).find(candidate => candidate.id === entityId);
    addEvidenceTerm(terms, entity?.name || entityId);
  }
  for (const operation of target.operations || []) {
    if (isTestOrHelperOperation(operation) && !capabilityIsTesting(target)) continue;
    const node = operationNode(operation, cas);
    if (!(operation.entry_point_type === 'internal' && node?.type === 'function')) {
      addEvidenceTerm(terms, node?.name);
      addEvidenceTerm(terms, node?.type);
    }
    addEvidenceTerm(terms, operation.action);
    addEvidenceTerm(terms, compactOwnerArea(operation.path_or_command));
  }
  return [...terms].slice(0, 18);
}

async function capabilitySourceExcerpts(projectPath: string, target: any): Promise<Array<{ file: string; excerpt: string }>> {
  const files = new Set<string>();
  for (const operation of target.operations || []) {
    if (isTestOrHelperOperation(operation) && !capabilityIsTesting(target)) continue;
    const file = operationFile(operation);
    if (!file || !isSourceLikeFile(file)) continue;
    files.add(file);
    if (files.size >= 3) break;
  }

  const excerpts: Array<{ file: string; excerpt: string }> = [];
  for (const file of files) {
    const excerpt = await readSourceExcerpt(projectPath, file);
    if (!excerpt) continue;
    excerpts.push({
      file: publicFileHint(file),
      excerpt: excerpt.slice(0, 1800),
    });
  }
  return excerpts;
}

function capabilityGlossary(target: any): Record<string, string> | undefined {
  const text = `${target.name || ''} ${(target.related_domains || []).join(' ')}`.toLowerCase();
  const glossary: Record<string, string> = {};
  if (/\bcas\b|code analysis specification/.test(text)) {
    glossary.CAS = 'Code Analysis Specification: Klauro analysis output describing codebase structure, relationships, risks, tests, idioms, and behavior.';
  }
  if (/\bcontract\b/.test(text) && /\bcas\b|schema|api|graph/.test(text)) {
    glossary.contract = 'A schema, API, graph, or quality expectation that analysis output must satisfy; not a legal or commercial agreement.';
  }
  if (/\bvalidation\b/.test(text)) {
    glossary.validation = 'Checking output against expected rules before an engineer or agent relies on it.';
  }
  return Object.keys(glossary).length > 0 ? glossary : undefined;
}

function addEvidenceTerm(terms: Set<string>, value: unknown): void {
  const text = humanizeEvidenceName(value);
  if (!text || text.length < 3) return;
  if (/^(src|app|apps|test|tests|lib|index|main|handler|controller|service|module|function|class|file)$/i.test(text)) return;
  terms.add(text);
}

function humanizeEvidenceName(value: unknown): string {
  return String(value || '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_/-]+/g, ' ')
    .trim();
}

function compactOwnerArea(value: unknown): string | undefined {
  const command = String(value || '');
  if (!command) return undefined;
  const parts = command.split(/[\\/]/).filter(Boolean);
  const file = parts[parts.length - 1]?.replace(/\.[a-z0-9]+$/i, '');
  const parent = parts.length > 1 ? parts[parts.length - 2] : undefined;
  return [parent, file].filter(Boolean).join(' ');
}

function publicOperationConcept(operation: any, node?: CASNode): string {
  const nodeConcept = humanizeEvidenceName(node?.name);
  if (nodeConcept && !/^(main|index|handler|controller|service|module|function|class|mutation fn|query fn)$/i.test(nodeConcept)) {
    return nodeConcept;
  }
  const file = operationFile(operation);
  const pathConcept = file ? publicFileHint(file) : '';
  if (pathConcept && !/^(src|app|apps|lib|index|main)$/i.test(pathConcept)) return pathConcept;
  return humanizeEvidenceName(operation.path_or_command);
}

function operationFile(operation: any): string | undefined {
  const command = String(operation?.path_or_command || '');
  const fileMatch = command.match(/(?:^|[\s'"])([\w./\\-]+\.(?:ts|tsx|js|jsx|py|php|rb|go|rs|java|cs|dart|swift|kt|sql|tf|tfvars|hcl|yaml|yml|json))(?:$|[\s'"])/i);
  return fileMatch?.[1] || (isSourceLikeFile(command) ? command : undefined);
}

function isSourceLikeFile(value: string): boolean {
  return /\.(?:ts|tsx|js|jsx|py|php|rb|go|rs|java|cs|dart|swift|kt|sql|tf|tfvars|hcl|yaml|yml|json)$/i.test(value);
}

function publicFileHint(file: string): string {
  const parts = file.replace(/\\/g, '/').split('/').filter(Boolean);
  const surfaceIndex = parts.findIndex(part => /^(pages?|routes?)$/i.test(part));
  if (surfaceIndex >= 0 && parts[surfaceIndex + 1]) {
    return humanizeEvidenceName(parts[surfaceIndex + 1].replace(/\.[a-z0-9]+$/i, ''));
  }
  const useful = parts
    .map(part => part.replace(/\.[a-z0-9]+$/i, ''))
    .filter(part => !/^(src|app|apps|lib|libs|packages|scripts?|bin|index|main|pages?|routes?)$/i.test(part))
    .filter(part => !/^(test|tests|spec|specs|fixtures?|mocks?|__tests__|__mocks__|e2e-test-helpers)$/i.test(part));
  return humanizeEvidenceName(useful.slice(-3).join(' '));
}

function isTestOrHelperOperation(operation: any): boolean {
  const text = String(operation?.path_or_command || '');
  return /(^|[/\\._-])(?:test|tests|spec|specs|fixture|fixtures|mock|mocks|__tests__|__mocks__|e2e(?:[-_.]?test)?[-_.]?helpers?|helpers?)(?:[/\\._-]|$)/i.test(text);
}

function capabilityIsTesting(target: any): boolean {
  return /\b(test|testing|qa|quality assurance|fixture|mock)\b/i.test([
    target?.name,
    ...(target?.related_domains || []),
  ].join(' '));
}

function operationNode(operation: any, cas?: CASOutput): CASNode | undefined {
  if (!cas) return undefined;
  const raw = String(operation.entry_point_id || '');
  const nodeId = raw.startsWith('node:') ? raw.slice('node:'.length) : raw;
  return cas.nodes.find(node => node.id === nodeId);
}

async function readSourceExcerpt(projectPath: string, file?: string, line?: number): Promise<string | undefined> {
  if (!file) return undefined;
  const absolute = path.isAbsolute(file) ? file : path.join(projectPath, file);
  const source = await fs.readFile(absolute, 'utf8').catch(() => undefined);
  if (!source) return undefined;

  const lines = source.split(/\r?\n/);
  if (!line || line < 1) return lines.slice(0, 80).join('\n').slice(0, 6000);

  const start = Math.max(0, line - 20);
  const end = Math.min(lines.length, line + 80);
  return lines.slice(start, end).join('\n').slice(0, 6000);
}

async function fingerprintTarget(projectPath: string, context: Record<string, unknown>, file?: string): Promise<string> {
  let fileStats: Record<string, unknown> | undefined;
  if (file) {
    const absolute = path.isAbsolute(file) ? file : path.join(projectPath, file);
    const stat = await fs.stat(absolute).catch(() => null);
    if (stat?.isFile()) {
      fileStats = {
        file: path.relative(projectPath, absolute),
        size: stat.size,
        mtime_ms: Math.floor(stat.mtimeMs),
      };
    }
  }
  return crypto.createHash('sha256')
    .update(JSON.stringify({ context: stableFingerprintValue(context), fileStats }))
    .digest('hex');
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined && typeof child !== 'function')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)])
  );
}

function stableFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableFingerprintValue);
  if (!value || typeof value !== 'object') return value;
  const volatileKeys = new Set(['description', 'current_description', 'description_source', 'description_generation']);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, child]) => !volatileKeys.has(key) && child !== undefined && typeof child !== 'function')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableFingerprintValue(child)])
  );
}

function nodeName(cas: CASOutput, id: string): string {
  const node = cas.nodes.find(candidate => candidate.id === id);
  return node ? `${node.name} (${node.type})` : id;
}

function cleanDescription(raw: string): string {
  return raw
    .replace(/^```(?:text|markdown)?/i, '')
    .replace(/```$/i, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/`/g, '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
}

function repairGenericDescriptionPhrasing(description: string, resolved: Pick<ResolvedTarget, 'kind' | 'name'>): string {
  if (resolved.kind !== 'capability') return description;
  return cleanDescription(description
    .replace(/\s+across different (?:platforms?|services?|channels?|systems?)\b/gi, '')
    .replace(/\s+across multiple (?:platforms?|services?|channels?|systems?)\b/gi, '')
    .replace(/\s+across the supported product areas(?: and platforms)?\b/gi, ''));
}

export function validateDescription(description: string, target: Pick<ResolvedTarget, 'kind' | 'name' | 'target'>, cas?: CASOutput): { ok: boolean; reason?: string } {
  const relatedDomains = Array.isArray((target.target as any)?.related_domains)
    ? (target.target as any).related_domains.filter((domain: unknown): domain is string => typeof domain === 'string')
    : undefined;
  if (target.kind === 'capability') {
    const overNarrow = overNarrowCapabilitySourceClaim(description, target.target);
    if (overNarrow) return { ok: false, reason: overNarrow };
  }
  const derivedDomains = target.kind === 'capability'
    ? capabilityDerivedGroundingTerms(target.target, cas)
    : [];
  const relatedEntityIds = Array.isArray((target.target as any)?.related_entities)
    ? (target.target as any).related_entities.filter((id: unknown): id is string => typeof id === 'string')
    : [];
  const entityNamesById = new Map((cas?.data_entities || []).map(entity => [entity.id, entity.name]));
  return validateElementDescription(description, {
    name: target.name,
    kind: target.kind,
    relatedDomains: [...(relatedDomains || []), ...derivedDomains],
    relatedEntities: relatedEntityIds.map((id: string) => entityNamesById.get(id) || id),
    // Same grounding sources as the system description validator: domain
    // vocabulary legitimizes marketing-flagged words (e.g. "compliance" in a
    // compliance-domain codebase).
    domainVocabulary: [
      cas?.enhanced_system_purpose?.primary_domain,
      ...(cas?.enhanced_system_purpose?.core_concepts || []),
      cas?.enhanced_system_purpose?.inferred_description,
    ].filter((term): term is string => Boolean(term && term !== 'unknown')),
  }, {
    // Capabilities are reviewed against a 50-char floor by the usefulness
    // review gate; generating shorter text would pass here and fail review.
    minLength: target.kind === 'capability' ? 50 : 35,
    maxLength: 800,
  });
}

function capabilityDerivedGroundingTerms(target: any, cas?: CASOutput): string[] {
  if (!isGenericAnalyzerCapabilityName(target?.name)) return [];
  const terms = new Set<string>();
  for (const operation of target?.operations || []) {
    const concept = publicOperationConcept(operation, operationNode(operation, cas));
    for (const token of humanizeEvidenceName(concept).split(/\s+/)) {
      if (token.length > 2 && !/^(bos|web|src|app|apps|page|pages|mutation|query|function|handler)$/i.test(token)) {
        terms.add(token);
      }
    }
  }
  for (const hint of capabilityBehaviorHints(target, cas)) {
    for (const token of hint.split(/\s+/)) {
      if (token.length > 4 && !/^(changes|workflow|status|external|active|such)$/i.test(token)) {
        terms.add(token);
      }
    }
  }
  return [...terms].slice(0, 12);
}

function overNarrowCapabilitySourceClaim(description: string, target: any): string | undefined {
  const operations = Array.isArray(target?.operations) ? target.operations : [];
  if (operations.length < 4) return undefined;

  const extensionNames = new Set<string>();
  for (const operation of operations) {
    const file = operationFile(operation);
    if (!file) continue;
    const normalized = file.replace(/\\/g, '/').toLowerCase();
    const match = normalized.match(/(?:^|\/)extensions\/([^/]+)/);
    if (match?.[1]) extensionNames.add(match[1].replace(/[^a-z0-9]+/g, ''));
  }
  if (extensionNames.size < 4) return undefined;

  const lowerDescription = description.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const subjectText = [
    target?.name,
    ...(Array.isArray(target?.related_domains) ? target.related_domains : []),
  ].join(' ').toLowerCase().replace(/[^a-z0-9]+/g, ' ');

  for (const extensionName of extensionNames) {
    if (extensionName.length < 4) continue;
    if (subjectText.includes(extensionName)) continue;
    if (lowerDescription.includes(extensionName)) return 'over-narrow-source-area-claim';
  }
  return undefined;
}

function isUsefulDescription(description: string, target: ResolvedTarget, cas?: CASOutput): boolean {
  return validateDescription(description, target, cas).ok;
}

function applyDescriptionToTarget(target: any, description: string, generatedAt: string, reason: string): void {
  target.description = description;
  target.description_source = 'ai';
  target.description_generation = {
    status: 'ai_applied',
    attempted: true,
    reason,
    generated_at: generatedAt,
  };
}

function descriptionKey(kind: DescriptionTargetKind, id: string): string {
  return `${kind}:${id}`;
}

function invalidateStoredDescription(entry: StoredDescription, reason: string): void {
  entry.invalidated_at = new Date().toISOString();
  entry.invalidation_reason = reason;
}

function publicTarget(resolved: ResolvedTarget) {
  return {
    kind: resolved.kind,
    id: resolved.id,
    name: resolved.name,
    file: resolved.file,
    line: resolved.line,
  };
}

async function loadDescriptionStore(projectPath: string): Promise<DescriptionStore> {
  const file = descriptionStorePath(projectPath);
  if (await fs.pathExists(file)) return fs.readJson(file);
  return {
    version: '1.0.0',
    project_path: projectPath,
    updated_at: new Date(0).toISOString(),
    entries: {},
  };
}

async function saveDescriptionStore(projectPath: string, store: DescriptionStore): Promise<void> {
  const file = descriptionStorePath(projectPath);
  await fs.ensureDir(path.dirname(file));
  await fs.writeJson(file, store, { spaces: 2 });
}

function descriptionStorePath(projectPath: string): string {
  return path.join(getProjectStorageDir(projectPath), 'element-descriptions.json');
}
