




















import * as fs from 'node:fs';
import * as path from 'node:path';

export interface RatchetEntry {
  file: string;
  ceiling: number;
}

export interface RatchetViolation {
  file: string;
  ceiling: number;
  actual: number;
}

export interface RatchetResult {
  violations: RatchetViolation[];

  slack: Array<{ file: string; ceiling: number; actual: number }>;
  checked: number;

  missing: string[];
}

export const RATCHET_BASELINE_FILE = 'file-size-ratchet.json';
export const OVERSIZED_SOURCE_THRESHOLD = 1000;
export const PRODUCTION_SOURCE_ROOTS = [
  'apps/mcp-server/src',
  'packages/analyzer-core/src',
  'packages/klauro-sdk-js/src',
  'packages/klauro-sdk-py/src',
];


export function countLines(contents: string): number {
  if (contents.length === 0) return 0;
  let lines = 0;
  for (let i = 0; i < contents.length; i += 1) if (contents[i] === '\n') lines += 1;

  if (!contents.endsWith('\n')) lines += 1;
  return lines;
}

export function findOversizedProductionSources(
  repoRoot: string,
  threshold = OVERSIZED_SOURCE_THRESHOLD,
): RatchetEntry[] {
  const entries: RatchetEntry[] = [];
  const extensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py']);
  const rejectedSegments = new Set(['node_modules', 'dist', 'build', 'target', 'fixtures', '__tests__', 'test-data', 'test-fixtures']);
  const visit = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!rejectedSegments.has(entry.name)) visit(absolute);
        continue;
      }
      if (!entry.isFile() || !extensions.has(path.extname(entry.name).toLowerCase())) continue;
      if (/\.(?:test|spec)\.[^.]+$/.test(entry.name)) continue;
      const ceiling = countLines(fs.readFileSync(absolute, 'utf8'));
      if (ceiling > threshold) entries.push({ file: path.relative(repoRoot, absolute), ceiling });
    }
  };
  for (const root of PRODUCTION_SOURCE_ROOTS) visit(path.join(repoRoot, root));
  return entries.sort((left, right) => right.ceiling - left.ceiling || left.file.localeCompare(right.file));
}







export function checkRatchet(repoRoot: string, baseline: RatchetEntry[]): RatchetResult {
  const violations: RatchetViolation[] = [];
  const slack: RatchetResult['slack'] = [];
  const missing: string[] = [];
  let checked = 0;

  for (const entry of baseline) {
    const absolute = path.join(repoRoot, entry.file);
    let contents: string;
    try {
      contents = fs.readFileSync(absolute, 'utf8');
    } catch {


      missing.push(entry.file);
      continue;
    }
    checked += 1;
    const actual = countLines(contents);
    if (actual > entry.ceiling) {
      violations.push({ file: entry.file, ceiling: entry.ceiling, actual });
    } else if (actual <= Math.floor(entry.ceiling * 0.9)) {
      slack.push({ file: entry.file, ceiling: entry.ceiling, actual });
    }
  }

  return { violations, slack, checked, missing };
}

export function formatRatchetFailure(result: RatchetResult): string {
  const lines: string[] = [];
  for (const violation of result.violations) {
    const over = violation.actual - violation.ceiling;
    lines.push(`  ${violation.file}: ${violation.actual} lines, ceiling ${violation.ceiling} (+${over})`);
  }
  lines.push('');
  lines.push('A file may not grow past its recorded ceiling. Options, in order of preference:');
  lines.push('  1. Put the new code in a module of its own (this is almost always the right answer).');
  lines.push('  2. Extract something else out of the file first, then lower its ceiling in the same commit.');
  lines.push(`  3. If growth is genuinely unavoidable, raise the ceiling in ${RATCHET_BASELINE_FILE} and say why in the commit message.`);
  return lines.join('\n');
}

export function formatRatchetSlack(result: RatchetResult): string {
  return result.slack
    .map(item => `  ${item.file}: ${item.actual} lines, ceiling still ${item.ceiling} — lower it to lock the win in`)
    .join('\n');
}
