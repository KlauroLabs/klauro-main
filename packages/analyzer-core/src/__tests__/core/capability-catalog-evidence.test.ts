import {
  capabilityCatalogAiPhaseStatus,
  catalogCountBounds,
  catalogEntityCandidateGroups,
  catalogEvidenceCandidates,
  catalogMinimumCapabilityCount,
  catalogRelatedEntityIds,
  hasFirstPartyCorroboratedCatalogOperations,
} from '../../analyzer/core/capability-catalog-evidence';
import type { CASDataEntity, SystemCapability } from '../../types/cas.types';

function candidate(id: string, name: string, category: SystemCapability['category'], actions: string[]): SystemCapability {
  return {
    id,
    name,
    structural_label: `${name} Management`,
    description: `${name} behavior backed by observed operations.`,
    category,
    criticality: 'medium',
    criticality_factors: [],
    related_entities: [],
    related_domains: [],
    operations: actions.map((action, index) => ({
      entry_point_id: `${id}_${index}`,
      entry_point_type: 'internal' as const,
      action,
    })),
  } as SystemCapability;
}

function entity(id: string, name: string, kind: CASDataEntity['kind'], lifecycle = false): CASDataEntity {
  return {
    id,
    name,
    kind,
    lifecycle: {
      created_by: lifecycle ? [`${id}_create`] : [],
      read_by: [],
      updated_by: [],
      deleted_by: [],
    },
  };
}

describe('catalogEvidenceCandidates', () => {
  test('keeps internally executed product behavior corroborated by first-party concepts', () => {
    const selected = catalogEvidenceCandidates([
      candidate('product', 'Product', 'core', ['Coordinate', 'Generate']),
      candidate('cart', 'Cart', 'supporting', ['Read', 'Update']),
      candidate('cart-notification', 'Cart Notification', 'supporting', ['Read', 'Process']),
      candidate('placeholder', 'Placeholder', 'supporting', ['Coordinate', 'Coordinate', 'Coordinate']),
      candidate('widths', 'Widths', 'supporting', ['Read', 'Generate']),
    ], [], [], 'app', { concepts: ['product', 'cart', 'storefront'] });

    expect(selected.map(item => item.id)).toEqual(['product', 'cart']);
  });

  test('does not promote a single internal occurrence or uncorroborated implementation family', () => {
    const selected = catalogEvidenceCandidates([
      candidate('quantity', 'Quantity', 'core', ['Update']),
      candidate('renderer', 'Renderer', 'core', ['Generate', 'Generate']),
    ], [], [], 'app', { concepts: ['quantity', 'commerce'] });

    expect(selected).toEqual([]);
  });

  test('keeps cohesive presentation surfaces while excluding uncorroborated delivery commands', () => {
    const interfaceSurface = candidate('workspace-ui', 'Workspace review surface', 'core', ['View', 'Compare']);
    interfaceSurface.evidence_kind = 'behavior-surface';
    interfaceSurface.operations.forEach(operation => { operation.entry_point_type = 'page'; });
    interfaceSurface.criticality_factors = ["2 page entry points form one cohesive behavior family ('workspace')"];
    const delivery = candidate('delivery', 'Artifact delivery', 'supporting', ['Deploy', 'Verify']);
    delivery.operations.forEach(operation => { operation.entry_point_type = 'cli'; });

    expect(catalogEvidenceCandidates(
      [delivery],
      [interfaceSurface],
      [],
      'app',
      { productDocSummary: 'A platform for reviewing and understanding software workspaces.' },
    ).map(item => item.id)).toEqual(['workspace-ui']);
  });

  test('keeps a command surface when first-party text establishes it as the product', () => {
    const formatter = candidate('formatter', 'Format documents', 'core', ['Format', 'Write']);
    formatter.operations.forEach(operation => { operation.entry_point_type = 'cli'; });

    expect(catalogEvidenceCandidates(
      [formatter], [], [], 'app', { manifestDescription: 'A product to format documents through commands.' },
    ).map(item => item.id)).toEqual(['formatter']);
  });

  test('requires lifecycle evidence for internally operated domain shapes', () => {
    const parcel = candidate('parcel', 'Track parcels', 'core', ['Track']);
    parcel.related_entities = ['entity_parcel'];
    const inspection = candidate('inspection', 'Record inspections', 'supporting', ['Record']);
    inspection.related_entities = ['entity_inspection'];

    const selected = catalogEvidenceCandidates(
      [parcel, inspection],
      [],
      [
        entity('entity_parcel', 'Parcel', 'domain-shape'),
        entity('entity_inspection', 'Inspection', 'domain-shape', true),
      ],
      'app',
    );

    expect(selected.map(item => item.id)).toEqual(['inspection']);
  });

  test('does not turn request contracts, unperformed models, or unrelated internal shapes into product evidence', () => {
    const request = candidate('request', 'Submit transfer', 'core', ['Submit']);
    request.related_entities = ['entity_transfer_request'];
    const dormant = candidate('dormant', 'Track reservation', 'core', []);
    dormant.related_entities = ['entity_reservation'];
    const unrelated = candidate('unrelated', 'Run indexing', 'supporting', ['Index']);
    unrelated.related_entities = ['entity_parcel'];
    const internal = candidate('internal', 'Process parcels', 'internal', ['Process']);
    internal.related_entities = ['entity_parcel'];

    const selected = catalogEvidenceCandidates(
      [request, dormant, unrelated, internal],
      [],
      [
        entity('entity_transfer_request', 'TransferRequest', 'request-dto', true),
        entity('entity_reservation', 'Reservation', 'domain-shape', true),
        entity('entity_parcel', 'Parcel', 'domain-shape', true),
      ],
      'app',
    );

    expect(selected).toEqual([]);
  });
});

