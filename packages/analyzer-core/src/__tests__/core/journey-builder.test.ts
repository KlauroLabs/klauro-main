import { buildUserJourneys } from '../../analyzer/core/journey-builder';
import {
  CASNode,
  CASEdge,
  CASEntryPoint,
  CASExitPoint,
  CASCallChain,
  CASDataEntity,
  CASChangeRisk
} from '../../types/cas.types';

function node(id: string, name: string, type: string): CASNode {
  return { id, name, type } as CASNode;
}

function edge(id: string, source: string, target: string, type: string): CASEdge {
  return { id, source, target, type };
}

function chain(id: string, entryNodeId: string, entryPointId: string, path: Array<[string, number]>, exitPointId?: string, exitNodeId?: string): CASCallChain {
  return {
    id,
    chain_type: 'entry-to-exit',
    entry_point: { node_id: entryNodeId, method_name: 'create', entry_point_id: entryPointId },
    exit_point: exitPointId ? { node_id: exitNodeId, method_name: 'save', exit_point_id: exitPointId } : undefined,
    call_path: path.map(([nodeId, depth], index) => ({
      call_id: `${id}_call_${index}`,
      node_id: nodeId,
      method_name: nodeId,
      depth,
    })),
    characteristics: {
      total_calls: path.length,
      max_depth: Math.max(...path.map(([, depth]) => depth), 0),
      has_external_calls: false,
      has_database_calls: true,
      has_async_calls: false,
      is_circular: false,
      is_recursive: false,
      complexity_score: 1,
    },
    risk_analysis: { risk_level: 'low', risk_factors: [] },
  } as CASCallChain;
}

