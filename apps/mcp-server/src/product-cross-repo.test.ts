import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCrossRepositoryLinks, buildCrossRepoJourneys, buildCrossRepoRouteDrift } from './product';
import { getCrossRepoContracts } from './analysis-mastery';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

function makeCas(name: string, overrides: Record<string, unknown> = {}): CASOutput {
  return {
    cas_version: '1.10.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: `analysis-${name}`,
    system: { id: name, name, type: 'service', root_path: `/tmp/${name}` },
    nodes: [],
    edges: [],
    analyzer_contributions: [],
    ...overrides,
  } as unknown as CASOutput;
}

function repo(name: string, cas: CASOutput) {
  return { path: `/tmp/${name}`, name, cas };
}

function frontendCas(overrides: Record<string, unknown> = {}): CASOutput {
  return makeCas('frontend', {
    nodes: [
      {
        id: 'node-things-service-method',
        type: 'method',
        name: 'getThing',
        source: { file: 'src/app/services/things.service.ts', line: 12 },
      },
      {
        id: 'node-things-component-import',
        type: 'import',
        name: 'ThingsService',
        source: { file: 'src/app/things/things-page.component.ts', line: 2 },
        metadata: { source: '../services/things.service' },
      },
    ],
    exit_points: [
      {
        id: 'exit-get-thing',
        type: 'api',
        name: 'getThing',
        source_node: 'node-things-service-method',
        target: { endpoint: '/api/things/${ id }' },
        operation: { method: 'GET' },
      },
    ],
    ...overrides,
  });
}

function backendCas(overrides: Record<string, unknown> = {}): CASOutput {
  return makeCas('backend', {
    nodes: [
      {
        id: 'node-things-controller',
        type: 'controller',
        name: 'ThingController',
        source: { file: 'src/Controller/Api/ThingController.php', line: 10 },
      },
      {
        id: 'node-things-handler',
        type: 'method',
        name: 'detail',
        source: { file: 'src/Controller/Api/ThingController.php', line: 30 },
      },
      {
        id: 'node-things-use-service',
        type: 'use',
        name: 'App\\Service\\Thing\\ThingManager',
        source: { file: 'src/Controller/Api/ThingController.php', line: 5 },
      },
      {
        id: 'node-things-use-entity',
        type: 'use',
        name: 'App\\Entity\\Thing',
        source: { file: 'src/Controller/Api/ThingController.php', line: 6 },
      },
    ],
    entry_points: [
      {
        id: 'entry-get-thing',
        type: 'http',
        name: 'GET /api/things/{thingId}',
        source_node: 'node-things-handler',
        trigger: { method: 'GET', path: '/api/things/{thingId}' },
        handler: {
          node_id: 'node-things-handler',
          method_name: 'detail',
          file: 'src/Controller/Api/ThingController.php',
          line: 30,
        },
      },
    ],
    entities: [
      { id: 'entity-thing', name: 'Thing', lifecycle: {} },
    ],
    ...overrides,
  });
}

test('frontend template-literal HTTP call links to backend route with path-parameter normalization', () => {
  const result = buildCrossRepositoryLinks([repo('frontend', frontendCas()), repo('backend', backendCas())]);
  const apiLinks = result.links.filter(link => link.type === 'api');

  assert.equal(apiLinks.length, 1);
  const link = apiLinks[0];
  assert.equal(link.source_repository?.path, '/tmp/frontend');
  assert.equal(link.target_repository?.path, '/tmp/backend');
  assert.equal(link.connection?.endpoint, '/api/things/{thingId}');
  assert.equal(link.connection?.method, 'GET');
  assert.ok((link.metadata?.confidence || 0) >= 0.9);
});

test('prefixed client routes match provider suffixes with framework wildcard segments', () => {
  const frontend = frontendCas({
    exit_points: [{
      id: 'exit-events',
      type: 'api',
      name: 'getEvents',
      source_node: 'node-things-service-method',
      target: { endpoint: '/api/orders/customers/:customerId/items/:itemId/events' },
      operation: { method: 'GET' },
    }],
  });
  const backend = backendCas({
    entry_points: [{
      id: 'entry-events',
      type: 'http',
      name: 'GET customers/*/items/:itemId/events',
      source_node: 'node-things-handler',
      trigger: { method: 'GET', path: 'customers/*/items/:itemId/events' },
      handler: { node_id: 'node-things-handler', method_name: 'events', file: 'src/events.ts', line: 1 },
    }],
  });

  const result = buildCrossRepositoryLinks([repo('orders-frontend', frontend), repo('orders-backend', backend)]);

  assert.equal(result.links.filter(link => link.type === 'api').length, 1);
  assert.equal(result.links[0].connection?.endpoint, 'customers/*/items/:itemId/events');
});

