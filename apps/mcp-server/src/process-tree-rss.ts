import { execFileSync } from 'node:child_process';

export function processTreeRssBytesFromPs(output: string, rootPid: number): number {
  const rows = output.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    return match ? [{ pid: Number(match[1]), parentPid: Number(match[2]), rssKb: Number(match[3]) }] : [];
  });
  const processIds = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (processIds.has(row.parentPid) && !processIds.has(row.pid)) {
        processIds.add(row.pid);
        changed = true;
      }
    }
  }
  return rows
    .filter(row => processIds.has(row.pid))
    .reduce((total, row) => total + row.rssKb * 1024, 0);
}

export function sampleProcessTreeRss(rootPid: number): number {
  try {
    const output = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    return processTreeRssBytesFromPs(output, rootPid);
  } catch {
    return 0;
  }
}
