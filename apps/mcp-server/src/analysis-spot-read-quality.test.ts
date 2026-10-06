import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateSpotReadCas } from './analysis-spot-read-quality';

function baseCas(overrides: any = {}): any {
  return {
    system: {
      name: 'sample-api',
      root_path: '/tmp/sample-api',
      description: 'Sample API',
      technologies: { languages: [{ name: 'TypeScript' }], frameworks: [{ name: 'NestJS' }] },
    },
    nodes: Array.from({ length: 80 }, (_, index) => ({
      id: `node-${index}`,
      name: index % 3 === 0 ? `UsersController${index}` : index % 3 === 1 ? `UsersService${index}` : `UserEntity${index}`,
      type: index % 3 === 0 ? 'controller' : index % 3 === 1 ? 'service' : 'model',
      source: { file: index % 3 === 0 ? `src/users/users-${index}.controller.ts` : `src/users/users-${index}.service.ts` },
    })),
    edges: [{ source: 'node-0', target: 'node-1', type: 'calls' }],
    system_purpose: { primary_type: 'api-service', confidence: 0.9 },
    enhanced_system_purpose: {
      primary_domain: 'user-management',
      inferred_description: 'This user management service coordinates account registration, profile updates, access checks, and administrative user lifecycle workflows for operators and API clients. It explains the behavior agents need to preserve when changing account and authorization code.',
      description_source: 'ai',
      description_generation: { attempted: true, status: 'ai_applied' },
    },
    capabilities: [{
      id: 'cap-user-lifecycle',
      name: 'User Lifecycle',
      description: 'Coordinates user registration, profile updates, and account state transitions so operators can manage access without duplicating authorization rules.',
      description_source: 'ai',
      description_generation: { attempted: true, status: 'ai_applied' },
      operations: [{ path_or_command: 'src/users/users.service.ts' }],
    }],
    architecture_summary: {
      system_type: 'NestJS service',
      architectural_patterns: [{
        name: 'Service Layer',
        confidence: 0.85,
        evidence: [{ file: 'src/users/users.service.ts' }],
        node_ids: ['node-1'],
      }],
      architectural_inventory: {
        controllers: [{ name: 'UsersController', file: 'src/users/users.controller.ts' }],
        services: [{ name: 'UsersService', file: 'src/users/users.service.ts' }],
        models: [{ name: 'UserEntity', file: 'src/users/user.entity.ts' }],
      },
      pattern_balance: { status: 'balanced' },
    },
    codebase_idioms: [{
      category: 'dependency-injection',
      name: 'Services use constructor injection',
      confidence: 0.8,
      evidence: [{ file: 'src/users/users.service.ts' }],
      positive_examples: [{ file: 'src/users/users.service.ts' }],
      agent_guidance: { do: ['Follow constructor injection.'], avoid: [], validation: [] },
    }],
    entities: [{ id: 'entity-user', name: 'User', fields: [{ name: 'id' }] }],
    domain_concepts: [{ name: 'User', appears_in: { nodes: ['node-2'] } }],
    entry_points: [{ id: 'entry-users', name: 'GET /users', type: 'http', handler: { file: 'src/users/users.controller.ts' } }],
    test_summary: { total_tests: 12, coverage: { lines: 82 } },
    ...overrides,
  };
}

for (const status of ['partial', 'rejected', 'unavailable'] as const) {
  test('spot-read quality cannot pass an explicitly ' + status + ' catalog with attractive capability names', () => {
    const cas = baseCas();
    cas.enhanced_system_purpose.capability_catalog_coverage = {
      status, evidence_families: 0, published_capabilities: 1,
      reason: 'provider-request-budget-exhausted',
    };
    const result = evaluateSpotReadCas(cas);
    const quality = result.gates.find(value => value.id === 'capability-quality');
    assert.equal(quality?.status, 'fail');
    assert.match(quality?.detail || '', new RegExp(status));
    assert.match(quality?.detail || '', /provider-request-budget-exhausted/);
    assert.equal(result.status, 'fail');
    assert.equal(result.summary.capabilities, 1);
    cas.enhanced_system_purpose.capability_catalog_coverage.status = 'accepted';
    assert.equal(evaluateSpotReadCas(cas).gates.find(value => value.id === 'capability-quality')?.status, 'pass');
  });
}

test('spot-read quality passes strong behavior-oriented analysis output', () => {
  const result = evaluateSpotReadCas(baseCas(), '/tmp/sample.json');
  assert.equal(result.status, 'pass');
  assert.equal(result.summary.weak_capabilities.length, 0);
});

