import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRealWorkspaceAiAttempt, buildCrossCodebaseSystemGraph, buildWorkspaceAgentContext, detectWorkspaceCryptoProfile, enforceWorkspaceNarrativeProductValueSummary, enrichWorkspaceAnalysisNarrative, evaluateWorkspaceNarrativeGate, isUncorroboratedEntityNameDomain, isVerbPhraseDomainLabel, isWorkspaceAiParseArtifactText, normalizeWorkspaceAiDescriptionText, productFrameworksFromCas, selectPreferredWorkspaceOllamaModel, selectWorkspaceAnalysisDetail, stripUngroundedWorkspaceMarketingLanguage, stripWorkspaceItemDescriptionArtifacts, withWorkspaceAiTimeout, workspaceNarrativeDomainMisattributionReason, workspaceNarrativeEntityMisattributionReason, workspaceNarrativeHardRejectReason, workspaceNarrativeMarketingMatches, workspaceNarrativeMisattributionReason, workspaceNarrativePromptContext } from './cross-codebase-analysis';
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
  // mcp-agent-surface used to fire from name coincidence alone (an app named
  // "mcp-*" alongside apps named "agent"/"coordinator"/etc). There is no
  // structural evidence for "agent-ness" anywhere in CAS/WAS, so the insight
  // was deleted (evidence-or-delete) rather than kept as a name guess.
  assert.ok(!graph.system_insights.some(insight => insight.type === 'mcp-agent-surface'));
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

test('does not link a UI to an API on name similarity alone; requires endpoint evidence', () => {
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

  // Sharing "admin" naming with no exit-point/endpoint evidence must NOT produce a link:
  // link inference is evidence-only now, there is no name-vocabulary fallback.
  assert.ok(!graph.application_links.some(candidate =>
    appNames.get(candidate.source_application_id) === 'admin-ui' &&
    appNames.get(candidate.target_application_id) === 'admin-api'
  ));
});

