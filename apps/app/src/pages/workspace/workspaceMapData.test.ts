import { describe, it, expect } from 'vitest';
import { buildWorkspaceMapEdges, buildWorkspaceMapNodes, liveApplications } from './workspaceMapData';
import type { WorkspaceApplication, WorkspaceAnalysisResponse } from '../../api';

function app(id: string, overrides: Partial<WorkspaceApplication> = {}): WorkspaceApplication {
  return { id, codebase_id: `cb-${id}`, name: id, ...overrides };
}

type WorkspaceGraph = NonNullable<WorkspaceAnalysisResponse['analysis']>;

describe('liveApplications', () => {
  it('drops applications merged into a survivor', () => {
    const apps = [app('a'), app('b', { merged_into: 'a' })];
    expect(liveApplications(apps).map(a => a.id)).toEqual(['a']);
  });
});

describe('buildWorkspaceMapNodes', () => {
  const apps = [
    app('a', { kind: 'service', codebase_id: 'cb-a' }),
    app('b', { kind: 'worker', codebase_id: 'cb-b', ports: ['8080'] }),
  ];
  const codebases: WorkspaceGraph['codebases'] = [
    { id: 'cb-a', primary_domain: 'fintech' },
    { id: 'cb-b', primary_domain: 'infra' },
  ];

  it('structural perspective clusters by application kind', () => {
    const nodes = buildWorkspaceMapNodes(apps, codebases, 'structural');
    expect(nodes.map(n => n.cluster)).toEqual(['service', 'worker']);
  });

  it('domain perspective clusters by the owning codebase primary_domain', () => {
    const nodes = buildWorkspaceMapNodes(apps, codebases, 'domain');
    expect(nodes.map(n => n.cluster)).toEqual(['fintech', 'infra']);
  });

  it('exposure perspective clusters by presence of declared ports', () => {
    const nodes = buildWorkspaceMapNodes(apps, codebases, 'exposure');
    expect(nodes[0].cluster).toBe('Internal only');
    expect(nodes[1].cluster).toBe('Publicly reachable (has ports)');
  });

  it('excludes merged-into duplicates from the node set', () => {
    const withDup = [...apps, app('c', { merged_into: 'a' })];
    const nodes = buildWorkspaceMapNodes(withDup, codebases, 'structural');
    expect(nodes).toHaveLength(2);
  });
});

describe('buildWorkspaceMapEdges', () => {
  it('joins runtime_links to applications through runtime_components, preserving evidence', () => {
    const graph: WorkspaceGraph = {
      runtime_components: [
        { id: 'rc1', codebase_id: 'cb-a', application_id: 'a', name: 'A' },
        { id: 'rc2', codebase_id: 'cb-b', application_id: 'b', name: 'B' },
      ],
      runtime_links: [
        { id: 'l1', codebase_id: 'cb-a', source_component_id: 'rc1', target_component_id: 'rc2', kind: 'http', evidence: ['GET /x'] },
      ],
    };
    const edges = buildWorkspaceMapEdges(graph, new Set(['a', 'b']));
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: 'a', target: 'b', label: 'http', muted: false });
  });

  it('marks an edge muted when its runtime_link has no evidence', () => {
    const graph: WorkspaceGraph = {
      runtime_components: [
        { id: 'rc1', codebase_id: 'cb-a', application_id: 'a', name: 'A' },
        { id: 'rc2', codebase_id: 'cb-b', application_id: 'b', name: 'B' },
      ],
      runtime_links: [{ id: 'l1', codebase_id: 'cb-a', source_component_id: 'rc1', target_component_id: 'rc2' }],
    };
    const edges = buildWorkspaceMapEdges(graph, new Set(['a', 'b']));
    expect(edges[0].muted).toBe(true);
  });

  it('drops an edge whose endpoint application was filtered out (merged duplicate)', () => {
    const graph: WorkspaceGraph = {
      runtime_components: [
        { id: 'rc1', codebase_id: 'cb-a', application_id: 'a', name: 'A' },
        { id: 'rc2', codebase_id: 'cb-c', application_id: 'c', name: 'C' },
      ],
      runtime_links: [{ id: 'l1', codebase_id: 'cb-a', source_component_id: 'rc1', target_component_id: 'rc2' }],
    };
    expect(buildWorkspaceMapEdges(graph, new Set(['a']))).toHaveLength(0);
  });

  it('falls back to application_links when no runtime_link joins to a known application pair', () => {
    const graph: WorkspaceGraph = {
      application_links: [{ id: 'al1', kind: 'grpc', source_application_id: 'a', target_application_id: 'b', source_codebase_id: 'cb-a', target_codebase_id: 'cb-b' }],
    };
    const edges = buildWorkspaceMapEdges(graph, new Set(['a', 'b']));
    expect(edges).toEqual([{ id: 'a->b', source: 'a', target: 'b', label: 'grpc' }]);
  });
});
