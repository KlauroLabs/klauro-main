import { diffBehavior } from '../../analyzer/core/behavior-diff';
import {
  CASEntityLineage,
  CASOutput,
  CASUserJourney,
  SystemCapability,
} from '../../types/cas.types';

function journey(overrides: {
  id: string;
  name: string;
  method: string;
  path: string;
  written?: string[];
  read?: string[];
  boundaries?: Array<{ name: string; mechanism: string }>;
  tests?: string[];
}): CASUserJourney {
  return {
    id: overrides.id,
    name: overrides.name,
    journey_kind: 'user-facing',
    entry_point_id: `ep_${overrides.id}`,
    entry: {
      type: 'http',
      name: overrides.name,
      method: overrides.method,
      path_or_trigger: overrides.path,
      handler_node_id: `node_${overrides.id}`,
    },
    steps: [],
    terminal_effects: {
      entities_written: overrides.written || [],
      entities_read: overrides.read || [],
      external_services: [],
      messages_emitted: [],
    },
    terminal_entities: [
      ...(overrides.written || []).map(name => ({
        name,
        access: 'created' as const,
        terminal_kind: 'entity' as const,
      })),
      ...(overrides.read || []).map(name => ({
        name,
        access: 'read' as const,
        terminal_kind: 'entity' as const,
      })),
    ],
    security_boundaries: overrides.boundaries || [],
    tests_covering: overrides.tests || [],
    criticality: 'medium',
    call_chain_ids: [],
    exit_point_ids: [],
  };
}

function capability(overrides: {
  id: string;
  name: string;
  entities?: string[];
}): SystemCapability {
  return {
    id: overrides.id,
    name: overrides.name,
    description: '',
    category: 'core',
    operations: [],
    related_entities: overrides.entities || [],
    related_domains: [],
    criticality: 'medium',
    criticality_factors: [],
  };
}

function lineage(overrides: {
  entityId: string;
  entityName: string;
  sensitive?: boolean;
  writers?: Array<{ node_id: string; file?: string; via: string }>;
  recipients?: Array<{ exit_point_id: string; service: string }>;
  unguardedPaths?: number;
  externalTransfer?: boolean;
}): CASEntityLineage {
  return {
    entity_id: overrides.entityId,
    entity_name: overrides.entityName,
    sensitive_fields: overrides.sensitive ? ['secret'] : [],
    writers: overrides.writers || [],
    readers: [],
    external_recipients: overrides.recipients || [],
    boundaries_crossed: [],
    journeys_carrying: [],
    exposure: {
      unguarded_paths: overrides.unguardedPaths || 0,
      external_transfer: overrides.externalTransfer || false,
      sensitive: overrides.sensitive || false,
    },
  };
}

function cas(partial: Partial<CASOutput>): CASOutput {
  return { nodes: [], edges: [], ...partial } as CASOutput;
}

const authBoundary = { name: 'require_auth', mechanism: 'before_action' };

const guardedBase = [
  journey({
    id: 'journey_list',
    name: 'List invoices',
    method: 'GET',
    path: '/invoices',
    read: ['Invoice'],
    boundaries: [authBoundary],
    tests: ['spec/invoices_spec.rb'],
  }),
  journey({
    id: 'journey_create',
    name: 'Create invoice',
    method: 'POST',
    path: '/invoices',
    written: ['Invoice'],
    boundaries: [authBoundary],
    tests: ['spec/invoices_spec.rb'],
  }),
];

