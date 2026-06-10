import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { buildSummary } from './query';

export interface GreenfieldReferenceAnalysis {
  path: string;
  name: string;
  cas: CASOutput;
}

export interface GreenfieldGuidanceOptions {
  planText: string;
  proposedFiles?: Array<{ path: string; content?: string; status?: string }>;
  references?: GreenfieldReferenceAnalysis[];
  limit?: number;
}

export function buildGreenfieldArchitectureGuidance(options: GreenfieldGuidanceOptions) {
  const planText = options.planText || '';
  const proposedFiles = options.proposedFiles || [];
  const references = options.references || [];
  const planSignals = extractPlanSignals(planText, proposedFiles);
  const referenceSignals = references.map(reference => summarizeReference(reference));
  const overlap = findExistingOverlap(planSignals, referenceSignals, options.limit || 12);
  const capabilityMemory = buildCapabilityMemory(planSignals, referenceSignals, overlap, options.limit || 12);
  const patterns = recommendPatterns(planSignals, referenceSignals);
  const filePlan = buildSuggestedFilePlan(planSignals, patterns, proposedFiles);
  const proposedReview = reviewProposedFiles(planSignals, proposedFiles, patterns, overlap);
  const risks = buildGreenfieldRisks(planSignals, proposedFiles, overlap, patterns);
  const largeScaleBuildStrategy = buildLargeScaleBuildStrategy(planSignals, patterns, capabilityMemory);

  return {
    product: 'greenfield_architecture_guidance',
    generated_at: new Date().toISOString(),
    status: risks.some(risk => risk.severity === 'error') ? 'needs_revision' : risks.length ? 'warn' : 'ready',
    plan_intent: planSignals,
    reference_scope: {
      repositories: referenceSignals.map(reference => ({
        name: reference.name,
        path: reference.path,
        primary_domain: reference.primary_domain,
        capabilities: reference.capabilities.slice(0, 8).map(capability => capability.name),
        architecture_patterns: reference.patterns.slice(0, 6).map(pattern => pattern.name),
      })),
      count: referenceSignals.length,
    },
    capability_memory: capabilityMemory,
    existing_overlap: overlap,
    recommended_architecture: {
      patterns,
      file_plan: filePlan,
      testing: buildTestingGuidance(planSignals, patterns),
      data_and_migrations: buildDataGuidance(planSignals),
      agent_rules: [
        'Before creating a module, compare the proposed capability name against existing_overlap.reused_or_integrated_capabilities.',
        'Use the recommended patterns as defaults only when they are supported by reference evidence or explicit plan needs.',
        'After proposed files exist, run preview_greenfield_codebase and inspect the generated CAS graph before implementation.',
        'If the project grows by capability, create one vertical slice at a time and re-run preview_greenfield_codebase after each slice.',
      ],
    },
    large_scale_build_strategy: largeScaleBuildStrategy,
    proposed_files_review: proposedReview,
    risks,
    next_mcp_calls: [
      { tool: 'preview_greenfield_codebase', when: 'after producing the first file bundle', args: { plan_text: '<same plan>', proposed_files: '<file bundle>' } },
      { tool: 'compare_analysis_iterations', when: 'after a proposal preview exists and another iteration is proposed', args: { preview_id: '<preview id>' } },
    ],
  };
}

function summarizeReference(reference: GreenfieldReferenceAnalysis) {
  const summary = buildSummary(reference.cas);
  const capabilities = (reference.cas.system_capabilities || []).map(capability => ({
    name: capability.name,
    description: capability.description,
    domains: capability.related_domains || [],
    entities: capability.related_entities || [],
  }));
  const entities = [
    ...(reference.cas.data_entities || []).map(entity => entity.name),
    ...(reference.cas.database_schema?.entities || []).map(entity => entity.name),
    ...(reference.cas.domain_concepts || []).filter(concept => concept.classification !== 'infrastructure').map(concept => concept.name),
  ];
  const patterns = reference.cas.architecture_summary?.architectural_patterns || [];
  const inventory = reference.cas.architecture_summary?.architectural_inventory || {};

  return {
    name: reference.name,
    path: reference.path,
    primary_domain: summary.primary_domain || reference.cas.enhanced_system_purpose?.primary_domain || 'unknown',
    description: summary.description || reference.cas.enhanced_system_purpose?.inferred_description || reference.cas.system?.description || '',
    capabilities,
    entities: uniqueStrings(entities).slice(0, 40),
    patterns,
    inventory,
    frameworks: summary.frameworks || [],
    languages: summary.languages || [],
  };
}

