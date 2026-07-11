import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRealWorkspaceAiAttempt, buildCrossCodebaseSystemGraph, buildWorkspaceAgentContext, detectWorkspaceCryptoProfile, enrichWorkspaceAnalysisNarrative, evaluateWorkspaceNarrativeGate, selectPreferredWorkspaceOllamaModel, selectWorkspaceAnalysisDetail, workspaceNarrativeHardRejectReason } from './cross-codebase-analysis';
import { aiService } from '../../../packages/analyzer-core/src/ai/ai-service';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

function cas(overrides: Partial<CASOutput>): CASOutput {
  return {
    cas_version: '1.10.0',
    analysis_timestamp: '2026-01-01T00:00:00.000Z',
    analysis_id: 'analysis',
    system: {
      id: 'system',
      name: 'system',
      type: 'application',
      root_path: '/tmp/system',
      technologies: {},
    },
    nodes: [],
    edges: [],
    analyzer_contributions: [],
    progressive_levels: { total_levels: 1 },
    ...overrides,
  } as CASOutput;
}

test('builds outer graph with http, sdk, message, passive data, and unmatched interfaces', () => {
  const api = cas({
    system: { id: 'api', name: 'accounts-api', type: 'service', root_path: '/tmp/accounts-api' },
    nodes: [{ id: 'route-node', name: 'getAccount', type: 'function', source: { file: 'src/accounts.ts', line: 10 } } as any],
    entry_points: [{
      id: 'entry:get-account',
      source_node: 'route-node',
      type: 'http',
      name: 'GET /api/accounts/:id',
      trigger: { method: 'GET', path: '/api/accounts/:id' },
    }],
    exit_points: [{
      id: 'exit:account-updated',
      source_node: 'route-node',
      type: 'message',
      name: 'account.updated',
      target: { resource: 'account.updated' },
      data: { output_type: 'AccountUpdated' },
    }, {
      id: 'exit:db-accounts',
      source_node: 'route-node',
      type: 'database',
      name: 'accounts',
      target: { resource: 'accounts' },
    }],
  });
  const web = cas({
    system: { id: 'web', name: 'accounts-web', type: 'application', root_path: '/tmp/accounts-web' },
    nodes: [{ id: 'panel-node', name: 'AccountPanel', type: 'component', source: { file: 'src/AccountPanel.tsx', line: 4 } } as any],
    exit_points: [{
      id: 'exit:get-account',
      source_node: 'panel-node',
      type: 'api',
      name: 'fetch account',
      target: { endpoint: 'http://accounts-api/api/accounts/123', service_id: 'accounts-api' },
      operation: { method: 'GET' },
    }],
    dependencies: {
      manager: 'npm',
      packages: [{ name: '@klauro/sdk', version: '1.0.0', direct: true }],
    },
  });
  const worker = cas({
    system: { id: 'worker', name: 'accounts-worker', type: 'service', root_path: '/tmp/accounts-worker' },
    nodes: [{ id: 'listener-node', name: 'AccountUpdatedListener', type: 'function', source: { file: 'src/listener.ts', line: 7 } } as any],
    entry_points: [{
      id: 'entry:account-updated',
      source_node: 'listener-node',
      type: 'message',
      name: 'account.updated',
      trigger: { event: 'account.updated' },
      input: { schema: 'AccountUpdated' },
    }],
  });
  const sdk = cas({
    system: {
      id: 'sdk',
      name: '@klauro/sdk',
      type: 'package',
      root_path: '/tmp/klauro-sdk',
      metadata: { package_name: '@klauro/sdk' },
    },
    nodes: [{ id: 'sdk-node', name: 'KlaurSdk', type: 'module', source: { file: 'src/index.ts', line: 1 } } as any],
  });

  const graph = buildCrossCodebaseSystemGraph('test-system', [
    { path: '/tmp/accounts-api', name: 'accounts-api', cas: api },
    { path: '/tmp/accounts-web', name: 'accounts-web', cas: web },
    { path: '/tmp/accounts-worker', name: 'accounts-worker', cas: worker },
    { path: '/tmp/klauro-sdk', name: '@klauro/sdk', cas: sdk },
  ], { generatedAt: '2026-01-01T00:00:00.000Z' });

  assert.equal(graph.codebase_count, 4);
  assert.ok(graph.interfaces.some(item => item.kind === 'http-api' && item.role === 'provider'));
  assert.ok(graph.interfaces.some(item => item.kind === 'sdk' && item.role === 'provider'));
  assert.ok(graph.links.some(link => link.kind === 'http-call'));
  assert.ok(graph.links.some(link => link.kind === 'message-flow'));
  assert.ok(graph.links.some(link => link.kind === 'sdk-install'));
  assert.ok(graph.interfaces.some(item => item.kind === 'passive-data'));
  assert.ok(Array.isArray(graph.unmatched_interfaces));
});

test('matches deployment service aliases from container topology facts', () => {
  const api = cas({
    system: { id: 'api', name: 'accounts-api', type: 'service', root_path: '/tmp/accounts-api' },
    nodes: [{ id: 'compose-api', name: 'Compose service: accounts-api', type: 'compose_service' } as any],
    entry_points: [{
      id: 'entry:compose-api',
      source_node: 'compose-api',
      type: 'http',
      name: 'Compose service accounts-api:8080',
      trigger: { method: 'ALL', path: 'http://accounts-api:8080' },
      metadata: { service_aliases: ['accounts-api'], deployment_service_name: 'accounts-api' },
    }],
  });
  const web = cas({
    system: { id: 'web', name: 'accounts-web', type: 'application', root_path: '/tmp/accounts-web' },
    nodes: [{ id: 'compose-web', name: 'Compose service: web', type: 'compose_service' } as any],
    exit_points: [{
      id: 'exit:compose-dep',
      source_node: 'compose-web',
      type: 'api',
      name: 'Compose dependency web -> accounts-api',
      target: { endpoint: 'http://accounts-api', service_id: 'accounts-api' },
      operation: { method: 'FETCH' },
      metadata: { service_aliases: ['accounts-api'], deployment_service_name: 'accounts-api' },
    }],
  });

  const graph = buildCrossCodebaseSystemGraph('deployment-system', [
    { path: '/tmp/accounts-api', name: 'accounts-api', cas: api },
    { path: '/tmp/accounts-web', name: 'accounts-web', cas: web },
  ]);

  assert.ok(graph.links.some(link => link.kind === 'http-call' && link.source_codebase_id.includes('accounts-web') && link.target_codebase_id.includes('accounts-api')));
});

test('breaks monorepos into app-level cross-codebase links', () => {
  const api = cas({
    system: { id: 'api', name: 'zerac-api', type: 'service', root_path: '/tmp/zerac-api' },
    nodes: [
      { id: 'user-route', name: 'registerDevice', type: 'function', source: { file: '/tmp/zerac-api/apps/user-api/src/app.controller.ts', line: 10 } } as any,
      { id: 'admin-route', name: 'registerAgent', type: 'function', source: { file: '/tmp/zerac-api/apps/admin-api/src/agents.controller.ts', line: 20 } } as any,
    ],
    entry_points: [{
      id: 'entry:user-register-device',
      source_node: 'user-route',
      type: 'http',
      name: 'POST /register-device',
      trigger: { method: 'POST', path: '/register-device' },
    }, {
      id: 'entry:admin-register-agent',
      source_node: 'admin-route',
      type: 'http',
      name: 'POST /service/agents/register',
      trigger: { method: 'POST', path: '/service/agents/register' },
    }],
  });
  const poc = cas({
    system: { id: 'poc', name: 'poc', type: 'service', root_path: '/tmp/poc' },
    nodes: [
      { id: 'client-api', name: 'registerDevice', type: 'function', source: { file: '/tmp/poc/bin/client-service/src/api.rs', line: 181 } } as any,
      { id: 'drop-api', name: 'registerAgent', type: 'function', source: { file: '/tmp/poc/bin/drop-server/src/api.rs', line: 91 } } as any,
    ],
    exit_points: [{
      id: 'exit:user-register-device',
      source_node: 'client-api',
      type: 'api',
      name: 'register device',
      target: { endpoint: 'http://user-api/register-device' },
      operation: { method: 'POST', async: true },
    }, {
      id: 'exit:admin-register-agent',
      source_node: 'drop-api',
      type: 'api',
      name: 'register agent',
      target: { endpoint: 'http://admin-api/service/agents/register' },
      operation: { method: 'POST', async: true },
    }],
  });

  const graph = buildCrossCodebaseSystemGraph('zerac-system', [
    { path: '/tmp/zerac-api', name: 'zerac-api', cas: api },
    { path: '/tmp/poc', name: 'poc', cas: poc },
  ]);

  const appNames = new Map(graph.applications.map(app => [app.id, app.name]));
  assert.ok([...appNames.values()].includes('user-api'));
  assert.ok([...appNames.values()].includes('admin-api'));
  assert.ok([...appNames.values()].includes('client-service'));
  assert.ok([...appNames.values()].includes('drop-server'));
  assert.ok(graph.links.some(link =>
    appNames.get(link.source_application_id) === 'client-service' &&
    appNames.get(link.target_application_id) === 'user-api' &&
    link.kind === 'http-call'
  ));
  assert.ok(graph.links.some(link =>
    appNames.get(link.source_application_id) === 'drop-server' &&
    appNames.get(link.target_application_id) === 'admin-api' &&
    link.kind === 'http-call'
  ));
});

