/**
 * CLI for the file-size ratchet (see file-size-ratchet-gate.ts). Invoked from
 * infrastructure/vps/deploy.sh alongside the spec-purity gate.
 *
 *   npx tsx src/file-size-ratchet-gate-cli.ts <repoRoot>            # check
 *   npx tsx src/file-size-ratchet-gate-cli.ts <repoRoot> --adopt    # (re)record
 *
 * --adopt writes every tracked file's current size as its ceiling. It is how the
 * baseline is created and how a deliberate ceiling change is made; it is never
 * run by the gate itself, because a gate that can rewrite its own expectations
 * is not a gate. Same lesson as the spec-purity gate's assertGateActuallyScanned:
 * a check must fail when it cannot prove it checked.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  RATCHET_BASELINE_FILE,
  checkRatchet,
  countLines,
  formatRatchetFailure,
  formatRatchetSlack,
  type RatchetEntry,
} from './file-size-ratchet-gate';

// The files the ratchet polices. Explicit, because the point is to hold the
// worst offenders and the modules extracted from them — not to police every
// file in the repo, which would make the gate noisy and get it switched off.
const TRACKED: string[] = [
  'packages/analyzer-core/src/analyzer/core/orchestrator.ts',
  'packages/analyzer-core/src/analyzer/core/flow-concepts.ts',
  'packages/analyzer-core/src/analyzer/core/tree-sitter-ts-extractor.ts',
  'packages/analyzer-core/src/analyzer/core/language-spec.ts',
  'packages/analyzer-core/src/analyzer/core/journey-builder.ts',
  'packages/analyzer-core/src/analyzer/core/idiom-detector.ts',
  'packages/analyzer-core/src/analyzer/core/domain-extractor.ts',
  'packages/analyzer-core/src/analyzer/core/base-analyzer.ts',
  'packages/analyzer-core/src/analyzer/core/product-map.ts',
  'packages/analyzer-core/src/analyzer/core/change-detector.ts',
  'packages/analyzer-core/src/analyzer/core/deployable-evidence.ts',
  'packages/analyzer-core/src/analyzer/core/system-type.ts',
];

function baselinePath(repoRoot: string): string {
  return path.join(repoRoot, RATCHET_BASELINE_FILE);
}

function adopt(repoRoot: string): void {
  const entries: RatchetEntry[] = [];
  for (const file of TRACKED) {
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
    adopt(repoRoot);
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
