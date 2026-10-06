export interface ConventionMatchReport {
  convention_kind: 'route' | 'entry_point' | 'entity' | 'di_binding' | 'role' | 'flow';
  convention_summary: string;
  matched_node_ids: string[];
  matched: boolean;
  reason?: string;
}
