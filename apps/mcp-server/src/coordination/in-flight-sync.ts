


















import * as fs from 'node:fs';

import { loadRedactionRules, redactInFlightDiff, redactInFlightChanges, type InFlightDiffFile } from './security';
import type { SymbolChange } from './conceptual-conflict';
import type { InFlightAttributionSource } from './participant-in-flight-store';
import { RemoteFabricError, remotePublishInFlight } from './remote-transport';


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

  try {
    await remotePublishInFlight({ baseUrl, token }, {
      workspace: workspaceId,
      agentId,
      orgId: options.orgId,
      baseCommit: extra.baseCommit,
      branch: extra.branch,
      attributionSource: options.attributionSource ?? 'workspace-tree',
      diffContext: JSON.stringify({ files: kept, dropped_count: dropped.length }),
      ...(extra.changes !== undefined ? { changes: keptChanges } : {}),
      capturedAt: new Date().toISOString(),
    });
  } catch (err) {
    const detail = err instanceof RemoteFabricError ? err.message : `remote operation failed: ${String(err)}`;
    throw new InFlightPublishError(`publishInFlight: ${detail}`, err);
  }
  return {
    status: 'success',
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
  let running = false;
  let pending = false;

  const flush = async () => {
    if (stopped) return;
    if (running) {
      pending = true;
      return;
    }
    running = true;
    do {
      pending = false;
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
    } while (!stopped && pending);
    running = false;
  };

  const schedule = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), debounceMs);
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
