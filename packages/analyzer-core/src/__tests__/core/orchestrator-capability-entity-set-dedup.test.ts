import { SystemCapability } from '../../types/cas.types';
import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';

// LIVE BUG (prj_wbW33m-wfETn1N41, Klauro self-analysis): two capability rows
// — "Manage multiple projects in a single workspace" and "Host and manage
// multiple codebases and projects" — carried the IDENTICAL related_entities
// set {Project, Workspace, Component, CallChain, Codebase} and fully
// overlapping operations, yet survived as two separate rows with
// suspiciously-repeated entity counts (the "5/2/2/5" echo a user reported).
//
// dedupeSystemCapabilitiesByEntitySet's three passes all missed this pair:
//  - Pass 1 requires the SAME purpose subject phrase too — "Host and manage"
//    isn't stripped by the leading-verb regex ('host' isn't in the verb
//    list), so the subject phrases differ even though the entity sets match.
//  - Pass 2 (pre-fix) only matched a STRICT subset (otherSet.size > set.size)
//    — two equal-size identical sets never qualified.
//  - Pass 3 requires the same PRIMARY (first) entity, which is
//    order-dependent on an array with no canonical ordering — "project" vs
//    "codebase" first depending on insertion order, despite identical sets.
//
// Private-method access, same pattern as
// orchestrator-entry-point-contract-capability.test.ts.
const orch = new AnalyzerOrchestrator() as any;

function capability(overrides: Partial<SystemCapability> & { id: string; name: string }): SystemCapability {
  return {
    description: '',
    description_source: 'deterministic',
    category: 'core',
    operations: [],
    related_entities: [],
    related_domains: [],
    criticality: 'high',
    criticality_factors: [],
    ...overrides,
  } as SystemCapability;
}

function op(entryPointId: string): SystemCapability['operations'][number] {
  return { entry_point_id: entryPointId, entry_point_type: 'mcp_tool', action: 'call' };
}

describe('orchestrator: dedupeSystemCapabilitiesByEntitySet — equal-size identical-entity-set near-dups', () => {
  it('merges two capabilities with an IDENTICAL entity set and fully-overlapping operations, even though their subject phrasing and primary-entity order differ', () => {
    const sharedOps = [op('entry_a'), op('entry_b'), op('entry_c')];
    const cap1 = capability({
      id: 'capability_manage_multiple_projects_in_a_single_workspace',
      name: 'Manage multiple projects in a single workspace',
      related_entities: ['entity_project', 'entity_workspace', 'entity_component', 'entity_callchain', 'entity_codebase'],
      operations: sharedOps,
    });
    const cap5 = capability({
      id: 'capability_host_and_manage_multiple_codebases_and_projects',
      name: 'Host and manage multiple codebases and projects',
      related_entities: ['entity_codebase', 'entity_project', 'entity_component', 'entity_callchain', 'entity_workspace'],
      operations: sharedOps,
    });

    const result: SystemCapability[] = orch.dedupeSystemCapabilitiesByEntitySet([cap1, cap5]);

    expect(result).toHaveLength(1);
    expect(result[0].related_entities.sort()).toEqual(
      ['entity_callchain', 'entity_codebase', 'entity_component', 'entity_project', 'entity_workspace'].sort()
    );
  });

  it('does NOT merge two capabilities with an identical entity set when both their subjects AND their operations genuinely differ (real distinguishing behavior, not a same-subject verb variant like create/delete which the existing pass-1 dedup already collapses by design)', () => {
    const capExport = capability({
      id: 'capability_export_task_backups',
      name: 'Export Task Backups',
      related_entities: ['entity_task'],
      operations: [op('entry_export')],
    });
    const capAnalyze = capability({
      id: 'capability_analyze_task_duration',
      name: 'Analyze Task Duration',
      related_entities: ['entity_task'],
      operations: [op('entry_analyze')],
    });

    const result: SystemCapability[] = orch.dedupeSystemCapabilitiesByEntitySet([capExport, capAnalyze]);

    expect(result).toHaveLength(2);
  });

  it('per-capability entity counts stay honest (not copied) for genuinely distinct capabilities that happen to share a count', () => {
    const capA = capability({
      id: 'capability_a',
      name: 'Analyze and detect patterns in codebases',
      related_entities: ['entity_callchain', 'entity_patterndetection'],
      operations: [op('entry_x')],
    });
    const capB = capability({
      id: 'capability_b',
      name: 'Provide secure and controlled access to resources',
      related_entities: ['entity_workspaceaccess', 'entity_user'],
      operations: [op('entry_y')],
    });

    const result: SystemCapability[] = orch.dedupeSystemCapabilitiesByEntitySet([capA, capB]);

    expect(result).toHaveLength(2);
    const byId = new Map(result.map(c => [c.id, c]));
    expect(byId.get('capability_a')!.related_entities).toEqual(['entity_callchain', 'entity_patterndetection']);
    expect(byId.get('capability_b')!.related_entities).toEqual(['entity_workspaceaccess', 'entity_user']);
  });

  it('merges synonymous organization outcomes while preserving their complete evidence and authored binding', () => {
    const categorized = capability({
      id: 'capability_categorize_applications',
      name: 'Categorize job applications',
      related_entities: ['entity_category'],
      operations: [op('category-read')],
      criticality_factors: ['catalog-candidate:cap_category_management'],
    });
    const organized = capability({
      id: 'capability_organize_applications',
      name: 'Organize job applications by category',
      related_entities: ['entity_category'],
      operations: [op('category-write')],
      criticality_factors: ['catalog-outcome-requirement:all:category-create'],
    });
    const tracked = capability({
      id: 'capability_track_applications',
      name: 'Track job applications by category',
      related_entities: ['entity_category'],
      operations: [op('category-filter')],
    });

    const result: SystemCapability[] = orch.dedupeSystemCapabilitiesByEntitySet([categorized, organized, tracked]);

    expect(result).toHaveLength(1);
    expect(result[0].operations.map(operation => operation.entry_point_id).sort()).toEqual([
      'category-filter', 'category-read', 'category-write',
    ]);
    expect(result[0].criticality_factors).toContain('catalog-outcome-requirement:all:category-create');
  });

  it('preserves distinct product outcomes when their operation sets overlap', () => {
    const sharedOperations = [op('get_context'), op('inspect_graph')];
    const graph = capability({
      id: 'capability_build_graph',
      name: 'Build a trustworthy relationship graph',
      operations: sharedOperations,
    });
    const comprehension = capability({
      id: 'capability_comprehension',
      name: 'Provide behavior-level comprehension',
      operations: [sharedOperations[0]],
    });

    const result: SystemCapability[] = orch.dedupeSystemCapabilitiesByEntitySet([graph, comprehension]);

    expect(result.map(item => item.id)).toEqual([
      'capability_build_graph',
      'capability_comprehension',
    ]);
  });
});
