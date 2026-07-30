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

export async function main(argv: string[]): Promise<number> {
  const repoRoot = path.resolve(argv[0] || process.cwd());
  const result = await runSpecPurityGate(repoRoot);

  if (result.ok) {
    process.stderr.write(
      `[spec-purity-gate] clean — ${result.forbiddenNames.length} evidence-derived name(s) checked, 0 violations.\n`,
    );
    return 0;
  }

  process.stderr.write('ERROR: SPEC-PURITY gate failed — benchmark/client corpus names found in specs or\n');
  process.stderr.write('       product source (rule: spec/doctrine and product source must be\n');
  process.stderr.write('       product-agnostic — move corpus references to benchmark records or fixtures).\n\n');
  for (const violation of result.violations) {
    process.stderr.write(
      `  ${violation.file}:${violation.line}: [${violation.reason}] "${violation.name}" — ${violation.text}\n`,
    );
  }
  process.stderr.write('\n       Fix by rewording the offending comments/docs generically, or by moving the\n');
  process.stderr.write('       corpus-specific detail into a test/fixture/gauntlet/bench/corpus path (which\n');
  process.stderr.write('       this gate excludes). Refusing to deploy.\n');
  return 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  });
}
