import * as fs from 'fs-extra';
import * as path from 'path';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { analyzeProjectIncremental } from './analyzer';
import { buildGreenfieldArchitectureGuidance, type GreenfieldReferenceAnalysis } from './greenfield-guidance';
import { buildSummary } from './query';

export interface GreenfieldBuildPacketOptions {
  workspacePath: string;
  planText: string;
  proposedFiles?: Array<{ path: string; content?: string; status?: string }>;
  references?: GreenfieldReferenceAnalysis[];
  limit?: number;
}

export async function buildGreenfieldBuildPacket(options: GreenfieldBuildPacketOptions) {
  const workspacePath = path.resolve(options.workspacePath);
  const files = await listBuildFiles(workspacePath);
  const hasCodebase = files.length > 0;
  const currentAnalysis = hasCodebase ? (await analyzeProjectIncremental(workspacePath)).output : null;
  const sourceConcepts = hasCodebase ? await extractSourceConcepts(workspacePath, files) : [];
  const currentReference = currentAnalysis ? [{
    path: workspacePath,
    name: currentAnalysis.system?.name || path.basename(workspacePath) || 'current-greenfield-build',
    cas: currentAnalysis,
  }] : [];
  const references = [...currentReference, ...(options.references || [])];
  const guidance = buildGreenfieldArchitectureGuidance({
    planText: options.planText,
    proposedFiles: options.proposedFiles || [],
    references,
    limit: options.limit,
  });
  const currentMemory = currentAnalysis ? buildCurrentMemory(currentAnalysis, workspacePath, files, sourceConcepts, options.planText) : null;
  const risks = normalizeBuildPacketRisks(guidance.risks, hasCodebase, options.proposedFiles || []);
  const status = risks.some(risk => risk.severity === 'error') ? 'needs_revision' : risks.length ? 'warn' : 'ready';

  return {
    product: 'greenfield_build_packet',
    generated_at: new Date().toISOString(),
    workspace_path: workspacePath,
    stage: hasCodebase ? 'continuation_iteration' : 'empty_workspace_first_slice',
    status,
    objective: 'Use Klauro as build memory so agents can grow a new system without rebuilding concepts, losing architecture decisions, or spending tokens rediscovering the project.',
    current_analysis: currentMemory,
    architecture_memory: buildArchitectureMemory(currentMemory, files),
    product_focus: buildProductFocus(options.planText, currentMemory, guidance),
    growth_control_plane: buildGrowthControlPlane(hasCodebase, currentMemory, guidance, options.planText),
    build_strategy: guidance.large_scale_build_strategy,
    capability_memory: guidance.capability_memory,
    existing_overlap: guidance.existing_overlap,
    recommended_architecture: guidance.recommended_architecture,
    duplicate_prevention: buildDuplicatePrevention(options.planText, currentMemory, guidance),
    context_budget: buildContextBudget(currentMemory, guidance),
    next_agent_steps: buildNextAgentSteps(hasCodebase),
    validation_plan: buildValidationPlan(hasCodebase),
    risks,
  };
}

