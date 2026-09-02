import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Cold-customer feedback (2026-07-06): `klauro status` and `klauro doctor`
 * disagreed about analysis completion for ~2 minutes — one said done, the
 * other not. Root cause: `status` (and the auto-refresh gate in cli.ts
 * loadOrAnalyze) decide freshness via freshness.ts's summarizeAnalysisFreshness
 * (git-diff based), while `doctor` (agent-doctor.ts) decided freshness via the
 * INDEPENDENT getAnalysisFreshness (mtime-glob based) — two different
 * algorithms over two different file sets that can disagree in the
 * populating-to-ready window. agent-doctor.ts now reconciles: when the shared
 * summarizeAnalysisFreshness disagrees with the mtime-glob status, it defers
 * to the shared check, so `doctor` never contradicts `status`.
 */
function withTempStorage(run: (storageDir: string) => void | Promise<void>): Promise<void> | void {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-doctor-status-storage-'));
  const previous = process.env.KLAURO_STORAGE_PATH;
  process.env.KLAURO_STORAGE_PATH = storageDir;
  const cleanup = () => {
    process.env.KLAURO_STORAGE_PATH = previous;
    fs.rmSync(storageDir, { recursive: true, force: true });
  };
  try {
    const result = run(storageDir);
    if (result && typeof (result as Promise<void>).finally === 'function') {
      return (result as Promise<void>).finally(cleanup);
    }
    cleanup();
    return result;
  } catch (error) {
    cleanup();
    throw error;
  }
}

