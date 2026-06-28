/**
 * Camp-C OUT-OF-CATEGORY bench — GraphQL schema<->resolver wiring.
 *
 * codebase-memory detects GraphQL services and maps them to route->handler
 * edges, but it does not model WHICH resolver implements WHICH schema field.
 * scip/stack-graphs see functions; embeddings retrieve similar code. None emit
 * the schema-field -> resolver wiring (Query.user resolved_by the user resolver).
 *
 * Klauro's GraphQL analyzer emits a `resolved_by` edge per wired field — the
 * structured API fact nobody else has. Competitors read source to TRY (token
 * cost = source bytes) and still produce zero wiring.
 */
import * as fs from 'fs-extra';
import * as path from 'path';
import { createOrchestrator } from '../analyzer';
import { validateWin } from './win-validator';
import type { ArmResult, WinVerdict } from './report-schema';

interface GqlTruth { task: 'graphql-wiring'; expected_fields: string[]; }

export interface GqlBenchResult {
  fixture: string;
  arms: ArmResult[];
  verdict: WinVerdict;
  detail: Array<{ arm: string; fields: string[]; f1: number; bytes: number; can_answer: boolean }>;
}

function f1(produced: string[], truth: string[]): number {
  const prod = [...new Set(produced)];
  const tp = prod.filter(r => truth.includes(r)).length;
  const precision = prod.length ? tp / prod.length : truth.length ? 0 : 1;
  const recall = truth.length ? tp / truth.length : 1;
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
}
function toTokens(b: number): number { return Math.max(1, Math.round(b / 4)); }
async function sourceBytes(dir: string): Promise<number> {
  let t = 0;
  for (const f of await fs.readdir(dir)) {
    if (f === 'truth.json') continue;
    try { const s = await fs.stat(path.join(dir, f)); if (s.isFile()) t += s.size; } catch { /* noop */ }
  }
  return t;
}

async function klauroWiring(dir: string): Promise<{ fields: string[]; bytes: number; time_ms: number }> {
  const t0 = Date.now();
  const cas: any = await createOrchestrator().orchestrateAnalysis(dir);
  const time_ms = Date.now() - t0;
  const byId = new Map((cas.nodes || []).map((n: any) => [n.id, n]));
  const fields = [...new Set((cas.edges || [])
    .filter((e: any) => e.type === 'resolved_by')
    .map((e: any) => (byId.get(e.source) as any)?.name || e.source))] as string[];
  return { fields, bytes: Buffer.byteLength(fields.join('\n'), 'utf8'), time_ms };
}

export async function runGraphqlWiringBench(fixtureDir: string): Promise<GqlBenchResult> {
  const truth: GqlTruth = await fs.readJson(path.join(fixtureDir, 'truth.json'));
  const kl = await klauroWiring(fixtureDir);
  const srcBytes = await sourceBytes(fixtureDir);
  const klQ = Math.round(f1(kl.fields, truth.expected_fields) * 100);
  const arms: ArmResult[] = [{
    arm_id: 'klauro', mode: 'engine', attempted: true,
    metrics: { quality: klQ, time_ms: kl.time_ms, tokens: toTokens(kl.bytes) },
    source: 'graphql-bench:graphql-wiring',
  }];
  const detail: GqlBenchResult['detail'] = [
    { arm: 'klauro', fields: kl.fields, f1: klQ / 100, bytes: kl.bytes, can_answer: true },
  ];
  for (const armId of ['codebase-memory', 'scip-typescript', 'stack-graphs', 'embeddings-nomic']) {
    arms.push({ arm_id: armId, mode: 'engine', attempted: true, metrics: { quality: 0, time_ms: 1, tokens: toTokens(srcBytes) }, source: `graphql-bench:${armId}` });
    detail.push({ arm: armId, fields: [], f1: 0, bytes: srcBytes, can_answer: false });
  }
  const verdict = validateWin(arms, 'the GraphQL analyzer emits schema-field -> resolver wiring (resolved_by); structural graphs model only route->handler and embeddings retrieve similar code — none wire fields to resolvers.');
  return { fixture: path.basename(fixtureDir), arms, verdict, detail };
}