describe('buildUserJourneys', () => {
  const nodes: CASNode[] = [
    node('n_controller', 'WorkOrdersController', 'controller'),
    node('n_service', 'WorkOrderService', 'service'),
    node('n_repo', 'WorkOrderRepository', 'repository'),
    node('n_guard', 'authenticate_user', 'guard'),
    node('n_suite', 'WorkOrderService spec', 'test_suite'),
  ];

  const edges: CASEdge[] = [
    edge('e1', 'n_controller', 'n_service', 'calls'),
    edge('e2', 'n_service', 'n_repo', 'calls'),
    edge('e3', 'n_controller', 'n_guard', 'guarded_by'),
    edge('e4', 'n_suite', 'n_service', 'tests'),
  ];

  const entryPoint: CASEntryPoint = {
    id: 'entry_create_work_order',
    source_node: 'n_controller',
    type: 'http',
    name: 'POST /work_orders',
    trigger: { method: 'POST', path: '/work_orders' },
    handler: { node_id: 'n_controller', method_name: 'create' },
    security: { authenticated: true, guards: [] },
  } as CASEntryPoint;

  const exitPoint: CASExitPoint = {
    id: 'exit_work_order_db',
    source_node: 'n_repo',
    type: 'database',
    name: 'work_orders insert',
    operation: { action: 'insert' },
  } as CASExitPoint;

  const workOrderEntity: CASDataEntity = {
    id: 'entity_work_order',
    name: 'WorkOrder',
    lifecycle: {
      created_by: ['n_repo'],
      read_by: [],
      updated_by: [],
      deleted_by: [],
    },
  } as CASDataEntity;

  const changeRisk: CASChangeRisk = {
    node_id: 'n_service',
    risk_level: 'high',
    risk_factors: [],
    downstream_impact: {
      direct_callers: [],
      transitive_callers: [],
      affected_call_chains: [],
      affected_entry_points: [],
    },
    test_protection: { has_direct_tests: true, has_integration_tests: false },
    stability_context: { recent_churn: false, commit_count_30d: 0, bug_fix_density: 0 },
  };

  const baseInput = {
    nodes,
    edges,
    entryPoints: [entryPoint],
    exitPoints: [exitPoint],
    callChains: [
      chain(
        'chain_1',
        'n_controller',
        'entry_create_work_order',
        [['n_controller', 0], ['n_service', 1], ['n_repo', 2]],
        'exit_work_order_db',
        'n_repo'
      ),
    ],
    dataEntities: [workOrderEntity],
    changeRisks: [changeRisk],
  };

  it('composes an end-to-end journey from entry through service to terminal entity', () => {
    const { journeys, summary } = buildUserJourneys(baseInput);

    expect(journeys).toHaveLength(1);
    expect(summary.total_discovered).toBe(1);
    expect(summary.included).toBe(1);

    const journey = journeys[0];
    expect(journey.entry_point_id).toBe('entry_create_work_order');
    expect(journey.journey_kind).toBe('user-facing');
    expect(journey.call_chain_ids).toEqual(['chain_1']);
    expect(journey.exit_point_ids).toContain('exit_work_order_db');

    const stepIds = journey.steps.map(step => step.node_id);
    expect(stepIds).toEqual(['n_controller', 'n_service', 'n_repo']);
    expect(journey.steps[0].layer).toBe('entry');
    expect(journey.steps[1].layer).toBe('business');
    expect(journey.steps[2].layer).toBe('data');
  });

  it('names the journey from the entry action and the terminal entity', () => {
    const { journeys } = buildUserJourneys(baseInput);
    expect(journeys[0].name).toBe('Create work order -> WorkOrder created');
    expect(journeys[0].terminal_entities).toEqual([
      { entity_id: 'entity_work_order', name: 'WorkOrder', access: 'created', node_id: 'n_repo', terminal_kind: 'entity' },
    ]);
    expect(journeys[0].terminal_effects.entities_written).toEqual(['WorkOrder']);
  });

  it('captures security boundaries crossed on the path', () => {
    const { journeys } = buildUserJourneys(baseInput);
    const boundaryNames = journeys[0].security_boundaries.map(boundary => boundary.name);
    expect(boundaryNames).toContain('authenticate_user');
    const guardBoundary = journeys[0].security_boundaries.find(boundary => boundary.node_id === 'n_guard');
    expect(guardBoundary?.mechanism).toBe('guarded_by');
  });

  it('links covering tests via tests edges on path nodes', () => {
    const { journeys } = buildUserJourneys(baseInput);
    expect(journeys[0].tests_covering).toEqual(['n_suite']);
  });

  it('surfaces the maximum change risk found on the path', () => {
    const { journeys } = buildUserJourneys(baseInput);
    expect(journeys[0].risk).toBe('high');
  });

  it('classifies scheduled entry points as scheduled journeys', () => {
    const scheduledEntry: CASEntryPoint = {
      id: 'entry_nightly_cleanup',
      source_node: 'n_service',
      type: 'schedule',
      name: 'nightly_cleanup',
      trigger: { schedule: '0 0 * * *' },
      handler: { node_id: 'n_service', method_name: 'cleanup' },
    } as CASEntryPoint;

    const { journeys } = buildUserJourneys({
      ...baseInput,
      entryPoints: [scheduledEntry],
      callChains: [
        chain('chain_2', 'n_service', 'entry_nightly_cleanup', [['n_service', 0], ['n_repo', 1]]),
      ],
    });

    expect(journeys).toHaveLength(1);
    expect(journeys[0].journey_kind).toBe('scheduled');
  });

  it('classifies a CLI entry rooted in a shell script as system (operational), not user-facing', () => {
    // Live leak: release.sh / install.sh / *-smoke.sh surfaced as user-facing/high
    // journeys. A `.sh` deploy/install/release/smoke script is an operator surface,
    // not a product CLI — evidence = entry TYPE (cli) + a script-file root.
    const scriptEntry: CASEntryPoint = {
      id: 'entry_release_script',
      source_node: 'n_service',
      type: 'cli',
      name: 'Shell script: release.sh',
      handler: { node_id: 'n_service', method_name: 'main', file: 'apps/mcp-server/scripts/release.sh' },
    } as CASEntryPoint;

    const { journeys } = buildUserJourneys({
      ...baseInput,
      entryPoints: [scriptEntry],
      callChains: [
        chain('chain_release', 'n_service', 'entry_release_script', [['n_service', 0], ['n_repo', 1]]),
      ],
    });

    expect(journeys).toHaveLength(1);
    expect(journeys[0].journey_kind).toBe('system');
  });

  it('keeps a genuine product CLI (bin entry rooted in a source file) user-facing', () => {
    const cliEntry: CASEntryPoint = {
      id: 'entry_klauro_cli',
      source_node: 'n_controller',
      type: 'cli',
      name: 'klauro',
      handler: { node_id: 'n_controller', method_name: 'main', file: 'apps/mcp-server/src/cli.ts' },
    } as CASEntryPoint;

    const { journeys } = buildUserJourneys({
      ...baseInput,
      entryPoints: [cliEntry],
      callChains: [
        chain('chain_cli', 'n_controller', 'entry_klauro_cli', [['n_controller', 0], ['n_service', 1], ['n_repo', 2]], 'exit_work_order_db', 'n_repo'),
      ],
    });

    expect(journeys).toHaveLength(1);
    expect(journeys[0].journey_kind).toBe('user-facing');
  });

  it('falls back to call edges when no call chains exist for an entry point', () => {
    const { journeys } = buildUserJourneys({ ...baseInput, callChains: [] });
    expect(journeys).toHaveLength(1);
    const stepIds = journeys[0].steps.map(step => step.node_id);
    expect(stepIds).toContain('n_service');
    expect(stepIds).toContain('n_repo');
    expect(journeys[0].terminal_entities[0]?.name).toBe('WorkOrder');
  });

  it('caps included journeys while reporting the total discovered', () => {
    const manyEntryPoints: CASEntryPoint[] = [];
    const manyChains: CASCallChain[] = [];
    for (let i = 0; i < 5; i++) {
      manyEntryPoints.push({
        id: `entry_${i}`,
        source_node: 'n_controller',
        type: 'http',
        name: `GET /things_${i}`,
        trigger: { method: 'GET', path: `/things_${i}` },
        handler: { node_id: 'n_controller', method_name: `index_${i}` },
      } as CASEntryPoint);
      manyChains.push(
        chain(`chain_${i}`, 'n_controller', `entry_${i}`, [['n_controller', 0], ['n_service', 1], ['n_repo', 2]])
      );
    }

    const { journeys, summary } = buildUserJourneys(
      { ...baseInput, entryPoints: manyEntryPoints, callChains: manyChains },
      { maxJourneys: 3 }
    );

    expect(summary.total_discovered).toBe(5);
    expect(summary.included).toBe(3);
    expect(journeys).toHaveLength(3);
  });

  it('is deterministic across repeated runs', () => {
    const first = buildUserJourneys(baseInput);
    const second = buildUserJourneys(baseInput);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('resolves terminal entities through structural edges when lifecycle data is empty', () => {
    const input = {
      nodes: [
        node('n_route', 'POST /work_orders', 'rails_route'),
        node('n_ctrl', 'WorkOrdersController', 'rails_controller'),
        node('n_handler', 'create', 'method'),
        node('n_model', 'WorkOrder', 'rails_model'),
        node('n_related', 'Customer', 'rails_model'),
      ],
      edges: [
        edge('e_route', 'n_route', 'n_ctrl', 'routes_to'),
        edge('e_call', 'n_route', 'n_handler', 'calls'),
        edge('e_uses', 'n_ctrl', 'n_model', 'uses'),
        edge('e_rel', 'n_model', 'n_related', 'relates_to'),
      ],
      entryPoints: [{
        id: 'entry_create',
        source_node: 'n_route',
        type: 'http',
        name: 'POST /work_orders',
        trigger: { method: 'POST', path: '/work_orders' },
        handler: { node_id: 'n_handler', method_name: 'create' },
      } as CASEntryPoint],
      exitPoints: [],
      callChains: [],
      dataEntities: [
        { id: 'entity_work_order', name: 'WorkOrder', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } } as CASDataEntity,
        { id: 'entity_customer', name: 'Customer', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } } as CASDataEntity,
      ],
    };

    const { journeys } = buildUserJourneys(input);
    expect(journeys).toHaveLength(1);
    const terminalNames = journeys[0].terminal_entities.map(t => t.name);
    expect(terminalNames[0]).toBe('WorkOrder');
    expect(terminalNames).toContain('Customer');
    const primary = journeys[0].terminal_entities[0];
    expect(primary.entity_id).toBe('entity_work_order');
    expect(primary.access).toBe('created');
    expect(primary.terminal_kind).toBe('entity');
    expect(journeys[0].name).toBe('Create work order -> WorkOrder created (+1 more)');
  });

  it('resolves terminal entities through a controller, service, repository chain', () => {
    const input = {
      nodes: [
        node('n_ctrl_method', 'createInspection', 'method'),
        node('n_service2', 'InspectionService', 'service'),
        node('n_repo2', 'InspectionRepository', 'repository'),
        node('n_entity2', 'InspectionConfig', 'entity'),
      ],
      edges: [
        edge('e_a', 'n_ctrl_method', 'n_service2', 'depends_on'),
        edge('e_b', 'n_service2', 'n_repo2', 'depends_on'),
        edge('e_c', 'n_repo2', 'n_entity2', 'manages'),
      ],
      entryPoints: [{
        id: 'entry_inspection',
        source_node: 'n_ctrl_method',
        type: 'http',
        name: 'POST /inspections',
        trigger: { method: 'POST', path: '/inspections' },
      } as CASEntryPoint],
      exitPoints: [],
      callChains: [],
      dataEntities: [
        { id: 'entity_inspectionconfig', name: 'InspectionConfig', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } } as CASDataEntity,
      ],
    };

    const { journeys } = buildUserJourneys(input);
    expect(journeys).toHaveLength(1);
    expect(journeys[0].terminal_entities).toEqual([
      { entity_id: 'entity_inspectionconfig', name: 'InspectionConfig', access: 'created', node_id: 'n_entity2', terminal_kind: 'entity' },
    ]);
    expect(journeys[0].name).toBe('Create inspection -> InspectionConfig created');
  });

  it('matches database exit point resources to entities by table name', () => {
    const input = {
      nodes: [
        node('n_handler2', 'show', 'method'),
        node('n_model2', 'WorkOrder', 'rails_model'),
      ],
      edges: [
        edge('e_uses2', 'n_handler2', 'n_model2', 'uses'),
      ],
      entryPoints: [{
        id: 'entry_show',
        source_node: 'n_handler2',
        type: 'http',
        name: 'GET /work_orders/:id',
        trigger: { method: 'GET', path: '/work_orders/:id' },
      } as CASEntryPoint],
      exitPoints: [{
        id: 'exit_db',
        source_node: 'n_model2',
        type: 'database',
        name: 'ActiveRecord: work_orders',
        target: { resource: 'work_orders' },
        operation: { action: 'read_write' },
      } as CASExitPoint],
      callChains: [],
      dataEntities: [
        { id: 'entity_work_order', name: 'WorkOrder', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } } as CASDataEntity,
      ],
    };

    const { journeys } = buildUserJourneys(input);
    expect(journeys).toHaveLength(1);
    expect(journeys[0].terminal_entities[0].name).toBe('WorkOrder');
    expect(journeys[0].terminal_entities[0].entity_id).toBe('entity_work_order');
    expect(journeys[0].terminal_entities[0].access).toBe('read');
    expect(journeys[0].exit_point_ids).toContain('exit_db');
  });

  it('composes journeys from handler classes by expanding contained methods', () => {
    const input = {
      nodes: [
        node('n_msg_handler', 'AsyncReportHandler', 'message_handler'),
        node('n_invoke', '__invoke', 'method'),
        node('n_report_entity', 'Report', 'entity'),
      ],
      edges: [
        edge('e_contains', 'n_msg_handler', 'n_invoke', 'has_method'),
        edge('e_calls', 'n_invoke', 'n_report_entity', 'calls'),
      ],
      entryPoints: [{
        id: 'entry_msg',
        source_node: 'n_msg_handler',
        type: 'message',
        name: 'Message: ReportRequest',
        trigger: { pattern: 'ReportRequest' },
        metadata: { message_class: 'ReportRequest', handler: 'AsyncReportHandler' },
      } as CASEntryPoint],
      exitPoints: [],
      callChains: [],
      dataEntities: [
        { id: 'entity_report', name: 'Report', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } } as CASDataEntity,
      ],
    };

    const { journeys } = buildUserJourneys(input);
    expect(journeys).toHaveLength(1);
    const stepIds = journeys[0].steps.map(step => step.node_id);
    expect(stepIds).toContain('n_invoke');
    expect(journeys[0].terminal_entities[0].name).toBe('Report');
    expect(journeys[0].name).toMatch(/^Handle report request/);
  });

  it('falls back to the deepest non-framework node labeled as a node terminal', () => {
    const input = {
      nodes: [
        node('n_handler3', 'guestToken', 'method'),
        node('n_client', 'SupersetClient', 'service'),
      ],
      edges: [
        edge('e_call3', 'n_handler3', 'n_client', 'calls'),
      ],
      entryPoints: [{
        id: 'entry_token',
        source_node: 'n_handler3',
        type: 'http',
        name: 'GET /superset',
        trigger: { method: 'GET', path: '/superset' },
      } as CASEntryPoint],
      exitPoints: [],
      callChains: [],
      dataEntities: [],
    };

    const { journeys } = buildUserJourneys(input);
    expect(journeys).toHaveLength(1);
    expect(journeys[0].terminal_entities).toEqual([
      { name: 'SupersetClient', access: 'read', node_id: 'n_client', terminal_kind: 'node' },
    ]);
    expect(journeys[0].terminal_effects.entities_written).toEqual([]);
    expect(journeys[0].terminal_effects.entities_read).toEqual([]);
  });

  it('produces unique names when entry actions collide', () => {
    const collidingEntryPoints: CASEntryPoint[] = [
      {
        id: 'entry_put',
        source_node: 'n_controller',
        type: 'http',
        name: 'PUT /work_orders/:id',
        trigger: { method: 'PUT', path: '/work_orders/:id' },
        handler: { node_id: 'n_controller', method_name: 'update' },
      } as CASEntryPoint,
      {
        id: 'entry_patch',
        source_node: 'n_controller',
        type: 'http',
        name: 'PATCH /work_orders/:id',
        trigger: { method: 'PATCH', path: '/work_orders/:id' },
        handler: { node_id: 'n_controller', method_name: 'update' },
      } as CASEntryPoint,
    ];

    const { journeys } = buildUserJourneys({
      ...baseInput,
      entryPoints: collidingEntryPoints,
      callChains: [
        chain('chain_put', 'n_controller', 'entry_put', [['n_controller', 0], ['n_service', 1], ['n_repo', 2]]),
        chain('chain_patch', 'n_controller', 'entry_patch', [['n_controller', 0], ['n_service', 1], ['n_repo', 2]]),
      ],
    });

    expect(journeys).toHaveLength(2);
    const names = journeys.map(journey => journey.name);
    expect(new Set(names).size).toBe(2);
    expect(names.some(name => name.includes('PUT /work_orders/:id'))).toBe(true);
    expect(names.some(name => name.includes('PATCH /work_orders/:id'))).toBe(true);
  });

  it('does not apply the route verb to adjacent entities reached through associations', () => {
    const input = {
      nodes: [
        node('n_route', 'DELETE /addresses/:id', 'route'),
        node('n_ctrl', 'AddressesController', 'controller'),
        node('n_address', 'Address', 'rails_model'),
        node('n_country', 'Country', 'rails_model'),
      ],
      edges: [
        edge('e_route', 'n_route', 'n_ctrl', 'routes_to'),
        edge('e_uses', 'n_ctrl', 'n_address', 'uses'),
        edge('e_rel', 'n_address', 'n_country', 'relates_to'),
      ],
      entryPoints: [{
        id: 'entry_delete_address',
        source_node: 'n_route',
        type: 'http',
        name: 'DELETE /addresses/:id',
        trigger: { method: 'DELETE', path: '/addresses/:id' },
        handler: { node_id: 'n_ctrl', method_name: 'destroy' },
      } as CASEntryPoint],
      exitPoints: [],
      callChains: [],
      dataEntities: [
        { id: 'entity_address', name: 'Address', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } } as CASDataEntity,
        { id: 'entity_country', name: 'Country', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } } as CASDataEntity,
      ],
    };

    const { journeys } = buildUserJourneys(input);
    expect(journeys).toHaveLength(1);
    const byName = new Map(journeys[0].terminal_entities.map(item => [item.name, item]));
    expect(byName.get('Address')?.access).toBe('deleted');
    expect(byName.get('Country')?.access).toBe('read');
    expect(journeys[0].terminal_effects.entities_written).toEqual(['Address']);
    expect(journeys[0].terminal_effects.entities_read).toContain('Country');
    expect(journeys[0].name).toBe('Delete address -> Address deleted (+1 more)');
  });

  it('honors explicit write edges on the path for non-route entities', () => {
    const input = {
      nodes: [
        node('n_route', 'POST /orders/:id/complete', 'route'),
        node('n_ctrl', 'OrdersController', 'controller'),
        node('n_order', 'Order', 'rails_model'),
        node('n_shipment', 'Shipment', 'rails_model'),
      ],
      edges: [
        edge('e_route', 'n_route', 'n_ctrl', 'routes_to'),
        edge('e_uses', 'n_ctrl', 'n_order', 'uses'),
        edge('e_creates', 'n_order', 'n_shipment', 'creates'),
      ],
      entryPoints: [{
        id: 'entry_complete_order',
        source_node: 'n_route',
        type: 'http',
        name: 'POST /orders/:id/complete',
        trigger: { method: 'POST', path: '/orders/:id/complete' },
        handler: { node_id: 'n_ctrl', method_name: 'complete' },
      } as CASEntryPoint],
      exitPoints: [],
      callChains: [],
      dataEntities: [
        { id: 'entity_order', name: 'Order', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } } as CASDataEntity,
        { id: 'entity_shipment', name: 'Shipment', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } } as CASDataEntity,
      ],
    };

    const { journeys } = buildUserJourneys(input);
    expect(journeys).toHaveLength(1);
    const byName = new Map(journeys[0].terminal_entities.map(item => [item.name, item]));
    expect(byName.get('Shipment')?.access).toBe('created');
    expect(journeys[0].terminal_effects.entities_written).toContain('Shipment');
  });

  it('names GET /new and GET /:id/edit routes as forms, not list journeys', () => {
    const formEntryPoints: CASEntryPoint[] = [
      {
        id: 'entry_new',
        source_node: 'n_controller',
        type: 'http',
        name: 'GET /addresses/new',
        trigger: { method: 'GET', path: '/addresses/new' },
        handler: { node_id: 'n_controller', method_name: 'new' },
      } as CASEntryPoint,
      {
        id: 'entry_edit',
        source_node: 'n_controller',
        type: 'http',
        name: 'GET /addresses/:id/edit',
        trigger: { method: 'GET', path: '/addresses/:id/edit' },
        handler: { node_id: 'n_controller', method_name: 'edit' },
      } as CASEntryPoint,
    ];

    const { journeys } = buildUserJourneys({
      ...baseInput,
      entryPoints: formEntryPoints,
      callChains: [
        chain('chain_new', 'n_controller', 'entry_new', [['n_controller', 0], ['n_service', 1]]),
        chain('chain_edit', 'n_controller', 'entry_edit', [['n_controller', 0], ['n_service', 1]]),
      ],
    });

    expect(journeys).toHaveLength(2);
    const names = journeys.map(journey => journey.name);
    expect(names.some(name => name.startsWith('New address form'))).toBe(true);
    expect(names.some(name => name.startsWith('Edit address form'))).toBe(true);
    expect(names.some(name => name.toLowerCase().includes('list news'))).toBe(false);
    expect(names.some(name => name.toLowerCase().includes('list edits'))).toBe(false);
  });
});

