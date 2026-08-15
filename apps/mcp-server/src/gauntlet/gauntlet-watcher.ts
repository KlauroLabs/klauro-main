


















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





export interface GauntletWatcher {
  id: string;
  repoPath: string;
  repoName: string;
  watchId: string;
  installedAt: string;
  enabled: boolean;

  runs: number;
}

export interface GauntletWatcherStatus extends GauntletWatcher {

  watch: WatchStatus | null;
}





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






const runCounts = new Map<string, number>();

const wiredWatchIds = new Set<string>();

function changeFromEvent(payload: any): IncrementalChange | undefined {

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






function wireWatch(gw: GauntletWatcher): void {
  if (wiredWatchIds.has(gw.watchId)) return;
  wiredWatchIds.add(gw.watchId);

  const emitter = getWatchEmitter();

  const handler = (payload: any) => {
    if (!payload || payload.watchId !== gw.watchId) return;
    const change = changeFromEvent(payload) || changeFromStatus(gw.watchId);

    void (async () => {
      try {
        await runIncrementalGauntlet({ repoName: gw.repoName, change });
        const next = (runCounts.get(gw.id) || gw.runs || 0) + 1;
        runCounts.set(gw.id, next);
        await bumpPersistedRunCount(gw.id, next);
      } catch (err) {


        console.error(
          `[gauntlet-watcher] incremental run failed for ${gw.repoName}:`,
          err instanceof Error ? err.message : String(err)
        );
      }
    })();
  };



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

  }
}





async function resolveRepoName(repoPath: string): Promise<string> {
  const normalized = path.resolve(repoPath);
  const entries = await listAnalyses();
  const match =
    entries.find(e => path.resolve(e.path) === normalized) ||
    entries.find(e => path.basename(e.path) === path.basename(normalized)) ||
    entries.find(e => e.name === path.basename(normalized));
  return match?.name || path.basename(normalized);
}






export async function installGauntletWatcher(repoPath: string): Promise<GauntletWatcher> {
  const normalized = path.resolve(repoPath);


  const existing = (await readWatchers()).find(
    w => path.resolve(w.repoPath) === normalized && w.enabled
  );
  if (existing) {
    runCounts.set(existing.id, existing.runs || 0);
    wireWatch(existing);
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


export async function stopGauntletWatcher(id: string): Promise<{ ok: boolean }> {
  const watchers = await readWatchers();
  const idx = watchers.findIndex(w => w.id === id);
  if (idx < 0) return { ok: false };

  const gw = watchers[idx];
  try {
    stopWatch(gw.watchId);
  } catch {

  }
  wiredWatchIds.delete(gw.watchId);

  watchers[idx] = { ...gw, enabled: false };
  await writeWatchers(watchers);
  return { ok: true };
}






export async function startInstalledWatchers(): Promise<{ started: number }> {
  const watchers = await readWatchers();
  let started = 0;

  for (const w of watchers) {
    if (!w.enabled) continue;
    try {
      if (!(await fs.pathExists(w.repoPath))) {

        console.warn(`[gauntlet-watcher] skip ${w.repoName}: path gone (${w.repoPath})`);
        continue;
      }

      const { watchId } = startWatch(w.repoPath);
      const refreshed: GauntletWatcher = { ...w, watchId };
      runCounts.set(refreshed.id, w.runs || 0);
      wireWatch(refreshed);


      const all = await readWatchers();
      const idx = all.findIndex(x => x.id === w.id);
      if (idx >= 0) {
        all[idx] = { ...all[idx], watchId };
        await writeWatchers(all);
      }
      started++;
    } catch (err) {

      console.error(
        `[gauntlet-watcher] failed to start watcher ${w.repoName}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  return { started };
}
