import * as fs from 'fs-extra';
import * as path from 'path';

export interface ProofReportEntry<T extends Record<string, any>> {
  path: string;
  report: T;
}

export async function discoverProofReports<T extends Record<string, any>>(
  directory: string,
  accepts: (report: T) => boolean,
): Promise<Array<ProofReportEntry<T>>> {
  if (!(await fs.pathExists(directory))) return [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return discoverProofReports(absolute, accepts);
    if (!entry.isFile() || path.extname(entry.name) !== '.json') return [];
    try {
      const report = await fs.readJson(absolute) as T;
      return accepts(report) ? [{ path: absolute, report }] : [];
    } catch {
      return [];
    }
  }));
  return nested.flat();
}

export function proofReportTimestamp(report: Record<string, any>): number {
  for (const value of [report.execution_generated_at, report.generated_at, report.rescored_at]) {
    const timestamp = Date.parse(String(value || ''));
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}