function extractPlanSignals(planText: string, proposedFiles: Array<{ path: string; content?: string }>) {
  const text = `${planText}\n${proposedFiles.map(file => `${file.path}\n${file.content || ''}`).join('\n')}`;
  const lower = text.toLowerCase();
  const filePaths = proposedFiles.map(file => file.path);
  const stack = uniqueStrings([
    lower.includes('nestjs') || lower.includes('@nestjs') ? 'NestJS' : '',
    lower.includes('express') ? 'Express' : '',
    lower.includes('fastapi') ? 'FastAPI' : '',
    lower.includes('django') ? 'Django' : '',
    lower.includes('react') || filePaths.some(file => file.endsWith('.tsx')) ? 'React' : '',
    lower.includes('next') ? 'Next.js' : '',
    lower.includes('postgres') || lower.includes('prisma') ? 'PostgreSQL/Prisma' : '',
    lower.includes('stripe') ? 'Stripe' : '',
    lower.includes('kafka') || lower.includes('queue') ? 'Messaging/Queue' : '',
  ].filter(Boolean));
  const capabilities = nounPhrases(planText)
    .filter(term => !GENERIC_TERMS.has(term.toLowerCase()))
    .slice(0, 16);
  const domains = uniqueStrings([
    ...capabilities.filter(term => term.length > 3),
    ...Array.from(lower.matchAll(/\b(auth|tenant|billing|payment|portfolio|trading|report|analytics|notification|user|workspace|project|document|media|audio|search|proposal|preview)\w*\b/g)).map(match => match[0]),
  ]).slice(0, 16);

  const needsApi = /\b(api|endpoint|route|controller|requests?|responses?|webhook)\b/i.test(text);
  const needsUi = /\b(ui|page|component|screen|view|form|dashboard)\b/i.test(text);
  const needsData = /\b(database|entity|schema|migration|postgres|prisma|sql|repository|persistent|persistence)\b/i.test(text) ||
    filePaths.some(file => /model|entity|schema|migration|repository|prisma/i.test(file));
  const needsAuthOrTenant = /\b(auth|login|user|tenant|organization|workspace|permission|role)\b/i.test(text);
  const needsBackgroundWork = /\b(job|queue|worker|scheduled?|schedule|cron|event|message|digest)\b/i.test(text);
  const needsEntry = needsApi || needsUi || needsBackgroundWork ||
    /\b(backend|platform|service|application|system|workflow|supports?|submit|review|approve|reject|create|update|process)\b/i.test(text);

  return {
    summary: firstSentence(planText) || 'New codebase proposal',
    domains,
    capabilities,
    stack,
    file_count: proposedFiles.length,
    proposed_paths: filePaths,
    needs_entry: needsEntry,
    needs_api: needsApi,
    needs_ui: needsUi,
    needs_data: needsData,
    needs_auth_or_tenant: needsAuthOrTenant,
    needs_background_work: needsBackgroundWork,
    needs_external_integration: /\b(stripe|github|slack|email|webhook|external|api client|sdk)\b/i.test(text),
  };
}