test('workspace analysis composes completed CAS outputs without source reads', () => {
  const zeracApi = cas({
    analysis_id: 'analysis:zerac-api',
    system: { id: 'api', name: 'zerac-api', type: 'service', root_path: '/tmp/zerac-api' },
    nodes: [
      { id: 'admin-route', name: 'AdminApi', type: 'function', source: { file: '/tmp/zerac-api/apps/admin-api/src/controller.ts', line: 1 } } as any,
      { id: 'internal-route', name: 'InternalApi', type: 'function', source: { file: '/tmp/zerac-api/apps/internal-api/src/controller.ts', line: 1 } } as any,
      { id: 'user-route', name: 'UserApi', type: 'function', source: { file: '/tmp/zerac-api/apps/user-api/src/controller.ts', line: 1 } } as any,
      { id: 'mcp-route', name: 'McpApi', type: 'function', source: { file: '/tmp/zerac-api/apps/mcp-api/src/access-requests.controller.ts', line: 1 } } as any,
      { id: 'agent-entity', name: 'Agent', type: 'entity', source: { file: '/tmp/zerac-api/apps/admin-api/src/agents/agent.entity.ts', line: 1 } } as any,
      { id: 'redis', name: 'Compose service: redis', type: 'compose_service', metadata: { topology_surface: 'docker-compose', deployment_service_name: 'redis', service_aliases: ['redis'] } } as any,
    ],
    entry_points: [{
      id: 'entry:admin',
      source_node: 'admin-route',
      type: 'http',
      name: 'POST /service/agents/register',
      trigger: { method: 'POST', path: '/service/agents/register' },
    }, {
      id: 'entry:internal',
      source_node: 'internal-route',
      type: 'http',
      name: 'GET /internal/health',
      trigger: { method: 'GET', path: '/internal/health' },
    }, {
      id: 'entry:user',
      source_node: 'user-route',
      type: 'http',
      name: 'POST /register-device',
      trigger: { method: 'POST', path: '/register-device' },
    }, {
      id: 'entry:mcp',
      source_node: 'mcp-route',
      type: 'http',
      name: 'POST /m2m/access-requests',
      trigger: { method: 'POST', path: '/m2m/access-requests' },
    }, {
      id: 'entry:redis',
      source_node: 'redis',
      type: 'http',
      name: 'Compose service redis',
      trigger: { method: 'ALL', path: 'http://redis' },
      metadata: { topology_surface: 'docker-compose', deployment_service_name: 'redis', service_aliases: ['redis'] },
    }],
    data_entities: [{
      id: 'entity:agent',
      name: 'Agent',
      description: 'Agent records describe enrolled device agents and their access state.',
      description_source: 'deterministic',
      fields: [{ name: 'token', type: 'string', is_sensitive: true }],
      lifecycle: {
        created_by: ['admin-route'],
        read_by: ['admin-route', 'mcp-route'],
        updated_by: ['admin-route'],
        deleted_by: [],
      },
    }],
    data_lineage: [{
      entity_id: 'entity:agent',
      entity_name: 'Agent',
      sensitive_fields: ['token'],
      writers: [{ node_id: 'admin-route', file: '/tmp/zerac-api/apps/admin-api/src/controller.ts', via: 'register agent' }],
      readers: [{ node_id: 'mcp-route', file: '/tmp/zerac-api/apps/mcp-api/src/access-requests.controller.ts', via: 'access request lookup' }],
      external_recipients: [{ exit_point_id: 'exit:drop-admin', service: 'drop-server', via_node: 'admin-route' }],
      boundaries_crossed: [{ boundary: 'service-auth', guarded: true, guard_kinds: ['authentication'] }],
      journeys_carrying: ['workflow:agent-registration'],
      exposure: { unguarded_paths: 0, external_transfer: true, sensitive: true },
    }],
    system_capabilities: [{
      id: 'capability:agent-access',
      name: 'Agent Access Brokerage',
      description: 'Agent Access Brokerage registers agents and exposes access request state to agent-facing surfaces.',
      category: 'system',
      criticality: 'critical',
      operations: [{ entry_point_id: 'entry:admin', action: 'register', path_or_command: '/service/agents/register' }],
      related_entities: ['Agent'],
      related_domains: ['Agent Access'],
      confidence: 0.86,
      evidence: ['entry:admin', 'entity:agent'],
    }] as any,
    workflows: [{
      id: 'workflow:agent-registration',
      name: 'Agent Registration',
      description: 'Drop server registers agents through the admin API before agent workflows can proceed.',
      workflow_type: 'command',
      entry_points: ['entry:admin'],
      call_chains: [],
      exit_points: [],
      entities_touched: ['Agent'],
      services_used: ['admin-api'],
      classification: 'primary',
      criticality: 'critical',
      dependencies: [],
      dependents: [],
    }],
  });
  const adminUi = cas({
    analysis_id: 'analysis:admin-ui',
    system: { id: 'admin-ui', name: 'admin-ui', type: 'application', root_path: '/tmp/admin-ui' },
    nodes: [{ id: 'config', name: 'API_CONFIG', type: 'module', source: { file: '/tmp/admin-ui/src/shared/api/config.ts', line: 18 } } as any],
    exit_points: [{
      id: 'exit:admin-config',
      source_node: 'config',
      type: 'api',
      name: 'Admin API host',
      target: { endpoint: 'http://admin-api/service/agents/register' },
      operation: { method: 'POST' },
    }],
  });
  const clientUi = cas({
    analysis_id: 'analysis:client-ui',
    system: { id: 'client-ui', name: 'client-ui', type: 'application', root_path: '/tmp/client-ui' },
    nodes: [{ id: 'config', name: 'API_CONFIG', type: 'module', source: { file: '/tmp/client-ui/src/shared/api/config.ts', line: 15 } } as any],
    exit_points: [{
      id: 'exit:user-config',
      source_node: 'config',
      type: 'api',
      name: 'User API host',
      target: { endpoint: 'http://user-api/register-device' },
      operation: { method: 'POST' },
    }],
  });
  const poc = cas({
    analysis_id: 'analysis:poc',
    system: { id: 'poc', name: 'poc', type: 'service', root_path: '/tmp/poc' },
    nodes: [
      { id: 'client', name: 'Compose service: client', type: 'compose_service', metadata: { topology_surface: 'docker-compose', deployment_service_name: 'client', service_aliases: ['client'] } } as any,
      { id: 'client-service', name: 'Compose service: client-service', type: 'compose_service', metadata: { topology_surface: 'docker-compose', deployment_service_name: 'client-service', service_aliases: ['client-service', 'zeracd'] } } as any,
      { id: 'agent', name: 'Compose service: agent', type: 'compose_service', metadata: { topology_surface: 'docker-compose', deployment_service_name: 'agent', service_aliases: ['agent'] } } as any,
      { id: 'coordinator', name: 'Compose service: coordinator', type: 'compose_service', metadata: { topology_surface: 'docker-compose', deployment_service_name: 'coordinator', service_aliases: ['coordinator'] } } as any,
      { id: 'drop', name: 'Compose service: drop-server', type: 'compose_service', metadata: { topology_surface: 'docker-compose', deployment_service_name: 'drop-server', service_aliases: ['drop-server'] } } as any,
    ],
    entry_points: [
      { id: 'entry:client', source_node: 'client', type: 'http', name: 'Compose service client', trigger: { method: 'ALL', path: 'http://client' }, metadata: { topology_surface: 'docker-compose', service_aliases: ['client'] } },
      { id: 'entry:client-service', source_node: 'client-service', type: 'http', name: 'Compose service client-service', trigger: { method: 'ALL', path: 'http://client-service' }, metadata: { topology_surface: 'docker-compose', service_aliases: ['client-service', 'zeracd'] } },
      { id: 'entry:agent', source_node: 'agent', type: 'http', name: 'Compose service agent', trigger: { method: 'ALL', path: 'http://agent' }, metadata: { topology_surface: 'docker-compose', service_aliases: ['agent'] } },
      { id: 'entry:coordinator', source_node: 'coordinator', type: 'http', name: 'Compose service coordinator', trigger: { method: 'ALL', path: 'http://coordinator' }, metadata: { topology_surface: 'docker-compose', service_aliases: ['coordinator'] } },
      { id: 'entry:drop', source_node: 'drop', type: 'http', name: 'Compose service drop-server', trigger: { method: 'ALL', path: 'http://drop-server' }, metadata: { topology_surface: 'docker-compose', service_aliases: ['drop-server'] } },
    ] as any,
    exit_points: [
      { id: 'exit:client-coordinator', source_node: 'client', type: 'api', name: 'client -> coordinator', target: { endpoint: 'http://coordinator', service_id: 'coordinator' }, operation: { method: 'FETCH' }, metadata: { topology_surface: 'docker-compose', service_aliases: ['coordinator'] } },
      { id: 'exit:client-service-user', source_node: 'client-service', type: 'api', name: 'client-service -> user-api', target: { endpoint: 'http://user-api/register-device', service_id: 'user-api' }, operation: { method: 'POST' } },
      { id: 'exit:coordinator-agent', source_node: 'coordinator', type: 'api', name: 'coordinator -> agent', target: { endpoint: 'http://agent', service_id: 'agent' }, operation: { method: 'FETCH' }, metadata: { topology_surface: 'docker-compose', service_aliases: ['agent'] } },
      { id: 'exit:agent-drop', source_node: 'agent', type: 'api', name: 'agent -> drop-server', target: { endpoint: 'http://drop-server', service_id: 'drop-server' }, operation: { method: 'FETCH' }, metadata: { topology_surface: 'docker-compose', service_aliases: ['drop-server'] } },
      { id: 'exit:drop-admin', source_node: 'drop', type: 'api', name: 'drop-server -> admin-api', target: { endpoint: 'http://admin-api/service/agents/register', service_id: 'admin-api' }, operation: { method: 'POST' } },
    ] as any,
    distribution_units: [{
      id: 'distribution:desktop',
      name: 'Zerac desktop installation',
      kind: 'desktop-app',
      platforms: ['linux', 'macos', 'windows'],
      component_names: ['client', 'client-service'],
      component_node_ids: ['client', 'client-service'],
      artifact_node_ids: ['installer', 'desktop', 'service'],
      artifact_paths: ['installer/zerac-installer.nsi', 'scripts/linux/zerac.desktop', 'scripts/linux/zeracd.service'],
      confidence: 0.94,
      evidence: [
        { source: 'installer', file: 'installer/zerac-installer.nsi', claim: 'Installer references client.exe and zeracd.exe.', confidence: 0.92 },
        { source: 'desktop-entry', file: 'scripts/linux/zerac.desktop', claim: 'Desktop entry launches client.', confidence: 0.9 },
        { source: 'service-unit', file: 'scripts/linux/zeracd.service', claim: 'Service unit launches zeracd.', confidence: 0.9 },
      ],
      agent_guidance: 'Preserve tray and daemon install wiring together.',
    }] as any,
  });
  const website = cas({
    analysis_id: 'analysis:website',
    system: { id: 'website', name: 'website', type: 'application', root_path: '/tmp/website' },
    nodes: [{ id: 'home-page', name: 'HomePage', type: 'component', source: { file: '/tmp/website/src/HomePage.tsx', line: 1 } } as any],
  });

  const graph = buildCrossCodebaseSystemGraph('zerac-workspace', [
    { path: '/tmp/zerac-api', name: 'zerac-api', cas: zeracApi },
    { path: '/tmp/admin-ui', name: 'admin-ui', cas: adminUi },
    { path: '/tmp/client-ui', name: 'client-ui', cas: clientUi },
    { path: '/tmp/poc', name: 'poc', cas: poc },
    { path: '/tmp/website', name: 'website', cas: website },
  ], { generatedAt: '2026-01-01T00:00:00.000Z' });
  const appNames = new Map(graph.applications.map(app => [app.id, app.name]));
  const applicationPairs = new Set(graph.application_links.map(link => `${appNames.get(link.source_application_id)}->${appNames.get(link.target_application_id)}`));
  const overview = selectWorkspaceAnalysisDetail(graph, 'overview') as any;
  const overviewDeployableNames = new Set((overview.deployables || []).map((deployable: any) => deployable.name));

  assert.equal(graph.analysis_kind, 'workspace');
  assert.equal(graph.spec_version, '1.0.0');
  assert.equal(graph.composition.kind, 'interconnected-system');
  assert.equal(graph.composition.recommended_primary_view, 'system-map');
  // Comprehension is AI-only: the synchronous WAS builder leaves the narrative
  // description empty (a pre-AI placeholder). There is no deterministic workspace
  // description; enrichWorkspaceAnalysisNarrative writes it, or throws.
  assert.equal(graph.workspace_narrative.description, '');
  assert.equal(graph.workspace_narrative.ai_required, true);
  assert.equal(graph.workspace_narrative.generation_pass, 'default-summary');
  assert.equal(graph.workspace_narrative.source, 'ai-required-degraded');
  assert.notEqual(graph.workspace_narrative.source, 'deterministic');
  assert.ok(graph.workspace_capabilities.some(capability => capability.name === 'Agent Access Brokerage' && capability.description_source === 'ai-required-degraded'));
  assert.ok(graph.workspace_entities.some(entity => entity.name === 'Agent' && entity.sensitive_fields.includes('token')));
  assert.ok(graph.workspace_entity_paths.some(entityPath => entityPath.entity_name === 'Agent' && entityPath.path_type === 'lineage'));
  assert.ok(graph.workspace_workflows.some(workflow =>
    workflow.name === 'Agent Registration' &&
    /Agent Registration is a workspace-visible flow/.test(workflow.description)
  ));
  assert.equal(overview.level, 'overview');
  assert.ok(overview.entities.some((entity: any) => entity.name === 'Agent'));
  assert.ok(overview.connections.every((connection: any) => connection.link_id && connection.source_id && connection.target_id));
  assert.ok(applicationPairs.has('admin-ui->admin-api'));
  assert.ok(applicationPairs.has('client-ui->user-api'));
  assert.ok(applicationPairs.has('client->coordinator'));
  assert.ok(applicationPairs.has('client-service->user-api'));
  assert.ok(applicationPairs.has('coordinator->agent'));
  assert.ok(applicationPairs.has('agent->drop-server'));
  assert.ok(applicationPairs.has('drop-server->admin-api'));
  assert.ok(overview.connections.every((connection: any) => ['sync', 'async', 'passive', 'stream'].includes(connection.mode)));
  assert.ok(overview.isolated_deployables.some((deployable: any) => deployable.name === 'website'));
  assert.ok(!overviewDeployableNames.has('redis'));
  assert.ok(!overviewDeployableNames.has('zerac-api'));
  assert.ok(!overviewDeployableNames.has('app-base'));
  assert.ok(!overviewDeployableNames.has('checkreq'));
  assert.ok(overview.distribution_units.some((unit: any) =>
    unit.name === 'Zerac desktop installation' &&
    unit.component_names.includes('client') &&
    unit.component_names.includes('client-service') &&
    unit.component_deployable_ids.some((id: string) => /client-service/.test(id))
  ));
  assert.ok(overview.external_dependencies.some((dependency: any) => dependency.name === 'redis' && dependency.used === false));
  assert.ok(graph.system_insights.some(insight => insight.type === 'mcp-agent-surface'));
  assert.ok(graph.system_insights.some(insight => insight.type === 'declared-unused-infrastructure' && /redis/i.test(insight.title)));
  assert.ok(graph.system_insights.some(insight => insight.type === 'provider-api-without-source-consumers' && /internal-api/i.test(insight.title)));
});

