


















import * as fs from 'node:fs';

import { loadRedactionRules, redactInFlightDiff, redactInFlightChanges, type InFlightDiffFile } from './security';
import type { SymbolChange } from './conceptual-conflict';
import type { InFlightAttributionSource } from './participant-in-flight-store';


export interface PublishInFlightResult {
  status: 'success';
  workspace: string;
  agent_id: string;
  kept_files: number;
  dropped_files: number;

  kept_changes: number;

  dropped_changes: number;
}

export class InFlightPublishError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'InFlightPublishError';
  }
}

export interface PublishInFlightOptions {

  diffOnly?: boolean;

  orgId?: string;
  attributionSource?: InFlightAttributionSource;
}




















export async function publishInFlight(
  baseUrl: string,
  token: string | undefined,
  workspaceId: string,
  agentId: string,
  projectRoot: string,
  diffFiles: InFlightDiffFile[],
  options: PublishInFlightOptions = {},
  extra: { baseCommit?: string; branch?: string; changes?: SymbolChange[] } = {}
): Promise<PublishInFlightResult> {
  const rules = await loadRedactionRules(projectRoot);
  const { kept, dropped } = redactInFlightDiff(diffFiles, rules, { diffOnly: options.diffOnly });
  const { kept: keptChanges, dropped: droppedChanges } = redactInFlightChanges(extra.changes ?? [], rules);

  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/coordination/in-flight`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        workspace: workspaceId,
        agent_id: agentId,
        org_id: options.orgId,
        base_commit: extra.baseCommit,
        branch: extra.branch,
        attribution_source: options.attributionSource ?? 'workspace-tree',
        diff_context: JSON.stringify({ files: kept, dropped_count: dropped.length }),
        ...(extra.changes !== undefined ? { changes: keptChanges } : {}),
      }),
    });
  } catch (err) {
    throw new InFlightPublishError(`publishInFlight: network error POSTing to ${baseUrl}`, err);
  }
  if (!response.ok) {
    let bodyText: string | undefined;
    try {
      bodyText = await response.text();
    } catch {

    }
    throw new InFlightPublishError(`publishInFlight: remote responded ${response.status}`, bodyText);
  }
  const parsed = (await response.json()) as { status: 'success' };
  return {
    status: parsed.status,
    workspace: workspaceId,
    agent_id: agentId,
    kept_files: kept.length,
    dropped_files: dropped.length,
    kept_changes: keptChanges.length,
    dropped_changes: droppedChanges.length,
  };
}

export interface InFlightWatcherOptions extends PublishInFlightOptions {

  debounceMs?: number;
  baseCommit?: string;
  branch?: string;

  onPublished?: (result: PublishInFlightResult) => void;

  onError?: (error: unknown) => void;
}


















export function startInFlightWatcher(
  projectRoot: string,
  baseUrl: string,
  token: string | undefined,
  workspaceId: string,
  agentId: string,
  buildDiff: () => Promise<InFlightDiffFile[]> | InFlightDiffFile[],
  options: InFlightWatcherOptions = {},
  buildChanges?: () => Promise<SymbolChange[]> | SymbolChange[]
): { stop: () => void } {
  const debounceMs = options.debounceMs ?? 2000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const flush = () => {
    if (stopped) return;
    void (async () => {
      try {
        const [diffFiles, changes] = await Promise.all([
          buildDiff(),
          buildChanges ? buildChanges() : Promise.resolve(undefined),
        ]);
        const result = await publishInFlight(
          baseUrl,
          token,
          workspaceId,
          agentId,
          projectRoot,
          diffFiles,
          { diffOnly: options.diffOnly, orgId: options.orgId, attributionSource: options.attributionSource },
          { baseCommit: options.baseCommit, branch: options.branch, changes }
        );
        options.onPublished?.(result);
      } catch (err) {
        options.onError?.(err);
      }
    })();
  };

  const schedule = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  };

  const watcher = fs.watch(projectRoot, { recursive: true }, () => schedule());

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}
