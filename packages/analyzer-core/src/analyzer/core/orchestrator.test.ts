import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnalyzerOrchestrator } from './orchestrator';
import { CASAnalysisError, CASContribution, CASOutput, SystemCapability } from '../../types/cas.types';
import { evaluateCapabilityCatalogOperationCoverage } from './capability-operation-coverage';
import { normalizePublishedCapabilityIds } from './capability-catalog-publication';

function emptyTarget() {
  return {
    allNodes: [] as any[],
    allEdges: [] as any[],
    allEntryPoints: [] as any[],
    allExitPoints: [] as any[],
  };
}

function contributions(): CASContribution[] {
  return [
    {
      nodes: [{ id: 'node-a', name: 'first', type: 'function', metadata: { first: true } } as any],
      edges: [{ id: 'edge-a', source: 'node-a', target: 'node-a', type: 'calls' } as any],
      entry_points: [{
        id: 'entry-coarse',
        name: 'run_tool',
        type: 'message',
        source_node: 'node-a',
        handler: { node_id: 'node-a', method_name: 'run_tool', file: 'server.ts' },
      } as any],
      exit_points: [{ id: 'exit-a', name: 'API', type: 'api', source_node: 'node-a' } as any],
      analyzer_metadata: { analyzer_id: 'first', analyzer_name: 'first', contribution_type: 'language' },
    },
    {
      nodes: [
        { id: 'node-a', name: 'second', type: 'method', description: 'richer', metadata: { second: true } } as any,
        { id: 'node-b', name: 'new', type: 'function' } as any,
      ],
      edges: [
        { id: 'edge-a', source: 'node-a', target: 'node-a', type: 'calls' } as any,
        { id: 'edge-b', source: 'node-a', target: 'node-b', type: 'calls' } as any,
      ],
      entry_points: [{
        id: 'entry-rich',
        name: 'run_tool',
        type: 'message',
        source_node: 'node-a',
        handler: { node_id: 'node-a', method_name: 'handleRunTool', file: 'server.ts', line: 42 },
        metadata: { registration: 'registerTool' },
      } as any],
      exit_points: [{ id: 'exit-a', name: 'Different API', type: 'api', source_node: 'node-b' } as any],
      analyzer_metadata: { analyzer_id: 'second', analyzer_name: 'second', contribution_type: 'framework' },
    },
    {
      edges: [{ id: 'edge-invalid', source: 'entry-invalid', target: 'node-a', type: 'calls' } as any],
      entry_points: [{ id: 'entry-invalid', name: 'invalid', type: 'not-a-real-type', source_node: 'node-a' } as any],
      analyzer_metadata: { analyzer_id: 'third', analyzer_name: 'third', contribution_type: 'library' },
    },
  ];
}

async function mergeAll(usePersistentIndexes: boolean) {
  const orchestrator = new AnalyzerOrchestrator() as any;
  const target = emptyTarget();
  const analysisErrors: CASAnalysisError[] = [];
  const originalCreateIndexes = orchestrator.createAnalysisMergeIndexes.bind(orchestrator);
  let indexBuilds = 0;
  orchestrator.createAnalysisMergeIndexes = (mergeTarget: ReturnType<typeof emptyTarget>) => {
    indexBuilds++;
    return originalCreateIndexes(mergeTarget);
  };
  const mergeIndexes = usePersistentIndexes
    ? orchestrator.createAnalysisMergeIndexes(target)
    : undefined;

  for (const contribution of contributions()) {
    await orchestrator.mergeAnalysisResult(target, contribution, {
      analyzerId: contribution.analyzer_metadata?.analyzer_id,
      analysisErrors,
      mergeIndexes,
    });
  }

  return { target, analysisErrors, indexBuilds, mergeIndexes };
}