test('does not invent cross-repo links from relative http calls', () => {
  const adminApi = cas({
    system: { id: 'admin-api', name: 'admin-api', type: 'service', root_path: '/tmp/admin-api' },
    nodes: [{ id: 'users-route', name: 'UsersController.index', type: 'function', source: { file: 'src/users.controller.ts', line: 12 } } as any],
    entry_points: [{
      id: 'entry:users',
      source_node: 'users-route',
      type: 'http',
      name: 'GET /users',
      trigger: { method: 'GET', path: '/users' },
    }],
  });
  const isolatedDemo = cas({
    system: { id: 'zerac-demo', name: 'zerac-demo', type: 'application', root_path: '/tmp/zerac-demo' },
    nodes: [{ id: 'demo-client', name: 'DemoClient', type: 'component', source: { file: 'admin-ui/src/api/users.ts', line: 4 } } as any],
    exit_points: [{
      id: 'exit:demo-users',
      source_node: 'demo-client',
      type: 'api',
      name: 'fetch demo users',
      target: { endpoint: '/api/users' },
      operation: { method: 'GET' },
    }],
  });

  const graph = buildCrossCodebaseSystemGraph('zerac-system', [
    { path: '/tmp/admin-api', name: 'admin-api', cas: adminApi },
    { path: '/tmp/zerac-demo', name: 'zerac-demo', cas: isolatedDemo },
  ]);

  const appNames = new Map(graph.applications.map(app => [app.id, app.name]));
  assert.ok(!graph.application_links.some(link =>
    appNames.get(link.source_application_id) === 'zerac-demo' &&
    appNames.get(link.target_application_id) === 'admin-api'
  ));
});

test('keeps infra overlay mappings tied to deployable names, not dependency aliases', () => {
  const builder = cas({
    system: { id: 'builder', name: 'self-hosted-builder', type: 'service', root_path: '/tmp/self-hosted-builder' },
    nodes: [
      {
        id: 'admin-gateway',
        name: 'Compose service: admin-gateway',
        type: 'compose_service',
        metadata: {
          topology_surface: 'docker-compose',
          deployment_service_name: 'admin-gateway',
          service_aliases: ['admin-gateway', 'admin-api', 'coordinator', 'drop-server'],
        },
      } as any,
      {
        id: 'coordinator',
        name: 'Compose service: coordinator',
        type: 'compose_service',
        metadata: {
          topology_surface: 'docker-compose',
          deployment_service_name: 'coordinator',
          service_aliases: ['coordinator'],
        },
      } as any,
      {
        id: 'drop-server',
        name: 'Compose service: drop-server',
        type: 'compose_service',
        metadata: {
          topology_surface: 'docker-compose',
          deployment_service_name: 'drop-server',
          service_aliases: ['drop-server'],
        },
      } as any,
    ],
    entry_points: [
      { id: 'entry:admin-gateway', source_node: 'admin-gateway', type: 'http', name: 'Compose service admin-gateway', trigger: { method: 'ALL', path: 'http://admin-gateway' }, metadata: { topology_surface: 'docker-compose', service_aliases: ['admin-gateway', 'admin-api', 'coordinator', 'drop-server'] } },
      { id: 'entry:coordinator', source_node: 'coordinator', type: 'http', name: 'Compose service coordinator', trigger: { method: 'ALL', path: 'http://coordinator' }, metadata: { topology_surface: 'docker-compose', service_aliases: ['coordinator'] } },
      { id: 'entry:drop-server', source_node: 'drop-server', type: 'http', name: 'Compose service drop-server', trigger: { method: 'ALL', path: 'http://drop-server' }, metadata: { topology_surface: 'docker-compose', service_aliases: ['drop-server'] } },
    ] as any,
    exit_points: [
      { id: 'exit:admin-gateway-coordinator', source_node: 'admin-gateway', type: 'api', name: 'admin-gateway -> coordinator', target: { endpoint: 'http://coordinator', service_id: 'coordinator' }, operation: { method: 'FETCH' }, metadata: { topology_surface: 'docker-compose', service_aliases: ['coordinator'] } },
      { id: 'exit:admin-gateway-drop', source_node: 'admin-gateway', type: 'api', name: 'admin-gateway -> drop-server', target: { endpoint: 'http://drop-server', service_id: 'drop-server' }, operation: { method: 'FETCH' }, metadata: { topology_surface: 'docker-compose', service_aliases: ['drop-server'] } },
    ] as any,
  });

  const graph = buildCrossCodebaseSystemGraph('builder-workspace', [
    { path: '/tmp/self-hosted-builder', name: 'self-hosted-builder', cas: builder },
  ]);
  const gateway = graph.applications.find(app => app.name === 'admin-gateway');
  const coordinator = graph.applications.find(app => app.name === 'coordinator');
  assert.ok(gateway);
  assert.ok(coordinator);

  const gatewayMapping = graph.infrastructure_overlay.app_mappings.find(mapping => mapping.deployable_id === gateway.id);
  const coordinatorMapping = graph.infrastructure_overlay.app_mappings.find(mapping => mapping.deployable_id === coordinator.id);
  assert.ok(gatewayMapping?.resource_names.includes('admin-gateway'));
  assert.ok(!gatewayMapping?.resource_names.includes('coordinator'));
  assert.ok(coordinatorMapping?.resource_names.includes('coordinator'));
});

test('keeps UI/API name pairings as inference unless source endpoints identify the target', () => {
  const api = cas({
    system: { id: 'admin-api', name: 'admin-api', type: 'service', root_path: '/tmp/admin-api' },
    nodes: [{ id: 'route', name: 'listUsers', type: 'function', source: { file: 'src/users.ts', line: 1 } } as any],
    entry_points: [{
      id: 'entry:users',
      source_node: 'route',
      type: 'http',
      name: 'GET /users',
      trigger: { method: 'GET', path: '/users' },
    }],
  });
  const ui = cas({
    system: { id: 'admin-ui', name: 'admin-ui', type: 'application', root_path: '/tmp/admin-ui' },
    nodes: [{ id: 'config', name: 'ApiConfig', type: 'module', source: { file: 'src/api/config.ts', line: 1 } } as any],
  });

  const graph = buildCrossCodebaseSystemGraph('admin-workspace', [
    { path: '/tmp/admin-api', name: 'admin-api', cas: api },
    { path: '/tmp/admin-ui', name: 'admin-ui', cas: ui },
  ], { generatedAt: '2026-01-01T00:00:00.000Z' });
  const appNames = new Map(graph.applications.map(app => [app.id, app.name]));
  const link = graph.application_links.find(candidate =>
    appNames.get(candidate.source_application_id) === 'admin-ui' &&
    appNames.get(candidate.target_application_id) === 'admin-api'
  );

  assert.ok(link);
  assert.equal(link.evidence_quality, 'name-inferred');
  assert.ok(link.confidence < 0.7);
  assert.ok(graph.workspace_workflows.some(workflow =>
    workflow.deployable_ids.includes(link.source_application_id) &&
    workflow.deployable_ids.includes(link.target_application_id) &&
    workflow.evidence_quality === 'name-inferred'
  ));
});

