/* eslint-disable no-console */
// Throwaway benchmark for task #82: full-CAS load vs segmented-section load,
// at concurrency N=1/4/16, against a REAL stored analysis (truckspy,
// prj_5Fuar2garhkXpoB9, 85,652 nodes) mounted read-only from prod storage.
// Not part of the shipped surface — run once via tsx and delete.
import { loadAnalysis, loadAnalysisSections, clearLoadedAnalysisCache } from './storage';
import { CAS_SECTION_PROFILES } from './cas-sections';

const PROJECT_PATH = process.env.BENCH_PROJECT_PATH || '/data/workspaces/prj_5Fuar2garhkXpoB9';

function rssMb(): number {
  return Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10;
}

async function runConcurrent(label: string, n: number, fn: () => Promise<unknown>) {
  clearLoadedAnalysisCache();
  if (global.gc) global.gc();
  const rssBefore = rssMb();
  let peakRss = rssBefore;
  const sampler = setInterval(() => { peakRss = Math.max(peakRss, rssMb()); }, 25);
  const start = Date.now();
  await Promise.all(Array.from({ length: n }, () => fn()));
  const elapsed = Date.now() - start;
  clearInterval(sampler);
  peakRss = Math.max(peakRss, rssMb());
  console.log(JSON.stringify({ label, n, elapsed_ms: elapsed, rss_before_mb: rssBefore, peak_rss_mb: peakRss }));
}

async function main() {
  console.log(`bench project=${PROJECT_PATH}`);
  for (const n of [1, 4, 16]) {
    await runConcurrent('full-cas', n, () => loadAnalysis(PROJECT_PATH));
  }
  for (const n of [1, 4, 16]) {
    await runConcurrent('segmented-start-context', n, () =>
      loadAnalysisSections(PROJECT_PATH, CAS_SECTION_PROFILES.full));
  }
  for (const n of [1, 4, 16]) {
    await runConcurrent('segmented-graph-search', n, () =>
      loadAnalysisSections(PROJECT_PATH, CAS_SECTION_PROFILES.graph_search));
  }
}

main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
