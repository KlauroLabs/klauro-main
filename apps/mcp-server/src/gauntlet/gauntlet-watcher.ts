/**
 * Gauntlet watcher — auto-run the incremental gauntlet when a repo changes.
 *
 * This wraps the existing file watcher (watcher.ts) and the incremental gauntlet
 * (incremental-gauntlet.ts) into an installable, persistent unit: install one on
 * a repo, and every time the watcher's incremental analysis completes (or a file
 * changes), we run the incremental gauntlet for THAT change and record the
 * quality/token/speed delta. The result is a time series of Klauro's advantage on
 * understanding the repo's changes, maintained automatically.
 *
 * Robustness contract (the watcher must outlive failures):
 *  - The event handler never throws: a failed incremental run is logged and
 *    swallowed so it cannot kill the watch.
 *  - Watchers are de-duplicated per repoPath: installing twice reuses the live one.
 *  - Config is persisted to ~/.klauro/gauntlet/watchers.json so it survives
 *    restarts; startInstalledWatchers() re-installs enabled ones on boot and is
 *    idempotent + never throws if a repo path is gone (skip + log).
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import { randomUUID } from 'crypto';

import {
  startWatch,
  stopWatch,
  getWatchStatus,
  getWatchEmitter,
  type WatchStatus,
} from '../watcher';
import { listAnalyses } from '../storage';
import { runIncrementalGauntlet, type IncrementalChange } from './incremental-gauntlet';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GauntletWatcher {
  id: string;
  repoPath: string;
  repoName: string;
  watchId: string;
  installedAt: string;
  enabled: boolean;
  /** Number of incremental gauntlet runs this watcher has triggered. */
  runs: number;
}