test('AI enrichment updates workspace narrative, domains, and primary capability descriptions without adding graph facts', async () => {
  const originalGenerate = aiService.generateComponentDescription;
  const originalEnv = process.env.KLAURO_WORKSPACE_AI_ENRICHMENT;
  const originalAutoConfig = process.env.KLAURO_WORKSPACE_AI_AUTO_CONFIG;
  const originalOllamaBaseUrl = process.env.OLLAMA_BASE_URL;
  const originalOllamaAuto = process.env.KLAURO_OLLAMA_AUTO;
  process.env.KLAURO_WORKSPACE_AI_ENRICHMENT = 'true';
  process.env.KLAURO_WORKSPACE_AI_AUTO_CONFIG = 'false';
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.KLAURO_OLLAMA_AUTO;
  aiService.generateComponentDescription = async () => JSON.stringify({
    description: 'This workspace coordinates agent registration through the agent API service so agent enrollment, trust checks, access requests, and heartbeat records stay connected to a single source-backed API flow. The agent enrollment workflow routes registration into the API, records agent identity and state, and exposes the resulting access context to downstream tools.',
    product_value_summary: 'The workspace coordinates agent enrollment and access state through a single API.',
    domains: [{ name: 'Agent Access', description: 'Agent Access routes device agents through the drop server and admin API so enrollment, trust, and access-request state stay tied to concrete agent records.' }],
    key_capabilities: [{ name: 'Agent Access Brokerage', description: 'Agent Access Brokerage routes drop server register agents calls into the admin API, stores agent state, and exposes that state to MCP-facing access workflows.' }],
    workflows: [{ name: 'Agent Enrollment', description: 'Agent Enrollment follows the drop server to admin API route that records agent identity, heartbeat, and access state for downstream MCP access decisions.' }],
    entities: [{ name: 'Agent', description: 'Agent stores a registered device-side process, token, connection state, and service registration used by the access brokerage API flow.' }],
    value_drivers: ['agent enrollment and access coordination'],
    relationship_summary: ['drop-server calls admin-api for agent registration'],
  });
  try {
    const api = cas({
      system: { id: 'api', name: 'agent-api', type: 'service', root_path: '/tmp/agent-api' },
      nodes: [{ id: 'route', name: 'registerAgent', type: 'function', source: { file: '/tmp/agent-api/src/agents.controller.ts', line: 1 } } as any],
      entry_points: [{ id: 'entry:agent', source_node: 'route', type: 'http', name: 'POST /agents', trigger: { method: 'POST', path: '/agents' } }],
      system_capabilities: [{
        id: 'capability:agent-access',
        name: 'Agent Access Brokerage',
        description: 'Deterministic fallback capability text.',
        category: 'system',
        criticality: 'critical',
        operations: [{ entry_point_id: 'entry:agent', action: 'register', path_or_command: '/agents' }],
        related_entities: ['Agent'],
        related_domains: ['Agent Access'],
        confidence: 0.82,
        evidence: ['entry:agent'],
      }] as any,
      domain_concepts: [{ id: 'domain:agent-access', name: 'Agent Access', classification: 'core', confidence: 0.8, evidence: [] } as any],
      data_entities: [{
        id: 'entity_agent',
        name: 'Agent',
        description: 'Deterministic Agent entity description.',
        fields: [{ name: 'token', type: 'string', is_sensitive: true }],
        lifecycle: { created_by: ['route'], read_by: ['route'], updated_by: [], deleted_by: [] },
      }] as any,
      data_lineage: [{
        entity_id: 'entity_agent',
        entity_name: 'Agent',
        writers: [{ node_id: 'route', file: '/tmp/agent-api/src/agents.controller.ts', via: 'create' }],
        readers: [{ node_id: 'route', file: '/tmp/agent-api/src/agents.controller.ts', via: 'read' }],
        external_recipients: [],
        boundaries_crossed: [],
        sensitive_fields: ['token'],
        exposure: { sensitive: true },
      }] as any,
      workflows: [{
        id: 'workflow:agent-enrollment',
        name: 'Agent Enrollment',
        description: 'Deterministic workflow text.',
        entry_points: ['entry:agent'],
        exit_points: [],
        entities_touched: ['Agent'],
        criticality: 'critical',
      }] as any,
    });
    const graph = buildCrossCodebaseSystemGraph('agent-workspace', [
      { path: '/tmp/agent-api', name: 'agent-api', cas: api },
    ]);
    const enriched = await enrichWorkspaceAnalysisNarrative(graph);

    assert.equal(enriched.workspace_narrative.source, 'ai');
    assert.match(enriched.workspace_narrative.description, /agent enrollment/i);
    assert.equal(enriched.workspace_capabilities.length, 1);
    assert.equal(enriched.workspace_capabilities[0].description_source, 'ai');
    assert.match(enriched.workspace_capabilities[0].description, /drop server register agents/i);
    assert.equal(enriched.workspace_domains[0].description_source, 'ai');
    assert.match(enriched.workspace_domains[0].description, /enrollment, trust/i);
    assert.equal(enriched.workspace_workflows[0].description, 'Agent Enrollment follows the drop server to admin API route that records agent identity, heartbeat, and access state for downstream MCP access decisions.');
    assert.equal(enriched.workspace_entities[0].description_source, 'ai');
    assert.match(enriched.workspace_entities[0].description || '', /registered device[- ]side process/i);
    assert.equal(enriched.interfaces.length, graph.interfaces.length);
    assert.equal(enriched.links.length, graph.links.length);
  } finally {
    aiService.generateComponentDescription = originalGenerate;
    if (originalEnv === undefined) delete process.env.KLAURO_WORKSPACE_AI_ENRICHMENT;
    else process.env.KLAURO_WORKSPACE_AI_ENRICHMENT = originalEnv;
    if (originalAutoConfig === undefined) delete process.env.KLAURO_WORKSPACE_AI_AUTO_CONFIG;
    else process.env.KLAURO_WORKSPACE_AI_AUTO_CONFIG = originalAutoConfig;
    if (originalOllamaBaseUrl === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = originalOllamaBaseUrl;
    if (originalOllamaAuto === undefined) delete process.env.KLAURO_OLLAMA_AUTO;
    else process.env.KLAURO_OLLAMA_AUTO = originalOllamaAuto;
  }
});

test('AI enrichment rejects generic or unsupported workspace descriptions instead of marking them ready', async () => {
  const originalGenerate = aiService.generateComponentDescription;
  const originalEnv = process.env.KLAURO_WORKSPACE_AI_ENRICHMENT;
  const originalAutoConfig = process.env.KLAURO_WORKSPACE_AI_AUTO_CONFIG;
  const originalOllamaBaseUrl = process.env.OLLAMA_BASE_URL;
  const originalOllamaAuto = process.env.KLAURO_OLLAMA_AUTO;
  process.env.KLAURO_WORKSPACE_AI_ENRICHMENT = 'true';
  process.env.KLAURO_WORKSPACE_AI_AUTO_CONFIG = 'false';
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.KLAURO_OLLAMA_AUTO;
  aiService.generateComponentDescription = async () => JSON.stringify({
    description: 'This workspace consists of multiple projects and provides various applications and services for end users. It appears to serve customer-related functionality and uses src/customer.ts plus analyzer.ts files to manage the system.',
    product_value_summary: 'The workspace may serve customer functionality.',
    domains: [
      { name: 'Customer', description: 'Though not explicitly mentioned, the Customer domain appears to serve end-users across the system.' },
      { name: 'Packages', description: 'Packages is responsible for external libraries and dependencies across various projects.' },
    ],
    key_capabilities: [
      { name: 'CAS Contract Validation', description: 'CAS Contract Validation validates Contract as a Service behavior for correct behavior and compatibility.' },
    ],
  });
  try {
    const api = cas({
      system: { id: 'api', name: 'analysis-api', type: 'service', root_path: '/tmp/analysis-api' },
      nodes: [{ id: 'route', name: 'analyzeCodebase', type: 'function', source: { file: '/tmp/analysis-api/src/analysis.controller.ts', line: 1 } } as any],
      entry_points: [{ id: 'entry:analysis', source_node: 'route', type: 'http', name: 'POST /analysis', trigger: { method: 'POST', path: '/analysis' } }],
      system_capabilities: [{
        id: 'capability:cas-validation',
        name: 'CAS Contract Validation',
        description: 'Deterministic fallback capability text.',
        category: 'system',
        criticality: 'high',
        operations: [{ entry_point_id: 'entry:analysis', action: 'validate', path_or_command: '/analysis' }],
        related_entities: ['AnalysisRun'],
        related_domains: ['Analysis'],
        confidence: 0.82,
        evidence: ['entry:analysis'],
      }] as any,
      domain_concepts: [
        { id: 'domain:analysis', name: 'Analysis', classification: 'core', confidence: 0.8, evidence: [] },
        { id: 'domain:customer', name: 'Customer', classification: 'supporting', confidence: 0.5, evidence: [] },
      ] as any,
      data_entities: [{ id: 'entity_analysis_run', name: 'AnalysisRun', fields: [], lifecycle: { created_by: ['route'], read_by: ['route'], updated_by: [], deleted_by: [] } }] as any,
    });
    const graph = buildCrossCodebaseSystemGraph('analysis-workspace', [
      { path: '/tmp/analysis-api', name: 'analysis-api', cas: api },
    ]);
    const enriched = await enrichWorkspaceAnalysisNarrative(graph);

    assert.equal(enriched.workspace_narrative.source, 'ai-required-degraded');
    assert.ok(enriched.workspace_domains.every(domain => domain.description_source !== 'ai'));
    assert.ok(enriched.workspace_capabilities.every(capability => capability.description_source !== 'ai'));
    assert.ok(enriched.quality_flags.some(flag => flag.code === 'workspace-narrative-ai-degraded'));
    assert.ok(enriched.quality_flags.some(flag => flag.code === 'capability-descriptions-degraded'));
  } finally {
    aiService.generateComponentDescription = originalGenerate;
    if (originalEnv === undefined) delete process.env.KLAURO_WORKSPACE_AI_ENRICHMENT;
    else process.env.KLAURO_WORKSPACE_AI_ENRICHMENT = originalEnv;
    if (originalAutoConfig === undefined) delete process.env.KLAURO_WORKSPACE_AI_AUTO_CONFIG;
    else process.env.KLAURO_WORKSPACE_AI_AUTO_CONFIG = originalAutoConfig;
    if (originalOllamaBaseUrl === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = originalOllamaBaseUrl;
    if (originalOllamaAuto === undefined) delete process.env.KLAURO_OLLAMA_AUTO;
    else process.env.KLAURO_OLLAMA_AUTO = originalOllamaAuto;
  }
});

test('workspace domains demote thin entity-only concepts below terminal product semantics', () => {
  const api = cas({
    system: { id: 'api', name: 'analysis-api', type: 'service', root_path: '/tmp/analysis-api' },
    nodes: [{ id: 'route', name: 'analyzeCodebase', type: 'function', source: { file: '/tmp/analysis-api/src/analysis.controller.ts', line: 1 } } as any],
    entry_points: [{ id: 'entry:analysis', source_node: 'route', type: 'http', name: 'POST /analysis', trigger: { method: 'POST', path: '/analysis' } }],
    enhanced_system_purpose: {
      primary_domain: 'Codebase Analysis',
      core_concepts: ['Codebase Graph', 'Agent Context'],
      primary_workflow_id: 'workflow:analyze-codebase',
    } as any,
    system_capabilities: [{
      id: 'capability:analyze-codebase',
      name: 'Codebase Analysis',
      description: 'Codebase Analysis builds a graph from code elements, routes, entities, and risks for agent contexts.',
      category: 'core',
      criticality: 'critical',
      operations: [{ entry_point_id: 'entry:analysis', action: 'analyze', path_or_command: '/analysis' }],
      related_entities: ['AnalysisRun', 'CodebaseGraph'],
      related_domains: ['Codebase Analysis'],
      confidence: 0.9,
      evidence: ['entry:analysis'],
    }] as any,
    domain_concepts: [
      { id: 'domain:analysis', name: 'Codebase Analysis', classification: 'core', confidence: 0.9, evidence: [] },
      { id: 'domain:codebase', name: 'Codebase', classification: 'core', confidence: 0.8, evidence: [] },
      { id: 'domain:bare-analysis', name: 'Analysis', classification: 'core', confidence: 0.8, evidence: [] },
      { id: 'domain:customer', name: 'Customer', classification: 'supporting', confidence: 0.5, evidence: [] },
    ] as any,
    data_entities: [
      { id: 'entity_analysis_run', name: 'AnalysisRun', fields: [], lifecycle: { created_by: ['route'], read_by: ['route'], updated_by: [], deleted_by: [] } },
      { id: 'entity_customer', name: 'Customer', fields: [], lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } },
    ] as any,
    user_journeys: [{
      id: 'journey:analysis',
      name: 'Analyze Codebase',
      classification: 'primary',
      criticality: 'critical',
      terminal_entities: [{ name: 'AnalysisRun', access: 'created' }],
      terminal_effects: { entities_written: ['AnalysisRun'], entities_read: ['CodebaseGraph'], messages_emitted: [], external_services: [] },
    }] as any,
  });

  const graph = buildCrossCodebaseSystemGraph('analysis-workspace', [
    { path: '/tmp/analysis-api', name: 'analysis-api', cas: api },
  ]);
  const domainNames = graph.workspace_domains.map(domain => domain.name);
  const codebaseIndex = domainNames.indexOf('Codebase Analysis');
  const customerIndex = domainNames.indexOf('Customer');

  assert.ok(codebaseIndex >= 0);
  assert.ok(customerIndex < 0 || customerIndex > codebaseIndex);
  assert.ok(!graph.workspace_domains.slice(0, 3).some(domain => domain.name === 'Customer'));
  assert.ok(!graph.workspace_domains.some(domain => domain.name === 'Codebase'));
  assert.ok(!graph.workspace_domains.some(domain => domain.name === 'Analysis'));
});

// Regression (live prod v1.0.61): shell-script/fixture/file-format tokens leaked
// into workspace `domains` ("Json", "Curl", "Pentest", "Shell", ...). Their repo
// concepts occur ONLY in file-basename entry points (entry_file_*.sh) and bare
// code nodes — never in a data entity, a structural entry point, or the terminal
// value chain. The evidence gate must drop them at derivation, while concepts
// grounded in entities/structural entries (and capability-backed domains) stay.
test('workspace domains reject token-frequency concepts sourced only from shell scripts and file basenames', () => {
  const agent = cas({
    system: { id: 'agent', name: 'zt-agent', type: 'service', root_path: '/tmp/zt-agent' },
    nodes: [{ id: 'enroll', name: 'enrollDevice', type: 'function', source: { file: '/tmp/zt-agent/src/enroll.rs', line: 1 } } as any],
    entry_points: [{ id: 'entry:enroll', source_node: 'enroll', type: 'http', name: 'POST /enroll', trigger: { method: 'POST', path: '/enroll' } }],
    enhanced_system_purpose: {
      primary_domain: 'Network Access Management',
      core_concepts: ['device', 'access'],
    } as any,
    system_capabilities: [{
      id: 'capability:policy',
      name: 'Policy Management',
      description: 'Policy Management evaluates access policies for enrolled devices.',
      category: 'core',
      criticality: 'critical',
      operations: [{ entry_point_id: 'entry:enroll', action: 'evaluate', path_or_command: '/enroll' }],
      related_entities: ['Policy'],
      related_domains: ['Policy Management'],
      confidence: 0.9,
      evidence: ['entry:enroll'],
    }] as any,
    domain_concepts: [
      // Grounded: appears in data entities → real domain vocabulary.
      { id: 'concept_policy', name: 'policy', classification: 'core', frequency: 41, appears_in: { entry_points: [], entities: ['entity_policy'], nodes: ['impl:access_policies.rs:AccessPolicyExecutor'] } },
      // Grounded: appears at a structural (non file-basename) entry point.
      { id: 'concept_network', name: 'network', classification: 'core', frequency: 228, appears_in: { entry_points: ['entry:cli:crates/config/src/machine.rs:subcommand:NetworkAccessRequest'], entities: [], nodes: [] } },
      // Junk class: tokens occurring ONLY in shell-script file-basename entry
      // points and shell function nodes. These are exactly the live leaks.
      { id: 'concept_shell', name: 'shell', classification: 'core', frequency: 243, appears_in: { entry_points: ['entry_file_pentest_full_attack_suite_sh', 'entry_file_build_dmg_installer_sh'], entities: [], nodes: [] } },
      { id: 'concept_pentest', name: 'pentest', classification: 'core', frequency: 8, appears_in: { entry_points: ['entry_file_scripts_test_relay_scenarios_39_pentest_malformed_zerac_sh'], entities: [], nodes: ['function_pentest_setup_sh_check_tool_10'] } },
      { id: 'concept_curl', name: 'curl', classification: 'supporting', frequency: 5, appears_in: { entry_points: [], entities: [], nodes: ['function_scripts_test_relay_lib_workload_sh_workload_curl_minio_87'] } },
      { id: 'concept_json', name: 'json', classification: 'supporting', frequency: 12, appears_in: { entry_points: [], entities: [], nodes: ['function_scripts_parse_json_sh_parse_json_3'] } },
      { id: 'concept_revisions', name: 'revisions', classification: 'supporting', frequency: 6, appears_in: { entry_points: [], entities: [], nodes: ['function_scripts_revisions_sh_list_revisions_2'] } },
    ] as any,
    data_entities: [
      { id: 'entity_policy', name: 'Policy', fields: [], lifecycle: { created_by: ['enroll'], read_by: ['enroll'], updated_by: [], deleted_by: [] } },
    ] as any,
    user_journeys: [{
      id: 'journey:enroll',
      name: 'Enroll Device',
      classification: 'primary',
      criticality: 'critical',
      terminal_entities: [{ name: 'Policy', access: 'read' }],
      terminal_effects: { entities_written: ['Policy'], entities_read: ['Policy'], messages_emitted: [], external_services: [] },
    }] as any,
  });

  const graph = buildCrossCodebaseSystemGraph('zt-workspace', [
    { path: '/tmp/zt-agent', name: 'zt-agent', cas: agent },
  ]);
  const domainNames = graph.workspace_domains.map(domain => domain.name);

  // Junk tokens sourced only from shell scripts / file basenames never surface.
  for (const junk of ['Shell', 'Pentest', 'Curl', 'Json', 'Revisions']) {
    assert.ok(!domainNames.includes(junk), `junk token "${junk}" must not be a workspace domain: ${JSON.stringify(domainNames)}`);
  }
  // Every surfaced domain is backed by real evidence (analyzer domain answer,
  // capability, or terminal grounding) — never raw token frequency alone.
  for (const domain of graph.workspace_domains) {
    const anchored = domain.evidence.some(item => /^(primary_domain|project_domain|crypto_anchor|capability|capability_domain|deployable):/.test(item));
    assert.ok(anchored || (domain.terminal_score || 0) > 0,
      `domain "${domain.name}" surfaced without domain evidence: ${JSON.stringify(domain.evidence)}`);
  }
  // The evidence-grounded domains still surface.
  assert.ok(domainNames.some(name => /Network Access/i.test(name)), `expected a Network Access domain: ${JSON.stringify(domainNames)}`);
  assert.ok(domainNames.some(name => /Policy/i.test(name)), `expected a Policy domain: ${JSON.stringify(domainNames)}`);
});

test('AI enrichment rejects item descriptions that are useful-sounding but not grounded in target evidence', async () => {
  const originalGenerate = aiService.generateComponentDescription;
  const originalEnv = process.env.KLAURO_WORKSPACE_AI_ENRICHMENT;
  const originalAutoConfig = process.env.KLAURO_WORKSPACE_AI_AUTO_CONFIG;
  const originalOllamaBaseUrl = process.env.OLLAMA_BASE_URL;
  const originalOllamaAuto = process.env.KLAURO_OLLAMA_AUTO;
  process.env.KLAURO_WORKSPACE_AI_ENRICHMENT = 'true';
  process.env.KLAURO_WORKSPACE_AI_AUTO_CONFIG = 'false';
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.KLAURO_OLLAMA_AUTO;
  aiService.generateComponentDescription = async () => JSON.stringify({
    description: 'The analysis API turns submitted codebase structure into graph context for AI agents, connecting analysis runs, codebase graph records, route evidence, and work-context guidance so changes can target the right behavior without broad file rediscovery.',
    product_value_summary: 'The workspace analyzes codebases into graph-backed agent context.',
    domains: [
      { name: 'Customer', description: 'Customer routes customer API requests into customer database records so customer accounts, users, and support workflows stay synchronized.' },
      { name: 'Codebase Analysis', description: 'Codebase Analysis turns analysis API route evidence, AnalysisRun records, and CodebaseGraph facts into agent-ready workspace context.' },
    ],
    key_capabilities: [
      { name: 'Codebase Analysis', description: 'Codebase Analysis analyzes submitted codebase routes, entities, risks, and graph relationships into compact agent contexts.' },
    ],
    value_drivers: ['agent context from codebase graph analysis'],
    relationship_summary: ['analysis-api accepts codebase analysis requests'],
  });
  try {
    const api = cas({
      system: { id: 'api', name: 'analysis-api', type: 'service', root_path: '/tmp/analysis-api' },
      nodes: [{ id: 'route', name: 'analyzeCodebase', type: 'function', source: { file: '/tmp/analysis-api/src/analysis.controller.ts', line: 1 } } as any],
      entry_points: [{ id: 'entry:analysis', source_node: 'route', type: 'http', name: 'POST /analysis', trigger: { method: 'POST', path: '/analysis' } }],
      enhanced_system_purpose: {
        primary_domain: 'Codebase Analysis',
        core_concepts: ['Codebase Graph'],
        primary_workflow_id: 'workflow:analyze-codebase',
      } as any,
      system_capabilities: [{
        id: 'capability:codebase-analysis',
        name: 'Codebase Analysis',
        description: 'Deterministic fallback capability text.',
        category: 'core',
        criticality: 'critical',
        operations: [{ entry_point_id: 'entry:analysis', action: 'analyze', path_or_command: '/analysis' }],
        related_entities: ['AnalysisRun', 'CodebaseGraph'],
        related_domains: ['Codebase Analysis'],
        confidence: 0.9,
        evidence: ['entry:analysis'],
      }] as any,
      domain_concepts: [
        { id: 'domain:analysis', name: 'Codebase Analysis', classification: 'core', confidence: 0.9, evidence: [] },
        { id: 'domain:customer', name: 'Customer', classification: 'supporting', confidence: 0.5, evidence: [] },
      ] as any,
      data_entities: [
        { id: 'entity_analysis_run', name: 'AnalysisRun', fields: [], lifecycle: { created_by: ['route'], read_by: ['route'], updated_by: [], deleted_by: [] } },
        { id: 'entity_customer', name: 'Customer', fields: [], lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } },
      ] as any,
      user_journeys: [{
        id: 'journey:analysis',
        name: 'Analyze Codebase',
        classification: 'primary',
        criticality: 'critical',
        terminal_entities: [{ name: 'AnalysisRun', access: 'created' }],
        terminal_effects: { entities_written: ['AnalysisRun'], entities_read: ['CodebaseGraph'], messages_emitted: [], external_services: [] },
      }] as any,
    });
    const graph = buildCrossCodebaseSystemGraph('analysis-workspace', [
      { path: '/tmp/analysis-api', name: 'analysis-api', cas: api },
    ]);
    const enriched = await enrichWorkspaceAnalysisNarrative(graph);
    const customer = enriched.workspace_domains.find(domain => domain.name === 'Customer');
    const capability = enriched.workspace_capabilities.find(item => item.name === 'Codebase Analysis');

    assert.equal(capability?.description_source, 'ai');
    assert.notEqual(customer?.description_source, 'ai');
  } finally {
    aiService.generateComponentDescription = originalGenerate;
    if (originalEnv === undefined) delete process.env.KLAURO_WORKSPACE_AI_ENRICHMENT;
    else process.env.KLAURO_WORKSPACE_AI_ENRICHMENT = originalEnv;
    if (originalAutoConfig === undefined) delete process.env.KLAURO_WORKSPACE_AI_AUTO_CONFIG;
    else process.env.KLAURO_WORKSPACE_AI_AUTO_CONFIG = originalAutoConfig;
    if (originalOllamaBaseUrl === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = originalOllamaBaseUrl;
    if (originalOllamaAuto === undefined) delete process.env.KLAURO_OLLAMA_AUTO;
    else process.env.KLAURO_OLLAMA_AUTO = originalOllamaAuto;
  }
});

test('surfaces source-backed auth providers and topology-only infrastructure separately', () => {
  const ui = cas({
    system: { id: 'ui', name: 'admin-ui', type: 'application', root_path: '/tmp/admin-ui' },
    nodes: [{ id: 'auth-hook', name: 'useAuth0', type: 'hook', source: { file: 'src/auth.ts', line: 8 } } as any],
    external_services: [{
      id: 'external:auth0',
      name: '@auth0/auth0-react',
      type: 'sdk',
      connected_nodes: ['auth-hook'],
    }] as any,
    dependencies: {
      manager: 'npm',
      packages: [{ name: '@auth0/auth0-react', version: '2.2.4', direct: true }],
    },
  });
  const runtime = cas({
    system: { id: 'api', name: 'api', type: 'service', root_path: '/tmp/api' },
    nodes: [
      { id: 'redis', name: 'Compose service: redis', type: 'compose_service', metadata: { topology_surface: 'docker-compose', deployment_service_name: 'redis', service_aliases: ['redis'] } } as any,
      { id: 'ecs', name: 'resource.aws_ecs_service.admin_api', type: 'infrastructure_resource', metadata: { topology_surface: 'terraform', environment: 'production', attributes: { terraform_type: 'aws_ecs_service', provider: 'aws', environment: 'production' } } } as any,
    ],
    entry_points: [{
      id: 'entry:redis',
      source_node: 'redis',
      type: 'http',
      name: 'Compose service redis',
      trigger: { method: 'ALL', path: 'http://redis' },
      metadata: { topology_surface: 'docker-compose', deployment_service_name: 'redis', service_aliases: ['redis'] },
    }],
    data_entities: [
      { id: 'entity:agent', name: 'Agent', fields: [{ name: 'token', type: 'string', is_sensitive: true }], lifecycle: { created_by: ['entry:admin'], read_by: [], updated_by: ['entry:admin'], deleted_by: [] } },
      { id: 'entity:device', name: 'Device', fields: [], lifecycle: { created_by: ['entry:user'], read_by: [], updated_by: [], deleted_by: [] } },
    ] as any,
    data_lineage: [{
      entity_id: 'entity:agent',
      entity_name: 'Agent',
      writers: [{ node_id: 'admin-route', file: '/tmp/zerac-api/apps/admin-api/src/controller.ts', via: 'POST /service/agents/register' }],
      readers: [],
      external_recipients: [],
      boundaries_crossed: [{ boundary: 'admin-api', guarded: true }],
      sensitive_fields: ['token'],
      exposure: { sensitive: true },
    }, {
      entity_id: 'entity:device',
      entity_name: 'Device',
      writers: [{ node_id: 'user-route', file: '/tmp/zerac-api/apps/user-api/src/controller.ts', via: 'POST /register-device' }],
      readers: [],
      external_recipients: [],
      boundaries_crossed: [{ boundary: 'user-api', guarded: true }],
      sensitive_fields: [],
      exposure: { sensitive: false },
    }] as any,
  });

  const graph = buildCrossCodebaseSystemGraph('infra-system', [
    { path: '/tmp/admin-ui', name: 'admin-ui', cas: ui },
    { path: '/tmp/api', name: 'api', cas: runtime },
  ]);
  const overview = selectWorkspaceAnalysisDetail(graph, 'overview') as any;

  assert.ok(overview.external_dependencies.some((dependency: any) =>
    dependency.name === 'Auth0' &&
    dependency.used === true &&
    dependency.usage === 'source-backed'
  ));
  assert.ok(overview.external_dependencies.some((dependency: any) =>
    dependency.name === 'redis' &&
    dependency.used === false &&
    dependency.usage !== 'source-backed'
  ));
  assert.ok(graph.runtime_topology.components.some(component =>
    component.topology_surface === 'terraform' &&
    component.environment === 'production'
  ));
});

test('never authors deterministic product summaries — pre-AI narrative ships empty awaiting AI enrichment', () => {
  const soon = cas({
    system: { id: 'soon-sync', name: 'soon-sync', type: 'service', root_path: '/tmp/soon-sync' },
    nodes: [{ id: 'billing-route', name: 'BillingRecoveryController', type: 'function', source: { file: 'src/billing.ts', line: 1 } } as any],
    entry_points: [{ id: 'entry:billing', source_node: 'billing-route', type: 'http', name: 'POST /billing/recovery', trigger: { method: 'POST', path: '/billing/recovery' } }],
    system_capabilities: [{
      id: 'capability:automation-audit',
      name: 'Automation Audit Management',
      description: 'Automation Audit Management maintains automated investing, tax-stash, account-sync, and billing recovery behavior.',
      category: 'system',
      criticality: 'high',
      operations: [{ entry_point_id: 'entry:billing', action: 'process', path_or_command: '/billing/recovery' }],
      related_entities: ['Account'],
      related_domains: ['Investing Operations'],
      confidence: 0.84,
      evidence: ['entry:billing'],
    }] as any,
    data_entities: [{ id: 'entity:account', name: 'Account', fields: [], lifecycle: { created_by: [], read_by: ['billing-route'], updated_by: [], deleted_by: [] } }] as any,
  });
  const klauro = cas({
    system: { id: 'klauro', name: 'Klauro', type: 'service', root_path: '/tmp/klauro' },
    nodes: [{ id: 'mcp', name: 'McpServer', type: 'module', source: { file: 'src/server.ts', line: 1 } } as any],
    entry_points: [{ id: 'entry:mcp', source_node: 'mcp', type: 'http', name: 'GET /mcp', trigger: { method: 'GET', path: '/mcp' } }],
    system_capabilities: [{
      id: 'capability:codebase-analysis',
      name: 'Codebase Analysis',
      description: 'Codebase Analysis turns CAS graph, workspace analysis, analyzer facts, and MCP agent context context into agent guidance.',
      category: 'system',
      criticality: 'critical',
      operations: [{ entry_point_id: 'entry:mcp', action: 'query', path_or_command: '/mcp' }],
      related_entities: ['AnalysisResult'],
      related_domains: ['Codebase Intelligence'],
      confidence: 0.9,
      evidence: ['entry:mcp'],
    }] as any,
    data_entities: [{ id: 'entity:analysis', name: 'AnalysisResult', fields: [], lifecycle: { created_by: ['mcp'], read_by: ['mcp'], updated_by: [], deleted_by: [] } }] as any,
  });

  const soonGraph = buildCrossCodebaseSystemGraph('Soon', [{ path: '/tmp/soon-sync', name: 'soon-sync', cas: soon }]);
  const klauroGraph = buildCrossCodebaseSystemGraph('Klauro', [{ path: '/tmp/klauro', name: 'Klauro', cas: klauro }]);

  // DETERMINISM-BOUNDARY: comprehension prose is AI-only. The pre-AI structural
  // builder must never author a keyword-frame summary ("financial application
  // workspace", "codebase-intelligence workspace", ...) — it ships empty and is
  // marked as requiring AI enrichment.
  assert.equal(soonGraph.workspace_narrative.product_value_summary, '');
  assert.equal(klauroGraph.workspace_narrative.product_value_summary, '');
  assert.equal(soonGraph.workspace_narrative.source, 'ai-required-degraded');
  assert.equal(klauroGraph.workspace_narrative.source, 'ai-required-degraded');
});

test('workspace AI auto configuration prefers fast capable local Ollama models', () => {
  assert.equal(selectPreferredWorkspaceOllamaModel(['llama3.2:3b', 'qwen3:8b', 'qwen3-coder:latest', 'mistral:7b']), 'mistral:7b');
  assert.equal(selectPreferredWorkspaceOllamaModel(['llama3.2:3b', 'qwen3:8b', 'mistral:7b']), 'mistral:7b');
  assert.equal(selectPreferredWorkspaceOllamaModel(['mistral:7b', 'llama3.1:8b']), 'mistral:7b');
  assert.equal(selectPreferredWorkspaceOllamaModel(['custom-local-model']), 'custom-local-model');
  assert.equal(selectPreferredWorkspaceOllamaModel([]), undefined);
});

test('workspace entity paths keep traversable project steps even when capabilities lack deployable ids', () => {
  const api = cas({
    system: { id: 'api', name: 'policy-api', type: 'service', root_path: '/tmp/policy-api' },
    system_capabilities: [{
      id: 'capability:policy-review',
      name: 'Policy Review',
      description: 'Policy Review reads Policy records before access is granted.',
      category: 'system',
      criticality: 'high',
      operations: [],
      related_entities: ['Policy'],
      related_domains: ['Access Policy'],
      confidence: 0.82,
      evidence: ['entity:Policy'],
    }] as any,
    data_entities: [{ id: 'entity:policy', name: 'Policy', fields: [], lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } }] as any,
  });

  const graph = buildCrossCodebaseSystemGraph('Policy Workspace', [
    { path: '/tmp/policy-api', name: 'policy-api', cas: api },
  ]);
  const entity = graph.workspace_entities.find(item => item.name === 'Policy');
  const path = graph.workspace_entity_paths.find(item => item.entity_name === 'Policy' && item.path_type === 'capability');

  assert.ok(entity);
  assert.ok((entity?.path_count || 0) > 0);
  assert.ok(entity?.path_types?.includes('capability'));
  assert.ok(path);
  assert.ok((path?.via || []).length > 0);
  assert.equal(path?.via[0].project_id, 'tmp-policy-api');
  assert.equal(path?.via[0].label, 'Policy Review');
});

