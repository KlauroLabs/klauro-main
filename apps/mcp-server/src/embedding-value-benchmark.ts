import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { loadAnalysis } from './storage';
import { getAgentContext } from './agent-adoption';
import { RETRIEVAL_FIXTURE } from './semantic-retrieval-fixture';

type Arm = 'semantic' | 'lexical';

interface ArmResult {
  arm: Arm;
  query: string;
  repo: string;
  resolvedNodeId: string | null;
  correct: boolean;
  rank: number;
  filesInReadPlan: number;
  contextTokens: number;
}

interface ArmAggregate {
  arm: Arm;
  entries: number;
  accuracy: number;
  avgFilesInReadPlan: number;
  avgContextTokens: number;
}

function rankOfExpected(
  candidates: Array<{ id?: string }>,
  expected: string[],
): number {
  const expectedSet = new Set(expected);
  for (let i = 0; i < candidates.length; i++) {
    const id = candidates[i]?.id;
    if (id && expectedSet.has(id)) return i + 1;
  }
  return 0;
}

function estimateContextTokens(context: unknown): number {
  return Math.ceil(JSON.stringify(context).length / 4);
}

async function readKlaurorc(repoPath: string): Promise<{ file: string; original: string }> {
  const file = path.join(repoPath, '.klaurorc');
  const original = await fs.readFile(file, 'utf8');
  return { file, original };
}

async function withEmbeddingDisabled<T>(
  repoPath: string,
  run: () => Promise<T>,
): Promise<T> {
  const { file, original } = await readKlaurorc(repoPath);
  try {
    const parsed = JSON.parse(original) as Record<string, unknown>;
    const embedding = (parsed.embedding as Record<string, unknown>) || {};
    parsed.embedding = { ...embedding, enabled: false };
    await fs.writeFile(file, JSON.stringify(parsed, null, 2) + '\n');
    return await run();
  } finally {
    await fs.writeFile(file, original);
  }
}

async function measure(
  arm: Arm,
  cas: CASOutput,
  repoPath: string,
  query: string,
  expectedNodeIds: string[],
): Promise<ArmResult> {
  const context = await getAgentContext(cas, repoPath, { task_type: 'modify', target: query });
  const resolution = context.target_resolution;
  const candidates = (resolution.candidates || []) as Array<{ id?: string }>;
  const resolvedNodeId = resolution.selected_node_id;
  return {
    arm,
    query,
    repo: path.basename(repoPath),
    resolvedNodeId,
    correct: Boolean(resolvedNodeId && expectedNodeIds.includes(resolvedNodeId)),
    rank: rankOfExpected(candidates, expectedNodeIds),
    filesInReadPlan: context.file_read_plan.length,
    contextTokens: estimateContextTokens(context),
  };
}

function aggregate(arm: Arm, results: ArmResult[]): ArmAggregate {
  const count = results.length;
  return {
    arm,
    entries: count,
    accuracy: results.filter(result => result.correct).length / count,
    avgFilesInReadPlan: results.reduce((sum, result) => sum + result.filesInReadPlan, 0) / count,
    avgContextTokens: results.reduce((sum, result) => sum + result.contextTokens, 0) / count,
  };
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
    if (!cas.embedding_index) {
      throw new Error(`Analysis for ${repoPath} has no embedding index; generate embeddings first`);
    }
    casCache.set(repoPath, cas);
    return cas;
  }

  const semanticResults: ArmResult[] = [];
  const lexicalResults: ArmResult[] = [];

  for (const entry of RETRIEVAL_FIXTURE) {
    const cas = await casFor(entry.repoPath);
    const semantic = await measure('semantic', cas, entry.repoPath, entry.query, entry.expectedNodeIds);
    const lexical = await withEmbeddingDisabled(entry.repoPath, () =>
      measure('lexical', cas, entry.repoPath, entry.query, entry.expectedNodeIds),
    );
    semanticResults.push(semantic);
    lexicalResults.push(lexical);
  }

  const semanticAgg = aggregate('semantic', semanticResults);
  const lexicalAgg = aggregate('lexical', lexicalResults);

  const accuracyDelta = semanticAgg.accuracy - lexicalAgg.accuracy;
  const filesDelta = semanticAgg.avgFilesInReadPlan - lexicalAgg.avgFilesInReadPlan;
  const tokensDelta = semanticAgg.avgContextTokens - lexicalAgg.avgContextTokens;

  console.log('\nEmbedding Value Benchmark - Work-Context Target Resolution');
  console.log('='.repeat(72));
  console.log('arm        accuracy   avg files   avg tokens');
  for (const agg of [semanticAgg, lexicalAgg]) {
    console.log(
      `${agg.arm.padEnd(10)} ${agg.accuracy.toFixed(3).padStart(8)}` +
        ` ${agg.avgFilesInReadPlan.toFixed(2).padStart(11)} ${agg.avgContextTokens.toFixed(0).padStart(12)}`,
    );
  }
  console.log('-'.repeat(72));
  console.log(
    `delta      ${accuracyDelta.toFixed(3).padStart(8)}` +
      ` ${filesDelta.toFixed(2).padStart(11)} ${tokensDelta.toFixed(0).padStart(12)}`,
  );
  console.log('='.repeat(72));
  console.log(`Fixture entries: ${RETRIEVAL_FIXTURE.length}`);
  console.log(
    `Semantic vs lexical: accuracy ${accuracyDelta >= 0 ? '+' : ''}${accuracyDelta.toFixed(3)}, ` +
      `avg tokens ${tokensDelta >= 0 ? '+' : ''}${tokensDelta.toFixed(0)} per context`,
  );

  const reportDir = path.join(__dirname, '..', '.klauro-embedding-value-benchmark');
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, 'latest-report.json');
  await fs.writeFile(
    reportPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        fixture_entries: RETRIEVAL_FIXTURE.length,
        aggregates: { semantic: semanticAgg, lexical: lexicalAgg },
        deltas: {
          accuracy: accuracyDelta,
          avg_files_in_read_plan: filesDelta,
          avg_context_tokens: tokensDelta,
        },
        per_task: RETRIEVAL_FIXTURE.map((entry, index) => ({
          query: entry.query,
          repo: path.basename(entry.repoPath),
          expected_node_ids: entry.expectedNodeIds,
          semantic: semanticResults[index],
          lexical: lexicalResults[index],
        })),
      },
      null,
      2,
    ),
  );
  console.log(`Report: ${reportPath}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