function findExistingOverlap(planSignals: ReturnType<typeof extractPlanSignals>, references: ReturnType<typeof summarizeReference>[], limit: number) {
  const terms = uniqueStrings([...planSignals.domains, ...planSignals.capabilities]).map(term => term.toLowerCase());
  const matches = [];
  for (const reference of references) {
    const candidateCapabilities = reference.capabilities
      .map(capability => {
        const match = scoreCapabilityOverlap(planSignals, capability);
        return { ...capability, match_score: match.score, matched_terms: match.terms };
      })
      .filter(capability => capability.match_score >= 35 || terms.some(term => capability.matched_terms.includes(term)))
      .sort((left, right) => right.match_score - left.match_score);
    const candidateEntities = reference.entities.filter(entity => {
      const normalized = entity.toLowerCase();
      return terms.some(term => normalized.includes(term) || term.includes(normalized));
    });
    if (candidateCapabilities.length || candidateEntities.length) {
      matches.push({
        repository: reference.name,
        path: reference.path,
        primary_domain: reference.primary_domain,
        reused_or_integrated_capabilities: candidateCapabilities.slice(0, 8),
        related_entities: candidateEntities.slice(0, 12),
        strongest_overlap_score: candidateCapabilities[0]?.match_score || (candidateEntities.length ? 40 : 0),
        matched_terms: uniqueStrings([
          ...candidateCapabilities.flatMap(capability => capability.matched_terms),
          ...candidateEntities.flatMap(entity => matchedTermsForText(terms, entity)),
        ]).slice(0, 12),
        guidance: candidateCapabilities.length
          ? `Check ${reference.name} before rebuilding overlapping behavior; prefer integration, shared package extraction, or explicit divergence.`
          : `Review ${reference.name} entities before naming or modeling the same domain again.`,
      });
    }
  }
  return {
    status: matches.length ? 'overlap-found' : 'no-known-overlap',
    matches: matches.slice(0, limit),
    duplication_rule: matches.length
      ? 'Do not recreate overlapping capabilities silently. Decide whether to reuse, integrate, extract shared code, or intentionally fork the behavior.'
      : 'No overlapping analyzed capability was found; still run preview_greenfield_codebase once files exist.',
  };
}

function buildCapabilityMemory(
  planSignals: ReturnType<typeof extractPlanSignals>,
  references: ReturnType<typeof summarizeReference>[],
  overlap: ReturnType<typeof findExistingOverlap>,
  limit: number
) {
  const ledger = references.flatMap(reference => reference.capabilities.map(capability => {
    const match = scoreCapabilityOverlap(planSignals, capability);
    return {
      repository: reference.name,
      path: reference.path,
      capability: capability.name,
      description: capability.description,
      domains: capability.domains,
      entities: capability.entities,
      match_score: match.score,
      matched_terms: match.terms,
      recommendation: match.score >= 70 ? 'reuse-or-integrate' : match.score >= 35 ? 'review-before-building' : 'background-reference',
    };
  }))
    .filter(entry => entry.capability)
    .sort((left, right) => right.match_score - left.match_score || left.repository.localeCompare(right.repository))
    .slice(0, Math.max(limit, 12));

  const decisions = ledger
    .filter(entry => entry.match_score >= 35)
    .slice(0, limit)
    .map(entry => ({
      proposed_need: entry.matched_terms.join(', ') || entry.capability,
      existing_capability: entry.capability,
      repository: entry.repository,
      decision_required: entry.match_score >= 70 ? 'reuse_or_integrate_before_building' : 'review_then_build_or_fork_explicitly',
      rationale: entry.match_score >= 70
        ? 'The plan appears to request behavior already represented by this analyzed capability.'
        : 'The plan overlaps existing domain language or entities enough that silent duplication is risky.',
      acceptable_outcomes: [
        'reuse existing behavior',
        'integrate through an API/package/shared module',
        'extract a shared capability',
        'intentionally fork with a named reason',
      ],
    }));
  const existingDecisionKeys = new Set(decisions.map(decision => `${decision.repository}:${decision.existing_capability}:${decision.proposed_need}`));
  for (const match of overlap.matches) {
    for (const entity of match.related_entities.slice(0, Math.max(1, limit - decisions.length))) {
      const key = `${match.repository}:${entity}:${entity}`;
      if (existingDecisionKeys.has(key)) continue;
      existingDecisionKeys.add(key);
      decisions.push({
        proposed_need: entity,
        existing_capability: entity,
        repository: match.repository,
        decision_required: 'review_then_build_or_fork_explicitly',
        rationale: 'The plan overlaps an existing analyzed domain/entity name; silent model duplication is risky even when no named capability matched strongly.',
        acceptable_outcomes: [
          'reuse existing model/entity',
          'extend the existing module boundary',
          'integrate through an API/package/shared module',
          'intentionally fork with a named reason',
        ],
      });
      if (decisions.length >= limit) break;
    }
    if (decisions.length >= limit) break;
  }

  return {
    status: decisions.length ? 'existing-capabilities-found' : 'no-matching-capability-memory',
    analyzed_capabilities: ledger,
    reuse_decisions_required: decisions,
    do_not_rebuild: overlap.matches.map(match => ({
      repository: match.repository,
      path: match.path,
      capabilities: match.reused_or_integrated_capabilities.map(capability => capability.name),
      entities: match.related_entities,
      matched_terms: match.matched_terms,
      rule: 'Do not create a new implementation of this behavior without choosing reuse, integration, extraction, or explicit fork.',
    })),
    agent_checklist: [
      'Search analyzed capabilities before creating a new module or service.',
      'Name the intended capability and compare it to reuse_decisions_required.',
      'If overlap exists, state reuse/integrate/extract/fork in the plan before writing files.',
      'After files exist, run preview_greenfield_codebase and compare the proposed CAS against this memory.',
    ],
  };
}