function buildGrowthControlPlane(
  hasCodebase: boolean,
  currentMemory: ReturnType<typeof buildCurrentMemory> | null,
  guidance: ReturnType<typeof buildGreenfieldArchitectureGuidance>,
  planText: string
) {
  const requestedBehaviors = extractProductBehaviors(planText);
  const patternBudget = guidance.large_scale_build_strategy.pattern_budget;
  const knownConcepts = currentMemory?.concepts_to_reuse || guidance.large_scale_build_strategy.core_concepts_to_name_once || [];
  const ownerFiles = selectReadFirstFiles(currentMemory?.existing_files_to_consider || []);
  const nextFiles = guidance.recommended_architecture.file_plan.slice(0, 6).map(file => file.path);
  const capabilityDecisions = guidance.capability_memory.reuse_decisions_required || [];

  return {
    product: 'greenfield_growth_control_plane',
    purpose: 'Keep architecture, concept ownership, and duplicate-work checks outside the agent context loop so the agent can spend more effort on product behavior.',
    mode: hasCodebase ? 'cas_backed_growth' : 'first_slice_bootstrap',
    product_slice: {
      requested_behaviors: requestedBehaviors,
      focus_rule: hasCodebase
        ? 'Implement one coherent product behavior by extending the owner files Klauro names; do not re-survey the whole project.'
        : 'Implement one tested vertical slice; do not create a broad platform skeleton before behavior exists.',
      done_when: hasCodebase
        ? [
          'The requested behavior is represented in source.',
          'Existing named concepts are reused or intentionally forked with a reason.',
          'Focused tests or test scaffolds cover the highest-risk changed boundary.',
          'A fresh Klauro analysis can describe the new slice without duplicate concept drift.',
        ]
        : [
          'The first externally visible behavior has source, tests or test scaffolds, and a stable domain owner.',
          'Core domain concepts are named once and imported across boundaries.',
          'preview_greenfield_codebase can produce a meaningful CAS graph for the proposed files.',
        ],
    },
    architecture_budget: {
      patterns_to_use_now: patternBudget.recommended_patterns.slice(0, 5),
      defer_until_needed: [
        'secondary transport adapters',
        'generic plugin systems',
        'cross-cutting abstractions with no first-slice behavior',
        'additional pattern families not required by the current product slice',
      ],
      balance_rule: patternBudget.rule,
    },
    concept_ownership_contract: {
      known_concepts: knownConcepts.slice(0, 20),
      owner_files: ownerFiles.slice(0, 6).map(item => ({
        file: item.file,
        reason: item.reason,
      })),
      next_files: nextFiles,
      fork_requires: [
        'a different lifecycle',
        'a different external contract',
        'a named bounded context split',
        'a focused test proving the separation',
      ],
    },
    duplication_gate: {
      required_before_new_model_or_service: [
        'Check known_concepts and capability_memory.reuse_decisions_required.',
        'If a concept or capability already exists, extend its owner file or explain the intentional fork.',
        'Do not create feature-local stand-ins for tenant, auth, user, organization, request, policy, report, digest, evidence, or audit concepts.',
      ],
      external_reuse_decisions: capabilityDecisions.slice(0, 8).map(decision => ({
        proposed_need: decision.proposed_need,
        existing_capability: decision.existing_capability,
        repository: decision.repository,
        decision_required: decision.decision_required,
      })),
    },
    context_budget: {
      max_first_reads: hasCodebase ? 5 : 0,
      read_rule: hasCodebase
        ? 'Read only owner_files first. Expand only when an owner file explicitly points to another boundary needed by the product slice.'
        : 'No source exists yet; read the packet, write the first slice, then ask Klauro to analyze it.',
      stop_rule: 'Stop after one coherent slice, focused validation, and a result summary. Do not add exploratory docs, alternate architectures, or unrelated scaffolding.',
    },
    next_klauro_loop: hasCodebase
      ? [
        'Run the narrow validation plan for the touched slice.',
        'Run incremental analysis after edits.',
        'Request a new greenfield build packet before the next product slice.',
      ]
      : [
        'Create the first file bundle.',
        'Run preview_greenfield_codebase on the bundle.',
        'Write the files, run focused validation, then request a continuation build packet.',
      ],
  };
}

function normalizeBuildPacketRisks(
  risks: Array<{ severity: string; risk: string; recommendation: string }>,
  hasCodebase: boolean,
  proposedFiles: Array<{ path: string; content?: string; status?: string }>
) {
  if (proposedFiles.length > 0) return risks;
  return risks.filter(risk => risk.risk !== 'No file bundle');
}

async function listBuildFiles(workspacePath: string): Promise<string[]> {
  if (!(await fs.pathExists(workspacePath))) return [];
  const files: string[] = [];
  await walk(workspacePath, workspacePath, files);
  return files.sort();
}

async function walk(root: string, current: string, out: string[]) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute);
    if (shouldSkip(relative, entry.name)) continue;
    if (entry.isDirectory()) {
      await walk(root, absolute, out);
    } else if (isBuildMemoryFile(relative)) {
      out.push(relative);
    }
  }
}

function shouldSkip(relative: string, name: string): boolean {
  return name === '.git' ||
    name === '.claude' ||
    name === 'node_modules' ||
    name === 'dist' ||
    name === 'build' ||
    name === 'coverage' ||
    name === '.next' ||
    name === '.turbo' ||
    name === '.klauro' ||
    name.startsWith('.klauro-') ||
    name.startsWith('.unravl-') ||
    relative.startsWith('.agents/reviews/') ||
    relative.includes('/node_modules/') ||
    relative.includes('/dist/') ||
    relative.includes('/build/');
}

function isBuildMemoryFile(file: string): boolean {
  return /\.(ts|tsx|js|jsx|py|go|rs|java|cs|php|dart|sql|prisma|json|ya?ml|md)$/.test(file);
}

