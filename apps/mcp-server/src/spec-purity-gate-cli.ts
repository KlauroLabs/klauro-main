#!/usr/bin/env -S npx tsx
/**
 * CLI entry for the evidence-derived spec-purity gate (see spec-purity-gate.ts
 * for the policy). Invoked by infrastructure/vps/deploy.sh before every
 * deploy; exits non-zero (and prints every violation) if any is found.
 *
 * Usage: tsx src/spec-purity-gate-cli.ts <repoRoot>
 */
import path from 'node:path';
import process from 'node:process';
import { runSpecPurityGate } from './spec-purity-gate';
import { runVocabShapeGate, VOCAB_SHAPE_THRESHOLD, INLINE_ATTESTATION_MARKER } from './spec-purity-vocab-shapes';

export async function main(argv: string[]): Promise<number> {
  const repoRoot = path.resolve(argv[0] || process.cwd());
  const [nameResult, shapeResult] = await Promise.all([
    runSpecPurityGate(repoRoot),
    runVocabShapeGate(repoRoot),
  ]);

  let failed = false;

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
