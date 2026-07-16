import {
  attachFlowContract,
  attachCapability,
  attachInteractionReach,
  type EntryPointLike,
  type FlowLike,
  type CapabilityLike,
  type CommunicationSeamsLike,
} from '../../analyzer/core/entry-point-enrichment';

function ep(overrides: Partial<EntryPointLike> & { id: string }): EntryPointLike {
  return { ...overrides };
}

function flow(overrides: Partial<FlowLike> & { flow_id: string; entry_point: string }): FlowLike {
  return { entities: [], ...overrides } as FlowLike;
}

describe('attachFlowContract', () => {
  it('marks output as void for a "()" contract', () => {
    const eps = [ep({ id: 'entry_a' })];
    const flows = [flow({ flow_id: 'f1', entry_point: 'entry_a', contract: { input: [], output: ['()'] } })];

    const [result] = attachFlowContract(eps, flows);

    expect(result.output).toEqual({ type: 'void', is_named_type: false, is_void: true });
    expect(result.input).toBeUndefined();
  });

  it('extracts a bare named type out of Promise<CASOutput>', () => {
    const eps = [ep({ id: 'entry_b' })];
    const flows = [
      flow({ flow_id: 'f2', entry_point: 'entry_b', contract: { input: [], output: ['Promise<CASOutput>'] } }),
    ];

    const [result] = attachFlowContract(eps, flows);

    expect(result.output).toEqual({ type: 'CASOutput', is_named_type: true, is_void: false });
  });

  it('resolves a nullable union (Promise<CASOutput | null>) to the named member', () => {
    const eps = [ep({ id: 'entry_c' })];
    const flows = [
      flow({
        flow_id: 'f3',
        entry_point: 'entry_c',
        contract: { input: [], output: ['Promise<CASOutput | null>'] },
      }),
    ];

    const [result] = attachFlowContract(eps, flows);

    expect(result.output).toEqual({ type: 'CASOutput', is_named_type: true, is_void: false });
  });

  it('does not treat a multi-member union or inline object type as a named type', () => {
    const eps = [ep({ id: 'entry_union' }), ep({ id: 'entry_inline' })];
    const flows = [
      flow({ flow_id: 'fu', entry_point: 'entry_union', contract: { input: [], output: ["'' | '.zst' | '.br'"] } }),
      flow({
        flow_id: 'fi',
        entry_point: 'entry_inline',
        contract: { input: [], output: ['Promise<{ stdout: string; code: number }>'] },
      }),
    ];

    const [unionResult, inlineResult] = attachFlowContract(eps, flows);

    expect(unionResult.output?.is_named_type).toBe(false);
    expect(inlineResult.output?.is_named_type).toBe(false);
    expect(inlineResult.output?.type).toBe('{ stdout: string; code: number }');
  });

  it('does not overwrite a pre-existing input/output on the entry point', () => {
    const existingOutput = { type: 'PreExisting', is_named_type: true, is_void: false };
    const eps = [ep({ id: 'entry_d', output: existingOutput })];
    const flows = [flow({ flow_id: 'f4', entry_point: 'entry_d', contract: { input: [], output: ['boolean'] } })];

    const [result] = attachFlowContract(eps, flows);

    expect(result.output).toBe(existingOutput);
  });

  it('derives named/positional input fields from contract.input', () => {
    const eps = [ep({ id: 'entry_e' })];
    const flows = [
      flow({
        flow_id: 'f5',
        entry_point: 'entry_e',
        contract: { input: ['userId: string', 'options: Options'], output: ['boolean'] },
      }),
    ];

    const [result] = attachFlowContract(eps, flows);

    expect(result.input).toEqual({
      fields: [
        { name: 'userId', type: 'string' },
        { name: 'options', type: 'Options' },
      ],
      is_positional_only: false,
    });
  });
});