test('unrelated frontend paths do not link to backend routes', () => {
  const frontend = frontendCas({
    exit_points: [
      {
        id: 'exit-get-widget',
        type: 'api',
        name: 'getWidget',
        source_node: 'node-things-service-method',
        target: { endpoint: '/api/widgets/${ id }' },
        operation: { method: 'GET' },
      },
    ],
  });
  const result = buildCrossRepositoryLinks([repo('frontend', frontend), repo('backend', backendCas())]);

  assert.equal(result.links.filter(link => link.type === 'api').length, 0);
});

test('single-segment routes require independent domain evidence in both repositories', () => {
  const routeConcept = (id: string, name: string) => ({
    id,
    name,
    frequency: 2,
    appears_in: { entry_points: [], entities: [], nodes: [] },
    classification: 'core' as const,
  });
  const consumer = frontendCas({
    domain_concepts: [routeConcept('concept-consumer-shipment', 'Shipment')],
    exit_points: [{
      id: 'exit-shipments',
      type: 'api',
      name: 'loadShipments',
      source_node: 'node-things-service-method',
      target: { endpoint: '/shipments' },
      operation: { method: 'GET' },
    }],
  });
  const producer = backendCas({
    domain_concepts: [routeConcept('concept-producer-shipment', 'Shipments')],
    entry_points: [{
      id: 'entry-shipments',
      type: 'http',
      name: 'GET /shipments',
      source_node: 'node-things-handler',
      trigger: { method: 'GET', path: '/shipments' },
    }],
  });

  const links = buildCrossRepositoryLinks([repo('consumer', consumer), repo('producer', producer)]).links;
  assert.equal(links.filter(link => link.type === 'api').length, 1);
});

test('an exact ubiquitous single-segment route is not linked without independent domain evidence', () => {
  const consumer = frontendCas({
    domain_concepts: [],
    exit_points: [{
      id: 'exit-records',
      type: 'api',
      name: 'loadRecords',
      source_node: 'node-things-service-method',
      target: { endpoint: '/api/v1/records' },
      operation: { method: 'GET' },
    }],
  });
  const producer = backendCas({
    domain_concepts: [],
    entry_points: [{
      id: 'entry-records',
      type: 'http',
      name: 'GET /api/v1/records',
      source_node: 'node-things-handler',
      trigger: { method: 'GET', path: '/api/v1/records' },
    }],
  });

  const links = buildCrossRepositoryLinks([repo('consumer', consumer), repo('producer', producer)]).links;
  assert.equal(links.filter(link => link.type === 'api').length, 0);
});

test('provider domain evidence resolves a single-segment seam without client-side concepts', () => {
  const consumer = frontendCas({
    domain_concepts: [],
    exit_points: [{ id: 'exit-jobs', type: 'api', name: 'jobs', source_node: 'node-things-service-method', target: { endpoint: '/jobs' }, operation: { method: 'GET' } }],
  });
  const producer = backendCas({
    domain_concepts: [{ id: 'concept-jobs', name: 'Jobs', frequency: 2, appears_in: { entry_points: [], entities: [], nodes: [] }, classification: 'core' }],
    entry_points: [{ id: 'entry-jobs', type: 'http', name: 'GET /jobs', source_node: 'node-things-handler', trigger: { method: 'GET', path: '/jobs' } }],
  });

  const links = buildCrossRepositoryLinks([repo('consumer', consumer), repo('producer', producer)]).links;
  assert.equal(links.filter(link => link.type === 'api').length, 1);
});

test('a shared generic workspace parent does not create repository affinity', () => {
  const consumer = {
    path: '/tmp/analysis-input/consumer',
    name: 'consumer',
    cas: frontendCas({
      exit_points: [{
        id: 'exit-generic-doc',
        type: 'api',
        name: 'GET /docs',
        source_node: 'node-things-service-method',
        target: { endpoint: '/docs' },
        operation: { method: 'GET' },
      }],
    }),
  };
  const producer = {
    path: '/tmp/analysis-input/producer',
    name: 'producer',
    cas: backendCas({
      entry_points: [{
        id: 'entry-generic-id',
        type: 'http',
        name: 'GET /:id',
        source_node: 'node-things-handler',
        trigger: { method: 'GET', path: '/:id' },
        handler: { node_id: 'node-things-handler', method_name: 'detail', file: 'src/controller.ts', line: 1 },
      }],
    }),
  };

  const result = buildCrossRepositoryLinks([consumer, producer]);

  assert.equal(result.links.filter(link => link.type === 'api').length, 0);
  assert.equal(result.conflicts.length, 0);
});