function scoreCapabilityOverlap(
  planSignals: ReturnType<typeof extractPlanSignals>,
  capability: { name: string; description?: string; domains?: string[]; entities?: string[] }
) {
  const terms = uniqueStrings([...planSignals.domains, ...planSignals.capabilities])
    .map(term => normalizeTerm(term))
    .filter(term => term.length > 2 && !GENERIC_TERMS.has(term));
  const haystack = normalizeTerm([
    capability.name,
    capability.description || '',
    ...(capability.domains || []),
    ...(capability.entities || []),
  ].join(' '));
  const matched = terms.filter(term => term.length > 2 && (haystack.includes(term) || term.includes(haystack)));
  const capabilityTokens = tokenSet(haystack);
  const planTokens = tokenSet(terms.join(' '));
  const intersection = [...planTokens].filter(token => capabilityTokens.has(token) && !GENERIC_TERMS.has(token));
  const lexicalScore = planTokens.size ? Math.round((intersection.length / Math.max(1, Math.min(planTokens.size, capabilityTokens.size))) * 100) : 0;
  const directScore = matched.length ? Math.min(100, 45 + matched.length * 15) : 0;
  return {
    score: Math.max(lexicalScore, directScore),
    terms: uniqueStrings([...matched, ...intersection]).slice(0, 12),
  };
}

function matchedTermsForText(terms: string[], text: string): string[] {
  const normalized = normalizeTerm(text);
  return terms.filter(term => normalized.includes(normalizeTerm(term)) || normalizeTerm(term).includes(normalized));
}

function recommendPatterns(planSignals: ReturnType<typeof extractPlanSignals>, references: ReturnType<typeof summarizeReference>[]) {
  const fromReferences = new Map<string, { name: string; category: string; confidence: number; evidence: string[]; guidance: string }>();
  for (const reference of references) {
    for (const pattern of reference.patterns.slice(0, 8) as any[]) {
      const key = String(pattern.name || '').toLowerCase();
      if (!key || fromReferences.has(key)) continue;
      if (!patternMatchesPlan(pattern.name || '', pattern.category || '', planSignals)) continue;
      fromReferences.set(key, {
        name: pattern.name,
        category: pattern.category || 'application-architecture',
        confidence: Math.min(0.95, Number(pattern.confidence || 0.7)),
        evidence: [`${reference.name}: ${(pattern.evidence || []).slice(0, 2).join('; ')}`].filter(Boolean),
        guidance: pattern.guidance || `Follow the ${pattern.name} shape used in ${reference.name}.`,
      });
    }
  }

  const recommended = Array.from(fromReferences.values());
  if ((planSignals.needs_api || planSignals.needs_entry || planSignals.needs_data) && !hasPattern(recommended, 'service layer')) {
    recommended.push({
      name: 'Service Layer',
      category: 'business-logic',
      confidence: 0.8,
      evidence: ['Plan includes externally visible product behavior or persistence-backed workflows.'],
      guidance: 'Keep request handling thin; put business behavior in services that can be tested directly.',
    });
  }
  if (planSignals.needs_data && !hasPattern(recommended, 'repository')) {
    recommended.push({
      name: 'Repository/Data Access Boundary',
      category: 'data-access',
      confidence: 0.76,
      evidence: ['Plan includes data models, database, schema, or migrations.'],
      guidance: 'Put persistence behind repository/data-access functions and pair schema changes with migrations.',
    });
  }
  if (planSignals.needs_ui && !hasPattern(recommended, 'component')) {
    recommended.push({
      name: 'Component/Page UI',
      category: 'presentation',
      confidence: 0.74,
      evidence: ['Plan includes UI/page/component behavior.'],
      guidance: 'Keep route/page composition separate from reusable components and data-fetching hooks.',
    });
  }
  if (planSignals.needs_background_work && !hasPattern(recommended, 'worker')) {
    recommended.push({
      name: 'Worker/Event Boundary',
      category: 'integration',
      confidence: 0.72,
      evidence: ['Plan includes background jobs, schedules, queues, or events.'],
      guidance: 'Model async triggers as entry points and keep handlers idempotent where possible.',
    });
  }

  return recommended
    .sort((left, right) => Number(right.confidence || 0) - Number(left.confidence || 0))
    .slice(0, 5);
}