test('ranks evidence-backed product capabilities above unsupported generic buckets', () => {
  const api = cas({
    system: { id: 'api', name: 'zerac-api', type: 'service', root_path: '/tmp/zerac-api' },
    nodes: [
      { id: 'device-route', name: 'DeviceController', type: 'function', source: { file: 'apps/user-api/src/devices.controller.ts', line: 1 } } as any,
      { id: 'access-route', name: 'AccessController', type: 'function', source: { file: 'apps/admin-api/src/accessControl/accessControl.controller.ts', line: 1 } } as any,
      { id: 'config-node', name: 'JestConfig', type: 'module', source: { file: 'apps/admin-api/jest.config.ts', line: 1 } } as any,
    ],
    entry_points: [
      { id: 'entry:device', source_node: 'device-route', type: 'http', name: 'POST /register-device', trigger: { method: 'POST', path: '/register-device' } },
      { id: 'entry:access', source_node: 'access-route', type: 'http', name: 'POST /access/requests', trigger: { method: 'POST', path: '/access/requests' } },
      { id: 'entry:generic', source_node: 'config-node', type: 'cli', name: 'jest config' },
    ] as any,
	    system_capabilities: [{
	      id: 'capability:generic',
      name: 'Project Backend Provisioning',
      description: 'Project Backend Provisioning creates and configures developer projects, databases, APIs, and backend resources.',
      category: 'system',
      criticality: 'critical',
      operations: [{ entry_point_id: 'entry:generic', action: 'coordinate', path_or_command: 'apps/admin-api/jest.config.ts' }],
      related_entities: [],
      related_domains: ['project-backend-provisioning'],
      confidence: 0.9,
      evidence: ['apps/admin-api/jest.config.ts', 'apps/admin-api/src/app/accessControl/accessControl.module.ts'],
    }, {
      id: 'capability:device',
      name: 'Device Enrollment',
      description: 'Device Enrollment registers devices and binds them to organizations for access decisions.',
      category: 'system',
      criticality: 'high',
      operations: [{ entry_point_id: 'entry:device', action: 'register', path_or_command: '/register-device' }],
      related_entities: ['Device'],
      related_domains: ['device-enrollment'],
      confidence: 0.86,
      evidence: ['apps/user-api/src/devices.controller.ts', 'entity:Device'],
    }, {
      id: 'capability:access',
      name: 'Access Request Management',
      description: 'Access Request Management creates and reviews access request records.',
      category: 'system',
      criticality: 'high',
      operations: [{ entry_point_id: 'entry:access', action: 'create', path_or_command: '/access/requests' }],
      related_entities: ['AccessRequest'],
      related_domains: ['access-requests'],
      confidence: 0.86,
      evidence: ['apps/admin-api/src/accessControl/accessControl.controller.ts', 'entity:AccessRequest'],
    }] as any,
	    data_entities: [
	      { id: 'entity:device', name: 'Device', fields: [], lifecycle: { created_by: ['device-route'], read_by: [], updated_by: [], deleted_by: [] } },
	      { id: 'entity:access-request', name: 'AccessRequest', fields: [], lifecycle: { created_by: ['access-route'], read_by: [], updated_by: [], deleted_by: [] } },
	    ] as any,
	    user_journeys: [{
	      id: 'journey:device-enrollment',
	      name: 'Enroll a device for access',
	      criticality: 'high',
	      entry_point_id: 'entry:device',
	      terminal_effects: { entities_written: ['Device'], entities_read: [], external_services: [], messages_emitted: [] },
	      terminal_entities: [{ name: 'Device', access: 'created', terminal_kind: 'entity' }],
	      steps: [],
	      entry: { type: 'http', name: 'POST /register-device' },
	      security_boundaries: [],
	      tests_covering: [],
	      call_chain_ids: [],
	      exit_point_ids: [],
	    }, {
	      id: 'journey:access-request',
	      name: 'Create an access request',
	      criticality: 'critical',
	      entry_point_id: 'entry:access',
	      terminal_effects: { entities_written: ['AccessRequest'], entities_read: [], external_services: [], messages_emitted: [] },
	      terminal_entities: [{ name: 'AccessRequest', access: 'created', terminal_kind: 'entity' }],
	      steps: [],
	      entry: { type: 'http', name: 'POST /access/requests' },
	      security_boundaries: [],
	      tests_covering: [],
	      call_chain_ids: [],
	      exit_point_ids: [],
	    }] as any,
	    flow_graph: {
	      capabilities: [],
	      dependencies: [],
	      topology: {
	        root_capabilities: ['capability:generic'],
	        leaf_capabilities: ['capability:device', 'capability:access'],
	        critical_path: ['capability:device', 'capability:access'],
	        max_depth: 2,
	      },
	      primary_flow: {
	        core_capability_id: 'capability:access',
	        value_chain: ['capability:device', 'capability:access'],
	        supporting_capabilities: [],
	        infrastructure_capabilities: ['capability:generic'],
	      },
	      layers: [],
	      system_insights: { detected_patterns: [], primary_entry_type: 'http', data_flow_type: 'write' },
	    } as any,
	  });

  const graph = buildCrossCodebaseSystemGraph('Zerac', [{ path: '/tmp/zerac-api', name: 'zerac-api', cas: api }]);
  const names = graph.workspace_capabilities.map(capability => capability.name);

	  assert.ok(names.indexOf('Device Enrollment') < names.indexOf('Project Backend Provisioning'));
	  assert.ok(names.indexOf('Access Request Management') < names.indexOf('Project Backend Provisioning'));
	  const device = graph.workspace_capabilities.find(capability => capability.name === 'Device Enrollment');
	  const access = graph.workspace_capabilities.find(capability => capability.name === 'Access Request Management');
	  const generic = graph.workspace_capabilities.find(capability => capability.name === 'Project Backend Provisioning');
	  assert.equal(device?.semantic_role, 'core');
	  assert.equal(access?.semantic_role, 'core');
	  assert.equal(generic?.semantic_role, 'infrastructure');
	  assert.ok((device?.terminal_score || 0) > (generic?.terminal_score || 0));
	  assert.ok((graph.workspace_entities.find(entity => entity.name === 'AccessRequest')?.terminal_score || 0) > 0);
	});