test('a parameter-only provider route does not claim an unrelated literal consumer route', () => {
  const consumer = frontendCas({
    exit_points: [{
      id: 'exit-docs',
      type: 'api',
      name: 'docs',
      source_node: 'node-things-service-method',
      target: { endpoint: 'http://localhost:8000/docs' },
      operation: { method: 'GET' },
    }],
  });
  const producer = backendCas({
    entry_points: [{
      id: 'entry-id',
      type: 'http',
      name: 'GET /:id',
      source_node: 'node-things-handler',
      trigger: { method: 'GET', path: '/:id' },
      handler: { node_id: 'node-things-handler', method_name: 'detail', file: 'src/controller.ts', line: 1 },
    }],
  });

  const result = buildCrossRepositoryLinks([repo('consumer', consumer), repo('producer', producer)]);

  assert.equal(result.links.filter(link => link.type === 'api').length, 0);
  assert.equal(result.conflicts.length, 0);
});

test('generic ORM resource labels do not fabricate a shared database', () => {
  const first = makeCas('first', {
    exit_points: [{ id: 'first-orm', source_node: 'first-node', type: 'database', name: 'orm', target: { resource: 'orm' } }],
  });
  const second = makeCas('second', {
    exit_points: [{ id: 'second-orm', source_node: 'second-node', type: 'database', name: 'orm', target: { resource: 'orm' } }],
  });

  const result = buildCrossRepositoryLinks([repo('first', first), repo('second', second)]);
  assert.equal(result.links.filter(link => link.type === 'shared-database').length, 0);
});

test('matching concrete database endpoints establish a shared database without exposing credentials', () => {
  const first = makeCas('first', {
    exit_points: [{ id: 'first-db', source_node: 'first-node', type: 'database', name: 'orders', target: { endpoint: 'postgresql://writer:secret@orders-db.internal:5432/orders' } }],
  });
  const second = makeCas('second', {
    exit_points: [{ id: 'second-db', source_node: 'second-node', type: 'database', name: 'orders', target: { endpoint: 'postgresql://reader:different@orders-db.internal:5432/orders' } }],
  });

  const result = buildCrossRepositoryLinks([repo('first', first), repo('second', second)]);
  const links = result.links.filter(link => link.type === 'shared-database');
  assert.equal(links.length, 1);
  assert.equal((links[0].connection as any)?.resource, 'postgresql://orders-db.internal:5432/orders');
  assert.doesNotMatch(JSON.stringify(links[0]), /secret|different/);
});

test('unresolved dynamic prefix matches backend route by literal suffix', () => {
  const frontend = frontendCas({
    exit_points: [
      {
        id: 'exit-get-companies',
        type: 'api',
        name: 'getCompanies',
        source_node: 'node-things-service-method',
        target: { endpoint: '${ this.pathPrefixWeb }/companies' },
        operation: { method: 'GET' },
      },
    ],
  });
  const backend = backendCas({
    entry_points: [
      {
        id: 'entry-get-companies',
        type: 'http',
        name: 'GET /api/web/companies',
        source_node: 'node-things-handler',
        trigger: { method: 'GET', path: '/api/web/companies' },
        handler: {
          node_id: 'node-things-handler',
          method_name: 'list',
          file: 'src/Controller/Api/ThingController.php',
          line: 30,
        },
      },
    ],
  });
  const result = buildCrossRepositoryLinks([repo('frontend', frontend), repo('backend', backend)]);
  const apiLinks = result.links.filter(link => link.type === 'api');

  assert.equal(apiLinks.length, 1);
  assert.equal(apiLinks[0].connection?.endpoint, '/api/web/companies');
  assert.ok((apiLinks[0].metadata?.confidence || 0) < 0.9);
});