function withTempRepo(run: (root: string) => void | Promise<void>): Promise<void> | void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-doctor-status-repo-'));
  const result = run(dir);
  if (result && typeof (result as Promise<void>).finally === 'function') {
    return (result as Promise<void>).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

function initGitRepo(root: string): void {
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git(['init']);
  git(['-c', 'user.email=test@klauro.dev', '-c', 'user.name=Klauro Test', '-c', 'commit.gpgsign=false', 'add', '.']);
  git(['-c', 'user.email=test@klauro.dev', '-c', 'user.name=Klauro Test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);
}

function setMtime(file: string, whenMs: number): void {
  fs.utimesSync(file, new Date(whenMs), new Date(whenMs));
}

function fixtureCas(root: string, analyzedAt: string): CASOutput {
  return {
    cas_version: '1.11.0',
    analysis_timestamp: analyzedAt,
    analysis_id: 'analysis_doctor_status_test',
    system: {
      name: 'Doctor Status Fixture',
      type: 'api',
      description: 'Fixture service for doctor/status agreement tests',
      root_path: root,
      technologies: { languages: [{ name: 'TypeScript', percentage: 100 }], frameworks: [], databases: [] },
    },
    nodes: [
      { id: 'svc', name: 'Service', type: 'service', source: { file: 'src/index.ts', line: 1 } },
    ],
    edges: [],
    entry_points: [],
    exit_points: [],
    analyzer_contributions: [{ analyzer_name: 'fixture', nodes_created: 1, edges_created: 0 }],
  } as unknown as CASOutput;
}

test('doctor freshness status agrees with status/summarizeAnalysisFreshness when a source file changed after analysis', async () => {
  await withTempStorage(async () => {
    await withTempRepo(async root => {
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      const indexFile = path.join(root, 'src', 'index.ts');
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture' }));
      fs.writeFileSync(indexFile, 'export const app = true;\n');
      initGitRepo(root);
      const analyzedAt = new Date(Date.now() - HOUR_MS).toISOString();
      setMtime(indexFile, Date.now() - 2 * HOUR_MS);

      const { clearFreshnessSummaryCache, summarizeAnalysisFreshness } = await import('./freshness');
      const { saveAnalysis } = await import('./storage');
      const { getAgentDoctor } = await import('./agent-doctor');

      const cas = fixtureCas(root, analyzedAt);
      await saveAnalysis(root, cas);

      // Change a source file AFTER the recorded analysis timestamp — this is
      // exactly the signal `status` uses (git-diff based) to call the repo
      // non-fresh/aging.
      fs.appendFileSync(indexFile, '// changed after analysis\n');

      clearFreshnessSummaryCache();
      const statusView = summarizeAnalysisFreshness(root, cas.analysis_timestamp);
      assert.ok(statusView);
      assert.notEqual(statusView!.staleness, 'fresh', 'precondition: status must see this as non-fresh');

      const doctorView = await getAgentDoctor(cas, root);
      const freshnessCheck = doctorView.checks.find(check => check.id === 'freshness');
      assert.ok(freshnessCheck, 'doctor report includes a freshness check');

      // The two surfaces must never contradict: if status says non-fresh,
      // doctor's freshness check must not report a clean pass.
      assert.notEqual(freshnessCheck!.status, 'pass',
        `doctor reported freshness=pass while status/summarizeAnalysisFreshness reported staleness=${statusView!.staleness} — status and doctor disagree`);
      assert.equal(doctorView.freshness.status, 'stale');
    });
  });
});

test('a CAS still populating (layers_ready.complete=false) is reported as incomplete by BOTH doctor and the same manifest klauro status reads', async () => {
  // This is the actual reported scenario: an analysis mid-flight (some layers
  // still 'pending') is real and queryable, but not fully ready. `doctor` must
  // report it as not-agent-context-ready, and the layers_ready manifest it
  // reads must be the identical shape `klauro status`'s repo_analysis_complete
  // is derived from (cli.ts runStatusCommand) — so a caller checking either
  // command sees the same "still populating" signal, never one saying done
  // while the other says not-yet.
  await withTempStorage(async () => {
    await withTempRepo(async root => {
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture' }));
      fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export const app = true;\n');
      initGitRepo(root);
      const analyzedAt = new Date().toISOString();

      const { saveAnalysis } = await import('./storage');
      const { getAgentDoctor } = await import('./agent-doctor');

      const cas = fixtureCas(root, analyzedAt);
      (cas as any).layers_ready = {
        layers: [
          { layer: 'L0', name: 'inventory', status: 'ready', fields: ['l0_index'] },
          { layer: 'L1', name: 'structure', status: 'ready', fields: ['nodes', 'edges'] },
          { layer: 'L5', name: 'ai-enrichment', status: 'pending', fields: ['descriptions'] },
        ],
        complete: false,
        generated_at: analyzedAt,
      };
      await saveAnalysis(root, cas);

      // Same manifest shape klauro status's runStatusCommand reads off the
      // loaded CAS to derive repo_analysis_complete.
      const statusAnalysisComplete = !cas.layers_ready || (cas.layers_ready as any).complete !== false;
      assert.equal(statusAnalysisComplete, false, 'status must see this analysis as still populating');

      const doctorView = await getAgentDoctor(cas, root, { assumeFresh: true });
      const layersCheck = doctorView.checks.find(check => check.id === 'layers-complete');
      assert.ok(layersCheck, 'doctor report includes a layers-complete check');
      assert.notEqual(layersCheck!.status, 'pass', 'doctor must not report layers-complete=pass while layers_ready.complete=false');
      assert.equal(doctorView.agent_context_ready, false, 'doctor must not claim agent-context-ready while layers are still populating');
    });
  });
});

test('a CAS without a readiness manifest is never reported as complete or agent-context-ready', async () => {
  await withTempStorage(async () => {
    await withTempRepo(async root => {
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture' }));
      fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export const app = true;\n');
      initGitRepo(root);

      const { getAgentDoctor } = await import('./agent-doctor');
      const cas = fixtureCas(root, new Date().toISOString());
      delete cas.layers_ready;

      const doctorView = await getAgentDoctor(cas, root, { assumeFresh: true });
      const layersCheck = doctorView.checks.find(check => check.id === 'layers-complete');

      assert.equal(layersCheck?.status, 'fail');
      assert.equal(layersCheck?.detail, 'Analysis readiness manifest is missing');
      assert.equal(doctorView.agent_context_ready, false);
    });
  });
});
test('doctor freshness status agrees with status when nothing changed since analysis (both fresh)', async () => {
  await withTempStorage(async () => {
    await withTempRepo(async root => {
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      const indexFile = path.join(root, 'src', 'index.ts');
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture' }));
      fs.writeFileSync(indexFile, 'export const app = true;\n');
      initGitRepo(root);
      const past = Date.now() - 2 * HOUR_MS;
      setMtime(indexFile, past);
      setMtime(path.join(root, 'package.json'), past);
      const analyzedAt = new Date(Date.now() - HOUR_MS).toISOString();

      const { clearFreshnessSummaryCache, summarizeAnalysisFreshness } = await import('./freshness');
      const { saveAnalysis } = await import('./storage');
      const { getAgentDoctor } = await import('./agent-doctor');

      const cas = fixtureCas(root, analyzedAt);
      await saveAnalysis(root, cas);

      clearFreshnessSummaryCache();
      const statusView = summarizeAnalysisFreshness(root, cas.analysis_timestamp);
      assert.ok(statusView);
      assert.equal(statusView!.staleness, 'fresh');

      const doctorView = await getAgentDoctor(cas, root);
      const freshnessCheck = doctorView.checks.find(check => check.id === 'freshness');
      assert.equal(freshnessCheck!.status, 'pass');
      assert.equal(doctorView.freshness.status, 'fresh');
    });
  });
});
