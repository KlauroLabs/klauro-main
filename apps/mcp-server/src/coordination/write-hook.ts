





























import * as fs from 'node:fs';
import * as path from 'node:path';

import { EXCLUDED_DIRECTORIES } from '../remote-source';
import { announceEdit, attributeChange, recordAmbiguousEdit, recordUnclaimedEdit, warnIfTreeGlobalOp } from './local-store';









export { warnIfTreeGlobalOp };

export interface WriteHookAnnounceEvent {
  path: string;
  agentId: string;
  claimId: string;
}

export interface WriteHookUnclaimedEvent {
  path: string;
}

export interface WriteHookAmbiguousEvent {
  path: string;
  candidateAgentIds: string[];
}

export interface WriteHookOptions {









  debounceMs?: number;

  onAnnounce?: (event: WriteHookAnnounceEvent) => void;

  onUnclaimedEdit?: (event: WriteHookUnclaimedEvent) => void;
  onAmbiguousEdit?: (event: WriteHookAmbiguousEvent) => void;





  onError?: (error: unknown) => void;

  detectedBy?: string;
}

export interface WriteHookHandle {

  close: () => void;
}


function isExcludedPath(relPath: string): boolean {
  const segments = relPath.split(path.sep).filter(Boolean);
  return segments.some((seg) => EXCLUDED_DIRECTORIES.has(seg));
}








export function startWriteHook(
  workspaceRoot: string,
  workspaceId: string,
  options: WriteHookOptions = {}
): WriteHookHandle {
  const debounceMs = options.debounceMs ?? 300;
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const processPath = async (relPath: string): Promise<void> => {
    try {
      const attribution = await attributeChange(workspaceId, relPath);
      if (attribution.attributions.length === 0) {
        try {
          await recordUnclaimedEdit(workspaceId, relPath, { detectedBy: options.detectedBy });
          options.onUnclaimedEdit?.({ path: relPath });
        } catch (err) {
          options.onError?.(err);
        }
        return;
      }
      if (attribution.attributions.length > 1) {
        const candidateAgentIds = [...new Set(attribution.attributions.map((entry) => entry.agent_id))].sort();
        await recordAmbiguousEdit(workspaceId, relPath, candidateAgentIds);
        options.onAmbiguousEdit?.({ path: relPath, candidateAgentIds });
        return;
      }
      const attributed = attribution.attributions[0];
      try {
        await announceEdit(workspaceId, attributed.agent_id, [relPath], { intent: `write-hook: ${attributed.intent}` });
        options.onAnnounce?.({ path: relPath, agentId: attributed.agent_id, claimId: attributed.claim_id });
      } catch (err) {
        options.onError?.(err);
      }
    } catch (err) {
      options.onError?.(err);
    }
  };

  const flush = (): void => {
    if (closed) return;
    const paths = [...pending];
    pending.clear();
    void (async () => {
      for (const relPath of paths) {
        if (closed) return;
        await processPath(relPath);
      }
    })().catch((err) => options.onError?.(err));
  };

  const schedule = (relPath: string): void => {
    if (closed) return;
    if (isExcludedPath(relPath)) return;
    pending.add(relPath);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  };

  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = fs.watch(workspaceRoot, { recursive: true }, (_event, filename) => {
      try {
        if (!filename) return;
        schedule(filename.toString());
      } catch (err) {
        options.onError?.(err);
      }
    });
    watcher.on('error', (err) => options.onError?.(err));
  } catch (err) {


    options.onError?.(err);
  }

  return {
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      try {
        watcher?.close();
      } catch {

      }
    },
  };
}










export const DEFAULT_WRITE_HOOK_REGISTRY: Map<string, WriteHookHandle> = new Map();










export function ensureWriteHookStarted(
  workspaceRoot: string,
  workspaceId: string,
  options: WriteHookOptions = {},
  registry: Map<string, WriteHookHandle> = DEFAULT_WRITE_HOOK_REGISTRY
): WriteHookHandle {
  const existing = registry.get(workspaceId);
  if (existing) return existing;
  const handle = startWriteHook(workspaceRoot, workspaceId, options);
  registry.set(workspaceId, handle);
  return handle;
}








export function closeAllWriteHooks(registry: Map<string, WriteHookHandle> = DEFAULT_WRITE_HOOK_REGISTRY): void {
  for (const handle of registry.values()) {
    try {
      handle.close();
    } catch {

    }
  }
  registry.clear();
}
















export function shouldActivateWriteHook(
  settings: { fabric?: { enabled?: boolean } },
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (settings.fabric?.enabled === true) return true;
  return env.KLAURO_WRITE_HOOK === '1';
}