describe('catalogEntityCandidateGroups', () => {
  test('allows one authored capability to cover several related entity families', () => {
    expect(catalogCountBounds(37, 0, 37)).toEqual({ min: 6, max: 20 });
    expect(catalogMinimumCapabilityCount(37, 37)).toBe(6);
  });

  test('groups candidates sharing an entity while preserving unrelated product families', () => {
    const parcelRead = candidate('parcel-read', 'Review parcels', 'core', ['Read']);
    parcelRead.related_entities = ['entity_parcel'];
    const parcelWrite = candidate('parcel-write', 'Record parcels', 'core', ['Write']);
    parcelWrite.related_entities = ['entity_parcel'];
    const inspection = candidate('inspection', 'Record inspections', 'supporting', ['Write']);
    inspection.related_entities = ['entity_inspection'];

    expect(catalogEntityCandidateGroups([parcelRead, parcelWrite, inspection])).toEqual([
      ['inspection'],
      ['parcel-read', 'parcel-write'],
    ]);
  });

  test('excludes entity-free, external-only, and behavior-surface candidates', () => {
    const external = candidate('external', 'Call carrier', 'supporting', ['Call']);
    external.related_entities = ['entity_parcel'];
    external.operations[0].entry_point_type = 'external';
    const surface = candidate('surface', 'Parcel surface', 'supporting', ['Read']);
    surface.related_entities = ['entity_parcel'];
    surface.evidence_kind = 'behavior-surface';

    expect(catalogEntityCandidateGroups([external, surface])).toEqual([]);
  });
});

describe('catalogRelatedEntityIds', () => {
  test('preserves the authored entity family when structural evidence spans other entities', () => {
    expect(catalogRelatedEntityIds(
      ['entity_invoice'],
      new Set(['entity_invoice', 'entity_vehicle', 'entity_fuel_purchase']),
    )).toEqual(['entity_invoice']);
  });

  test('uses structural entity evidence when the authored catalog omits entity mapping', () => {
    expect(catalogRelatedEntityIds([], new Set(['entity_vehicle', 'entity_vehicle']))).toEqual(['entity_vehicle']);
  });
});

describe('hasFirstPartyCorroboratedCatalogOperations', () => {
  test('accepts cited operation evidence when first-party product text corroborates the authored outcome', () => {
    const structural = candidate('fabric-surface', 'Fabric collaboration', 'internal', ['Claim', 'Coordinate']);
    const authored = candidate('authored', 'Enable real-time collaboration through Fabric', 'core', ['Claim']);
    authored.criticality_factors = ['catalog-candidate:fabric-surface'];

    expect(hasFirstPartyCorroboratedCatalogOperations(
      authored,
      [structural],
      { productDocSummary: 'Fabric enables real-time collaboration when teams work on overlapping concepts.' },
    )).toBe(true);
  });

  test('rejects operation-only outcomes without both a valid citation and first-party corroboration', () => {
    const structural = candidate('fallback-route', 'Fallback route', 'supporting', ['Handle']);
    const authored = candidate('authored', 'Provide system fallback', 'supporting', ['Handle']);
    authored.criticality_factors = ['catalog-candidate:fallback-route'];

    expect(hasFirstPartyCorroboratedCatalogOperations(authored, [structural], {
      productDocSummary: 'A parcel tracking application for dispatch teams.',
    })).toBe(false);
    expect(hasFirstPartyCorroboratedCatalogOperations({
      ...authored,
      criticality_factors: [],
    }, [structural], {
      productDocSummary: 'The system provides fallback routing for resilient operations.',
    })).toBe(false);
  });
});

describe('capabilityCatalogAiPhaseStatus', () => {
  test('degrades the AI phase whenever required catalog evidence is not fully accepted', () => {
    expect(capabilityCatalogAiPhaseStatus({ evidence_families: 35, status: 'rejected' })).toBe('degraded');
    expect(capabilityCatalogAiPhaseStatus({ evidence_families: 35, status: 'partial' })).toBe('degraded');
    expect(capabilityCatalogAiPhaseStatus({ evidence_families: 35, status: 'accepted' })).toBe('complete');
    expect(capabilityCatalogAiPhaseStatus({ evidence_families: 0, status: 'unavailable' })).toBe('complete');
  });
});
