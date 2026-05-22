import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CASOutput } from '../../backend/src/types/cas.types';
import { loadAnalysis } from './storage';
import { searchNodes } from './query';
import { semanticSearch } from './semantic-search';
import { RETRIEVAL_FIXTURE } from './semantic-retrieval-fixture';

type Mode = 'lexical' | 'semantic' | 'hybrid';

const MODES: Mode[] = ['lexical', 'semantic', 'hybrid'];
const TOP_K = 10;

interface ModeMetrics {
  mode: Mode;
  entries: number;
  recallAt5: number;
  recallAt10: number;
  mrr: number;
}

function firstRank(rankedIds: string[], expected: string[]): number {
  const expectedSet = new Set(expected);
  for (let i = 0; i < rankedIds.length; i++) {
    if (expectedSet.has(rankedIds[i])) return i + 1;
  }
  return 0;
}

async function rankedIds(
  mode: Mode,
  cas: CASOutput,
  repoPath: string,
  query: string,
): Promise<string[]> {
  if (mode === 'lexical') {
    return searchNodes(cas, query, { limit: TOP_K }).map(node => node.id);
  }
  const response = await semanticSearch(repoPath, query, { mode, limit: TOP_K });
  return response.results.map(result => result.node_id);
}

async function main(): Promise<void> {
  const casCache = new Map<string, CASOutput>();
  async function casFor(repoPath: string): Promise<CASOutput> {
    const cached = casCache.get(repoPath);
    if (cached) return cached;
    const cas = await loadAnalysis(repoPath);
    if (!cas) {
      throw new Error(`No analysis found for ${repoPath}; analyze it before running the benchmark`);
    }
    casCache.set(repoPath, cas);
    return cas;
  }

  const ranksByMode: Record<Mode, number[]> = { lexical: [], semantic: [], hybrid: [] };
  const detail: Array<Record<string, unknown>> = [];

  for (const entry of RETRIEVAL_FIXTURE) {
    const cas = await casFor(entry.repoPath);
    const row: Record<string, unknown> = {
      query: entry.query,
      repo: path.basename(entry.repoPath),
    };
    for (const mode of MODES) {
      const ranked = await rankedIds(mode, cas, entry.repoPath, entry.query);
      const rank = firstRank(ranked, entry.expectedNodeIds);
      ranksByMode[mode].push(rank);
      row[mode] = rank;
    }
    detail.push(row);
  }

  const metrics: ModeMetrics[] = MODES.map(mode => {
    const ranks = ranksByMode[mode];
    const count = ranks.length;
    return {
      mode,
      entries: count,
      recallAt5: ranks.filter(rank => rank > 0 && rank <= 5).length / count,
      recallAt10: ranks.filter(rank => rank > 0 && rank <= 10).length / count,
      mrr: ranks.reduce((sum, rank) => sum + (rank > 0 ? 1 / rank : 0), 0) / count,
    };
  });

  const lexical = metrics.find(metric => metric.mode === 'lexical')!;
  const hybrid = metrics.find(metric => metric.mode === 'hybrid')!;
  const pass = hybrid.recallAt10 >= lexical.recallAt10 && hybrid.mrr >= lexical.mrr;

  console.log('\nSemantic Retrieval Benchmark');
  console.log('='.repeat(64));
  console.log('mode       recall@5   recall@10      MRR');
  for (const metric of metrics) {
    console.log(
      `${metric.mode.padEnd(10)} ${metric.recallAt5.toFixed(3).padStart(8)}` +
        ` ${metric.recallAt10.toFixed(3).padStart(11)} ${metric.mrr.toFixed(3).padStart(8)}`,
    );
  }
  console.log('='.repeat(64));
  console.log(`Fixture entries: ${RETRIEVAL_FIXTURE.length}`);
  console.log(
    `Verdict: ${pass ? 'PASS' : 'FAIL'} ` +
      `(hybrid recall@10 ${hybrid.recallAt10.toFixed(3)} vs lexical ${lexical.recallAt10.toFixed(3)}; ` +
      `hybrid MRR ${hybrid.mrr.toFixed(3)} vs lexical ${lexical.mrr.toFixed(3)})`,
  );

  const reportDir = path.join(__dirname, '..', '.unravl-semantic-retrieval-benchmark');
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, 'latest-report.json');
  await fs.writeFile(
    reportPath,
    JSON.stringify(
      { generated_at: new Date().toISOString(), fixture_entries: RETRIEVAL_FIXTURE.length, metrics, pass, detail },
      null,
      2,
    ),
  );
  console.log(`Report: ${reportPath}`);

  process.exit(pass ? 0 : 1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
