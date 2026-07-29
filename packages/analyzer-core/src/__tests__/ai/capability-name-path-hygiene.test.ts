/**
 * REGRESSION GATE — a capability whose name could not be AI-generated must
 * never ship filesystem text as a product capability.
 *
 * Measured live on the deployed build (2026-07-28): an analysis shipped
 * `status: ready` with 228 capabilities carrying
 * `name_generation: { status: 'ai_skipped', reason: 'awaiting-ai-comprehension' }`
 * whose names were filename-derived — a file extension rendered as an English
 * word ("Manage Nat R" from `nat.rs`, "… Sh", "… Nix"; 39 names in total) and,
 * twice, the SERVER'S OWN STORAGE PATH humanized into a capability name. The
 * same repo, when the comprehension pass succeeded, produced 13 coherent
 * capabilities and zero path fragments.
 *
 * Red here means a customer is about to be shown internal infrastructure
 * geography, or a file type, as a product capability.
 */

import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import {
  isPathDerivedCapabilityName,
  namingSubjectFromPath,
  stripSourceFileExtension,
} from '../../analyzer/core/capability-naming';
import { SystemCapability, CASDataEntity } from '../../types/cas.types';

const orch = new AnalyzerOrchestrator() as any;

// A storage-root-shaped absolute path of the shape the hosted analyzer stores
// analyzed source under. Assembled from parts so the constant itself is not a
// literal server path.
const STORAGE_ROOT = ['', 'data', 'workspaces', 'prj_A1b2C3d4E5', 'bin'].join('/');

function capability(partial: Partial<SystemCapability>): SystemCapability {
  return {
    id: partial.id || 'cap_1',
    name: partial.name || 'X',
    description: partial.description || 'd',
    category: 'core',
    criticality: 'medium',
    operations: [],
    related_entities: [],
    related_domains: [],
    ...partial,
  } as SystemCapability;
}

describe('path hygiene vocabulary', () => {
  it('strips only recognized source-file extensions', () => {
    expect(stripSourceFileExtension('nat.rs')).toBe('nat');
    expect(stripSourceFileExtension('deploy.sh')).toBe('deploy');
    expect(stripSourceFileExtension('flake.nix')).toBe('flake');
    expect(stripSourceFileExtension('App.tsx')).toBe('App');
    // Not an extension — a dotted domain noun survives intact.
    expect(stripSourceFileExtension('v1.orders')).toBe('v1.orders');
  });

  it('reduces any path to its basename, so no directory can reach a name', () => {
    expect(namingSubjectFromPath(`${STORAGE_ROOT}/sample-service-host/web/App.tsx`)).toBe('App');
    expect(namingSubjectFromPath('src\\services\\nat.rs')).toBe('nat');
    expect(namingSubjectFromPath('Invoice')).toBe('Invoice');
  });

  it('flags a trailing file-type marker, storage geography and opaque ids', () => {
    expect(isPathDerivedCapabilityName('Manage Nat R')).toBe(true);
    expect(isPathDerivedCapabilityName('Manage Store Sh')).toBe(true);
    expect(isPathDerivedCapabilityName('Manage Linux Nix')).toBe(true);
    expect(isPathDerivedCapabilityName('Workspaces Prj A1b2C3 Sample Service Host Web Tsx')).toBe(true);
    expect(isPathDerivedCapabilityName('Manage Prj A1b2C3d4E5 Uploads')).toBe(true);
  });

  it('never flags legitimate product vocabulary that merely resembles a path word', () => {
    for (const name of [
      'Manage Project Members',
      'Manage Data Exports',
      'Render HTML Invoices',
      'Generate SQL Reports',
      'Manage Go Workers',
      'Export JSON Payloads',
      'Manage Build Pipelines',
      'View Cache Statistics',
      'Manage Datasets',
      'Manage Service Bindings',
      // Found by a live scan of 966 stored analyses: these are REAL shipped
      // capabilities that an over-broad storage vocabulary flagged on
      // `user`+`data` adjacency. Product English wins whenever a word is
      // genuinely both a directory name and a domain noun.
      'Secure user data',
      'Surfaces user data',
      'Manage Project Analysis Storage',
      'View Build Cache Index',
    ]) {
      expect([name, isPathDerivedCapabilityName(name)]).toEqual([name, false]);
    }
  });
});