test('spot-read quality recognizes evidence retained by the product-map projection', () => {
  const capabilities = [
    ['Find owners by pet', ['Owner', 'Pet']],
    ['Record pet visits', ['Visit']],
    ['Find veterinarians by specialty', ['Vet', 'Specialty']],
    ['Ask questions about clinic records', ['Owner', 'Pet', 'Vet']],
  ].map(([name], index) => ({
    id: `cap-${index}`,
    name,
    description: `Customers can ${String(name).toLowerCase()} using the clinic information available to them.`,
    operations: [{ path_or_command: `/capability/${index}` }],
  }));
  const productMapCapabilities = capabilities.map((capability, index) => ({
    name: capability.name,
    description: capability.description,
    entities: index === 3 ? [] : ['Owner'],
    journeys: index === 3 ? [{ id: 'journey-chat', name: 'Ask a clinic question' }] : [],
  }));
  const result = evaluateSpotReadCas(baseCas({
    enhanced_system_purpose: {
      primary_domain: 'pet-clinic',
      inferred_description: 'This pet clinic application helps staff find owners and veterinarians, maintain pet records, record visits, and answer questions about clinic information. It keeps those connected behaviors visible for review and change planning.',
      description_source: 'ai',
      description_generation: { attempted: true, status: 'ai_applied' },
    },
    capabilities,
    product_map: { capabilities: productMapCapabilities },
  }), '/tmp/projected.json');

  const capabilityGate = result.gates.find(gate => gate.id === 'capability-quality');
  assert.equal(capabilityGate?.status, 'pass');
  assert.doesNotMatch(capabilityGate?.detail || '', /do not match domain/);
});

test('spot-read quality accepts developer-facing library outcomes grounded by catalog provenance', () => {
  const capabilities = [
    'Route requests to handlers',
    'Parse requests with extractors',
    'Generate HTTP responses',
    'Share middleware across applications',
  ].map((name, index) => ({
    id: `library-cap-${index}`,
    name,
    description: `Application developers can ${name.toLowerCase()} with predictable behavior and minimal integration code.`,
    criticality_factors: [`catalog-candidate:public-api-${index}`],
  }));
  const result = evaluateSpotReadCas(baseCas({
    system_purpose: { primary_type: 'library-package', confidence: 0.9 },
    enhanced_system_purpose: {
      primary_domain: 'http-routing-library',
      inferred_description: 'This HTTP routing library helps application developers route requests, parse inputs, generate responses, and compose reusable middleware. Its public interfaces support predictable request handling without imposing an application architecture.',
      description_source: 'ai',
      description_generation: { attempted: true, status: 'ai_applied' },
    },
    capabilities,
    product_map: {
      capabilities: capabilities.map(capability => ({
        name: capability.name,
        description: capability.description,
        entities: [],
        journeys: [],
      })),
    },
  }), '/tmp/library.json');

  const capabilityGate = result.gates.find(gate => gate.id === 'capability-quality');
  assert.equal(capabilityGate?.status, 'pass');
});

test('spot-read quality fails stale narrative, weak capabilities, missing patterns, false idioms, and empty coverage', () => {
  const result = evaluateSpotReadCas(baseCas({
    system_purpose: { primary_type: 'sync-service', confidence: 0.1 },
    enhanced_system_purpose: {
      primary_domain: 'authentication',
      inferred_description: 'A sample system built with NestJS. Key capabilities: Changepassword Workflow. Data model: User. Entry points: 1 http. Integrations: Database.',
      description_source: 'reused',
      description_generation: { attempted: false, status: 'reused_previous', reason: 'ai-unavailable-on-full-rebuild', may_be_stale: true },
    },
    capabilities: [{
      id: 'cap-change-password',
      name: 'Changepassword Workflow',
      description: 'Changepassword Workflow handles operations for changepassword handlers.',
    }],
    architecture_summary: {
      system_type: 'NestJS service',
      architectural_patterns: [],
      architectural_inventory: {},
      pattern_balance: { status: 'balanced' },
    },
    codebase_idioms: [{
      category: 'migrations',
      name: 'Schema changes go through views/home/components/',
      confidence: 0.8,
      evidence: [{ file: 'views/home/components/Card.tsx' }],
      positive_examples: [{ file: 'views/home/components/Card.tsx' }],
      agent_guidance: { do: [], avoid: [], validation: [] },
    }],
    entities: [],
    domain_concepts: [],
    entry_points: [{ id: 'entry-test', name: 'test', type: 'test' }],
    test_summary: { total_tests: 10, coverage: {} },
  }), '/tmp/weak.json');

  assert.equal(result.status, 'fail');
  assert.ok(result.gates.find(gate => gate.id === 'purpose-coherence')?.status === 'fail');
  assert.ok(result.gates.find(gate => gate.id === 'narrative-provenance')?.status === 'fail');
  assert.ok(result.gates.find(gate => gate.id === 'capability-quality')?.status === 'fail');
  assert.ok(result.gates.find(gate => gate.id === 'architecture-patterns')?.status === 'fail');
  assert.ok(result.gates.find(gate => gate.id === 'idiom-precision')?.status === 'fail');
  assert.ok(result.gates.find(gate => gate.id === 'coverage-serialization')?.status === 'fail');
});