function buildSuggestedFilePlan(
  planSignals: ReturnType<typeof extractPlanSignals>,
  patterns: ReturnType<typeof recommendPatterns>,
  proposedFiles: Array<{ path: string; content?: string }>
) {
  if (proposedFiles.length > 0) {
    return proposedFiles.map(file => ({
      path: file.path,
      role: inferFileRole(file.path),
      guidance: `Keep this file aligned with the ${inferFileRole(file.path)} role; avoid mixing unrelated layers.`,
    }));
  }
  const conceptCount = uniqueStrings([...planSignals.capabilities, ...planSignals.domains]).length;
  const aggregateDomain = conceptCount >= 8;
  const files = [];
  if (planSignals.needs_api || (planSignals.needs_entry && !planSignals.needs_ui)) {
    files.push({ path: 'src/routes-or-controllers/<capability>.ts', role: 'entry point', guidance: 'Define the external API shape and delegate behavior.' });
    files.push({ path: 'src/services/<capability>.service.ts', role: 'business logic', guidance: 'Implement capability behavior here for focused tests.' });
  }
  if (planSignals.needs_data) {
    files.push(aggregateDomain
      ? { path: 'src/domain/<domain>.models.ts', role: 'domain model', guidance: 'For broad first slices, group related entities in one domain model file before splitting by bounded context.' }
      : { path: 'src/models-or-entities/<entity>.ts', role: 'domain model', guidance: 'Define the domain shape once and reference it consistently.' });
    files.push(aggregateDomain
      ? { path: 'src/repositories/<domain>.repository.ts', role: 'data access', guidance: 'Use one repository boundary for the first slice; split per entity only after behavior proves the need.' }
      : { path: 'src/repositories/<entity>.repository.ts', role: 'data access', guidance: 'Isolate persistence and query behavior.' });
    files.push({ path: 'migrations/<timestamp>_<change>.sql', role: 'migration', guidance: 'Pair schema changes with migration evidence.' });
  }
  if (planSignals.needs_ui) {
    files.push({ path: 'src/pages-or-routes/<feature>.tsx', role: 'view/page', guidance: 'Compose user workflow and data loading.' });
    files.push({ path: 'src/components/<feature>/<component>.tsx', role: 'component', guidance: 'Keep reusable UI separate from route orchestration.' });
  }
  if (planSignals.needs_background_work) {
    files.push({ path: 'src/jobs-or-workers/<capability>.ts', role: 'background entry point', guidance: 'Keep scheduled/async triggers thin and delegate behavior to services.' });
  }
  if (!files.length && (planSignals.capabilities.length || planSignals.domains.length)) {
    files.push({ path: 'src/domain/<core-concepts>.ts', role: 'domain model', guidance: 'Name the core concepts once so later slices extend the same model chain.' });
    files.push({ path: 'src/services/<first-capability>.service.ts', role: 'business logic', guidance: 'Put the first product behavior behind a focused service boundary.' });
    files.push({ path: 'src/entrypoints/<first-capability>.ts', role: 'entry point', guidance: 'Expose the first behavior through a thin entry boundary, even if the final transport is not chosen yet.' });
  }
  files.push({ path: 'tests/<capability>.test.ts', role: 'test', guidance: 'Cover the first behavior slice and the highest-risk boundary.' });
  return files.slice(0, 10);
}

