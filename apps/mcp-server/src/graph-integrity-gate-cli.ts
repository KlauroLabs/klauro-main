#!/usr/bin/env -S npx tsx
/**
 * EDGE REFERENTIAL-INTEGRITY GATE over a REAL stored analysis.
 *
 * The invariant (see graph-referential-integrity.ts for why it exists and what
 * it caught): every edge endpoint must resolve in nodes ∪ exit_points ∪
 * entry_points. Point this at a stored analysis document and it exits non-zero
 * with a per-class breakdown naming the id scheme at fault, so a regression in
 * ANY producer — an analyzer inventing a target, or a pass dropping a row
 * without reconciling its references — is attributable without a re-run.
 *
 * Accepts a plain `.json` document or a zstd-compressed `.json.zst` one (the
 * stored form), and either a full analysis document or a bare CAS.
 *
 * Usage: tsx src/graph-integrity-gate-cli.ts <analysis.json|analysis.json.zst>
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  checkEdgeReferentialIntegrity,
  formatReferentialIntegrityReport,
} from '../../../packages/analyzer-core/src/analyzer/core/graph-referential-integrity';

function loadDocument(filePath: string): any {
  const raw = filePath.endsWith('.zst')
    // zstd is how the stored form is written; decoding through the same tool
    // avoids a dependency whose only job would be to read one file.
    ? execFileSync('zstd', ['-dc', filePath], { maxBuffer: 1024 * 1024 * 1024 })
    : fs.readFileSync(filePath);
  return JSON.parse(raw.toString('utf8'));
}

export async function main(argv: string[]): Promise<number> {
  const target = argv[0];
  if (!target) {
    process.stderr.write('usage: graph-integrity-gate-cli.ts <analysis.json|analysis.json.zst>\n');
    return 2;
  }
  const filePath = path.resolve(target);
  if (!fs.existsSync(filePath)) {
    process.stderr.write(`ERROR: no such analysis document: ${filePath}\n`);
    return 2;
  }

  const document = loadDocument(filePath);
  const cas = document?.cas ?? document;
  const report = checkEdgeReferentialIntegrity(cas?.edges, {
    nodes: cas?.nodes,
    entry_points: cas?.entry_points,
    exit_points: cas?.exit_points,
  });

  if (report.ok) {
    process.stderr.write(`[graph-integrity-gate] ${formatReferentialIntegrityReport(report)}\n`);
    return 0;
  }

  process.stderr.write('ERROR: EDGE REFERENTIAL-INTEGRITY gate failed — the graph references ids that\n');
  process.stderr.write('       exist in no id-bearing collection, so every traversal and every count\n');
  process.stderr.write('       derived from it is wrong by that amount.\n\n');
  process.stderr.write(`${formatReferentialIntegrityReport(report)}\n\n`);
  process.stderr.write('       Fix at the producer named by the unresolved id scheme: either persist the\n');
  process.stderr.write('       row the edge references, or reconcile (repoint/drop) the edges when the row\n');
  process.stderr.write('       is legitimately removed. Never leave the reference behind.\n');
  return 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  });
}
