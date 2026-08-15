


















import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { arbitrate, detectCollisions } from '../coordination/index';
import {
  announceEdit,
  appendClaim,
  attributeChange,
  checkEditLock,
  getActiveClaims,
  getPresence,
} from '../coordination/local-store';
import type { CasEdgeRef, InFlightSnapshot, WorkspaceCapabilityRef, WorkClaim } from '../coordination/types';

const WORKSPACE_ID = 'coordination-demo-workspace';


const CAS_EDGES: CasEdgeRef[] = [
  { id: 'e1', source: 'CheckoutService.submitOrder', target: 'PricingEngine.computeTotal', type: 'calls' },
  { id: 'e2', source: 'PricingEngine.computeTotal', target: 'CheckoutService.submitOrder', type: 'called_by' },
];


const WORKSPACE_CAPABILITIES: WorkspaceCapabilityRef[] = [
  { id: 'cap-1', name: 'checkout-refactor', project_ids: ['proj-checkout'] },
];


export interface TranscriptLine {
  scenario: 1 | 2 | 3 | 4;
  label: string;
  detail?: unknown;
}

export interface ScenarioResult {
  scenario: 1 | 2 | 3 | 4;
  name: string;
  verdict: string;
  passed: boolean;
}

export interface DemoRunResult {
  transcript: TranscriptLine[];
  scenarios: ScenarioResult[];
}

function say(transcript: TranscriptLine[], scenario: 1 | 2 | 3 | 4, label: string, detail?: unknown): void {
  transcript.push({ scenario, label, detail });
  const prefix = `[scenario ${scenario}]`;
  if (detail !== undefined) {
    console.log(`${prefix} ${label}`);
    console.log(JSON.stringify(detail, null, 2));
  } else {
    console.log(`${prefix} ${label}`);
  }
}

function nowClaim(partial: Partial<WorkClaim> & Pick<WorkClaim, 'claim_id' | 'agent_id' | 'scope' | 'intent'>): Omit<WorkClaim, 'seq'> {
  const now = new Date().toISOString();
  return {
    workspace_id: WORKSPACE_ID,
    agent_kind: 'claude',
    status: 'active',
    created_at: now,
    ttl_ms: 5 * 60 * 1000,
    heartbeat_at: now,
    ...partial,
  };
}


async function scenario1(transcript: TranscriptLine[]): Promise<ScenarioResult> {
  say(transcript, 1, 'Agent A claims capability "checkout-refactor" (claim_work -> arbitrate).');
  const claimA = await appendClaim(WORKSPACE_ID, nowClaim({
    claim_id: 'claim-a-checkout',
    agent_id: 'agent-A',
    scope: { repo: WORKSPACE_ID, paths: ['src/checkout/'], symbols: ['CheckoutService.submitOrder'], capability: 'checkout-refactor' },
    intent: 'Refactor checkout flow to support split payments',
  }));
  const resultA = arbitrate(claimA, await getActiveClaims(WORKSPACE_ID), CAS_EDGES, WORKSPACE_CAPABILITIES);
  say(transcript, 1, 'Agent A verdict', { verdict: resultA.verdict });

  say(transcript, 1, 'Agent B is given the SAME task and calls claim_work for "checkout-refactor".');
  const claimBAttempt: WorkClaim = { ...nowClaim({
    claim_id: 'claim-b-checkout',
    agent_id: 'agent-B',
    scope: { repo: WORKSPACE_ID, paths: ['src/checkout/'], symbols: [], capability: 'checkout-refactor' },
    intent: 'Rebuild checkout flow to support split payments',
  }), seq: 999 };
  const activeForB = await getActiveClaims(WORKSPACE_ID);
  const resultB = arbitrate(claimBAttempt, activeForB, CAS_EDGES, WORKSPACE_CAPABILITIES);
  say(transcript, 1, 'Agent B verdict (check_collision / claim_work)', {
    verdict: resultB.verdict,
    with_claim_id: resultB.with_claim?.claim_id,
    with_agent: resultB.with_claim?.agent_id,
    with_intent: resultB.with_claim?.intent,
    evidence: resultB.evidence,
  });

  const passed = resultA.verdict === 'granted' && resultB.verdict === 'duplicate';
  say(
    transcript,
    1,
    passed
      ? 'Agent B would have rebuilt checkout — Klauro told it Agent A owns it (claim + intent surfaced); B defers.'
      : 'UNEXPECTED: duplicate work was NOT flagged.'
  );
  return { scenario: 1, name: 'duplicate-work-prevented', verdict: resultB.verdict, passed };
}


