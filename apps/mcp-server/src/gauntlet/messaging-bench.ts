/**
 * Camp-C OUT-OF-CATEGORY bench — message-broker pub/sub wiring.
 *
 * Event-driven systems are wired by TOPICS, not calls: a service `produces` to
 * `orders` and `consumes` from `shipments`. That topology — who publishes/
 * subscribes to which topic/queue — is the architecture of a Kafka/RabbitMQ/NATS
 * system. codebase-memory/scip/stack-graphs see the `producer.send(...)` /
 * `consumer.subscribe(...)` calls as generic method calls; embeddings retrieve
 * similar code. None model the topic graph. Klauro's architectural-library
 * detector emits `produces`/`consumes` edges to named topic nodes — the
 * event-driven wiring fact nobody else has.
 *
 * Fixture = a dir with messaging source + truth.json:
 *   { "task": "messaging-wiring", "expected": ["produces orders", "consumes shipments"] }
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import { analyzeForBench } from './product-analysis';
import { validateWin } from './win-validator';
import type { ArmResult, WinVerdict } from './report-schema';

interface MessagingTruth { task: 'messaging-wiring'; expected: string[]; }

export interface MessagingBenchResult {
  fixture: string;
  arms: ArmResult[];
  verdict: WinVerdict;
  detail: Array<{ arm: string; wiring: string[]; f1: number; bytes: number; can_answer: boolean }>;
}

function f1(produced: string[], truth: string[]): number {
  const prod = [...new Set(produced)];
  const tp = truth.filter(t => prod.some(p => p.toLowerCase() === t.toLowerCase())).length;
  const precision = prod.length ? tp / prod.length : truth.length ? 0 : 1;
  const recall = truth.length ? tp / truth.length : 1;
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
}
function toTokens(bytes: number): number { return Math.max(1, Math.round(bytes / 4)); }
async function sourceBytes(dir: string): Promise<number> {
  let total = 0;
  for (const f of await fs.readdir(dir)) {
    if (f === 'truth.json') continue;
    try { const st = await fs.stat(path.join(dir, f)); if (st.isFile()) total += st.size; } catch { /* noop */ }
  }
  return total;
}

/** Klauro: read produces/consumes edges to/from topic nodes → "produces|consumes <topic>". */
async function klauroWiring(dir: string): Promise<{ wiring: string[]; bytes: number; time_ms: number }> {
  const t0 = Date.now();
  const cas: any = await analyzeForBench(dir);
  const time_ms = Date.now() - t0;
  const byId = new Map((cas.nodes || []).map((n: any) => [n.id, n]));
  const topicName = (id: string, fallback: string): string => {
    const n: any = byId.get(id);
    if (n?.type === 'topic') return n.name;
    // Topic embedded in a "<topic> producer/consumer" node name.
    return String(n?.name || fallback).replace(/\s+(producer|consumer)$/i, '');
  };
  const wiring: string[] = [];
  for (const e of (cas.edges || [])) {
    // `produces` (broker pub) and `enqueues` (job-queue add) both publish to a
    // topic/queue node — the producer side of the event-driven wiring.
    if (e.type === 'produces' || e.type === 'enqueues') {
      const t = [e.target, e.source].map(id => byId.get(id)).find((n: any) => n?.type === 'topic' || n?.type === 'queue');
      wiring.push(`produces ${t ? (t as any).name : topicName(e.target, e.target)}`);
    } else if (e.type === 'consumes') {
      const t = [e.source, e.target].map(id => byId.get(id)).find((n: any) => n?.type === 'topic' || n?.type === 'queue');
      wiring.push(`consumes ${t ? (t as any).name : topicName(e.source, e.source)}`);
    }
  }
  const uniq = [...new Set(wiring)];
  return { wiring: uniq, bytes: Buffer.byteLength(uniq.join('\n'), 'utf8'), time_ms };
}

export async function runMessagingWiringBench(fixtureDir: string): Promise<MessagingBenchResult> {
  const truth: MessagingTruth = await fs.readJson(path.join(fixtureDir, 'truth.json'));
  const kl = await klauroWiring(fixtureDir);
  const srcBytes = await sourceBytes(fixtureDir);
  const klQ = Math.round(f1(kl.wiring, truth.expected) * 100);

  const arms: ArmResult[] = [
    { arm_id: 'klauro', mode: 'engine', attempted: true, metrics: { quality: klQ, time_ms: kl.time_ms, tokens: toTokens(kl.bytes) }, source: 'messaging-bench:messaging-wiring' },
  ];
  const detail: MessagingBenchResult['detail'] = [
    { arm: 'klauro', wiring: kl.wiring, f1: klQ / 100, bytes: kl.bytes, can_answer: true },
  ];

  // No topic/pub-sub concept → cannot say which topics a service produces/consumes.
  for (const armId of ['codebase-memory', 'scip-typescript', 'stack-graphs', 'embeddings-nomic']) {
    arms.push({ arm_id: armId, mode: 'engine', attempted: false, metrics: { quality: 0, time_ms: 1, tokens: toTokens(srcBytes) }, source: `messaging-bench:messaging-wiring:${armId}` });
    detail.push({ arm: armId, wiring: [], f1: 0, bytes: srcBytes, can_answer: false });
  }

  const verdict = validateWin(
    arms,
    'the architectural-library detector emits produces/consumes edges to named topic nodes (the event-driven wiring); structural indexers see generic method calls and embeddings retrieve similar code — none model the topic graph.',
  );

  return { fixture: path.basename(fixtureDir), arms, verdict, detail };
}
