import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasAuthoritativeCapabilityOperationSubjectLineage } from './capability-operation-coverage';
import type { SystemCapability } from '../../types/cas.types';
import { capabilityCatalogRepairEvidenceFacts } from './capability-catalog-scheduling';
import { buildCapabilityOperationObligationViews, classifyCapabilityOperationEffect, evaluateCapabilityCatalogOperationCoverage, fullyCoveredAggregateCapabilityCandidateIds, normalizeCapabilityOperationObligationEvidence, retireFullyCoveredPendingAggregateCapabilities, scopeRequiredCapabilityOperations, uncoveredAggregateOperationObligationIds, uncoveredRequiredBehaviorCandidateIds, uncoveredRequiredCapabilityOperations } from './capability-operation-coverage';
const operation = (id: string, path?: string) => ({ entry_point_id: id, entry_point_type: "event", action: path ? "Manage" : "Handle", ...(path ? { trigger: { method: "POST", path } } : {}) });
const capability = (id: string, operations: SystemCapability['operations'], entities = ['entity_job']): SystemCapability => ({ id, name: id, description: id, category: 'core', operations, related_entities: entities, related_domains: [], criticality: 'high', criticality_factors: [], evidence_kind: 'behavior-surface', evidence_role: 'product-outcome', evidence_examples: [] });
const terminalContext = () => ({
  entryPoints: [{ id: 'click', source_analyzer: 'react', type: 'event', name: 'Card click', source_node: 'component', trigger: { pattern: 'click' }, handler: { node_id: 'component', method_name: 'Card', file: 'ui.ts' }, metadata: { handler_name: 'changeStatus', handler_references: [{ name: 'changeStatus', kind: 'direct', binding_node_id: 'handler' }], handler_binding_node_ids: ['handler'], handler_component_id: 'component', source_analyzer: 'react' } }] as any[],
  nodes: [{ id: 'handler', name: 'changeStatus', type: 'function', source: { file: 'ui.ts', line: 10, end_line: 20 }, metadata: {} }, { id: 'client', name: 'sendStatus', type: 'function', source: { file: 'api.ts', line: 5, end_line: 15 }, metadata: {} }] as any[],
  edges: [{ id: 'call', source: 'handler', target: 'client', type: 'calls' }] as any[],
  exitPoints: [{ id: 'exit', source_node: 'client', type: 'api', name: 'POST status', target: { endpoint: '{param}/status/{param}' }, operation: { method: 'POST', action: 'Update' }, metadata: { sourceFile: 'api.ts', line: 10 } }] as any[],
});
test('accepts an exact React page component as authoritative read lineage without inventing terminal effects', () => { const context = { entryPoints: [{ id: 'statistics-page', source_analyzer: 'react', source_node: 'statistics-component', type: 'page', name: 'Page Statistics', handler: { node_id: 'statistics-component', method_name: 'StatisticsView', file: 'StatisticsView.tsx' }, metadata: { component: 'StatisticsView', trigger_kind: 'page-component', source_analyzer: 'react' } }], nodes: [{ id: 'statistics-component', name: 'StatisticsView', type: 'functional_component', source: { file: 'StatisticsView.tsx', line: 1 }, metadata: {} }], edges: [], exitPoints: [] } as any; const candidate = capability('statistics', [{ entry_point_id: 'statistics-page', entry_point_type: 'page', action: 'View' }], []); const effect = classifyCapabilityOperationEffect(candidate, candidate.operations[0], context); assert.deepEqual(effect.actions, ['read']); assert.deepEqual(effect.subjects, ['statistic']); assert.equal(hasAuthoritativeCapabilityOperationSubjectLineage(candidate, context), true); const forged = { ...context, entryPoints: [{ ...context.entryPoints[0], handler: { ...context.entryPoints[0].handler, node_id: 'other' } }] }; assert.equal(hasAuthoritativeCapabilityOperationSubjectLineage(candidate, forged), false); });
test('requires an event whose resolved handler reaches a terminal outbound effect', () => assert.equal(classifyCapabilityOperationEffect(capability('surface', [operation('click')]), operation('click'), terminalContext()).kind, 'required'));
test('preserves an exact HTTP lifecycle action when reached terminal evidence has no action verb', () => {
  const op = {
    entry_point_id: 'delete-category',
    entry_point_type: 'http',
    action: 'Delete',
    path_or_command: '/categories/:id',
    trigger: { method: 'DELETE', path: '/categories/:id' },
  };
  const context = {
    entryPoints: [{
      id: 'delete-category', type: 'http', name: 'DELETE /categories/:id',
      source_node: 'handler', trigger: { method: 'DELETE', path: '/categories/:id' },
      handler: { node_id: 'handler', method_name: 'destroy', file: 'categories.ts' },
    }],
    nodes: [
      { id: 'handler', name: 'destroy', type: 'method', source: { file: 'categories.ts', line: 1 }, metadata: {} },
      { id: 'repository', name: 'CategoryRepository', type: 'class', source: { file: 'categories.ts', line: 20 }, metadata: {} },
    ],
    edges: [{ id: 'calls-repository', source: 'handler', target: 'repository', type: 'calls' }],
    exitPoints: [{ id: 'write-category', source_node: 'repository', type: 'database', name: 'persist category', target: { resource: 'categories' }, operation: { action: 'persist' } }],
  } as any;
  const candidate = capability('categories', [op as any], ['entity_category']);
  assert.deepEqual(classifyCapabilityOperationEffect(candidate, op as any, context).actions, ['delete']);
});

