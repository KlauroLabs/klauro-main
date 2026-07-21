import { describe, it, expect } from 'vitest';
import {
  buildArchitectureDiagramEdges,
  buildArchitectureDiagramNodes,
  buildConceptDiagramEdges,
  buildConceptDiagramNodes,
  buildConceptGroups,
  conceptNodeId,
  promotedUnitIdForEvidence,
} from '@/app/Codebase/architectureDiagramData';
import type { DeployableEvidence } from '@/app/Deployable/dasTypes';
import type { RawCallEdge } from '@/shared/hooks/useArchitectureConcepts';

function evidence(overrides: Partial<DeployableEvidence>): DeployableEvidence {
  return { root_path: '.', name: 'svc', tier: 1, kind: 'container', evidence: ['Dockerfile'], ...overrides };
}

describe('buildArchitectureDiagramNodes', () => {
  it('structural perspective clusters by human-readable kind label', () => {
    const nodes = buildArchitectureDiagramNodes([evidence({ kind: 'container' }), evidence({ kind: 'package', name: 'lib' })], 'structural');
    expect(nodes.map(n => n.cluster)).toEqual(['Container (Dockerfile)', 'Package']);
  });

  it('exposure perspective clusters by declared ports', () => {
    const nodes = buildArchitectureDiagramNodes([evidence({ ports: [8080] }), evidence({ name: 'internal' })], 'exposure');
    expect(nodes[0].cluster).toBe('Publicly reachable (has ports)');
    expect(nodes[1].cluster).toBe('Internal only');
  });

  it('surfaces a bundled member\'s parent in its subtitle', () => {
    const nodes = buildArchitectureDiagramNodes([evidence({ name: 'client-service', bundled_into: 'client' })], 'structural');
    expect(nodes[0].subtitle).toBe('bundled into client');
  });

  it('returns no nodes for empty evidence', () => {
    expect(buildArchitectureDiagramNodes([], 'structural')).toEqual([]);
  });
});

describe('buildArchitectureDiagramEdges', () => {
  it('draws a bundled_into edge from member to parent', () => {
    const items = [evidence({ name: 'client' }), evidence({ name: 'client-service', bundled_into: 'client' })];
    const edges = buildArchitectureDiagramEdges(items);
    expect(edges).toHaveLength(1);
    expect(edges[0].label).toBe('bundled into');
  });

  it('produces no edges when nothing is bundled', () => {
    const items = [evidence({ name: 'a' }), evidence({ name: 'b' })];
    expect(buildArchitectureDiagramEdges(items)).toHaveLength(0);
  });

  it('drops a bundled_into edge whose named parent is not in the evidence set', () => {
    const items = [evidence({ name: 'orphan', bundled_into: 'nowhere' })];
    expect(buildArchitectureDiagramEdges(items)).toHaveLength(0);
  });
});

describe('buildConceptGroups', () => {
  it('drops zero-count categories and sorts by size descending', () => {
    const groups = buildConceptGroups({ services: ['s1', 's2'], controllers: ['c1'], view_models: [] });
    expect(groups.map(g => g.id)).toEqual(['services', 'controllers']);
    expect(groups[0].count).toBe(2);
    expect(groups[0].label).toBe('Services');
  });

  it('returns an empty array for missing or empty inventory', () => {
    expect(buildConceptGroups(undefined)).toEqual([]);
    expect(buildConceptGroups({})).toEqual([]);
  });

  it('title-cases an unlabeled category as a fallback', () => {
    const groups = buildConceptGroups({ some_future_category: ['u1'] });
    expect(groups[0].label).toBe('Some Future Category');
  });

  it('tail-aggregates past MAX_CONCEPT_GROUPS into an Other bucket', () => {
    const inventory: Record<string, string[]> = {};
    for (let i = 0; i < 25; i++) inventory[`cat_${i}`] = [`n${i}_a`, `n${i}_b`].slice(0, i % 2 === 0 ? 2 : 1);
    const groups = buildConceptGroups(inventory);
    expect(groups.length).toBe(20);
    expect(groups[groups.length - 1].id).toBe('other');
  });
});

describe('buildConceptDiagramNodes', () => {
  it('labels each node with its display name and count', () => {
    const groups = buildConceptGroups({ services: ['s1', 's2', 's3'] });
    const nodes = buildConceptDiagramNodes(groups);
    expect(nodes).toEqual([{ id: conceptNodeId('services'), label: 'Services (3)', weight: 3 }]);
  });
});

describe('buildConceptDiagramEdges', () => {
  it('aggregates call edges between two groups into one counted edge', () => {
    const groups = buildConceptGroups({ controllers: ['ctl_1'], services: ['svc_1', 'svc_2'] });
    const edges: RawCallEdge[] = [
      { source: 'ctl_1', target: 'svc_1', type: 'calls' },
      { source: 'ctl_1', target: 'svc_2', type: 'invokes' },
    ];
    const result = buildConceptDiagramEdges(groups, edges);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe(conceptNodeId('controllers'));
    expect(result[0].target).toBe(conceptNodeId('services'));
    expect(result[0].label).toBe('2 calls');
  });

  it('drops self-pairs and non-call edge types', () => {
    const groups = buildConceptGroups({ services: ['svc_1', 'svc_2'] });
    const edges: RawCallEdge[] = [
      { source: 'svc_1', target: 'svc_2', type: 'calls' }, // same group, self-pair
      { source: 'svc_1', target: 'svc_2', type: 'imports' }, // not a call-graph type
    ];
    expect(buildConceptDiagramEdges(groups, edges)).toHaveLength(0);
  });

  it('excludes the packages category as an edge endpoint', () => {
    const groups = buildConceptGroups({ packages: ['p1'], services: ['s1'] });
    const edges: RawCallEdge[] = [{ source: 's1', target: 'p1', type: 'calls' }];
    expect(buildConceptDiagramEdges(groups, edges)).toHaveLength(0);
  });

  it('drops edges whose endpoints are not in any group', () => {
    const groups = buildConceptGroups({ services: ['s1'] });
    const edges: RawCallEdge[] = [{ source: 's1', target: 'unknown', type: 'calls' }];
    expect(buildConceptDiagramEdges(groups, edges)).toHaveLength(0);
  });
});

describe('promotedUnitIdForEvidence', () => {
  it('resolves a das unit id only once two-or-more units qualify for promotion', () => {
    const items = [
      evidence({ name: 'api', root_path: 'services/api', tier: 1 }),
      evidence({ name: 'worker', root_path: 'services/worker', tier: 1 }),
    ];
    const idA = promotedUnitIdForEvidence(items, `container:api:0`);
    expect(idA).toMatch(/^das:/);
  });

  it('returns undefined for a single, non-promoted deployable', () => {
    const items = [evidence({ name: 'solo', root_path: '.' })];
    expect(promotedUnitIdForEvidence(items, 'container:solo:0')).toBeUndefined();
  });

  it('returns undefined for an unknown node id', () => {
    expect(promotedUnitIdForEvidence([], 'nope')).toBeUndefined();
  });
});