describe('buildUserJourneys frontend entry naming', () => {
  const pageEntry = (
    id: string,
    sourceNode: string,
    pageName: string,
    path: string,
    component: string
  ): CASEntryPoint => ({
    id,
    source_node: sourceNode,
    source_analyzer: 'react',
    type: 'page',
    name: `Page ${pageName}`,
    trigger: { path, method: 'GET' },
    metadata: { component, name: pageName },
  } as CASEntryPoint);

  it('names a file-path page entry from its route segments instead of the file path', () => {
    const input = {
      nodes: [
        node('n_page', 'decision-list', 'page'),
        node('n_hook', 'useDecisionHistory', 'hook'),
      ],
      edges: [edge('e1', 'n_page', 'n_hook', 'calls')],
      entryPoints: [pageEntry('entry_decision_list', 'n_page', 'decision-list', '/activity/decision-list.tsx', 'DecisionList')],
      exitPoints: [{
        id: 'exit_api_decisions',
        source_node: 'n_hook',
        type: 'api',
        name: 'GET /api/decision-history',
        target: { service_id: 'external_api', endpoint: '/api/decision-history' },
        operation: { method: 'GET', action: 'fetch' },
      } as CASExitPoint],
      callChains: [],
      dataEntities: [],
    };

    const { journeys } = buildUserJourneys(input);
    expect(journeys).toHaveLength(1);
    expect(journeys[0].name).toBe('View decision list -> DecisionHistory read');
    expect(journeys[0].name).not.toContain('.tsx');
    expect(journeys[0].entry.path_or_trigger).toBe('/activity/decision-list.tsx');
  });

  it('drops structural directories like components and widgets from the subject', () => {
    const input = {
      nodes: [
        node('n_page', 'stop-loss', 'page'),
        node('n_hook', 'useAutomationConfig', 'hook'),
      ],
      edges: [edge('e1', 'n_page', 'n_hook', 'calls')],
      entryPoints: [pageEntry('entry_stop_loss', 'n_page', 'stop-loss', '/connections/dashboard/widgets/stop-loss.tsx', 'StopLoss')],
      exitPoints: [{
        id: 'exit_api_automation_config',
        source_node: 'n_hook',
        type: 'api',
        name: 'GET /api/automation/config',
        target: { service_id: 'external_api', endpoint: '/api/automation/config' },
        operation: { method: 'GET', action: 'fetch' },
      } as CASExitPoint],
      callChains: [],
      dataEntities: [],
    };

    const { journeys } = buildUserJourneys(input);
    expect(journeys[0].name).toBe('View stop loss -> AutomationConfig read');
  });

  it('uses the parent segment when an index page is the entry file', () => {
    const input = {
      nodes: [
        node('n_page', 'index', 'page'),
        node('n_hook', 'useActivityFeed', 'hook'),
      ],
      edges: [edge('e1', 'n_page', 'n_hook', 'calls')],
      entryPoints: [pageEntry('entry_activity_index', 'n_page', 'index', '/activity/index.tsx', 'ActivityPage')],
      exitPoints: [{
        id: 'exit_api_activity_feed',
        source_node: 'n_hook',
        type: 'api',
        name: 'GET /api/activity-feed',
        target: { service_id: 'external_api', endpoint: '/api/activity-feed' },
        operation: { method: 'GET', action: 'fetch' },
      } as CASExitPoint],
      callChains: [],
      dataEntities: [],
    };

    const { journeys } = buildUserJourneys(input);
    expect(journeys[0].name).toBe('View activity -> ActivityFeed read');
  });

  it('contextualizes generic tail segments like settings with the owning resource', () => {
    const input = {
      nodes: [
        node('n_page', 'settings', 'page'),
        node('n_machine', 'Machine', 'entity'),
      ],
      edges: [edge('e1', 'n_page', 'n_machine', 'updates')],
      entryPoints: [pageEntry('entry_machine_settings', 'n_page', 'settings', '/machines/[id]/settings', 'MachineSettings')],
      exitPoints: [],
      callChains: [],
      dataEntities: [
        { id: 'entity_machine', name: 'Machine', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } } as CASDataEntity,
      ],
    };

    const { journeys } = buildUserJourneys(input);
    expect(journeys[0].name).toBe('Update machine settings -> Machine updated');
  });

  it('keeps verb-led route subjects as the action without a stacked verb', () => {
    const input = {
      nodes: [
        node('n_route_node', 'app.tsx', 'file'),
        node('n_app', 'App', 'function'),
      ],
      edges: [edge('e1', 'n_route_node', 'n_app', 'calls')],
      entryPoints: [{
        id: 'entry_update_billing',
        source_node: 'n_route_node',
        source_analyzer: 'react-router',
        type: 'route',
        name: 'GET /update-billing',
        trigger: { path: '/update-billing', method: 'GET' },
        metadata: { framework: 'react-router', component: 'Redirect' },
      } as CASEntryPoint],
      exitPoints: [],
      callChains: [],
      dataEntities: [],
    };

    const { journeys } = buildUserJourneys(input);
    expect(journeys[0].name).toBe('Update billing -> App');
  });

  it('falls back to the component display name for root and wildcard routes', () => {
    const input = {
      nodes: [
        node('n_route_node', 'app.tsx', 'file'),
        node('n_app', 'App', 'function'),
      ],
      edges: [edge('e1', 'n_route_node', 'n_app', 'calls')],
      entryPoints: [{
        id: 'entry_root',
        source_node: 'n_route_node',
        source_analyzer: 'react-router',
        type: 'route',
        name: 'GET /',
        trigger: { path: '/', method: 'GET' },
        metadata: { framework: 'react-router', component: 'LoginPage' },
      } as CASEntryPoint],
      exitPoints: [],
      callChains: [],
      dataEntities: [],
    };

    const { journeys } = buildUserJourneys(input);
    expect(journeys[0].name).toBe('Login -> App');
  });

  it('keeps the Visit fallback when neither path segments nor a component exist', () => {
    const input = {
      nodes: [
        node('n_route_node', 'app-routing.ts', 'file'),
        node('n_cmp', 'AdminComponent', 'component'),
      ],
      edges: [edge('e1', 'n_route_node', 'n_cmp', 'calls')],
      entryPoints: [{
        id: 'entry_wildcard',
        source_node: 'n_route_node',
        source_analyzer: 'angular',
        type: 'route',
        name: 'Route **',
        trigger: { path: '**', method: 'GET' },
        metadata: {},
      } as CASEntryPoint],
      exitPoints: [],
      callChains: [],
      dataEntities: [],
    };

    const { journeys } = buildUserJourneys(input);
    expect(journeys[0].name).toBe('Visit ** -> AdminComponent');
  });
});

