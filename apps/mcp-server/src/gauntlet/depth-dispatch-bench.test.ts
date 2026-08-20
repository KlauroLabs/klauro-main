import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDepthDispatchReport, __resetDepthDispatchCache } from './depth-dispatch-bench';
import { startCodebaseMemoryDaemon, type CodebaseMemoryDaemonLease } from './real-camp-arms';

let daemon: CodebaseMemoryDaemonLease | null = null;

before(() => {
  daemon = startCodebaseMemoryDaemon();
});

after(() => {
  daemon?.close();
});

test('DEPTH-4 dispatch: Klauro never strictly loses to codebase-memory on impl resolution', async () => {
  __resetDepthDispatchCache();
  const report = await buildDepthDispatchReport();

  if (!report.available) {
    // Skip-guard: codebase-memory binary not installed in this environment.
    console.warn('[depth-dispatch] codebase-memory-mcp not installed — skipping head-to-head.');
    return;
  }

  assert.ok(report.results.length >= 3, 'expected at least 3 dispatch fixtures');

  // Per-case table (always printed for transparency).
  for (const r of report.results) {
    console.log(
      `[${r.fixture}] lang=${r.language} lsp=${r.lspLang} verdict=${r.verdict} ` +
        `| Klauro F1=${r.klauroF1.toFixed(2)} {${r.klauroImpls.join(', ') || '-'}} ` +
        `| cbm F1=${r.cbmF1.toFixed(2)} {${r.cbmImpls.join(', ') || '-'}} ` +
        `| decoyExcluded=${r.decoyExcludedByKlauro}`,
    );
    console.log(`    Klauro: ${r.klauroHow}`);
    console.log(`    cbm:    ${r.cbmHow}`);
  }

  // HONESTY ASSERTION 1: no strict losses. If cbm out-resolves Klauro on any
  // case, NAME it and leave this RED — that is the true signal to deepen Klauro.
  const losses = report.results.filter(r => r.verdict === 'loss');
  assert.equal(
    losses.length,
    0,
    `Klauro LOST (cbm strictly out-resolved) on: ${losses
      .map(l => `${l.fixture} (Klauro ${l.klauroF1.toFixed(2)} < cbm ${l.cbmF1.toFixed(2)}; cbm=${l.cbmImpls.join(', ')})`)
      .join(' | ')}`,
  );

  // HONESTY ASSERTION 2: Klauro F1 >= cbm F1 per case (tie at ceiling or win).
  for (const r of report.results) {
    assert.ok(
      r.klauroF1 >= r.cbmF1 - 1e-9,
      `${r.fixture}: Klauro F1 ${r.klauroF1.toFixed(2)} < cbm F1 ${r.cbmF1.toFixed(2)}`,
    );
  }

  // Aggregate sanity.
  assert.equal(report.aggregate.losses, 0);
  assert.ok(report.aggregate.strictWinRate >= 0 && report.aggregate.strictWinRate <= 1);
  assert.equal(report.aggregate.nonLossRate, 1);
});

test('DEPTH-4 dispatch: Klauro excludes the same-named decoy on every case', async () => {
  const report = await buildDepthDispatchReport();
  if (!report.available) return;
  for (const r of report.results) {
    assert.ok(r.decoyExcludedByKlauro, `${r.fixture}: Klauro wrongly included the decoy class`);
  }
});