function reviewProposedFiles(
  planSignals: ReturnType<typeof extractPlanSignals>,
  proposedFiles: Array<{ path: string; content?: string }>,
  patterns: ReturnType<typeof recommendPatterns>,
  overlap: ReturnType<typeof findExistingOverlap>
) {
  const paths = proposedFiles.map(file => file.path);
  const findings = [];
  if (!proposedFiles.length) {
    findings.push({
      status: 'needs-files',
      message: 'No proposed files were supplied, so Klauro can only provide architecture guidance. Supply a minimal file bundle for CAS preview.',
    });
  }
  if ((planSignals.needs_api || planSignals.needs_entry) && !paths.some(path => /controller|route|handler|api|entrypoint/i.test(path))) {
    findings.push({ status: 'warn', message: 'Plan appears to need an API boundary, but no controller/route/handler file is proposed.' });
  }
  if (planSignals.needs_data && !paths.some(path => /model|entity|schema|migration|repository|prisma/i.test(path))) {
    findings.push({ status: 'warn', message: 'Plan appears to need data persistence, but no model/entity/schema/repository/migration file is proposed.' });
  }
  if (planSignals.needs_ui && !paths.some(path => /page|route|component|view/i.test(path))) {
    findings.push({ status: 'warn', message: 'Plan appears to need UI, but no page/view/component file is proposed.' });
  }
  if (paths.some(path => isSourcePath(path)) && !paths.some(path => isTestPath(path))) {
    findings.push({ status: 'warn', message: 'Source files are proposed without tests. Add focused tests or explain why this is scaffolding-only.' });
  }
  if (overlap.status === 'overlap-found') {
    findings.push({ status: 'warn', message: 'Existing analyzed repositories contain overlapping capabilities or entities; resolve reuse/integration before creating duplicates.' });
  }
  return {
    status: findings.some(finding => finding.status === 'needs-files') ? 'needs-files' : findings.length ? 'warn' : 'pass',
    findings,
    pattern_fit: patterns.map(pattern => ({
      pattern: pattern.name,
      supplied_examples: paths.filter(file => file.toLowerCase().includes(pattern.name.toLowerCase().split(/[ /-]/)[0])).slice(0, 5),
    })),
  };
}

function buildGreenfieldRisks(
  planSignals: ReturnType<typeof extractPlanSignals>,
  proposedFiles: Array<{ path: string; content?: string }>,
  overlap: ReturnType<typeof findExistingOverlap>,
  patterns: ReturnType<typeof recommendPatterns>
) {
  const risks = [];
  if (!proposedFiles.length) {
    risks.push({ severity: 'error', risk: 'No file bundle', recommendation: 'Provide a minimal file bundle so Klauro can analyze the proposed codebase state.' });
  }
  if (overlap.status === 'overlap-found') {
    risks.push({ severity: 'warning', risk: 'Potential duplicate capability', recommendation: overlap.duplication_rule });
  }
  if (planSignals.needs_auth_or_tenant) {
    risks.push({ severity: 'warning', risk: 'Auth or tenant boundary', recommendation: 'Define auth/tenant invariants and tests in the first slice.' });
  }
  if (patterns.length > 6) {
    risks.push({ severity: 'warning', risk: 'Pattern spread', recommendation: 'Start with the smallest set of patterns needed for the first vertical slice.' });
  }
  return risks;
}

function buildTestingGuidance(planSignals: ReturnType<typeof extractPlanSignals>, patterns: ReturnType<typeof recommendPatterns>) {
  return uniqueStrings([
    'Add one focused test for the first externally visible behavior.',
    planSignals.needs_api ? 'Add route/controller tests for status codes, validation, and auth/tenant behavior.' : '',
    planSignals.needs_data ? 'Add repository/data-access tests around persistence and migration-sensitive behavior.' : '',
    planSignals.needs_ui ? 'Add component/page tests for visible states and data-loading boundaries.' : '',
    patterns.some(pattern => /worker|event/i.test(pattern.name)) ? 'Add idempotency and retry-path tests for async handlers.' : '',
  ].filter(Boolean));
}

function buildDataGuidance(planSignals: ReturnType<typeof extractPlanSignals>) {
  if (!planSignals.needs_data) return ['No data layer is clearly required by the plan; avoid adding persistence until a behavior needs it.'];
  return [
    'Name core entities from the domain terms in plan_intent.domains, not from implementation layers.',
    'Create migrations for schema changes and keep model/entity definitions aligned with migration names.',
    'Treat tenant/user/workspace fields as invariants when the plan mentions auth, users, organizations, or workspaces.',
  ];
}

