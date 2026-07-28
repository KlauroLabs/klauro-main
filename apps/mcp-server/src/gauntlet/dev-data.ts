/**
 * The ONE explicit dev-data dir for dev tooling (corpus harnesses, benches,
 * gauntlets): ~/.klauro/dev. Everything under it is regenerable scratch that
 * is safe to delete wholesale — corpus clones, bench-seeded analyses. Dev
 * tooling that persists anything durable writes HERE (never the user's real
 * store, never the repo tree); each run prints the dir's size on exit so
 * growth stays visible instead of silently accumulating (the old behavior
 * grew ~/.klauro/analyses to 29GB from corpus sweeps).
 */

import { execFileSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';

export function devDataRoot(): string {
  return path.join(os.homedir(), '.klauro', 'dev');
}

let exitReportRegistered = false;

/** Print `du -sh ~/.klauro/dev` once at process exit (best-effort, dev-only). */
export function reportDevDataDirSizeOnExit(): void {
  if (exitReportRegistered) return;
  exitReportRegistered = true;
  process.once('exit', () => {
    try {
      const out = execFileSync('du', ['-sh', devDataRoot()], { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
      console.error(`[klauro dev-data] ${out}  (regenerable scratch — safe to delete)`);
    } catch {
      // dir may not exist yet, or no `du` — nothing worth failing over
    }
  });
}