async function extractSourceConcepts(workspacePath: string, files: string[]): Promise<string[]> {
  const concepts: string[] = [];
  for (const file of files.filter(file => /\.(ts|tsx|js|jsx|py|go|rs|java|cs|php|dart)$/.test(file)).slice(0, 80)) {
    const absolute = path.join(workspacePath, file);
    const content = await fs.readFile(absolute, 'utf8').catch(() => '');
    for (const match of content.matchAll(/\b(?:class|interface|type|enum)\s+([A-Z][A-Za-z0-9_]*)/g)) {
      concepts.push(match[1]);
    }
    for (const match of content.matchAll(/\b(?:function|const)\s+([a-z][A-Za-z0-9_]*)/g)) {
      const name = match[1];
      if (/(Service|Repository|Controller|Adapter|Client|Store|Hook|Api)$/i.test(name) || name.length > 10) {
        concepts.push(name);
      }
    }
    for (const match of content.matchAll(/\bexport\s+class\s+([A-Z][A-Za-z0-9_]*)/g)) {
      concepts.push(match[1]);
    }
  }
  return unique(concepts).slice(0, 80);
}

function buildCurrentMemory(cas: CASOutput, workspacePath: string, files: string[], sourceConcepts: string[], planText: string) {
  const summary = buildSummary(cas);
  const capabilities = (cas.system_capabilities || []).slice(0, 18).map(capability => ({
    name: capability.name,
    description: capability.description,
    domains: capability.related_domains || [],
    entities: capability.related_entities || [],
  }));
  const entities = unique([
    ...sourceConcepts,
    ...(cas.data_entities || []).map(entity => entity.name),
    ...(cas.database_schema?.entities || []).map(entity => entity.name),
    ...(cas.domain_concepts || []).map(concept => concept.name),
  ]).slice(0, 40);
  const patterns = (cas.architecture_summary?.architectural_patterns || []).slice(0, 12).map(pattern => ({
    name: pattern.name,
    confidence: pattern.confidence,
    evidence: pattern.evidence?.slice(0, 4) || [],
  }));

  return {
    path: workspacePath,
    system_name: cas.system?.name || path.basename(workspacePath),
    primary_domain: summary.primary_domain || cas.enhanced_system_purpose?.primary_domain || 'unknown',
    description: summary.description || cas.enhanced_system_purpose?.inferred_description || cas.system?.description || '',
    graph: {
      nodes: cas.nodes?.length || 0,
      edges: cas.edges?.length || 0,
      entry_points: cas.entry_points?.length || 0,
      tests: cas.test_summary?.total_tests || cas.test_suites?.reduce((sum, suite) => sum + (suite.tests?.length || 0), 0) || 0,
      capabilities: capabilities.length,
      files: files.length,
    },
    concepts_to_reuse: entities,
    capabilities_to_extend: capabilities,
    architecture_patterns_to_preserve: patterns,
    existing_files_to_consider: selectContextFiles(files, planText),
  };
}

function buildArchitectureMemory(currentMemory: ReturnType<typeof buildCurrentMemory> | null, files: string[]) {
  if (!currentMemory) {
    return {
      stage: 'no_code_yet',
      decision_ledger: [
        {
          decision: 'Name core domain concepts once in the first vertical slice.',
          evidence: 'The workspace is empty, so there is no existing ownership map yet.',
          agent_guidance: 'Create the initial domain/model boundary before creating feature-local duplicates.',
        },
        {
          decision: 'Separate entry/view, behavior, persistence/state, and tests when the product requires durable growth.',
          evidence: 'Large greenfield builds need a stable shape before later slices can reuse it.',
          agent_guidance: 'After the first slice exists, ask for another build packet and treat it as the source of truth for continuation work.',
        },
      ],
      model_ownership: [],
      boundary_ownership: [],
      test_memory: [],
      continuation_rules: [
        'After the first slice, do not add a second model with the same business meaning under a feature folder.',
        'Prefer extending the owner file for a concept unless the packet names a reason to split it.',
        'If a new bounded context is intentional, name the boundary and add a test that proves the separation.',
      ],
    };
  }

  const ownerFiles = currentMemory.existing_files_to_consider || [];
  const modelFiles = ownerFiles.filter(item => /domain|models?|entities?|schemas?|types/i.test(item.file));
  const behaviorFiles = ownerFiles.filter(item => isBehaviorBoundary(item.file));
  const entryFiles = ownerFiles.filter(item => isEntryBoundary(item.file));
  const testFiles = ownerFiles.filter(item => /(test|spec)\./i.test(item.file));
  const migrationFiles = files.filter(file => /migration|prisma|schema\.sql/i.test(file));

  return {
    stage: 'cas_backed_continuation',
    decision_ledger: [
      {
        decision: `Preserve the existing primary domain: ${currentMemory.primary_domain}.`,
        evidence: currentMemory.description || `${currentMemory.graph.nodes} nodes and ${currentMemory.graph.edges} edges in the current CAS graph.`,
        agent_guidance: 'Treat new work as an iteration on this system unless the user explicitly asks for a separate product or bounded context.',
      },
      ...currentMemory.architecture_patterns_to_preserve.slice(0, 6).map(pattern => ({
        decision: `Preserve detected architecture pattern: ${pattern.name}.`,
        evidence: (pattern.evidence || []).join('; ') || `confidence ${pattern.confidence}`,
        agent_guidance: 'Use the same boundary shape for the next slice before introducing a new abstraction.',
      })),
    ],
    model_ownership: currentMemory.concepts_to_reuse.slice(0, 16).map(concept => ({
      concept,
      likely_owner_files: modelFiles.slice(0, 2).map(item => item.file),
      agent_guidance: 'Extend owner before adding a parallel concept.',
    })),
    boundary_ownership: [
      ...entryFiles.slice(0, 6).map(item => ({
        boundary: item.file,
        role: item.reason,
        agent_guidance: 'Extend for adjacent user-facing behavior.',
      })),
      ...behaviorFiles.slice(0, 8).map(item => ({
        boundary: item.file,
        role: item.reason,
        agent_guidance: 'Add behavior here or beside this boundary.',
      })),
      ...migrationFiles.slice(0, 6).map(file => ({
        boundary: file,
        role: 'Persistence migration/history.',
        agent_guidance: 'Follow this persistence change style.',
      })),
    ],
    test_memory: testFiles.slice(0, 8).map(item => ({
      file: item.file,
      agent_guidance: 'Mirror this style for regression coverage.',
    })),
    continuation_rules: [
      'Start by reading model_ownership and boundary_ownership, then inspect only the listed owner files before editing.',
      'When the plan names an existing concept, extend the owner boundary instead of adding a feature-local duplicate.',
      'When the plan introduces a new concept, add it beside the closest owner boundary and connect it to the existing graph through tests.',
      'Run a fresh greenfield build packet after each slice so the next iteration inherits the updated graph memory.',
    ],
  };
}

