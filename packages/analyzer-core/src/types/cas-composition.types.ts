export interface CASTerminalityEdge {
  source: string;
  target: string;
}

export interface CASTerminalityRelationEvidence {
  relation_id: string;
  source_id: string;
  target_id: string;
  evidence_ids: string[];
  confidence: number;
}

export interface CASComposedClaimProvenance {
  source_child_id: string;
  source_capability_id: string;
  source_node_ids: string[];
  source_flow_ids: string[];
  relation_path: CASTerminalityRelationEvidence[];
  confidence: number;
  abstention_reason?: string;
  disposition: 'promoted' | 'absorbed' | 'abstained';
}

export interface CASTerminalityProvenance {
  source_child_id: string;
  relation_path: CASTerminalityRelationEvidence[];
  supporting_source_ids: string[];
  confidence: number;
  abstention_reason?: 'isolated-child' | 'unresolved-relation-path';
}