describe('buildUserJourneys state machine walking', () => {
  const file = '/repo/core/app/models/spree/order.rb';
  const stateNode = (id: string, name: string, initial = false): CASNode => ({
    id,
    name,
    type: 'state',
    source: { file, line: 10 },
    metadata: { framework: 'ruby', attributes: { state_machine_attribute: 'state', initial } },
  } as CASNode);

  const stateMachineNodes: CASNode[] = [
    { id: 'n_route', name: 'POST /orders', type: 'rails_route', source: { file: '/repo/config/routes.rb', line: 5 } } as CASNode,
    { id: 'n_controller', name: 'OrdersController', type: 'rails_controller', source: { file: '/repo/app/controllers/orders_controller.rb', line: 1 } } as CASNode,
    { id: 'n_model', name: 'Order', type: 'rails_model', source: { file, line: 1 } } as CASNode,
    { id: 'n_class', name: 'Order', type: 'class', source: { file, line: 9 } } as CASNode,
    stateNode('n_state_cart', 'cart', true),
    stateNode('n_state_address', 'address'),
    stateNode('n_state_complete', 'complete'),
  ];

  const stateMachineEdges: CASEdge[] = [
    edge('e_route', 'n_route', 'n_controller', 'routes_to'),
    edge('e_model', 'n_controller', 'n_model', 'uses'),
    edge('e_own_cart', 'n_class', 'n_state_cart', 'contains'),
    edge('e_own_address', 'n_class', 'n_state_address', 'contains'),
    edge('e_own_complete', 'n_class', 'n_state_complete', 'contains'),
    edge('e_t1', 'n_state_cart', 'n_state_address', 'transitions_to'),
    edge('e_t2', 'n_state_address', 'n_state_complete', 'transitions_to'),
  ];

  const orderEntity: CASDataEntity = {
    id: 'entity_order',
    name: 'Order',
    lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] },
  } as CASDataEntity;

  const entryPoint: CASEntryPoint = {
    id: 'entry_create_order',
    source_node: 'n_route',
    type: 'http',
    name: 'POST /orders',
    trigger: { method: 'POST', path: '/orders' },
    handler: { node_id: 'n_controller', method_name: 'create' },
  } as CASEntryPoint;

  const input = {
    nodes: stateMachineNodes,
    edges: stateMachineEdges,
    entryPoints: [entryPoint],
    exitPoints: [],
    callChains: [
      chain('chain_order', 'n_route', 'entry_create_order', [['n_route', 0], ['n_controller', 1]]),
    ],
    dataEntities: [orderEntity],
  };

  it('walks from a model step into its state machine through transitions_to', () => {
    const { journeys } = buildUserJourneys(input);
    expect(journeys).toHaveLength(1);
    const stepNames = journeys[0].steps.map(step => step.name);
    expect(stepNames).toContain('Order');
    const cartIndex = stepNames.indexOf('cart');
    const addressIndex = stepNames.indexOf('address');
    const completeIndex = stepNames.indexOf('complete');
    expect(cartIndex).toBeGreaterThan(-1);
    expect(addressIndex).toBeGreaterThan(cartIndex);
    expect(completeIndex).toBeGreaterThan(addressIndex);
  });

  it('renders state steps with the state name and keeps terminal grounding on the entity', () => {
    const { journeys } = buildUserJourneys(input);
    const journey = journeys[0];
    const stateSteps = journey.steps.filter(step => ['cart', 'address', 'complete'].includes(step.name));
    expect(stateSteps).toHaveLength(3);
    for (const step of stateSteps) {
      expect(step.layer).toBe('business');
    }
    const terminalNames = journey.terminal_entities.map(entity => entity.name);
    expect(terminalNames).toContain('Order');
    expect(terminalNames).not.toContain('cart');
    expect(terminalNames).not.toContain('address');
    expect(terminalNames).not.toContain('complete');
  });

  it('does not pull in a state machine from an unrelated file that shares the model name', () => {
    const otherFile = '/repo/core/app/models/spree/other.rb';
    const unrelated: CASNode[] = [
      { id: 'n_other_class', name: 'Other', type: 'class', source: { file: otherFile, line: 1 } } as CASNode,
      { id: 'n_other_state', name: 'pending', type: 'state', source: { file: otherFile, line: 5 }, metadata: { attributes: { initial: true } } } as CASNode,
    ];
    const { journeys } = buildUserJourneys({
      ...input,
      nodes: [...stateMachineNodes, ...unrelated],
      edges: [...stateMachineEdges, edge('e_other', 'n_other_class', 'n_other_state', 'contains')],
    });
    const stepNames = journeys[0].steps.map(step => step.name);
    expect(stepNames).not.toContain('pending');
  });
});

