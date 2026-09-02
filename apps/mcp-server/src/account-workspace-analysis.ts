import * as fs from 'fs-extra';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { loadAnalysisSections, writeJsonAtomic } from './storage';
import { enrichWorkspaceAnalysisNarrative, workspaceAiEnrichmentEnabled, type CrossCodebaseInput, type CrossCodebaseSystemGraph } from './cross-codebase-analysis';
import { buildIncrementalCrossCodebaseSystemGraph } from './incremental-workspace-analysis';
import type { AccountStore } from './account-store';
import { waitForForegroundAnalysisIdle } from './foreground-analysis';
import { resolveWorkspacePreviousRecordMaxBytes, runAccountWorkspaceAnalysisWorker, WorkspaceAnalysisPreemptedError } from './account-workspace-analysis-process';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import type { CasSectionName } from './cas-sections';
import { projectAttemptRecordPath, readAttemptRecord } from './analysis-attempt-record';

export const WORKSPACE_MEMBER_SECTIONS = [
  'facts', 'comprehension', 'runtime', 'quality', 'supplemental',
] as const satisfies readonly CasSectionName[];

export function compactWorkspaceMemberCas(cas: Partial<CASOutput>): CASOutput {
  return { ...cas, nodes: [], edges: [], analyzer_contributions: cas.analyzer_contributions || [] } as CASOutput;
}
