test('builds compact workspace agent contexts from WAS without full graph injection', () => {
  const api = cas({
    system: { id: 'api', name: 'zerac-api', type: 'service', root_path: '/tmp/zerac-api' },
    nodes: [
      { id: 'admin-route', name: 'AdminApi', type: 'function', source: { file: '/tmp/zerac-api/apps/admin-api/src/controller.ts', line: 1 } } as any,
      { id: 'user-route', name: 'UserApi', type: 'function', source: { file: '/tmp/zerac-api/apps/user-api/src/controller.ts', line: 1 } } as any,
      { id: 'redis', name: 'Compose service: redis', type: 'compose_service', metadata: { topology_surface: 'docker-compose', deployment_service_name: 'redis', service_aliases: ['redis'] } } as any,
    ],
    entry_points: [{
      id: 'entry:admin',
      source_node: 'admin-route',
      type: 'http',
      name: 'POST /service/agents/register',
      trigger: { method: 'POST', path: '/service/agents/register' },
    }, {
      id: 'entry:user',
      source_node: 'user-route',
      type: 'http',
      name: 'POST /register-device',
      trigger: { method: 'POST', path: '/register-device' },
    }, {
      id: 'entry:redis',
      source_node: 'redis',
      type: 'http',
      name: 'Compose service redis',
      trigger: { method: 'ALL', path: 'http://redis' },
      metadata: { topology_surface: 'docker-compose', deployment_service_name: 'redis', service_aliases: ['redis'] },
    }],
    data_entities: [
      { id: 'entity:agent', name: 'Agent', fields: [{ name: 'token', type: 'string', is_sensitive: true }], lifecycle: { created_by: ['entry:admin'], read_by: [], updated_by: ['entry:admin'], deleted_by: [] } },
      { id: 'entity:device', name: 'Device', fields: [], lifecycle: { created_by: ['entry:user'], read_by: [], updated_by: [], deleted_by: [] } },
    ] as any,
    data_lineage: [{
      entity_id: 'entity:agent',
      entity_name: 'Agent',
      writers: [{ node_id: 'admin-route', file: '/tmp/zerac-api/apps/admin-api/src/controller.ts', via: 'POST /service/agents/register' }],
      readers: [],
      external_recipients: [],
      boundaries_crossed: [{ boundary: 'admin-api', guarded: true }],
      sensitive_fields: ['token'],
      exposure: { sensitive: true },
    }, {
      entity_id: 'entity:device',
      entity_name: 'Device',
      writers: [{ node_id: 'user-route', file: '/tmp/zerac-api/apps/user-api/src/controller.ts', via: 'POST /register-device' }],
      readers: [],
      external_recipients: [],
      boundaries_crossed: [{ boundary: 'user-api', guarded: true }],
      sensitive_fields: [],
      exposure: { sensitive: false },
    }] as any,
  });
  const drop = cas({
    system: { id: 'poc', name: 'poc', type: 'service', root_path: '/tmp/poc' },
    nodes: [{ id: 'drop', name: 'DropServer', type: 'function', source: { file: '/tmp/poc/bin/drop-server/src/api.rs', line: 91 } } as any],
    exit_points: [{
      id: 'exit:drop-admin',
      source_node: 'drop',
      type: 'api',
      name: 'register agent',
      target: { endpoint: 'http://admin-api/service/agents/register', service_id: 'admin-api' },
      operation: { method: 'POST' },
    }],
  });
  const ui = cas({
    system: { id: 'ui', name: 'admin-ui', type: 'application', root_path: '/tmp/admin-ui' },
    nodes: [{ id: 'auth-hook', name: 'useAuth0', type: 'hook', source: { file: 'src/auth.ts', line: 8 } } as any],
    dependencies: {
      manager: 'npm',
      packages: [{ name: '@auth0/auth0-react', version: '2.2.4', direct: true }],
    },
    exit_points: [{
      id: 'exit:admin-config',
      source_node: 'auth-hook',
      type: 'api',
      name: 'Admin API host',
      target: { endpoint: 'http://admin-api/service/agents/register' },
      operation: { method: 'POST' },
    }],
  });

  const graph = buildCrossCodebaseSystemGraph('zerac-workspace', [
    { path: '/tmp/zerac-api', name: 'zerac-api', cas: api },
    { path: '/tmp/poc', name: 'poc', cas: drop },
    { path: '/tmp/admin-ui', name: 'admin-ui', cas: ui },
  ], { generatedAt: '2026-01-01T00:00:00.000Z' });
  const context = buildWorkspaceAgentContext(graph, {
    task_type: 'debug',
    target: 'drop server auth0 admin api',
    instructions: 'Figure out how the drop server brokers agent registration into the admin API.',
  });

  assert.equal(context.product, 'workspace_agent_context');
  assert.equal(context.workspace.composition_kind, 'interconnected-system');
  assert.ok(context.context_budget.estimated_context_tokens < context.context_budget.estimated_full_was_tokens);
  assert.ok(context.context_budget.estimated_token_reduction_percentage > 0);
  assert.ok(['high', 'medium', 'low'].includes(context.context_budget.signal_quality));
  assert.ok(context.selected_surfaces.some(app => app.name === 'drop-server' && typeof app.deployable === 'boolean'));
  assert.ok(context.agent_guidance.read_order.every(item => item.startsWith('/tmp/')));
  assert.ok(context.selected_surfaces.some(app => app.name === 'admin-api'));
  assert.ok(context.source_backed_connections.some(connection => connection.source === 'drop-server' && connection.target === 'admin-api' && connection.runtime_behavior === 'yes'));
  assert.ok(context.source_backed_connections.every(connection => connection.link_id && connection.source_id && connection.target_id));
  assert.ok(context.external_dependencies.some(dependency => dependency.name === 'Auth0' && dependency.usage === 'source-backed'));
  assert.ok(context.entities.length >= 2);
  assert.ok(context.entity_paths.length > 0);
  assert.ok(context.agent_guidance.agent_should_read_next.length > 0);
  assert.ok(context.agent_guidance.next_mcp_calls.some(call => call.tool === 'get_workspace_entity_map'));
  assert.ok(context.agent_guidance.warnings.some(warning => /prototype-or-demo-projects-present/.test(warning)));
  assert.ok(context.health);
  assert.ok(Array.isArray(context.risk_areas));
  assert.ok(Array.isArray(context.capabilities));
  assert.ok(Array.isArray(context.workflows));
  assert.ok(context.agent_guidance.next_mcp_calls.some(call => call.tool === 'get_agent_context'));
  assert.ok(context.agent_guidance.next_mcp_calls.some(call => call.tool === 'get_agent_context' && String((call.args as any).path).startsWith('/tmp/')));
  assert.ok(context.agent_guidance.validation.some(rule => /topology-only/.test(rule)));
});

