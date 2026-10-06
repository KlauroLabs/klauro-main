import type { CASProductMap } from '../../../packages/analyzer-core/src/types/cas.types';
import type { SubCasNodeIndex } from './deployable-analysis';

export const SUMMARY_SUB_CAS_UNIT_LIMIT = 20;

export function compactSubCasNodes(index: SubCasNodeIndex) {
  const units = [...index.units]
    .sort((a, b) => b.node_count - a.node_count || a.id.localeCompare(b.id))
    .slice(0, SUMMARY_SUB_CAS_UNIT_LIMIT)
    .map(unit => ({
      id: unit.id,
      name: unit.name,
      root_path: unit.root_path,
      kind: unit.kind,
      tier: unit.tier,
      node_count: unit.node_count,
    }));
  return {
    promoted: index.promoted,
    qualified_unit_count: index.qualified_unit_count,
    units_total: index.units.length,
    units_shown: units.length,
    units,
    coverage_ratio: index.coverage_ratio,
    orphan_node_count: index.orphan_node_count,
    detail: 'Pass a unit id as scope.sub_cas_node_id to any scoped tool for that sub-project; get_semantic_map lists sub-projects with their relationships.',
  };
}

export function productMapOverview(map: CASProductMap) {
  return {
    capabilities: map.capabilities.length,
    entry_point_flows: {
      total: map.entry_point_flows.total,
      user_facing: map.entry_point_flows.user_facing,
      system: map.entry_point_flows.system,
      scheduled: map.entry_point_flows.scheduled,
    },
    journeys: {
      total: map.journeys.total,
      shown: map.journeys.shown,
    },
    entities: map.data.entities,
    paradigms: map.conventions.paradigms.length,
    open_deviations: map.conventions.open_deviations,
    health: {
      ...(map.health.status ? { status: map.health.status } : {}),
      ...(map.health.score !== undefined ? { score: map.health.score } : {}),
      tests_total: map.health.tests.total,
    },
    detail: 'get_product_map returns capabilities, entry-point flows, journeys, data, conventions, health and runtime topology; get_entry_point_flows, get_user_journeys and get_data_entities page the flows, journeys and entities.',
  };
}