function buildDuplicatePrevention(planText: string, currentMemory: ReturnType<typeof buildCurrentMemory> | null, guidance: ReturnType<typeof buildGreenfieldArchitectureGuidance>) {
  const plan = normalize(planText);
  const existingConcepts = currentMemory?.concepts_to_reuse || [];
  const likelyReusedConcepts = existingConcepts.filter(concept => {
    const normalized = normalize(concept);
    return normalized.length > 2 && (plan.includes(normalized) || normalized.split(/\s+/).some(part => part.length > 3 && plan.includes(part)));
  }).slice(0, 16);

  return {
    known_concepts_already_defined: existingConcepts.slice(0, 24),
    likely_reused_concepts_for_this_slice: likelyReusedConcepts,
    do_not_rebuild: guidance.capability_memory.do_not_rebuild,
    rules: [
      'Check known concepts before adding a model/entity/service/hook/component.',
      'Extend the existing owner boundary for reused concepts.',
      'If a split is intentional, name the divergence and test it.',
      'After the slice, run another greenfield build packet so the next iteration starts from the updated CAS memory.',
    ],
  };
}

function buildProductFocus(
  planText: string,
  currentMemory: ReturnType<typeof buildCurrentMemory> | null,
  guidance: ReturnType<typeof buildGreenfieldArchitectureGuidance>
) {
  const requestedBehaviors = extractProductBehaviors(planText);
  const existingCapabilities = currentMemory?.capabilities_to_extend || [];
  const matchingCapabilities = existingCapabilities
    .filter(capability => {
      const haystack = normalize([capability.name, capability.description, ...capability.entities, ...capability.domains].join(' '));
      return requestedBehaviors.some(behavior => haystack.includes(normalize(behavior)) || normalize(behavior).split(' ').some(part => part.length > 4 && haystack.includes(part)));
    })
    .slice(0, 8);
  const behaviorExtensionTargets = currentMemory
    ? buildBehaviorExtensionTargets(requestedBehaviors, currentMemory, matchingCapabilities)
    : [];

  return {
    objective: currentMemory
      ? 'Let Klauro carry the architecture map so the agent can spend its context budget on the next product behavior.'
      : 'Start from product behavior, not empty-folder exploration; Klauro provides the first architecture rails.',
    requested_product_behaviors: requestedBehaviors,
    product_questions_to_answer_in_code: requestedBehaviors.length
      ? requestedBehaviors.map(behavior => `What is the smallest tested slice of ${behavior} that should exist after this iteration?`)
      : ['What is the smallest tested product behavior that should exist after this iteration?'],
    existing_behavior_to_extend: behaviorExtensionTargets.map(capability => ({
      capability: capability.name,
      description: capability.description,
      entities: capability.entities,
      domains: capability.domains,
      owner_files: capability.owner_files,
      match_reason: capability.match_reason,
      agent_guidance: capability.agent_guidance,
    })),
    architecture_decisions_klauro_is_carrying: currentMemory
      ? [
        `${currentMemory.graph.nodes} nodes, ${currentMemory.graph.edges} edges, ${currentMemory.graph.capabilities} capabilities, and ${currentMemory.graph.tests} tests are already mapped.`,
        ...currentMemory.architecture_patterns_to_preserve.slice(0, 5).map(pattern => `${pattern.name} pattern (${pattern.confidence} confidence)`),
      ]
      : guidance.recommended_architecture.patterns.slice(0, 5).map(pattern => `${pattern.name}: ${pattern.guidance}`),
    agent_should_not_spend_time_on: currentMemory
      ? [
        'Re-discovering the whole folder before reading context_budget.read_first.',
        'Creating a new architecture shape for concepts already listed in duplicate_prevention.',
        'Opening broad unrelated files before product behavior requires them.',
      ]
      : [
        'Listing or reading an empty folder.',
        'Inventing several architecture alternatives before creating the first vertical slice.',
        'Building multiple product areas before one tested slice exists.',
      ],
    next_product_slice_definition: currentMemory
      ? 'Implement one user-visible or agent-visible behavior by extending the listed owner files, then run tests and request a fresh packet.'
      : 'Create one tested vertical slice that names the core concepts once, then analyze it so the next slice starts with CAS memory.',
  };
}

