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
