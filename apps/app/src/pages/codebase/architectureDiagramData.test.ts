import { describe, it, expect } from 'vitest';
import { buildArchitectureDiagramEdges, buildArchitectureDiagramNodes, promotedUnitIdForEvidence } from './architectureDiagramData';
import type { DeployableEvidence } from '../deployable/dasTypes';

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
