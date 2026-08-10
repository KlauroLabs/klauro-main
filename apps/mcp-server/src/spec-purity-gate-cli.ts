#!/usr/bin/env -S npx tsx
/**
 * CLI entry for the evidence-derived spec-purity gate (see spec-purity-gate.ts
 * for the policy). Invoked by infrastructure/vps/deploy.sh before every
 * deploy; exits non-zero (and prints every violation) if any is found.
 *
 * Usage: tsx src/spec-purity-gate-cli.ts <repoRoot>
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { runSpecPurityGate } from './spec-purity-gate';
import { runVocabShapeGate, VOCAB_SHAPE_THRESHOLD, INLINE_ATTESTATION_MARKER } from './spec-purity-vocab-shapes';

/**
 * Directories the gate MUST be able to see for its result to mean anything.
 * The scan walker returns silently on an unreadable directory, so a wrong
 * repoRoot does not error — it produces an empty candidate set, which every
 * downstream check then reports as "clean".
 */
const REQUIRED_SCAN_ROOTS = ['packages/analyzer-core/src', 'apps/mcp-server/src', 'docs'];

/**
 * Refuses to report a verdict the gate did not actually compute.
 *
 * Observed 2026-08-10: run from `apps/mcp-server/` instead of the repo root,
 * this gate printed "names: clean — 16 names checked, 0 violations" and
 * "vocab-shapes: clean — 0 known large literal-array shape(s)" and exited 0 —
 * while the same commit run from the repo root found 408 shapes and a real
 * blocking name violation. `repoRoot` defaults to `process.cwd()`, so the
 * verdict silently depended on the caller's working directory.
 *
 * Two independent assertions, because either alone can be defeated:
 *  - the required scan roots must exist under the resolved repoRoot;
 *  - the shape scan must find at least as many candidates as the baseline
 *    grandfathered. The baseline is a floor by construction: every entry was
 *    derived from a shape that exists in the tree, so finding fewer means the
 *    scan missed files, not that debt was paid down. Deletions legitimately
 *    lower it, so the baseline must be regenerated in the same commit — which
 *    is the review step that keeps the floor honest.
 *
 * A gate that cannot prove it looked must fail, not pass. Silent-clean is the
 * worst possible failure mode for a deploy gate: it is indistinguishable from
 * success at exactly the moment it stops protecting anything.
 */
function assertGateActuallyScanned(repoRoot: string, shapeCandidateCount: number): string[] {
  const problems: string[] = [];

  for (const rel of REQUIRED_SCAN_ROOTS) {
    if (!fs.existsSync(path.join(repoRoot, rel))) {
      problems.push(`required scan root missing under repoRoot: ${rel}`);
    }
  }

  const baselinePath = path.join(repoRoot, 'apps/mcp-server/src/spec-purity-vocab-baseline.json');
  let baselineCount = 0;
  try {
    baselineCount = (JSON.parse(fs.readFileSync(baselinePath, 'utf8')).entries || []).length;
  } catch {
    problems.push(`vocab-shape baseline unreadable at ${baselinePath}`);
  }
  if (baselineCount > 0 && shapeCandidateCount < baselineCount) {
    problems.push(
      `vocab-shape scan found ${shapeCandidateCount} shape(s) but the baseline grandfathered ` +
        `${baselineCount} — the scan did not see the whole tree (or the baseline needs regenerating ` +
        `in this commit if shapes were deleted).`,
    );
  }

  return problems;
}

export async function main(argv: string[]): Promise<number> {
  const repoRoot = path.resolve(argv[0] || process.cwd());
  const [nameResult, shapeResult] = await Promise.all([
    runSpecPurityGate(repoRoot),
    runVocabShapeGate(repoRoot),
  ]);

  let failed = false;

  const coverageProblems = assertGateActuallyScanned(repoRoot, shapeResult.candidates.length);
  if (coverageProblems.length) {
    failed = true;
    process.stderr.write('ERROR: SPEC-PURITY gate could not prove it scanned the repository — its verdict\n');
    process.stderr.write('       below is NOT trustworthy and is being treated as a failure.\n\n');
    process.stderr.write(`  resolved repoRoot: ${repoRoot}\n`);
    for (const problem of coverageProblems) process.stderr.write(`  - ${problem}\n`);
    process.stderr.write('\n       Pass the repo root explicitly: tsx apps/mcp-server/src/spec-purity-gate-cli.ts <repoRoot>\n\n');
  }

  if (nameResult.ok) {
    process.stderr.write(
      `[spec-purity-gate] names: clean — ${nameResult.forbiddenNames.length} evidence-derived name(s) checked, 0 violations.\n`,
    );
  } else {
    failed = true;
    process.stderr.write('ERROR: SPEC-PURITY gate failed — benchmark/client corpus names found in specs or\n');
    process.stderr.write('       product source (rule: spec/doctrine and product source must be\n');
    process.stderr.write('       product-agnostic — move corpus references to benchmark records or fixtures).\n\n');
    for (const violation of nameResult.violations) {
      process.stderr.write(
        `  ${violation.file}:${violation.line}: [${violation.reason}] "${violation.name}" — ${violation.text}\n`,
      );
    }
    process.stderr.write('\n       Fix by rewording the offending comments/docs generically, or by moving the\n');
    process.stderr.write('       corpus-specific detail into a test/fixture/gauntlet/bench/corpus path (which\n');
    process.stderr.write('       this gate excludes).\n\n');
  }

  if (shapeResult.ok) {
    process.stderr.write(
      `[spec-purity-gate] vocab-shapes: clean — ${shapeResult.candidates.length} known large literal-array shape(s), 0 new/unreviewed.\n`,
    );
  } else {
    failed = true;
    process.stderr.write('ERROR: SPEC-PURITY gate failed — a NEW large literal string array/Set was added\n');
    process.stderr.write(`       to product source (>= ${VOCAB_SHAPE_THRESHOLD} string literals) with no baseline entry and no\n`);
    process.stderr.write('       inline attestation. This is the SHAPE a hardcoded brand/keyword/domain\n');
    process.stderr.write('       categorizer takes — the cardinal rule is deterministic structural facts +\n');
    process.stderr.write('       AI interpretation, never a hardcoded vocabulary table.\n\n');
    for (const violation of shapeResult.newViolations) {
      process.stderr.write(
        `  ${violation.file}:${violation.line}: const ${violation.name} (${violation.count} literals) — e.g. ${violation.sample.slice(0, 4).join(', ')}\n`,
      );
    }
    process.stderr.write('\n       If this list is real closed vocabulary (language keywords, file extensions,\n');
    process.stderr.write('       a dependency-manifest signature table checked against real import/package\n');
    process.stderr.write(`       evidence, a closed output taxonomy) — add a comment within a few lines above\n`);
    process.stderr.write(`       the declaration containing the marker "${INLINE_ATTESTATION_MARKER}" explaining why.\n`);
    process.stderr.write('       If it is a business/domain keyword bag deciding a classification, replace it\n');
    process.stderr.write('       with real evidence (see capability-audience-test.ts for the pattern).\n\n');
  }

  if (!failed) return 0;
  process.stderr.write('Refusing to deploy.\n');
  return 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  });
}
