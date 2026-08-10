import type { CASOutput, ChangeReport } from '../../../packages/analyzer-core/src/types/cas.types';
import type { BranchDiffContext, RemoteFileChange, SourceManifest, SourceSnapshot, WorkingTreeChangeContext } from './remote-source';
import type { ProposedFileInput } from './proposal-preview';

export const REMOTE_ANALYSIS_PROTOCOL_VERSION = 2 as const;

/**
 * The 426 remediation text. It MUST only name commands the SHIPPED CLI
 * actually implements — the 2026-07-27 audit found this message telling every
 * protocol-1 client to "run klauro update" when no released CLI had an
 * `update` command at all (it printed usage and exited 0), so the only escape
 * was a hand-rolled `npm i -g` of the tarball. `update` exists now
 * (self-update.ts, wired into installed-cli.ts), and the reinstall one-liner is
 * spelled out as the fallback for clients too old to have even that.
 *
 * Kept next to the protocol constant, and covered by
 * installed-cli-update-command.test.ts, so the pair can never drift again.
 */
export function clientUpgradeRequiredMessage(
  requiredVersion: number = REMOTE_ANALYSIS_PROTOCOL_VERSION,
  installOneLiner = 'curl -fsSL https://mcp.klauro.com/install.sh | sh',
): string {
  return `This Klauro server requires analysis protocol ${requiredVersion}. ` +
    `Run \`klauro update\` and restart the MCP client. ` +
    `If your klauro is too old to have an update command (before 1.0.128) or the update fails, reinstall: ${installOneLiner}`;
}

export interface RemoteAnalyzeRequest {
  protocol_version: typeof REMOTE_ANALYSIS_PROTOCOL_VERSION;
  project_id?: string;
  organization_id?: string;
  project_path?: string;
  snapshot: SourceSnapshot;
  /** Progressive-disclosure mode (the default client behavior): the server
   *  accepts the snapshot and responds in seconds with `status:'accepted'`;
   *  the analysis runs entirely server-side in the background, attaching to
   *  the account project and refreshing the workspace analysis as it lands.
   *  Completion is observed through the status and explicit export endpoints;
   *  uploads never hold the request open for a full CAS response. */
  async?: boolean;
  /**
   * `klauro analyze --force` (task #132). When true, the server MUST bypass
   * BOTH: (1) the snapshot/analyzer-identity reuse gate — normally an
   * unchanged snapshot+analyzer short-circuits to `reused: true` with no new
   * work — and (2) the AI response cache, so re-run capability
   * names/descriptions are freshly generated, not served from a cached
   * entry keyed on scrubbed (path/timestamp-independent) content. Before
   * this field existed, `--force` was parsed by the CLI and documented in
   * its help text but never read anywhere, so it silently did nothing —
   * every `--force` re-run still came back `reused: true`.
   */
  force?: boolean;
}

/** Immediate response to an `async: true` analyze push — the snapshot was
 *  accepted and the analysis is running server-side. */
export interface RemoteAnalyzeAcceptedResponse {
  status: 'accepted';
  protocol_version: typeof REMOTE_ANALYSIS_PROTOCOL_VERSION;
  analysis_id: string;
  base_commit?: string;
  manifest: SourceManifest;
  /** The exact committed snapshot is already analyzed or currently in flight. */
  reused?: boolean;
  /** 'unchanged' = stored analysis served as-is. 'analyzer_upgrade' = the
   *  snapshot was unchanged but the analyzer that produced the stored analysis
   *  is not this one, so it is being re-analyzed. 'forced' = the client passed
   *  `--force`; the snapshot may well be unchanged but the reuse gate (and
   *  the AI response cache) were bypassed deliberately. */
  analysis_type?: 'unchanged' | 'analyzer_upgrade' | 'forced';
  /**
   * WHY this request was (or was not) served from the stored analysis. Always
   * present. `reused: true` with no reason is how "customers never receive
   * fixes" stayed invisible: the reuse gate deduped on the source snapshot
   * alone, and a new analyzer build silently returned the old analysis.
   */
  reuse_decision?: {
    reused: boolean;
    reason: string;
    source: 'unchanged' | 'analyzer_upgrade' | 'source_changed' | 'forced';
    /** Which identity tier decided it — see analyzer-identity-reuse.ts. */
    analyzer_identity_tier: 'parser' | 'derived' | 'build' | 'legacy-build' | 'match' | 'unknown' | 'in-flight';
    analyzer_build?: string;
    /** Present (and true) only on `source: 'forced'`: the AI response cache
     *  was ALSO bypassed for this run, not just the snapshot reuse gate —
     *  see CASOutput.ai_cache_reuse for the resulting per-run hit/miss delta. */
    ai_cache_bypassed?: boolean;
  };
}