test('keeps reversible action subresources distinct from generic create and delete', () => {
  const operations = [
    {
      entry_point_id: 'favorite',
      entry_point_type: 'http',
      action: 'Create',
      path_or_command: '/articles/:slug/favorite',
      trigger: { method: 'POST', path: '/articles/:slug/favorite' },
    },
    {
      entry_point_id: 'unfavorite',
      entry_point_type: 'http',
      action: 'Delete',
      path_or_command: '/articles/:slug/favorite',
      trigger: { method: 'DELETE', path: '/articles/:slug/favorite' },
    },
  ] as any;
  const context = {
    entryPoints: operations.map((item: any) => ({
      id: item.entry_point_id, source_node: item.entry_point_id, type: 'http',
      name: item.entry_point_id, interaction_reach: 'external', trigger: item.trigger,
    })),
    nodes: [], edges: [], exitPoints: [],
  } as any;
  const candidate = capability('articles', operations, ['entity_article']);
  assert.deepEqual(operations.map((item: any) => classifyCapabilityOperationEffect(candidate, item, context).actions), [['favorite'], ['unfavorite']]);
});
test('classifies proven local state interaction as support without removing it', () => { const context = { entryPoints: [{ id: 'leave', source_analyzer: 'react', source_node: 'component', type: 'event', name: 'leave', handler: { file: 'ui.ts' }, metadata: { handler_name: 'setOpen', handler_references: [{ name: 'setOpen', kind: 'direct', binding_node_id: 'state' }], handler_binding_node_ids: ['state'], handler_file: 'ui.ts', handler_component_id: 'component', local_handler_kind: 'state-setter', source_analyzer: 'react' } }], nodes: [{ id: 'state', name: '[open, setOpen]', type: 'react_handler_binding', primaryAnalyzer: 'react', parent: 'component', source: { file: 'ui.ts', line: 1 }, metadata: { attributes: { value: 'useState(false)', binding_kind: 'state-setter', binding_names: ['open', 'setOpen'] } } }], edges: [], exitPoints: [] } as any; const candidate = capability('surface', [operation('leave')]); assert.equal(classifyCapabilityOperationEffect(candidate, candidate.operations[0], context).kind, 'support'); assert.equal(candidate.operations.length, 1); });
test('classifies proven child callback wiring as support without removing it', () => { const context = { entryPoints: [{ id: 'close', source_analyzer: 'react', source_node: 'modal', type: 'event', name: 'close', handler: { file: 'modal.ts' }, metadata: { handler_name: 'onClose', handler_references: [{ name: 'onClose', kind: 'direct', binding_node_id: 'close-binding', binding_origin_component_id: 'parent' }], handler_binding_node_ids: ['close-binding'], handler_component_id: 'modal', callback_origin_component_id: 'parent', callback_component_path: ['modal', 'parent'], jsx_element: 'Button', binding_kind: 'component-callback-prop', source_analyzer: 'react' } }], nodes: [{ id: 'parent', name: 'Parent', type: 'functional_component', metadata: {} }, { id: 'modal', name: 'Modal', type: 'functional_component', metadata: {} }, { id: 'close-binding', name: '{ isOpen, onClose }', type: 'react_handler_binding', primaryAnalyzer: 'react', parent: 'parent', source: { file: 'parent.ts', line: 2 }, metadata: { attributes: { value: 'useDisclosure()', binding_kind: 'disclosure-controller', binding_names: ['isOpen', 'onClose'] } } }], edges: [{ id: 'renders', source: 'parent', target: 'modal', type: 'renders' }], exitPoints: [] } as any; assert.equal(classifyCapabilityOperationEffect(capability('surface', [operation('close')]), operation('close'), context).kind, 'support'); });
test('classifies a locally bound disclosure controller action as support', () => { const context = { entryPoints: [{ id: 'open', source_analyzer: 'react', source_node: 'component', type: 'event', name: 'open', handler: { file: 'ui.ts' }, metadata: { handler_name: 'onOpen', handler_references: [{ name: 'onOpen', kind: 'direct', binding_node_id: 'disclosure' }], handler_binding_node_ids: ['disclosure'], handler_file: 'ui.ts', handler_component_id: 'component', local_handler_kind: 'disclosure-controller', jsx_element: 'Button', binding_kind: 'event-handler', source_analyzer: 'react' } }], nodes: [{ id: 'disclosure', name: '{ isOpen, onOpen, onClose }', type: 'react_handler_binding', primaryAnalyzer: 'react', parent: 'component', source: { file: 'ui.ts', line: 4 }, metadata: { attributes: { value: 'useDisclosure()', binding_kind: 'disclosure-controller', binding_names: ['isOpen', 'onOpen', 'onClose'] } } }], edges: [], exitPoints: [] } as any; assert.equal(classifyCapabilityOperationEffect(capability('surface', [operation('open')]), operation('open'), context).kind, 'support'); });
test('classifies an exact member disclosure controller action as support', () => { const context = { entryPoints: [{ id: 'open', source_analyzer: 'react', source_node: 'component', type: 'event', name: 'open', handler: { file: 'ui.tsx' }, metadata: { handler_references: [{ name: 'sidebar.onOpen', kind: 'member', binding_node_id: 'sidebar' }], handler_binding_node_ids: ['sidebar'], handler_file: 'ui.tsx', handler_component_id: 'component', local_handler_kind: 'disclosure-controller', source_analyzer: 'react' } }], nodes: [{ id: 'sidebar', name: 'sidebar', type: 'react_handler_binding', primaryAnalyzer: 'react', parent: 'component', source: { file: 'ui.tsx', line: 4 }, metadata: { attributes: { value: 'useDisclosure()', binding_kind: 'disclosure-controller', binding_names: ['sidebar'] } } }], edges: [], exitPoints: [] } as any; assert.equal(classifyCapabilityOperationEffect(capability('surface', [operation('open')]), operation('open'), context).kind, 'support'); });
test('rejects a forged member name for an exact disclosure binding', () => { const context = { entryPoints: [{ id: 'open', source_analyzer: 'react', source_node: 'component', type: 'event', name: 'open', handler: { file: 'ui.tsx' }, metadata: { handler_references: [{ name: 'forged.onOpen', kind: 'member', binding_node_id: 'sidebar' }], handler_binding_node_ids: ['sidebar'], handler_file: 'ui.tsx', handler_component_id: 'component', local_handler_kind: 'disclosure-controller', source_analyzer: 'react' } }], nodes: [{ id: 'sidebar', name: 'sidebar', type: 'react_handler_binding', primaryAnalyzer: 'react', parent: 'component', source: { file: 'ui.tsx', line: 4 }, metadata: { attributes: { value: 'useDisclosure()', binding_kind: 'disclosure-controller', binding_names: ['sidebar'] } } }], edges: [], exitPoints: [] } as any; assert.equal(classifyCapabilityOperationEffect(capability('surface', [operation('open')]), operation('open'), context).kind, 'required'); });
test('classifies a mixed exact state setter and disclosure member gesture as support', () => {
  const entry = { id: 'prepare-delete', source_analyzer: 'react', source_node: 'component', type: 'event', name: 'Categories click', handler: { file: 'ui.tsx' }, metadata: {
    handler_references: [
      { name: 'setCategoryToDelete', kind: 'inline-callee', binding_node_id: 'category-state' },
      { name: 'deleteCategory.onOpen', kind: 'inline-callee', binding_node_id: 'delete-dialog' },
    ], handler_binding_node_ids: ['category-state', 'delete-dialog'], handler_file: 'ui.tsx', handler_component_id: 'component', source_analyzer: 'react',
  } } as any;
  const nodes = [
    { id: 'category-state', name: '{ categoryToDelete, setCategoryToDelete }', type: 'react_handler_binding', primaryAnalyzer: 'react', parent: 'component', source: { file: 'ui.tsx', line: 4 }, metadata: { attributes: { value: "useState<string>('')", binding_kind: 'state-setter', binding_names: ['categoryToDelete', 'setCategoryToDelete'] } } },
    { id: 'delete-dialog', name: 'deleteCategory', type: 'react_handler_binding', primaryAnalyzer: 'react', parent: 'component', source: { file: 'ui.tsx', line: 5 }, metadata: { attributes: { value: 'useDisclosure()', binding_kind: 'disclosure-controller', binding_names: ['deleteCategory'] } } },
  ] as any[];
  const context = { entryPoints: [entry], nodes, edges: [], exitPoints: [] } as any;
  assert.equal(classifyCapabilityOperationEffect(capability('surface', [operation('prepare-delete')]), operation('prepare-delete'), context).kind, 'support');
});
test('rejects a member disclosure binding from another file', () => { const context = { entryPoints: [{ id: 'open', source_analyzer: 'react', source_node: 'component', type: 'event', name: 'open', handler: { file: 'ui.tsx' }, metadata: { handler_references: [{ name: 'sidebar.onOpen', kind: 'member', binding_node_id: 'sidebar' }], handler_binding_node_ids: ['sidebar'], handler_file: 'ui.tsx', handler_component_id: 'component', local_handler_kind: 'disclosure-controller', source_analyzer: 'react' } }], nodes: [{ id: 'sidebar', name: 'sidebar', type: 'react_handler_binding', primaryAnalyzer: 'react', parent: 'component', source: { file: 'other.tsx', line: 4 }, metadata: { attributes: { value: 'useDisclosure()', binding_kind: 'disclosure-controller', binding_names: ['sidebar'] } } }], edges: [], exitPoints: [] } as any; assert.equal(classifyCapabilityOperationEffect(capability('surface', [operation('open')]), operation('open'), context).kind, 'required'); });
test('does not treat an unproven similarly named handler as local disclosure support', () => { const context = { entryPoints: [{ id: 'open', source_analyzer: 'react', source_node: 'component', type: 'event', name: 'open', handler: { file: 'ui.ts' }, metadata: { handler_name: 'onOpen', handler_references: [{ name: 'onOpen', kind: 'direct' }], handler_binding_node_ids: [], jsx_element: 'Button', binding_kind: 'event-handler', source_analyzer: 'react' } }], nodes: [], edges: [], exitPoints: [] } as any; assert.equal(classifyCapabilityOperationEffect(capability('surface', [operation('open')]), operation('open'), context).kind, 'required'); });
test('keeps a disclosure-named handler required when it resolves to a terminal path', () => { const context = terminalContext() as any; context.entryPoints[0].metadata.handler_name = 'onOpen'; context.nodes[0].name = 'onOpen'; context.nodes.push({ id: 'disclosure', name: '{ isOpen, onOpen, onClose }', type: 'react_handler_binding', primaryAnalyzer: 'react', parent: 'component', source: { file: 'ui.ts', line: 4 }, metadata: { attributes: { value: 'useDisclosure()', binding_kind: 'disclosure-controller', binding_names: ['isOpen', 'onOpen', 'onClose'] } } }); assert.equal(classifyCapabilityOperationEffect(capability('surface', [operation('click')]), operation('click'), context).kind, 'required'); });
test('defaults an unresolved operation to required', () => { const context = { entryPoints: [], nodes: [], edges: [], exitPoints: [] } as any; assert.equal(classifyCapabilityOperationEffect(capability('surface', [operation('unknown')]), operation('unknown'), context).kind, 'required'); });
test('covers a client operation through the same method, entity, and terminal endpoint lineage', () => assert.deepEqual(uncoveredRequiredCapabilityOperations(capability('surface', [operation('click')]), [capability('Manage job status', [operation('route', '/job/status/:jobId')])], terminalContext()), []));
test('does not cover a same-suffix endpoint on an unrelated resource', () => assert.deepEqual(uncoveredRequiredCapabilityOperations(capability('surface', [operation('click')]), [capability('manage-account', [operation('route', '/account/status/:accountId')], ['entity_job'])], terminalContext()).map(item => item.entryPointId), ['click']));
test("does not cover a terminal mutation through a read-only capability title", () => assert.deepEqual(uncoveredRequiredCapabilityOperations(capability("surface", [operation("click")]), [capability("Filter job status", [operation("route", "/job/status/:jobId")])], terminalContext()).map(item => item.entryPointId), ["click"]));
test('does not cover an exact entry point through an incompatible action', () => assert.deepEqual(uncoveredRequiredCapabilityOperations(capability('surface', [operation('click')]), [capability('Filter job status', [operation('click')])], terminalContext()).map(item => item.entryPointId), ['click']));
test('covers an exact entry point only with a compatible action and subject', () => assert.deepEqual(uncoveredRequiredCapabilityOperations(capability('surface', [operation('click')]), [capability('Manage job status', [operation('click')])], terminalContext()), []));
test('does not cover an exact entry point through an unrelated subject', () => assert.deepEqual(uncoveredRequiredCapabilityOperations(capability('surface', [operation('click')]), [capability('Manage account status', [operation('click')], ['entity_account'])], terminalContext()).map(item => item.entryPointId), ['click']));
test('does not cover an exact entry point through an actionless title', () => assert.deepEqual(uncoveredRequiredCapabilityOperations(capability('surface', [operation('click')]), [capability('Job status', [operation('click')])], terminalContext()).map(item => item.entryPointId), ['click']));
test('does not cover matching terminal lineage through an actionless title', () => assert.deepEqual(uncoveredRequiredCapabilityOperations(capability('surface', [operation('click')]), [capability('Job status', [operation('route', '/job/status/:jobId')])], terminalContext()).map(item => item.entryPointId), ['click']));
test('requires a distinct read outcome for a terminal list route while excluding its local disclosure operation', () => {
  const context = {
    entryPoints: [
      { id: 'list-route', type: 'http', name: 'POST /jobs/:userId', handler: { file: 'routes/job.js', method_name: 'getJobs' }, trigger: { method: 'POST', path: '/jobs/:userId' }, metadata: {} },
      { id: 'open-modal', source_analyzer: 'react', type: 'event', name: 'Jobs click', handler: { file: 'ui.ts' }, metadata: { handler_name: 'onOpen', handler_references: [{ name: 'onOpen', kind: 'direct', binding_node_id: 'disclosure' }], handler_binding_node_ids: ['disclosure'], handler_file: 'ui.ts', handler_component_id: 'component', local_handler_kind: 'disclosure-controller', jsx_element: 'Button', binding_kind: 'event-handler', source_analyzer: 'react' } },
    ],
    nodes: [{ id: 'disclosure', name: '{ isOpen, onOpen, onClose }', type: 'react_handler_binding', primaryAnalyzer: 'react', parent: 'component', source: { file: 'ui.ts', line: 4 }, metadata: { attributes: { value: 'useDisclosure()', binding_kind: 'disclosure-controller', binding_names: ['isOpen', 'onOpen', 'onClose'] } } }],
    edges: [], exitPoints: [],
  } as any;
  const readOperation = { ...operation('list-route', '/jobs/:userId'), action: 'Read' };
  const mixed = capability('jobs', [readOperation, operation('open-modal')]);
  assert.deepEqual(uncoveredRequiredCapabilityOperations(mixed, [capability('Automatically close job applications', [operation('list-route', '/jobs/:userId')])], context).map(item => item.entryPointId), ['list-route']);
  assert.deepEqual(uncoveredRequiredCapabilityOperations(mixed, [capability('List job applications', [operation('list-route', '/jobs/:userId')])], context), []);
});
test('keeps partial terminal operation coverage uncovered', () => assert.deepEqual(uncoveredRequiredCapabilityOperations(capability('surface', [operation('click'), operation('unknown')]), [capability('Manage job status', [operation('route', '/job/status/:jobId')])], terminalContext()).map(item => item.entryPointId), ['unknown']));
test('todo-style mixed surface requires only terminal click while retaining support operations', () => { const context = terminalContext() as any; context.entryPoints.push({ id: 'leave', source_analyzer: 'react', source_node: 'component', type: 'event', name: 'leave', handler: { file: 'ui.ts' }, metadata: { handler_name: 'setOpen', handler_references: [{ name: 'setOpen', kind: 'direct', binding_node_id: 'state' }], handler_binding_node_ids: ['state'], handler_file: 'ui.ts', handler_component_id: 'component', local_handler_kind: 'state-setter', source_analyzer: 'react' } }, { id: 'close', source_analyzer: 'react', source_node: 'modal', type: 'event', name: 'close', handler: { file: 'modal.ts' }, metadata: { handler_name: 'onClose', handler_references: [{ name: 'onClose', kind: 'direct', binding_node_id: 'close-binding', binding_origin_component_id: 'component' }], handler_binding_node_ids: ['close-binding'], handler_component_id: 'modal', callback_origin_component_id: 'component', callback_component_path: ['modal', 'component'], jsx_element: 'Button', binding_kind: 'component-callback-prop', source_analyzer: 'react' } }); context.nodes.push({ id: 'component', name: 'Parent', type: 'functional_component', metadata: {} }, { id: 'state', name: '[open, setOpen]', type: 'react_handler_binding', primaryAnalyzer: 'react', parent: 'component', source: { file: 'ui.ts', line: 1 }, metadata: { attributes: { value: 'useState(false)', binding_kind: 'state-setter', binding_names: ['open', 'setOpen'] } } }, { id: 'modal', name: 'Modal', type: 'functional_component', metadata: {} }, { id: 'close-binding', name: '{ isOpen, onClose }', type: 'react_handler_binding', primaryAnalyzer: 'react', parent: 'component', source: { file: 'ui.ts', line: 2 }, metadata: { attributes: { value: 'useDisclosure()', binding_kind: 'disclosure-controller', binding_names: ['isOpen', 'onClose'] } } }); context.edges.push({ id: 'renders', source: 'component', target: 'modal', type: 'renders' }); const mixed = capability('surface', [operation('click'), operation('leave'), operation('close')]); assert.equal(mixed.operations.length, 3); assert.deepEqual(uncoveredRequiredCapabilityOperations(mixed, [capability('Manage job status', [operation('route', '/job/status/:jobId')])], context), []); });
test('status lifecycle remains uncovered with filtering alone and is covered when management is published', () => {
  const surface = capability('status-surface', [operation('click')]);
  const filtering = capability('Filter job applications by status', [operation('filter-route', '/job/status/:jobId')]);
  const management = { ...capability('Manage application status', [operation('manage-route', '/job/status/:jobId')]), criticality_factors: ['catalog-candidate:status-surface'] };
  assert.deepEqual(uncoveredRequiredCapabilityOperations(surface, [filtering], terminalContext()).map(item => item.entryPointId), ['click']);
  assert.deepEqual(uncoveredRequiredCapabilityOperations(surface, [filtering, management], terminalContext()), []);
});
test('requires every action cluster reached by one terminal operation', () => {
  const context = terminalContext() as any;
  context.entryPoints[0].metadata.handler_name = 'createJob';
  context.entryPoints[0].handler.method_name = 'createJob';
  context.nodes[0].name = 'createJob';
  context.exitPoints[0].operation.action = 'Create';
  context.exitPoints.push({ id: 'delete-exit', source_node: 'client', type: 'api', name: 'DELETE job', target: { endpoint: '{param}/status/{param}' }, operation: { method: 'POST', action: 'delete' }, metadata: { sourceFile: 'api.ts', line: 11 } });
  const surface = capability('job-lifecycle', [operation('click')]);
  const createOnly = capability('Create job status', [operation('click')]);
  const remove = capability('Remove job status', [operation('click')]);
  assert.deepEqual(uncoveredRequiredCapabilityOperations(surface, [createOnly], context).map(item => item.entryPointId), ['click']);
  assert.deepEqual(uncoveredRequiredCapabilityOperations(surface, [createOnly, remove], context), []);
});
test('derives subjects per operation instead of leaking candidate-wide entities', () => {
  const context = {
    entryPoints: [
      { id: 'jobs', type: 'http', name: 'GET /jobs', handler: { file: 'routes.ts', method_name: 'getJobs' }, trigger: { method: 'GET', path: '/jobs' }, metadata: {} },
      { id: 'notes', type: 'http', name: 'GET /notes', handler: { file: 'routes.ts', method_name: 'getNotes' }, trigger: { method: 'GET', path: '/notes' }, metadata: {} },
    ], nodes: [], edges: [], exitPoints: [],
  } as any;
  const mixed = capability('mixed', [
    { ...operation('jobs', '/jobs'), action: 'Read' },
    { ...operation('notes', '/notes'), action: 'Read' },
  ], ['entity_job', 'entity_note']);
  const jobs = capability('List jobs', [{ ...operation('jobs', '/jobs'), action: 'Read' }], ['entity_job']);
  assert.deepEqual(uncoveredRequiredCapabilityOperations(mixed, [jobs], context).map(item => item.entryPointId), ['notes']);
});

