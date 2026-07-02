/**
 * Coordination fabric — pure data model (§4 of docs/SPEC-COORDINATION-FABRIC.md).
 *
 * This module is transport-free and IO-free: no reads from storage.ts, no HTTP,
 * no MCP wiring. Everything here is plain data + pure functions operating on
 * data passed in by a caller (see arbiter.ts / collision.ts / presence.ts).
 */

/** Kind of agent holding a claim or presence entry (WS-C). */
export type AgentKind = 'claude' | 'cursor' | 'codex' | 'human' | 'other';

/** Lifecycle status of a WorkClaim (WS-C). */
export type WorkClaimStatus = 'active' | 'released' | 'superseded' | 'expired';

/**
 * The unit of "announced intent" an agent registers before acting.
 * Last-writer-wins per `claim_id`, ordered by the monotonic `seq` (presence.ts).
 */
export interface WorkClaim {
  claim_id: string;
  seq: number;
  workspace_id: string;
  agent_id: string;
  agent_kind: AgentKind;
  scope: {
    repo: string;
    paths: string[];
    symbols: string[];
    capability?: string;
  };
  intent: string;
  status: WorkClaimStatus;
  created_at: string;
  ttl_ms: number;
  heartbeat_at: string;
  base_commit?: string;
  branch?: string;
  /** Organization scope (§WS-F tenancy). Optional/additive — see `TenantScoped` in security.ts. */
  org_id?: string;
}

/** A workspace's live agent roster (WS-C `presence.ts` / `get_active_agents`). */
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
  };
  base_commit?: string;
}

/** Compact summary of an agent's uncommitted working-tree state (WS-B, §4). */
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
  /** Organization scope (§WS-F tenancy). Optional/additive — see `TenantScoped` in security.ts. */
  org_id?: string;
}

/** A minimal CAS call/data edge, enough for blast-radius overlap (matches CASEdge shape). */
export interface CasEdgeRef {
  id: string;
  source: string;
  target: string;
  type: string;
}

/** A minimal WAS capability, enough for capability-name matching (matches WorkspaceCapability). */
export interface WasCapabilityRef {
  id: string;
  name: string;
  project_ids?: string[];
}

/** Verdict returned by `arbitrate()` (WS-C). */
export type ArbitrationVerdict = 'granted' | 'conflict' | 'duplicate';

/** Kind of overlap evidence backing a `conflict` verdict. */
export type ConflictKind = 'path' | 'symbol' | 'capability' | 'blast_radius';

export interface ArbitrationResult {
  verdict: ArbitrationVerdict;
  with_claim?: WorkClaim;
  kind?: ConflictKind;
  evidence?: string[];
}

/** One flagged duplicate-work finding (WS-D detector 1). */
export interface DuplicateFinding {
  claim_id: string;
  with_claim_id: string;
  capability?: string;
  evidence: string[];
}

/** One flagged edit-overlap finding (WS-D detector 2). */
export interface OverlapFinding {
  claim_id: string;
  with_claim_id: string;
  paths: string[];
  symbols: string[];
  evidence: string[];
}

/** One flagged in-flight contract-drift finding (WS-D detector 3). */
export interface DriftFinding {
  agent_id: string;
  with_agent_id: string;
  contracts: string[];
  evidence: string[];
}

/** One flagged cross-agent blast-radius finding (WS-D detector 4). */
export interface BlastIntersectionFinding {
  claim_id: string;
  with_claim_id: string;
  symbols: string[];
  evidence: string[];
}

/** Output of `detectCollisions()` (WS-D). */
export interface CollisionReport {
  duplicates: DuplicateFinding[];
  overlaps: OverlapFinding[];
  drifts: DriftFinding[];
  blast_intersections: BlastIntersectionFinding[];
}