describe('buildUserJourneys entry guard truth', () => {
  const httpEntry = (overrides: Partial<CASEntryPoint>): CASEntryPoint => ({
    id: 'entry_update_config',
    source_node: 'n_controller',
    type: 'http',
    name: 'PUT /automation/autopilot/config',
    trigger: { method: 'PUT', path: '/automation/autopilot/config' },
    handler: { node_id: 'n_controller', method_name: 'updateConfig' },
    ...overrides,
  } as CASEntryPoint);

  const input = (entryPoint: CASEntryPoint) => ({
    nodes: [
      node('n_controller', 'AutoPilotController', 'controller'),
      node('n_service', 'AutomationService', 'service'),
    ],
    edges: [edge('e1', 'n_controller', 'n_service', 'calls')],
    entryPoints: [entryPoint],
    exitPoints: [],
    callChains: [],
    dataEntities: [],
  });

  it('renders security.guards set by the analyzer as entry-guard boundaries', () => {
    const { journeys } = buildUserJourneys(input(httpEntry({
      security: { authenticated: false, authorized_roles: [], guards: ['ThrottlerGuard'] },
      metadata: { controller: 'AutoPilotController', handler: 'updateConfig', guards: ['ThrottlerGuard'] },
    })));
    expect(journeys[0].security_boundaries).toEqual([
      { name: 'ThrottlerGuard', mechanism: 'entry-guard', kind: 'rate-limiting' },
    ]);
  });

  it('reads metadata.guards as the same guard truth the route table renders', () => {
    const { journeys } = buildUserJourneys(input(httpEntry({
      security: { authenticated: false, authorized_roles: [] },
      metadata: { controller: 'AutoPilotController', handler: 'updateConfig', guards: ['ThrottlerGuard', 'ApiKeyGuard'] },
    })));
    const names = journeys[0].security_boundaries.map(boundary => boundary.name);
    expect(names).toEqual(['ApiKeyGuard', 'ThrottlerGuard']);
    const kinds = journeys[0].security_boundaries.map(boundary => boundary.kind);
    expect(kinds).toEqual(['authentication', 'rate-limiting']);
  });

  it('names global guards applied by the framework instead of the generic authentication label', () => {
    const { journeys } = buildUserJourneys(input(httpEntry({
      security: { authenticated: true, authorized_roles: [], guards: ['GlobalAuthGuard'] },
      metadata: { controller: 'AutoPilotController', handler: 'updateConfig', guards: ['GlobalAuthGuard'], global_guards: ['GlobalAuthGuard'] },
    })));
    expect(journeys[0].security_boundaries).toEqual([
      { name: 'GlobalAuthGuard', mechanism: 'entry-guard', kind: 'authentication' },
    ]);
  });

  it('deduplicates guards present in both security and metadata', () => {
    const { journeys } = buildUserJourneys(input(httpEntry({
      security: { authenticated: true, authorized_roles: [], guards: ['LocalAuthGuard', 'ThrottlerGuard'] },
      metadata: { guards: ['LocalAuthGuard', 'ThrottlerGuard'] },
    })));
    const names = journeys[0].security_boundaries.map(boundary => boundary.name);
    expect(names).toEqual(['LocalAuthGuard', 'ThrottlerGuard']);
  });

  it('keeps the authentication fallback when authenticated with no named guards', () => {
    const { journeys } = buildUserJourneys(input(httpEntry({
      security: { authenticated: true, authorized_roles: [] },
    })));
    expect(journeys[0].security_boundaries).toEqual([
      { name: 'authentication', mechanism: 'entry-guard', kind: 'authentication' },
    ]);
  });

  it('keeps anonymous opted-out entries unguarded', () => {
    const { journeys } = buildUserJourneys(input(httpEntry({
      security: { authenticated: false, authorized_roles: [], guards: [] },
      metadata: { guards: [] },
    })));
    expect(journeys[0].security_boundaries).toEqual([]);
  });
});

describe('buildUserJourneys page-component entries', () => {
  it('names a page-component entry from its trigger pattern and keeps it free of HTTP framing', () => {
    const input = {
      nodes: [
        node('n_page', 'ProfitMachine', 'react_page'),
        node('n_hook', 'useBosState', 'hook'),
      ],
      edges: [edge('e1', 'n_page', 'n_hook', 'calls')],
      entryPoints: [{
        id: 'entry_profit_machine',
        source_node: 'n_page',
        source_analyzer: 'react',
        type: 'page',
        name: 'Page ProfitMachine',
        trigger: { pattern: '/profit-machine' },
        metadata: { component: 'ProfitMachine', name: 'ProfitMachine', trigger_kind: 'page-component' },
      } as CASEntryPoint],
      exitPoints: [],
      callChains: [],
      dataEntities: [],
    };

    const { journeys } = buildUserJourneys(input);
    expect(journeys).toHaveLength(1);
    // The hook node carries no product identity: it must not be promoted to
    // a terminal outcome, so the name stays at the entry action.
    expect(journeys[0].name).toBe('View profit machine');
    expect(journeys[0].terminal_entities).toEqual([]);
    expect(journeys[0].entry.method).toBeUndefined();
    expect(journeys[0].entry.path_or_trigger).toBe('/profit-machine');
  });
});

describe('buildUserJourneys CLI entry naming', () => {
  const cliEntry = (
    id: string,
    sourceNode: string,
    name: string,
    metadata?: Record<string, unknown>,
    trigger?: { pattern?: string }
  ): CASEntryPoint => ({
    id,
    source_node: sourceNode,
    source_analyzer: 'rust',
    type: 'cli',
    name,
    trigger,
    metadata,
  } as CASEntryPoint);

  const callGraph = () => ({
    nodes: [
      node('n_main', 'main', 'function'),
      node('n_runner', 'run_loop', 'function'),
    ],
    edges: [edge('e1', 'n_main', 'n_runner', 'calls')],
    exitPoints: [],
    callChains: [],
    dataEntities: [],
  });

  it('names a bare main entry after its binary instead of main', () => {
    const input = {
      ...callGraph(),
      entryPoints: [cliEntry('entry:main:bin/coordinator/src/main.rs', 'n_main', 'main', { crate: 'coordinator', binary: 'coordinator' })],
    };

    const { journeys } = buildUserJourneys(input);
    expect(journeys).toHaveLength(1);
    expect(journeys[0].name).toBe('Run coordinator -> run_loop');
    expect(journeys[0].name).not.toMatch(/\bmain\b/);
  });

  it('names a build script entry as a build of its crate', () => {
    const input = {
      ...callGraph(),
      entryPoints: [cliEntry('entry:main:bin/agent/build.rs', 'n_main', 'main', { crate: 'agent', build_script: true })],
    };

    const { journeys } = buildUserJourneys(input);
    expect(journeys[0].name).toBe('Build agent -> run_loop');
  });

  it('names a clap subcommand variant with binary plus subcommand intent', () => {
    const input = {
      ...callGraph(),
      entryPoints: [cliEntry('entry:cli:bin/agent/src/main.rs:subcommand:Connect', 'n_main', 'Connect', {
        crate: 'agent', binary: 'agent', subcommand: 'Connect', command_type: 'subcommand_variant',
      })],
    };

    const { journeys } = buildUserJourneys(input);
    expect(journeys[0].name).toBe('Agent connect -> run_loop');
  });

  it('humanizes multi-word subcommand variants', () => {
    const input = {
      ...callGraph(),
      entryPoints: [cliEntry('entry:cli:bin/scan/src/main.rs:subcommand:ScanTarget', 'n_main', 'ScanTarget', {
        crate: 'zerac-scan', binary: 'scan', subcommand: 'ScanTarget', command_type: 'subcommand_variant',
      })],
    };

    const { journeys } = buildUserJourneys(input);
    expect(journeys[0].name).toBe('Scan target -> run_loop');
  });

  it('falls back to the binary when the clap command struct name is generic', () => {
    const input = {
      ...callGraph(),
      entryPoints: [cliEntry('entry:cli:bin/zeracd/src/main.rs:Commands', 'n_main', 'Commands', {
        crate: 'zeracd', binary: 'zeracd', command: 'Commands', command_type: 'subcommand_enum',
      })],
    };

    const { journeys } = buildUserJourneys(input);
    expect(journeys[0].name).toBe('Run zeracd -> run_loop');
  });

  it('strips clap type suffixes from descriptive command struct names', () => {
    const input = {
      ...callGraph(),
      entryPoints: [cliEntry('entry:cli:crates/config/src/agent.rs:AgentClap', 'n_main', 'AgentClap', {
        crate: 'zerac_config', binary: 'zerac_config', command: 'AgentClap', command_type: 'command_struct',
      })],
    };

    const { journeys } = buildUserJourneys(input);
    expect(journeys[0].name).toBe('Run agent -> run_loop');
  });

  it('derives the program from the entry file path when metadata is absent', () => {
    const input = {
      ...callGraph(),
      entryPoints: [cliEntry('entry:main:bin/agent/src/main.rs', 'n_main', 'main')],
    };

    const { journeys } = buildUserJourneys(input);
    expect(journeys[0].name).toBe('Run agent -> run_loop');
  });

  it('derives the binary stem for src/bin targets without metadata', () => {
    const input = {
      ...callGraph(),
      entryPoints: [cliEntry('entry:main:src/bin/zerac-ngrok.rs', 'n_main', 'main')],
    };

    const { journeys } = buildUserJourneys(input);
    expect(journeys[0].name).toBe('Run zerac-ngrok -> run_loop');
  });

  it('keeps non-file trigger patterns from other CLI analyzers', () => {
    const input = {
      ...callGraph(),
      entryPoints: [cliEntry('entry_cli_app_user_promote', 'n_main', 'bin/console app:user:promote', undefined, { pattern: 'app:user:promote' })],
    };

    const { journeys } = buildUserJourneys(input);
    expect(journeys[0].name).toBe('Run app:user:promote -> run_loop');
  });

  it('drops a zero-signal main terminal outcome', () => {
    const input = {
      nodes: [
        node('n_main', 'main', 'function'),
        node('n_helper', 'main', 'function_call'),
      ],
      edges: [edge('e1', 'n_main', 'n_helper', 'calls')],
      entryPoints: [cliEntry('entry:main:bin/hello/src/main.rs', 'n_main', 'main', { crate: 'hello', binary: 'hello' })],
      exitPoints: [],
      callChains: [],
      dataEntities: [],
    };

    const { journeys } = buildUserJourneys(input);
    expect(journeys[0].name).toBe('Run hello');
  });

  it('builds a single journey when the same entry point id appears twice', () => {
    const duplicate = cliEntry('entry:main:bin/agent/build.rs', 'n_main', 'main', { crate: 'agent', build_script: true });
    const input = {
      ...callGraph(),
      entryPoints: [duplicate, { ...duplicate }],
    };

    const { journeys } = buildUserJourneys(input);
    expect(journeys).toHaveLength(1);
    expect(journeys[0].name).toBe('Build agent -> run_loop');
  });

  it('disambiguates same-named CLI journeys with binary context instead of main', () => {
    const graph = {
      nodes: [
        node('n_main_a', 'main', 'function'),
        node('n_main_b', 'main', 'function'),
        node('n_runner', 'run_loop', 'function'),
      ],
      edges: [
        edge('e1', 'n_main_a', 'n_runner', 'calls'),
        edge('e2', 'n_main_b', 'n_runner', 'calls'),
      ],
      exitPoints: [],
      callChains: [],
      dataEntities: [],
    };
    const input = {
      ...graph,
      entryPoints: [
        cliEntry('entry:main:crates/transport/build.rs', 'n_main_a', 'main', { crate: 'transport', build_script: true }),
        cliEntry('entry:main:crates/version/build.rs', 'n_main_b', 'main', { crate: 'transport', build_script: true }),
      ],
    };

    const { journeys } = buildUserJourneys(input);
    const names = journeys.map(j => j.name).sort();
    expect(names).toHaveLength(2);
    expect(names[0]).not.toContain('(main)');
    expect(names[1]).not.toContain('(main)');
    expect(names.some(name => name.includes('transport'))).toBe(true);
  });
});