test('persistent merge indexes build once and preserve exact CAS and warning parity', async () => {
  const persistent = await mergeAll(true);
  const fresh = await mergeAll(false);

  assert.equal(persistent.indexBuilds, 1);
  assert.equal(fresh.indexBuilds, contributions().length);
  assert.deepEqual(persistent.target, fresh.target);
  assert.deepEqual(persistent.analysisErrors, fresh.analysisErrors);
  assert.equal(persistent.mergeIndexes.nodesById.size, persistent.target.allNodes.length);
  assert.equal(persistent.mergeIndexes.edgesById.size, persistent.target.allEdges.length);
  assert.equal(persistent.mergeIndexes.entryPointsById.size, persistent.target.allEntryPoints.length);
  assert.equal(persistent.mergeIndexes.exitPointsById.size, persistent.target.allExitPoints.length);
  assert.deepEqual(persistent.target.allEntryPoints.map((entryPoint: any) => entryPoint.id), ['entry-rich']);
  assert.deepEqual(persistent.target.allEdges.map((edge: any) => edge.id), ['edge-a', 'edge-b']);
});

test('source inventory does not exclude first-party legacy directories by name', () => {
  const orchestrator = new AnalyzerOrchestrator() as any;
  const ignored = orchestrator.isIgnoredInventoryDirectory('legacy', 'legacy', new Set(), '/repo');

  assert.equal(ignored, false);
});

test('an atomic CRUD title cannot stand in for a multi-operation product capability', () => {
  const orchestrator = new AnalyzerOrchestrator() as any;
  const operations = [
    { entry_point_id: 'categories-index', entry_point_type: 'http', action: 'read', trigger: { method: 'GET', path: '/categories' } },
    { entry_point_id: 'categories-create', entry_point_type: 'http', action: 'create', trigger: { method: 'POST', path: '/categories' } },
    { entry_point_id: 'categories-update', entry_point_type: 'http', action: 'update', trigger: { method: 'PATCH', path: '/categories/:id' } },
    { entry_point_id: 'categories-delete', entry_point_type: 'http', action: 'delete', trigger: { method: 'DELETE', path: '/categories/:id' } },
  ];

  for (const name of ['View categories', 'Create categories', 'Update categories', 'Delete categories', 'Create and delete categories']) {
    assert.equal(orchestrator.capabilityContradictsObservedOperations({ name, description: '', operations }), true, name);
  }
  assert.equal(orchestrator.capabilityContradictsObservedOperations({
    name: 'Organize spending categories', description: '', operations,
  }), false);
});

test('read-only evidence cannot be described as maintaining or mutating its subject', () => {
  const orchestrator = new AnalyzerOrchestrator() as any;
  const operations = [
    { entry_point_id: 'securities-index', entry_point_type: 'http', action: 'read', trigger: { method: 'GET', path: '/securities' } },
  ];

  assert.equal(orchestrator.capabilityContradictsObservedOperations({
    name: 'Maintain securities', description: 'Users maintain securities over time.', operations,
  }), true);
  assert.equal(orchestrator.capabilityContradictsObservedOperations({
    name: 'Review securities', description: 'Users review securities and their current market details.', operations,
  }), false);
});

test('capability publication treats generic lifecycle prose as an unresolved template', () => {
  const orchestrator = new AnalyzerOrchestrator() as any;
  const capability = {
    id: 'categories', name: 'Organize spending categories', name_source: 'ai',
    description: 'Users can create, view, update, and remove categories through the same lifecycle whenever needed.',
    description_source: 'ai', category: 'core', criticality: 'high', criticality_factors: [],
    related_entities: ['entity_category'], related_domains: ['category'],
    operations: [{ entry_point_id: 'categories-create', entry_point_type: 'http', action: 'create' }],
  };

  assert.equal(orchestrator.capabilityPublishabilityFailure(capability), 'structural-placeholder-description');
});

test('capability publication accepts a concise grounded audience outcome', () => {
  const orchestrator = new AnalyzerOrchestrator() as any;
  const capability = {
    id: 'routing', name: 'Route requests to handlers with a macro free API', name_source: 'ai',
    description: 'Developers direct incoming requests to the handlers that serve them through a macro free API.',
    description_source: 'deterministic', category: 'core', criticality: 'high',
    criticality_factors: ['catalog-outcome-requirement:all:route'],
    related_entities: [], related_domains: ['routing'],
    operations: [{ entry_point_id: 'routing-entry', entry_point_type: 'http', action: 'route' }],
  };

  assert.equal(orchestrator.capabilityPublishabilityFailure(capability), undefined);
  assert.deepEqual(orchestrator.validateElementDescription(capability.description, {
    id: 'routing',
    name: capability.name,
    kind: 'capability',
    operations: ['route requests to handlers'],
    relatedEntities: [],
    relatedDomains: ['routing'],
    rawIdentifiers: [],
    productOutcomeTerms: ['Users can route requests to handlers with a macro free API.'],
  }), { ok: true });
});