test('classifies library workspaces as composed architecture instead of runtime systems', () => {
  const app = cas({
    system: { id: 'app', name: 'commerce-app', type: 'application', root_path: '/tmp/commerce-app' },
    nodes: [{ id: 'app', name: 'CheckoutApp', type: 'module', source: { file: 'src/app.ts', line: 1 } } as any],
    dependencies: {
      manager: 'npm',
      packages: [
        { name: '@commerce/domain-sdk', version: '1.0.0', direct: true },
        { name: '@commerce/payment-sdk', version: '1.0.0', direct: true },
      ],
    },
  });
  const domain = cas({
    system: {
      id: 'domain',
      name: '@commerce/domain-sdk',
      type: 'package',
      root_path: '/tmp/domain-sdk',
      metadata: { package_name: '@commerce/domain-sdk' },
    },
    nodes: [{ id: 'domain-export', name: 'OrderDomain', type: 'module', source: { file: 'src/index.ts', line: 1 } } as any],
  });
  const payments = cas({
    system: {
      id: 'payments',
      name: '@commerce/payment-sdk',
      type: 'package',
      root_path: '/tmp/payment-sdk',
      metadata: { package_name: '@commerce/payment-sdk' },
    },
    nodes: [{ id: 'payment-export', name: 'PaymentClient', type: 'module', source: { file: 'src/index.ts', line: 1 } } as any],
  });

  const graph = buildCrossCodebaseSystemGraph('commerce-workspace', [
    { path: '/tmp/commerce-app', name: 'commerce-app', cas: app },
    { path: '/tmp/domain-sdk', name: '@commerce/domain-sdk', cas: domain },
    { path: '/tmp/payment-sdk', name: '@commerce/payment-sdk', cas: payments },
  ], { generatedAt: '2026-01-01T00:00:00.000Z' });
  const overview = selectWorkspaceAnalysisDetail(graph, 'overview') as any;
  const context = buildWorkspaceAgentContext(graph, {
    task_type: 'modify',
    target: 'checkout domain payment',
    instructions: 'Add checkout behavior without duplicating domain or payment libraries.',
  });

  assert.equal(graph.composition.kind, 'composed-application-architecture');
  assert.equal(graph.composition.recommended_primary_view, 'architecture-map');
  assert.equal(overview.composition.kind, 'composed-application-architecture');
  assert.ok(graph.application_links.every(link => link.kind === 'sdk-install'));
  assert.ok(context.system_summary.composition_reasons.some(reason => /package|library/.test(reason)));
});

test('validates standalone single-repo workspaces without requiring integration links', () => {
  const api = cas({
    analysis_id: 'analysis:single-api',
    system: { id: 'api', name: 'single-api', type: 'service', root_path: '/tmp/single-api' },
    nodes: [{ id: 'route-node', name: 'HealthController', type: 'function', source: { file: 'src/health.ts', line: 10 } } as any],
    entry_points: [{
      id: 'entry:health',
      source_node: 'route-node',
      type: 'http',
      name: 'GET /health',
      trigger: { method: 'GET', path: '/health' },
    }],
  });

  const graph = buildCrossCodebaseSystemGraph('single-service-workspace', [
    { path: '/tmp/single-api', name: 'single-api', cas: api },
  ], { generatedAt: '2026-01-01T00:00:00.000Z' });

  assert.equal(graph.validation.conforms_to_was, true);
  assert.equal(graph.validation.cas_inputs_validated[0].status, 'valid');
  assert.equal(graph.validation.relationship_coverage.integration_link_count, 0);
});

test('falls back to the repo directory name instead of a hash-shaped workspace basename', () => {
  // Mirrors a real analyzer-server flow: a snapshot is analyzed inside a
  // workspace directory named after an opaque analysis id (a 16-char hex
  // digest of the real repo path), so cas.system.name ends up being that
  // hash instead of the real project name. A deployable/app name must never
  // surface that hash — it should fall back to the actual repo directory's
  // basename ("truckspyapp"), not the workspace-basename hash.
  const hashLikeWorkspaceBasename = '43d8a1e72566feb2';
  const app = cas({
    system: { id: hashLikeWorkspaceBasename, name: hashLikeWorkspaceBasename, type: 'application', root_path: `/tmp/workspaces/${hashLikeWorkspaceBasename}` },
    nodes: [{ id: 'controller', name: 'CustomerApiTokenController', type: 'controller', source: { file: 'Customer/CustomerApiTokenController.php', line: 1 } } as any],
    entry_points: [{
      id: 'entry:token',
      source_node: 'controller',
      type: 'http',
      name: 'POST /api/customer/token',
      trigger: { method: 'POST', path: '/api/customer/token' },
    }],
  });

  // No explicit `name` passed (the real bench/product flow keys the
  // repository input off the real filesystem path but does not always
  // supply a separate display name) — `path` is the one value guaranteed
  // to be the real, human-meaningful directory, never the hash.
  const graph = buildCrossCodebaseSystemGraph('truckspy-system', [
    { path: '/Users/x/dev/clients/outcode/truckspy/truckspyapp', cas: app },
  ]);

  const names = graph.applications.map(candidate => candidate.name);
  assert.ok(!names.includes(hashLikeWorkspaceBasename), `expected no hash-shaped name, got: ${names.join(', ')}`);
  assert.ok(names.includes('truckspyapp'), `expected repo-directory-derived name "truckspyapp", got: ${names.join(', ')}`);
});

test('falls back to the repo directory name instead of a bare external endpoint hostname', () => {
  // Mirrors a real PHP/SOAP integration: a WSDL client hardcodes a remote
  // host (ws.efsllc.com). That host names the OTHER end of the integration,
  // not this repo's own application identity, and must never surface as a
  // deployable/app name (previously produced "ws-efsllc-com").
  const app = cas({
    system: { id: 'wex-client-php', name: 'wex-client-php', type: 'application', root_path: '/tmp/wex-client-php' },
    nodes: [{ id: 'console', name: 'console', type: 'function', source: { file: 'wex-client-php/console.php', line: 1 } } as any],
    external_services: [{
      id: 'external:wex-soap',
      name: 'WEX SOAP client',
      type: 'http',
      endpoint: 'https://ws.efsllc.com/richapp/Wsdl.action?wsdl=/axis2/services/CardManagementWS',
      connected_nodes: ['console'],
    }] as any,
  });

  const graph = buildCrossCodebaseSystemGraph('truckspy-system', [
    { path: '/Users/x/dev/clients/outcode/truckspy/wex-client-php', cas: app },
  ]);

  const names = graph.applications.map(candidate => candidate.name);
  assert.ok(!names.includes('ws-efsllc-com'), `expected no bare-hostname name, got: ${names.join(', ')}`);
  assert.ok(names.includes('wex-client-php'), `expected repo-directory-derived name "wex-client-php", got: ${names.join(', ')}`);
});