const coupledLifecycleContext = () => ({
  entryPoints: [
    { id: 'lifecycle', type: 'event', name: 'Manage lifecycle', handler: { file: 'ui.ts', method_name: 'runLifecycle' }, metadata: { handler_name: 'runLifecycle' } },
    { id: 'create-job', type: 'http', name: 'Create job', trigger: { method: 'POST', path: '/jobs' }, metadata: {} },
    { id: 'delete-note', type: 'http', name: 'Delete note', trigger: { method: 'DELETE', path: '/notes' }, metadata: {} },
    { id: 'create-note', type: 'http', name: 'Create note', trigger: { method: 'POST', path: '/jobs' }, metadata: {} },
    { id: 'delete-job', type: 'http', name: 'Delete job', trigger: { method: 'DELETE', path: '/notes' }, metadata: {} },
  ],
  nodes: [
    { id: 'handler', name: 'runLifecycle', type: 'function', source: { file: 'ui.ts', line: 1, end_line: 10 }, metadata: {} },
    { id: 'job-client', name: 'createJob', type: 'function', source: { file: 'job.ts', line: 1, end_line: 10 }, metadata: {} },
    { id: 'note-client', name: 'deleteNote', type: 'function', source: { file: 'note.ts', line: 1, end_line: 10 }, metadata: {} },
  ],
  edges: [
    { id: 'job-call', source: 'handler', target: 'job-client', type: 'calls' },
    { id: 'note-call', source: 'handler', target: 'note-client', type: 'calls' },
  ],
  exitPoints: [
    { id: 'job-exit', source_node: 'job-client', type: 'api', name: 'Create job', target: { endpoint: '/jobs' }, operation: { method: 'POST', action: 'Create' }, metadata: {} },
    { id: 'note-exit', source_node: 'note-client', type: 'api', name: 'Delete note', target: { endpoint: '/notes' }, operation: { method: 'DELETE', action: 'Delete' }, metadata: {} },
  ],
} as any);

test('does not cross-cover coupled action and subject obligations', () => {
  const required = capability('lifecycle', [{ ...operation('lifecycle'), action: 'Manage' }], ['entity_job', 'entity_note']);
  const createNote = capability('Create notes', [{ ...operation('create-note', '/jobs'), action: 'Create' }], ['entity_note']);
  const deleteJob = capability('Delete jobs', [{ ...operation('delete-job', '/notes'), action: 'Delete' }], ['entity_job']);
  assert.deepEqual(uncoveredRequiredCapabilityOperations(required, [createNote, deleteJob], coupledLifecycleContext()).map(item => item.entryPointId), ['lifecycle']);
});

test('a grouped Manage outcome covers each CRUD obligation only through exact terminal evidence', () => {
  const required = capability('lifecycle', [{ ...operation('lifecycle'), action: 'Manage' }], ['entity_job', 'entity_note']);
  const grouped = capability('Manage job and note lifecycle', [
    { ...operation('create-job', '/jobs'), action: 'Create' },
    { ...operation('delete-note', '/notes'), action: 'Delete', trigger: { method: 'DELETE', path: '/notes' } },
  ], ['entity_job', 'entity_note']);
  const partial = capability('Manage job and note lifecycle', [
    { ...operation('create-job', '/jobs'), action: 'Create' },
  ], ['entity_job', 'entity_note']);
  const context = coupledLifecycleContext();
  assert.deepEqual(uncoveredRequiredCapabilityOperations(required, [grouped], context), []);
  assert.deepEqual(uncoveredRequiredCapabilityOperations(required, [partial], context).map(item => item.entryPointId), ['lifecycle']);
});

test('does not fall back from a React event without an exact handler to the owning component', () => {
  const context = {
    entryPoints: [{ id: 'change', source_analyzer: 'react', source_node: 'component', type: 'event', name: 'Categories change', handler: { node_id: 'component', method_name: 'Categories', file: 'ui.ts' }, metadata: { source_analyzer: 'react', handler_references: [], handler_binding_node_ids: [] } }],
    nodes: [{ id: 'component', name: 'Categories', type: 'functional_component', source: { file: 'ui.ts', line: 1, end_line: 100 }, metadata: {} }],
    edges: [],
    exitPoints: [{ id: 'unrelated', source_node: 'component', type: 'api', name: 'Create category', target: { endpoint: '/categories' }, operation: { method: 'POST', action: 'Create' }, metadata: {} }],
  } as any;
  const effect = classifyCapabilityOperationEffect(capability('categories', [operation('change')], ['entity_category']), operation('change'), context);
  assert.equal(effect.kind, 'required');
  assert.deepEqual(effect.signatures, []);
  assert.deepEqual(effect.actions, ['update']);
});

test('attributes terminal exits only through the exact React handler binding lineage', () => {
  const context = {
    entryPoints: [{ id: 'submit', source_analyzer: 'react', source_node: 'component', type: 'event', name: 'Notes submit', handler: { file: 'notes.tsx' }, metadata: { source_analyzer: 'react', handler_references: [{ name: 'addNote', kind: 'direct', binding_node_id: 'add' }], handler_binding_node_ids: ['add'] } }],
    nodes: [{ id: 'add', name: 'addNote', type: 'function', source: { file: 'notes.tsx', line: 10, end_line: 20 }, metadata: {} }, { id: 'remove', name: 'deleteNote', type: 'function', source: { file: 'notes.tsx', line: 30, end_line: 40 }, metadata: {} }],
    edges: [],
    exitPoints: [{ id: 'add-exit', source_node: 'add', type: 'api', name: 'Create note', target: { endpoint: '/notes' }, operation: { method: 'POST', action: 'Create' }, metadata: {} }, { id: 'delete-exit', source_node: 'remove', type: 'api', name: 'Delete note', target: { endpoint: '/notes' }, operation: { method: 'DELETE', action: 'Delete' }, metadata: {} }],
  } as any;
  const effect = classifyCapabilityOperationEffect(capability('notes', [operation('submit')], ['entity_note']), operation('submit'), context);
  assert.deepEqual(effect.actions, ['create']);
  assert.equal(effect.terminalObligations.length, 1);
});

test('uses a route handler read action instead of unioning a coarse POST create action', () => {
  const op = { entry_point_id: 'jobs', entry_point_type: 'http', action: 'Create', trigger: { method: 'POST', path: '/job/jobs/:userId' } } as any;
  const context = { entryPoints: [{ id: 'jobs', type: 'http', name: 'POST jobs', trigger: { method: 'POST', path: '/job/jobs/:userId' }, handler: { method_name: 'getJobs', file: 'routes.js' }, metadata: {} }], nodes: [], edges: [], exitPoints: [] } as any;
  const effect = classifyCapabilityOperationEffect(capability('jobs', [op]), op, context);
  assert.deepEqual(effect.actions, ['read']);
  assert.deepEqual(effect.signatures, ['POST|job/jobs|entity_job']);
});

test('uses terminal-effect actions without unioning the surface action', () => {
  const context = terminalContext() as any;
  const op = { ...operation('click'), action: 'Create' };
  const effect = classifyCapabilityOperationEffect(capability('status', [op]), op, context);
  assert.deepEqual(effect.actions, ['update']);
});

test('keeps an unresolved React event required even when its name resembles local UI state', () => {
  const context = { entryPoints: [{ id: 'active', source_analyzer: 'react', type: 'event', name: 'set active', metadata: { source_analyzer: 'react', handler_references: [{ name: 'setActiveSite', kind: 'inline-callee' }], handler_binding_node_ids: [] } }], nodes: [], edges: [], exitPoints: [] } as any;
  assert.equal(classifyCapabilityOperationEffect(capability('sites', [operation('active')]), operation('active'), context).kind, 'required');
});

test('rejects forged state support metadata that points at a non-hook declaration', () => {
  const context = {
    entryPoints: [{ id: 'active', source_analyzer: 'react', type: 'event', name: 'active', metadata: {
      source_analyzer: 'react',
      handler_file: 'ui.tsx',
      handler_references: [{ name: 'setActive', kind: 'inline-callee', binding_node_id: 'forged' }],
      handler_binding_node_ids: ['forged'],
      local_handler_kind: 'state-setter'
    } }],
    nodes: [{ id: 'forged', name: 'setActive', type: 'function', source: { file: 'ui.tsx', line: 8 }, metadata: { value: 'saveToDatabase()' } }],
    edges: [],
    exitPoints: []
  } as any;
  assert.equal(classifyCapabilityOperationEffect(capability('surface', [operation('active')]), operation('active'), context).kind, 'required');
});

test('rejects an exact hook-shaped binding from a different file', () => {
  const context = {
    entryPoints: [{ id: 'active', source_analyzer: 'react', type: 'event', name: 'active', metadata: {
      source_analyzer: 'react',
      handler_file: 'ui.tsx',
      handler_references: [{ name: 'setActive', kind: 'inline-callee', binding_node_id: 'other-state' }],
      handler_binding_node_ids: ['other-state'],
      local_handler_kind: 'state-setter'
    } }],
    nodes: [{ id: 'other-state', name: '[active, setActive]', type: 'variable', source: { file: 'other.tsx', line: 8 }, metadata: { value: 'useState(false)' } }],
    edges: [],
    exitPoints: []
  } as any;
  assert.equal(classifyCapabilityOperationEffect(capability('surface', [operation('active')]), operation('active'), context).kind, 'required');
});


test('scopes mixed candidates to genuine operations and excludes proven local-only support from coverage', () => {
  const context = {
    entryPoints: [
      { id: 'list', type: 'http', name: 'POST /items', trigger: { method: 'POST', path: '/items' }, handler: { method_name: 'getItems', file: 'routes.ts' }, metadata: {} },
      { id: 'open', source_analyzer: 'react', source_node: 'panel', type: 'event', name: 'Panel click', metadata: { source_analyzer: 'react', handler_file: 'panel.tsx', handler_component_id: 'panel', handler_references: [{ name: 'onOpen', binding_node_id: 'disclosure' }], handler_binding_node_ids: ['disclosure'], local_handler_kind: 'disclosure-controller' } },
    ],
    nodes: [{ id: 'disclosure', name: '{ isOpen, onOpen }', type: 'react_handler_binding', primaryAnalyzer: 'react', parent: 'panel', source: { file: 'panel.tsx', line: 2 }, metadata: { attributes: { value: 'useDisclosure()', binding_kind: 'disclosure-controller', binding_names: ['isOpen', 'onOpen'] } } }],
    edges: [], exitPoints: [],
  } as any;
  const mixed = capability('items', [{ ...operation('list', '/items'), action: 'Create' }, operation('open')], ['entity_item']);
  const support = capability('panel', [operation('open')], ['entity_item']);
  const [scopedMixed, scopedSupport] = scopeRequiredCapabilityOperations([mixed, support], context);
  assert.deepEqual(scopedMixed.operations.map(item => [item.entry_point_id, item.action]), [['list', 'read']]);
  assert.match(scopedMixed.name, /^read item$/);
  assert.deepEqual(scopedSupport.operations, []);
  assert.equal(scopedSupport.evidence_role, 'supporting-mechanism');
});

test('terminal endpoint semantics override a coarse POST action', () => {
  const context = {
    entryPoints: [{ id: 'edit', type: 'event', name: 'Form submit', metadata: { handler_name: 'saveCategory' } }],
    nodes: [{ id: 'save', name: 'saveCategory', type: 'function', source: { file: 'form.ts', line: 1 }, metadata: {} }],
    edges: [],
    exitPoints: [{ id: 'edit-exit', source_node: 'save', type: 'api', name: 'POST category', target: { endpoint: '/edit-category/:id' }, operation: { method: 'POST', action: 'post' }, metadata: {} }],
  } as any;
  context.entryPoints[0].handler = { node_id: 'save', method_name: 'saveCategory', file: 'form.ts' };
  const candidate = capability('categories', [{ ...operation('edit'), action: 'Create' }], ['entity_category']);
  const effect = classifyCapabilityOperationEffect(candidate, candidate.operations[0], context);
  assert.deepEqual(effect.actions, ['update']);
  assert.deepEqual(scopeRequiredCapabilityOperations([candidate], context)[0].operations.map(item => item.action), ['update']);
});

test('scoped evidence distinguishes category reading and editing from job and site reading', () => {
  const context = {
    entryPoints: [
      { id: 'categories', type: 'http', name: 'GET categories', trigger: { method: 'GET', path: '/categories/:userId' }, handler: { method_name: 'getCategories', file: 'routes.ts' }, metadata: {} },
      { id: 'edit-category', type: 'event', name: 'Categories submit', handler: { node_id: 'edit-handler', method_name: 'editCategory', file: 'ui.tsx' }, metadata: { handler_name: 'editCategory' } },
      { id: 'jobs', type: 'http', name: 'POST jobs', trigger: { method: 'POST', path: '/jobs/:userId' }, handler: { method_name: 'getJobs', file: 'routes.ts' }, metadata: {} },
      { id: 'sites', type: 'http', name: 'GET job sites', trigger: { method: 'GET', path: '/job-sites/:userId' }, handler: { method_name: 'getJobSites', file: 'routes.ts' }, metadata: {} },
    ],
    nodes: [{ id: 'edit-handler', name: 'editCategory', type: 'function', source: { file: 'ui.tsx', line: 1 }, metadata: {} }],
    edges: [],
    exitPoints: [{ id: 'category-exit', source_node: 'edit-handler', type: 'api', name: 'POST category', target: { endpoint: '/edit-category/:id' }, operation: { method: 'POST', action: 'post' }, metadata: {} }],
  } as any;
  const candidates = [
    capability('categories', [{ ...operation('categories', '/categories/:userId'), action: 'Read' }, operation('edit-category')], ['entity_category', 'entity_user']),
    capability('jobs', [{ ...operation('jobs', '/jobs/:userId'), action: 'Create' }], ['entity_job', 'entity_user']),
    capability('sites', [{ ...operation('sites', '/job-sites/:userId'), action: 'Read' }], ['entity_job', 'entity_user']),
  ];
  const scoped = scopeRequiredCapabilityOperations(candidates, context);
  assert.match(scoped[0].name, /read and update category/);
  assert.equal(scoped[1].name, 'read job');
  assert.match(scoped[2].name, /^read .*site/);
  assert.equal(new Set(scoped.map(item => item.name)).size, 3);
});