async function scenario2(transcript: TranscriptLine[]): Promise<ScenarioResult> {
  say(transcript, 2, "Agent A announces an edit lock on ['src/auth/login.ts'] before writing.");
  await announceEdit(WORKSPACE_ID, 'agent-A', ['src/auth/login.ts'], {
    agentKind: 'claude',
    intent: 'Fix session-expiry bug in login handler',
  });

  say(transcript, 2, "Agent B checks the edit lock on the SAME path ['src/auth/login.ts'] before writing.");
  const lockConflicts = await checkEditLock(WORKSPACE_ID, ['src/auth/login.ts'], 'agent-B');
  say(transcript, 2, 'checkEditLock result', lockConflicts);

  say(transcript, 2, 'Same overlap re-checked through arbitrate() as a path claim.');
  const overlappingClaim: WorkClaim = { ...nowClaim({
    claim_id: 'claim-b-login',
    agent_id: 'agent-B',
    scope: { repo: WORKSPACE_ID, paths: ['src/auth/login.ts'], symbols: [] },
    intent: 'Add MFA prompt to login handler',
  }), seq: 998 };
  const arbResult = arbitrate(overlappingClaim, await getActiveClaims(WORKSPACE_ID), CAS_EDGES, WORKSPACE_CAPABILITIES);
  say(transcript, 2, 'arbitrate() verdict on overlapping path claim', { verdict: arbResult.verdict, kind: arbResult.kind, evidence: arbResult.evidence });

  const overlapPassed =
    lockConflicts.length > 0 &&
    lockConflicts[0].agent_id === 'agent-A' &&
    arbResult.verdict === 'conflict' &&
    arbResult.kind === 'path';
  say(
    transcript,
    2,
    overlapPassed
      ? 'Silent clobber DID NOT happen: Agent B saw the live edit-lock and the path-conflict verdict before writing over Agent A.'
      : 'UNEXPECTED: edit collision was NOT flagged.'
  );

  say(transcript, 2, "Control: Agent C checks a DISJOINT path ['src/billing/x.ts'] — should be clean, no false alarm.");
  const disjointLockConflicts = await checkEditLock(WORKSPACE_ID, ['src/billing/x.ts'], 'agent-C');
  const disjointClaim: WorkClaim = { ...nowClaim({
    claim_id: 'claim-c-billing',
    agent_id: 'agent-C',
    scope: { repo: WORKSPACE_ID, paths: ['src/billing/x.ts'], symbols: [] },
    intent: 'Add proration logic to billing',
  }), seq: 997 };
  const disjointArb = arbitrate(disjointClaim, await getActiveClaims(WORKSPACE_ID), CAS_EDGES, WORKSPACE_CAPABILITIES);
  say(transcript, 2, 'Disjoint-path result', {
    lockConflicts: disjointLockConflicts,
    arbitrateVerdict: disjointArb.verdict,
  });
  const disjointPassed = disjointLockConflicts.length === 0 && disjointArb.verdict === 'granted';
  say(
    transcript,
    2,
    disjointPassed
      ? 'Disjoint path correctly GRANTED — no false alarm raised for unrelated work.'
      : 'UNEXPECTED: disjoint path incorrectly flagged.'
  );

  return {
    scenario: 2,
    name: 'edit-collision-prevented',
    verdict: overlapPassed && disjointPassed ? 'conflict+disjoint-granted' : 'mismatch',
    passed: overlapPassed && disjointPassed,
  };
}