function buildBehaviorExtensionTargets(
  requestedBehaviors: string[],
  currentMemory: ReturnType<typeof buildCurrentMemory>,
  matchingCapabilities: Array<{ name: string; description?: string; entities: string[]; domains: string[] }>
) {
  const ownerFiles = selectReadFirstFiles(currentMemory.existing_files_to_consider || []);
  const behaviorFiles = ownerFiles.filter(item => isBehaviorBoundary(item.file));
  const domainFiles = ownerFiles.filter(item => isDomainOwnerFile(item.file));
  const entryFiles = ownerFiles.filter(item => isEntryBoundary(item.file));
  const fallbackFiles = uniqueByFile([...behaviorFiles, ...domainFiles, ...entryFiles, ...ownerFiles]).slice(0, 4);
  const targets = matchingCapabilities.map(capability => ({
    name: capability.name,
    description: capability.description || 'Existing analyzed capability that overlaps the requested slice.',
    entities: capability.entities || [],
    domains: capability.domains || [currentMemory.primary_domain].filter(Boolean),
    owner_files: fallbackFiles.map(item => item.file),
    match_reason: 'matched existing CAS capability',
    agent_guidance: 'Extend this capability and its owner files before creating a new service, model, or module.',
  }));
  const seen = new Set(targets.map(target => normalize(target.name)));

  for (const behavior of requestedBehaviors) {
    if (targets.length >= 8) break;
    const relatedConcepts = closestConceptsForBehavior(behavior, currentMemory.concepts_to_reuse || []);
    const relatedCapabilities = closestCapabilitiesForBehavior(behavior, currentMemory.capabilities_to_extend || []);
    const name = relatedCapabilities[0]?.name || `Extend ${shortBehaviorName(behavior)}`;
    const key = normalize(`${name}:${relatedConcepts.join(',') || behavior}`);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({
      name,
      description: relatedCapabilities[0]?.description || `Closest existing owner for requested behavior: ${behavior}.`,
      entities: relatedConcepts,
      domains: unique([...(relatedCapabilities[0]?.domains || []), currentMemory.primary_domain].filter(Boolean)).slice(0, 4),
      owner_files: fallbackFiles.map(item => item.file),
      match_reason: relatedConcepts.length
        ? `matched existing concepts: ${relatedConcepts.join(', ')}`
        : 'no exact capability match; using closest behavior/domain owner files from the current CAS memory',
      agent_guidance: 'Add the new behavior beside these owner files, reuse the listed concepts, and add focused tests before introducing a parallel boundary.',
    });
  }

  if (targets.length === 0 && currentMemory) {
    targets.push({
      name: `Extend ${currentMemory.system_name}`,
      description: 'No exact capability match was found; continue from the highest-signal owner files in the current CAS memory.',
      entities: currentMemory.concepts_to_reuse.slice(0, 6),
      domains: [currentMemory.primary_domain].filter(Boolean),
      owner_files: fallbackFiles.map(item => item.file),
      match_reason: 'fallback to current architecture owner files',
      agent_guidance: 'Read these owner files first and extend the existing graph shape before creating a new boundary.',
    });
  }

  return targets.slice(0, 8);
}

function closestConceptsForBehavior(behavior: string, concepts: string[]): string[] {
  const behaviorTokens = tokenSet(normalize(behavior));
  return concepts
    .map(concept => {
      const conceptTokens = tokenSet(normalize(splitIdentifier(concept)));
      const overlap = [...behaviorTokens].filter(token => conceptTokens.has(token) || [...conceptTokens].some(part => part.includes(token) || token.includes(part)));
      return { concept, score: overlap.length };
    })
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || left.concept.localeCompare(right.concept))
    .slice(0, 5)
    .map(item => item.concept);
}