test('dynamic prefix does not match a route with a different literal suffix', () => {
  const frontend = frontendCas({
    exit_points: [
      {
        id: 'exit-get-companies',
        type: 'api',
        name: 'getCompanies',
        source_node: 'node-things-service-method',
        target: { endpoint: '${ this.pathPrefixWeb }/companies' },
        operation: { method: 'GET' },
      },
    ],
  });
  const result = buildCrossRepositoryLinks([repo('frontend', frontend), repo('backend', backendCas())]);

  assert.equal(result.links.filter(link => link.type === 'api').length, 0);
});

test('non-path exit targets are ignored', () => {
  const frontend = frontendCas({
    exit_points: [
      {
        id: 'exit-noise-1',
        type: 'api',
        name: 'GET external',
        source_node: 'node-things-service-method',
        target: { endpoint: 'GET external' },
        operation: { method: 'GET' },
      },
      {
        id: 'exit-noise-2',
        type: 'api',
        name: 'LINK',
        source_node: 'node-things-service-method',
        target: { endpoint: 'LINK' },
        operation: { method: 'REQUEST' },
      },
    ],
  });
  const result = buildCrossRepositoryLinks([repo('frontend', frontend), repo('backend', backendCas())]);

  assert.equal(result.links.filter(link => link.type === 'api').length, 0);
});

test('shared entity structure reinforces repositories already connected by a concrete contract', () => {
  const frontend = frontendCas({
    nodes: [
      {
        id: 'node-frontend-thing-model',
        type: 'class',
        name: 'Thing',
        source: { file: 'src/app/models/thing.model.ts', line: 1 },
      },
      {
        id: 'node-frontend-user-model',
        type: 'class',
        name: 'User',
        source: { file: 'src/app/models/user.model.ts', line: 1 },
      },
    ],
    exit_points: [{
      id: 'exit-thing-list',
      type: 'api',
      name: 'GET /api/things',
      source_node: 'node-frontend-thing-model',
      target: { endpoint: '/api/things' },
      operation: { method: 'GET' },
    }],
    entities: [
      {
        id: 'entity-thing',
        name: 'Thing',
        fields: [
          { name: 'id', type: 'string', is_sensitive: false },
          { name: 'name', type: 'string', is_sensitive: false },
        ],
        lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] },
      },
    ],
  });
  const backend = backendCas({
    nodes: [
      {
        id: 'node-backend-thing-entity',
        type: 'class',
        name: 'Thing',
        source: { file: 'src/Entity/Thing.php', line: 8 },
      },
      {
        id: 'node-backend-user-entity',
        type: 'class',
        name: 'User',
        source: { file: 'src/Entity/User.php', line: 8 },
      },
    ],
    entities: [
      {
        id: 'entity-thing',
        name: 'Thing',
        fields: [
          { name: 'id', type: 'string', is_sensitive: false },
          { name: 'name', type: 'string', is_sensitive: false },
          { name: 'createdAt', type: 'date', is_sensitive: false },
        ],
        lifecycle: {},
      },
      { id: 'entity-user', name: 'User', lifecycle: {} },
    ],
    entry_points: [{
      id: 'entry-thing-list',
      type: 'http',
      name: 'GET /api/things',
      source_node: 'node-backend-thing-entity',
      trigger: { method: 'GET', path: '/api/things' },
      handler: { node_id: 'node-backend-thing-entity', method_name: 'list', file: 'src/Entity/Thing.php', line: 8 },
    }],
  });
  const result = buildCrossRepositoryLinks([repo('things-frontend', frontend), repo('things-backend', backend)]);
  const sharedSchema = result.links.filter(link => link.type === 'shared-schema');

  assert.equal(sharedSchema.length, 1);
  assert.equal(sharedSchema[0].connection?.contract, 'Thing');
  assert.ok(sharedSchema[0].source_repository?.node_ids?.includes('node-frontend-thing-model'));
  assert.ok(sharedSchema[0].target_repository?.node_ids?.includes('node-backend-thing-entity'));
});

test('matching entity names and shapes do not link repositories without relationship evidence', () => {
  const entity = {
    id: 'entity-invoice',
    name: 'Invoice',
    fields: [
      { name: 'id', type: 'string', is_sensitive: false },
      { name: 'total', type: 'number', is_sensitive: false },
      { name: 'status', type: 'string', is_sensitive: false },
    ],
    lifecycle: {},
  };
  const first = makeCas('first', {
    nodes: [{ id: 'first-invoice', type: 'class', name: 'Invoice', source: { file: 'src/invoice.ts', line: 1 } }],
    entities: [entity],
  });
  const second = makeCas('second', {
    nodes: [{ id: 'second-invoice', type: 'class', name: 'Invoice', source: { file: 'src/invoice.ts', line: 1 } }],
    entities: [{ ...entity, id: 'other-invoice' }],
  });

  const result = buildCrossRepositoryLinks([repo('billing', first), repo('accounting', second)]);

  assert.equal(result.links.filter(link => link.type === 'shared-schema').length, 0);
});