// --- WAS narrative quality-gate calibration (live-prod regression fixtures) ---

function shopCas(): CASOutput {
  return cas({
    system: { id: 'shop-api', name: 'shop-api', type: 'service', root_path: '/tmp/shop-api' },
    nodes: [{ id: 'order-route', name: 'createOrder', type: 'function', source: { file: 'src/orders.controller.ts', line: 1 } } as any],
    entry_points: [{ id: 'entry:order', source_node: 'order-route', type: 'http', name: 'POST /orders', trigger: { method: 'POST', path: '/orders' } }],
    system_capabilities: [{
      id: 'capability:order-fulfillment',
      name: 'Order Fulfillment',
      description: 'Deterministic order fulfillment capability text.',
      category: 'core',
      criticality: 'critical',
      operations: [{ entry_point_id: 'entry:order', action: 'create', path_or_command: '/orders' }],
      related_entities: ['Order'],
      related_domains: ['Commerce'],
      confidence: 0.9,
      evidence: ['entry:order'],
    }, {
      id: 'capability:catalog-management',
      name: 'Catalog Management',
      description: 'Deterministic catalog capability text.',
      category: 'core',
      criticality: 'high',
      operations: [{ entry_point_id: 'entry:order', action: 'read', path_or_command: '/catalog' }],
      related_entities: ['Product'],
      related_domains: ['Commerce'],
      confidence: 0.85,
      evidence: ['entry:order'],
    }] as any,
    domain_concepts: [{ id: 'domain:commerce', name: 'Commerce', classification: 'core', confidence: 0.9, evidence: [] } as any],
    data_entities: [
      { id: 'entity_order', name: 'Order', fields: [], lifecycle: { created_by: ['order-route'], read_by: ['order-route'], updated_by: [], deleted_by: [] } },
      { id: 'entity_product', name: 'Product', fields: [], lifecycle: { created_by: [], read_by: ['order-route'], updated_by: [], deleted_by: [] } },
    ] as any,
  });
}

const REAL_SHOP_NARRATIVE = 'This workspace powers the shop-api storefront backend: Order Fulfillment routes checkout orders into the shop-api service and records payment and shipment state, while Catalog Management stores product and price records and surfaces them to the storefront client over the HTTP API.';

// Verbatim shape of the live "Personal" workspace bad-accept (raw project id,
// HTTP-method dump, route param fragment, single-flow altitude).
const PERSONAL_BAD_ACCEPT_NARRATIVE = 'Friends is a workspace visible flow in account project-prj_yg64u7pf7lvdcppt. It is reached by DELETE/PATCH/GET/event route(s) such as /API/friends/:friendshipId and records friendship state so the account can manage friend connections across the workspace projects and services.';

test('WAS quality gate hard-rejects id-leaking, route-dumping, single-flow prose (the Personal bad-accept)', () => {
  const graph = buildCrossCodebaseSystemGraph('personal-workspace', [
    { path: '/tmp/shop-api', name: 'shop-api', cas: shopCas() },
  ]);
  const gate = evaluateWorkspaceNarrativeGate(graph, PERSONAL_BAD_ACCEPT_NARRATIVE, 'Manages friend connections for accounts.');
  assert.equal(gate.accepted, false);
  assert.ok(gate.reason, 'a rejection must carry a specific reason');

  // Each hard-reject marker individually:
  assert.match(String(workspaceNarrativeHardRejectReason('This workspace serves account project-prj_yg64u7pf7lvdcppt records to clients across services and stores them durably for later retrieval by the reporting pipeline and admin tools.', 'summary')), /internal id/i);
  assert.match(String(workspaceNarrativeHardRejectReason('This workspace is reached by DELETE/PATCH/GET route(s) that manage records across the services and store the resulting state for the reporting pipeline and admin tooling to read later.', 'summary')), /route fragments|single-flow/i);
  assert.match(String(workspaceNarrativeHardRejectReason('This workspace exposes endpoints such as /api/friends/:friendshipId that manage records across the services and store the resulting state for the reporting pipeline and admin tooling.', 'summary')), /route path|parameter/i);
  assert.match(String(workspaceNarrativeHardRejectReason('Friends is a workspace visible flow that manages friendship records across the services and stores the resulting state for the reporting pipeline and the admin tooling to read later on.', 'summary')), /single-flow|flow/i);
  // Empty product_value_summary alongside a non-empty description is a hard reject.
  assert.match(String(workspaceNarrativeHardRejectReason(REAL_SHOP_NARRATIVE, '')), /product_value_summary/i);
  // A clean workspace-level narrative with a summary has no hard-reject marker.
  assert.equal(workspaceNarrativeHardRejectReason(REAL_SHOP_NARRATIVE, 'Runs the storefront ordering and catalog backend.'), null);
});

test('WAS quality gate accepts a real workspace narrative that enumerates the workspace\'s own capabilities', () => {
  const graph = buildCrossCodebaseSystemGraph('shop-workspace', [
    { path: '/tmp/shop-api', name: 'shop-api', cas: shopCas() },
  ]);
  const gate = evaluateWorkspaceNarrativeGate(graph, REAL_SHOP_NARRATIVE, 'Runs the storefront ordering and catalog backend.');
  assert.equal(gate.accepted, true, `expected acceptance, got rejection: ${gate.reason}`);
});

test('a no-attempt AI response surfaces an honest enrichment error, never a fake quality-gate rejection', async () => {
  // Direct guard behavior.
  assert.throws(() => assertRealWorkspaceAiAttempt(''), /empty response/i);
  assert.throws(() => assertRealWorkspaceAiAttempt('AI description generation is disabled'), /no real attempt/i);
  assert.doesNotThrow(() => assertRealWorkspaceAiAttempt('{"description":"real model output"}'));

  const originalGenerate = aiService.generateComponentDescription;
  const originalEnv = process.env.KLAURO_WORKSPACE_AI_ENRICHMENT;
  const originalAutoConfig = process.env.KLAURO_WORKSPACE_AI_AUTO_CONFIG;
  const originalOllamaBaseUrl = process.env.OLLAMA_BASE_URL;
  const originalOllamaAuto = process.env.KLAURO_OLLAMA_AUTO;
  process.env.KLAURO_WORKSPACE_AI_ENRICHMENT = 'true';
  process.env.KLAURO_WORKSPACE_AI_AUTO_CONFIG = 'false';
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.KLAURO_OLLAMA_AUTO;
  // The feature-disabled canned string means NO model round-trip happened —
  // the 104ms live instant-degrade class. It must never be laundered into a
  // "rejected by the WAS quality gate" narrative.
  aiService.generateComponentDescription = async () => 'AI description generation is disabled';
  try {
    const graph = buildCrossCodebaseSystemGraph('shop-workspace', [
      { path: '/tmp/shop-api', name: 'shop-api', cas: shopCas() },
    ]);
    await assert.rejects(
      () => enrichWorkspaceAnalysisNarrative(graph),
      (error: Error) => /no real attempt/i.test(error.message) && !/rejected by the WAS quality gate/i.test(error.message),
    );
  } finally {
    aiService.generateComponentDescription = originalGenerate;
    if (originalEnv === undefined) delete process.env.KLAURO_WORKSPACE_AI_ENRICHMENT;
    else process.env.KLAURO_WORKSPACE_AI_ENRICHMENT = originalEnv;
    if (originalAutoConfig === undefined) delete process.env.KLAURO_WORKSPACE_AI_AUTO_CONFIG;
    else process.env.KLAURO_WORKSPACE_AI_AUTO_CONFIG = originalAutoConfig;
    if (originalOllamaBaseUrl === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = originalOllamaBaseUrl;
    if (originalOllamaAuto === undefined) delete process.env.KLAURO_OLLAMA_AUTO;
    else process.env.KLAURO_OLLAMA_AUTO = originalOllamaAuto;
  }
});

test('a gate rejection re-prompts with the rejection reason (and a fresh cache key) before degrading', async () => {
  const originalGenerate = aiService.generateComponentDescription;
  const originalEnv = process.env.KLAURO_WORKSPACE_AI_ENRICHMENT;
  const originalAutoConfig = process.env.KLAURO_WORKSPACE_AI_AUTO_CONFIG;
  const originalOllamaBaseUrl = process.env.OLLAMA_BASE_URL;
  const originalOllamaAuto = process.env.KLAURO_OLLAMA_AUTO;
  process.env.KLAURO_WORKSPACE_AI_ENRICHMENT = 'true';
  process.env.KLAURO_WORKSPACE_AI_AUTO_CONFIG = 'false';
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.KLAURO_OLLAMA_AUTO;

  const contexts: Array<Record<string, unknown> | undefined> = [];
  aiService.generateComponentDescription = async (context: any) => {
    contexts.push(context?.additionalContext);
    if (context?.additionalContext?.rejection_feedback) {
      // The re-prompt (carrying the gate's rejection reason) produces a real narrative.
      return JSON.stringify({
        description: REAL_SHOP_NARRATIVE,
        product_value_summary: 'Runs the storefront ordering and catalog backend.',
      });
    }
    // First attempt: generic inventory prose the gate rejects.
    return JSON.stringify({
      description: 'This workspace consists of multiple projects and provides various applications and services for end users, and it appears to serve customer-related functionality across the analyzed repositories in a generally useful manner overall.',
      product_value_summary: 'The workspace may serve customer functionality.',
    });
  };
  try {
    const graph = buildCrossCodebaseSystemGraph('shop-workspace', [
      { path: '/tmp/shop-api', name: 'shop-api', cas: shopCas() },
    ]);
    const enriched = await enrichWorkspaceAnalysisNarrative(graph);
    assert.equal(enriched.workspace_narrative.source, 'ai');
    assert.match(enriched.workspace_narrative.description, /Order Fulfillment routes checkout orders/);
    const repairContext = contexts.find(context => typeof context?.rejection_feedback === 'string');
    assert.ok(repairContext, 'the repair re-prompt must carry rejection_feedback');
    assert.match(String(repairContext!.rejection_feedback), /rejected by the WAS quality gate/i);
    // The retry attempt index is part of the prompt context so the retry can
    // never replay the rejected response from the content-addressed AI cache.
    assert.equal(typeof repairContext!.retry_attempt, 'number');
  } finally {
    aiService.generateComponentDescription = originalGenerate;
    if (originalEnv === undefined) delete process.env.KLAURO_WORKSPACE_AI_ENRICHMENT;
    else process.env.KLAURO_WORKSPACE_AI_ENRICHMENT = originalEnv;
    if (originalAutoConfig === undefined) delete process.env.KLAURO_WORKSPACE_AI_AUTO_CONFIG;
    else process.env.KLAURO_WORKSPACE_AI_AUTO_CONFIG = originalAutoConfig;
    if (originalOllamaBaseUrl === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = originalOllamaBaseUrl;
    if (originalOllamaAuto === undefined) delete process.env.KLAURO_OLLAMA_AUTO;
    else process.env.KLAURO_OLLAMA_AUTO = originalOllamaAuto;
  }
});

test('ambiguous general-purpose ports (Django 8000, pprof 6060) never assert a crypto workspace domain', () => {
  const djangoOrders = {
    id: 'app:hercules',
    codebase_id: 'hercules',
    codebase_path: '/tmp/hercules',
    name: 'hercules-orders',
    kind: 'service',
    deployable: true,
    path_hint: '',
    service_aliases: [],
    ports: ['8000', '8001', '6060'],
    interface_ids: [],
    runtime_component_ids: [],
    evidence: [],
  } as any;
  const noCrypto = detectWorkspaceCryptoProfile([], [djangoOrders], new Map());
  assert.equal(noCrypto.isCrypto, false, `a Django orders app on :8000 must not assert crypto: ${JSON.stringify(noCrypto.evidence)}`);

  // Real blockchain RPC ports still assert decisively.
  const evmNode = { ...djangoOrders, id: 'app:evm', name: 'geth-node', ports: ['8545', '30303'] } as any;
  const crypto = detectWorkspaceCryptoProfile([], [evmNode], new Map());
  assert.equal(crypto.isCrypto, true);
  assert.ok(crypto.rpc_ports.includes('8545'));
});