test('links a UI to an API once a real endpoint call is present (source-backed, not name-inferred)', () => {
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
    exit_points: [{
      id: 'exit:admin-users',
      source_node: 'config',
      type: 'api',
      name: 'fetch users',
      target: { endpoint: 'http://admin-api/users' },
      operation: { method: 'GET' },
    }],
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
  assert.equal(link.evidence_quality, 'source-backed');
  assert.ok(link.confidence >= 0.7);
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
  // Hash-shaped token leak (live: "Docker images from a Dockerfile with hash 7331").
  assert.match(String(workspaceNarrativeHardRejectReason('This workspace builds Docker images from a Dockerfile with hash 7331 and ships them to the registry so deployment stays consistent across the analysis services and the admin tooling that operates them.', 'summary')), /hash/i);
  assert.match(String(workspaceNarrativeHardRejectReason('This workspace publishes release artifacts whose sha 4f3a2b1c digest is recorded alongside the build metadata so downstream services can trace which build produced each running deployment across environments.', 'summary')), /hash/i);
  // Prose that merely talks about checksum verification (no bare token) is clean.
  assert.equal(workspaceNarrativeHardRejectReason('This workspace verifies SHA-256 checksums during install and coordinates the registry, deployment services, and the admin tooling that keep storefront releases consistent for the engineering teams that operate them.', 'Runs release verification for the storefront platform.'), null);
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

test('a model response that lacks product_value_summary is rejected at the accept path and re-prompted naming the missing field', async () => {
  const originalGenerate = aiService.generateComponentDescription;
  const originalEnv = process.env.KLAURO_WORKSPACE_AI_ENRICHMENT;
  const originalAutoConfig = process.env.KLAURO_WORKSPACE_AI_AUTO_CONFIG;
  process.env.KLAURO_WORKSPACE_AI_ENRICHMENT = 'true';
  process.env.KLAURO_WORKSPACE_AI_AUTO_CONFIG = 'false';

  const contexts: Array<Record<string, unknown> | undefined> = [];
  aiService.generateComponentDescription = async (context: any) => {
    contexts.push(context?.additionalContext);
    if (typeof context?.additionalContext?.rejection_feedback === 'string') {
      // The field-naming re-prompt supplies the missing summary.
      return JSON.stringify({
        description: REAL_SHOP_NARRATIVE,
        product_value_summary: 'Runs the storefront ordering and catalog backend.',
      });
    }
    // First attempt: an otherwise-acceptable narrative that simply OMITS the
    // product_value_summary field (the live v1.0.63 OpenClaw/Clients/Personal
    // shape). The old accept path persisted this as source='ai' with an empty
    // summary; it must now be rejected and re-prompted instead.
    return JSON.stringify({ description: REAL_SHOP_NARRATIVE });
  };
  try {
    const graph = buildCrossCodebaseSystemGraph('shop-workspace', [
      { path: '/tmp/shop-api', name: 'shop-api', cas: shopCas() },
    ]);
    const enriched = await enrichWorkspaceAnalysisNarrative(graph);
    assert.equal(enriched.workspace_narrative.source, 'ai');
    assert.equal(enriched.workspace_narrative.product_value_summary, 'Runs the storefront ordering and catalog backend.');
    const repairContext = contexts.find(context => typeof context?.rejection_feedback === 'string');
    assert.ok(repairContext, 'the re-prompt must fire when the summary field is missing');
    assert.match(String(repairContext!.rejection_feedback), /product_value_summary/i, 'the re-prompt must name the missing field');
  } finally {
    aiService.generateComponentDescription = originalGenerate;
    if (originalEnv === undefined) delete process.env.KLAURO_WORKSPACE_AI_ENRICHMENT;
    else process.env.KLAURO_WORKSPACE_AI_ENRICHMENT = originalEnv;
    if (originalAutoConfig === undefined) delete process.env.KLAURO_WORKSPACE_AI_AUTO_CONFIG;
    else process.env.KLAURO_WORKSPACE_AI_AUTO_CONFIG = originalAutoConfig;
  }
});

test('persist seam: source=ai with an empty product_value_summary is structurally impossible', async () => {
  const originalGenerate = aiService.generateComponentDescription;
  const graph = buildCrossCodebaseSystemGraph('shop-workspace', [
    { path: '/tmp/shop-api', name: 'shop-api', cas: shopCas() },
  ]);

  // Case 1: the field-naming re-prompt recovers the summary and 'ai' stands.
  const contexts: Array<Record<string, unknown> | undefined> = [];
  aiService.generateComponentDescription = async (context: any) => {
    contexts.push(context?.additionalContext);
    return JSON.stringify({ product_value_summary: 'Runs the storefront ordering and catalog backend.' });
  };
  try {
    graph.workspace_narrative = { ...graph.workspace_narrative, source: 'ai', description: REAL_SHOP_NARRATIVE, product_value_summary: '' };
    await enforceWorkspaceNarrativeProductValueSummary(graph);
    assert.equal(graph.workspace_narrative.source, 'ai');
    assert.equal(graph.workspace_narrative.product_value_summary, 'Runs the storefront ordering and catalog backend.');
    assert.equal(contexts.length, 1, 'exactly one re-prompt');
    assert.match(String(contexts[0]?.rejection_feedback), /product_value_summary/i, 'the re-prompt must name the missing field');

    // Case 2: the re-prompt STILL does not supply the field -> honest degrade.
    aiService.generateComponentDescription = async () => JSON.stringify({ description: 'still no summary field in this response, only unrelated prose that goes on long enough to be non-empty' });
    graph.workspace_narrative = { ...graph.workspace_narrative, source: 'ai', description: REAL_SHOP_NARRATIVE, product_value_summary: '' };
    await enforceWorkspaceNarrativeProductValueSummary(graph);
    assert.equal(graph.workspace_narrative.source, 'ai-required-degraded');
    assert.match(String(graph.workspace_narrative.degraded_reason), /missing product_value_summary/i);

    // Case 3: the AI call fails outright -> honest degrade, never empty-PVS-as-ai.
    aiService.generateComponentDescription = async () => { throw new Error('provider down'); };
    graph.workspace_narrative = { ...graph.workspace_narrative, source: 'ai', description: REAL_SHOP_NARRATIVE, product_value_summary: '', degraded_reason: undefined };
    await enforceWorkspaceNarrativeProductValueSummary(graph);
    assert.equal(graph.workspace_narrative.source, 'ai-required-degraded');
    assert.match(String(graph.workspace_narrative.degraded_reason), /missing product_value_summary/i);

    // A narrative that already carries a summary is untouched (no AI call).
    let called = false;
    aiService.generateComponentDescription = async () => { called = true; return '{}'; };
    graph.workspace_narrative = { ...graph.workspace_narrative, source: 'ai', description: REAL_SHOP_NARRATIVE, product_value_summary: 'Runs the storefront ordering and catalog backend.', degraded_reason: undefined };
    await enforceWorkspaceNarrativeProductValueSummary(graph);
    assert.equal(graph.workspace_narrative.source, 'ai');
    assert.equal(called, false);
  } finally {
    aiService.generateComponentDescription = originalGenerate;
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

// ---------------------------------------------------------------------------
// Workspace narrative frame-bias fixes (the live OpenClaw degrade loop):
// (1) the prompt context carries the workspace's OWN member domains and no
//     hardcoded frame vocabulary, (2) a frame rejection re-prompts with
//     feedback naming the actual rejected frame on a fresh cache key, and
// (3) the WAS AI timeout is env-configurable with a generous default.
// ---------------------------------------------------------------------------

function messagingGatewayCas(): CASOutput {
  return cas({
    system: { id: 'openclaw-gateway', name: 'openclaw-gateway', type: 'service', root_path: '/tmp/openclaw-gateway' } as any,
    nodes: [{ id: 'route-node', name: 'routeInboundMessage', type: 'function', source: { file: 'src/gateway/router.ts', line: 1 } } as any],
    entry_points: [{ id: 'entry:message', source_node: 'route-node', type: 'http', name: 'POST /channels/inbound', trigger: { method: 'POST', path: '/channels/inbound' } }] as any,
    enhanced_system_purpose: {
      primary_domain: 'messaging-gateway',
      core_concepts: ['Channel Routing', 'Exec Approvals'],
    } as any,
    system_capabilities: [{
      id: 'capability:channel-routing',
      name: 'Multi-Channel Message Routing',
      description: 'Routes inbound and outbound messages across Discord, Telegram, and Slack channel adapters.',
      category: 'core',
      criticality: 'critical',
      operations: [{ entry_point_id: 'entry:message', action: 'route', path_or_command: '/channels/inbound' }],
      related_entities: ['ChannelMessage'],
      related_domains: ['Messaging'],
      confidence: 0.9,
      evidence: ['entry:message'],
    }, {
      id: 'capability:exec-approvals',
      name: 'Exec Approvals',
      description: 'Holds outbound agent exec commands for human approval before dispatching them to a channel.',
      category: 'core',
      criticality: 'high',
      operations: [{ entry_point_id: 'entry:message', action: 'approve', path_or_command: '/approvals' }],
      related_entities: ['ExecApproval'],
      related_domains: ['Messaging'],
      confidence: 0.85,
      evidence: ['entry:message'],
    }] as any,
    domain_concepts: [{ id: 'domain:messaging', name: 'Messaging', classification: 'core', confidence: 0.9, evidence: [] }] as any,
    data_entities: [
      { id: 'entity_channel_message', name: 'ChannelMessage', fields: [], lifecycle: { created_by: ['route-node'], read_by: ['route-node'], updated_by: [], deleted_by: [] } },
      { id: 'entity_exec_approval', name: 'ExecApproval', fields: [], lifecycle: { created_by: ['route-node'], read_by: ['route-node'], updated_by: [], deleted_by: [] } },
    ] as any,
  });
}

test('workspace narrative prompt foregrounds the members\' own domains and contains no hardcoded frame vocabulary', () => {
  const graph = buildCrossCodebaseSystemGraph('openclaw-workspace', [
    { path: '/tmp/openclaw-gateway', name: 'openclaw-gateway', cas: messagingGatewayCas() },
  ]);
  const context = workspaceNarrativePromptContext(graph) as any;
  const serialized = JSON.stringify(context);

  // The member project's own analyzed primary_domain is foregrounded.
  assert.match(serialized, /messaging-gateway/, 'the member primary_domain must appear in the prompt context');
  const memberProjects = context.facts?.member_projects as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(memberProjects) && memberProjects.length > 0, 'facts.member_projects must be present');
  assert.equal(memberProjects[0].primary_domain, 'messaging-gateway');
  const mustExplain = (context.facts?.must_explain || []) as string[];
  assert.ok(mustExplain.some(item => /primary_domain is messaging-gateway/.test(item)), `must_explain must lead with member domain evidence, got: ${JSON.stringify(mustExplain)}`);

  // NEVER-HARDCODE: the old classifier-era frame exemplars must not appear
  // anywhere in the prompt for a workspace whose evidence does not contain them
  // (they seeded exactly those frames into the model output — the OpenClaw bias).
  assert.doesNotMatch(serialized, /secure network access/i);
  assert.doesNotMatch(serialized, /zero-trust/i);
  assert.doesNotMatch(serialized, /codebase intelligence/i);
  assert.doesNotMatch(serialized, /desktop-agent access/i);
  assert.doesNotMatch(serialized, /agent-context infrastructure/i);
});

test('a frame rejection re-prompts with feedback naming the actual rejected frame, on a fresh cache key per attempt', async () => {
  const originalGenerate = aiService.generateComponentDescription;
  const originalEnv = process.env.KLAURO_WORKSPACE_AI_ENRICHMENT;
  const originalAutoConfig = process.env.KLAURO_WORKSPACE_AI_AUTO_CONFIG;
  const originalOllamaBaseUrl = process.env.OLLAMA_BASE_URL;
  const originalOllamaAuto = process.env.KLAURO_OLLAMA_AUTO;
  process.env.KLAURO_WORKSPACE_AI_ENRICHMENT = 'true';
  process.env.KLAURO_WORKSPACE_AI_AUTO_CONFIG = 'false';
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.KLAURO_OLLAMA_AUTO;

  // A shop workspace has NO codebase-intelligence evidence, so a narrative
  // claiming that frame must be frame-rejected (the OpenClaw failure shape).
  const FRAMED_JUNK = JSON.stringify({
    description: 'This workspace provides codebase intelligence for coding agents: the analyzer builds a precomputed graph over the repositories and serves agent context through MCP so that agents can navigate the services, routes, and tooling that make up the analyzed system.',
    product_value_summary: 'Serves codebase intelligence and agent context to coding agents.',
  });
  const contexts: Array<Record<string, unknown> | undefined> = [];
  let repairCalls = 0;
  aiService.generateComponentDescription = async (context: any) => {
    contexts.push(context?.additionalContext);
    if (typeof context?.additionalContext?.rejection_feedback === 'string') {
      repairCalls += 1;
      // First repair attempt repeats the bad frame; the second converges.
      if (repairCalls === 1) return FRAMED_JUNK;
      return JSON.stringify({
        description: REAL_SHOP_NARRATIVE,
        product_value_summary: 'Runs the storefront ordering and catalog backend.',
      });
    }
    return FRAMED_JUNK;
  };
  try {
    const graph = buildCrossCodebaseSystemGraph('shop-workspace', [
      { path: '/tmp/shop-api', name: 'shop-api', cas: shopCas() },
    ]);
    const enriched = await enrichWorkspaceAnalysisNarrative(graph);
    assert.equal(enriched.workspace_narrative.source, 'ai', `expected convergence after frame-rejection retries, got: ${enriched.workspace_narrative.degraded_reason}`);
    assert.match(enriched.workspace_narrative.description, /Order Fulfillment routes checkout orders/);

    const repairContexts = contexts.filter(context => typeof context?.rejection_feedback === 'string');
    assert.ok(repairContexts.length >= 2, `expected at least two frame-rejection re-prompts, got ${repairContexts.length}`);
    // The feedback names the ACTUAL rejected frame (from the narrative text,
    // not a hardcoded list) and points at the workspace's own evidence.
    assert.match(String(repairContexts[0]!.rejection_feedback), /codebase intelligence/i, 'feedback must name the rejected frame');
    assert.match(String(repairContexts[0]!.rejection_feedback), /does not support/i);
    assert.match(String(repairContexts[0]!.rejection_feedback), /workspace's own evidence/i, 'feedback must point at the real evidence to use');
    // Every retry is a distinct cache key: attempt index AND per-call nonce.
    const nonces = repairContexts.map(context => String(context!.retry_nonce || ''));
    assert.ok(nonces.every(nonce => nonce.length > 0), 'every retry must carry a cache-busting nonce');
    assert.equal(new Set(nonces).size, nonces.length, 'retry cache keys must differ across attempts');
    // The repair context supplies the workspace's own domain evidence to reframe with.
    assert.ok(Array.isArray(repairContexts[0]!.workspace_domains), 'repair prompt must carry workspace_domains evidence');
    assert.ok(Array.isArray(repairContexts[0]!.member_projects), 'repair prompt must carry member_projects evidence');
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

test('WAS AI timeout is env-configurable (KLAURO_WAS_AI_TIMEOUT_MS, legacy alias) with a generous default', async () => {
  const originalNew = process.env.KLAURO_WAS_AI_TIMEOUT_MS;
  const originalLegacy = process.env.KLAURO_WORKSPACE_AI_TIMEOUT_MS;
  const delay = <T,>(ms: number, value: T) => new Promise<T>(resolve => setTimeout(() => resolve(value), ms));
  try {
    // Default is generous (120s) — a slow-ish provider chain is not killed.
    delete process.env.KLAURO_WAS_AI_TIMEOUT_MS;
    delete process.env.KLAURO_WORKSPACE_AI_TIMEOUT_MS;
    assert.equal(await withWorkspaceAiTimeout(delay(30, 'ok')), 'ok');

    // KLAURO_WAS_AI_TIMEOUT_MS is respected.
    process.env.KLAURO_WAS_AI_TIMEOUT_MS = '10';
    await assert.rejects(() => withWorkspaceAiTimeout(delay(300, 'late')), /exceeded 10ms/);

    // Legacy KLAURO_WORKSPACE_AI_TIMEOUT_MS still works as an alias.
    delete process.env.KLAURO_WAS_AI_TIMEOUT_MS;
    process.env.KLAURO_WORKSPACE_AI_TIMEOUT_MS = '10';
    await assert.rejects(() => withWorkspaceAiTimeout(delay(300, 'late')), /exceeded 10ms/);

    // The new var wins over the legacy alias.
    process.env.KLAURO_WAS_AI_TIMEOUT_MS = '5000';
    assert.equal(await withWorkspaceAiTimeout(delay(30, 'ok')), 'ok');
  } finally {
    if (originalNew === undefined) delete process.env.KLAURO_WAS_AI_TIMEOUT_MS;
    else process.env.KLAURO_WAS_AI_TIMEOUT_MS = originalNew;
    if (originalLegacy === undefined) delete process.env.KLAURO_WORKSPACE_AI_TIMEOUT_MS;
    else process.env.KLAURO_WORKSPACE_AI_TIMEOUT_MS = originalLegacy;
  }
});

// --- WAS output-quality regressions (live 4-workspace audit fixtures) ---

test('persist-seam guard: unparsed structured model output is never a description (JSON-leak class)', () => {
  // Verbatim shape of the live capability-description blob leak.
  const blob = '{ "key_capabilities": [ { "name": "Manages project and codebase lifecycle", "description": "Handles project records" } ] }';
  assert.equal(isWorkspaceAiParseArtifactText(blob), true);
  assert.equal(isWorkspaceAiParseArtifactText('[{"name":"x"}]'), true);
  assert.equal(isWorkspaceAiParseArtifactText('```json\n{"description":"x"}\n```'), true);
  assert.equal(isWorkspaceAiParseArtifactText('Reads "description" values are honest prose here: manages project and codebase lifecycle across the workspace API.'), false);

  // Narrative hard-reject: a blob description can never be accepted.
  const reason = workspaceNarrativeHardRejectReason(blob, 'Manages orders for the storefront.');
  assert.ok(reason && /unparsed structured-output artifact/.test(reason), `expected artifact hard-reject, got: ${reason}`);
  const graph = buildCrossCodebaseSystemGraph('personal-workspace', [
    { path: '/tmp/shop-api', name: 'shop-api', cas: shopCas() },
  ]);
  const gate = evaluateWorkspaceNarrativeGate(graph, blob, 'Manages orders for the storefront.');
  assert.equal(gate.accepted, false);
});

test('misattribution gate: member A capabilities in a sentence whose subject is member B are rejected', () => {
  const graph = {
    name: 'Personal',
    codebases: [
      { id: 'prj-kontinuum', name: 'kontinuum', primary_domain: 'document-management' },
      { id: 'prj-mtg', name: 'mtg', primary_domain: 'game-economy' },
    ],
    applications: [],
    distribution_units: [],
    system_insights: [],
    workspace_domains: [],
    workspace_entities: [],
    workspace_capabilities: [
      { name: 'Manage User Economy Transactions', project_ids: ['prj-mtg'], deployable_ids: [], evidence: [] },
      { name: 'Manage Workspace Documents', project_ids: ['prj-kontinuum'], deployable_ids: [], evidence: [] },
    ],
  } as any;

  // The live Personal-workspace defect shape: Kontinuum (member B) named as the
  // workspace and given mtg's (member A) entire game product.
  const bad = 'Kontinuum is a workspace that helps players manage user economy transactions and user game activity.';
  const reason = workspaceNarrativeMisattributionReason(graph, bad);
  assert.ok(reason && /Manage User Economy Transactions/.test(reason) && /mtg/.test(reason), `expected misattribution reason, got: ${reason}`);
  assert.equal(evaluateWorkspaceNarrativeGate(graph, bad, 'Manages personal projects.').accepted, false);

  // Correct per-member attribution passes the misattribution check.
  const good = 'mtg manages user economy transactions for players, while kontinuum manages workspace documents for owners.';
  assert.equal(workspaceNarrativeMisattributionReason(graph, good), null);

  // Single-member workspaces are exempt (nothing to cross-attribute).
  const single = { ...graph, codebases: [graph.codebases[0]] };
  assert.equal(workspaceNarrativeMisattributionReason(single, bad), null);
});

test('WAS narrative gate applies the project-tier marketing lint: saturation rejects, single instances strip', () => {
  const graph = buildCrossCodebaseSystemGraph('openclaw-workspace', [
    { path: '/tmp/shop-api', name: 'shop-api', cas: shopCas() },
  ]);
  // Verbatim class of the live OpenClaw fluff that survived the gate.
  const fluff = 'This comprehensive workspace offers a robust set of features and provides a strong foundation, making it an ideal solution for businesses and organizations.';
  const matches = workspaceNarrativeMarketingMatches(graph, fluff);
  assert.ok(matches.length >= 3, `expected saturated marketing matches, got: ${JSON.stringify(matches)}`);
  const gate = evaluateWorkspaceNarrativeGate(graph, fluff, 'Manages orders for the storefront.');
  assert.equal(gate.accepted, false);
  assert.ok(/unsupported-marketing-language/.test(gate.reason || ''), `expected marketing rejection, got: ${gate.reason}`);

  // A single ungrounded instance is stripped mechanically, keeping the facts.
  const single = 'This comprehensive workspace routes checkout orders into the shop-api service and records payment and shipment state for the storefront.';
  const stripped = stripUngroundedWorkspaceMarketingLanguage(graph, single);
  assert.ok(!/comprehensive/i.test(stripped), `expected "comprehensive" stripped, got: ${stripped}`);
  assert.ok(/routes checkout orders into the shop-api service/.test(stripped), `facts must survive the strip, got: ${stripped}`);
});

test('workspace domains are evidence-length: no verb-phrase capability labels, no silent 16-quota padding', () => {
  const app = cas({
    system: { id: 'msgs', name: 'msgs-api', type: 'service', root_path: '/tmp/msgs-api' },
    nodes: [{ id: 'send-route', name: 'sendMessage', type: 'function', source: { file: 'src/messages.controller.ts', line: 1 } } as any],
    entry_points: [{ id: 'entry:send', source_node: 'send-route', type: 'http', name: 'POST /messages', trigger: { method: 'POST', path: '/messages' } }],
    system_capabilities: [{
      id: 'capability:send-messages',
      name: 'Send Messages',
      description: 'Sends messages between users.',
      category: 'core',
      criticality: 'high',
      operations: [{ entry_point_id: 'entry:send', action: 'create', path_or_command: '/messages' }],
      related_entities: ['Message'],
      related_domains: [],
      confidence: 0.9,
      evidence: ['entry:send'],
    }] as any,
    data_entities: [
      { id: 'entity_pricingtype', name: 'PricingType', fields: [], lifecycle: { created_by: [], read_by: ['send-route'], updated_by: [], deleted_by: [] } },
      { id: 'entity_telemetrysnapshot', name: 'TelemetrySnapshot', fields: [], lifecycle: { created_by: [], read_by: ['send-route'], updated_by: [], deleted_by: [] } },
    ] as any,
  });
  const graph = buildCrossCodebaseSystemGraph('padding-workspace', [{ path: '/tmp/msgs-api', cas: app }]);
  const domainNames = graph.workspace_domains.map(domain => domain.name);
  // Verb-phrase capability labels are the wrong altitude for domains.
  assert.ok(!domainNames.some(name => /^Sends? Messages$/i.test(name)), `verb-phrase label leaked into domains: ${JSON.stringify(domainNames)}`);
  // Bare entity/class names never pad the domain list.
  assert.ok(!domainNames.includes('PricingType'), `entity name leaked into domains: ${JSON.stringify(domainNames)}`);
  assert.ok(!domainNames.includes('TelemetrySnapshot'), `entity name leaked into domains: ${JSON.stringify(domainNames)}`);
  // Evidence-length, not quota-length.
  assert.ok(graph.workspace_domains.length < 16, `expected an evidence-length domain list, got ${graph.workspace_domains.length}`);
});

test('workflow summary surfaces the true pre-cap count and a truncation flag', () => {
  const graph = buildCrossCodebaseSystemGraph('shop-workspace', [
    { path: '/tmp/shop-api', name: 'shop-api', cas: shopCas() },
  ]);
  assert.equal(typeof graph.summary.workflows_total, 'number');
  assert.equal(graph.summary.workflows_total, graph.workspace_workflows.length);
  assert.equal(graph.summary.workflows_truncated, false);
  assert.ok(graph.workspace_workflows.length <= 40);
});

test('compound product tokens survive prose normalization (macOS / iOS / iMessages tokenizer artifacts)', () => {
  const text = normalizeWorkspaceAiDescriptionText('Runs on macOS and iOS devices and relays iMessages through the gateway workflowEngine.');
  assert.ok(text.includes('macOS'), `macOS must not split, got: ${text}`);
  assert.ok(text.includes('iOS'), `iOS must not split, got: ${text}`);
  assert.ok(text.includes('iMessages'), `iMessages must not split, got: ${text}`);
  assert.ok(!/\bmac OS\b/.test(text), `got tokenizer artifact: ${text}`);
  assert.ok(!/\bi OS\b/.test(text), `got tokenizer artifact: ${text}`);
  // Real concatenated camelCase words still split into prose.
  assert.ok(/workflow Engine/.test(text), `expected camelCase prose split, got: ${text}`);
});

test('workspace narrative title uses the workspace name, never a member project name', () => {
  const graph = buildCrossCodebaseSystemGraph('Personal', [
    { path: '/tmp/shop-api', name: 'shop-api', cas: shopCas() },
  ]);
  assert.equal(graph.workspace_narrative.title, 'Personal workspace analysis');
});

test('internal analysis phrasing stays out of the narrative relationship summary', () => {
  const graph = buildCrossCodebaseSystemGraph('diag-workspace', [
    { path: '/tmp/shop-api', name: 'shop-api', cas: shopCas() },
  ]);
  for (const line of graph.workspace_narrative.relationship_summary) {
    assert.ok(!/source-backed|should not be forced|system graph|deployable\(s\)/i.test(line), `internal analysis phrase leaked into relationship_summary: ${line}`);
  }
});

// ============================================================================
// WAS live-revalidation defect fixes (v1.0.66 4-workspace audit)
// ============================================================================

// The real hosted blob (Klauro/Clients/Personal): the model echoed the repair
// prompt PAYLOAD back, so its embedded JSON arrives backslash-escaped and starts
// with a bare quoted key ("task":) — evading every unescaped-quote guard.
const REAL_PROMPT_ECHO_BLOB =
  '"task": "Return only valid JSON shaped {\\"key_capabilities\\":[{\\"name\\":\\"Surfaces codebase analysis insights\\",\\"description\\":\\"...\\"}]}. Generate exactly one AI description for the exact capability name.", "exact_name": "Surfaces codebase analysis insights"';

test('DEFECT1: parse-artifact guard catches escaped-quote prompt-echo blobs (real hosted shape)', () => {
  assert.equal(isWorkspaceAiParseArtifactText(REAL_PROMPT_ECHO_BLOB), true);
  // Unescaped and brace-led variants still caught; real prose is not.
  assert.equal(isWorkspaceAiParseArtifactText('{"key_capabilities":[]}'), true);
  assert.equal(isWorkspaceAiParseArtifactText('"description": "x"'), true);
  assert.equal(isWorkspaceAiParseArtifactText('Return only valid JSON shaped ...'), true);
  assert.equal(isWorkspaceAiParseArtifactText('Surfaces analyzed codebase structure, entities, and risks as reviewable context for engineers and agents.'), false);
});

test('DEFECT1: persist-seam sanitizer clears blob descriptions to honest absence (never the blob)', () => {
  const graph: any = {
    workspace_capabilities: [{ name: 'Surfaces codebase analysis insights', description: REAL_PROMPT_ECHO_BLOB, description_source: 'ai' }],
    workspace_domains: [{ name: 'Surfaces Codebase Analysis Results', description: REAL_PROMPT_ECHO_BLOB, description_source: 'ai' }],
    workspace_workflows: [],
    workspace_entities: [],
    workspace_narrative: { description: 'Real narrative.', product_value_summary: 'Real summary.', source: 'ai' },
    detail_views: { overview: { capabilities: [{ name: 'Surfaces codebase analysis insights', description: REAL_PROMPT_ECHO_BLOB }], description: 'Real narrative.' } },
  };
  const cleared = stripWorkspaceItemDescriptionArtifacts(graph);
  assert.equal(cleared, 2);
  assert.equal(graph.workspace_capabilities[0].description, '');
  assert.equal(graph.workspace_capabilities[0].description_source, 'ai-required-degraded');
  assert.equal(graph.workspace_domains[0].description, '');
  // Detail-view projection is re-synced from the sanitized array — no stale blob.
  assert.equal(graph.detail_views.overview.capabilities[0].description, '');
});

test('DEFECT2: domain misattribution uses deterministic workspace_domains as ground truth', () => {
  const graph: any = {
    name: 'Personal',
    codebases: [
      { id: 'p-kontinuum', name: 'kontinuum' },
      { id: 'p-mtg', name: 'mtg' },
    ],
    workspace_capabilities: [],
    workspace_domains: [{ name: 'Game Server', project_ids: ['p-mtg'] }],
  };
  // Subject "Kontinuum" credited with mtg's Game Server -> reject, even though
  // "mtg" is also named later in the sentence (evades the capability gate).
  const bad = 'Kontinuum is a personal intelligence substrate that manages memory, while also providing a game server, and is connected to the mtg game server.';
  const reason = workspaceNarrativeDomainMisattributionReason(graph, bad);
  assert.ok(reason && /Game Server/.test(reason) && /mtg/.test(reason), `expected misattribution reason, got ${reason}`);
  // Owner-qualified reference to mtg's own asset is legitimate -> accept.
  const good = 'Kontinuum is a personal intelligence substrate; the mtg game server is a separate member.';
  assert.equal(workspaceNarrativeDomainMisattributionReason(graph, good), null);
});

test('DEFECT-WAS1: entity misattribution catches paraphrased cross-member credit the domain gate evades (real Personal shape)', () => {
  const graph: any = {
    name: 'Personal',
    codebases: [
      { id: 'p-kontinuum', name: 'kontinuum' },
      { id: 'p-mtg', name: 'mtg' },
    ],
    workspace_capabilities: [],
    // decks/economy are mtg's ENTITIES, never top-level domains -> the domain
    // gate cannot see them; the entity gate is the ground truth.
    workspace_domains: [],
    workspace_entities: [
      { name: 'Deck', project_ids: ['p-mtg'] },
      { name: 'EconomyTransaction', project_ids: ['p-mtg'] },
      { name: 'RemoteMemory', project_ids: ['p-kontinuum'] },
      { name: 'Account', project_ids: ['p-kontinuum', 'p-mtg'] }, // co-owned -> ignored
    ],
  };
  // The exact live degraded narrative: Kontinuum credited with mtg's decks +
  // economy transactions (paraphrased, so the exact-phrase capability gate misses it).
  const bad = 'Kontinuum is a web based platform that enables users to purchase and manage decks, while also providing secure remote task reports and managing user economy transactions.';
  // The domain-only gate (prior mechanism) does NOT catch this — that is the evasion.
  assert.equal(workspaceNarrativeDomainMisattributionReason(graph, bad), null);
  // The entity gate does, keyed on deterministic member->entity attribution.
  const reason = workspaceNarrativeEntityMisattributionReason(graph, bad);
  assert.ok(reason && /mtg/.test(reason) && /(EconomyTransaction|Deck)/.test(reason), `expected entity misattribution, got ${reason}`);
  assert.equal(evaluateWorkspaceNarrativeGate(graph, bad, 'A digital asset system.').accepted, false);
  // CONTROL: correctly-attributed narrative (mtg owns decks/economy) passes.
  const good = 'Kontinuum manages remote memory and secures remote task reports. mtg lets users purchase and manage decks and manages user economy transactions.';
  assert.equal(workspaceNarrativeEntityMisattributionReason(graph, good), null);
  // Single-member workspace -> no cross-attribution possible.
  const single: any = { ...graph, codebases: [{ id: 'p-mtg', name: 'mtg' }] };
  assert.equal(workspaceNarrativeEntityMisattributionReason(single, bad), null);
});

test('DEFECT-WAS2: marketing saturation strips-and-accepts a grounded 2-repo narrative, still rejects pure fluff', () => {
  const graph: any = {
    name: 'Clients',
    codebases: [
      { id: 'c-backend', name: 'backend' },
      { id: 'c-infra', name: 'infrastructure' },
    ],
    workspace_capabilities: [],
    workspace_domains: [
      { name: 'Billing Location', project_ids: ['c-backend'] },
      { name: 'Cloud Access Control', project_ids: ['c-infra'] },
      { name: 'Database Infrastructure', project_ids: ['c-infra'] },
      { name: 'Cloud Monitoring', project_ids: ['c-infra'] },
    ],
    workspace_entities: [],
  };
  // Grounded 2-repo narrative sprinkled with the 3 live-degrade adjectives
  // (comprehensive / various / robust) -> was hard-rejected at >=3, now strips
  // and re-checks grounding: the stripped text still names real domains + verbs.
  const grounded = 'This workspace groups two client projects. The backend manages billing location and synchronizes inventory with NetSuite. The infrastructure project provisions cloud access control, database infrastructure, and exposes a comprehensive cloud monitoring surface across various environments with robust network access control.';
  const pvs = 'Manages NetSuite billing synchronization and provisions the cloud access, monitoring and database infrastructure that runs it.';
  assert.equal(evaluateWorkspaceNarrativeGate(graph, grounded, pvs).accepted, true);
  // Pure marketing fluff strips to nothing grounded -> still rejected.
  const fluff = 'This is a comprehensive and robust workspace that provides various powerful solutions. It is a best-in-class, seamless, scalable platform designed to deliver an ideal experience for all stakeholders alike.';
  assert.equal(evaluateWorkspaceNarrativeGate(graph, fluff, 'A comprehensive solution.').accepted, false);
});

test('DEFECT3: framework rollup drops fixture-sourced frameworks, keeps product + manifest-only', () => {
  const casOut: any = {
    system: { technologies: { frameworks: [{ name: 'Django' }, { name: 'Jest' }, { name: 'NestJS' }, { name: 'Terraform' }] } },
    nodes: [
      { metadata: { framework: 'nestjs' }, source: { file: 'src/app.controller.ts' } }, // product
      { metadata: { framework: 'django' }, source: { file: 'tests/fixtures/py/manage.py' } }, // fixture only
      { metadata: { framework: 'jest', is_test: true }, source: { file: 'src/app.spec.ts' } }, // test only
      // Terraform: no node-level framework evidence (manifest-only) -> kept.
    ],
  };
  const frameworks = productFrameworksFromCas(casOut);
  assert.deepEqual(frameworks, ['NestJS', 'Terraform']);
});

test('DEFECT3: TypeScript/JavaScript survive prose tokenization', () => {
  const out = normalizeWorkspaceAiDescriptionText('It uses TypeScript/JavaScript, and PostgreSQL and GraphQL.');
  assert.ok(/TypeScript/.test(out) && !/Type Script/.test(out), out);
  assert.ok(/JavaScript/.test(out) && !/Java Script/.test(out), out);
  assert.ok(/PostgreSQL/.test(out) && /GraphQL/.test(out), out);
});

test('DEFECT4: verb-phrase domain labels rejected (Surfaces/Analyzes), noun domains kept', () => {
  assert.equal(isVerbPhraseDomainLabel('Surfaces Codebase Analysis Results'), true);
  assert.equal(isVerbPhraseDomainLabel('Analyzes Codebase Patterns'), true);
  assert.equal(isVerbPhraseDomainLabel('Surfaces Remote Memory'), true);
  assert.equal(isVerbPhraseDomainLabel('Network Access Control'), false);
  assert.equal(isVerbPhraseDomainLabel('Payments'), false);
  // Real hosted leaks (v1.0.67): these evaded the prior list.
  assert.equal(isVerbPhraseDomainLabel('Describes Images'), true);      // OpenClaw (-es fallback + list)
  assert.equal(isVerbPhraseDomainLabel('Polls Users'), true);          // OpenClaw
  assert.equal(isVerbPhraseDomainLabel('Secures Remote Task Reports'), true); // Personal
  assert.equal(isVerbPhraseDomainLabel('Alter Netsuitesynctrack'), true);     // Clients (base-form verb)
  // Real noun domains from the same 4 hosted lists MUST be kept.
  for (const keep of [
    'Game Server', 'Web Memory Intelligence', 'Deck Card Purchase', 'React Route Surface',
    'Billing Location', 'Customer Invoice Preferences Netsuite', 'Mutation Surface',
    'Cloud Access Control', 'Container Registry Infrastructure', 'Cloud Monitoring',
    'Cloudfront Distribution Infrastructure', 'Database Infrastructure', 'Route53 Record Infrastructure',
  ]) {
    assert.equal(isVerbPhraseDomainLabel(keep), false, `should keep noun domain: ${keep}`);
  }
});

test('DEFECT4: bare entity/class-name domains rejected; core-concept domains kept', () => {
  const entityNames = new Set(['spawnbase', 'nodeinvoke', 'groksearch', 'employee', 'term', 'agent', 'membership']);
  // camelCase class identifiers whose only capability evidence is a self-echo.
  assert.equal(isUncorroboratedEntityNameDomain('SpawnBase', { evidence: ['entity:SpawnBase', 'capability:Manages Spawn bases'] }, entityNames), true);
  assert.equal(isUncorroboratedEntityNameDomain('GrokSearch', { evidence: ['entity:GrokSearch', 'capability:Manages Grok searches'] }, entityNames), true);
  // plural entity name vs singular entity in the set (Employees -> Employee).
  assert.equal(isUncorroboratedEntityNameDomain('Employees', { evidence: ['domain_concept:concept_employees', 'entity:Employee'] }, entityNames), true);
  assert.equal(isUncorroboratedEntityNameDomain('Terms', { evidence: ['domain_concept:concept_terms', 'entity:Term'] }, entityNames), true);
  // A real domain answer or core concept corroborates -> kept.
  assert.equal(isUncorroboratedEntityNameDomain('Agents', { evidence: ['core_concept:agent', 'domain_concept:concept_agents'] }, entityNames), false);
  assert.equal(isUncorroboratedEntityNameDomain('Orders', { evidence: ['primary_domain:orders', 'entity:Order'] }, new Set(['order'])), false);
});

// DEFECT-#45: runtime_links was permanently empty on every workspace because
// it only fired when a MATCHED interface pair had topology_surface on BOTH
// sides — but a real provider (a code-level route/handler) essentially never
// carries topology_surface; only infra-declared exits do. The fixture below
// mirrors the real shape: a compose-declared depends_on edge between two
// sibling compose services, plus a genuine code-level http-api provider (no
// topology_surface metadata, unlike the unrealistic all-topology fixtures
// elsewhere in this file) that a sibling's own exit reaches by host:port.
test('DEFECT-#45: resolves runtime_links from compose depends_on edges and interface host:port evidence, without fabricating unmatched interfaces', () => {
  const system = cas({
    system: { id: 'compose-system', name: 'compose-system', type: 'application', root_path: '/tmp/compose-system' },
    nodes: [
      {
        id: 'compose_service_gateway',
        name: 'Compose service: gateway',
        type: 'compose_service',
        metadata: {
          topology_surface: 'docker-compose',
          deployment_service_name: 'gateway',
          service_aliases: ['gateway'],
          ports: ['8080'],
        },
      } as any,
      {
        id: 'compose_service_widgets',
        name: 'Compose service: widgets',
        type: 'compose_service',
        metadata: {
          topology_surface: 'docker-compose',
          deployment_service_name: 'widgets',
          service_aliases: ['widgets'],
          ports: ['4000'],
        },
      } as any,
      {
        id: 'compose_service_orphan',
        name: 'Compose service: orphan',
        type: 'compose_service',
        metadata: {
          topology_surface: 'docker-compose',
          deployment_service_name: 'orphan',
          service_aliases: ['orphan'],
          ports: ['9999'],
        },
      } as any,
      // Real code-level route handler for the widgets service — NOT infra
      // metadata, so (correctly) no topology_surface here.
      { id: 'widgets-route-fn', name: 'listWidgets', type: 'function', source: { file: 'apps/widgets/src/routes.ts', line: 8 } } as any,
      // A code-level outbound call site inside gateway that reaches widgets
      // by concrete host:port (e.g. a fetch/reqwest call), also with no
      // topology_surface — this is what a real cross-service call looks like.
      { id: 'gateway-client-fn', name: 'callWidgets', type: 'function', source: { file: 'apps/gateway/src/client.ts', line: 3 } } as any,
    ],
    // Real Tier-1 ship evidence (a Dockerfile per service) so gateway/widgets
    // resolve as actual deployables — matching the real repo shape, where
    // every compose-declared, independently-built service ships its own
    // artifact — rather than exercising an unrelated deployable-resolution
    // path this fixture isn't testing.
    deployable_evidence: [
      { root_path: 'apps/gateway', name: 'gateway', tier: 1, kind: 'container', evidence: ['docker/gateway.dockerfile'] },
      { root_path: 'apps/widgets', name: 'widgets', tier: 1, kind: 'container', evidence: ['docker/widgets.dockerfile'] },
    ] as any,
    edges: [
      // The container-topology analyzer's own depends_on edge between two
      // sibling compose-service nodes — the highest-confidence generic
      // evidence of a runtime relationship.
      {
        id: 'edge_compose_dep_gateway_widgets',
        source: 'compose_service_gateway',
        target: 'compose_service_widgets',
        type: 'DEPENDS_ON',
        metadata: { topology_surface: 'docker-compose', dependency_kind: 'compose-service' },
      } as any,
    ],
    entry_points: [{
      id: 'entry:widgets-list',
      source_node: 'widgets-route-fn',
      type: 'http',
      name: 'GET /widgets',
      trigger: { method: 'GET', path: '/widgets' },
    }] as any,
    exit_points: [
      // gateway's code calls widgets directly by host:port (no depends_on
      // edge covers this one — exercises the interface-alias/port path).
      {
        id: 'exit:gateway-widgets',
        source_node: 'gateway-client-fn',
        type: 'api',
        name: 'call widgets',
        target: { endpoint: 'http://widgets:4000/widgets', service_id: 'widgets' },
        operation: { method: 'GET' },
      },
      // gateway references a host with no sibling evidence anywhere —
      // must stay unmatched and counted, never fabricated into a link.
      {
        id: 'exit:gateway-unknown',
        source_node: 'gateway-client-fn',
        type: 'api',
        name: 'call unknown-service',
        target: { endpoint: 'http://unknown-service:1234/ping', service_id: 'unknown-service' },
        operation: { method: 'GET' },
      },
    ] as any,
  });

  const graph = buildCrossCodebaseSystemGraph('compose-workspace', [
    { path: '/tmp/compose-system', name: 'compose-system', cas: system },
  ], { generatedAt: '2026-01-01T00:00:00.000Z' });

  const componentById = new Map(graph.runtime_topology.components.map(component => [component.id, component]));
  const gatewayComponent = graph.runtime_topology.components.find(component => component.service_aliases.includes('gateway'));
  const widgetsComponent = graph.runtime_topology.components.find(component => component.service_aliases.includes('widgets'));
  const orphanComponent = graph.runtime_topology.components.find(component => component.service_aliases.includes('orphan'));
  assert.ok(gatewayComponent, 'gateway compose service should surface as a runtime component');
  assert.ok(widgetsComponent, 'widgets compose service should surface as a runtime component');

  // 1) compose depends_on edge resolves into a runtime_link, not just an
  //    unresolved interface.
  const dependsOnLink = graph.runtime_links.find(link =>
    link.source_component_id === gatewayComponent!.id && link.target_component_id === widgetsComponent!.id);
  assert.ok(dependsOnLink, 'runtime_links must not be permanently empty — a compose depends_on edge is direct evidence');
  assert.ok(dependsOnLink!.evidence.some(line => /compose-dependency/.test(line)), 'evidence must cite the compose dependency, not be fabricated');

  // 2) a code-level exit naming a sibling by host:port also resolves, even
  //    though no depends_on edge covers this specific pair.
  const hostPortLink = graph.runtime_links.find(link => {
    const source = componentById.get(link.source_component_id);
    const target = componentById.get(link.target_component_id);
    return source?.service_aliases.includes('gateway') && target?.service_aliases.includes('widgets');
  });
  assert.ok(hostPortLink, 'a host:port-addressed cross-service call must resolve into a runtime_link');

  // 3) the corresponding application-level link is also promoted (the WAS
  //    consumer surface most agents actually read).
  const appNames = new Map(graph.applications.map(app => [app.id, app.name]));
  assert.ok(graph.application_links.some(link =>
    appNames.get(link.source_application_id) === 'gateway' && appNames.get(link.target_application_id) === 'widgets'));

  // 4) never fabricated: the orphan compose service and the truly unknown
  //    host have no evidence connecting them to gateway, so no link exists
  //    for either, and the unknown-host interface stays counted as unmatched.
  assert.ok(!graph.runtime_links.some(link =>
    link.source_component_id === orphanComponent?.id || link.target_component_id === orphanComponent?.id));
  assert.ok(graph.unmatched_interfaces.some(item => /unknown-service/i.test(item.name)));
});

// DEFECT-#45b: buildApplications() minted a SystemApplication for every
// crates/<name> (or bin/<name>) directory purely from a path-shape match,
// with no check that the directory ever surfaced any application evidence
// (an interface, a runtime component). That produced dozens of zero-evidence
// "applications" — pure noise in the level-one list. A package/codebase-kind
// entry now requires at least one interface or runtime component (or an
// explicit deployable determination) to be admitted; entries with real
// evidence, or already flagged deployable, are unaffected.
test('DEFECT-#45b: package/codebase directories without application evidence are not admitted as applications', () => {
  const system = cas({
    system: { id: 'crates-system', name: 'crates-system', type: 'application', root_path: '/tmp/crates-system' },
    nodes: [
      // A pure library crate: a path-shape match only, no route/entry point,
      // no runtime component — must NOT become a level-one application.
      { id: 'lib-node', name: 'helpers', type: 'function', source: { file: 'crates/text-helpers/src/lib.rs', line: 1 } } as any,
      // A crate that DOES surface a real entry point — must still be kept.
      { id: 'worker-node', name: 'runJob', type: 'function', source: { file: 'crates/job-runner/src/main.rs', line: 1 } } as any,
    ],
    entry_points: [{
      id: 'entry:job-runner',
      source_node: 'worker-node',
      type: 'http',
      name: 'GET /run',
      trigger: { method: 'GET', path: '/run' },
    }] as any,
  });

  const graph = buildCrossCodebaseSystemGraph('crates-workspace', [
    { path: '/tmp/crates-system', name: 'crates-system', cas: system },
  ], { generatedAt: '2026-01-01T00:00:00.000Z' });

  const appNames = new Set(graph.applications.map(app => app.name));
  assert.ok(!appNames.has('text-helpers'), 'a zero-evidence crate directory must not mint an application');
  assert.ok(appNames.has('job-runner'), 'a crate with a real entry point must still be admitted');
});

// LIVE-SHAPE REGRESSION: a real multi-service compose workspace (agent /
// coordinator style) reported runtime_links=24 on one build and 0 on the
// very next, with the member CAS's own DEPENDS_ON edges verified intact.
//
// ROOT CAUSE (confirmed by this fixture, NOT the compose<->container
// identity join — that hypothesis was tested and disproven; see below):
// eb74c5b6 correctly stopped a consumer HTTP interface whose caller path has
// no recognized apps/packages/crates/bin/services/*.Dockerfile shape from
// being misnamed after its call TARGET's host (extractInterfaces' consumer-
// http application_id, cross-codebase-analysis.ts ~9213, now passes '' —
// not `endpoint` — into inferApplicationName). But inferApplicationName's
// own fallback chain for that exact shapeless case (cross-codebase-
// analysis.ts ~12539) runs out to the bare repository/system name when
// applicationNameFromFile finds no shape AND the node carries no
// service_aliases — a very common real shape being a bare top-level
// per-service directory with no wrapping prefix (`agent/src/client.ts`,
// not `apps/agent/src/client.ts`). That bare-repo-name pseudo-application
// is never a real SystemRuntimeComponent's application_id (every runtime
// component's identity is its OWN compose-service/container alias, e.g.
// "agent", never the whole codebase's name), so buildTopologyRuntimeLinks'
// `componentByApplication.get(...)` lookup (cross-codebase-analysis.ts
// ~9697) returns nothing and the link is silently dropped.
//
// Before the fix, the same shapeless consumer accidentally resolved to its
// call TARGET's own alias instead — a real misattribution bug, but one that
// (for any consumer/target pair that wasn't itself a same-name self-call)
// still pointed at a REAL sibling runtime component, so the lookup
// succeeded and produced a wrongly-attributed-but-real link, which is what
// inflated the pre-fix count. Once the misattribution was removed, this
// class of caller stopped resolving to any component at all.
//
// This fixture also carries an unmerged compose-service + container
// deployable_evidence row PER service (the compose<->container identity
// join from 8c38d383, which DEFECT-#45's fixture never exercised) to prove
// that hypothesis is NOT the cause — the join fires here and the links
// still resolve once the fallback below is in place.
//
// THE FIX: buildTopologyRuntimeLinks now falls back, when the
// application_id-keyed lookup misses, to resolving the source component via
// the interface's own caller-file leading path segment matched against a
// REAL declared service alias in the same codebase (callerAliasesFromRefs) —
// evidence-gated on the caller's own location, never the call's target.
test('LIVE-SHAPE: runtime_links survive a bare top-level-directory consumer (no apps/ prefix) plus the compose<->container identity join', () => {
  const system = cas({
    system: { id: 'fleet-system', name: 'fleet-system', type: 'application', root_path: '/tmp/fleet-system' },
    nodes: [
      {
        id: 'compose_service_agent',
        name: 'Compose service: agent',
        type: 'compose_service',
        metadata: {
          topology_surface: 'docker-compose',
          deployment_service_name: 'agent',
          service_aliases: ['agent'],
          ports: ['7000'],
        },
      } as any,
      {
        id: 'compose_service_coordinator',
        name: 'Compose service: coordinator',
        type: 'compose_service',
        metadata: {
          topology_surface: 'docker-compose',
          deployment_service_name: 'coordinator',
          service_aliases: ['coordinator'],
          ports: ['9000'],
        },
      } as any,
      // Real code-level provider route for coordinator — no topology_surface,
      // matching the real shape (code-level providers never carry it).
      { id: 'coordinator-route-fn', name: 'registerAgent', type: 'function', source: { file: 'apps/coordinator/src/routes.ts', line: 12 } } as any,
      // agent's own outbound call site, living directly under a BARE
      // top-level per-service directory (agent/src/client.ts) — a common
      // docker-compose monorepo convention with no wrapping apps/packages/
      // crates/bin/services/ prefix, so applicationNameFromFile's
      // directory-shape patterns don't recognize it at all. This is exactly
      // the shape eb74c5b6 exposed: previously such a shapeless consumer's
      // application_id fell back to naming itself after the endpoint host
      // (e.g. "coordinator") instead of "agent" — eb74c5b6 correctly fixed
      // that misattribution, but left this shapeless case with nothing to
      // fall back to except the bare repository name.
      { id: 'agent-client-fn', name: 'callCoordinator', type: 'function', source: { file: 'agent/src/client.ts', line: 5 } } as any,
      // A THIRD sibling, reachable only via host:port evidence (no
      // depends_on edge covers it) — proves the topology host:port path
      // resolves independently of the compose-dependency-edge path, rather
      // than the two coincidentally landing on the same pair and deduping
      // into one link (which would mask either path silently breaking).
      {
        id: 'compose_service_cache',
        name: 'Compose service: cache',
        type: 'compose_service',
        metadata: {
          topology_surface: 'docker-compose',
          deployment_service_name: 'cache',
          service_aliases: ['cache'],
          ports: ['6380'],
        },
      } as any,
    ],
    // LIVE SHAPE: both an unmerged compose-service row AND a container row
    // per service, as a real repo's deployable-evidence provider set emits
    // before joinComposeAndContainerUnits runs — DEFECT-#45's fixture never
    // included the compose-service-kind row, so it never exercised the join.
    deployable_evidence: [
      { root_path: 'apps/agent', name: 'agent', tier: 1, kind: 'compose-service', evidence: ['docker-compose.yml: agent'] },
      { root_path: 'apps/agent', name: 'agent', tier: 1, kind: 'container', evidence: ['apps/agent/Dockerfile'], entrypoint_member: 'agent' },
      { root_path: 'apps/coordinator', name: 'coordinator', tier: 1, kind: 'compose-service', evidence: ['docker-compose.yml: coordinator'] },
      { root_path: 'apps/coordinator', name: 'coordinator', tier: 1, kind: 'container', evidence: ['apps/coordinator/Dockerfile'], entrypoint_member: 'coordinator' },
    ] as any,
    edges: [
      {
        id: 'edge_compose_dep_agent_coordinator',
        source: 'compose_service_agent',
        target: 'compose_service_coordinator',
        type: 'DEPENDS_ON',
        metadata: { topology_surface: 'docker-compose', dependency_kind: 'compose-service' },
      } as any,
    ],
    entry_points: [{
      id: 'entry:coordinator-register',
      source_node: 'coordinator-route-fn',
      type: 'http',
      name: 'POST /agents/register',
      trigger: { method: 'POST', path: '/agents/register' },
    }] as any,
    exit_points: [
      {
        id: 'exit:agent-coordinator',
        source_node: 'agent-client-fn',
        type: 'api',
        name: 'register with coordinator',
        target: { endpoint: 'http://coordinator:9000/agents/register', service_id: 'coordinator' },
        operation: { method: 'POST' },
      },
      // Reaches the cache sibling by host:port only — no depends_on edge for
      // this pair, exercising the topology/host-port resolution path
      // distinctly from the compose-dependency-edge path above.
      {
        id: 'exit:agent-cache',
        source_node: 'agent-client-fn',
        type: 'api',
        name: 'call cache',
        target: { endpoint: 'http://cache:6380/get', service_id: 'cache' },
        operation: { method: 'GET' },
      },
    ] as any,
  });

  const graph = buildCrossCodebaseSystemGraph('fleet-workspace', [
    { path: '/tmp/fleet-system', name: 'fleet-system', cas: system },
  ], { generatedAt: '2026-01-01T00:00:00.000Z' });

  const componentById = new Map(graph.runtime_topology.components.map(component => [component.id, component]));
  const agentComponent = graph.runtime_topology.components.find(component => component.service_aliases.includes('agent'));
  const coordinatorComponent = graph.runtime_topology.components.find(component => component.service_aliases.includes('coordinator'));
  const cacheComponent = graph.runtime_topology.components.find(component => component.service_aliases.includes('cache'));
  assert.ok(agentComponent, 'agent compose service should still surface as a runtime component after the identity join');
  assert.ok(coordinatorComponent, 'coordinator compose service should still surface as a runtime component after the identity join');
  assert.ok(cacheComponent, 'cache compose service should still surface as a runtime component after the identity join');

  // The compose depends_on edge must still resolve into a runtime_link post-join.
  const dependsOnLink = graph.runtime_links.find(link =>
    link.source_component_id === agentComponent!.id && link.target_component_id === coordinatorComponent!.id);
  assert.ok(dependsOnLink, 'runtime_links must survive the compose<->container identity join — a compose depends_on edge is direct evidence regardless of deployable-evidence row merging');
  assert.ok(dependsOnLink!.evidence.some(line => /compose-dependency/.test(line)));

  // The host:port-addressed call (agent -> cache, no depends_on edge for this
  // pair) must also resolve independently, with the CONSUMER resolving to
  // its own (agent) application identity, not the target's.
  const agentApp = graph.applications.find(app => app.name === 'agent');
  assert.ok(agentApp, 'agent must resolve to its own application identity (eb74c5b6), not be swallowed by the coordinator/cache target name');
  const hostPortLink = graph.runtime_links.find(link =>
    link.source_component_id === agentComponent!.id && link.target_component_id === cacheComponent!.id);
  assert.ok(hostPortLink, 'a host:port-addressed cross-service call must resolve into a runtime_link post-join, on a pair distinct from the compose-dependency edge');

  // Never regress below the pre-join link count for this shape: exactly the
  // permanent floor DEFECT-#45 established, now proven to survive the
  // compose<->container identity join plus the consumer-naming and
  // audience-compat fixes landing together.
  assert.ok(graph.runtime_links.length >= 2, `expected at least 2 runtime_links (compose-dependency + host:port on distinct pairs), got ${graph.runtime_links.length}`);
});
