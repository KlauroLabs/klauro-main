/**
 * W5 — Write-hook (auto-announce REAL edits), SPEC-COORDINATION-FABRIC-V3
 * §6.3/§8: "Kills the self-reporting drift class." Before this module,
 * `announceEdit` (local-store.ts) existed but nobody called it automatically
 * — agents self-reported (or didn't), so claims drifted from reality. The v3
 * battle-test's own evidence (§3.2, §6.3): agents A and E both edited
 * `orchestrator.ts`, a file NEITHER had claimed, and the drift was invisible
 * until it was too late to matter.
 *
 * This is a thin, debounced `fs.watch` wrapper — same pattern as
 * `in-flight-sync.ts`'s `startInFlightWatcher` (per that module's own header:
 * "keep it simple; a thin wrapper is fine — do NOT build a full file-watcher
 * engine"). On a REAL file change under `workspaceRoot`:
 *
 *   1. Resolve which active claim(s) (`attributeChange`, local-store.ts)
 *      cover the changed path.
 *   2. If one or more active claims cover it: auto-`announceEdit` for EACH
 *      matching claim's `agent_id` — no self-reporting, no waiting for the
 *      agent to call a tool.
 *   3. If NO active claim covers it: `recordUnclaimedEdit` (local-store.ts) —
 *      an additive `kind: 'unclaimed-edit'` event-log entry, never an active
 *      claim — so the drift is VISIBLE the instant it happens instead of at
 *      merge time.
 *
 * AWARENESS, NOT ENFORCEMENT (§2/§4 SPEC-COORDINATION-FABRIC-V3): this module
 * never blocks a write, never throws into the `fs.watch` callback, and never
 * denies anything. Every error is swallowed to the caller-supplied
 * `onError` — a crash in this module must never crash the write it observed.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { EXCLUDED_DIRECTORIES } from '../remote-source';
import { announceEdit, attributeChange, recordUnclaimedEdit, warnIfTreeGlobalOp } from './local-store';

/**
 * W6 re-export (SPEC-COORDINATION-FABRIC-V3 §6.3/§8): the write-hook's public
 * surface is where `fab.ts` and any future tree-global git wrapper already
 * import claim-log helpers from for the awareness path, so the tree-global-op
 * warning is re-exported here too rather than requiring a second import of
 * `./local-store` for one function. Defined once in `local-store.ts` (single
 * source of truth) — this is purely a re-export, not a second implementation.
 */
export { warnIfTreeGlobalOp };

export interface WriteHookAnnounceEvent {
  path: string;
  agentId: string;
  claimId: string;
}

export interface WriteHookUnclaimedEvent {
  path: string;
}

export interface WriteHookOptions {
  /**
   * Debounce window (ms) coalescing a burst of `fs.watch` events (an
   * editor/save typically fires several) into one processing pass per
   * changed path. Default 300ms — deliberately much shorter than
   * `in-flight-sync.ts`'s 2000ms, since that module debounces an expensive
   * REMOTE publish while this one debounces a cheap same-machine claim-log
   * append; W5's whole point is that drift is visible "the moment it
   * happens," not after a multi-second delay.
   */
  debounceMs?: number;
  /** Called once per (path, agentId) claim the write-hook auto-announced an edit for. */
  onAnnounce?: (event: WriteHookAnnounceEvent) => void;
  /** Called once per path that changed under NO active claim. */
  onUnclaimedEdit?: (event: WriteHookUnclaimedEvent) => void;
  /**
   * Called with any error encountered while processing a change. Errors are
   * ALWAYS swallowed here — this callback is for logging/telemetry, never a
   * throw path. Awareness must never fail the write it is merely observing.
   */
  onError?: (error: unknown) => void;
  /** Attribute unclaimed-edit events to a synthetic agent id (default 'unknown'). */
  detectedBy?: string;
}

export interface WriteHookHandle {
  /** Stop watching and release the underlying `fs.watch` handle. Idempotent. */
  close: () => void;
}

/** True if any path segment of `relPath` is one of the snapshot-walk's excluded directories (node_modules, .git, dist, ...). */
function isExcludedPath(relPath: string): boolean {
  const segments = relPath.split(path.sep).filter(Boolean);
  return segments.some((seg) => EXCLUDED_DIRECTORIES.has(seg));
}

