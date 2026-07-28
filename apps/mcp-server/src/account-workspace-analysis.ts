import * as fs from 'fs-extra';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { getAnalysis } from './analyzer';
import { writeJsonAtomic } from './storage';
import { buildCrossCodebaseSystemGraph, enrichWorkspaceAnalysisNarrative, workspaceAiEnrichmentEnabled, type CrossCodebaseInput, type CrossCodebaseSystemGraph } from './cross-codebase-analysis';
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

/**
 * Terminal-honest AI narrative enrichment state for a persisted WAS record.
 * 'pending' only ever appears in the FIRST (deterministic) persist of a
 * rebuild — every rebuild ends by re-persisting with a terminal status
 * ('ai' | 'degraded' | 'skipped' | 'error'), so a record can never look
 * silently degraded-forever: either the narrative is AI-written ('ai'), or
 * the record says exactly why it is not.
 */
interface WorkspaceAnalysisEnrichment {
  status: 'pending' | 'ai' | 'degraded' | 'skipped' | 'error';
  reason?: string;
  error?: string;
  started_at?: string;
  completed_at?: string;
}

interface WorkspaceAnalysisRecord {
  workspace_id: string;
  workspace_name: string;
  generated_at: string;
  member_project_ids: string[];
  member_project_names: string[];
  /** Linear, bounded digest of the member CAS revisions used for this build. */
  input_signature?: string;
  graph: CrossCodebaseSystemGraph;
  /** Absent on records persisted before enrichment was attached to server-side WAS rebuilds. */
  enrichment?: WorkspaceAnalysisEnrichment;
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
  private readonly forceRequested = new Set<string>();

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
  async rebuild(workspaceId: string, options: { force?: boolean } = {}): Promise<WorkspaceAnalysisRecord | null> {
    if (options.force) this.forceRequested.add(workspaceId);
    const existingRun = this.inFlight.get(workspaceId);
    if (existingRun) {
      // Calling rebuild while one is active means an input or explicit request
      // arrived after that run took its membership snapshot. Record one dirty
      // follow-up before joining; all concurrent callers coalesce on it.
      this.dirty.add(workspaceId);
      await existingRun;
      // A project may land while this rebuild is running. Its debounce callback
      // then joins the in-flight promise, but the change is still dirty and
      // must be consumed by a follow-up rebuild. Returning here used to strand
      // that dirty bit forever, so a fully persisted WAS reported `pending`
      // indefinitely. Coalesce all such arrivals into one next run.
      if (this.dirty.has(workspaceId) || this.forceRequested.has(workspaceId)) return this.rebuild(workspaceId);
      return this.load(workspaceId);
    }

    // An explicit rebuild supersedes any not-yet-fired debounce for the same
    // workspace. Cancel it before starting so it cannot wake mid-run merely to
    // join this promise and manufacture another lifecycle transition.
    const scheduled = this.pending.get(workspaceId);
    if (scheduled) {
      clearTimeout(scheduled.timer);
      this.pending.delete(workspaceId);
    }
    this.dirty.delete(workspaceId);
    const force = this.forceRequested.delete(workspaceId);
    const run = this.doRebuild(workspaceId, force);
    this.inFlight.set(workspaceId, run);
    try {
      await run;
    } finally {
      this.inFlight.delete(workspaceId);
    }
    // Do not lose a notification that arrived after dirty.delete() and before
    // the run completed. JavaScript resumes concurrent waiters serially, so
    // the first caller starts the follow-up and the rest join it above.
    if (this.dirty.has(workspaceId) || this.forceRequested.has(workspaceId)) return this.rebuild(workspaceId);
    return this.load(workspaceId);
  }