test('normalizes reference-style Markdown and rejects leaked document fragments', () => {
  const orchestrator = new AnalyzerOrchestrator() as any;
  const framing = orchestrator.extractProductDocFraming([
    '# Flutter samples',
    '',
    'A collection of open source samples that illustrate best practices for',
    '[Flutter].',
  ].join('\n'));
  assert.equal(framing.summary, 'A collection of open source samples that illustrate best practices for Flutter.');
  assert.equal(orchestrator.capabilityPublishabilityFailure({
    id: 'bad', name: 'open source samples that illustrate best practices for [Flutter', name_source: 'ai',
    description: 'Developers inspect Flutter examples.', related_entities: [], related_domains: ['flutter'],
    operations: [{ entry_point_id: 'sample', entry_point_type: 'event', action: 'open' }],
  }), 'malformed-document-fragment-name');
});

test('extracts authored outcomes from overview and integration sections', () => {
  const orchestrator = new AnalyzerOrchestrator() as any;
  const framing = orchestrator.extractProductDocFraming([
    '# Distributed Pet Clinic',
    '',
    'A sample application demonstrating a microservices architecture.',
    '',
    '## Starting services locally without Docker',
    '',
    'Start Config Server and Discovery Server before every application.',
    '',
    '## Microservices Overview',
    '',
    '- **Customers Service**: manages customer and pet data.',
    '- **Vets Service**: helps users find veterinarian information.',
    '- **Visits Service**: records pet visit history.',
    '',
    '## Integrating the Chatbot',
    '',
    'Users can ask natural-language questions about owners, pets, and veterinarians.',
    '',
    '## Quick Start',
    '',
    '- Run ./mvnw clean install.',
  ].join('\n'));
  assert.match(framing.summary, /Context: Customers Service: manages customer and pet data/);
  assert.match(framing.summary, /find veterinarian information/);
  assert.match(framing.summary, /records pet visit history/);
  assert.match(framing.summary, /Feature: Users can ask natural-language questions/);
  assert.doesNotMatch(framing.summary, /Config Server and Discovery Server/);
  assert.doesNotMatch(framing.summary, /mvnw clean install/);
});

test('keeps documented examples and fenced usage code out of capability requirements', () => {
  const orchestrator = new AnalyzerOrchestrator() as any;
  const framing = orchestrator.extractProductDocFraming([
    '# Routing Library',
    '',
    '[![Build status](https://example.test/status.svg)](https://example.test/build)',
    '',
    'An HTTP routing library for application developers.',
    '',
    '## High level features',
    '',
    '- Route requests to handlers with a macro-free API.',
    '- Share middleware with applications built on other HTTP libraries.',
    '',
    'This is what sets the library apart from other frameworks.',
    '',
    '## Integrating the Chatbot',
    '',
    'Users can ask natural-language questions about clinic records. Here are some examples of what you could ask:',
    '- Which owners have dogs?',
    '- Are there any vets that specialize in surgery?',
    '',
    '1. Configure a provider API key.',
    '',
    '## In case you find a bug in Routing Library',
    '',
    'Our issue tracker is available online.',
    '',
    '## Usage example',
    '',
    '```rust',
    'use axum::{routing::{get, post}, http::StatusCode, Json, Router};',
    '```',
  ].join('\n'));

  assert.match(framing.summary, /Feature: Route requests to handlers/);
  assert.match(framing.summary, /Feature: Share middleware/);
  assert.match(framing.summary, /Feature: Users can ask natural-language questions/);
  assert.match(framing.summary, /Example: Which owners have dogs/);
  assert.doesNotMatch(framing.summary, /Feature: Which owners have dogs/);
  assert.doesNotMatch(framing.summary, /sets the library apart/);
  assert.doesNotMatch(framing.summary, /Build status|provider API key|issue tracker/);
  assert.doesNotMatch(framing.summary, /StatusCode|Json, Router|get, post/);
});

