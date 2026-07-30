import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { writeCrossProcessAmbiguityFixture } from './cross-process-fixture';

/**
 * Regression coverage for docs/cas/DETERMINISM-BOUNDARY.md / CAS
 * SPECIFICATION.md §5.33: cross-file `references`-edge resolution must be
 * byte-identical across SEPARATE PROCESSES, not just separate in-process
 * calls. run-stability.test.ts's "resolves an identical cross-file
 * `references` edge set across independent runs" test proves in-process
 * stability (same V8 instance, same warmed caches, 6 iterations); it cannot
 * by construction catch a defect that depends on process-level async
 * scheduling (e.g. a raw glob()/readdir() I/O race whose timing looks
 * different across a fresh process's uncontended fs cache vs. a long-lived
 * process's warmed one). This test spawns genuinely fresh `node` child
 * processes — no shared module cache, no shared event loop — against the
 * SAME on-disk fixture and diffs their output.
 *
 * Historical context (see docs/cas/DETERMINISM-BOUNDARY.md for the full
 * archaeology): a 2026-07-07 audit documented an open defect where ambiguous
 * name resolution (same identifier declared in multiple files) depended on
 * async file-processing order, producing a small edge-count variance across
 * separate processes on a real ~24k-node repo. The same day, a few hours
 * later, commit a3b6e0c2 landed import-source-aware resolution with a stable
 * file/line/id tiebreak (typescript-javascript-analyzer.ts
 * selectDeclarationCandidate / compareNodesStable) — but the doc was never
 * revisited against that fix. This test is the cross-process proof the
 * archaeology called for: it does not by itself certify realistic-corpus
 * scale (thousands of files, the ~24k-node class the original defect was
 * measured on) — that remains open, see the doc.
 */
describe('cross-process reference-edge stability', () => {
  jest.setTimeout(180000);

  const RUNS = 5;
  const GROUPS = 12; // each group = a name declared in 3 different files (3-way ambiguity)
  const FILLERS = 150; // unrelated files, for real file-discovery/read concurrency surface

  let fixtureDir: string;
  const runnerPath = path.join(__dirname, 'cross-process-reference-runner.ts');
  const tsNodeRegister = require.resolve('ts-node/register/transpile-only');

  beforeAll(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-crossproc-ambiguity-'));
    writeCrossProcessAmbiguityFixture(fixtureDir, { groups: GROUPS, fillers: FILLERS });
  });

  afterAll(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  function runOnce(): { refSet: string[]; attributions: Record<string, string> } {
    const stdout = execFileSync(
      process.execPath,
      ['-r', tsNodeRegister, runnerPath, fixtureDir],
      { encoding: 'utf-8', env: { ...process.env }, maxBuffer: 64 * 1024 * 1024 },
    );
    return JSON.parse(stdout);
  }

  it(
    `produces a byte-identical references edge set across ${RUNS} separate cold node processes, ` +
      `on a fixture with genuine 3-way cross-file name ambiguity (${GROUPS} groups x 3 declarations)`,
    () => {
      const results = Array.from({ length: RUNS }, () => runOnce());

      // Sanity: the fixture must actually produce references edges and
      // attributions, otherwise every assertion below is vacuous.
      expect(results[0].refSet.length).toBeGreaterThan(0);
      expect(Object.keys(results[0].attributions).length).toBeGreaterThan(0);
      // 12 groups x 6 consumers = 72 attributed (consumer, group) pairs.
      expect(Object.keys(results[0].attributions).length).toBe(GROUPS * 6);

      const baseline = results[0];
      for (let i = 1; i < results.length; i++) {
        const added = results[i].refSet.filter((e) => !baseline.refSet.includes(e));
        const removed = baseline.refSet.filter((e) => !results[i].refSet.includes(e));
        if (added.length || removed.length) {
          // eslint-disable-next-line no-console
          console.error(
            `[cross-process references-edge nondeterminism] run ${i} vs run 0: ` +
              `+${added.length} / -${removed.length} edges. ` +
              `count ${baseline.refSet.length} -> ${results[i].refSet.length}. ` +
              `added=${JSON.stringify(added)} removed=${JSON.stringify(removed)}`,
          );
        }
        expect(results[i].refSet).toEqual(baseline.refSet);
        expect(results[i].attributions).toEqual(baseline.attributions);
      }
    },
  );

  it('attributes every ambiguous cross-file reference to the module actually imported from', () => {
    const expected = JSON.parse(
      fs.readFileSync(path.join(fixtureDir, 'expected-attributions.json'), 'utf-8'),
    ) as Record<string, string>;
    const result = runOnce();

    expect(Object.keys(result.attributions).length).toBe(Object.keys(expected).length);
    const misattributed = Object.entries(result.attributions).filter(
      ([key, module]) => expected[key] && expected[key] !== module,
    );
    expect(misattributed).toEqual([]);
  });
});