export interface GauntletWatcherStatus extends GauntletWatcher {
  /** Live watch status (null if the underlying watch is gone). */
  watch: WatchStatus | null;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function gauntletDir(): string {
  return path.join(os.homedir(), '.klauro', 'gauntlet');
}

function watchersFile(): string {
  return path.join(gauntletDir(), 'watchers.json');
}

async function readWatchers(): Promise<GauntletWatcher[]> {
  try {
    const arr = await fs.readJson(watchersFile());
    return Array.isArray(arr) ? (arr as GauntletWatcher[]) : [];
  } catch {
    return [];
  }
}

async function writeWatchers(watchers: GauntletWatcher[]): Promise<void> {
  await fs.ensureDir(gauntletDir());
  await fs.writeJson(watchersFile(), watchers, { spaces: 2 });
}

// ---------------------------------------------------------------------------
// Live run-count tracking + event wiring
// ---------------------------------------------------------------------------

/** In-memory run counters keyed by watcher id (config is persisted lazily). */
const runCounts = new Map<string, number>();
/** watchId -> the listener we attached, so we don't double-subscribe. */
const wiredWatchIds = new Set<string>();

function changeFromEvent(payload: any): IncrementalChange | undefined {
  // 'analysis-complete' carries a full ChangeReport; 'file-change' is lighter.
  const cr = payload?.changeReport;
  if (cr?.summary) {
    return {
      filesChanged:
        (cr.summary.filesAdded || 0) +
        (cr.summary.filesModified || 0) +
        (cr.summary.filesDeleted || 0),
      nodesAdded: cr.summary.nodesAdded || 0,
      nodesModified: cr.summary.nodesModified || 0,
      nodesDeleted: cr.summary.nodesDeleted || 0,
      riskLevel: cr.impact?.riskLevel,
    };
  }
  return undefined;
}

/** Pull the latest change off the live watch status as a fallback. */
function changeFromStatus(watchId: string): IncrementalChange | undefined {
  const status = getWatchStatus(watchId);
  const last = status?.recentChanges?.[0];
  if (!last) return undefined;
  return {
    filesChanged: last.filesChanged,
    nodesAdded: last.nodesAdded,
    nodesModified: last.nodesModified,
    nodesDeleted: last.nodesDeleted,
    riskLevel: last.riskLevel,
  };
}

/**
 * Subscribe (once) to watcher events for this watchId and run the incremental
 * gauntlet on each. The handler NEVER throws — a failed run must not kill the
 * watch — and is fire-and-forget so a slow projection doesn't block the emitter.
 */
function wireWatch(gw: GauntletWatcher): void {
  if (wiredWatchIds.has(gw.watchId)) return;
  wiredWatchIds.add(gw.watchId);

  const emitter = getWatchEmitter();

  const handler = (payload: any) => {
    if (!payload || payload.watchId !== gw.watchId) return;
    const change = changeFromEvent(payload) || changeFromStatus(gw.watchId);
    // Fire-and-forget; isolate every failure.
    void (async () => {
      try {
        await runIncrementalGauntlet({ repoName: gw.repoName, change });
        const next = (runCounts.get(gw.id) || gw.runs || 0) + 1;
        runCounts.set(gw.id, next);
        await bumpPersistedRunCount(gw.id, next);
      } catch (err) {
        // Swallow: the watcher survives a failed incremental run.
        // eslint-disable-next-line no-console
        console.error(
          `[gauntlet-watcher] incremental run failed for ${gw.repoName}:`,
          err instanceof Error ? err.message : String(err)
        );
      }
    })();
  };

  // We only have analysis-complete for the real ripple; file-change is a
  // coarser trigger that falls back to the latest recorded change.
  emitter.on('analysis-complete', handler);
}

async function bumpPersistedRunCount(id: string, runs: number): Promise<void> {
  try {
    const watchers = await readWatchers();
    const idx = watchers.findIndex(w => w.id === id);
    if (idx >= 0) {
      watchers[idx].runs = runs;
      await writeWatchers(watchers);
    }
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function resolveRepoName(repoPath: string): Promise<string> {
  const normalized = path.resolve(repoPath);
  const entries = await listAnalyses();
  const match =
    entries.find(e => path.resolve(e.path) === normalized) ||
    entries.find(e => path.basename(e.path) === path.basename(normalized)) ||
    entries.find(e => e.name === path.basename(normalized));
  return match?.name || path.basename(normalized);
}

/**
 * Install a gauntlet watcher on a repo: resolve its analyzed name, start the file
 * watch, wire the incremental gauntlet to fire on change, and persist config.
 * De-duplicated per repoPath — installing again returns the existing one.
 */
export async function installGauntletWatcher(repoPath: string): Promise<GauntletWatcher> {
  const normalized = path.resolve(repoPath);

  // Reuse an existing enabled watcher on the same path.
  const existing = (await readWatchers()).find(
    w => path.resolve(w.repoPath) === normalized && w.enabled
  );
  if (existing) {
    runCounts.set(existing.id, existing.runs || 0);
    wireWatch(existing); // idempotent
    return existing;
  }

  const repoName = await resolveRepoName(normalized);
  const { watchId } = startWatch(normalized);

  const gw: GauntletWatcher = {
    id: randomUUID(),
    repoPath: normalized,
    repoName,
    watchId,
    installedAt: new Date().toISOString(),
    enabled: true,
    runs: 0,
  };

  runCounts.set(gw.id, 0);
  wireWatch(gw);

  const watchers = await readWatchers();
  watchers.push(gw);
  await writeWatchers(watchers);

  return gw;
}

/** Merge persisted config with the live watch status for each watcher. */
export async function listGauntletWatchers(): Promise<GauntletWatcherStatus[]> {
  const watchers = await readWatchers();
  return watchers.map(w => {
    const runs = runCounts.has(w.id) ? runCounts.get(w.id)! : w.runs;
    return {
      ...w,
      runs,
      watch: getWatchStatus(w.watchId),
    };
  });
}

/** Stop the underlying watch, mark disabled, persist. */
export async function stopGauntletWatcher(id: string): Promise<{ ok: boolean }> {
  const watchers = await readWatchers();
  const idx = watchers.findIndex(w => w.id === id);
  if (idx < 0) return { ok: false };

  const gw = watchers[idx];
  try {
    stopWatch(gw.watchId);
  } catch {
    /* underlying watch may already be gone */
  }
  wiredWatchIds.delete(gw.watchId);

  watchers[idx] = { ...gw, enabled: false };
  await writeWatchers(watchers);
  return { ok: true };
}

/**
 * Re-install all persisted enabled watchers on server boot so they auto-run.
 * Idempotent (reuses live watches per path) and never throws — a missing repo
 * path is skipped + logged, not fatal.
 */
export async function startInstalledWatchers(): Promise<{ started: number }> {
  const watchers = await readWatchers();
  let started = 0;

  for (const w of watchers) {
    if (!w.enabled) continue;
    try {
      if (!(await fs.pathExists(w.repoPath))) {
        // eslint-disable-next-line no-console
        console.warn(`[gauntlet-watcher] skip ${w.repoName}: path gone (${w.repoPath})`);
        continue;
      }
      // startWatch de-dupes per path; re-attach the live watchId and re-wire.
      const { watchId } = startWatch(w.repoPath);
      const refreshed: GauntletWatcher = { ...w, watchId };
      runCounts.set(refreshed.id, w.runs || 0);
      wireWatch(refreshed);

      // Persist the (possibly new) watchId back.
      const all = await readWatchers();
      const idx = all.findIndex(x => x.id === w.id);
      if (idx >= 0) {
        all[idx] = { ...all[idx], watchId };
        await writeWatchers(all);
      }
      started++;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[gauntlet-watcher] failed to start watcher ${w.repoName}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  return { started };
}