export interface RemoteSyncRequest {
  protocol_version: typeof REMOTE_ANALYSIS_PROTOCOL_VERSION;
  analysis_id: string;
  project_id?: string;
  organization_id?: string;
  project_path?: string;
  changes: WorkingTreeChangeContext | {
    project_name: string;
    base_commit?: string;
    git_diff?: string;
    changed_files: RemoteFileChange[];
    manifest?: SourceManifest;
  };
  /** Customer clients submit changes and return after durable acceptance. */
  async?: boolean;
}

export interface RemoteAnalyzeDiffRequest {
  project_id?: string;
  organization_id?: string;
  project_path?: string;
  diff_context: BranchDiffContext;
}

export interface RemoteAnalyzeResponse {
  status: 'success';
  analysis_id: string;
  analysis_revision: number;
  analysis_type: 'full' | 'incremental';
  base_commit?: string;
  manifest: SourceManifest;
  cas: CASOutput;
  change_report?: ChangeReport;
}

export interface RemoteProjectRevision {
  analysis_id: string;
  analysis_revision: number;
  branch?: string;
  commit?: string;
  source: 'local_commit_submission' | 'git_provider' | 'manual';
  generated_at: string;
  files: number;
  bytes: number;
  snapshot_digest?: string;
  nodes: number;
  edges: number;
}

export interface RemoteProjectRevisionsResponse {
  status: 'success';
  analysis_id: string;
  revisions: RemoteProjectRevision[];
}

/**
 * A single reverse-chronological entry in GET /api/account/activity and
 * GET /api/workspaces/{id}/activity ("Change Activity" panel in the Home +
 * Workspace Figma frames). Every event is derived from data ALREADY
 * persisted for other reasons (project revisions, reanalyze attempt
 * sidecars, the server-side workspace-level-CAS record) — there is no separate activity-log
 * writer, so this type is deliberately a thin projection, not a new store.
 */
export interface AccountActivityEvent {
  type:
    | 'analysis_completed'
    | 'analysis_failed'
    | 'workspace_rebuilt'
    | 'workspace_enrichment_degraded'
    | 'workspace_rebuild_failed'
    | 'project_created'
    | 'project_moved';
  /** ISO timestamp this event happened at — the sort key for the feed. */
  at: string;
  workspace_id?: string;
  project_id?: string;
  title: string;
  detail?: string;
  /** Node/edge count change vs. the previous stored revision, when one exists to diff against. */
  deltas?: { nodes: number; edges: number };
  duration_ms?: number;
}

export interface AccountActivityResponse {
  events: AccountActivityEvent[];
  next_cursor: null;
}

export interface RemoteProposalPreviewRequest {
  project_id?: string;
  organization_id?: string;
  codebase_id?: string;
  project_path?: string;
  title?: string;
  plan_text: string;
  diff_text?: string;
  proposed_files?: ProposedFileInput[];
  preview_base_url?: string;
  snapshot?: SourceSnapshot;
}

export interface RemoteGreenfieldPreviewRequest {
  project_id?: string;
  organization_id?: string;
  title?: string;
  plan_text: string;
  proposed_files: ProposedFileInput[];
  preview_base_url?: string;
}

export interface RemoteErrorResponse {
  status: 'error';
  error: string;
}

export type RemoteAnalyzerResponse = RemoteAnalyzeResponse | RemoteAnalyzeAcceptedResponse | RemoteProjectRevisionsResponse | RemoteErrorResponse;
