import { analyzeTerminality, buildCasTerminality } from '../../analyzer/core/terminality';
import type { CASOutput, FlowConcept, SystemCapability } from '../../types/cas.types';

describe('analyzeTerminality', () => {
  it('marks sinks, proximal members, and strongly connected terminal groups', () => {
    const result = analyzeTerminality(
      ['start', 'middle-a', 'middle-b', 'terminal-a', 'terminal-b'],
      [
        { source: 'start', target: 'middle-a' },
        { source: 'middle-a', target: 'middle-b' },
        { source: 'middle-b', target: 'middle-a' },
        { source: 'middle-b', target: 'terminal-a' },
        { source: 'terminal-a', target: 'terminal-b' },
        { source: 'terminal-b', target: 'terminal-a' },
      ],
    );
    const byId = new Map(result.map(member => [member.id, member]));
    expect(byId.get('terminal-a')).toMatchObject({ terminal: true, distance_to_terminal: 0, strongly_connected_size: 2 });
    expect(byId.get('middle-a')).toMatchObject({ proximal_terminal: true, distance_to_terminal: 1, strongly_connected_size: 2 });
    expect(byId.get('start')).toMatchObject({ terminal: false, proximal_terminal: false, distance_to_terminal: 2 });
  });

  it('handles deep graphs without recursive stack growth', () => {
    const ids = Array.from({ length: 20_000 }, (_, index) => `node-${index}`);
    const edges = ids.slice(1).map((id, index) => ({ source: ids[index], target: id }));
    const result = analyzeTerminality(ids, edges);
    const byId = new Map(result.map(member => [member.id, member]));
    expect(byId.get('node-19999')?.terminal).toBe(true);
    expect(byId.get('node-19998')?.proximal_terminal).toBe(true);
    expect(byId.get('node-0')?.distance_to_terminal).toBe(19_999);
  });
});