test('namespace imports link a consumer to the repository that defines the class', () => {
  const consumer = makeCas('consumer', {
    nodes: [
      {
        id: 'node-use-cardmanagement',
        type: 'use',
        name: 'TruckSpy\\Wex\\Client\\Soap\\CardManagement\\CardManagementWS',
        source: { file: 'src/Service/WexProvider.php', line: 4 },
      },
    ],
  });
  const producer = makeCas('wex-client', {
    nodes: [
      {
        id: 'node-cardmanagement-class',
        type: 'class',
        name: 'CardManagementWS',
        source: { file: 'src/Client/Soap/CardManagement/CardManagementWS.php', line: 10 },
      },
    ],
  });
  const result = buildCrossRepositoryLinks([repo('consumer', consumer), repo('wex-client', producer)]);
  const libraryLinks = result.links.filter(link => link.type === 'library');

  assert.equal(libraryLinks.length, 1);
  assert.equal(libraryLinks[0].connection?.contract, 'TruckSpy\\Wex\\Client\\Soap\\CardManagement\\CardManagementWS');
  assert.equal(libraryLinks[0].target_repository?.node_ids?.[0], 'node-cardmanagement-class');
});

test('namespace imports do not link when the file path does not mirror the namespace', () => {
  const consumer = makeCas('consumer', {
    nodes: [
      {
        id: 'node-use-cardmanagement',
        type: 'use',
        name: 'TruckSpy\\Wex\\Client\\Soap\\CardManagement\\CardManagementWS',
        source: { file: 'src/Service/WexProvider.php', line: 4 },
      },
    ],
  });
  const producer = makeCas('other-lib', {
    nodes: [
      {
        id: 'node-unrelated-class',
        type: 'class',
        name: 'CardManagementWS',
        source: { file: 'src/Totally/Different/CardManagementWS.php', line: 10 },
      },
    ],
  });
  const result = buildCrossRepositoryLinks([repo('consumer', consumer), repo('other-lib', producer)]);

  assert.equal(result.links.filter(link => link.type === 'library').length, 0);
});

test('cross-repo journeys compose UI action file, HTTP call, backend handler, service, and terminal entity', () => {
  const repositories = [repo('frontend', frontendCas()), repo('backend', backendCas())];
  const result = buildCrossRepositoryLinks(repositories);
  const journeys = buildCrossRepoJourneys(repositories, result.links);

  assert.equal(journeys.length, 1);
  const journey = journeys[0];
  assert.equal(journey.consumer.repository, 'frontend');
  assert.deepEqual(journey.consumer.action_files, ['src/app/things/things-page.component.ts']);
  assert.equal(journey.consumer.call_file, 'src/app/services/things.service.ts');
  assert.equal(journey.consumer.call_symbol, 'getThing');
  assert.equal(journey.http.method, 'GET');
  assert.equal(journey.http.route, '/api/things/{thingId}');
  assert.equal(journey.provider.repository, 'backend');
  assert.equal(journey.provider.handler, 'ThingController::detail');
  assert.equal(journey.provider.handler_file, 'src/Controller/Api/ThingController.php');
  assert.deepEqual(journey.provider.services, ['ThingManager']);
  assert.deepEqual(journey.provider.terminal_entities, ['Thing']);
});

test('getCrossRepoContracts returns a usable contract table and journeys', () => {
  const repositories = [repo('frontend', frontendCas()), repo('backend', backendCas())];
  const contracts = getCrossRepoContracts(repositories, { journey_limit: 5 });

  assert.equal(contracts.contract_table.length, 1);
  const row = contracts.contract_table[0];
  assert.equal(row.method, 'GET');
  assert.equal(row.route, '/api/things/{thingId}');
  assert.equal(row.consumer_repository, 'frontend');
  assert.equal(row.consumer_file, 'src/app/services/things.service.ts');
  assert.equal(row.provider_repository, 'backend');
  assert.equal(row.provider_handler, 'ThingController::detail');
  assert.equal(row.provider_file, 'src/Controller/Api/ThingController.php');
  assert.equal(contracts.journeys.length, 1);
});