test('a scoped AI repair attempt cannot outlive its scheduler deadline', async () => {
  const orchestrator = new AnalyzerOrchestrator() as any;
  const startedAt = Date.now();
  await assert.rejects(
    orchestrator.awaitAiBoundedThenUncapped(
      () => new Promise(() => undefined),
      'deadline proof',
      {
        perAttemptTimeoutMs: 10_000,
        maxBoundedAttempts: 1,
        slowWarnMs: 10_000,
        hardDeadlineAt: startedAt + 30,
      },
    ),
    /ai-catalog-hard-deadline-exceeded/,
  );
  assert.ok(Date.now() - startedAt < 500);
});

function rejectedCapabilityOutput(aiEnrichment: CASOutput['ai_enrichment']): CASOutput {
  return {
    ai_enrichment: aiEnrichment,
    enhanced_system_purpose: {
      ai_phase_status: 'degraded',
      inferred_description: 'Patients schedule appointments with available clinicians.',
      description_source: 'ai',
      capability_catalog_coverage: {
        evidence_families: 12,
        published_capabilities: 0,
        status: 'rejected',
        reason: 'catalog omitted required operation obligations',
      },
    },
    analysis_phases: [
      { id: 'agent-context', name: 'Agent context', priority: 2, status: 'partial', purpose: 'agent-development', default_phase: true, description: '', outputs: [], agent_value: '', visualization_value: '', can_run_later: false },
      { id: 'ai-system-narrative', name: 'AI narrative', priority: 3, status: 'complete', purpose: 'ai-enrichment', default_phase: true, description: '', outputs: [], agent_value: '', visualization_value: '', can_run_later: true },
    ],
    analysis_errors: [],
  } as unknown as CASOutput;
}

function assertRejectedCapabilityStatus(output: CASOutput, expectedEnrichment: 'ready' | 'synchronous'): void {
  assert.equal(output.ai_enrichment, expectedEnrichment);
  assert.equal(output.analysis_errors?.length, 1);
  assert.equal(output.analysis_errors?.[0].code, 'CAPABILITY_CATALOG_REJECTED');
  assert.match(output.analysis_errors?.[0].message || '', /omitted required operation obligations/);
  assert.equal(output.analysis_phases?.find(phase => phase.id === 'agent-context')?.status, 'failed');
  assert.equal(output.analysis_phases?.find(phase => phase.id === 'ai-system-narrative')?.status, 'complete');
}

test('synchronous AI settlement records a rejected capability catalog after enrichment status settles', () => {
  const orchestrator = new AnalyzerOrchestrator() as any;
  const output = rejectedCapabilityOutput(undefined);

  orchestrator.settleCapabilityCatalogStatus(output, 'synchronous');
  orchestrator.settleCapabilityCatalogStatus(output, 'synchronous');

  assertRejectedCapabilityStatus(output, 'synchronous');
});

test('deferred AI settlement records a rejected capability catalog only after enrichment completes', async () => {
  const orchestrator = new AnalyzerOrchestrator() as any;
  const output = rejectedCapabilityOutput('pending');
  orchestrator.deferredAiEnrichments.set(output, async () => undefined);

  await orchestrator.enrichAnalysisAI(output);
  await orchestrator.enrichAnalysisAI(output);

  assertRejectedCapabilityStatus(output, 'ready');
});

