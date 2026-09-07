import { projectCapabilityCatalogPromptEvidence, capabilityCatalogStructuralApiLabels, capabilityCatalogValidationEvidence } from '../../analyzer/core/capability-catalog-prompt-evidence';
import { projectCapabilityCatalogPromptFacts } from '../../analyzer/core/capability-catalog-prompt-facts';
import { capabilityOperationEvidenceTexts } from '../../analyzer/core/capability-subject-evidence';
import { capabilityOutcomeNameUnsupportedTokens } from '../../analyzer/core/capability-catalog-evidence';
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
  it.each(['message', 'cli', 'http'] as const)('retains an authored %s entry contract without guessing from its name', entryType => {
    const raw = 'Reports workshop occupancy from maintenance reservations. It does not allocate staff or approve maintenance.';
    const node = { id: 'public_handler', name: 'lookup', documentation: { raw } } as CASNode;
    const entry: CASEntryPoint = { id: 'lookup_entry', source_node: node.id, type: entryType, name: 'lookup' };
    const value = capability({
      operations: [{ entry_point_id: entry.id, entry_point_type: entryType, action: 'Handle' }],
    });
    const nodes = new Map([[node.id, node]]);
    const entries = new Map([[entry.id, entry]]);
    const result = projectCapabilityCatalogPromptEvidence(value, nodes, entries);
    expect(result.operations).toEqual(['Lookup']);
    expect(result.declared_contracts).toEqual([{
      entry_point_id: entry.id, source_node_id: node.id, text: raw, example_blocks_omitted: 0,
    }]);
    expect(projectCapabilityCatalogPromptEvidence({ ...value, operation_evidence: [] }, nodes, entries).declared_contracts).toBeUndefined();
    expect(projectCapabilityCatalogPromptEvidence(value, new Map(), entries).declared_contracts).toBeUndefined();
    expect(projectCapabilityCatalogPromptEvidence(value, nodes, new Map()).declared_contracts).toBeUndefined();
    const validation = capabilityCatalogValidationEvidence(value, nodes, entries);
    expect(capabilityOperationEvidenceTexts(validation)).toEqual([raw]);
    expect(validation.operations).toBe(value.operations);
    expect(validation.name).toBe(value.name);
    expect(capabilityCatalogValidationEvidence(validation, nodes, entries)).toEqual(validation);
    const excluded = { ...value, operation_evidence: [] };
    expect(capabilityCatalogValidationEvidence(excluded, nodes, entries)).toBe(excluded);
    expect(value.operation_evidence).toBeUndefined();
    expect(node.documentation?.raw).toBe(raw);
  });

  it.each(['message', 'cli', 'http'] as const)('uses only retained source-linked %s contract evidence during validation', entryType => {
    const record = { entry_point_id: 'lookup', source_node_id: 'handler', text: 'Reports workshop occupancy without allocating staff.' };
    const value = capability({
      operations: [{ entry_point_id: 'lookup', entry_point_type: entryType, action: 'Handle' }],
      operation_evidence: [record, record,
        { entry_point_id: 'removed', source_node_id: 'handler', text: 'Approve maintenance.' },
        { entry_point_id: 'lookup', source_node_id: '', text: 'Allocate staff.' }],
      evidence_examples: ['Assign work automatically.'],
    });
    expect(capabilityOperationEvidenceTexts(value)).toEqual([record.text]);
    expect(capabilityOperationEvidenceTexts({ ...value, operation_evidence: [] })).toEqual([]);
    expect(value.operation_evidence).toHaveLength(4);
  });

  it.each(['api', 'message', 'cli', 'http'] as const)('keeps curated %s evidence authoritative in the outcome scope gate', entryType => {
    const value = capability({
      name: 'Lookup surface',
      operations: [{ entry_point_id: 'lookup', entry_point_type: entryType, action: 'Handle' }],
      operation_evidence: [{ entry_point_id: 'lookup', source_node_id: 'handler', text: 'Reports workshop occupancy.' }],
      evidence_examples: ['Pay employee salaries.'],
    });
    expect(capabilityOutcomeNameUnsupportedTokens('Inspect workshop occupancy', [value])).toEqual([]);
    expect(capabilityOutcomeNameUnsupportedTokens('Pay employee salaries', [value])).toEqual(['employee', 'salary']);
    expect(capabilityOutcomeNameUnsupportedTokens('Inspect workshop occupancy', [{ ...value, operation_evidence: [] }]))
      .toEqual(['workshop', 'occupancy']);
    expect(capabilityOutcomeNameUnsupportedTokens('Inspect workshop occupancy', [value, capability({ name: 'Other area' })])).toEqual([]);
    expect(value.evidence_examples).toEqual(['Pay employee salaries.']);
  });

  it('does not promote generated node descriptions or unlinked documentation to declared contracts', () => {
    const entry: CASEntryPoint = { id: 'lookup', source_node: 'handler', type: 'message', name: 'lookup' };
    const value = capability({
      operations: [{ entry_point_id: entry.id, entry_point_type: entry.type, action: 'Handle' }],
    });
    const nodes = new Map<string, CASNode>([
      ['handler', { id: 'handler', name: 'lookup', description: 'Automatically assign maintenance work.' } as CASNode],
      ['unrelated', { id: 'unrelated', name: 'assign', documentation: { raw: 'Assign work to mechanics.' } } as CASNode],
    ]);
    const entries = new Map([[entry.id, entry]]);
    expect(projectCapabilityCatalogPromptEvidence(value, nodes, entries).declared_contracts).toBeUndefined();
    expect(capabilityCatalogValidationEvidence(value, nodes, entries)).toBe(value);
    expect(value.operation_evidence).toBeUndefined();
  });

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
