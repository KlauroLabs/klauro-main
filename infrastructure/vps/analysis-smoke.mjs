/**
 * POST-DEPLOY ANALYSIS SMOKE TEST — runs INSIDE the api container.
 *
 * Why this exists: /health and /dist checks are liveness probes, not
 * correctness probes. On 2026-07-16 a deploy shipped a torn orchestrator.ts
 * (rsynced while a concurrent editor was mid-write) whose analysis path
 * referenced `entryPointsWithContractAndCapability` with no definition in
 * scope. Every hosted analyze/reanalyze died with a ReferenceError — while
 * /health returned 200 and the deploy reported success. 100% of analyses were
 * broken for hours and nothing caught it.
 *
 * A ReferenceError inside a function body does NOT fire on module import, so
 * merely loading the orchestrator proves nothing: the smoke must actually RUN
 * an analysis end-to-end and assert it produced real nodes.
 *
 * Deliberately AI-OFF: the AI pass is non-deterministic, needs a provider, and
 * is irrelevant here — the deterministic structural path is what a torn file
 * breaks, and it must stay fast enough to gate every deploy.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP = '/app/apps/mcp-server/src/analyzer.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-deploy-smoke-'));
try {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'klauro-deploy-smoke', version: '1.0.0' }));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  // A tiny but REAL shape: a class + an exported function, so the structural
  // pipeline (nodes -> entry points -> the contract/capability derivation the
  // torn file broke) actually executes rather than short-circuiting on empty.
  fs.writeFileSync(
    path.join(dir, 'src', 'service.ts'),
    [
      'export class SmokeService {',
      '  handle(input: string): string { return input.toUpperCase(); }',
      '}',
      'export function smokeEntry(): string {',
      '  return new SmokeService().handle("ok");',
      '}',
      '',
    ].join('\n'),
  );

  const { analyzeProject } = await import(APP);
  const started = Date.now();
  const output = await analyzeProject(dir, 'klauro-deploy-smoke');
  const nodes = (output?.nodes || []).length;
  const elapsed = Date.now() - started;

  if (nodes < 1) {
    console.error(`ANALYSIS SMOKE FAIL: analysis completed but produced ${nodes} nodes (expected > 0).`);
    console.error('The deployed analyzer is broken even though /health is green.');
    process.exit(1);
  }

  // REFERENTIAL INTEGRITY over the analysis just produced. Liveness and a
  // node count do not catch a graph that points at rows which do not exist: a
  // stored analysis once carried 16.9% of its edges referencing ids present in
  // no id-bearing collection, self-reported in validation and gated by nothing.
  // Asserted here because this is the one deploy step that runs a REAL
  // analysis end to end.
  const { checkEdgeReferentialIntegrity, formatReferentialIntegrityReport } = await import(
    '/app/packages/analyzer-core/src/analyzer/core/graph-referential-integrity.ts'
  );
  const integrity = checkEdgeReferentialIntegrity(output?.edges, {
    nodes: output?.nodes,
    entry_points: output?.entry_points,
    exit_points: output?.exit_points,
  });
  if (!integrity.ok) {
    console.error('ANALYSIS SMOKE FAIL: edge referential integrity violated.');
    console.error(formatReferentialIntegrityReport(integrity));
    process.exit(1);
  }

  console.log(`analysis smoke OK — ${nodes} nodes in ${elapsed}ms; ${formatReferentialIntegrityReport(integrity)}`);
} catch (error) {
  // A torn/partial deploy surfaces HERE (e.g. ReferenceError: X is not defined).
  console.error(`ANALYSIS SMOKE FAIL: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error && error.stack) console.error(error.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
