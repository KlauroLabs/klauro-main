/**
 * Camp-C OUT-OF-CATEGORY bench — WORKSPACE cross-repo comprehension.
 *
 * The whitespace nobody fills: ui → api → worker is ONE product, but every
 * Camp-A/Camp-B tool indexes a SINGLE repo. Klauro analyzes each repo, then
 * buildCrossRepositoryLinks fuses them: a `fetch('/invoices')` in the UI repo is
 * linked to the `GET /invoices` route in the API repo (consumer → producer), with
 * a generic-route + affinity guard so it does not over-link. Single-repo indexers
 * (scip, stack-graphs, embeddings) cannot see across repos at all; codebase-memory
 * only links nodes co-indexed in one store and still has no fetch↔route fusion.
 *
 * A fixture is a dir containing >=2 repo subdirs + truth.json:
 *   { "task": "cross-repo-links", "expected_links": ["ui -> api GET /invoices", ...] }
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import { analyzeForBench } from './product-analysis';
import { buildCrossRepositoryLinks } from '../product';
import { validateWin } from './win-validator';
import type { ArmResult } from './report-schema';

interface WasTruth { task: 'cross-repo-links'; expected_links: string[]; }

export interface WasBenchResult {
  fixture: string;
  arms: ArmResult[];
  verdict: ReturnType<typeof validateWin>;
  detail: Array<{ arm: string; links: string[]; f1: number; bytes: number; can_answer: boolean }>;
}

function toTokens(bytes: number): number { return Math.max(1, Math.round(bytes / 4)); }

function f1(produced: string[], truth: string[]): number {
  const prod = [...new Set(produced)];
  const tp = prod.filter(p => truth.includes(p)).length;
  const precision = prod.length ? tp / prod.length : (truth.length ? 0 : 1);
  const recall = truth.length ? tp / truth.length : 1;
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
}

async function repoDirs(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const f of await fs.readdir(dir)) {
    if (f === 'truth.json') continue;
    if ((await fs.stat(path.join(dir, f))).isDirectory()) out.push(f);
  }
  return out.sort();
}

async function sourceBytes(dir: string): Promise<number> {
  let total = 0;
  const walk = async (d: string): Promise<void> => {
    for (const f of await fs.readdir(d)) {
      if (f === 'truth.json' || f === 'node_modules') continue;
      const p = path.join(d, f);
      const st = await fs.stat(p);
      if (st.isDirectory()) await walk(p); else total += st.size;
    }
  };
  await walk(dir);
  return total;
}

/** Klauro: analyze each repo, fuse them, report the api consumer→producer links. */
async function klauroLinks(dir: string): Promise<{ links: string[]; bytes: number; time_ms: number }> {
  const t0 = Date.now();
  const dirs = await repoDirs(dir);
  const repos = [];
  for (const name of dirs) {
    const cas: any = await analyzeForBench(path.join(dir, name));
    repos.push({ path: name, name, cas });
  }
  const result = buildCrossRepositoryLinks(repos);
  const links = [...new Set(
    result.links
      .filter((l: any) => l.type === 'api')
      .map((l: any) => `${l.source_repository?.path} -> ${l.target_repository?.path} ${(l.connection?.method || '').toUpperCase()} ${l.connection?.endpoint}`)
  )];
  return { links, bytes: Buffer.byteLength(links.join('\n'), 'utf8'), time_ms: Date.now() - t0 };
}

export async function runWasCrossRepoBench(fixtureDir: string): Promise<WasBenchResult> {
  const truth: WasTruth = await fs.readJson(path.join(fixtureDir, 'truth.json'));
  const kl = await klauroLinks(fixtureDir);
  const srcBytes = await sourceBytes(fixtureDir);
  const klQ = Math.round(f1(kl.links, truth.expected_links) * 100);

  const arms: ArmResult[] = [
    { arm_id: 'klauro', mode: 'engine', attempted: true, metrics: { quality: klQ, time_ms: kl.time_ms, tokens: toTokens(kl.bytes) }, source: 'was-bench:cross-repo-links' },
  ];
  const detail: WasBenchResult['detail'] = [
    { arm: 'klauro', links: kl.links, f1: klQ / 100, bytes: kl.bytes, can_answer: true },
  ];

  // Camp A + Camp B index a single repo — no cross-repo fusion of a client call to
  // a server route. Un-attempted (categorical Camp-C / WAS win).
  for (const armId of ['codebase-memory', 'scip-typescript', 'stack-graphs', 'embeddings-nomic']) {
    arms.push({ arm_id: armId, mode: 'engine', attempted: false, metrics: { quality: 0, time_ms: 1, tokens: toTokens(srcBytes) }, source: `was-bench:cross-repo-links:${armId}` });
    detail.push({ arm: armId, links: [], f1: 0, bytes: srcBytes, can_answer: false });
  }

  const verdict = validateWin(
    arms,
    'buildCrossRepositoryLinks fuses a client fetch in one repo to the server route in another (ui -> api), the cross-repo product graph; single-repo indexers (scip, stack-graphs, embeddings) cannot see across repos and codebase-memory has no fetch↔route fusion.',
  );

  return { fixture: path.basename(fixtureDir), arms, verdict, detail };
}
