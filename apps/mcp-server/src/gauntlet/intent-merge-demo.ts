





















import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

import { analyzeForBench } from './product-analysis';
import { planIntentMerge } from '../coordination/intent-merge';
import type { AgentInFlightState, ConflictCas } from '../coordination/conceptual-conflict';
import type { MergePlan } from '../coordination/intent-merge';

const FIXTURE_SOURCE = `
export interface User { id: string; name: string; }

export function getUser(id: string): User | null {
  return id ? { id, name: 'demo' } : null;
}

export function renderProfile(id: string): string {
  const user = getUser(id);
  if (!user) return 'no user';
  return user.name;
}

export function processPayment(amountCents: number): boolean {
  return amountCents > 0;
}

export function billingHandler(amountCents: number): number {
  return amountCents * 100;
}
`;

async function buildFixture(): Promise<string> {
  const dir = path.join(os.tmpdir(), `klauro-intent-merge-demo-${process.pid}-${Date.now()}`);
  await fs.mkdirp(dir);
  await fs.writeFile(path.join(dir, 'app.ts'), FIXTURE_SOURCE, 'utf8');
  return dir;
}

function idFor(cas: ConflictCas, name: string): string {
  const node = cas.nodes.find((n) => n.name === name);
  if (!node) throw new Error(`fixture CAS missing expected node: ${name}`);
  return node.id;
}

export interface DemoScenarioResult {
  scenario: string;
  expected_bucket: 'auto_mergeable' | 'needs_resolution' | 'duplicate_work';
  plan: MergePlan;
  matches_expectation: boolean;
}

export interface IntentMergeDemoReport {
  scenarios: DemoScenarioResult[];
  summary: string;
}

function bucketFor(plan: MergePlan, symbol: string): 'auto_mergeable' | 'needs_resolution' | 'duplicate_work' | 'none' {
  if (plan.auto_mergeable.some((e) => e.symbol === symbol)) return 'auto_mergeable';
  if (plan.needs_resolution.some((e) => e.symbol === symbol)) return 'needs_resolution';
  if (plan.duplicate_work.some((e) => e.symbol === symbol)) return 'duplicate_work';
  return 'none';
}

export async function runIntentMergeDemo(): Promise<IntentMergeDemoReport> {
  const fixtureDir = await buildFixture();
  let cas: ConflictCas;
  try {
    const realCas = await analyzeForBench(fixtureDir);
    cas = { nodes: realCas.nodes.map((n) => ({ id: n.id, name: n.name })), edges: realCas.edges as any };
  } finally {
    await fs.remove(fixtureDir).catch(() => {});
  }

  const scenarios: DemoScenarioResult[] = [];


  {
    const symbol = idFor(cas, 'processPayment');
    const states: AgentInFlightState[] = [
      {
        agent_id: 'agent-retry',
        intent: 'add retry with backoff to processPayment for transient failures',
        changes: [{ symbol_id: symbol, name: 'processPayment', file: 'app.ts', change_kind: 'body' }],
      },
      {
        agent_id: 'agent-logging',
        intent: 'add structured logging to processPayment for observability',
        changes: [{ symbol_id: symbol, name: 'processPayment', file: 'app.ts', change_kind: 'body' }],
      },
    ];
    const plan = planIntentMerge(states, cas);
    scenarios.push({
      scenario: 'orthogonal additive changes to the same function (retry + logging)',
      expected_bucket: 'auto_mergeable',
      plan,
      matches_expectation: bucketFor(plan, symbol) === 'auto_mergeable',
    });
  }



  {
    const symbol = idFor(cas, 'getUser');
    const states: AgentInFlightState[] = [
      {
        agent_id: 'agent-a',
        intent: 'retype getUser to non-null now that auth guarantees a session exists',
        changes: [
          {
            symbol_id: symbol,
            name: 'getUser',
            file: 'app.ts',
            change_kind: 'nullability',
            before: { nullable: true },
            after: { nullable: false },
          },
        ],
      },
      {
        agent_id: 'agent-b',
        intent: 'add avatar rendering to renderProfile, still guards on getUser being null',
        changes: [
          { symbol_id: idFor(cas, 'renderProfile'), name: 'renderProfile', file: 'app.ts', change_kind: 'body' },
        ],
      },
    ];
    const plan = planIntentMerge(states, cas);
    scenarios.push({
      scenario: 'conceptual conflict: A drops nullability, B relies on it (git would silently merge this)',
      expected_bucket: 'needs_resolution',
      plan,
      matches_expectation: bucketFor(plan, symbol) === 'needs_resolution',
    });
  }


  {
    const states: AgentInFlightState[] = [
      {
        agent_id: 'agent-a',
        intent: 'add retry with exponential backoff around billingHandler for transient failures',
        changes: [{ symbol_id: 'sym:retryBillingA', name: 'retryBilling', file: 'app.ts', change_kind: 'add' }],
      },
      {
        agent_id: 'agent-b',
        intent: 'add retry backoff wrapper for billingHandler to survive transient errors',
        changes: [{ symbol_id: 'sym:retryBillingB', name: 'retryBilling', file: 'app.ts', change_kind: 'add' }],
      },
    ];
    const plan = planIntentMerge(states, cas);
    scenarios.push({
      scenario: 'duplicate work: both agents add the same retry wrapper',
      expected_bucket: 'duplicate_work',
      plan,
      matches_expectation: bucketFor(plan, 'sym:retryBillingA') === 'duplicate_work',
    });
  }


  {
    const states: AgentInFlightState[] = [
      {
        agent_id: 'agent-a',
        intent: 'add caching to billingHandler',
        changes: [{ symbol_id: idFor(cas, 'billingHandler'), name: 'billingHandler', file: 'app.ts', change_kind: 'body' }],
      },
      {
        agent_id: 'agent-b',
        intent: 'add a brand new formatCurrency utility, unrelated to billing or rendering',
        changes: [{ symbol_id: 'sym:formatCurrency', name: 'formatCurrency', file: 'utils.ts', change_kind: 'add' }],
      },
    ];
    const plan = planIntentMerge(states, cas);
    scenarios.push({
      scenario: 'disjoint edits -> all auto_mergeable',
      expected_bucket: 'auto_mergeable',
      plan,
      matches_expectation: plan.needs_resolution.length === 0 && plan.duplicate_work.length === 0 && plan.auto_mergeable.length === 2,
    });
  }

  const totalSymbols = scenarios.reduce((sum, s) => sum + s.plan.summary.total_symbols, 0);
  const totalAuto = scenarios.reduce((sum, s) => sum + s.plan.summary.auto, 0);
  const totalConflicts = scenarios.reduce((sum, s) => sum + s.plan.summary.conflicts, 0);
  const totalDuplicates = scenarios.reduce((sum, s) => sum + s.plan.summary.duplicates, 0);

  const summary =
    `${totalSymbols} symbols: ${totalAuto} auto-merged by intent, ${totalConflicts} conflicts surfaced ` +
    `(git would have silently merged them), ${totalDuplicates} duplicates deduped.`;

  return { scenarios, summary };
}

if (require.main === module) {
  runIntentMergeDemo()
    .then((report) => {

      console.log(JSON.stringify(report, null, 2));
      console.log(report.summary);
    })
    .catch((err) => {

      console.error(err);
      process.exitCode = 1;
    });
}
