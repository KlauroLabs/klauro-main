/**
 * WS-B in-flight publisher — a debounced, redaction-gated publisher of a local
 * agent's uncommitted working-tree diff to the REMOTE coordination service
 * (`POST /v1/coordination/in-flight`, wired in `remote-analyzer-service.ts`).
 *
 * Security is non-negotiable and comes FIRST (§WS-F, hard gate): every diff is
 * passed through `redactInFlightDiff` (security.ts) — which drops
 * secret-pattern / `.klauroignore` files and, in `diffOnly` mode, strips full
 * file bodies — BEFORE it is ever serialized into an HTTP request body. No
 * caller of `publishInFlight` can bypass this.
 *
 * `startInFlightWatcher` is intentionally a thin wrapper (per
 * SPEC-COORDINATION-FABRIC.md WS-B: "keep it simple; a thin wrapper is fine —
 * do NOT build a full file-watcher engine") around `node:fs.watch` on the
 * project root, debounced, calling a caller-supplied diff-builder + publish.
 * It does not attempt to reuse the MCP-side `start_watch`/`poll_watch_changes`
 * tools (those live in server.ts, which this workstream must not touch).
 */

import * as fs from 'node:fs';

import { loadRedactionRules, redactInFlightDiff, type InFlightDiffFile } from './security';

/** Response shape from `POST /v1/coordination/in-flight` (remote-analyzer-service.ts). */
export interface PublishInFlightResult {
  status: 'success';
  workspace: string;
  agent_id: string;
  kept_files: number;
  dropped_files: number;
}

export class InFlightPublishError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'InFlightPublishError';
  }
}

export interface PublishInFlightOptions {
  /** Diff-only mode (§WS-F): strip full file bodies, keep only patch text. */
  diffOnly?: boolean;
  /** Organization scope (§WS-F tenancy), forwarded to the server for `assertSameTenant`. */
  orgId?: string;
}

/**
 * Redact `diffFiles` (via `redactInFlightDiff` + `.klauroignore`/secret rules
 * loaded from `projectRoot`) and POST the surviving, possibly diff-only,
 * payload to the remote coordination service's in-flight endpoint. The raw
 * (pre-redaction) diff never leaves this function — only `kept` is
 * serialized into the request body.
 */
export async function publishInFlight(
  baseUrl: string,
  token: string | undefined,
  workspaceId: string,
  agentId: string,
  projectRoot: string,
  diffFiles: InFlightDiffFile[],
  options: PublishInFlightOptions = {},
  extra: { baseCommit?: string; branch?: string } = {}
): Promise<PublishInFlightResult> {
  const rules = await loadRedactionRules(projectRoot);
  const { kept, dropped } = redactInFlightDiff(diffFiles, rules, { diffOnly: options.diffOnly });

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
        diff_context: JSON.stringify({ files: kept, dropped_count: dropped.length }),
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
      // ignore — best-effort diagnostic text only.
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
  };
}

export interface InFlightWatcherOptions extends PublishInFlightOptions {
  /** Debounce window in ms between a filesystem change and the publish call. Default 2000 (§WS-K: "debounced to ≤2s"). */
  debounceMs?: number;
  baseCommit?: string;
  branch?: string;
  /** Called with the publish result on each successful flush. */
  onPublished?: (result: PublishInFlightResult) => void;
  /** Called with the error on a failed flush (network or redaction never throws, so this is publish-only). */
  onError?: (error: unknown) => void;
}

/**
 * Start a thin, debounced watcher on `projectRoot`: on any filesystem change,
 * wait `debounceMs` (coalescing bursts of writes into one publish), then call
 * `buildDiff()` to compute the current working-tree diff files and publish
 * them via `publishInFlight`. Returns a `stop()` function.
 *
 * `buildDiff` is caller-supplied rather than built here — this module does
 * not reimplement diff computation (that's `remote-source.ts`'s
 * `buildBranchDiffContext`, outside this workstream's editable file set); it
 * only owns the debounce + redact + publish plumbing.
 */
export function startInFlightWatcher(
  projectRoot: string,
  baseUrl: string,
  token: string | undefined,
  workspaceId: string,
  agentId: string,
  buildDiff: () => Promise<InFlightDiffFile[]> | InFlightDiffFile[],
  options: InFlightWatcherOptions = {}
): { stop: () => void } {
  const debounceMs = options.debounceMs ?? 2000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const flush = () => {
    if (stopped) return;
    void (async () => {
      try {
        const diffFiles = await buildDiff();
        const result = await publishInFlight(
          baseUrl,
          token,
          workspaceId,
          agentId,
          projectRoot,
          diffFiles,
          { diffOnly: options.diffOnly, orgId: options.orgId },
          { baseCommit: options.baseCommit, branch: options.branch }
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