describe('buildUserJourneys terminal data hygiene', () => {
  it('never stores an HTTP verb as a terminal entity and classifies verb handlers as entry steps', () => {
    // Next.js App Router style: the route handler is a function literally
    // named GET; the walk also reaches a same-name alias node with another id.
    const input = {
      nodes: [
        node('n_get_handler', 'GET', 'function'),
        node('n_get_alias', 'GET', 'function'),
        node('n_service', 'fetchCollection', 'function'),
      ],
      edges: [
        edge('e1', 'n_get_handler', 'n_get_alias', 'calls'),
        edge('e2', 'n_get_alias', 'n_service', 'calls'),
      ],
      entryPoints: [{
        id: 'entry_get_collection',
        source_node: 'n_get_handler',
        type: 'http',
        name: 'GET /api/economy/collection',
        trigger: { method: 'GET', path: '/api/economy/collection' },
        handler: { node_id: 'n_get_handler', method_name: 'GET' },
      } as CASEntryPoint],
      exitPoints: [],
      callChains: [],
      dataEntities: [],
    };

    const { journeys } = buildUserJourneys(input);
    expect(journeys).toHaveLength(1);
    const terminalNames = journeys[0].terminal_entities.map(t => t.name);
    expect(terminalNames).not.toContain('GET');
    expect(journeys[0].terminal_effects.entities_read).not.toContain('GET');
    expect(journeys[0].terminal_effects.entities_written).not.toContain('GET');
    for (const step of journeys[0].steps) {
      if (step.name === 'GET') expect(step.layer).toBe('entry');
    }
  });

  it('never emits hook, hook-usage, or lifecycle names in terminal effects or entities', () => {
    const input = {
      nodes: [
        node('n_page', 'BuySellView', 'functional_component'),
        node('n_hook_usage', 'useEffect usage', 'hook_usage'),
        node('n_hook', 'useAutomationConfig', 'hook'),
      ],
      edges: [
        edge('e1', 'n_page', 'n_hook_usage', 'uses'),
        edge('e2', 'n_page', 'n_hook', 'calls'),
      ],
      entryPoints: [{
        id: 'entry_buy_sell',
        source_node: 'n_page',
        source_analyzer: 'react',
        type: 'page',
        name: 'Page BuySellView',
        trigger: { pattern: '/buy-sell' },
        metadata: { component: 'BuySellView' },
      } as CASEntryPoint],
      exitPoints: [],
      callChains: [],
      dataEntities: [],
    };

    const { journeys } = buildUserJourneys(input);
    expect(journeys).toHaveLength(1);
    const journey = journeys[0];
    const terminalNames = journey.terminal_entities.map(t => t.name);
    for (const name of terminalNames) {
      expect(name).not.toMatch(/^use[A-Z]/);
      expect(name).not.toContain(' usage');
    }
    expect(journey.terminal_effects.entities_read).toEqual([]);
    expect(journey.terminal_effects.entities_written).toEqual([]);
    const hookUsageStep = journey.steps.find(step => step.name === 'useEffect usage');
    expect(hookUsageStep?.layer).toBe('infrastructure');
    const hookStep = journey.steps.find(step => step.name === 'useAutomationConfig');
    expect(hookStep?.layer).toBe('infrastructure');
  });

  it('resolves a frontend journey terminal to the data entity behind its API call', () => {
    const input = {
      nodes: [
        node('n_page', 'PortfolioPage', 'react_page'),
        node('n_hook', 'usePortfolio', 'hook'),
      ],
      edges: [edge('e1', 'n_page', 'n_hook', 'calls')],
      entryPoints: [{
        id: 'entry_portfolio',
        source_node: 'n_page',
        source_analyzer: 'react',
        type: 'page',
        name: 'Page PortfolioPage',
        trigger: { pattern: '/portfolio' },
        metadata: { component: 'PortfolioPage' },
      } as CASEntryPoint],
      exitPoints: [{
        id: 'exit_api_portfolio',
        source_node: 'n_hook',
        type: 'api',
        name: 'POST /api/portfolio',
        target: { service_id: 'external_api', endpoint: '/api/portfolio' },
        operation: { method: 'POST', action: 'post' },
      } as CASExitPoint],
      callChains: [],
      dataEntities: [
        { id: 'entity_portfolio', name: 'Portfolio', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } } as CASDataEntity,
      ],
    };

    const { journeys } = buildUserJourneys(input);
    expect(journeys).toHaveLength(1);
    const terminal = journeys[0].terminal_entities[0];
    expect(terminal.name).toBe('Portfolio');
    expect(terminal.entity_id).toBe('entity_portfolio');
    expect(terminal.terminal_kind).toBe('entity');
    expect(terminal.access).toBe('created');
    expect(journeys[0].terminal_effects.entities_written).toContain('Portfolio');
  });

  it('falls back to the API resource noun when no data entity matches', () => {
    const input = {
      nodes: [
        node('n_page', 'HoldingsPage', 'react_page'),
        node('n_hook', 'useConnectionHoldings', 'hook'),
      ],
      edges: [edge('e1', 'n_page', 'n_hook', 'calls')],
      entryPoints: [{
        id: 'entry_holdings',
        source_node: 'n_page',
        source_analyzer: 'react',
        type: 'page',
        name: 'Page HoldingsPage',
        trigger: { pattern: '/holdings' },
        metadata: { component: 'HoldingsPage' },
      } as CASEntryPoint],
      exitPoints: [{
        id: 'exit_api_holdings',
        source_node: 'n_hook',
        type: 'api',
        name: 'GET /api/connections/holdings',
        target: { service_id: 'external_api', endpoint: '/api/connections/holdings' },
        operation: { method: 'GET', action: 'fetch' },
      } as CASExitPoint],
      callChains: [],
      dataEntities: [],
    };

    const { journeys } = buildUserJourneys(input);
    const terminal = journeys[0].terminal_entities[0];
    expect(terminal.name).toBe('Holding');
    expect(terminal.access).toBe('read');
  });

  it('never promotes Flutter lifecycle methods or widget builders to terminals and demotes them from business stages', () => {
    const input = {
      nodes: [
        node('n_screen', 'DashboardScreen', 'mobile_screen'),
        node('n_init', 'initState', 'method'),
        node('n_build', 'build', 'method'),
        node('n_dispose', 'dispose', 'method'),
        node('n_builder', '_buildHeader', 'method'),
        node('n_service', 'AgentDirectory', 'class'),
      ],
      edges: [
        edge('e1', 'n_screen', 'n_init', 'calls'),
        edge('e2', 'n_screen', 'n_build', 'calls'),
        edge('e3', 'n_screen', 'n_dispose', 'calls'),
        edge('e4', 'n_build', 'n_builder', 'calls'),
        edge('e5', 'n_init', 'n_service', 'calls'),
      ],
      entryPoints: [{
        id: 'entry_dashboard',
        source_node: 'n_screen',
        source_analyzer: 'dart',
        type: 'page',
        name: 'Dashboard screen',
        trigger: { pattern: '/dashboard' },
        metadata: {},
      } as CASEntryPoint],
      exitPoints: [],
      callChains: [],
      dataEntities: [],
    };

    const { journeys } = buildUserJourneys(input);
    expect(journeys).toHaveLength(1);
    const journey = journeys[0];
    const terminalNames = journey.terminal_entities.map(t => t.name);
    for (const banned of ['initState', 'build', 'dispose', '_buildHeader']) {
      expect(terminalNames).not.toContain(banned);
    }
    // The fallback resolves past lifecycle plumbing to the deepest node with identity.
    expect(terminalNames).toContain('AgentDirectory');
    for (const step of journey.steps) {
      if (['initState', 'build', 'dispose', '_buildHeader'].includes(step.name)) {
        expect(step.layer).toBe('infrastructure');
      }
    }
  });

  it('keeps helper and extension classes out of terminals and classifies getters as infrastructure', () => {
    const input = {
      nodes: [
        node('n_controller', 'AddressesController', 'controller'),
        node('n_service', 'AddressesService', 'service'),
        node('n_ext', 'ClaimsPrincipalExtensions', 'class'),
        node('n_helper', 'PathHelper', 'class'),
        node('n_getter', 'GetIntOrDefault', 'method'),
        node('n_getter2', 'GetServerPath', 'method'),
      ],
      edges: [
        edge('e1', 'n_controller', 'n_service', 'calls'),
        edge('e2', 'n_service', 'n_ext', 'calls'),
        edge('e3', 'n_service', 'n_helper', 'calls'),
        edge('e4', 'n_helper', 'n_getter', 'calls'),
        edge('e5', 'n_helper', 'n_getter2', 'calls'),
      ],
      entryPoints: [{
        id: 'entry_get_addresses',
        source_node: 'n_controller',
        type: 'http',
        name: 'GET /api/addresses',
        trigger: { method: 'GET', path: '/api/addresses' },
        handler: { node_id: 'n_controller', method_name: 'GetAddresses' },
      } as CASEntryPoint],
      exitPoints: [],
      callChains: [],
      dataEntities: [],
    };

    const { journeys } = buildUserJourneys(input);
    expect(journeys).toHaveLength(1);
    const journey = journeys[0];
    const terminalNames = journey.terminal_entities.map(t => t.name);
    for (const banned of ['ClaimsPrincipalExtensions', 'PathHelper', 'GetIntOrDefault', 'GetServerPath']) {
      expect(terminalNames).not.toContain(banned);
    }
    expect(terminalNames).toContain('AddressesService');
    for (const step of journey.steps) {
      if (['GetIntOrDefault', 'GetServerPath', 'ClaimsPrincipalExtensions', 'PathHelper'].includes(step.name)) {
        expect(step.layer).toBe('infrastructure');
      }
    }
  });
});

