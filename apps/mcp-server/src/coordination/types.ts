







import type { SymbolChange } from './conceptual-conflict';


export type AgentKind = 'claude' | 'cursor' | 'codex' | 'human' | 'other';


export type WorkClaimStatus = 'active' | 'released' | 'superseded' | 'expired';



















export interface ConceptualCoordinate {

  capability_id?: string;

  flow_id?: string;

  step_id?: string;




  entities?: string[];




  source?: 'declared' | 'derived';
}






export type ContractKind = 'export' | 'signature' | 'endpoint' | 'type' | 'event' | 'schema';



















export interface DeclaredContract {
  kind: ContractKind;

  name: string;

  path?: string;

  signature?: string;

  notes?: string;







  status?: 'declared' | 'observed';
}





export interface WorkClaim {
  claim_id: string;
  seq: number;












  version?: number;
  operation_id?: string;
  workspace_id: string;
  agent_id: string;
  agent_kind: AgentKind;
  scope: {
    repo: string;
    paths: string[];
    symbols: string[];
    capability?: string;


    concept?: ConceptualCoordinate;
  };
  intent: string;
  status: WorkClaimStatus;
  created_at: string;
  ttl_ms: number;
  heartbeat_at: string;
  base_commit?: string;
  branch?: string;

  org_id?: string;








  produces?: DeclaredContract[];








  consumes?: string[];
}











export type DerivedPhase = 'exploring' | 'building' | 'verifying';


export interface AgentPresence {
  agent_id: string;
  agent_kind: AgentKind;
  workspace: string;
  last_seen: string;
  scope: {
    repo: string;
    paths: string[];
    symbols: string[];
    capability?: string;
    concept?: ConceptualCoordinate;
  };
  base_commit?: string;
}


export interface InFlightSnapshot {
  workspace: string;
  agent_id: string;
  base_commit: string;
  branch?: string;
  diff_context: string;
  touched: {
    entities: string[];
    routes: string[];
    contracts: string[];
    symbols: string[];
  };
  updated_at: string;

  org_id?: string;













  changes?: SymbolChange[];
}


export interface CasEdgeRef {
  id: string;
  source: string;
  target: string;
  type: string;
}


export interface WorkspaceCapabilityRef {
  id: string;
  name: string;
  project_ids?: string[];
}


export type ArbitrationVerdict = 'granted' | 'conflict' | 'duplicate';


export type ConflictKind = 'path' | 'symbol' | 'capability' | 'blast_radius';

export interface ArbitrationResult {
  verdict: ArbitrationVerdict;
  with_claim?: WorkClaim;
  kind?: ConflictKind;
  evidence?: string[];
}


export interface DuplicateFinding {
  claim_id: string;
  with_claim_id: string;
  capability?: string;
  evidence: string[];
}


export interface OverlapFinding {
  claim_id: string;
  with_claim_id: string;
  paths: string[];
  symbols: string[];
  evidence: string[];
}


export interface DriftFinding {
  agent_id: string;
  with_agent_id: string;
  contracts: string[];
  evidence: string[];
}


export interface BlastIntersectionFinding {
  claim_id: string;
  with_claim_id: string;
  symbols: string[];
  evidence: string[];
}


export interface CollisionReport {
  duplicates: DuplicateFinding[];
  overlaps: OverlapFinding[];
  drifts: DriftFinding[];
  blast_intersections: BlastIntersectionFinding[];
}











export type {
  MergePlan,
  AutoMergeableEntry,
  NeedsResolutionEntry,
  DuplicateWorkEntry,
  MergePlanSummary,
} from './intent-merge';