test('capability merging preserves operations beyond the former 24 and 64 item limits for coverage', () => {
  const operations = Array.from({ length: 65 }, (_, index) => ({
    entry_point_id: `operation-${index}`,
    entry_point_type: 'http',
    action: 'update',
  }));
  const makeCapability = (id: string, selected: SystemCapability['operations']): SystemCapability => ({
    id,
    name: 'Manage records',
    description: 'Users manage records.',
    category: 'core',
    operations: selected,
    related_entities: ['entity_record'],
    related_domains: ['record'],
    criticality: 'high',
    criticality_factors: [],
    evidence_kind: 'behavior-surface',
    evidence_role: 'product-outcome',
  });
  const [merged] = (new AnalyzerOrchestrator() as any).dedupeSystemCapabilitiesByName([
    makeCapability('records-a', operations.slice(0, 40)),
    makeCapability('records-b', operations.slice(40)),
  ], true);

  assert.equal(merged.operations.length, 65);
  assert.equal(merged.operations.at(-1)?.entry_point_id, 'operation-64');

  const coverage = evaluateCapabilityCatalogOperationCoverage(
    [makeCapability('published', merged.operations.slice(0, 64))],
    [merged],
    {
      entryPoints: operations.map(operation => ({
        id: operation.entry_point_id,
        type: 'http',
        name: operation.entry_point_id,
        trigger: { method: 'POST', path: `/records/${operation.entry_point_id}` },
      })) as any,
      nodes: [],
      edges: [],
      exitPoints: [],
    },
    () => true,
  );
  assert.deepEqual(coverage.uncoveredCandidateIds, ['records-a']);
});

test('capability merging keeps one stable id and prefers authored language without losing evidence', () => {
  const operation = { entry_point_id: 'category-create', entry_point_type: 'http', action: 'create' };
  const deterministic: SystemCapability = {
    id: 'category-lifecycle', name: 'Manage categories', description: 'Users can manage categories.',
    name_source: 'deterministic', description_source: 'deterministic',
    category: 'core', operations: [operation], related_entities: ['entity_category'], related_domains: ['category'],
    criticality: 'high', criticality_factors: ['catalog-candidate:cap_categories'],
  };
  const authored: SystemCapability = {
    ...deterministic, name: 'Organize spending categories', description: 'Users create and revise spending categories for their financial records.',
    name_source: 'ai', description_source: 'ai',
    criticality_factors: ['catalog-candidate:cap_categories', 'catalog-description-repair-lifecycle:candidate:cap_categories'],
  };
  const merged = normalizePublishedCapabilityIds([deterministic, authored]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'category-lifecycle');
  assert.equal(merged[0].name, authored.name);
  assert.equal(merged[0].name_source, 'ai');
  assert.deepEqual(merged[0].operations, [operation]);
});

test('capability merging collapses singular and plural read outcomes with shared evidence', () => {
  const firstOperation = { entry_point_id: 'article-list', entry_point_type: 'http', action: 'read' };
  const secondOperation = { entry_point_id: 'article-show', entry_point_type: 'http', action: 'read' };
  const capability = (id: string, name: string, operations: SystemCapability['operations']): SystemCapability => ({
    id,
    name,
    description: 'Users read published articles.',
    name_source: 'ai',
    description_source: 'ai',
    category: 'core',
    operations,
    related_entities: ['entity_article'],
    related_domains: ['article'],
    criticality: 'high',
    criticality_factors: ['catalog-candidate:cap_article_management'],
  });

  const merged = (new AnalyzerOrchestrator() as any).dedupeSystemCapabilitiesByName([
    capability('read-articles', 'Read articles', [firstOperation]),
    capability('read-an-article', 'Read an article', [firstOperation, secondOperation]),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].name, 'Read an article');
  assert.deepEqual(
    merged[0].operations.map((operation: SystemCapability['operations'][number]) => operation.entry_point_id),
    ['article-list', 'article-show'],
  );
});

test('capability merging collapses grammatical action variants but preserves inverse outcomes', () => {
  const operation = { entry_point_id: 'article-favorite', entry_point_type: 'http', action: 'update' };
  const capability = (id: string, name: string): SystemCapability => ({
    id,
    name,
    description: 'Users control whether an article is included in their favorites.',
    name_source: 'ai',
    description_source: 'ai',
    category: 'core',
    operations: [operation],
    related_entities: ['entity_article'],
    related_domains: ['article'],
    criticality: 'high',
    criticality_factors: ['catalog-candidate:cap_article_favorites'],
  });

  const merged = (new AnalyzerOrchestrator() as any).dedupeSystemCapabilitiesByName([
    capability('favorite-an-article', 'Favorite an article'),
    capability('favorite-articles', 'Favorite articles'),
    capability('unfavorite-articles', 'Unfavorite articles'),
  ]);

  assert.equal(merged.length, 2);
  assert.equal(merged.filter((item: SystemCapability) => item.name.startsWith('Favorite')).length, 1);
  assert.equal(merged.filter((item: SystemCapability) => item.name.startsWith('Unfavorite')).length, 1);
});