describe('buildUserJourneys summary by_kind over the discovered set', () => {
  it('computes by_kind over ALL discovered journeys, not just the included top-N', () => {
    const nodes: CASNode[] = [node('n_ctrl', 'ThingsController', 'controller')];
    const entryPoints: CASEntryPoint[] = [];
    const callChains: CASCallChain[] = [];

    // 9 high-criticality user-facing journeys (each writes 3 entities, so they
    // dominate the criticality ranking) plus 1 lower-signal scheduled journey.
    for (let i = 0; i < 9; i++) {
      entryPoints.push({
        id: `entry_uf_${i}`,
        source_node: 'n_ctrl',
        type: 'http',
        name: `POST /things_${i}`,
        trigger: { method: 'POST', path: `/things_${i}` },
      } as CASEntryPoint);
      callChains.push(chain(`chain_uf_${i}`, 'n_ctrl', `entry_uf_${i}`, [['n_ctrl', 0]]));
    }
    entryPoints.push({
      id: 'entry_sched',
      source_node: 'n_ctrl',
      type: 'schedule',
      name: 'nightly_sweep',
      trigger: { schedule: '0 2 * * *' },
    } as CASEntryPoint);
    callChains.push(chain('chain_sched', 'n_ctrl', 'entry_sched', [['n_ctrl', 0]]));

    const dataEntities: CASDataEntity[] = entryPoints.map((ep, i) => ({
      id: `entity_${i}`,
      name: `Thing${i}`,
      lifecycle: { created_by: ['n_ctrl'], read_by: [], updated_by: [], deleted_by: [] },
    } as CASDataEntity));

    const { summary } = buildUserJourneys(
      { nodes, edges: [], entryPoints, exitPoints: [], callChains, dataEntities },
      { maxJourneys: 5 }
    );

    expect(summary.total_discovered).toBe(10);
    // The discovered set genuinely has 9 user-facing + 1 scheduled; by_kind
    // must reflect that even though the top-5 slice may not include the
    // scheduled journey.
    expect(summary.by_kind['user-facing'] + summary.by_kind.scheduled).toBe(10);
    expect(summary.by_kind.scheduled).toBe(1);
    expect(summary.by_kind['user-facing']).toBe(9);
  });

  it('reserves a fair share of the included budget for a minority kind instead of burying it', () => {
    const nodes: CASNode[] = [node('n_ctrl', 'ThingsController', 'controller')];
    const entryPoints: CASEntryPoint[] = [];
    const callChains: CASCallChain[] = [];
    const dataEntities: CASDataEntity[] = [];

    // 20 user-facing journeys with strong write signal (outrank the lone
    // system journey on every criticality tiebreaker) and exactly ONE system
    // journey (an operational CLI/script-rooted entry) with weaker signal.
    for (let i = 0; i < 20; i++) {
      entryPoints.push({
        id: `entry_uf_${i}`,
        source_node: 'n_ctrl',
        type: 'http',
        name: `POST /widgets_${i}`,
        trigger: { method: 'POST', path: `/widgets_${i}` },
      } as CASEntryPoint);
      callChains.push(chain(`chain_uf_${i}`, 'n_ctrl', `entry_uf_${i}`, [['n_ctrl', 0]]));
      dataEntities.push({
        id: `entity_${i}`,
        name: `Widget${i}`,
        lifecycle: { created_by: ['n_ctrl'], read_by: [], updated_by: [], deleted_by: [] },
      } as CASDataEntity);
    }
    entryPoints.push({
      id: 'entry_system_sole',
      source_node: 'n_ctrl',
      type: 'cli',
      name: 'sync-cache',
      trigger: { pattern: 'bin/sync-cache.sh' },
      handler: { node_id: 'n_ctrl', method_name: 'run', file: 'bin/sync-cache.sh' },
    } as CASEntryPoint);
    callChains.push(chain('chain_sys', 'n_ctrl', 'entry_system_sole', [['n_ctrl', 0]]));

    const { journeys, summary } = buildUserJourneys(
      { nodes, edges: [], entryPoints, exitPoints: [], callChains, dataEntities },
      { maxJourneys: 10 }
    );

    expect(summary.total_discovered).toBe(21);
    expect(summary.by_kind.system).toBe(1);
    expect(summary.by_kind['user-facing']).toBe(20);
    // The sole system journey must survive top-N selection even though a
    // pure global criticality ranking would rank it below all 20 stronger
    // user-facing journeys.
    expect(journeys.some(j => j.journey_kind === 'system')).toBe(true);
  });
});