/**
 * Start the write-hook: watch `workspaceRoot` and auto-announce/record real
 * edits against `workspaceId`'s coordination fabric. Returns a handle whose
 * `close()` stops the watcher — call it on shutdown/session-end so the
 * process can exit cleanly (no leaked `fs.watch` handle keeping the event
 * loop alive).
 */
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
      // Overlapping claims on the same path are a supported, ordinary case
      // (V3 §1 inversion #5) — announce for EVERY covering agent, not just
      // the first. `attributeChange` only ever returns 'active' entries
      // (it derives from `getActiveClaims`), so no extra status filter is
      // needed here.
      for (const a of attribution.attributions) {
        try {
          await announceEdit(workspaceId, a.agent_id, [relPath], { intent: `write-hook: ${a.intent}` });
          options.onAnnounce?.({ path: relPath, agentId: a.agent_id, claimId: a.claim_id });
        } catch (err) {
          options.onError?.(err);
        }
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
        if (!filename) return; // some platforms/events omit the filename — nothing to attribute, skip silently.
        schedule(filename.toString());
      } catch (err) {
        options.onError?.(err);
      }
    });
    watcher.on('error', (err) => options.onError?.(err));
  } catch (err) {
    // fs.watch itself can throw synchronously (e.g. workspaceRoot vanished) —
    // never let starting the write-hook take down its caller.
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
        // already closed / never opened — nothing to do.
      }
    },
  };
}

/**
 * Module-level registry of running write-hooks keyed by workspace id. Both
 * production callers of `ensureWriteHookStarted` — the MCP-server lifecycle
 * wiring (server.ts, one process per session) and `fab watch`
 * (scripts/fab.ts, one process per terminal) — share this singleton so
 * activation is idempotent for the life of the process without either caller
 * having to track its own state. Exported (rather than private) so a test can
 * pass its own `Map` for isolation instead of touching the shared singleton.
 */
export const DEFAULT_WRITE_HOOK_REGISTRY: Map<string, WriteHookHandle> = new Map();

/**
 * Idempotent-by-workspace activation: start a write-hook for `workspaceId`
 * rooted at `workspaceRoot` unless one is already running for that workspace
 * id in `registry`, in which case the existing handle is returned untouched
 * (a repeat call — e.g. once per `fab_*` MCP tool invocation — is a no-op,
 * not a second watcher on the same tree). This is the activation primitive
 * both W5 production callers use; see `shouldActivateWriteHook` for the
 * "should I call this at all" gate.
 */
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

/**
 * Stop every write-hook in `registry` (default: the module singleton) and
 * clear it. Call once on process shutdown (server.ts registers this against
 * `process.on('exit', ...)`). Safe to call more than once — `close()` on an
 * already-closed handle is a no-op per `startWriteHook`'s own contract, and
 * clearing an already-empty registry is a no-op too.
 */
export function closeAllWriteHooks(registry: Map<string, WriteHookHandle> = DEFAULT_WRITE_HOOK_REGISTRY): void {
  for (const handle of registry.values()) {
    try {
      handle.close();
    } catch {
      // already closed — nothing to do.
    }
  }
  registry.clear();
}

/**
 * Should the MCP-server lifecycle (or `fab watch`) auto-start a write-hook
 * for this resolved fabric configuration? Gate, per the task: an explicit
 * `.klaurorc` `fabric.enabled: true` (the repo ran `klauro init` / `klauro
 * fabric on` — see fabric-config.ts) OR the `KLAURO_WRITE_HOOK=1` escape
 * hatch (forces activation without a `.klaurorc`, e.g. local dev/tests).
 *
 * A workspace with NO `.klaurorc` fabric section at all (the local default —
 * `resolveFabricSettings` falls back to workspace `'poc'`) stays INERT: no
 * fs.watch, no behavior change, byte-for-byte the pre-activation server —
 * matching fabric-config.ts's own stated invariant ("no config + no env =
 * byte-for-byte the original local behavior"). Opting a repo into ambient
 * awareness is exactly what `klauro fabric on`/`klauro init` already means;
 * this gate reuses that existing signal rather than inventing a new one.
 */
export function shouldActivateWriteHook(
  settings: { fabric?: { enabled?: boolean } },
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (settings.fabric?.enabled === true) return true;
  return env.KLAURO_WRITE_HOOK === '1';
}