function buildLargeScaleBuildStrategy(
  planSignals: ReturnType<typeof extractPlanSignals>,
  patterns: ReturnType<typeof recommendPatterns>,
  capabilityMemory: ReturnType<typeof buildCapabilityMemory>
) {
  const domains = planSignals.domains.slice(0, 10);
  const capabilities = planSignals.capabilities.slice(0, 10);
  const coreConcepts = uniqueStrings([
    ...domains,
    ...capabilities.flatMap(capability => capability.split(/\s+/).filter(part => part.length > 3)),
  ])
    .filter(term => !GENERIC_TERMS.has(term.toLowerCase()))
    .slice(0, 12);
  const firstSlice = uniqueStrings([
    planSignals.needs_auth_or_tenant ? 'auth/tenant boundary' : '',
    planSignals.needs_api ? 'one external entry point' : '',
    planSignals.needs_data ? 'core domain model plus repository and migration' : '',
    planSignals.needs_ui ? 'one route/page plus reusable component boundary' : '',
    planSignals.needs_background_work ? 'one worker/event boundary' : '',
    'focused tests for the first externally visible behavior',
  ].filter(Boolean));

  return {
    product: 'large_scale_greenfield_strategy',
    objective: 'Let the agent focus on product behavior while Klauro carries architecture memory, duplication checks, and iteration checkpoints.',
    core_concepts_to_name_once: coreConcepts,
    first_slice: {
      goal: 'Build the smallest vertical slice that proves the architecture and names the core domain once.',
      required_boundaries: firstSlice,
      exit_criteria: [
        'preview_greenfield_codebase returns a meaningful CAS graph',
        'core entities appear once and are imported by routes/services/tests instead of redefined',
        'tests cover the highest-risk behavior in the first slice',
      ],
    },
    iteration_loop: [
      'Before each new slice, read capability_memory.do_not_rebuild and reuse_decisions_required.',
      'Add behavior by extending existing domain/service/repository boundaries unless the new capability has a clearly different lifecycle.',
      'Run preview_greenfield_codebase or compare_analysis_iterations after the slice and inspect changed entities, contracts, tests, idioms, and risks.',
      'Promote recurring conventions into codebase idioms once the first two slices establish the local pattern.',
    ],
    anti_duplication_rules: [
      'Never create a second entity/model for a concept listed in core_concepts_to_name_once without an explicit fork reason.',
      'Prefer ID/type references to existing models for continuation entities.',
      'Keep migrations incremental; do not rewrite the initial schema when adding a later slice.',
      'Keep one owner for cross-cutting concepts such as tenant scope, auth, validation, logging, configuration, and scheduling.',
    ],
    context_budgeting: [
      'Use Klauro guidance for architecture memory before reading generated files.',
      'On later slices, read only files named by the previous CAS preview, changed contracts, relevant idioms, and required tests.',
      'Treat broad source rediscovery as a fallback when CAS reports missing or low-confidence graph facts.',
    ],
      pattern_budget: {
      recommended_patterns: patterns.map(pattern => pattern.name),
      rule: patterns.length > 4
        ? 'Start with only the patterns needed for the first vertical slice; defer lower-confidence patterns until a concrete behavior needs them.'
        : 'Use these patterns as the initial architecture budget and avoid adding more until a slice needs them.',
    },
    file_budget: {
      rule: 'Use the fewest files that preserve layer ownership; first slices should group domain and repository concepts before splitting.',
      split_later_when: [
        'A bounded context has independent lifecycle, ownership, or tests.',
        'A single owner file becomes hard to scan after real behavior accumulates.',
        'CAS shows duplicated concepts or unclear boundaries after an iteration.',
      ],
    },
    capability_memory_status: capabilityMemory.status,
  };
}

function hasPattern(patterns: Array<{ name: string }>, name: string): boolean {
  return patterns.some(pattern => pattern.name.toLowerCase().includes(name.toLowerCase()));
}

function patternMatchesPlan(patternName: string, category: string, planSignals: ReturnType<typeof extractPlanSignals>): boolean {
  const name = patternName.toLowerCase();
  const kind = category.toLowerCase();
  if (planSignals.needs_ui) {
    return /component|page|view|mvvm|presentation/.test(`${name} ${kind}`);
  }
  if (planSignals.needs_background_work) {
    return /worker|event|mediator|handler|service|repository|layer/.test(`${name} ${kind}`);
  }
  if (planSignals.needs_api || planSignals.needs_data) {
    if (/singleton|registry|command script|automation|static site/.test(name)) return false;
    if (planSignals.needs_data && /repository|unit of work|data|service|layer|feature|mvc/.test(`${name} ${kind}`)) return true;
    if (planSignals.needs_api && /mvc|controller|service|layer|feature|api/.test(`${name} ${kind}`)) return true;
  }
  if (planSignals.needs_external_integration && /client|sdk|integration/.test(`${name} ${kind}`)) return true;
  return false;
}

