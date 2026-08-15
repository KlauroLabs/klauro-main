



















import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

import { analyzeForBench } from './product-analysis';
import { getCallers } from '../query';
import { detectConceptualConflicts } from '../coordination/conceptual-conflict';
import type { AgentInFlightState, ConflictCas } from '../coordination/conceptual-conflict';

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

export function billingHandler(amountCents: number): number {
  return amountCents * 100;
}

export function render(): string {
  return 'header+body';
}

export function renderCaller(): string {
  return render();
}
`;

async function buildFixture(): Promise<string> {
  const dir = path.join(os.tmpdir(), `klauro-conceptual-conflict-demo-${process.pid}-${Date.now()}`);
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
  expected_conflict_kind: string | null;
  conflicts_found: number;
  passes_textual_merge_all: boolean;
  detail: ReturnType<typeof detectConceptualConflicts>;
}

export interface ConceptualConflictDemoReport {
  scenarios: DemoScenarioResult[];
  total_conceptual_conflicts_caught: number;
  summary: string;
}

export async function runConceptualConflictDemo(): Promise<ConceptualConflictDemoReport> {
  const fixtureDir = await buildFixture();
  let cas: ConflictCas;
  try {
    const realCas = await analyzeForBench(fixtureDir);
    cas = { nodes: realCas.nodes.map((n) => ({ id: n.id, name: n.name })), edges: realCas.edges as any };



    const getUserId = idFor(cas, 'getUser');
    const callers = getCallers(realCas, getUserId, 1, 10);
    if (!callers.callers.some((c) => c.name === 'renderProfile')) {
      throw new Error('fixture CAS did not produce the expected getUser <- renderProfile call edge');
    }
  } finally {
    await fs.remove(fixtureDir).catch(() => {});
  }

  const scenarios: DemoScenarioResult[] = [];



  {
    const states: AgentInFlightState[] = [
      {
        agent_id: 'agent-a',
        intent: 'retype getUser to non-null now that auth guarantees a session exists',
        changes: [
          {
            symbol_id: idFor(cas, 'getUser'),
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
        intent: 'add avatar rendering to renderProfile',
        changes: [
          {
            symbol_id: idFor(cas, 'renderProfile'),
            name: 'renderProfile',
            file: 'app.ts',
            change_kind: 'body',
          },
        ],
      },
    ];
    const conflicts = detectConceptualConflicts(states, cas);
    scenarios.push({
      scenario: 'nullability contract-divergence (getUser)',
      expected_conflict_kind: 'contract-divergence',
      conflicts_found: conflicts.length,
      passes_textual_merge_all: conflicts.every((c) => c.passes_textual_merge),
      detail: conflicts,
    });
  }





  {
    const states: AgentInFlightState[] = [
      {
        agent_id: 'agent-a',
        intent: 'retype billingHandler to return Money instead of raw cents number',
        changes: [
          {
            symbol_id: idFor(cas, 'billingHandler'),
            name: 'billingHandler',
            file: 'app.ts',
            change_kind: 'return_type',
            before: { return_type: 'number' },
            after: { return_type: 'Money' },
          },
        ],
      },
      {
        agent_id: 'agent-b',
        intent: 'add a caller that multiplies billingHandler output by 100 for display',
        changes: [
          {
            symbol_id: idFor(cas, 'renderCaller'),
            name: 'renderCaller',
            file: 'app.ts',
            change_kind: 'body',
          },
        ],
      },
    ];



    const casWithSyntheticCallEdge: ConflictCas = {
      nodes: cas.nodes,
      edges: [...cas.edges, { source: idFor(cas, 'renderCaller'), target: idFor(cas, 'billingHandler'), type: 'calls' }],
    };
    const conflicts = detectConceptualConflicts(states, casWithSyntheticCallEdge);
    scenarios.push({
      scenario: 'return-type retype (cents -> Money) with a caller still doing amount*100',
      expected_conflict_kind: 'contract-divergence',
      conflicts_found: conflicts.length,
      passes_textual_merge_all: conflicts.every((c) => c.passes_textual_merge),
      detail: conflicts,
    });
  }



  {
    const states: AgentInFlightState[] = [
      {
        agent_id: 'agent-a',
        intent: 'split render into render + renderHeader for layout reuse',
        changes: [
          {
            symbol_id: idFor(cas, 'render'),
            name: 'render',
            file: 'app.ts',
            change_kind: 'split',
            before: { name: 'render' },
            after: { split_into: ['render2', 'renderHeader'] },
          },
        ],
      },
      {
        agent_id: 'agent-b',
        intent: 'add a new footer widget that calls render() directly',
        changes: [
          {
            symbol_id: 'sym:newFooterWidget',
            name: 'newFooterWidget',
            file: 'app.ts',
            change_kind: 'add',
            after: { signature: 'function newFooterWidget() { return render(); }' },
          },
        ],
      },
    ];
    const conflicts = detectConceptualConflicts(states, cas);
    scenarios.push({
      scenario: 'structural split (render -> render + renderHeader) with a new caller of old render',
      expected_conflict_kind: 'structural-divergence',
      conflicts_found: conflicts.length,
      passes_textual_merge_all: conflicts.every((c) => c.passes_textual_merge),
      detail: conflicts,
    });
  }


  {
    const states: AgentInFlightState[] = [
      {
        agent_id: 'agent-a',
        intent: 'add retry with exponential backoff around billingHandler for transient failures',
        changes: [
          {
            symbol_id: 'sym:retryBillingA',
            name: 'retryBilling',
            file: 'app.ts',
            change_kind: 'add',
          },
        ],
      },
      {
        agent_id: 'agent-b',
        intent: 'add retry backoff wrapper for billingHandler to survive transient errors',
        changes: [
          {
            symbol_id: 'sym:retryBillingB',
            name: 'retryBilling',
            file: 'app.ts',
            change_kind: 'add',
          },
        ],
      },
    ];
    const conflicts = detectConceptualConflicts(states, cas);
    scenarios.push({
      scenario: 'duplicate-work (both agents add retry logic to billingHandler)',
      expected_conflict_kind: 'duplicate-work',
      conflicts_found: conflicts.length,
      passes_textual_merge_all: conflicts.every((c) => c.passes_textual_merge),
      detail: conflicts,
    });
  }


  {
    const states: AgentInFlightState[] = [
      {
        agent_id: 'agent-a',
        intent: 'fix a typo in the User interface doc comment',
        changes: [
          { symbol_id: idFor(cas, 'User'), name: 'User', file: 'app.ts', change_kind: 'body' },
        ],
      },
      {
        agent_id: 'agent-b',
        intent: 'add a brand new formatCurrency utility, unrelated to billing or rendering',
        changes: [
          { symbol_id: 'sym:formatCurrency', name: 'formatCurrency', file: 'utils.ts', change_kind: 'add' },
        ],
      },
    ];
    const conflicts = detectConceptualConflicts(states, cas);
    scenarios.push({
      scenario: 'non-conflict control (two disjoint, unrelated changes)',
      expected_conflict_kind: null,
      conflicts_found: conflicts.length,
      passes_textual_merge_all: conflicts.every((c) => c.passes_textual_merge),
      detail: conflicts,
    });
  }

  const total = scenarios
    .filter((s) => s.expected_conflict_kind !== null)
    .reduce((sum, s) => sum + s.conflicts_found, 0);

  return {
    scenarios,
    total_conceptual_conflicts_caught: total,
    summary: `${total} conceptual conflicts caught that textual merge would have passed.`,
  };
}

if (require.main === module) {
  runConceptualConflictDemo()
    .then((report) => {

      console.log(JSON.stringify(report, null, 2));
      console.log(report.summary);
    })
    .catch((err) => {

      console.error(err);
      process.exitCode = 1;
    });
}