  private async doRebuild(workspaceId: string, force = false): Promise<void> {
    const workspace = await this.accounts.getWorkspaceById(workspaceId);
    const projects = await this.accounts.listProjectsForWorkspace(workspaceId);
    const inputs: CrossCodebaseInput[] = [];
    const memberIds: string[] = [];
    const memberNames: string[] = [];
    let memberComprehensionSettled = true;
    for (const project of projects) {
      if (!project.analysis_id) continue; // evidence-gated: no analysis yet, exclude
      try {
        const cas = await getAnalysis(this.workspacePathFor(project.analysis_id));
        inputs.push({ path: `account-project:${project.id}`, name: project.name, cas });
        memberIds.push(project.id);
        memberNames.push(project.name);
        memberComprehensionSettled = memberComprehensionSettled && isCasComprehensionSettled(cas);
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
    const inputSignature = workspaceInputSignature(inputs, memberIds);
    const previous = await this.load(workspaceId);
    if (!force && previous?.input_signature === inputSignature) return;
    const graph = buildCrossCodebaseSystemGraph(name, inputs, { id: workspaceId });
    const record: WorkspaceAnalysisRecord = {
      workspace_id: workspaceId,
      workspace_name: name,
      generated_at: graph.generated_at,
      member_project_ids: memberIds,
      member_project_names: memberNames,
      input_signature: inputSignature,
      graph,
      enrichment: {
        status: 'pending',
        reason: memberComprehensionSettled
          ? 'Workspace AI comprehension is queued.'
          : 'Workspace structure is ready; AI comprehension waits for every member project comprehension layer to settle.',
        started_at: new Date().toISOString(),
      },
    };
    await fs.ensureDir(this.storeDir);
    // Persist the deterministic build FIRST (progressive availability — the
    // WAS sibling of the project L0->L5 ladder): readers get the structural
    // facts immediately while the AI narrative pass runs below; a second
    // persist then attaches the enriched (or error-stamped) narrative. This
    // whole method already runs in the background (debounced timer or the
    // 202-answered reanalyze route), so the enrichment never blocks an HTTP
    // response.
    //
    // ATOMIC (regression fix): this record is multi-MB and re-persisted more
    // than once per rebuild; a plain fs.writeJson truncates-then-streams in
    // place, so any concurrent GET /api/workspaces/:id/analysis during the
    // write reads a torn/partial file — load() swallows the parse error into
    // `null`, the route answers with NO `analysis` object at all, and a
    // consumer counting fields (applications, runtime_links) reads them all
    // as ZERO exactly at rebuild time, while the on-disk record settles
    // healthy moments later. writeJsonAtomic (temp file + rename, the same
    // primitive the analysis store already uses) closes that window.
    await writeJsonAtomic(this.recordPath(workspaceId), record);

    // Project analyses publish progressively. Building the structural WAS from
    // L0-L4 facts is useful immediately, but enriching it before every member's
    // L5 state settles wastes provider calls and produces a narrative over a
    // transient subset. The final project-layer notification changes the input
    // signature and triggers exactly one enriched rebuild.
    if (!memberComprehensionSettled) return;

    if (!workspaceAiEnrichmentEnabled()) {
      // Honest terminal state, mirroring run_workspace_analysis's
      // ai_enrichment:false: comprehension is AI-only, so the narrative stays
      // the AI-required placeholder — but the record says WHY instead of
      // looking permanently pending.
      record.enrichment = {
        status: 'skipped',
        reason: 'Workspace AI enrichment is disabled by environment; the narrative is a placeholder until AI runs.',
        started_at: record.enrichment?.started_at,
        completed_at: new Date().toISOString(),
      };
      await writeJsonAtomic(this.recordPath(workspaceId), record);
      return;
    }

    // AI workspace narrative enrichment — the SAME pass the run_workspace_analysis
    // MCP tool attaches (enrichWorkspaceAnalysisNarrative), using the ai-service
    // provider chain (DeepInfra -> local -> OpenRouter) already configured on
    // this host. Without this pass the server-side auto-WAS ships an
    // 'ai-required-degraded' narrative with empty description forever.
    try {
      record.graph = await enrichWorkspaceAnalysisNarrative(graph);
      const requiredDescriptionsReady =
        record.graph.workspace_domains.slice(0, 6).every(item => item.description_source === 'ai' && Boolean(item.description?.trim())) &&
        record.graph.workspace_capabilities.slice(0, 8).every(item => item.description_source === 'ai' && Boolean(item.description?.trim()));
      const enrichmentReady = record.graph.workspace_narrative?.source === 'ai' && requiredDescriptionsReady;
      record.enrichment = {
        status: enrichmentReady ? 'ai' : 'degraded',
        reason: enrichmentReady
          ? undefined
          : record.graph.workspace_narrative?.degraded_reason || 'One or more required workspace domain/capability descriptions did not pass AI grounding validation.',
        started_at: record.enrichment?.started_at,
        completed_at: new Date().toISOString(),
      };
    } catch (error) {
      // Enrichment failure is a VISIBLE terminal state (never silent
      // degraded-forever): stamp the narrative AND the record with the error
      // so readers/support can see exactly what to retry.
      const detail = error instanceof Error ? error.message : String(error);
      record.graph.workspace_narrative = {
        ...record.graph.workspace_narrative,
        source: 'ai-required-degraded',
        degraded_reason: `AI workspace narrative enrichment failed during the server-side WAS rebuild: ${detail}. Retry via POST /api/workspaces/{id}/reanalyze once an AI provider is reachable.`,
      };
      record.enrichment = {
        status: 'error',
        error: detail.slice(0, 500),
        started_at: record.enrichment?.started_at,
        completed_at: new Date().toISOString(),
      };
    }
    await writeJsonAtomic(this.recordPath(workspaceId), record);
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

export function isCasComprehensionSettled(cas: any): boolean {
  if (cas?.ai_enrichment === 'pending') return false;
  if (!cas?.layers_ready) return true;
  const layers = Array.isArray(cas.layers_ready.layers) ? cas.layers_ready.layers : [];
  const l5 = layers.find((layer: any) => layer?.layer === 'L5');
  // A progressive CAS with only L0-L4 rows has not reached comprehension yet.
  // Only old synchronous CAS records lack the layer manifest entirely.
  return Boolean(l5 && (l5.status === 'ready' || l5.status === 'error'));
}

export function workspaceInputSignature(inputs: CrossCodebaseInput[], memberIds: string[]): string {
  const members = inputs.map((input, index) => {
    const cas: any = input.cas;
    return {
      project_id: memberIds[index] || input.name || input.path,
      analysis_id: cas?.analysis_id,
      analysis_timestamp: cas?.analysis_timestamp,
      derived_fingerprint: cas?.derived_fingerprint,
      ai_enrichment: cas?.ai_enrichment,
      layers: Array.isArray(cas?.layers_ready?.layers)
        ? cas.layers_ready.layers.map((layer: any) => [layer.layer, layer.status, layer.completed_at || '', layer.error || ''])
        : [],
      nodes: Array.isArray(cas?.nodes) ? cas.nodes.length : 0,
      edges: Array.isArray(cas?.edges) ? cas.edges.length : 0,
      system_description: cas?.system?.description || '',
      capabilities: (cas?.system?.primary_capabilities || []).map((capability: any) => [
        capability?.name || capability?.title || '',
        capability?.description || '',
        capability?.description_source || '',
      ]),
    };
  }).sort((left, right) => String(left.project_id).localeCompare(String(right.project_id)));
  return createHash('sha256').update(JSON.stringify(members)).digest('hex');
}

export type { WorkspaceAnalysisRecord, WorkspaceAnalysisEnrichment };
