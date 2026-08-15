












import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  RATCHET_BASELINE_FILE,
  checkRatchet,
  countLines,
  findOversizedProductionSources,
  formatRatchetFailure,
  formatRatchetSlack,
  type RatchetEntry,
} from './file-size-ratchet-gate';







function trackedFiles(repoRoot: string, extra: string[]): string[] {
  const existing = fs.existsSync(baselinePath(repoRoot))
    ? ((JSON.parse(fs.readFileSync(baselinePath(repoRoot), 'utf8')) as { files?: RatchetEntry[] }).files || []).map(entry => entry.file)
    : [];
  const oversized = findOversizedProductionSources(repoRoot).map(entry => entry.file);
  return Array.from(new Set([...existing, ...oversized, ...extra.map(value => path.relative(repoRoot, path.resolve(repoRoot, value)))]));
}

function baselinePath(repoRoot: string): string {
  return path.join(repoRoot, RATCHET_BASELINE_FILE);
}

function adopt(repoRoot: string, extra: string[]): void {
  const entries: RatchetEntry[] = [];
  for (const file of trackedFiles(repoRoot, extra)) {
    const absolute = path.join(repoRoot, file);
    if (!fs.existsSync(absolute)) {
      console.error(`  skipped (not found): ${file}`);
      continue;
    }
    entries.push({ file, ceiling: countLines(fs.readFileSync(absolute, 'utf8')) });
  }
  entries.sort((left, right) => right.ceiling - left.ceiling);
  fs.writeFileSync(
    baselinePath(repoRoot),
    `${JSON.stringify({ note: 'Ceilings may only go DOWN. See apps/mcp-server/src/file-size-ratchet-gate.ts', files: entries }, null, 2)}\n`,
  );
  const total = entries.reduce((sum, entry) => sum + entry.ceiling, 0);
  console.log(`Recorded ${entries.length} ceilings (${total} lines total) in ${RATCHET_BASELINE_FILE}`);
}

function main(): void {
  const repoRoot = path.resolve(process.argv[2] || process.cwd());
  if (process.argv.includes('--adopt')) {
    adopt(repoRoot, process.argv.slice(3).filter(arg => !arg.startsWith('--')));
    return;
  }

  const file = baselinePath(repoRoot);
  if (!fs.existsSync(file)) {
    console.error(`ERROR: FILE-SIZE RATCHET baseline missing at ${file}`);
    console.error('Run with --adopt to record the current sizes. Refusing to pass a check that never ran.');
    process.exit(1);
  }

  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { files?: RatchetEntry[] };
  const baseline = parsed.files || [];
  if (baseline.length === 0) {
    console.error('ERROR: FILE-SIZE RATCHET baseline is empty — it would pass everything. Run --adopt.');
    process.exit(1);
  }
  const registered = new Set(baseline.map(entry => entry.file));
  const unregistered = findOversizedProductionSources(repoRoot).filter(entry => !registered.has(entry.file));
  if (unregistered.length > 0) {
    console.error(`ERROR: FILE-SIZE RATCHET found ${unregistered.length} oversized production file(s) without ceilings:`);
    for (const entry of unregistered) console.error(`  ${entry.file}: ${entry.ceiling} lines`);
    console.error(`Refactor below the threshold or add the file with --adopt; ${RATCHET_BASELINE_FILE} ceilings may only decrease afterward.`);
    process.exit(1);
  }

  const result = checkRatchet(repoRoot, baseline);
  if (result.checked === 0) {
    console.error('ERROR: FILE-SIZE RATCHET checked 0 files (wrong repo root?). A check that proved nothing is a failure.');
    process.exit(1);
  }
  if (result.missing.length > 0) {
    console.error(`ERROR: FILE-SIZE RATCHET has ${result.missing.length} baseline file(s) that no longer exist:`);
    for (const name of result.missing) console.error(`  ${name}`);
    console.error(`If a file was renamed or intentionally removed, update ${RATCHET_BASELINE_FILE}.`);
    process.exit(1);
  }
  if (result.violations.length > 0) {
    console.error(`ERROR: FILE-SIZE RATCHET — ${result.violations.length} file(s) grew past their ceiling:`);
    console.error(formatRatchetFailure(result));
    process.exit(1);
  }

  console.log(`  file-size ratchet ok (${result.checked} files within ceilings)`);
  if (result.slack.length > 0) {
    console.log(`  ${result.slack.length} file(s) now well under ceiling — lower them to make the win permanent:`);
    console.log(formatRatchetSlack(result));
  }
}

main();
