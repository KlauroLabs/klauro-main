/**
 * File-size ratchet — the gate that was missing while orchestrator.ts grew from
 * 23,103 lines (2026-07-05) to 33,441 (2026-08-11) without ever shrinking once.
 *
 * WHY A RATCHET AND NOT A LIMIT: a flat "no file over N lines" rule cannot be
 * turned on here — the worst file is 22× any sane N, so the gate would be red
 * from the first commit and would be disabled within a day. A ratchet is
 * enforceable immediately: every file's CURRENT size becomes its ceiling, so the
 * rule is only "no file gets worse". Extractions then lower ceilings, and the
 * lowered number is permanent because raising it fails the build.
 *
 * This is the step task #121 never had. Modules WERE extracted (system-type.ts,
 * deployable-evidence.ts, product-map.ts, journey-builder.ts are all real) but
 * they were additive: nothing stopped the god file growing faster than the
 * extractions drained it, and nobody measured the one number that defined
 * success. A ratchet makes that number impossible to ignore, because it is the
 * build failing rather than a report nobody reads.
 *
 * Deliberately counts LINES, not tokens or AST nodes: the number has to be
 * obvious to whoever sees the failure, and reproducible without parsing.
 */
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
  /** Files at least 10% under their ceiling — the ceiling should be lowered. */
  slack: Array<{ file: string; ceiling: number; actual: number }>;
  checked: number;
  /** Baseline entries whose file no longer exists (renamed/deleted). */
  missing: string[];
}

export const RATCHET_BASELINE_FILE = 'file-size-ratchet.json';

/** Count lines the same way `wc -l` does, so a human can verify a failure. */
export function countLines(contents: string): number {
  if (contents.length === 0) return 0;
  let lines = 0;
  for (let i = 0; i < contents.length; i += 1) if (contents[i] === '\n') lines += 1;
  // A trailing fragment with no newline is still a line to a reader.
  if (!contents.endsWith('\n')) lines += 1;
  return lines;
}

/**
 * Compare every baseline entry against the tree. Pure apart from reading the
 * files named in the baseline — it never writes, and it never walks the repo
 * looking for new files to police (adding a file to the ratchet is a deliberate
 * act, so a gate run cannot start failing because someone added a module).
 */
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
      // A baseline entry whose file is gone is reported, never silently passed:
      // "the file I was policing vanished" must not read as success.
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
