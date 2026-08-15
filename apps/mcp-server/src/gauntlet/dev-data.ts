









import { execFileSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';

export function devDataRoot(): string {
  return path.join(os.homedir(), '.klauro', 'dev');
}

let exitReportRegistered = false;


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

    }
  });
}
