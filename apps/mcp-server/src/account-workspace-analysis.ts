import * as fs from 'fs-extra';
import * as path from 'node:path';
import { getAnalysis } from './analyzer';
import { buildCrossCodebaseSystemGraph, type CrossCodebaseInput, type CrossCodebaseSystemGraph } from './cross-codebase-analysis';
import type { AccountStore } from './account-store';

/**
 * Server-side auto-refreshed Workspace Analysis (WAS) for an account
 * workspace. This is the account-API sibling of the local CLI's
 * `run_workspace_analysis` MCP tool: instead of an agent supplying local repo
 * paths, membership is the account workspace's OWN project records (never a
 * local folder scan — see the sibling agent-isolation finding that local
 * gauntlet artifacts must never leak into this store), and the member CAS
 * analyses are whatever the account API already has stored per project after
 * `/v1/analyze` / `/api/projects/:id/reanalyze` pushes.
 *
 * Design:
 *  - Every landed project analysis marks its workspace "dirty" and schedules
 *    a debounced rebuild (default 3s quiet period) so a batch of N project
 *    pushes in quick succession (e.g. a `klauro analyze` sweep across a
 *    multi-repo workspace) collapses into ONE rebuild, not N.
 *  - The rebuild itself runs asynchronously and NEVER blocks or fails the
 *    calling analyze/reanalyze HTTP response — failures are logged and the
 *    dirty flag is left set so the next landed analysis (or a manual
 *    read-triggered rebuild) retries.
 *  - GET reads are honest: if a rebuild has never completed for a workspace,
 *    the endpoint reports {status:'none'}; if a rebuild is currently in
 *    flight (or was scheduled but hasn't fired), it reports
 *    {status:'pending'} rather than serving nothing or blocking.
 */

const DEFAULT_DEBOUNCE_MS = 3000;

interface WorkspaceAnalysisRecord {
  workspace_id: string;
  workspace_name: string;
  generated_at: string;
  member_project_ids: string[];
  member_project_names: string[];
  graph: CrossCodebaseSystemGraph;
}

interface PendingRebuild {
  timer: NodeJS.Timeout;
  scheduledAt: string;
}

export class AccountWorkspaceAnalysisScheduler {
  private readonly storeDir: string;
  private readonly debounceMs: number;
  private readonly dirty = new Set<string>();
  private readonly pending = new Map<string, PendingRebuild>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly dataDir: string,
    private readonly accounts: AccountStore,
    options: { debounceMs?: number } = {},
  ) {
    this.storeDir = path.join(dataDir, 'workspace-analyses');
    this.debounceMs = options.debounceMs ?? resolveDebounceMs();
  }

  /**
   * Call this whenever a project analysis lands (POST /v1/analyze or
   * POST /api/projects/:id/reanalyze). Marks the owning workspace dirty and
   * (re)schedules a single debounced rebuild — repeated calls within the
   * debounce window coalesce into the same timer, so a 5-repo batch push
   * yields ~1 rebuild.
   */
  notifyProjectAnalysisLanded(workspaceId: string): void {
    if (!workspaceId) return;
    this.dirty.add(workspaceId);
    const existing = this.pending.get(workspaceId);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.pending.delete(workspaceId);
      this.rebuild(workspaceId).catch(error => {
        // Never let a rebuild failure escape as an unhandled rejection or
        // affect the analyze/reanalyze response — it already returned.
        // eslint-disable-next-line no-console
        console.error(`[Klauro] workspace analysis auto-rebuild failed for ${workspaceId}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, this.debounceMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.pending.set(workspaceId, { timer, scheduledAt: new Date().toISOString() });
  }

  /** True while a rebuild is scheduled (debounce window) or actively running. */
  isPending(workspaceId: string): boolean {
    return this.pending.has(workspaceId) || this.inFlight.has(workspaceId) || this.dirty.has(workspaceId);
  }

  /** Load the last-persisted workspace analysis for `workspaceId`, or null if none has ever been built. */
  async load(workspaceId: string): Promise<WorkspaceAnalysisRecord | null> {
    const file = this.recordPath(workspaceId);
    if (!(await fs.pathExists(file))) return null;
    try {
      return await fs.readJson(file);
    } catch {
      return null;
    }
  }

  /**
   * Rebuild now, from the STORED member analyses only (evidence-gated:
   * membership = accounts.listProjects(workspaceId) records, never a local
   * folder scan). Skips projects that have no analysis_id yet, or whose
   * stored CAS can't be loaded (deleted/corrupt workspace) — those are
   * evidence-absent and simply excluded, never treated as empty members.
   * Coalesces concurrent calls for the same workspace into one in-flight run.
   */
  async rebuild(workspaceId: string): Promise<WorkspaceAnalysisRecord | null> {
    const existingRun = this.inFlight.get(workspaceId);
    if (existingRun) {
      await existingRun;
      return this.load(workspaceId);
    }
    this.dirty.delete(workspaceId);
    const run = this.doRebuild(workspaceId);
    this.inFlight.set(workspaceId, run);
    try {
      await run;
    } finally {
      this.inFlight.delete(workspaceId);
    }
    return this.load(workspaceId);
  }

  private async doRebuild(workspaceId: string): Promise<void> {
    const workspace = await this.accounts.getWorkspaceById(workspaceId);
    const projects = await this.accounts.listProjectsForWorkspace(workspaceId);
    const inputs: CrossCodebaseInput[] = [];
    const memberIds: string[] = [];
    const memberNames: string[] = [];
    for (const project of projects) {
      if (!project.analysis_id) continue; // evidence-gated: no analysis yet, exclude
      try {
        const cas = await getAnalysis(this.workspacePathFor(project.analysis_id));
        inputs.push({ path: `account-project:${project.id}`, name: project.name, cas });
        memberIds.push(project.id);
        memberNames.push(project.name);
      } catch {
        // Stored analysis missing/corrupt — exclude rather than fail the
        // whole workspace rebuild for the other members.
      }
    }

    if (inputs.length === 0) {
      // Nothing to build from yet — do not write a stale/empty record over
      // a previously-good one; leave the store as "none" or as-is.
      return;
    }

    const name = workspace?.name || workspaceId;
    const graph = buildCrossCodebaseSystemGraph(name, inputs, { id: workspaceId });
    const record: WorkspaceAnalysisRecord = {
      workspace_id: workspaceId,
      workspace_name: name,
      generated_at: graph.generated_at,
      member_project_ids: memberIds,
      member_project_names: memberNames,
      graph,
    };
    await fs.ensureDir(this.storeDir);
    await fs.writeJson(this.recordPath(workspaceId), record, { spaces: 2 });
  }

  private workspacePathFor(analysisId: string): string {
    return path.join(this.dataDir, 'workspaces', analysisId.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 120));
  }

  private recordPath(workspaceId: string): string {
    return path.join(this.storeDir, `${safeId(workspaceId)}.json`);
  }
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 120);
}

function resolveDebounceMs(): number {
  const raw = process.env.KLAURO_WORKSPACE_ANALYSIS_DEBOUNCE_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DEBOUNCE_MS;
}

export type { WorkspaceAnalysisRecord };