test('requires a forged local support chain without its exact AST-derived edge', () => {
  const context = {
    entryPoints: [{ id: 'change', source_analyzer: 'react', source_node: 'form', type: 'event', name: 'Form change', metadata: {
      source_analyzer: 'react', handler_file: 'form.tsx', handler_component_id: 'form',
      handler_references: [{ name: 'handleChange', binding_node_id: 'handler' }], handler_binding_node_ids: ['handler'],
      local_handler_kind: 'state-setter', local_support_callee_names: ['setDraft'], local_support_binding_node_ids: ['state'],
    } }],
    nodes: [
      { id: 'handler', name: 'handleChange', type: 'function', source: { file: 'form.tsx', line: 5 }, metadata: {} },
      { id: 'state', name: '[draft, setDraft]', type: 'react_handler_binding', primaryAnalyzer: 'react', parent: 'form', source: { file: 'form.tsx', line: 2 }, metadata: { attributes: { value: 'useState({})', binding_kind: 'state-setter', binding_names: ['draft', 'setDraft'] } } },
    ],
    edges: [], exitPoints: [],
  } as any;
  assert.equal(classifyCapabilityOperationEffect(capability('form', [operation('change')]), operation('change'), context).kind, 'required');
  context.edges.push({ id: 'state-call', source: 'handler', target: 'state', type: 'calls' });
  assert.equal(classifyCapabilityOperationEffect(capability('form', [operation('change')]), operation('change'), context).kind, 'support');
});

test('does not expose unbound browser-control callees as capability subjects', () => {
  const context = terminalContext() as any;
  context.entryPoints[0].metadata.handler_references.unshift({ name: 'preventDefault', kind: 'inline-callee' });
  const candidate = capability('notes', [operation('click')], ['entity_note']);
  const scoped = scopeRequiredCapabilityOperations([candidate], context)[0];
  assert.equal(scoped.name, 'update note');
  assert.doesNotMatch(scoped.name, /prevent|default/);
});

test('allows a grounded exact-candidate citation to cover the same entry without a literal CRUD title verb', () => {
  const required = capability('categories', [operation('click')]);
  const published = { ...capability('Categorize job applications', [operation('click')]), criticality_factors: ['catalog-candidate:categories'] };
  assert.deepEqual(uncoveredRequiredCapabilityOperations(required, [published], terminalContext()), []);
  published.criticality_factors = [];
  assert.deepEqual(uncoveredRequiredCapabilityOperations(required, [published], terminalContext()).map(item => item.entryPointId), ['click']);
});

test('attributes a file-owned terminal exit to the unique smallest reachable callable and ignores an upstream hook exit', () => {
  const context = {
    entryPoints: [{ id: 'submit', source_analyzer: 'react', type: 'event', name: 'Submit', metadata: { source_analyzer: 'react', handler_references: [{ name: 'save', binding_node_id: 'save' }], handler_binding_node_ids: ['save'] } }],
    nodes: [
      { id: 'save', name: 'save', type: 'function', source: { file: 'form.tsx', line: 10, end_line: 30 }, metadata: {} },
      { id: 'client', name: 'editRecord', type: 'function', source: { file: 'api.ts', line: 5, end_line: 15 }, metadata: {} },
      { id: 'api-file', name: 'api.ts', type: 'file', source: { file: 'api.ts', line: 1, end_line: 100 }, metadata: {} },
    ],
    edges: [{ id: 'call', source: 'save', target: 'client', type: 'calls' }],
    exitPoints: [
      { id: 'hook', source_node: 'save', type: 'sdk', name: 'useState', target: { endpoint: 'useState' }, operation: { action: 'useState' }, metadata: {} },
      { id: 'file-http', source_node: 'api-file', type: 'api', name: 'POST edit record', target: { endpoint: '/edit-record/:id' }, operation: { method: 'POST', action: 'post' }, metadata: { sourceFile: 'api.ts', line: 10 } },
    ],
  } as any;
  const effect = classifyCapabilityOperationEffect(capability('records', [operation('submit')], ['entity_record']), operation('submit'), context);
  assert.deepEqual(effect.actions, ['update']);
  assert.deepEqual(effect.subjects, ['record']);
});

test('preserves reference terminal attribution, ordering, and downstream tie-breaking', () => {
  const context = {
    entryPoints: [{ id: 'submit', source_analyzer: 'react', type: 'event', name: 'Submit', metadata: {
      source_analyzer: 'react', handler_references: [{ name: 'save', binding_node_id: 'save' }], handler_binding_node_ids: ['save'],
    } }],
    nodes: [
      { id: 'save', name: 'save', type: 'function', source: { file: 'form.tsx', line: 10, end_line: 30 }, metadata: {} },
      { id: 'client', name: 'editRecord', type: 'function', source: { file: 'api.ts', line: 5, end_line: 20 }, metadata: {} },
      { id: 'nested', name: 'removeRecord', type: 'function', source: { file: 'api.ts', line: 8, end_line: 12 }, metadata: {} },
      { id: 'api-file', name: 'api.ts', type: 'file', source: { file: 'api.ts', line: 1, end_line: 100 }, metadata: {} },
    ],
    edges: [
      { id: 'call-client', source: 'save', target: 'client', type: 'calls' },
      { id: 'call-nested', source: 'client', target: 'nested', type: 'calls' },
    ],
    exitPoints: [
      { id: 'upstream', source_node: 'client', type: 'api', name: 'POST edit record', target: { endpoint: '/edit-record/:id' }, operation: { method: 'POST', action: 'post' }, metadata: {} },
      { id: 'file-owned', source_node: 'api-file', type: 'api', name: 'DELETE record', target: { endpoint: '/record/:id' }, operation: { method: 'DELETE', action: 'delete' }, metadata: { sourceFile: 'api.ts', line: 10 } },
    ],
  } as any;
  const effect = classifyCapabilityOperationEffect(capability('records', [operation('submit')], ['entity_record']), operation('submit'), context);
  assert.deepEqual(effect, {
    entryPointId: 'submit',
    kind: 'required',
    actions: ['delete'],
    signatures: ['DELETE|record|entity_record'],
    subjects: ['record'],
    terminalObligations: [{ actions: ['delete'], signatures: ['DELETE|record|entity_record'], subjects: ['record'], outcomeLabels: [] }],
  });
});