describe('operation subject derivation never yields a file extension', () => {
  it('drops the extension before the plural strip (the "Manage Nat R" defect)', () => {
    expect(orch.fallbackRouteResourceSubject('src/nat.rs')).toBe('nat');
    expect(orch.fallbackRouteResourceSubject('scripts/store.sh')).toBe('store');
    expect(orch.fallbackRouteResourceSubject('infra/gateway.nix')).toBe('gateway');
  });

  it('refuses filesystem geography as a resource subject', () => {
    const subject = orch.fallbackRouteResourceSubject(`${STORAGE_ROOT}/web/App.tsx`);
    expect(subject).toBe('App');
  });

  it('still resolves a real route resource', () => {
    expect(orch.fallbackRouteResourceSubject('/api/v1/invoices/:id')).toBe('invoice');
  });
});

describe('domain tokenization is path-free', () => {
  it('never tokenizes the analysis root out of an absolute source path', () => {
    const tokens: string[] = orch.domainTokensFromText(
      `${STORAGE_ROOT}/sample-service-host/web/DeviceRegistry.tsx`
    );
    expect(tokens).not.toContain('workspaces');
    expect(tokens).not.toContain('prj');
    expect(tokens).not.toContain('tsx');
    expect(tokens).toContain('device');
  });
});

describe('finalizeSystemCapabilityNames — path-derived guard', () => {
  it('never ships a filename-derived name; rebuilds it from entity evidence', () => {
    const entities: CASDataEntity[] = [
      { id: 'ent_1', name: 'NatRule', kind: 'persisted-entity', fields: [], lifecycle: { created_by: [], read_by: ['n1'], updated_by: [], deleted_by: [] } } as any,
    ];
    const capabilities = [capability({
      id: 'cap_nat',
      name: 'Manage Nat R',
      structural_label: 'Manage Nat R',
      related_entities: ['ent_1'],
      operations: [{ entry_point_id: 'node:n1', entry_point_type: 'internal', action: 'Create', path_or_command: 'src/nat.rs' }] as any,
    })];
    const purpose: any = {};

    orch.finalizeSystemCapabilityNames(capabilities, entities, purpose);

    expect(capabilities).toHaveLength(1);
    expect(isPathDerivedCapabilityName(capabilities[0].name)).toBe(false);
    expect(capabilities[0].name).toBe('Manage Nat Rule');
    expect(purpose.capability_name_degradations).toEqual([
      expect.objectContaining({ rejected_name: 'Manage Nat R', disposition: 'rebuilt-from-evidence' }),
    ]);
  });

  it('drops a storage-path capability outright rather than leaking the analysis root', () => {
    const capabilities = [capability({
      id: 'cap_leak',
      name: 'Workspaces Prj A1b2C3 Sample Service Host Web Tsx',
      structural_label: 'Workspaces Prj A1b2C3 Sample Service Host Web Tsx',
    })];
    const purpose: any = {};

    orch.finalizeSystemCapabilityNames(capabilities, [], purpose);

    expect(capabilities).toHaveLength(0);
    expect(purpose.capability_name_degradations).toEqual([
      expect.objectContaining({ disposition: 'dropped', reason: 'name-derived-from-source-path' }),
    ]);
  });

  it('leaves an AI-authored name untouched even if it contains a path-ish word', () => {
    const capabilities = [capability({
      id: 'cap_ai',
      name: 'Manage Project Data Exports',
      name_source: 'ai',
    })];
    orch.finalizeSystemCapabilityNames(capabilities, [], {} as any);
    expect(capabilities.map(item => item.name)).toEqual(['Manage Project Data Exports']);
  });

  it('reports naming coverage so an un-enriched catalog cannot pass as a result', () => {
    const capabilities = [
      capability({ id: 'c1', name: 'Manage Invoices', operations: [{ entry_point_id: 'node:a', entry_point_type: 'internal', action: 'Create' }] as any }),
      capability({ id: 'c2', name: 'Manage Payments', operations: [{ entry_point_id: 'node:b', entry_point_type: 'internal', action: 'Create' }] as any }),
    ];
    const purpose: any = {};
    orch.finalizeSystemCapabilityNames(capabilities, [], purpose);
    expect(purpose.capability_naming_coverage).toEqual({
      total: 2,
      authored: 0,
      un_enriched: 2,
      path_derived_rejected: 0,
    });
  });
});
