/**
 * CLI entry point for the extractor differential-parity harness.
 *
 * `npm run parity:extractor` (from the repo root or packages/analyzer-core)
 * runs this. It prints the full categorized divergence report — the artifact
 * the extractor's author needs — and exits non-zero when any divergence is not
 * on the reviewed allowlist, so it is usable directly as a gate step.
 *
 * Flags:
 *   --root <dir>      corpus root (repeatable); defaults to this repo
 *   --limit <n>       cap the corpus after sorting (smoke runs only)
 *   --out <file>      also write the report to a file
 *   --max-examples <n>  examples shown per JSON path shape
 *   --quiet           suppress the progress line
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  formatReport,
  hashBaselineModule,
  pinnedBaselineHash,
  runExtractorParity,
} from './extractor-differential-parity';
import { defaultCorpus, enumerateCorpus } from './extractor-corpus';

function parseArgs(argv: string[]) {
  const roots: string[] = [];
  let limit: number | undefined;
  let out: string | undefined;
  let maxExamples = 3;
  let quiet = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') roots.push(path.resolve(argv[++i]));
    else if (arg === '--limit') limit = Number(argv[++i]);
    else if (arg === '--out') out = path.resolve(argv[++i]);
    else if (arg === '--max-examples') maxExamples = Number(argv[++i]);
    else if (arg === '--quiet') quiet = true;
  }
  return { roots, limit, out, maxExamples, quiet };
}

function main(): void {
  const { roots, limit, out, maxExamples, quiet } = parseArgs(process.argv.slice(2));

  const pinned = pinnedBaselineHash();
  const actualHash = hashBaselineModule();
  if (actualHash !== pinned.sha256) {
    console.error(
      `BASELINE TAMPERED: vendored pre-rewrite extractor hash ${actualHash} != pinned ${pinned.sha256}.\n` +
        'The baseline is frozen reference data. Revert the edit, or re-vendor from a named commit and update the pin in the same reviewed commit.',
    );
    process.exit(2);
  }

  const corpus =
    roots.length > 0
      ? enumerateCorpus({ roots, relativeTo: roots[0], limit })
      : defaultCorpus(limit);

  if (!quiet) {
    process.stderr.write(`corpus: ${corpus.length} files\n`);
  }

  let lastTick = 0;
  const result = runExtractorParity({
    corpus,
    onProgress: quiet
      ? undefined
      : (done, total) => {
          const now = Date.now();
          if (done === total || now - lastTick > 2000) {
            lastTick = now;
            process.stderr.write(`\r  ${done}/${total}   `);
          }
        },
  });
  if (!quiet) process.stderr.write('\n');

  const report = formatReport(result, maxExamples);
  console.log(report);
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${report}\n`, 'utf8');
    process.stderr.write(`report written to ${out}\n`);
  }

  process.exit(result.unallowed.length > 0 ? 1 : 0);
}

main();