test('builds immutable context indexes once and reuses exact scope results without global rescans', () => {
  const base = terminalContext() as any;
  const scans = { nodes: 0, edges: 0, entries: 0, exits: 0 };
  const counted = <T>(values: T[], key: keyof typeof scans): T[] => new Proxy(values, {
    get(target, property, receiver) {
      if (property === Symbol.iterator) scans[key] += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const context = {
    nodes: counted(base.nodes, 'nodes'),
    edges: counted(base.edges, 'edges'),
    entryPoints: counted(base.entryPoints, 'entries'),
    exitPoints: counted(base.exitPoints, 'exits'),
  } as any;
  const candidate = capability('surface', [operation('click')]);
  assert.equal(classifyCapabilityOperationEffect(candidate, operation('click'), context).kind, 'required');
  scans.nodes = scans.edges = scans.entries = scans.exits = 0;
  for (let index = 0; index < 100; index += 1) {
    assert.equal(classifyCapabilityOperationEffect(candidate, operation('click'), context).kind, 'required');
  }
  assert.deepEqual(scans, { nodes: 0, edges: 0, entries: 0, exits: 0 });
});

test('attributes terminal effects beyond 256 reachable nodes without truncating the graph', () => {
  const chainLength = 320;
  const nodes = Array.from({ length: chainLength }, (_, index) => ({
    id: 'call-' + index,
    name: index === chainLength - 1 ? 'deleteRecord' : 'step' + index,
    type: 'function',
    source: { file: 'workflow.ts', line: index + 1 },
    metadata: {},
  }));
  const edges = nodes.slice(1).map((node, index) => ({
    id: 'edge-' + index,
    source: nodes[index].id,
    target: node.id,
    type: 'calls',
  }));
  const context = {
    entryPoints: [{ id: 'submit', type: 'event', name: 'Submit workflow', handler: { method_name: 'step0', file: 'workflow.ts' }, metadata: {} }],
    nodes,
    edges,
    exitPoints: [{
      id: 'terminal-delete', source_node: nodes[chainLength - 1].id, type: 'api', name: 'DELETE record',
      target: { endpoint: '/records/:id' }, operation: { method: 'DELETE', action: 'delete' }, metadata: {},
    }],
  } as any;
  const effect = classifyCapabilityOperationEffect(capability('records', [operation('submit')], ['entity_record']), operation('submit'), context);
  assert.equal(effect.kind, 'required');
  assert.deepEqual(effect.actions, ['delete']);
  assert.deepEqual(effect.subjects, ['record']);
  assert.deepEqual(effect.signatures, ['DELETE|records|entity_record']);
});

test('does not downgrade a state handler with an additional unresolved domain branch', () => {
  const context = {
    entryPoints: [{ id: 'change', source_analyzer: 'react', type: 'event', name: 'Form change', metadata: {
      source_analyzer: 'react', handler_file: 'form.tsx', handler_component_id: 'form',
      handler_references: [{ name: 'handleChange', binding_node_id: 'handler' }], handler_binding_node_ids: ['handler'],
      local_handler_kind: 'state-setter', local_support_callee_names: ['setDraft'], local_support_binding_node_ids: ['state'],
    } }],
    nodes: [
      { id: 'handler', name: 'handleChange', type: 'function', source: { file: 'form.tsx', line: 5 }, metadata: {} },
      { id: 'state', name: '[draft, setDraft]', type: 'react_handler_binding', primaryAnalyzer: 'react', parent: 'form', source: { file: 'form.tsx', line: 2 }, metadata: { attributes: { value: 'useState({})', binding_kind: 'state-setter', binding_names: ['draft', 'setDraft'] } } },
      { id: 'domain', name: 'persistDraft', type: 'function', source: { file: 'domain.ts', line: 2 }, metadata: {} },
    ],
    edges: [{ id: 'state-call', source: 'handler', target: 'state', type: 'calls' }, { id: 'domain-call', source: 'handler', target: 'domain', type: 'calls' }],
    exitPoints: [],
  } as any;
  assert.equal(classifyCapabilityOperationEffect(capability('form', [operation('change')]), operation('change'), context).kind, 'required');
});


const lifecycleObligationFixture = () => {
  const entryPoints = [
    ['list-records', 'GET', '/records', 'listRecords'],
    ['create-record', 'POST', '/records', 'createRecord'],
    ['update-record', 'PUT', '/records/:id', 'updateRecord'],
    ['delete-record', 'DELETE', '/records/:id', 'deleteRecord'],
  ].map(([id, method, path, methodName]) => ({
    id, type: 'http', name: method + ' ' + path, description: 'User can ' + id.replace('-', ' '), trigger: { method, path },
    handler: { file: 'routes.ts', method_name: methodName }, metadata: {},
  }));
  const operations = entryPoints.map(entry => ({
    entry_point_id: entry.id, entry_point_type: 'http',
    action: entry.id.split('-')[0], trigger: entry.trigger,
  })) as SystemCapability['operations'];
  return { candidate: capability('record-lifecycle', operations, ['entity_record']), context: { entryPoints, nodes: [], edges: [], exitPoints: [] } as any };
};

test('splits mixed lifecycle evidence into stable independently scoped operation obligations', () => {
  const { candidate, context } = lifecycleObligationFixture();
  const first = buildCapabilityOperationObligationViews([candidate], context);
  const reversed = buildCapabilityOperationObligationViews([{ ...candidate, operations: [...candidate.operations].reverse() }], context);
  assert.equal(first.candidates.length, 4);
  assert.deepEqual(first.candidates.map(item => item.id), reversed.candidates.map(item => item.id));
  assert.deepEqual(first.candidates.flatMap(item => item.operations.map(operationItem => operationItem.entry_point_id)).sort(), ['create-record', 'delete-record', 'list-records', 'update-record']);
  for (const view of first.candidates) {
    assert.match(view.id, /^operation-obligation:record-lifecycle:[a-f0-9]{16}$/);
    assert.deepEqual(view.criticality_factors?.filter(factor => factor.startsWith('catalog-parent-candidate:')), ['catalog-parent-candidate:record-lifecycle']);
    assert.equal(view.operations.length, 1);
    assert.deepEqual(view.evidence_examples, ['User can ' + view.operations[0].entry_point_id.replace('-', ' ')]);
  }
});

test('keeps partial obligation coverage red and converges only when every scoped operation is covered', () => {
  const { candidate, context } = lifecycleObligationFixture();
  const views = buildCapabilityOperationObligationViews([candidate], context);
  context.obligationScopes = views.scopes;
  const published = views.candidates.map(view => ({ ...view, description: 'Users can ' + view.name + ' through the verified product workflow.', criticality_factors: ['catalog-candidate:' + view.id, 'catalog-operation-obligation:' + view.id] }));
  assert.equal(uncoveredRequiredBehaviorCandidateIds(views.candidates, published.slice(0, 1), context).length, 3);
  assert.deepEqual(uncoveredRequiredBehaviorCandidateIds(views.candidates, published, context), []);
});

test('a complete parent-cited lifecycle capability covers every exact child obligation it contains', () => {
  const { candidate, context } = lifecycleObligationFixture();
  const views = buildCapabilityOperationObligationViews([candidate], context);
  context.obligationScopes = views.scopes;
  const grouped = {
    ...candidate,
    name: 'Manage records',
    description: 'Users can create, view, update, and remove records through the same lifecycle whenever needed.',
    criticality_factors: ['catalog-candidate:' + candidate.id, 'catalog-deterministic-grouped-lifecycle'],
  };

  assert.ok(views.candidates.every(view =>
    uncoveredRequiredCapabilityOperations(view, [grouped], context).length === 0));
});

test('normalizes obligation citations to their parent while preserving exact operation evidence', () => {
  const { candidate, context } = lifecycleObligationFixture();
  const views = buildCapabilityOperationObligationViews([candidate], context);
  const view = views.candidates[0];
  const authored = { ...view, criticality_factors: ['catalog-candidate:' + view.id, 'catalog-operation-obligation:' + view.id] };
  const normalized = normalizeCapabilityOperationObligationEvidence([authored], views.scopes, new Map([[candidate.id, candidate], ...views.candidates.map(item => [item.id, item] as const)]));
  assert.deepEqual(normalized.errors, []);
  assert.ok(normalized.capabilities[0].criticality_factors?.includes('catalog-candidate:record-lifecycle'));
  assert.ok(normalized.capabilities[0].criticality_factors?.includes('catalog-operation-obligation:' + view.id));
  assert.ok(!normalized.capabilities[0].criticality_factors?.includes('catalog-candidate:' + view.id));
  assert.deepEqual(normalized.capabilities[0].operations, view.operations);
});

test('rejects unresolved, uncited, and missing evidence while projecting away foreign operations', () => {
  const { candidate, context } = lifecycleObligationFixture();
  const views = buildCapabilityOperationObligationViews([candidate], context);
  const [first, second] = views.candidates;
  const invalid = normalizeCapabilityOperationObligationEvidence([
    { ...first, operations: [], criticality_factors: ['catalog-candidate:' + first.id, 'catalog-operation-obligation:' + first.id] },
    { ...first, operations: [...first.operations, ...second.operations], related_entities: ['entity_record', 'entity_foreign'], criticality_factors: ['catalog-candidate:' + first.id, 'catalog-candidate:' + candidate.id, 'catalog-operation-obligation:' + first.id] },
    { ...first, criticality_factors: ['catalog-operation-obligation:' + first.id] },
    { ...first, criticality_factors: ['catalog-operation-obligation:operation-obligation:missing:0000000000000000'] },
  ], views.scopes, new Map([[candidate.id, candidate], ...views.candidates.map(item => [item.id, item] as const)]));
  assert.ok(invalid.errors.some(error => error.startsWith('operation-obligation-missing-operation:')));
  assert.ok(!invalid.errors.some(error => error.startsWith('operation-obligation-extra-operation:')));
  assert.deepEqual(invalid.capabilities[1].operations, first.operations);
  assert.ok(invalid.errors.some(error => error.startsWith('operation-obligation-missing-parent:')));
  assert.deepEqual(invalid.capabilities[1].related_entities, ['entity_record']);
  assert.ok(invalid.errors.some(error => error.includes('operation-obligation-unresolved:operation-obligation:missing')));
});


test('scopes repair evidence facts to one obligation operation', () => {
  const { candidate, context } = lifecycleObligationFixture();
  const views = buildCapabilityOperationObligationViews([candidate], context);
  const facts = capabilityCatalogRepairEvidenceFacts(views.candidates, views.candidates.map(view => view.id), new Map([['entity_record', 'Record']]));
  assert.equal(facts.length, 4);
  assert.ok(facts.every(fact => fact.operations.length === 1));
  assert.deepEqual(facts.flatMap(fact => fact.operations.map(operationItem => operationItem.action)).sort(), ['create', 'delete', 'read', 'update']);
});

test('keeps action and subject coupled for multiple terminal effects on one entry point', () => {
  const context = terminalContext() as any;
  context.exitPoints = [
    { id: 'create-record', source_node: 'client', type: 'api', name: 'Create record', target: { endpoint: '/records' }, operation: { method: 'POST', action: 'Create' }, metadata: {} },
    { id: 'delete-record', source_node: 'client', type: 'api', name: 'Delete record', target: { endpoint: '/records/:id' }, operation: { method: 'DELETE', action: 'Delete' }, metadata: {} },
  ];
  const parent = capability('record-write', [operation('click')], ['entity_record']);
  const views = buildCapabilityOperationObligationViews([parent], context);
  assert.equal(views.candidates.length, 2);
  context.obligationScopes = views.scopes;
  const createView = views.candidates.find(view => view.name.startsWith('create '));
  const deleteView = views.candidates.find(view => view.name.startsWith('delete '));
  assert.ok(createView);
  assert.ok(deleteView);
  const publishedCreate = { ...createView, criticality_factors: ['catalog-candidate:' + createView.id, 'catalog-operation-obligation:' + createView.id] };
  assert.deepEqual(uncoveredRequiredBehaviorCandidateIds(views.candidates, [publishedCreate], context), [deleteView.id]);
  const broadCreate = { ...publishedCreate, name: 'Manage record lifecycle' };
  assert.deepEqual(uncoveredRequiredBehaviorCandidateIds(views.candidates, [broadCreate], context), [deleteView.id]);
  const publishedDelete = { ...deleteView, criticality_factors: ['catalog-candidate:' + deleteView.id, 'catalog-operation-obligation:' + deleteView.id] };
  assert.deepEqual(uncoveredRequiredBehaviorCandidateIds(views.candidates, [publishedCreate, publishedDelete], context), []);
});


test('requires the exact complete entry-point subset for a multi-entry obligation', () => {
  const entryPoints = [
    { id: 'list-primary', type: 'http', name: 'GET /records', trigger: { method: 'GET', path: '/records' }, metadata: {} },
    { id: 'list-secondary', type: 'http', name: 'GET /records', trigger: { method: 'GET', path: '/records' }, metadata: {} },
    { id: 'create-record', type: 'http', name: 'POST /records', trigger: { method: 'POST', path: '/records' }, metadata: {} },
  ];
  const candidate = capability('record-access', [
    { ...operation('list-primary', '/records'), action: 'Read', trigger: { method: 'GET', path: '/records' } },
    { ...operation('list-secondary', '/records'), action: 'Read', trigger: { method: 'GET', path: '/records' } },
    { ...operation('create-record', '/records'), action: 'Create' },
  ], ['entity_record']);
  const views = buildCapabilityOperationObligationViews([candidate], { entryPoints, nodes: [], edges: [], exitPoints: [] } as any);
  const readView = views.candidates.find(view => view.name.startsWith('read '));
  assert.ok(readView);
  assert.deepEqual(readView.operations.map(item => item.entry_point_id), ['list-primary', 'list-secondary']);
  const incomplete = { ...readView, operations: readView.operations.slice(0, 1), criticality_factors: [`catalog-candidate:${readView.id}`, `catalog-operation-obligation:${readView.id}`] };
  const duplicate = { ...readView, operations: [...readView.operations, readView.operations[0]], criticality_factors: [`catalog-candidate:${readView.id}`, `catalog-operation-obligation:${readView.id}`] };
  const incompleteResult = normalizeCapabilityOperationObligationEvidence([incomplete], views.scopes, new Map([[candidate.id, candidate], ...views.candidates.map(item => [item.id, item] as const)]));
  assert.ok(incompleteResult.errors.some(error => error === `operation-obligation-missing-operation:${readView.id}:list-secondary`));
  const duplicateResult = normalizeCapabilityOperationObligationEvidence([duplicate], views.scopes, new Map([[candidate.id, candidate], ...views.candidates.map(item => [item.id, item] as const)]));
  assert.deepEqual(duplicateResult.errors, []);
  assert.deepEqual(duplicateResult.capabilities[0].operations.map(item => item.entry_point_id), ['list-primary', 'list-secondary']);
  const valid = normalizeCapabilityOperationObligationEvidence([{ ...readView, criticality_factors: [`catalog-candidate:${readView.id}`, `catalog-operation-obligation:${readView.id}`] }], views.scopes, new Map([[candidate.id, candidate], ...views.candidates.map(item => [item.id, item] as const)]));
  assert.deepEqual(valid.errors, []);
});

test('groups click and submit paths to one create-note obligation without absorbing delete or unrelated operations', () => {
  const entryPoints = [
    { id: 'note-click', source_analyzer: 'react', type: 'event', name: 'NotesModal click', source_node: 'notes-modal', handler: { file: 'NotesModal.tsx' }, metadata: { source_analyzer: 'react', interaction_label: 'Add note', handler_binding_node_ids: ['add-note'], handler_references: [{ name: 'handleAddNote', kind: 'direct', binding_node_id: 'add-note' }] } },
    { id: 'note-submit', source_analyzer: 'react', type: 'event', name: 'NotesModal submit', source_node: 'notes-modal', handler: { file: 'NotesModal.tsx' }, metadata: { source_analyzer: 'react', interaction_label: 'Add note', handler_binding_node_ids: ['add-note'], handler_references: [{ name: 'handleAddNote', kind: 'direct', binding_node_id: 'add-note' }] } },
    { id: 'note-delete', source_analyzer: 'react', type: 'event', name: 'NotesModal click', source_node: 'notes-modal', handler: { file: 'NotesModal.tsx' }, metadata: { source_analyzer: 'react', handler_binding_node_ids: ['delete-note'], handler_references: [{ name: 'handleDeleteNote', kind: 'direct', binding_node_id: 'delete-note' }] } },
  ] as any[];
  const nodes = [
    { id: 'notes-modal', name: 'NotesModal', type: 'functional_component', source: { file: 'NotesModal.tsx', line: 1, end_line: 140 }, metadata: {} },
    { id: 'add-note', name: 'handleAddNote', type: 'function', source: { file: 'Jobs.tsx', line: 70, end_line: 90 }, metadata: {} },
    { id: 'delete-note', name: 'handleDeleteNote', type: 'function', source: { file: 'Jobs.tsx', line: 95, end_line: 115 }, metadata: {} },
    { id: 'add-client', name: 'addNote', type: 'function', source: { file: 'note-client.ts', line: 1, end_line: 8 }, metadata: {} },
    { id: 'delete-client', name: 'deleteNote', type: 'function', source: { file: 'note-client.ts', line: 10, end_line: 18 }, metadata: {} },
  ] as any[];
  const context = { entryPoints, nodes, edges: [
    { id: 'add-call', source: 'add-note', target: 'add-client', type: 'calls' },
    { id: 'delete-call', source: 'delete-note', target: 'delete-client', type: 'calls' },
  ], exitPoints: [
    { id: 'add-exit', source_node: 'add-client', type: 'api', name: 'POST add note', target: { endpoint: '/note/add-note/:userId' }, operation: { method: 'POST', action: 'Create' }, metadata: { sourceFile: 'note-client.ts', line: 4 } },
    { id: 'delete-exit', source_node: 'delete-client', type: 'api', name: 'POST delete note', target: { endpoint: '/note/delete-note/:userId' }, operation: { method: 'POST', action: 'Delete' }, metadata: { sourceFile: 'note-client.ts', line: 14 } },
  ] } as any;
  const parent = capability('notes', [operation('note-click'), operation('note-submit'), operation('note-delete')], ['entity_note']);
  parent.name = 'Notes'; parent.structural_label = 'Notes'; parent.related_domains = ['note'];
  parent.evidence_examples = ['Telemetry change', 'Telemetry submit'];
  const views = buildCapabilityOperationObligationViews([parent], context);
  const createView = views.candidates.find(view => view.name === 'create note');
  const deleteView = views.candidates.find(view => view.name === 'delete note');
  assert.ok(createView); assert.ok(deleteView);
  assert.deepEqual(createView.operations.map(item => item.entry_point_id), ['note-click', 'note-submit']);
  assert.deepEqual(deleteView.operations.map(item => item.entry_point_id), ['note-delete']);
  context.obligationScopes = views.scopes;
  const authoredCreate = { ...createView, id: 'capability_add_notes', name: 'Add notes', description: 'Users can add notes to job applications and keep those notes with each application record.', criticality_factors: [`catalog-candidate:${createView.id}`, `catalog-operation-obligation:${createView.id}`] };
  const normalized = normalizeCapabilityOperationObligationEvidence([authoredCreate], views.scopes, new Map([[parent.id, parent], ...views.candidates.map(item => [item.id, item] as const)]));
  assert.deepEqual(normalized.errors, []);
  assert.deepEqual(normalized.capabilities[0].operations.map(item => item.entry_point_id), ['note-click', 'note-submit']);
  assert.ok(!normalized.capabilities[0].criticality_factors?.some(factor => factor.includes(deleteView.id)));
  assert.deepEqual(uncoveredRequiredBehaviorCandidateIds(views.candidates, [normalized.capabilities[0]], context), [deleteView.id]);
});

test('exports only the parent citation and normalized obligation factor', () => {
  const { candidate, context } = lifecycleObligationFixture();
  const views = buildCapabilityOperationObligationViews([candidate], context);
  const view = views.candidates[0];
  const normalized = normalizeCapabilityOperationObligationEvidence([{ ...view, criticality_factors: [
    `catalog-parent-candidate:${candidate.id}`,
    `catalog-candidate:${view.id}`,
    `catalog-operation-obligation:${view.id}`,
  ] }], views.scopes, new Map([[candidate.id, candidate], ...views.candidates.map(item => [item.id, item] as const)]));
  assert.deepEqual(normalized.errors, []);
  assert.deepEqual(normalized.capabilities[0].criticality_factors, [
    `catalog-candidate:${candidate.id}`,
    `catalog-operation-obligation:${view.id}`,
  ]);
});


test('derives an actionless status endpoint mutation from its exact terminal owner', () => {
  const context = {
    entryPoints: [{ id: 'status-click', source_analyzer: 'react', type: 'event', name: 'Card click', metadata: {
      source_analyzer: 'react', handler_references: [{ name: 'hadleJobStatus', binding_node_id: 'status-handler' }], handler_binding_node_ids: ['status-handler'],
    } }],
    nodes: [
      { id: 'status-handler', name: 'hadleJobStatus', type: 'function', source: { file: 'card.tsx', line: 10, end_line: 20 }, metadata: {} },
      { id: 'status-client', name: 'changeJobStatus', type: 'function', source: { file: 'job.ts', line: 4, end_line: 10 }, metadata: {} },
      { id: 'job-file', name: 'job.ts', type: 'file', source: { file: 'job.ts', line: 1, end_line: 40 }, metadata: {} },
    ],
    edges: [{ id: 'status-call', source: 'status-handler', target: 'status-client', type: 'calls' }],
    exitPoints: [{ id: 'status-exit', source_node: 'job-file', type: 'api', name: 'POST status', target: { endpoint: '/status/:jobId' }, operation: { method: 'POST', action: 'post' }, metadata: { sourceFile: 'job.ts', line: 7 } }],
  } as any;
  const candidate = capability('job-status', [operation('status-click')], ['entity_job']);
  const effect = classifyCapabilityOperationEffect(candidate, candidate.operations[0], context);
  assert.equal(effect.kind, 'required');
  assert.deepEqual(effect.actions, ['update']);
  assert.deepEqual(effect.subjects, ['job']);
  assert.deepEqual(effect.signatures, ['POST|status|entity_job']);
});

test('keeps an actionless endpoint fail closed when its exact owner has no lifecycle action', () => {
  const context = terminalContext() as any;
  context.nodes[1].name = 'sendStatus';
  context.exitPoints[0].operation.action = 'post';
  const candidate = capability('job-status', [operation('click')], ['entity_job']);
  const effect = classifyCapabilityOperationEffect(candidate, candidate.operations[0], context);
  assert.equal(effect.kind, 'required');
  assert.deepEqual(effect.actions, []);
  assert.deepEqual(uncoveredRequiredCapabilityOperations(candidate, [], context).map(item => item.entryPointId), ['click']);
});


test('allows authoritative unsplit evidence beside an exact synthetic obligation and rejects foreign evidence', () => {
  const { candidate, context } = lifecycleObligationFixture();
  const unsplit = capability('record-audit', [{ ...operation('audit-records', '/record-audit'), action: 'Read', trigger: { method: 'GET', path: '/record-audit' } }], ['entity_record']);
  const views = buildCapabilityOperationObligationViews([candidate, unsplit], context);
  const view = views.candidates.find(item => item.id.startsWith('operation-obligation:record-lifecycle:'))!;
  const authoritative = new Map([[candidate.id, candidate], [unsplit.id, unsplit], ...views.candidates.map(item => [item.id, item] as const)]);
  const combined = {
    ...view,
    operations: [...view.operations, ...unsplit.operations, view.operations[0]],
    criticality_factors: [`catalog-candidate:${view.id}`, `catalog-operation-obligation:${view.id}`, `catalog-candidate:${unsplit.id}`],
  };
  const normalized = normalizeCapabilityOperationObligationEvidence([combined], views.scopes, authoritative);
  assert.deepEqual(normalized.errors, []);
  assert.deepEqual(normalized.capabilities[0].operations.map(item => item.entry_point_id), ['audit-records', view.operations[0].entry_point_id].sort());
  const foreign = { ...combined, operations: [...combined.operations, operation('foreign')] };
  const projectedForeign = normalizeCapabilityOperationObligationEvidence([foreign], views.scopes, authoritative);
  assert.deepEqual(projectedForeign.capabilities[0].operations.map(item => item.entry_point_id), ['audit-records', view.operations[0].entry_point_id].sort());
  const unresolved = { ...unsplit, criticality_factors: ['catalog-candidate:unknown-candidate'] };
  assert.deepEqual(normalizeCapabilityOperationObligationEvidence([unresolved], views.scopes, authoritative).errors, ['catalog-candidate-unresolved:unknown-candidate']);
});


test('ignores transport response scaffolding while retaining a reached product read', () => {
  const context = {
    entryPoints: [{ id: 'avatar-route', type: 'http', name: 'GET avatar', handler: { node_id: 'handler' }, trigger: { method: 'GET', path: '/users/:id/avatar' }, metadata: {} }],
    nodes: [
      { id: 'handler', name: 'serveUserAvatar', type: 'method', source: { file: 'avatar.go', line: 1, end_line: 20 }, metadata: {} },
      { id: 'store', name: 'GetUser', type: 'method', source: { file: 'avatar.go', line: 5, end_line: 8 }, metadata: {} },
      { id: 'headers', name: 'setSecurityHeaders', type: 'function', source: { file: 'avatar.go', line: 10, end_line: 12 }, metadata: {} },
    ],
    edges: [
      { id: 'store-call', source: 'handler', target: 'store', type: 'calls' },
      { id: 'header-call', source: 'handler', target: 'headers', type: 'calls' },
    ],
    exitPoints: [
      { id: 'store-read', source_node: 'store', type: 'sdk', name: 'External call: s.Store.GetUser', metadata: { sourceFile: 'avatar.go', line: 6 } },
      { id: 'header-set', source_node: 'headers', type: 'sdk', name: 'External call: c.Response().Header().Set', metadata: { sourceFile: 'avatar.go', line: 11 } },
      { id: 'http-error', source_node: 'headers', type: 'sdk', name: 'External call: echo.NewHTTPError', metadata: { sourceFile: 'avatar.go', line: 12 } },
    ],
  } as any;
  const avatar = capability('avatar', [{ entry_point_id: 'avatar-route', entry_point_type: 'http', action: 'read', trigger: { method: 'GET', path: '/users/:id/avatar' } }], ['entity_avatar']);
  const effect = classifyCapabilityOperationEffect(avatar, avatar.operations[0], context);
  assert.deepEqual(effect.actions, ['read']);
  assert.deepEqual(effect.subjects, ['avatar']);
});
test('derives exact declaration action and subject parity before applying cross-contract aliases', () => {
  const declaration = (id: string, source: 'protobuf' | 'openapi', service: string, operationName: string) => ({
    id, type: 'http', name: operationName, source_analyzer: source,
    trigger: { method: 'POST', path: '/' + service + '/' + operationName },
    handler: { method_name: source === 'protobuf' ? operationName : service + '_' + operationName },
    metadata: source === 'protobuf'
      ? { execution_role: 'declaration', protocol: 'grpc', service, rpc: operationName }
      : { execution_role: 'declaration', operationId: service + '_' + operationName, tags: [service] },
  });
  const operations = [
    ['UserService', 'CreateUser'], ['UserService', 'DeleteUser'], ['UserService', 'GetUser'],
    ['UserService', 'ListUsers'], ['UserService', 'UpdateUser'], ['AuthService', 'SignIn'],
    ['AuthService', 'SignOut'], ['AuthService', 'RefreshToken'], ['MemoViewService', 'CreateMemoView'],
    ['MemoViewService', 'DeleteMemoView'], ['MemoViewService', 'UpdateMemoView'],
  ] as const;
  const entryPoints = operations.flatMap(([service, name]) => [
    declaration('grpc-' + name, 'protobuf', service, name),
    declaration('openapi-' + name, 'openapi', service, name),
  ]);
  const context = { entryPoints, nodes: [], edges: [], exitPoints: [] } as any;
  for (const [, name] of operations) {
    const requiredOperation = { entry_point_id: 'grpc-' + name, entry_point_type: 'http', action: '' };
    const publishedOperation = { entry_point_id: 'openapi-' + name, entry_point_type: 'http', action: '' };
    const required = capability('required-' + name, [requiredOperation], []);
    const published = capability('published-' + name, [publishedOperation], []);
    const effect = classifyCapabilityOperationEffect(required, requiredOperation, context);
    assert.ok(effect.actions.length > 0, name + ' action');
    assert.ok(effect.subjects.length > 0, name + ' subject');
    const verb = ({ create: 'Create', read: 'View', update: 'Update', delete: 'Remove', authenticate: 'Authenticate' } as Record<string, string>)[effect.actions[0]] || effect.actions[0];
    published.name = verb + ' ' + effect.subjects.join(' ');
    assert.deepEqual(uncoveredRequiredCapabilityOperations(required, [published], context), [], name);
  }
});

test('uses a grounded GET route outcome when reached authentication and header work are preconditions', () => {
  const context = {
    entryPoints: [{ id: 'avatar-route', type: 'http', name: 'GET avatar', handler: { node_id: 'handler' }, trigger: { method: 'GET', path: '/file/users/:identifier/avatar' }, metadata: {} }],
    nodes: [
      { id: 'handler', name: 'serveUserAvatar', type: 'method', source: { file: 'avatar.go', line: 1 }, metadata: {} },
      { id: 'auth', name: 'AuthenticateToUser', type: 'method', source: { file: 'auth.go', line: 1 }, metadata: {} },
      { id: 'usage', name: 'recordPATUsage', type: 'method', source: { file: 'auth.go', line: 2 }, metadata: {} },
    ],
    edges: [{ id: 'auth-call', source: 'handler', target: 'auth', type: 'calls' }, { id: 'usage-call', source: 'auth', target: 'usage', type: 'calls' }],
    exitPoints: [
      { id: 'auth-exit', source_node: 'auth', type: 'sdk', name: 'External call: token.Authenticate', metadata: {} },
      { id: 'usage-exit', source_node: 'usage', type: 'sdk', name: 'External call: store.UpdatePAT', metadata: {} },
    ],
  } as any;
  const avatar = capability('avatar', [{ entry_point_id: 'avatar-route', entry_point_type: 'http', action: 'read', trigger: { method: 'GET', path: '/file/users/:identifier/avatar' }, path_or_command: '/file/users/:identifier/avatar' }], ['entity_user']);
  const effect = classifyCapabilityOperationEffect(avatar, avatar.operations[0], context);
  assert.deepEqual(effect.actions, ['read']);
  assert.deepEqual(effect.subjects, ['avatar']);
  assert.equal(effect.terminalObligations.length, 1);
});

test('subsumes declaration transport aggregates only through complete exact cross-contract aliases', () => {
  const declaration = (id: string, source: 'protobuf' | 'openapi', service: string, operationName: string) => ({
    id, type: 'http', name: operationName, source_analyzer: source,
    trigger: { method: 'POST', path: '/' + service + '/' + operationName },
    metadata: source === 'protobuf'
      ? { execution_role: 'declaration', protocol: 'grpc', service, rpc: operationName }
      : { execution_role: 'declaration', operationId: service + '_' + operationName, tags: [service] },
  });
  const context = {
    entryPoints: [
      declaration('grpc-create', 'protobuf', 'AttachmentService', 'CreateAttachment'),
      declaration('grpc-delete', 'protobuf', 'AttachmentService', 'DeleteAttachment'),
      declaration('openapi-create', 'openapi', 'AttachmentService', 'CreateAttachment'),
      declaration('openapi-delete', 'openapi', 'AttachmentService', 'DeleteAttachment'),
      { id: 'avatar', type: 'http', name: 'GET avatar', trigger: { method: 'GET', path: '/users/:id/avatar' }, metadata: { execution_role: 'runtime' } },
      { id: 'cli', type: 'cli', name: 'memos', trigger: { pattern: 'memos' }, metadata: { framework: 'cobra' } },
    ], nodes: [], edges: [], exitPoints: [],
  } as any;
  const aggregate = capability('grpc-attachments', [
    { entry_point_id: 'grpc-create', entry_point_type: 'http', action: 'create' },
    { entry_point_id: 'grpc-delete', entry_point_type: 'http', action: 'delete' },
  ], ['entity_attachment', 'entity_actor']);
  const create = capability('Create attachments', [{ entry_point_id: 'openapi-create', entry_point_type: 'http', action: 'create' }], ['entity_attachment']);
  const remove = capability('Remove attachments', [{ entry_point_id: 'openapi-delete', entry_point_type: 'http', action: 'delete' }], ['entity_attachment']);
  assert.deepEqual([...fullyCoveredAggregateCapabilityCandidateIds([aggregate], [create, remove], context)], [aggregate.id]);
  assert.deepEqual([...fullyCoveredAggregateCapabilityCandidateIds([aggregate], [create], context)], []);
  const avatar = capability('avatar', [{ entry_point_id: 'avatar', entry_point_type: 'http', action: 'read' }], ['entity_user']);
  const cli = capability('cli', [{ entry_point_id: 'cli', entry_point_type: 'cli', action: 'execute' }], []);
  assert.deepEqual([...fullyCoveredAggregateCapabilityCandidateIds([avatar, cli], [create, remove], context)], []);
});

test('keeps a declaration aggregate required when an aliased product operation is not published', () => {
  const context = {
    entryPoints: [
      { id: 'grpc-view', type: 'http', name: 'GetMemoView', metadata: { execution_role: 'declaration', protocol: 'grpc', service: 'MemoViewService', rpc: 'GetMemoView' } },
      { id: 'openapi-view', type: 'http', name: 'GetMemoView', metadata: { execution_role: 'declaration', operationId: 'MemoViewService_GetMemoView', tags: ['MemoViewService'] } },
    ], nodes: [], edges: [], exitPoints: [],
  } as any;
  const aggregate = capability('memo-views', [{ entry_point_id: 'grpc-view', entry_point_type: 'http', action: 'read' }], ['entity_memo_view']);
  const unrelated = capability('Manage memos', [{ entry_point_id: 'other', entry_point_type: 'http', action: 'read' }], ['entity_memo']);
  assert.deepEqual([...fullyCoveredAggregateCapabilityCandidateIds([aggregate], [unrelated], context)], []);
});

test('covers an aggregate family only through the complete compatible operation and entity union', () => {
  const exactOperation = (id: string, action: string, path: string) => ({
    entry_point_id: id,
    entry_point_type: 'http',
    action,
    trigger: { method: action === 'delete' ? 'DELETE' : 'POST', path },
  });
  const aggregate = capability('aggregate-work', [
    exactOperation('create-job', 'create', '/jobs'),
    exactOperation('delete-job', 'delete', '/jobs/:id'),
    exactOperation('create-note', 'create', '/notes'),
  ], ['entity_job', 'entity_note']);
  const createJobs = capability('Create jobs', [exactOperation('create-job', 'create', '/jobs')], ['entity_job']);
  const deleteJobs = capability('Delete jobs', [exactOperation('delete-job', 'delete', '/jobs/:id')], ['entity_job']);
  const createNotes = capability('Create notes', [exactOperation('create-note', 'create', '/notes')], ['entity_note']);
  const context = { entryPoints: [], nodes: [], edges: [], exitPoints: [] } as any;

  assert.deepEqual([...fullyCoveredAggregateCapabilityCandidateIds(
    [aggregate], [createJobs, deleteJobs, createNotes], context,
  )], ['aggregate-work']);
  assert.deepEqual([...fullyCoveredAggregateCapabilityCandidateIds(
    [aggregate], [createJobs, createNotes], context,
  )], []);
  assert.deepEqual([...fullyCoveredAggregateCapabilityCandidateIds(
    [aggregate], [createJobs, deleteJobs, { ...createNotes, name: 'Create jobs' }], context,
  )], []);
  assert.deepEqual([...fullyCoveredAggregateCapabilityCandidateIds(
    [{ ...aggregate, id: 'operation-obligation:aggregate:read' }], [createJobs, deleteJobs, createNotes], context,
  )], []);
});

test('derives read semantics from a grounded GET product route and keeps it required', () => {
  const routeOperation = {
    entry_point_id: 'jobs-route', entry_point_type: 'route', action: 'Process',
    trigger: { method: 'GET', path: '/jobs' },
  };
  const aggregate = {
    ...capability('Jobs', [routeOperation], ['entity_job', 'entity_note']),
    evidence_kind: 'entity' as const,
    name: 'Jobs',
  };
  const context = {
    entryPoints: [{
      id: 'jobs-route', source_node: 'jobs-page', source_analyzer: 'react', type: 'route',
      name: 'Route /jobs', trigger: { method: 'GET', path: '/jobs' },
      metadata: { framework: 'react-router', component: 'Jobs', source_analyzer: 'react' },
    }],
    nodes: [], edges: [], exitPoints: [],
  } as any;

  const effect = classifyCapabilityOperationEffect(aggregate, routeOperation, context);
  assert.equal(effect.kind, 'required');
  assert.deepEqual(effect.actions, ['read']);
  assert.ok(effect.subjects.includes('job'));
  const [scoped] = scopeRequiredCapabilityOperations([aggregate], context);
  assert.equal(scoped.operations.length, 1);
  assert.equal(scoped.operations[0].action, 'read');
  assert.match(scoped.name, /^read\b/);
});

test('scopes product operations with backward-compatible sparse graph context', () => {
  const candidate = {
    ...capability('Jobs', [{
      entry_point_id: 'jobs-route', entry_point_type: 'route', action: 'read',
      trigger: { method: 'GET', path: '/jobs' },
    }], ['entity_job']),
    evidence_kind: 'entity' as const,
  };
  assert.doesNotThrow(() => scopeRequiredCapabilityOperations([candidate], { entryPoints: [], nodes: [] } as any));
});


test('preserves an exact interactive fetch-and-fill outcome instead of degrading it to generic viewing', () => {
  const context = {
    entryPoints: [
      { id: 'fetch-click', type: 'event', source_analyzer: 'react', source_node: 'job-modal', name: 'Job modal click', metadata: {
        source_analyzer: 'react', handler_component_id: 'job-modal', handler_binding_node_ids: ['fetch-handler'],
        handler_references: [{ name: 'handleFetchJob', binding_node_id: 'fetch-handler' }], interaction_label: 'Fetch job',
        handler_state_target_names: ['jobDetails'], handler_state_target_binding_node_ids: ['job-state'],
      } },
      { id: 'submit-click', type: 'event', source_analyzer: 'react', source_node: 'job-modal', name: 'Job modal submit', metadata: {
        source_analyzer: 'react', handler_component_id: 'job-modal', handler_binding_node_ids: ['submit-handler'],
        handler_references: [{ name: 'handleCreateJob', binding_node_id: 'submit-handler' }], interaction_label: 'Submit',
      } },
    ],
    nodes: [
      { id: 'fetch-handler', name: 'handleFetchJob', type: 'function', source: { file: 'JobModal.tsx', line: 10, end_line: 20 }, metadata: {} },
      { id: 'fetch-client', name: 'fetchJob', type: 'function', source: { file: 'job-client.ts', line: 1, end_line: 5 }, metadata: {} },
      { id: 'submit-handler', name: 'handleCreateJob', type: 'function', source: { file: 'JobModal.tsx', line: 30, end_line: 40 }, metadata: {} },
      { id: 'create-client', name: 'createJob', type: 'function', source: { file: 'job-client.ts', line: 10, end_line: 15 }, metadata: {} },
      { id: 'job-state', name: '[jobDetails, setJobDetails]', type: 'react_handler_binding', primaryAnalyzer: 'react', source: { file: 'JobModal.tsx', line: 4 }, metadata: { attributes: { binding_names: ['jobDetails', 'setJobDetails'], binding_kind: 'state-setter' } } },
    ],
    edges: [
      { id: 'fetch-call', source: 'fetch-handler', target: 'fetch-client', type: 'calls' },
      { id: 'fetch-state', source: 'fetch-handler', target: 'job-state', type: 'calls', metadata: { resolution: 'exact-handler-state-write' } },
      { id: 'create-call', source: 'submit-handler', target: 'create-client', type: 'calls' },
    ],
    exitPoints: [
      { id: 'fetch-exit', source_node: 'fetch-client', type: 'api', name: 'POST fetch job', target: { endpoint: '/fetch-job' }, operation: { method: 'POST', action: 'read' }, metadata: {} },
      { id: 'create-exit', source_node: 'create-client', type: 'api', name: 'POST create job', target: { endpoint: '/jobs' }, operation: { method: 'POST', action: 'create' }, metadata: {} },
    ],
  } as any;
  const parent = capability('job-work', [operation('fetch-click'), operation('submit-click')], ['entity_job']);
  const views = buildCapabilityOperationObligationViews([parent], context).candidates;
  const fetchView = views.find(view => view.operations.some(item => item.entry_point_id === 'fetch-click'))!;
  assert.equal(fetchView.name, 'Fetch job details');
  assert.equal(fetchView.structural_label, 'Fetch job details');
  assert.ok(fetchView.evidence_examples?.includes('Fetch job'));
  assert.ok(fetchView.evidence_examples?.includes('jobDetails'));

  const withoutFill = structuredClone(context);
  withoutFill.entryPoints[0].metadata.handler_state_target_names = ['loading'];
  const generic = buildCapabilityOperationObligationViews([parent], withoutFill).candidates
    .find(view => view.operations.some(item => item.entry_point_id === 'fetch-click'))!;
  assert.equal(generic.name, 'read job');

  const withoutExternalBoundary = structuredClone(context);
  withoutExternalBoundary.exitPoints = withoutExternalBoundary.exitPoints.filter((item: any) => item.id !== 'fetch-exit');
  const unresolved = buildCapabilityOperationObligationViews([parent], withoutExternalBoundary).candidates
    .find(view => view.operations.some(item => item.entry_point_id === 'fetch-click'))!;
  assert.notEqual(unresolved.name, 'Fetch job details');
});

test('repairs only uncovered action-scoped slices of a structural aggregate in stable order', () => {
  const { candidate, context } = lifecycleObligationFixture();
  const aggregate = { ...candidate, evidence_kind: undefined, evidence_role: undefined };
  const first = buildCapabilityOperationObligationViews([aggregate], context, { includeStructuralAggregates: true });
  const reversed = buildCapabilityOperationObligationViews([{ ...aggregate, operations: [...aggregate.operations].reverse() }], context, { includeStructuralAggregates: true });
  assert.deepEqual(first.candidates.map(item => item.id), reversed.candidates.map(item => item.id));
  assert.ok(first.candidates.every(item => item.criticality_factors?.includes('catalog-aggregate-operation-view')));
  context.obligationScopes = first.scopes;
  const readView = first.candidates.find(item => item.name.startsWith('read '))!;
  assert.ok(readView);
  const coveredAtomicOutcomes = first.candidates.filter(item => item.id !== readView.id).map(item => ({ ...item, description: `Users can ${item.name} through the verified product workflow.`, criticality_factors: [`catalog-candidate:${item.id}`, `catalog-operation-obligation:${item.id}`] }));
  const evidence = [aggregate, ...first.candidates];
  const readSpoof = {
    ...readView, name: 'Add records', description: 'Users add records through the verified product workflow.',
    criticality_factors: [`catalog-candidate:${readView.id}`, `catalog-operation-obligation:${readView.id}`],
  };
  assert.deepEqual(uncoveredAggregateOperationObligationIds(evidence, [...coveredAtomicOutcomes, readSpoof], first.scopes, context), new Map([[aggregate.id, [readView.id]]]));
  const deleteView = first.candidates.find(item => item.name.startsWith('delete '))!;
  const deleteSpoof = { ...deleteView, name: 'View records', description: 'Users view records through the verified product workflow.', criticality_factors: [`catalog-candidate:${deleteView.id}`, `catalog-operation-obligation:${deleteView.id}`] };
  assert.ok(uncoveredAggregateOperationObligationIds(evidence, [deleteSpoof], first.scopes, context).get(aggregate.id)?.includes(deleteView.id));
  const manage = { ...aggregate, name: 'Manage records', description: 'Users manage records across create, view, update, and remove actions.', criticality_factors: first.candidates.flatMap(item => [`catalog-candidate:${item.id}`, `catalog-operation-obligation:${item.id}`]) };
  assert.deepEqual(uncoveredAggregateOperationObligationIds(evidence, [manage], first.scopes, context), new Map());
  const track = { ...manage, name: 'Track records', description: 'Users can create, view, update, and remove records throughout their lifecycle.' };
  assert.deepEqual(uncoveredAggregateOperationObligationIds(evidence, [track], first.scopes, context), new Map());
  assert.deepEqual([...fullyCoveredAggregateCapabilityCandidateIds(evidence, [track], context)], [aggregate.id]);
  assert.deepEqual(uncoveredAggregateOperationObligationIds(evidence, coveredAtomicOutcomes, first.scopes, context), new Map([[aggregate.id, [readView.id]]]));
  assert.deepEqual([...fullyCoveredAggregateCapabilityCandidateIds(evidence, coveredAtomicOutcomes, context)], []);
  const fullyCovered = [...coveredAtomicOutcomes, { ...readView, name: 'View records', description: 'Users can view records through the verified product workflow.', criticality_factors: [`catalog-candidate:${readView.id}`, `catalog-operation-obligation:${readView.id}`] }];
  assert.deepEqual(uncoveredAggregateOperationObligationIds(evidence, fullyCovered, first.scopes, context), new Map());
  assert.deepEqual([...fullyCoveredAggregateCapabilityCandidateIds(evidence, fullyCovered, context)], [aggregate.id]);
  assert.deepEqual(uncoveredAggregateOperationObligationIds([aggregate], fullyCovered, first.scopes, context), new Map());
  assert.deepEqual([...fullyCoveredAggregateCapabilityCandidateIds([aggregate], fullyCovered, context)], [aggregate.id]);
  assert.deepEqual([...fullyCoveredAggregateCapabilityCandidateIds([aggregate], [...fullyCovered].reverse(), context)], [aggregate.id]);
  assert.deepEqual([...fullyCoveredAggregateCapabilityCandidateIds([{ ...aggregate, operations: [] }], fullyCovered, context)], [aggregate.id]);
  const exactScopeOutcomesWithoutDuplicatedEntityMetadata = fullyCovered.map(item => ({ ...item, related_entities: [] }));
  assert.deepEqual([...fullyCoveredAggregateCapabilityCandidateIds([aggregate], exactScopeOutcomesWithoutDuplicatedEntityMetadata, context)], [aggregate.id]);
  assert.deepEqual([...fullyCoveredAggregateCapabilityCandidateIds([aggregate], exactScopeOutcomesWithoutDuplicatedEntityMetadata.filter(item => item.id !== readView.id), context)], []);
  assert.deepEqual([...fullyCoveredAggregateCapabilityCandidateIds([aggregate], fullyCovered.filter(item => item.id !== readView.id), context)], []);
  assert.deepEqual([...fullyCoveredAggregateCapabilityCandidateIds([aggregate], [...coveredAtomicOutcomes, { ...readView, name: 'Create records' }], context)], []);
});

test('builds aggregate obligation views with a backward-compatible sparse graph context', () => {
  const { candidate, context } = lifecycleObligationFixture();
  const aggregate = { ...candidate, evidence_kind: undefined, evidence_role: undefined };
  const sparse = { entryPoints: context.entryPoints } as any;
  assert.doesNotThrow(() => buildCapabilityOperationObligationViews([aggregate], sparse, { includeStructuralAggregates: true }));
  assert.equal(buildCapabilityOperationObligationViews([aggregate], sparse, { includeStructuralAggregates: true }).candidates.length, 4);
});

test('retires only fully covered broad pending identities independent of catalog order', () => {
  const createId = 'operation-obligation:categories:create';
  const removeId = 'operation-obligation:categories:remove';
  const createOperation = { entry_point_id: 'create-category', entry_point_type: 'http', action: 'create' };
  const removeOperation = { entry_point_id: 'remove-category', entry_point_type: 'http', action: 'delete' };
  const createCandidate = { ...capability(createId, [createOperation], ['entity_category']), name: 'create category', structural_label: 'create category' };
  const removeCandidate = { ...capability(removeId, [removeOperation], ['entity_category']), name: 'delete category', structural_label: 'delete category' };
  const context = {
    entryPoints: [
      { id: 'create-category', type: 'event', source_node: 'create-handler' },
      { id: 'remove-category', type: 'event', source_node: 'remove-handler' },
    ],
    nodes: [{ id: 'create-handler', name: 'createCategory', type: 'function' }, { id: 'remove-handler', name: 'removeCategory', type: 'function' }],
    edges: [],
    exitPoints: [
      { id: 'create-exit', source_node: 'create-handler', type: 'database', name: 'create category', operation: { action: 'create' }, target: { resource: 'category' } },
      { id: 'remove-exit', source_node: 'remove-handler', type: 'database', name: 'delete category', operation: { action: 'delete' }, target: { resource: 'category' } },
    ],
    obligationScopes: new Map([
      [createId, { id: createId, parentCandidateId: 'cap_categories', entryPointIds: ['create-category'], terminalKeysByEntryPoint: new Map() }],
      [removeId, { id: removeId, parentCandidateId: 'cap_categories', entryPointIds: ['remove-category'], terminalKeysByEntryPoint: new Map() }],
    ]),
  } as any;
  const published = (id: string, name: string, operation: any) => ({
    ...capability(`published-${id}`, [operation], ['entity_category']), name,
    description: `Users ${name.toLowerCase()} while organizing their tracked application categories.`,
    criticality_factors: [`catalog-candidate:${id}`, `catalog-operation-obligation:${id}`],
  });
  const createPublished = published(createId, 'Create categories', createOperation);
  const removePublished = published(removeId, 'Remove categories', removeOperation);
  const pendingBroad = {
    ...capability('pending-categories', [createOperation, removeOperation], ['entity_category']), name: 'Manage categories', description: '',
    criticality_factors: [`catalog-candidate:${createId}`, `catalog-candidate:${removeId}`],
  };
  const pendingExact = { ...pendingBroad, id: 'pending-create', criticality_factors: [`catalog-candidate:${createId}`] };
  const isPublishable = (item: SystemCapability) => Boolean(item.description);
  for (const values of [[pendingBroad, createPublished, removePublished], [removePublished, pendingBroad, createPublished]]) {
    const coverage = evaluateCapabilityCatalogOperationCoverage(values, [createCandidate, removeCandidate], context, isPublishable);
    assert.deepEqual(coverage.uncoveredCandidateIds, []);
    assert.deepEqual(coverage.capabilities.map(item => item.id).sort(), [createPublished.id, removePublished.id].sort());
  }
  const partial = evaluateCapabilityCatalogOperationCoverage(
    [pendingBroad, createPublished],
    [createCandidate, removeCandidate],
    context,
    isPublishable,
  );
  assert.deepEqual(partial.uncoveredCandidateIds, [removeId]);
  assert.ok(partial.capabilities.some(item => item.id === pendingBroad.id));
  assert.ok(retireFullyCoveredPendingAggregateCapabilities([pendingExact, createPublished], [createCandidate], context, isPublishable)
    .some(item => item.id === pendingExact.id));

  const parent = {
    ...capability('cap_note_management', [createOperation, removeOperation], ['entity_category']),
    evidence_kind: 'entity-backed' as const, evidence_role: 'product-outcome' as const,
  };
  const directCreate = { ...createCandidate, id: 'capability_addnote_create' };
  const pendingParentBroad = {
    ...pendingBroad,
    criticality_factors: ['catalog-candidate:cap_note_management', 'catalog-candidate:capability_addnote_create'],
  };
  const parentEvidence = [parent, directCreate];
  const parentContext = {
    ...context,
    obligationScopes: new Map([...context.obligationScopes].map(([id, scope]: [string, any]) => [
      id, { ...scope, parentCandidateId: parent.id },
    ])),
  } as any;
  for (const values of [[pendingParentBroad, createPublished, removePublished], [removePublished, pendingParentBroad, createPublished]]) {
    const retired = retireFullyCoveredPendingAggregateCapabilities(values, parentEvidence, parentContext, isPublishable);
    assert.deepEqual(retired.map(item => item.id).sort(), [createPublished.id, removePublished.id].sort());
  }
  const parentPartial = retireFullyCoveredPendingAggregateCapabilities(
    [pendingParentBroad, createPublished], parentEvidence, parentContext, isPublishable,
  );
  assert.ok(parentPartial.some(item => item.id === pendingParentBroad.id));
  const singleParentContext = {
    ...context,
    obligationScopes: new Map([[createId, context.obligationScopes.get(createId)]]),
  } as any;
  const pendingSingleParent = { ...pendingBroad, id: 'pending-single-parent', criticality_factors: ['catalog-candidate:capability_addnote_create'] };
  assert.ok(retireFullyCoveredPendingAggregateCapabilities(
    [pendingSingleParent, createPublished], [directCreate], singleParentContext, isPublishable,
  ).some(item => item.id === pendingSingleParent.id));
});

test('keeps filesystem executable shell entries as support while preserving registered product CLIs', () => {
  const structuralEntry = {
    id: 'shell-dev', source_analyzer: 'shell', type: 'cli', name: 'Shell script: dev',
    metadata: { source_analyzer: 'shell', cli_origin: 'filesystem-executable', cli_product_role: 'supporting-mechanism' },
  } as any;
  const registeredEntry = {
    ...structuralEntry, id: 'shell-export',
    trigger: { pattern: 'export-report' },
    metadata: { ...structuralEntry.metadata, cli_product_role: 'product-command', command: 'export-report' },
  } as any;
  const structural = capability('shell-support', [{ entry_point_id: structuralEntry.id, entry_point_type: 'cli', action: 'Run' }] as any, []);
  const registered = capability('shell-product', [{ entry_point_id: registeredEntry.id, entry_point_type: 'cli', action: 'Export report' }] as any, []);
  const internalMainEntry = {
    id: 'internal-main', source_analyzer: 'cli-frameworks', type: 'cli', name: 'main', trigger: { pattern: 'main' },
    handler: { file: 'internal/parser/tool/main.go' }, metadata: { framework: 'generic', command: 'main', file: 'internal/parser/tool/main.go' },
  } as any;
  const internalMain = capability('internal-main', [{ entry_point_id: internalMainEntry.id, entry_point_type: 'cli', action: 'Run' }] as any, []);
  const commandGroupEntry = { id: 'root-command', type: 'cli', name: 'memos (command group)', trigger: { pattern: 'memos' }, metadata: { framework: 'cobra', kind: 'command-group', command: 'memos' } } as any;
  const versionEntry = { id: 'version-command', type: 'cli', name: 'version', trigger: { pattern: 'version' }, metadata: { framework: 'cobra', kind: 'command', command: 'version' } } as any;
  const commandGroup = capability('root-command', [{ entry_point_id: commandGroupEntry.id, entry_point_type: 'cli', action: 'Run' }] as any, []);
  const version = capability('version-command', [{ entry_point_id: versionEntry.id, entry_point_type: 'cli', action: 'Run' }] as any, []);
  const context = { entryPoints: [structuralEntry, registeredEntry, internalMainEntry, commandGroupEntry, versionEntry], nodes: [], edges: [], exitPoints: [] } as any;
  assert.equal(classifyCapabilityOperationEffect(commandGroup, commandGroup.operations[0], context).kind, 'support');
  assert.equal(classifyCapabilityOperationEffect(version, version.operations[0], context).kind, 'support');
  assert.equal(classifyCapabilityOperationEffect(structural, structural.operations[0], context).kind, 'support');
  assert.equal(classifyCapabilityOperationEffect(internalMain, internalMain.operations[0], context).kind, 'support');
  assert.equal(classifyCapabilityOperationEffect(registered, registered.operations[0], context).kind, 'required');
  assert.equal(structural.operations.length, 1, 'support classification must preserve the CAS operation');
});

test('uses parser-proven Rails resource semantics and keeps form preparation as support', () => {
  const entries = [
    { id: 'index', type: 'http', name: 'GET /work_orders', trigger: { method: 'GET', path: '/work_orders' }, handler: { method_name: 'index' }, metadata: { route_source: 'resources', route_resource: 'work_orders', rest_action: 'index', route_role: 'collection-read' } },
    { id: 'show', type: 'http', name: 'GET /work_orders/:id', trigger: { method: 'GET', path: '/work_orders/:id' }, handler: { method_name: 'show' }, metadata: { route_source: 'resources', route_resource: 'work_orders', rest_action: 'show', route_role: 'member-read' } },
    { id: 'new', type: 'http', name: 'GET /work_orders/new', trigger: { method: 'GET', path: '/work_orders/new' }, handler: { method_name: 'new' }, metadata: { route_source: 'resources', route_resource: 'work_orders', rest_action: 'new', route_role: 'create-form' } },
    { id: 'edit', type: 'http', name: 'GET /work_orders/:id/edit', trigger: { method: 'GET', path: '/work_orders/:id/edit' }, handler: { method_name: 'edit' }, metadata: { route_source: 'resources', route_resource: 'work_orders', rest_action: 'edit', route_role: 'update-form' } },
    { id: 'custom-new', type: 'http', name: 'GET /preview/new', trigger: { method: 'GET', path: '/preview/new' }, handler: { method_name: 'new' }, metadata: { route_source: 'verb' } },
  ] as any[];
  const operations = entries.map(entry => ({ entry_point_id: entry.id, entry_point_type: 'http', action: entry.handler.method_name, trigger: entry.trigger }));
  const candidate = capability('rails-routes', operations as any, []);
  const context = { entryPoints: entries, nodes: [], edges: [], exitPoints: [] } as any;
  const index = classifyCapabilityOperationEffect(candidate, operations[0] as any, context);
  const show = classifyCapabilityOperationEffect(candidate, operations[1] as any, context);
  assert.equal(index.kind, 'required');
  assert.deepEqual(index.actions, ['read']);
  assert.deepEqual(index.subjects, ['work', 'order']);
  assert.equal(show.kind, 'required');
  assert.deepEqual(index.terminalObligations[0].outcomeLabels, ['List work orders']);
  assert.deepEqual(show.subjects, ['work', 'order']);
  assert.equal(classifyCapabilityOperationEffect(candidate, operations[2] as any, context).kind, 'support');
  assert.deepEqual(show.terminalObligations[0].outcomeLabels, ['View work order']);
  assert.equal(classifyCapabilityOperationEffect(candidate, operations[3] as any, context).kind, 'support');
  assert.equal(classifyCapabilityOperationEffect(candidate, operations[4] as any, context).kind, 'required');
  const views = buildCapabilityOperationObligationViews([candidate], context);
  assert.ok(views.candidates.every(view => !/\b(?:indexs|news)\b/i.test(view.name)));
});