function closestCapabilitiesForBehavior(
  behavior: string,
  capabilities: Array<{ name: string; description?: string; entities: string[]; domains: string[] }>
) {
  const behaviorTokens = tokenSet(normalize(behavior));
  return capabilities
    .map(capability => {
      const haystack = normalize([
        capability.name,
        capability.description || '',
        ...(capability.entities || []).map(splitIdentifier),
        ...(capability.domains || []),
      ].join(' '));
      const capabilityTokens = tokenSet(haystack);
      const overlap = [...behaviorTokens].filter(token => capabilityTokens.has(token));
      return { capability, score: overlap.length };
    })
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || left.capability.name.localeCompare(right.capability.name))
    .slice(0, 3)
    .map(item => item.capability);
}

function shortBehaviorName(behavior: string): string {
  return behavior
    .split(/\s+/)
    .filter(part => part.length > 2)
    .slice(0, 5)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Next Product Slice';
}

function splitIdentifier(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ');
}

function tokenSet(value: string): Set<string> {
  return new Set(value.split(/\s+/).filter(token => token.length > 2));
}

function extractProductBehaviors(planText: string): string[] {
  const normalized = planText.replace(/\s+/g, ' ').trim();
  const phrases: string[] = [];
  const clauses = normalized
    .split(/[.;]|\n/)
    .map(clause => clause.trim())
    .filter(Boolean)
    .filter(clause => !/\b(do not|don't|dont|avoid|reuse|without|instead of|parallel)\b/i.test(clause));
  const actionPattern = /\b(?:support|supports|add|adds|adding|build|builds|building|create|creates|enable|enables|provide|provides|track|tracks|manage|manages|generate|generates|schedule|schedules|compare|compares|review|reviews|approve|approves|route|routes|notify|notifies|export|exports|import|imports|sync|syncs|analyze|analyzes|preview|previews|need|needs)\s+([^.;\n]{4,140})/gi;
  for (const clause of clauses) {
    let match: RegExpExecArray | null;
    while ((match = actionPattern.exec(clause)) && phrases.length < 10) {
      const phrase = match[1]
        .replace(/\b(and|with|for|through|using|that|the|a|an)\s*$/i, '')
        .trim();
      addProductPhrase(phrases, phrase);
    }
  }
  if (phrases.length > 0) return phrases.slice(0, 8);

  return clauses
    .join('. ')
    .split(/[,.;]|\band\b/i)
    .map(part => cleanProductPhrase(part))
    .filter(part => part.length >= 8 && part.length <= 90)
    .slice(0, 8);
}

function addProductPhrase(phrases: string[], phrase: string) {
  const cleaned = cleanProductPhrase(phrase);
  if (!cleaned || cleaned.length < 4) return;
  if (/^(one|the|a|an|same|existing)$/i.test(cleaned)) return;
  if (!phrases.some(existing => normalize(existing) === normalize(cleaned))) {
    phrases.push(cleaned);
  }
}

function cleanProductPhrase(phrase: string): string {
  return phrase
    .replace(/^\s*(by|with|for|to)\s+/i, '')
    .replace(/^\s*continue\s+with\s+(?:a\s+)?(?:second|third|fourth|fifth|next)\s+product\s+slice\s+for\s+/i, '')
    .replace(/^\s*continue\s+with\s+/i, '')
    .replace(/\b(instead|rather than|without|do not|don't|dont|reuse)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildContextBudget(currentMemory: ReturnType<typeof buildCurrentMemory> | null, guidance: ReturnType<typeof buildGreenfieldArchitectureGuidance>) {
  const currentFiles = currentMemory?.existing_files_to_consider || [];
  const proposedFiles = guidance.recommended_architecture.file_plan.slice(0, 10).map(file => ({
    file: file.path,
    reason: file.role,
  }));
  const readFirst = selectReadFirstFiles(currentFiles);
  return {
    read_first: readFirst,
    create_or_update_next: proposedFiles,
    token_rule: currentMemory
      ? 'Read the compact owner files first, use test_memory for test targeting, and query Klauro before broad exploration.'
      : 'Do not spend tokens exploring the empty folder; start from this packet, create the first vertical slice, then preview/analyze it.',
  };
}

function selectReadFirstFiles(files: Array<{ file: string; reason: string }>) {
  const domain = files.filter(item => isDomainOwnerFile(item.file));
  const planRelevant = files
    .filter(item => Number((item as any).score || 0) >= 45 && !isProjectManifest(item.file));
  if (planRelevant.length > 0) {
    const productionRelevantSource = planRelevant.filter(item => isSourceLikePath(item.file) && !isTestFile(item.file));
    const testRelevantSource = planRelevant.filter(item => isSourceLikePath(item.file) && isTestFile(item.file));
    const relevantSource = (productionRelevantSource.length ? productionRelevantSource : testRelevantSource).slice(0, 4);
    const relevantDocs = planRelevant.filter(item => isDocPath(item.file)).slice(0, 1);
    const relevantRoots = new Set(relevantSource.map(item => ownerRoot(item.file)));
    const relatedDomain = domain.filter(item => relevantRoots.has(ownerRoot(item.file))).slice(0, 1);
    const selected = relevantSource.length
      ? [...relevantSource, ...relatedDomain, ...relevantDocs]
      : planRelevant;
    return uniqueByFile(selected).slice(0, 5);
  }
  const behavior = files.filter(item => isBehaviorBoundary(item.file));
  const entry = files.filter(item => isEntryBoundary(item.file));
  const persistence = files.filter(item => /migration|prisma|schema\.sql/i.test(item.file));
  const selected = uniqueByFile([
    ...domain.slice(0, 2),
    ...behavior.slice(0, 2),
    ...entry.slice(0, 1),
    ...persistence.slice(0, 1),
  ]);
  if (selected.length > 0) return selected.slice(0, 4);
  return files.filter(item => !isProjectManifest(item.file) && !/(test|spec)\./i.test(item.file)).slice(0, 3);
}

function buildNextAgentSteps(hasCodebase: boolean): string[] {
  if (!hasCodebase) {
    return [
      'Create the smallest vertical slice that names the core domain concepts once.',
      'Keep route/view, service, data/model, and test boundaries separate when the product requires them.',
      'Run preview_greenfield_codebase on the proposed file bundle before treating the plan as final.',
      'Analyze the folder after writing files, then request another greenfield build packet for the next slice.',
    ];
  }
  return [
    'Extend existing concepts listed in current_analysis.concepts_to_reuse instead of recreating them.',
    'Read only context_budget.read_first before editing unless those files point elsewhere.',
    'Run preview_codebase_iteration or compare_analysis_iterations for multi-file changes.',
    'After editing, run validation_plan and request a fresh packet before the following slice.',
  ];
}

function buildValidationPlan(hasCodebase: boolean) {
  return {
    required_checks: hasCodebase
      ? ['project tests for touched slice', 'Klauro incremental analysis', 'duplicate concept scan', 'idiom validation when available']
      : ['preview_greenfield_codebase before implementation is considered stable', 'initial tests or test scaffold for highest-risk behavior'],
    klauro_checks: hasCodebase
      ? ['analyze_codebase with incremental state', 'get_codebase_idioms', 'validate_codebase_idioms', 'compare_analysis_iterations for large changes']
      : ['preview_greenfield_codebase', 'get_greenfield_build_packet after files exist'],
  };
}

function selectContextFiles(files: string[], planText = '') {
  const planTerms = planTokenSet(planText);
  const scored = files.map(file => ({
    file,
    score: contextFileScore(file, planTerms),
    reason: contextFileReason(file),
  })).filter(item => item.score > 0 && !isLowSignalBuildMemoryPath(item.file))
    .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file));
  const source = scored.filter(item => isSourceLikePath(item.file));
  const docs = scored.filter(item => isDocPath(item.file));
  const manifests = scored.filter(item => isProjectManifest(item.file));
  const selected = uniqueByFile([
    ...source.filter(item => !isTestFile(item.file)).slice(0, 10),
    ...source.filter(item => isTestFile(item.file)).slice(0, 3),
    ...docs.slice(0, 4),
    ...manifests.slice(0, 2),
  ]).sort((left: any, right: any) => Number(right.score || 0) - Number(left.score || 0) || left.file.localeCompare(right.file));
  return selected.slice(0, 16).map(({ file, reason, score }: any) => ({ file, reason, score }));
}

function contextFileScore(file: string, planTerms: Set<string> = new Set()): number {
  let score = 0;
  if (isLowSignalBuildMemoryPath(file)) return 0;
  const pathTerms = planTokenSet(file);
  const overlap = [...planTerms].filter(term => pathTerms.has(term) || [...pathTerms].some(pathTerm => pathTerm.includes(term) || term.includes(pathTerm)));
  if (overlap.length > 0) score += Math.min(75, 35 + overlap.length * 12);
  const highSignalOverlap = GREENFIELD_BUILD_MEMORY_HIGH_SIGNAL_TERMS.filter(term => planTerms.has(term) && pathTerms.has(term));
  if (highSignalOverlap.length > 0) score += Math.min(60, highSignalOverlap.length * 25);
  if (/^docs\//i.test(file) && ['doc', 'docs', 'proof', 'evidence', 'audit', 'report'].some(term => planTerms.has(term))) score += 35;
  if (isProjectManifest(file)) score += 40;
  if (/src\/(main|index|app|server|routes?|pages?|views?)\./i.test(file)) score += 35;
  if (isDomainOwnerFile(file)) score += 30;
  if (isBehaviorBoundary(file)) score += 25;
  if (isEntryBoundary(file)) score += 20;
  if (/(test|spec)\./i.test(file)) score += 15;
  if (/migration|prisma|schema\.sql/i.test(file)) score += 15;
  return score;
}

function isLowSignalBuildMemoryPath(file: string): boolean {
  return /(^|\/)(fixtures?|__fixtures__|testdata|snapshots?|mocks?)\//i.test(file) ||
    /(^|\/)\.(claude|klauro|unravl)(\/|$)/i.test(file) ||
    /(^|\/)\.agents\/reviews\//i.test(file) ||
    /(^|\/)(node_modules|dist|build|coverage|target|vendor)\//i.test(file);
}

function contextFileReason(file: string): string {
  if (isProjectManifest(file)) return 'Project stack and commands.';
  if (isDomainOwnerFile(file)) return 'Existing domain concepts to extend.';
  if (isBehaviorBoundary(file)) return 'Existing behavior boundary to reuse.';
  if (isEntryBoundary(file)) return 'Existing entry/view boundary to extend.';
  if (/(test|spec)\./i.test(file)) return 'Focused test pattern for the next slice.';
  if (/migration|prisma|schema\.sql/i.test(file)) return 'Persistence shape and migration pattern.';
  return 'High-signal project context.';
}

function isBehaviorBoundary(file: string): boolean {
  return /(^|\/|[-_.])(service|repository|adapter|client|hook|store|worker|job|usecase|use-case)([-_.]|\/)/i.test(file);
}

function isEntryBoundary(file: string): boolean {
  if (/(^|\/|[-_.])(controller|route|routes|page|view|screen|handler)([-_.]|\/)/i.test(file)) return true;
  return /(^|\/)components?\//i.test(file) || /(^|\/|[-_.])component\.(tsx|jsx|ts|js)$/i.test(file);
}

function isDomainOwnerFile(file: string): boolean {
  return /(^|\/)(domain|models?|entities?|schemas?|types)(\/|\.|-)/i.test(file) || /(model|entity|schema|domain|types)\./i.test(file);
}

function isProjectManifest(file: string): boolean {
  return /package\.json|pyproject\.toml|Cargo\.toml|go\.mod|pom\.xml|\.csproj$/.test(file);
}

function isDocPath(file: string): boolean {
  return /^docs\//i.test(file) || /\.md$/i.test(file);
}

function isSourceLikePath(file: string): boolean {
  return /\.(ts|tsx|js|jsx|py|go|rs|java|cs|php|dart)$/i.test(file);
}

function isTestFile(file: string): boolean {
  return /(^|\/)(__tests__|tests?|specs?)\/|(\.|-)(test|spec)\./i.test(file);
}

function planTokenSet(value: string): Set<string> {
  return new Set(normalize(value)
    .split(/\s+/)
    .filter(token => token.length > 2 && !BUILD_MEMORY_GENERIC_TERMS.has(token)));
}

function uniqueByFile(items: Array<{ file: string; reason: string }>) {
  const seen = new Set<string>();
  const out: Array<{ file: string; reason: string }> = [];
  for (const item of items) {
    if (seen.has(item.file)) continue;
    seen.add(item.file);
    out.push(item);
  }
  return out;
}

function ownerRoot(file: string): string {
  const parts = file.split('/').filter(Boolean);
  if (parts[0] === 'src') return 'src';
  if (parts[0] === 'apps' || parts[0] === 'packages') return parts.slice(0, 2).join('/');
  return parts[0] || file;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

const BUILD_MEMORY_GENERIC_TERMS = new Set([
  'add', 'and', 'app', 'code', 'codebase', 'current', 'file', 'files', 'fix', 'for',
  'from', 'into', 'new', 'next', 'project', 'repo', 'slice', 'source', 'system',
  'the', 'this', 'update', 'use', 'while', 'with', 'domain', 'domains', 'concept',
  'concepts', 'entity', 'entities', 'main',
]);

const GREENFIELD_BUILD_MEMORY_HIGH_SIGNAL_TERMS = [
  'greenfield',
  'continuation',
  'packet',
  'packets',
  'scratch',
  'proof',
  'benchmark',
  'acceptance',
  'compliance',
  'multi',
  'wave',
  'docs',
];