describe('diffBehavior', () => {
  it('flags an added journey writing an entity without any security boundary when guarding is the norm', () => {
    const before = cas({ user_journeys: guardedBase });
    const after = cas({
      user_journeys: [
        ...guardedBase,
        journey({
          id: 'journey_bulk',
          name: 'Bulk import invoices',
          method: 'POST',
          path: '/invoices/bulk_import',
          written: ['Invoice'],
        }),
      ],
    });

    const diff = diffBehavior(before, after);

    expect(diff.journeys.added).toHaveLength(1);
    expect(diff.journeys.added[0].name).toBe('Bulk import invoices');
    expect(diff.journeys.added[0].guarded).toBe(false);
    expect(diff.security.newly_unguarded_entries).toEqual([
      {
        journey_id: 'journey_bulk',
        name: 'Bulk import invoices',
        entry: 'http:POST /invoices/bulk_import',
        entities_written: ['Invoice'],
        reason: 'new-unguarded',
      },
    ]);
    expect(diff.summary.risk_flags[0]).toBe(
      "This change added a journey 'Bulk import invoices' that writes Invoice without crossing the auth boundary."
    );
  });

  it('detects a journey losing its auth boundary between analyses', () => {
    const before = cas({ user_journeys: guardedBase });
    const after = cas({
      user_journeys: [
        guardedBase[0],
        journey({
          id: 'journey_create_v2',
          name: 'Create invoice',
          method: 'POST',
          path: '/invoices',
          written: ['Invoice'],
          tests: ['spec/invoices_spec.rb'],
        }),
      ],
    });

    const diff = diffBehavior(before, after);

    expect(diff.journeys.added).toHaveLength(0);
    expect(diff.journeys.removed).toHaveLength(0);
    expect(diff.journeys.changed).toEqual([
      { id: 'journey_create_v2', name: 'Create invoice', what: ['lost auth boundary'] },
    ]);
    expect(diff.security.newly_unguarded_entries).toEqual([
      {
        journey_id: 'journey_create_v2',
        name: 'Create invoice',
        entry: 'http:POST /invoices',
        entities_written: ['Invoice'],
        reason: 'lost-guard',
      },
    ]);
    expect(diff.summary.risk_flags).toContain(
      "Journey 'Create invoice' lost its auth boundary while still writing Invoice."
    );
  });

  it('flags a new capability overlapping an existing one as possibly duplicated', () => {
    const before = cas({
      capabilities: [
        capability({ id: 'cap_invoicing', name: 'Invoice Billing', entities: ['Invoice', 'Customer'] }),
      ],
    });
    const after = cas({
      capabilities: [
        capability({ id: 'cap_invoicing', name: 'Invoice Billing', entities: ['Invoice', 'Customer'] }),
        capability({ id: 'cap_invoice_export', name: 'Invoice Export', entities: ['Invoice'] }),
      ],
    });

    const diff = diffBehavior(before, after);

    expect(diff.capabilities.added).toEqual([{ id: 'cap_invoice_export', name: 'Invoice Export' }]);
    expect(diff.capabilities.removed).toHaveLength(0);
    expect(diff.capabilities.possibly_duplicated).toEqual([
      {
        new_capability: 'Invoice Export',
        overlaps_with: 'Invoice Billing',
        shared_entities: ['Invoice'],
        shared_name_tokens: ['invoice'],
      },
    ]);
    expect(diff.summary.risk_flags).toContain(
      "New capability 'Invoice Export' possibly duplicates 'Invoice Billing' (shared entities: Invoice)."
    );
  });

  it('flags a sensitive entity gaining an external recipient', () => {
    const before = cas({
      data_lineage: [
        lineage({
          entityId: 'entity_payment',
          entityName: 'Payment',
          sensitive: true,
          writers: [{ node_id: 'n1', file: 'src/payments.ts', via: 'createPayment' }],
        }),
      ],
    });
    const after = cas({
      data_lineage: [
        lineage({
          entityId: 'entity_payment',
          entityName: 'Payment',
          sensitive: true,
          writers: [{ node_id: 'n1', file: 'src/payments.ts', via: 'createPayment' }],
          recipients: [{ exit_point_id: 'exit_stripe', service: 'stripe' }],
          externalTransfer: true,
        }),
      ],
    });

    const diff = diffBehavior(before, after);

    expect(diff.lineage.sensitive_exposure_changes).toEqual([
      { entity_name: 'Payment', change: "gained external recipient 'stripe'" },
    ]);
    expect(diff.summary.risk_flags).toContain(
      "Sensitive entity 'Payment' gained external recipient 'stripe'."
    );
  });

  it('returns an empty diff for identical analyses', () => {
    const build = () => cas({
      user_journeys: guardedBase.map(j => ({ ...j })),
      capabilities: [
        capability({ id: 'cap_invoicing', name: 'Invoice Billing', entities: ['Invoice'] }),
      ],
      data_lineage: [
        lineage({
          entityId: 'entity_invoice',
          entityName: 'Invoice',
          sensitive: true,
          writers: [{ node_id: 'n1', file: 'src/invoices.ts', via: 'createInvoice' }],
        }),
      ],
      paradigm_conformance: [
        {
          paradigm: 'guarded-http-entry-points',
          description: 'HTTP entry points cross a security boundary',
          adoption: { following_count: 2, comparable_count: 2, adoption_rate: 1, evidence_files: [] },
          deviations: [],
        },
      ],
    });

    const diff = diffBehavior(build(), build());

    expect(diff.journeys.added).toHaveLength(0);
    expect(diff.journeys.removed).toHaveLength(0);
    expect(diff.journeys.changed).toHaveLength(0);
    expect(diff.security.boundaries_added).toHaveLength(0);
    expect(diff.security.boundaries_removed).toHaveLength(0);
    expect(diff.security.newly_unguarded_entries).toHaveLength(0);
    expect(diff.capabilities.added).toHaveLength(0);
    expect(diff.capabilities.removed).toHaveLength(0);
    expect(diff.capabilities.possibly_duplicated).toHaveLength(0);
    expect(diff.lineage.entities_with_new_writers).toHaveLength(0);
    expect(diff.lineage.sensitive_exposure_changes).toHaveLength(0);
    expect(diff.paradigms.new_deviations).toHaveLength(0);
    expect(diff.paradigms.resolved_deviations).toHaveLength(0);
    expect(diff.summary.risk_flags).toHaveLength(0);
  });

  it('reports dropped tests and matches journeys despite changed ids', () => {
    const before = cas({ user_journeys: guardedBase });
    const after = cas({
      user_journeys: [
        journey({
          id: 'regenerated_id_1',
          name: 'List invoices',
          method: 'GET',
          path: '/invoices',
          read: ['Invoice'],
          boundaries: [authBoundary],
        }),
        { ...guardedBase[1] },
      ],
    });

    const diff = diffBehavior(before, after);

    expect(diff.journeys.added).toHaveLength(0);
    expect(diff.journeys.removed).toHaveLength(0);
    expect(diff.journeys.changed).toEqual([
      { id: 'regenerated_id_1', name: 'List invoices', what: ['tests dropped'] },
    ]);
    expect(diff.summary.risk_flags).toContain("Journey 'List invoices' lost test coverage.");
  });
});