describe('buildCasTerminality', () => {
  const flow = (id: string, continuations: string[] = [], capabilityId?: string): FlowConcept => ({
    flow_id: id,
    name: id,
    intent: id,
    entry_point: `entry-${id}`,
    capability_id: capabilityId,
    entities: [],
    contract: { input: [], logic: id, side_effects: { state_changes: [], external_integrations: [] }, output: [], constraints: [] },
    steps: [],
    continuations,
  });

  const capability = (id: string, dependsOn: string[] = []): SystemCapability => ({
    id,
    name: id,
    name_source: 'manual',
    description: `Provides the complete ${id} product outcome for its intended users.`,
    description_source: 'manual',
    category: 'core',
    operations: [{ entry_point_id: `entry-${id}`, entry_point_type: 'http', action: id }],
    related_entities: [],
    related_domains: [],
    criticality: 'high',
    criticality_factors: [],
    depends_on: dependsOn.map(target => ({
      from_capability: id,
      to_capability: target,
      dependency_type: 'requires',
      strength: 'required',
      evidence: { shared_services: [], shared_nodes: [] },
      description: `${id} requires ${target}`,
    })),
  });

  const assignFlowNode = (targetFlow: FlowConcept, nodeId: string): void => {
    targetFlow.steps = [{
      step_id: `step-${targetFlow.flow_id}`,
      order: 1,
      name: targetFlow.name,
      description: targetFlow.intent,
      description_source: 'deterministic-label',
      contract: {} as FlowConcept['steps'][number]['contract'],
      functions: [{ function_id: nodeId }],
      entities: [],
    }];
  };

  it('distinguishes prerequisite authentication from a terminal product outcome', () => {
    const cas = {
      nodes: [],
      edges: [],
      entities: [],
      flows: [flow('authenticate', ['purchase']), flow('purchase')],
      capabilities: [capability('authentication'), capability('purchasing', ['authentication'])],
    } as unknown as CASOutput;
    const result = buildCasTerminality(cas);
    const flowById = new Map(result.flows.map(member => [member.id, member]));
    const capabilityById = new Map(result.capabilities.map(member => [member.id, member]));
    expect(flowById.get('purchase')?.terminal).toBe(true);
    expect(flowById.get('authenticate')?.proximal_terminal).toBe(true);
    expect(capabilityById.get('purchasing')?.terminal).toBe(true);
    expect(capabilityById.get('authentication')?.proximal_terminal).toBe(true);
  });

  it('identifies authentication as terminal when authentication is the product outcome', () => {
    const cas = {
      nodes: [],
      edges: [],
      entities: [],
      flows: [flow('validate-credentials', ['issue-token']), flow('issue-token')],
      capabilities: [capability('credential-validation'), capability('authentication', ['credential-validation'])],
    } as unknown as CASOutput;
    const result = buildCasTerminality(cas);
    const capabilityById = new Map(result.capabilities.map(member => [member.id, member]));
    expect(capabilityById.get('authentication')?.terminal).toBe(true);
    expect(capabilityById.get('credential-validation')?.proximal_terminal).toBe(true);
  });

  it('projects capability prerequisites onto primary flows without requiring an explicit continuation', () => {
    const cas = {
      nodes: [],
      edges: [],
      entities: [],
      flows: [
        flow('sign-in-request', [], 'authentication'),
        flow('place-order', [], 'purchasing'),
      ],
      capabilities: [
        capability('authentication'),
        capability('purchasing', ['authentication']),
      ],
    } as unknown as CASOutput;
    const result = buildCasTerminality(cas);
    const flowById = new Map(result.flows.map(member => [member.id, member]));
    expect(flowById.get('place-order')).toMatchObject({ terminal: true, distance_to_terminal: 0 });
    expect(flowById.get('sign-in-request')).toMatchObject({ proximal_terminal: true, distance_to_terminal: 1 });
  });

  it('uses prerequisite flow relationships when capability dependencies are unavailable', () => {
    const purchasingFlow = flow('place-order', [], 'purchasing');
    purchasingFlow.capability_relationships = [{
      capability_id: 'authentication',
      role: 'prerequisite',
      rationale: 'Ordering requires an authenticated account.',
    }];
    const cas = {
      nodes: [],
      edges: [],
      entities: [],
      flows: [flow('sign-in-request', [], 'authentication'), purchasingFlow],
      capabilities: [capability('authentication'), capability('purchasing')],
    } as unknown as CASOutput;
    const result = buildCasTerminality(cas);
    const flowById = new Map(result.flows.map(member => [member.id, member]));
    expect(flowById.get('place-order')?.terminal).toBe(true);
    expect(flowById.get('sign-in-request')?.proximal_terminal).toBe(true);
  });

  it('projects graph-owned enforcement mechanisms onto protected flows', () => {
    const policyFlow = flow('evaluate-policy');
    const operationFlow = flow('perform-operation');
    assignFlowNode(policyFlow, 'policy-node');
    assignFlowNode(operationFlow, 'operation-node');
    const cas = {
      nodes: [
        { id: 'policy-node', name: 'AccessPolicy', type: 'guard' },
        { id: 'operation-node', name: 'PerformOperation', type: 'method' },
      ],
      edges: [{ id: 'policy-edge', source: 'operation-node', target: 'policy-node', type: 'protected_by' }],
      entities: [],
      capabilities: [],
      flows: [policyFlow, operationFlow],
    } as unknown as CASOutput;
    const result = buildCasTerminality(cas);
    const flowById = new Map(result.flows.map(member => [member.id, member]));
    expect(flowById.get('perform-operation')).toMatchObject({ terminal: true, distance_to_terminal: 0 });
    expect(flowById.get('evaluate-policy')).toMatchObject({ proximal_terminal: true, distance_to_terminal: 1 });
  });

  it('does not infer provider flows from product vocabulary', () => {
    const identityProductFlow = flow('issue-token');
    const administrationFlow = flow('manage-admin-settings');
    assignFlowNode(identityProductFlow, 'token-issuer');
    assignFlowNode(administrationFlow, 'admin-handler');
    const cas = {
      nodes: [
        { id: 'token-issuer', name: 'IssueToken', type: 'method' },
        { id: 'admin-handler', name: 'ManageAdminSettings', type: 'method' },
        { id: 'admin-guard', name: 'AdminGuard', type: 'guard' },
      ],
      edges: [{ id: 'admin-edge', source: 'admin-handler', target: 'admin-guard', type: 'protected_by' }],
      entities: [],
      capabilities: [],
      flows: [identityProductFlow, administrationFlow],
    } as unknown as CASOutput;
    const result = buildCasTerminality(cas);
    const flowById = new Map(result.flows.map(member => [member.id, member]));
    expect(flowById.get('issue-token')).toMatchObject({ terminal: true, distance_to_terminal: 0 });
    expect(flowById.get('manage-admin-settings')).toMatchObject({ terminal: true, distance_to_terminal: 0 });
  });
});