function inferFileRole(filePath: string): string {
  if (/test|spec/i.test(filePath)) return 'test';
  if (/controller|route|handler|api/i.test(filePath)) return 'entry point';
  if (/service|usecase|interactor/i.test(filePath)) return 'business logic';
  if (/repository|dao|store/i.test(filePath)) return 'data access';
  if (/model|entity|schema/i.test(filePath)) return 'domain model';
  if (/migration/i.test(filePath)) return 'migration';
  if (/component|page|view/i.test(filePath)) return 'presentation';
  if (/worker|job|queue|event/i.test(filePath)) return 'async boundary';
  return 'supporting source';
}

function nounPhrases(text: string): string[] {
  const enumeratedConcepts = Array.from(text.matchAll(/\b(?:needs?|supports?|support|with|including|include|includes|for)\s+([^.;\n]{4,240})/gi))
    .flatMap(match => match[1].split(/,|\band\b/gi))
    .map(cleanConceptTerm)
    .filter(Boolean);
  const explicitDomainTerms = Array.from(text.matchAll(/\b(auth|tenant|billing|payment|portfolio|trading|report|analytics|notification|workspace|proposal|preview|contract|migration|repository|controller|component|dashboard|organization|user|role|access|claim|claims|intake|evidence|packet|review|queue|policy|audit|export|sla|escalation|digest|webhook|postgres|persistence|worker|background)\w*\b/gi))
    .map(match => match[0].toLowerCase());
  const properConcepts = Array.from(text.matchAll(/\b([A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+){0,2})\b/g))
    .map(match => cleanConceptTerm(match[1]))
    .filter(Boolean);
  return uniqueStrings([...enumeratedConcepts, ...properConcepts, ...explicitDomainTerms])
    .filter(term => !isBadConceptTerm(term));
}

function cleanConceptTerm(term: string): string {
  return term
    .replace(/\b(the|a|an|this|that|it|system|product|project|codebase|large-scale|large|regulated|enterprise|teams?|many|multiple|focused|external|background|existing|new|current)\b/gi, ' ')
    .replace(/\b(must|should|could|would|can|able|grow|growing|without|duplicating|duplicate|re-deciding|deciding|architecture|time|each|slice|slices)\b.*$/gi, ' ')
    .replace(/\b(tests?|scaffolds?|source|files?|migrations?)\b$/i, match => match.toLowerCase())
    .replace(/[^a-zA-Z0-9/ -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(needs?|supports?|support|build|create|add|include|including|with|for)\s+/i, '')
    .trim();
}

function isBadConceptTerm(term: string): boolean {
  const normalized = normalizeTerm(term);
  if (!normalized || normalized.length < 3) return true;
  if (GENERIC_TERMS.has(normalized)) return true;
  if (/^(build|create|add|need|needs|support|supports|include|includes|including|it|the|this)\b/.test(normalized)) return true;
  if (/\b(must|without|duplicating|deciding|architecture each)\b/.test(normalized)) return true;
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length > 4) return true;
  if (tokens.every(token => GENERIC_TERMS.has(token))) return true;
  return false;
}

function firstSentence(text: string): string {
  return text.split(/\n|(?<=\.)\s+/).map(part => part.trim()).find(Boolean) || '';
}

function isSourcePath(filePath: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|cs|php|dart)$/.test(filePath) && !isTestPath(filePath);
}

function isTestPath(filePath: string): boolean {
  return /(^|\/)(__tests__|tests?|specs?)\/|(\.|-)(test|spec)\./i.test(filePath);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map(value => String(value || '').trim()).filter(Boolean)));
}

function normalizeTerm(value: string): string {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenSet(value: string): Set<string> {
  return new Set(normalizeTerm(value).split(/\s+/).filter(token => token.length > 2 && !GENERIC_TERMS.has(token)));
}

const GENERIC_TERMS = new Set([
  'create', 'build', 'add', 'new', 'small', 'service', 'system', 'codebase', 'project',
  'app', 'application', 'api', 'file', 'files', 'src', 'test', 'tests',
  'large', 'needs', 'need', 'supports', 'support', 'include', 'includes', 'including',
  'architecture', 'product', 'slice', 'slices', 'time', 'each',
]);