test('capability merging collapses equivalent comment outcomes with shared evidence', () => {
  const operation = { entry_point_id: 'comment-create', entry_point_type: 'http', action: 'create' };
  const capability = (id: string, name: string): SystemCapability => ({
    id,
    name,
    description: 'Users add comments to published articles.',
    name_source: 'ai',
    description_source: 'ai',
    category: 'core',
    operations: [operation],
    related_entities: ['entity_comment'],
    related_domains: ['article'],
    criticality: 'high',
    criticality_factors: ['catalog-candidate:cap_article_comments'],
  });

  const merged = (new AnalyzerOrchestrator() as any).dedupeSystemCapabilitiesByName([
    capability('post-a-comment', 'Post a comment'),
    capability('create-comments', 'Create comments on articles'),
  ]);

  assert.equal(merged.length, 1);
});

test('capability merging reconciles complementary lifecycle and cross-entity outcome evidence', () => {
  const capability = (
    id: string,
    name: string,
    entity: string,
    operation: SystemCapability['operations'][number],
    factors: string[],
  ): SystemCapability => ({
    id,
    name,
    description: `Users ${name.toLowerCase()}.`,
    name_source: 'ai',
    description_source: 'ai',
    category: 'core',
    operations: [operation],
    related_entities: [entity],
    related_domains: [entity.replace(/^entity_/, '')],
    criticality: 'high',
    criticality_factors: factors,
  });
  const orchestrator = new AnalyzerOrchestrator() as any;
  const notes = orchestrator.dedupeSystemCapabilitiesByName([
    capability(
      'attach-notes',
      'Attach notes to job applications',
      'entity_note',
      { entry_point_id: 'note-update', entry_point_type: 'http', action: 'update' },
      ['catalog-candidate:cap_note_management'],
    ),
    capability(
      'track-notes',
      'Track job application notes',
      'entity_note',
      { entry_point_id: 'note-read', entry_point_type: 'http', action: 'read' },
      ['catalog-candidate:cap_note_management'],
    ),
  ]);
  assert.equal(notes.length, 1);
  assert.deepEqual(new Set(notes[0].operations.map((operation: SystemCapability['operations'][number]) => operation.entry_point_id)), new Set(['note-update', 'note-read']));

  const categories = orchestrator.dedupeSystemCapabilitiesByName([
    capability(
      'organize-categories',
      'Organize job applications by category',
      'entity_category',
      { entry_point_id: 'category-create', entry_point_type: 'http', action: 'create' },
      ['catalog-candidate:cap_category_management'],
    ),
    capability(
      'categorize-jobs',
      'Categorize job applications',
      'entity_job',
      { entry_point_id: 'job-category-update', entry_point_type: 'http', action: 'update' },
      ['catalog-outcome-requirement:all:categorize-jobs', 'catalog-candidate:cap_job_management'],
    ),
  ]);
  assert.equal(categories.length, 1);
  assert.deepEqual(new Set(categories[0].related_entities), new Set(['entity_category', 'entity_job']));
  assert.deepEqual(new Set(categories[0].operations.map((operation: SystemCapability['operations'][number]) => operation.entry_point_id)), new Set(['category-create', 'job-category-update']));
});