test('UI call with no backend route surfaces as missing-route drift with consumer evidence', () => {
  const frontend = frontendCas({
    exit_points: [
      {
        id: 'exit-ack-notifications',
        type: 'api',
        name: 'ackNotifications',
        source_node: 'node-things-service-method',
        target: { endpoint: '/api/common/notifications/ack' },
        operation: { method: 'PATCH' },
      },
    ],
  });
  const drift = buildCrossRepoRouteDrift([repo('frontend', frontend), repo('backend', backendCas())]);

  assert.equal(drift.length, 1);
  const finding = drift[0];
  assert.equal(finding.kind, 'missing-route');
  assert.equal(finding.method, 'PATCH');
  assert.equal(finding.path, '/api/common/notifications/ack');
  assert.equal(finding.consumer_repo, 'frontend');
  assert.equal(finding.consumer_file, 'src/app/services/things.service.ts');
  assert.equal(finding.consumer_symbol, 'getThing');
  assert.ok(finding.confidence >= 0.8);
});

test('UI call to a renamed route surfaces as near-miss drift with the nearest backend route', () => {
  const frontend = frontendCas({
    exit_points: [
      {
        id: 'exit-list-thing',
        type: 'api',
        name: 'listThing',
        source_node: 'node-things-service-method',
        target: { endpoint: '/api/thing' },
        operation: { method: 'GET' },
      },
    ],
  });
  const backend = backendCas({
    entry_points: [
      {
        id: 'entry-list-things',
        type: 'http',
        name: 'GET /api/things',
        source_node: 'node-things-handler',
        trigger: { method: 'GET', path: '/api/things' },
        handler: {
          node_id: 'node-things-handler',
          method_name: 'list',
          file: 'src/Controller/Api/ThingController.php',
          line: 30,
        },
      },
    ],
  });
  const drift = buildCrossRepoRouteDrift([repo('frontend', frontend), repo('backend', backend)]);

  assert.equal(drift.length, 1);
  const finding = drift[0];
  assert.equal(finding.kind, 'near-miss');
  assert.equal(finding.path, '/api/thing');
  assert.equal(finding.nearest_backend_route?.path, '/api/things');
  assert.equal(finding.nearest_backend_route?.provider_repo, 'backend');
  assert.ok((finding.nearest_backend_route?.similarity || 0) >= 0.7);
});

test('external full-origin URLs are not route drift candidates', () => {
  const frontend = frontendCas({
    exit_points: [
      {
        id: 'exit-mapbox',
        type: 'api',
        name: 'geocode',
        source_node: 'node-things-service-method',
        target: { endpoint: 'https://api.mapbox.com/geocoding/v5/mapbox.places/austin.json' },
        operation: { method: 'GET' },
      },
      {
        id: 'exit-weather',
        type: 'api',
        name: 'forecast',
        source_node: 'node-things-service-method',
        target: { endpoint: 'https://api.weather.gov/points/30.26,-97.74' },
        operation: { method: 'GET' },
      },
    ],
  });
  const drift = buildCrossRepoRouteDrift([repo('frontend', frontend), repo('backend', backendCas())]);

  assert.equal(drift.length, 0);
});

test('matched UI calls do not appear as route drift', () => {
  const drift = buildCrossRepoRouteDrift([repo('frontend', frontendCas()), repo('backend', backendCas())]);

  assert.equal(drift.length, 0);
});

test('getCrossRepoContracts reports route drift with summary-first discipline', () => {
  const frontend = frontendCas({
    exit_points: [
      {
        id: 'exit-ack-notifications',
        type: 'api',
        name: 'ackNotifications',
        source_node: 'node-things-service-method',
        target: { endpoint: '/api/common/notifications/ack' },
        operation: { method: 'PATCH' },
      },
    ],
  });
  const contracts = getCrossRepoContracts([repo('frontend', frontend), repo('backend', backendCas())]);

  assert.equal(contracts.route_drift_summary.total, 1);
  assert.equal(contracts.route_drift_summary.missing_route, 1);
  assert.equal(contracts.route_drift_summary.near_miss, 0);
  assert.equal(contracts.route_drift.length, 1);
  assert.equal(contracts.route_drift[0].path, '/api/common/notifications/ack');
  assert.ok(contracts.route_drift.length <= 10);
});