describe('attachCapability', () => {
  const flows: FlowLike[] = [
    flow({ flow_id: 'flow_primary', entry_point: 'entry_multi', role: 'primary' }),
    flow({ flow_id: 'flow_supporting', entry_point: 'entry_multi', role: 'supporting' }),
    flow({ flow_id: 'flow_orphan', entry_point: 'entry_none', role: 'infrastructure' }),
  ];

  it('attaches many capabilities (primary + supporting roles) to one entry point', () => {
    const capabilities: CapabilityLike[] = [
      { id: 'cap_a', name: 'Capability A', related_flows: [{ flow_id: 'flow_primary', role: 'primary' }] },
      { id: 'cap_b', name: 'Capability B', related_flows: [{ flow_id: 'flow_supporting', role: 'supporting' }] },
    ];
    const eps = [ep({ id: 'entry_multi' })];

    const [result] = attachCapability(eps, flows, capabilities);

    expect(result.capabilities).toEqual([
      { capability_id: 'cap_a', capability_name: 'Capability A', role: 'primary' },
      { capability_id: 'cap_b', capability_name: 'Capability B', role: 'supporting' },
    ]);
  });

  it('leaves capabilities undefined for an entry point with no related capability (infrastructure flow)', () => {
    const capabilities: CapabilityLike[] = [
      { id: 'cap_c', name: 'Capability C', related_flows: [{ flow_id: 'flow_orphan', role: 'infrastructure' }] },
    ];
    // entry_none's only flow is infrastructure and untouched by any capability relation in this fixture;
    // an entry point with zero capability relations at all:
    const eps = [ep({ id: 'entry_isolated' })];

    const [result] = attachCapability(eps, flows, capabilities);

    expect(result.capabilities).toBeUndefined();
  });

  it('accepts bare string related_flows and preserves pre-existing capability refs', () => {
    const capabilities: CapabilityLike[] = [{ id: 'cap_d', name: 'Capability D', related_flows: ['flow_primary'] }];
    const preExisting = { capability_id: 'cap_pre', capability_name: 'Pre-existing', role: 'primary' };
    const eps = [ep({ id: 'entry_multi', capabilities: [preExisting] })];

    const [result] = attachCapability(eps, flows, capabilities);

    expect(result.capabilities).toEqual([
      preExisting,
      { capability_id: 'cap_d', capability_name: 'Capability D', role: 'primary' },
    ]);
  });
});

describe('attachInteractionReach', () => {
  it('marks a triggered http entry point as external', () => {
    const eps = [ep({ id: 'entry_http', type: 'http', trigger: { method: 'GET', path: '/orders' } })];
    const seams: CommunicationSeamsLike = { seams: [] };

    const [result] = attachInteractionReach(eps, seams);

    expect(result.interaction_reach).toBe('external');
  });

  it('marks an internally-triggered message entry point as internal', () => {
    const eps = [ep({ id: 'entry_msg', type: 'message' })];
    const seams: CommunicationSeamsLike = { seams: [] };

    const [result] = attachInteractionReach(eps, seams);

    expect(result.interaction_reach).toBe('internal');
  });

  it('falls back to unknown when there is no type or seam evidence', () => {
    const eps = [ep({ id: 'entry_cli', type: 'cli' })];
    const seams: CommunicationSeamsLike = { seams: [] };

    const [result] = attachInteractionReach(eps, seams);

    expect(result.interaction_reach).toBe('unknown');
  });

  it('prefers seam evidence over the type-based fallback when a matching seam exists', () => {
    const eps = [ep({ id: 'entry_evidenced', type: 'cli', source_node: 'function:src/handler.ts:run' })];
    const seams: CommunicationSeamsLike = {
      seams: [
        {
          id: 'seam_1',
          kind: 'messaging',
          source: 'external_actor',
          target: 'internal',
          evidence: 'inbound call into function:src/handler.ts:run from queue',
        },
      ],
    };

    const [result] = attachInteractionReach(eps, seams);

    expect(result.interaction_reach).toBe('internal');
  });
});