describe('buildUserJourneys terminal effects scoped to the traced call chain', () => {
  it('does not union in a sibling controller action reached only via containment, not the traced chain', () => {
    const input = {
      nodes: [
        node('n_ctrl', 'InspectionsController', 'controller'),
        node('n_create', 'create', 'method'),
        node('n_destroy', 'destroy', 'method'),
        node('n_inspection', 'Inspection', 'entity'),
        node('n_driver', 'Driver', 'entity'),
      ],
      edges: [
        // Both actions are declared (contained) by the same controller class.
        edge('e_has1', 'n_ctrl', 'n_create', 'has_method'),
        edge('e_has2', 'n_ctrl', 'n_destroy', 'has_method'),
        // create -> Inspection is on the traced path.
        edge('e_creates', 'n_create', 'n_inspection', 'creates'),
        // destroy -> Driver belongs to the SIBLING action, never traversed by
        // the create entry's own call chain.
        edge('e_deletes', 'n_destroy', 'n_driver', 'deletes'),
      ],
      entryPoints: [{
        id: 'entry_create_inspection',
        source_node: 'n_ctrl',
        type: 'http',
        name: 'POST /inspections',
        trigger: { method: 'POST', path: '/inspections' },
        handler: { node_id: 'n_create', method_name: 'create' },
      } as CASEntryPoint],
      exitPoints: [],
      // A real, authoritative call chain exists for this entry and it only
      // reaches n_create -> n_inspection.
      callChains: [
        chain('chain_create_inspection', 'n_create', 'entry_create_inspection', [['n_create', 0], ['n_inspection', 1]]),
      ],
      dataEntities: [
        { id: 'entity_inspection', name: 'Inspection', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } } as CASDataEntity,
        { id: 'entity_driver', name: 'Driver', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } } as CASDataEntity,
      ],
    };

    const { journeys } = buildUserJourneys(input);
    expect(journeys).toHaveLength(1);
    const terminalNames = journeys[0].terminal_entities.map(t => t.name);
    expect(terminalNames).toContain('Inspection');
    expect(terminalNames).not.toContain('Driver');
    expect(journeys[0].terminal_effects.entities_written).not.toContain('Driver');
  });

  it('still expands contained methods as a fallback when no call chain exists for the entry', () => {
    // Regression guard for the message-handler-class shape: no call chain
    // evidence exists, so containment expansion remains the only way to find
    // the handler's single contained method.
    const input = {
      nodes: [
        node('n_msg_handler', 'AsyncReportHandler', 'message_handler'),
        node('n_invoke', '__invoke', 'method'),
        node('n_report_entity', 'Report', 'entity'),
      ],
      edges: [
        edge('e_contains', 'n_msg_handler', 'n_invoke', 'has_method'),
        edge('e_calls', 'n_invoke', 'n_report_entity', 'calls'),
      ],
      entryPoints: [{
        id: 'entry_msg',
        source_node: 'n_msg_handler',
        type: 'message',
        name: 'Message: ReportRequest',
        trigger: { pattern: 'ReportRequest' },
        metadata: { message_class: 'ReportRequest', handler: 'AsyncReportHandler' },
      } as CASEntryPoint],
      exitPoints: [],
      callChains: [],
      dataEntities: [
        { id: 'entity_report', name: 'Report', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } } as CASDataEntity,
      ],
    };

    const { journeys } = buildUserJourneys(input);
    expect(journeys).toHaveLength(1);
    expect(journeys[0].terminal_entities[0].name).toBe('Report');
  });
});

describe('buildUserJourneys action-verb route naming from handler evidence', () => {
  it('names an RPC-style /complete action route from the handler function name, not "Create complete"', () => {
    const input = {
      nodes: [
        node('n_ctrl', 'MaintenanceIssuesController', 'controller'),
        node('n_issue', 'MaintenanceIssue', 'entity'),
      ],
      edges: [
        edge('e_updates', 'n_ctrl', 'n_issue', 'updates'),
      ],
      entryPoints: [{
        id: 'entry_complete_issue',
        source_node: 'n_ctrl',
        type: 'http',
        name: 'POST /maintenance_issues/:id/complete',
        trigger: { method: 'POST', path: '/maintenance_issues/:id/complete' },
        handler: { node_id: 'n_ctrl', method_name: 'completeMaintenanceIssue' },
      } as CASEntryPoint],
      exitPoints: [],
      callChains: [],
      dataEntities: [
        { id: 'entity_issue', name: 'MaintenanceIssue', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } } as CASDataEntity,
      ],
    };

    const { journeys } = buildUserJourneys(input);
    expect(journeys).toHaveLength(1);
    expect(journeys[0].name.startsWith('Complete maintenance issue')).toBe(true);
    expect(journeys[0].name).not.toContain('Create complete');
  });

  it('names an /oauth/grant action route from the handler function name, not "Create grant"', () => {
    const input = {
      nodes: [
        node('n_ctrl', 'OAuthController', 'controller'),
        node('n_access', 'OAuthAccess', 'entity'),
      ],
      edges: [
        edge('e_creates', 'n_ctrl', 'n_access', 'creates'),
      ],
      entryPoints: [{
        id: 'entry_grant',
        source_node: 'n_ctrl',
        type: 'http',
        name: 'POST /oauth/grant',
        trigger: { method: 'POST', path: '/oauth/grant' },
        handler: { node_id: 'n_ctrl', method_name: 'grantOAuthAccess' },
      } as CASEntryPoint],
      exitPoints: [],
      callChains: [],
      dataEntities: [
        { id: 'entity_access', name: 'OAuthAccess', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } } as CASDataEntity,
      ],
    };

    const { journeys } = buildUserJourneys(input);
    expect(journeys).toHaveLength(1);
    expect(journeys[0].name.startsWith('Grant oauth access')).toBe(true);
    expect(journeys[0].name).not.toContain('Create grant');
  });

  it('keeps ordinary CRUD naming when the handler name does not share the route action word', () => {
    const input = {
      nodes: [
        node('n_ctrl', 'CommentsController', 'controller'),
        node('n_comment', 'Comment', 'entity'),
      ],
      edges: [
        edge('e_creates', 'n_ctrl', 'n_comment', 'creates'),
      ],
      entryPoints: [{
        id: 'entry_add_comment',
        source_node: 'n_ctrl',
        type: 'http',
        name: 'POST /comments',
        trigger: { method: 'POST', path: '/comments' },
        handler: { node_id: 'n_ctrl', method_name: 'addComment' },
      } as CASEntryPoint],
      exitPoints: [],
      callChains: [],
      dataEntities: [
        { id: 'entity_comment', name: 'Comment', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } } as CASDataEntity,
      ],
    };

    const { journeys } = buildUserJourneys(input);
    expect(journeys).toHaveLength(1);
    expect(journeys[0].name.startsWith('Create comment')).toBe(true);
  });
});

describe('buildUserJourneys coherent single guard verdict', () => {
  it('never reports "no auth guard" when the entry point is independently authenticated, even with a named authorization guard', () => {
    const nodes: CASNode[] = [
      node('n_ctrl', 'GrantsController', 'controller'),
      node('n_service', 'GrantsService', 'service'),
    ];
    const edges: CASEdge[] = [edge('e1', 'n_ctrl', 'n_service', 'calls')];
    const entryPoint: CASEntryPoint = {
      id: 'entry_grant_access',
      source_node: 'n_ctrl',
      type: 'http',
      name: 'POST /grants',
      trigger: { method: 'POST', path: '/grants' },
      handler: { node_id: 'n_ctrl', method_name: 'grant' },
      // Two independent, both-true security facts: the route requires
      // authentication AND carries a named authorization guard (IsGranted).
      // A rendered verdict must never say "guarded (authorization: X), no
      // auth guard" when authenticated is true.
      security: { authenticated: true, authorized_roles: [], guards: ['IsGranted'] },
    } as CASEntryPoint;

    const { journeys } = buildUserJourneys({
      nodes,
      edges,
      entryPoints: [entryPoint],
      exitPoints: [],
      callChains: [],
      dataEntities: [],
    });

    expect(journeys).toHaveLength(1);
    const boundaries = journeys[0].security_boundaries;
    const kinds = boundaries.map(b => b.kind);
    expect(kinds).toContain('authorization');
    expect(kinds).toContain('authentication');
    // No duplicate/contradictory "authentication" entries and no bare
    // "no auth guard" outcome once the authentication fact is present.
    expect(boundaries.filter(b => b.kind === 'authentication')).toHaveLength(1);
  });

  it('still reports "no auth guard" truthfully when the entry is only authorization-guarded, not authenticated', () => {
    const nodes: CASNode[] = [
      node('n_ctrl', 'GrantsController', 'controller'),
      node('n_service', 'GrantsService', 'service'),
    ];
    const entryPoint: CASEntryPoint = {
      id: 'entry_grant_access_2',
      source_node: 'n_ctrl',
      type: 'http',
      name: 'POST /grants2',
      trigger: { method: 'POST', path: '/grants2' },
      security: { authenticated: false, authorized_roles: [], guards: ['IsGranted'] },
    } as CASEntryPoint;

    const { journeys } = buildUserJourneys({
      nodes,
      edges: [edge('e1', 'n_ctrl', 'n_service', 'calls')],
      entryPoints: [entryPoint],
      exitPoints: [],
      callChains: [],
      dataEntities: [],
    });

    expect(journeys).toHaveLength(1);
    const boundaries = journeys[0].security_boundaries;
    expect(boundaries.map(b => b.kind)).toEqual(['authorization']);
    expect(boundaries.some(b => b.kind === 'authentication')).toBe(false);
  });
});