async function scenario3(transcript: TranscriptLine[]): Promise<ScenarioResult> {
  say(transcript, 3, "Agent A's in-flight diff changes the OrderDTO field type (mid-edit, uncommitted).");
  const inFlightA: InFlightSnapshot = {
    workspace: WORKSPACE_ID,
    agent_id: 'agent-A',
    base_commit: 'abc123',
    branch: 'agent-a/order-dto-narrowing',
    diff_context: '- amount: number\n+ amount: Money',
    touched: { entities: ['Order'], routes: [], contracts: ['OrderDTO'], symbols: ['OrderDTO.amount'] },
    updated_at: new Date().toISOString(),
  };

  say(transcript, 3, "Agent B has an ACTIVE claim consuming OrderDTO (building against the shape as-is).");
  const claimB = await appendClaim(WORKSPACE_ID, nowClaim({
    claim_id: 'claim-b-order-consumer',
    agent_id: 'agent-B',
    scope: { repo: WORKSPACE_ID, paths: ['src/orders/summary.ts'], symbols: [], capability: 'OrderDTO' },
    intent: 'Build order-summary view consuming OrderDTO',
  }));

  const activeClaims = await getActiveClaims(WORKSPACE_ID);
  const report = detectCollisions(activeClaims, [inFlightA], CAS_EDGES, WORKSPACE_CAPABILITIES);
  say(transcript, 3, 'detectCollisions() report (drifts)', report.drifts);

  const drift = report.drifts.find((d) => d.agent_id === 'agent-A' && d.with_agent_id === claimB.agent_id);
  const passed = Boolean(drift && drift.contracts.includes('OrderDTO'));
  say(
    transcript,
    3,
    passed
      ? 'Agent B was about to build against a shape Agent A is mid-changing (OrderDTO.amount: number -> Money) — warned before the break.'
      : 'UNEXPECTED: contract drift was NOT flagged.'
  );
  return { scenario: 3, name: 'in-flight-contract-drift-warning', verdict: passed ? 'drift' : 'no-drift', passed };
}


async function scenario4(transcript: TranscriptLine[]): Promise<ScenarioResult> {
  say(transcript, 4, "attributeChange('src/auth/login.ts') — who touched this and why?");
  const attribution = await attributeChange(WORKSPACE_ID, 'src/auth/login.ts');
  say(transcript, 4, 'attributeChange() result', attribution);

  const hit = attribution.attributions.find((a) => a.agent_id === 'agent-A');
  const passed = Boolean(hit && hit.intent.includes('session-expiry'));
  say(
    transcript,
    4,
    passed
      ? `Attribution answers what the filesystem alone cannot: ${hit!.agent_id} is mid-edit here, intent: "${hit!.intent}".`
      : 'UNEXPECTED: attribution missing or intent mismatch.'
  );
  return { scenario: 4, name: 'change-attribution', verdict: passed ? 'attributed' : 'unattributed', passed };
}






export async function run(): Promise<DemoRunResult> {
  const prevCoordDir = process.env.KLAURO_COORD_DIR;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-coordination-demo-'));
  process.env.KLAURO_COORD_DIR = tempDir;

  console.log('='.repeat(72));
  console.log('KLAURO COORDINATION FABRIC — no-collision demo (local tier, same-machine)');
  console.log(`workspace: ${WORKSPACE_ID}`);
  console.log(`isolated KLAURO_COORD_DIR: ${tempDir}`);
  console.log('='.repeat(72));

  const transcript: TranscriptLine[] = [];
  try {
    const s1 = await scenario1(transcript);
    console.log('-'.repeat(72));
    const s2 = await scenario2(transcript);
    console.log('-'.repeat(72));
    const s3 = await scenario3(transcript);
    console.log('-'.repeat(72));
    const s4 = await scenario4(transcript);
    console.log('-'.repeat(72));

    const presence = await getPresence(WORKSPACE_ID);
    console.log('Final live agent presence roster (get_active_agents):');
    console.log(JSON.stringify(presence, null, 2));
    console.log('='.repeat(72));

    const scenarios = [s1, s2, s3, s4];
    const allPassed = scenarios.every((s) => s.passed);
    console.log(
      allPassed
        ? 'ALL SCENARIOS PASSED — the coordination fabric prevented every planted collision.'
        : 'SOME SCENARIOS FAILED — see verdicts above.'
    );
    console.log('='.repeat(72));

    return { transcript, scenarios };
  } finally {
    if (prevCoordDir === undefined) delete process.env.KLAURO_COORD_DIR;
    else process.env.KLAURO_COORD_DIR = prevCoordDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function main(): Promise<void> {
  const result = await run();
  const failed = result.scenarios.filter((s) => !s.passed);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}


const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('coordination-demo.ts') || process.argv[1].endsWith('coordination-demo.js'));
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