const DEFAULT_DEBOUNCE_MS = 3000;









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

  input_signature?: string;
  graph: CrossCodebaseSystemGraph;

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
  private readonly failures = new Map<string, string>();
  private closed = false;

  constructor(
    private readonly dataDir: string,
    private readonly accounts: AccountStore,
    options: { debounceMs?: number; settleMs?: number; runIsolated?: typeof runAccountWorkspaceAnalysisWorker } = {},
  ) {
    this.storeDir = path.join(dataDir, 'workspace-analyses');
    this.debounceMs = options.debounceMs ?? resolveDebounceMs();
    this.settleMs = options.settleMs ?? this.debounceMs;
    this.runIsolated = options.runIsolated ?? runAccountWorkspaceAnalysisWorker;
  }

  private readonly runIsolated: typeof runAccountWorkspaceAnalysisWorker;
  private readonly settleMs: number;








  notifyProjectAnalysisLanded(workspaceId: string): void {
    if (!workspaceId || this.closed) return;
    this.failures.set(workspaceId, 'Workspace analysis is waiting for current member analyses.');
    this.dirty.add(workspaceId);
    if (this.inFlight.has(workspaceId)) return;
    const existing = this.pending.get(workspaceId);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.pending.delete(workspaceId);
      this.rebuild(workspaceId).catch(error => {



        console.error(`[Klauro] workspace analysis auto-rebuild failed for ${workspaceId}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, this.debounceMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.pending.set(workspaceId, { timer, scheduledAt: new Date().toISOString() });
  }


  isPending(workspaceId: string): boolean {
    return this.pending.has(workspaceId) || this.inFlight.has(workspaceId) || this.dirty.has(workspaceId);
  }

  failureReason(workspaceId: string): string | undefined {
    return this.failures.get(workspaceId);
  }

  close(): void {
    this.closed = true;
    for (const rebuild of this.pending.values()) clearTimeout(rebuild.timer);
    this.pending.clear();
    this.dirty.clear();
    this.forceRequested.clear();
    this.failures.clear();
  }


  async load(workspaceId: string): Promise<WorkspaceAnalysisRecord | null> {
    if (this.failures.has(workspaceId)) return null;
    const memberFailure = await this.currentMemberFailure(workspaceId);
    if (memberFailure) {
      this.failures.set(workspaceId, memberFailure);
      return null;
    }
    const file = this.recordPath(workspaceId);
    if (!(await fs.pathExists(file))) return null;
    try {
      return await fs.readJson(file);
    } catch {
      return null;
    }
  }

  private async currentMemberFailure(workspaceId: string): Promise<string | null> {
    if (typeof this.accounts.listProjectsForWorkspace !== 'function') return null;
    const projects = await this.accounts.listProjectsForWorkspace(workspaceId);
    for (const project of projects) {
      if (!project.analysis_id) continue;
      const memberWorkspace = this.workspacePathFor(project.analysis_id);
      const attempt = await readAttemptRecord(projectAttemptRecordPath(memberWorkspace));
      if (attempt?.state === 'failed') {
        return `Workspace member ${project.name} (${project.id}) is unavailable: ${attempt.reason || 'latest analysis attempt failed'}`;
      }
    }
    return null;
  }

  private async loadPreviousForIncrementalRebuild(workspaceId: string): Promise<WorkspaceAnalysisRecord | null> {
    const file = this.recordPath(workspaceId);
    try {
      const stat = await fs.stat(file);
      const maxBytes = resolveWorkspacePreviousRecordMaxBytes();
      if (stat.size > maxBytes) {
        console.error(`[Klauro] workspace analysis ${workspaceId} will rebuild from complete member inputs because its ${stat.size}-byte previous record exceeds the ${maxBytes}-byte incremental reuse budget.`);
        return null;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      return await fs.readJson(file);
    } catch {
      return null;
    }
  }









  async rebuild(workspaceId: string, options: { force?: boolean } = {}): Promise<WorkspaceAnalysisRecord | null> {
    if (this.closed) return this.load(workspaceId);
    if (options.force) this.forceRequested.add(workspaceId);
    const existingRun = this.inFlight.get(workspaceId);
    if (existingRun) {



      this.dirty.add(workspaceId);
      await existingRun;





      if (!this.closed && (this.dirty.has(workspaceId) || this.forceRequested.has(workspaceId))) return this.rebuild(workspaceId);
      return this.load(workspaceId);
    }




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
    } catch (error) {
      if (error instanceof WorkspaceAnalysisPreemptedError) {
        this.dirty.add(workspaceId);
      } else {
        this.failures.set(workspaceId, error instanceof Error ? error.message : String(error));
        throw error;
      }
    } finally {
      this.inFlight.delete(workspaceId);
    }



    if (!this.closed && (this.dirty.has(workspaceId) || this.forceRequested.has(workspaceId))) return this.rebuild(workspaceId);
    this.failures.delete(workspaceId);
    return this.load(workspaceId);
  }

  private async doRebuild(workspaceId: string, force = false): Promise<void> {
    if (process.env.KLAURO_WORKSPACE_ANALYSIS_IN_PROCESS !== '1') {
      await waitForForegroundAnalysisIdle(0);
      while (this.settleMs > 0) {
        this.dirty.delete(workspaceId);
        await new Promise(resolve => setTimeout(resolve, this.settleMs));
        await waitForForegroundAnalysisIdle(0);
        if (!this.dirty.has(workspaceId)) break;
      }
      this.dirty.delete(workspaceId);
      await this.runIsolated(this.dataDir, workspaceId, force);
      return;
    }
    const workspace = await this.accounts.getWorkspaceById(workspaceId);
    const projects = await this.accounts.listProjectsForWorkspace(workspaceId);
    const inputs: CrossCodebaseInput[] = [];
    const memberIds: string[] = [];
    const memberNames: string[] = [];
    let memberComprehensionSettled = true;
    for (const project of projects) {
      if (!project.analysis_id) continue;
      try {
        const memberWorkspace = this.workspacePathFor(project.analysis_id);
        const attempt = await readAttemptRecord(projectAttemptRecordPath(memberWorkspace));
        if (attempt?.state === 'failed') throw new Error(attempt.reason || 'latest analysis attempt failed');
        const cas = await loadAnalysisSections(memberWorkspace, WORKSPACE_MEMBER_SECTIONS);
        if (!cas) throw new Error('current analysis is unavailable');
        inputs.push({
          path: `account-project:${project.id}`,
          name: project.name,
          cas: compactWorkspaceMemberCas(cas),
        });
        memberIds.push(project.id);
        memberNames.push(project.name);
        memberComprehensionSettled = memberComprehensionSettled && isCasComprehensionSettled(cas);
      } catch (error) {
        throw new Error(`Workspace member ${project.name} (${project.id}) is unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (inputs.length === 0) {


      return;
    }

    const name = workspace?.name || workspaceId;
    const inputSignature = workspaceInputSignature(inputs, memberIds);
    const previous = await this.loadPreviousForIncrementalRebuild(workspaceId);
    if (!force && previous?.input_signature === inputSignature) return;
    const graph = buildIncrementalCrossCodebaseSystemGraph({
      name,
      repositories: inputs,
      previous: force ? null : previous?.graph,
      id: workspaceId
    });
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

















    await writeJsonAtomic(this.recordPath(workspaceId), record);






    if (!memberComprehensionSettled) return;

    if (!workspaceAiEnrichmentEnabled()) {




      record.enrichment = {
        status: 'skipped',
        reason: 'Workspace AI enrichment is disabled by environment; no workspace narrative was generated.',
        started_at: record.enrichment?.started_at,
        completed_at: new Date().toISOString(),
      };
      await writeJsonAtomic(this.recordPath(workspaceId), record);
      return;
    }






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



      const detail = error instanceof Error ? error.message : String(error);
      record.graph.workspace_narrative = {
        ...record.graph.workspace_narrative,
        source: 'ai-required-degraded',
        degraded_reason: `AI workspace narrative enrichment failed during the server-side workspace-level CAS rebuild: ${detail}. Retry via POST /api/workspaces/{id}/reanalyze once an AI provider is reachable.`,
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
  if (!cas?.layers_ready?.layers?.length) return false;
  const layers = Array.isArray(cas.layers_ready.layers) ? cas.layers_ready.layers : [];
  const l5 = layers.find((layer: any) => layer?.layer === 'L5');


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
