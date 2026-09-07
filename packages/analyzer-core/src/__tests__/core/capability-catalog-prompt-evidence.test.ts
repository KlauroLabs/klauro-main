import { projectCapabilityCatalogPromptEvidence, capabilityCatalogStructuralApiLabels } from '../../analyzer/core/capability-catalog-prompt-evidence';
import { projectCapabilityCatalogPromptFacts } from '../../analyzer/core/capability-catalog-prompt-facts';
import type { CASEntryPoint, CASNode, SystemCapability } from '../../types/cas.types';

function capability(overrides: Partial<SystemCapability>): SystemCapability {
  return {
    id: 'candidate',
    name: 'Scheduled Task Surface',
    description: '',
    category: 'supporting',
    operations: [],
    related_entities: [],
    related_domains: [],
    criticality: 'medium',
    criticality_factors: [],
    ...overrides,
  };
}

describe('capability catalog prompt evidence', () => {
  it('resolves all retained surface operations from CAS entries rather than a five-name sample', () => {
    const entries: CASEntryPoint[] = Array.from({ length: 85 }, (_, index) => ({
      id: 'entry-' + index, source_node: 'node-' + index, type: 'message', name: 'inspect_record_' + index,
    }));
    const value = capability({
      evidence_kind: 'behavior-surface', evidence_role: 'supporting-mechanism',
      evidence_examples: entries.slice(0, 5).map(entry => entry.name),
      operations: entries.map(entry => ({ entry_point_id: entry.id, entry_point_type: entry.type, action: 'Handle' })),
    });
    const [fact] = projectCapabilityCatalogPromptFacts([value], new Map(), new Map(entries.map(entry => [entry.id, entry])), new Map(), new Map());
    expect(fact.operations).toEqual(entries.map((_, index) => 'Inspect record ' + index));
    expect(fact.entry_points).toBe(85);
    expect(fact.evidence_role).toBe('supporting-mechanism');
    expect(value.evidence_examples).toHaveLength(5);
    expect(value.operations.every(operation => operation.action === 'Handle')).toBe(true);
    const missing = { ...value, operations: [...value.operations, { entry_point_id: 'missing:invented_effect', entry_point_type: 'message' as const, action: 'Handle' }] };
    const projected = projectCapabilityCatalogPromptEvidence(missing, new Map(), new Map(entries.map(entry => [entry.id, entry])));
    expect(projected.unresolved_entry_point_ids).toEqual(['missing:invented_effect']);
    expect(projected.operations).toEqual(fact.operations);
  });

  it('retains every operation description instead of treating the first eight as the whole surface', () => {
    const evidence = Array.from({ length: 85 }, (_, index) => 'Inspect record ' + index);
    const candidate = capability({
      evidence_kind: 'behavior-surface', evidence_examples: evidence,
      operations: evidence.map((name, index) => ({ entry_point_id: 'entry-' + index, entry_point_type: 'message', action: name })),
    });
    const result = projectCapabilityCatalogPromptEvidence(candidate);
    expect(result.operations).toEqual(evidence);
    expect(candidate.evidence_examples).toEqual(evidence);
    expect(result.name.length).toBeLessThan(result.operations.join(', ').length);
  });

  it.each(['api', 'rpc'] as const)('projects only retained %s evidence without reviving legacy examples', entryType => {
    const retained = { entry_point_id: 'request', source_node_id: 'node_request', text: 'Route HTTP requests.' };
    const candidate = capability({
      name: 'Protocol handling',
      operations: [{ entry_point_id: 'request', entry_point_type: entryType, action: 'read' }],
      operation_evidence: [
        retained, retained,
        { entry_point_id: 'removed', source_node_id: 'node_removed', text: 'Sell products.' },
        { entry_point_id: 'request', source_node_id: '', text: 'Manage payments.' },
      ],
      evidence_examples: ['Delete user accounts.'],
    });
    expect(projectCapabilityCatalogPromptEvidence(candidate).operations).toEqual(['Route HTTP requests']);
    expect(candidate.operation_evidence).toHaveLength(4);
    expect(projectCapabilityCatalogPromptEvidence({ ...candidate, operation_evidence: [] }).operations).toEqual(['Read']);
  });

  it('preserves source contract qualifications and excludes illustrative code from owned behavior', () => {
    const prose = 'Returns a supplied record without verifying it. It does not accept or reject records. The caller must decide whether to accept it.';
    const raw = prose + '\n\n~~~typescript\nacceptRecord(record);\n~~~\n\nNo record is stored by this helper.';
    const node = { id: 'reader', name: 'readRecord', documentation: { raw, summary: 'Returns a supplied record.' } } as CASNode;
    const value = capability({
      name: 'Record API',
      operations: [{ entry_point_id: 'read', entry_point_type: 'api', action: 'read' }],
      operation_evidence: [
        { entry_point_id: 'read', source_node_id: 'reader', text: 'read record verify accept reject' },
        { entry_point_id: 'removed', source_node_id: 'reader', text: 'unrelated' },
        { entry_point_id: 'read', source_node_id: 'absent', text: 'unresolvable' },
      ],
    });
    const projected = projectCapabilityCatalogPromptEvidence(value, new Map([['reader', node]]));
    expect(projected.declared_contracts).toEqual([{
      entry_point_id: 'read', source_node_id: 'reader',
      text: prose + '\n\n\nNo record is stored by this helper.',
      example_blocks_omitted: 1,
    }]);
    expect(JSON.stringify(projected.declared_contracts)).not.toContain('acceptRecord(record)');
    expect(node.documentation?.raw).toBe(raw);
  });

  it('keeps public API groups as structure and proposes from their behavior', () => {
    const candidate = capability({
      name: 'Courier Request API', structural_label: 'Courier Request API Management',
      operations: [{ entry_point_id: 'request', entry_point_type: 'api', action: 'read' }],
      evidence_examples: ['request.accepts: Negotiate the response content type'],
    });
    expect(capabilityCatalogStructuralApiLabels([candidate])).toEqual(['Courier Request API', 'Courier Request API Management']);
    const result = projectCapabilityCatalogPromptEvidence(candidate);
    expect(result.name).not.toBe(candidate.name);
    expect(result.operations.join(' ')).toContain('Negotiate the response content type');
    expect(candidate.name).toBe('Courier Request API');
    expect(candidate.operations).toHaveLength(1);
  });

  it('does not classify authored library outcomes or ordinary API mentions as raw groups', () => {
    const authored = capability({
      name: 'Negotiate response formats through an API', name_source: 'manual',
      operations: [{ entry_point_id: 'request', entry_point_type: 'api', action: 'read' }],
    });
    expect(capabilityCatalogStructuralApiLabels([authored])).toEqual([]);
    expect(projectCapabilityCatalogPromptEvidence(authored).name).toBe(authored.name);
  });

  it('removes structural surface vocabulary from implementation-shaped evidence', () => {
    const result = projectCapabilityCatalogPromptEvidence(capability({
      name: 'Celery Task Surface',
      structural_label: 'Celery Task Surface',
      evidence_kind: 'behavior-surface',
      evidence_examples: ['celery.task.create_payment_invoice', 'celery:task:sync_orders'],
    }));

    expect(result).toEqual({
      name: 'Create payment invoice, Sync orders',
      operations: ['Create payment invoice', 'Sync orders'],
      relationships: [],
    });
  });

  it('uses observed actions when a surface has no named examples', () => {
    const result = projectCapabilityCatalogPromptEvidence(capability({
      evidence_kind: 'behavior-surface',
      operations: [{ entry_point_id: 'orders', entry_point_type: 'http', action: 'View' }],
    }));

    expect(result).toEqual({ name: 'View', operations: ['View'], relationships: [] });
  });

  it('keeps authored candidate names while humanizing their operation evidence', () => {
    const result = projectCapabilityCatalogPromptEvidence(capability({
      name: 'Order Fulfillment',
      evidence_kind: undefined,
      evidence_examples: ['submit_order'],
    }));

    expect(result).toEqual({ name: 'Order Fulfillment', operations: ['Submit order'], relationships: [] });
  });

  it('projects verified graph relationships separately from operations', () => {
    const result = projectCapabilityCatalogPromptEvidence(capability({
      name: 'Rules',
      depends_on: [{
        from_capability: 'bulk-update', to_capability: 'rule-update', dependency_type: 'shares-data', strength: 'common',
        evidence: { shared_services: [], shared_nodes: [], shared_entities: ['Rule', 'Transaction', 'Category'] },
        description: 'Bulk transaction updates share rule and category data',
      }],
    }));
    expect(result.relationships).toEqual([
      'Bulk transaction updates share rule and category data. Shared subjects: Rule, Transaction, Category',
    ]);
    expect(result.operations).toEqual([]);
  });
});
