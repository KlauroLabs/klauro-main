#!/usr/bin/env -S npx tsx















import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  checkEdgeReferentialIntegrity,
  formatReferentialIntegrityReport,
  checkSourcePathIntegrity,
  formatSourcePathIntegrityReport,
} from '../../../packages/analyzer-core/src/analyzer/core/graph-referential-integrity';

function loadDocument(filePath: string): any {
  const raw = filePath.endsWith('.zst')


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
  const pathReport = checkSourcePathIntegrity(
    { nodes: cas?.nodes, entry_points: cas?.entry_points },
    cas?.system?.root_path
  );

  let exitCode = 0;

  if (report.ok) {
    process.stderr.write(`[graph-integrity-gate] ${formatReferentialIntegrityReport(report)}\n`);
  } else {
    process.stderr.write('ERROR: EDGE REFERENTIAL-INTEGRITY gate failed — the graph references ids that\n');
    process.stderr.write('       exist in no id-bearing collection, so every traversal and every count\n');
    process.stderr.write('       derived from it is wrong by that amount.\n\n');
    process.stderr.write(`${formatReferentialIntegrityReport(report)}\n\n`);
    process.stderr.write('       Fix at the producer named by the unresolved id scheme: either persist the\n');
    process.stderr.write('       row the edge references, or reconcile (repoint/drop) the edges when the row\n');
    process.stderr.write('       is legitimately removed. Never leave the reference behind.\n');
    exitCode = 1;
  }

  if (pathReport.ok) {
    process.stderr.write(`[graph-integrity-gate] ${formatSourcePathIntegrityReport(pathReport)}\n`);
  } else {
    process.stderr.write('ERROR: SOURCE-PATH REPO-RELATIVITY gate failed — a persisted file field is an\n');
    process.stderr.write('       absolute path under the analysis root, leaking the sandbox filesystem\n');
    process.stderr.write('       layout into customer-visible output.\n\n');
    process.stderr.write(`${formatSourcePathIntegrityReport(pathReport)}\n\n`);
    process.stderr.write('       Fix at the producer named above: normalise the path where it ENTERS the\n');
    process.stderr.write('       node (see repoRelativePathSegments / relativizeProjectPaths), not at each\n');
    process.stderr.write('       consumer that copies it.\n');
    exitCode = 1;
  }

  return exitCode;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  });
}