test('authored outcomes subsume same-evidence deterministic lifecycle fallbacks across generated ids', () => {
  const operations = [
    { entry_point_id: 'exports-index', entry_point_type: 'http', action: 'read', path_or_command: '/family_exports' },
    { entry_point_id: 'exports-download', entry_point_type: 'http', action: 'read', path_or_command: '/family_exports/:id/download' },
    { entry_point_id: 'exports-create', entry_point_type: 'http', action: 'create', path_or_command: '/family_exports' },
  ];
  const authored: SystemCapability = {
    id: 'capability_export_family_financial_data', name: 'Export family financial data',
    description: 'Families export structured financial records for backup or external analysis.',
    name_source: 'ai', description_source: 'ai', category: 'core', operations,
    related_entities: ['entity_familyexport'], related_domains: ['exports'], criticality: 'high',
    criticality_factors: ['catalog-candidate:cap_family_exports_management'],
  };
  const fallback: SystemCapability = {
    ...authored, id: 'capability_grouped_cap_family_exports_management', name: 'Download family exports',
    description: 'Users can create and view family exports while keeping them current over time.',
    name_source: 'deterministic', description_source: 'deterministic',
    criticality_factors: [
      'catalog-deterministic-grouped-lifecycle',
      'catalog-candidate:cap_family_exports_management',
      'catalog-operation-obligation:operation-obligation:cap_family_exports_management:read',
    ],
  };

  const published = normalizePublishedCapabilityIds([authored, fallback]);

  assert.equal(published.length, 1);
  assert.equal(published[0].name, authored.name);
  assert.equal(published[0].name_source, 'ai');
  assert.ok(published[0].criticality_factors.includes('catalog-operation-obligation:operation-obligation:cap_family_exports_management:read'));
});

test('published capability ids remain unique without merging distinct exact operation obligations', () => {
  const first: SystemCapability = {
    id: 'capability_update_job_status',
    name: 'Update job status',
    description: 'Users update job application status throughout the review process.',
    category: 'supporting',
    operations: [{ entry_point_id: 'status-change', entry_point_type: 'event', action: 'update' }],
    related_entities: ['entity_job'],
    related_domains: [],
    criticality: 'medium',
    criticality_factors: ['catalog-candidate:operation-obligation:first'],
  };
  const second: SystemCapability = {
    ...first,
    operations: [{ entry_point_id: 'status-submit', entry_point_type: 'event', action: 'update' }],
    criticality_factors: ['catalog-candidate:operation-obligation:second'],
  };

  const published = normalizePublishedCapabilityIds([second, first]);

  assert.equal(published.length, 2);
  assert.equal(new Set(published.map((capability: SystemCapability) => capability.id)).size, 2);
  assert.deepEqual(
    published.flatMap((capability: SystemCapability) => capability.criticality_factors).sort(),
    first.criticality_factors.concat(second.criticality_factors).sort(),
  );
});

test('behavior capability generation preserves families beyond the former 16 family limit', async () => {
  const subjects = [
    'invoice', 'payment', 'shipment', 'booking', 'profile', 'account',
    'order', 'claim', 'policy', 'ticket', 'report', 'document',
    'subscription', 'notification', 'inventory', 'schedule', 'approval',
  ];
  const entryPoints = subjects.flatMap(subject =>
    Array.from({ length: 4 }, (_, index) => ({
      id: `${subject}-${index}`,
      type: 'command',
      name: `${subject} command ${index}`,
      source_node: `${subject}-handler-${index}`,
      trigger: { event: `${subject} changed ${index}` },
    })),
  ) as any[];
  const generated = await (new AnalyzerOrchestrator() as any)
    .buildBehaviorCapabilities(entryPoints, [], [], [], '/repo');

  assert.equal(generated.length, subjects.length);
  assert.equal(generated.reduce((total: number, capability: SystemCapability) => total + capability.operations.length, 0), entryPoints.length);

  const required = generated.map((capability: SystemCapability, index: number) => ({
    ...capability,
    id: `family-${index}`,
    evidence_kind: 'behavior-surface' as const,
    evidence_role: 'product-outcome' as const,
  }));
  const coverage = evaluateCapabilityCatalogOperationCoverage(
    [],
    required,
    { entryPoints, nodes: [], edges: [], exitPoints: [] },
    () => true,
  );
  assert.equal(coverage.uncoveredCandidateIds.length, 17);
  assert.ok(coverage.uncoveredCandidateIds.includes('family-16'));
});
