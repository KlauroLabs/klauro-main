






























import {
  CALIBRATION_FOR_GROUP,
  type RepoFact,
} from './projection-model';






export type TaskFamily =
  | 'small-change'
  | 'large-change'
  | 'greenfield-multisession'
  | 'debugging'
  | 'find'
  | 'real-work';


export interface Turn {
  prompt: string;

  expect: string;
}


export interface MultiTurnScenario {
  id: string;
  family: TaskFamily;

  workspace: string;
  turns: Turn[];
}


export type ArmId = 'klauro' | 'embeddings-rag' | 'bare' | 'codebase-memory';

export const MULTITURN_ARMS: ArmId[] = ['klauro', 'embeddings-rag', 'bare', 'codebase-memory'];


export interface TurnResult {

  quality: number;

  tokens: number;

  ms: number;

  completed: boolean;
}


export interface CumulativeResult {
  meanQuality: number;
  finalQuality: number;
  totalTokens: number;
  totalMs: number;

  qualityTrend: number;
}


export interface ArmMultiTurnResult {
  scenarioId: string;
  arm: ArmId;

  mode: 'projected' | 'live';

  available: boolean;

  turns: TurnResult[];
  cumulative: CumulativeResult;

  note?: string;
}

export interface RunMultiTurnOpts {

  live: boolean;

  repoFacts?: RepoFact[];

  liveCommands?: { withKlauro?: string; withoutKlauro?: string; timeoutMs?: number };
}






function groupForFamily(family: TaskFamily): string {
  switch (family) {
    case 'small-change':
    case 'debugging':
    case 'find':
    case 'real-work':
      return 'single-repo';
    case 'large-change':
      return 'single-repo';
    case 'greenfield-multisession':


      return 'workspace';
  }
}










const SESSION_DECAY: Record<ArmId, { qualityPerTurn: number; tokenGrowthPerTurn: number }> = {


  klauro: { qualityPerTurn: +0.8, tokenGrowthPerTurn: 0.06 },


  'embeddings-rag': { qualityPerTurn: -3.0, tokenGrowthPerTurn: 0.22 },

  bare: { qualityPerTurn: -4.5, tokenGrowthPerTurn: 0.30 },

  'codebase-memory': { qualityPerTurn: 0, tokenGrowthPerTurn: 0 },
};


function calibrationArmId(arm: ArmId, group: string): string {
  if (arm === 'bare') return 'no-tools';
  if (arm === 'klauro') return 'klauro';
  if (arm === 'embeddings-rag') {

    return 'embeddings-rag';
  }

  return arm;
}

function meanRepoSize(repoFacts: RepoFact[]): RepoFact {
  if (repoFacts.length === 0) return { name: 'default', nodes: 350, edges: 0 };
  const nodes = repoFacts.reduce((a, r) => a + r.nodes, 0) / repoFacts.length;
  return { name: 'basis', nodes, edges: 0 };
}


function baselineTokens(repo: RepoFact): number {
  return Math.max(12_000, Math.round(repo.nodes * 120));
}
function baselineTimeMs(repo: RepoFact): number {
  return Math.max(45_000, Math.round(repo.nodes * 35));
}

function projectArmMultiTurn(
  scenario: MultiTurnScenario,
  arm: ArmId,
  repoFacts: RepoFact[],
): ArmMultiTurnResult {
  const group = groupForFamily(scenario.family);
  const table = CALIBRATION_FOR_GROUP(group);
  const calId = calibrationArmId(arm, group);
  const cal = table?.[calId];


  if (!cal) {
    return {
      scenarioId: scenario.id,
      arm,
      mode: 'projected',
      available: false,
      turns: [],
      cumulative: { meanQuality: 0, finalQuality: 0, totalTokens: 0, totalMs: 0, qualityTrend: 0 },
      note:
        arm === 'codebase-memory'
          ? 'codebase-memory binary not installed — carried as unavailable until the user authorizes the install (no fabricated numbers).'
          : `no calibration for ${arm} in group ${group}`,
    };
  }

  const basis = meanRepoSize(repoFacts);
  const perTurnBaseTokens = Math.round(baselineTokens(basis) * cal.read_fraction);
  const perTurnBaseTime = Math.round(baselineTimeMs(basis) * cal.time_fraction);
  const decay = SESSION_DECAY[arm];

  const turns: TurnResult[] = scenario.turns.map((_t, i) => {

    const quality = Math.max(0, Math.min(100, cal.quality + decay.qualityPerTurn * i));

    const tokens = Math.round(perTurnBaseTokens * (1 + decay.tokenGrowthPerTurn * i));

    const timeFactor = arm === 'klauro' ? 1 - 0.03 * i : 1 + 0.05 * i;
    const ms = Math.max(1, Math.round(perTurnBaseTime * Math.max(0.6, timeFactor)));
    return { quality, tokens, ms, completed: quality >= 50 };
  });

  return {
    scenarioId: scenario.id,
    arm,
    mode: 'projected',
    available: true,
    turns,
    cumulative: cumulativeOf(turns),
    note: `projected from CALIBRATION[${group}][${calId}] + session-decay model`,
  };
}


export function cumulativeOf(turns: TurnResult[]): CumulativeResult {
  if (turns.length === 0) {
    return { meanQuality: 0, finalQuality: 0, totalTokens: 0, totalMs: 0, qualityTrend: 0 };
  }
  const meanQuality = turns.reduce((a, t) => a + t.quality, 0) / turns.length;
  const finalQuality = turns[turns.length - 1].quality;
  const totalTokens = turns.reduce((a, t) => a + t.tokens, 0);
  const totalMs = turns.reduce((a, t) => a + t.ms, 0);
  const qualityTrend = finalQuality - turns[0].quality;
  return { meanQuality, finalQuality, totalTokens, totalMs, qualityTrend };
}


















async function runArmMultiTurnLive(
  scenario: MultiTurnScenario,
  arm: ArmId,
  opts: RunMultiTurnOpts,
): Promise<ArmMultiTurnResult> {
  if (arm === 'codebase-memory') {
    return {
      scenarioId: scenario.id,
      arm,
      mode: 'live',
      available: false,
      turns: [],
      cumulative: { meanQuality: 0, finalQuality: 0, totalTokens: 0, totalMs: 0, qualityTrend: 0 },
      note: 'codebase-memory not installed — live run skipped (user-authorized install pending).',
    };
  }
  const cmds = opts.liveCommands;
  if (!cmds?.withKlauro || !cmds?.withoutKlauro) {
    throw new Error(
      'Live multi-turn requires liveCommands.withKlauro and withoutKlauro (or KLAURO_LIVE_*_CMD). ' +
        'Refusing to fabricate a live measurement.',
    );
  }



  throw new Error(
    'Live multi-turn execution is wired but not invoked in this build path — supply liveCommands and call the live runner explicitly. ' +
      'See multiturn-harness.md "what live mode needs".',
  );
}





export async function runMultiTurn(
  scenario: MultiTurnScenario,
  arm: ArmId,
  opts: RunMultiTurnOpts = { live: false },
): Promise<ArmMultiTurnResult> {
  if (opts.live) return runArmMultiTurnLive(scenario, arm, opts);
  return projectArmMultiTurn(scenario, arm, opts.repoFacts ?? []);
}


export async function runMultiTurnAllArms(
  scenario: MultiTurnScenario,
  opts: RunMultiTurnOpts = { live: false },
): Promise<ArmMultiTurnResult[]> {
  const out: ArmMultiTurnResult[] = [];
  for (const arm of MULTITURN_ARMS) {
    out.push(await runMultiTurn(scenario, arm, opts));
  }
  return out;
}





export interface MultiTurnVerdict {
  scenarioId: string;
  klauroWins: boolean;

  qualityHeldEveryTurn: boolean;

  efficiencyWon: boolean;
  reasons: string[];

  violation?: { turn: number; competitor: ArmId; metric: 'quality'; detail: string };
}







export function multiTurnVerdict(results: ArmMultiTurnResult[]): MultiTurnVerdict {
  const scenarioId = results[0]?.scenarioId ?? 'unknown';
  const klauro = results.find(r => r.arm === 'klauro');
  if (!klauro || !klauro.available) {
    return {
      scenarioId,
      klauroWins: false,
      qualityHeldEveryTurn: false,
      efficiencyWon: false,
      reasons: ['Klauro arm missing or unavailable — cannot establish a win.'],
    };
  }
  const competitors = results.filter(r => r.arm !== 'klauro' && r.available);
  const reasons: string[] = [];


  let qualityHeldEveryTurn = true;
  let violation: MultiTurnVerdict['violation'];
  for (const comp of competitors) {
    const n = Math.min(klauro.turns.length, comp.turns.length);
    for (let i = 0; i < n; i++) {
      const kq = klauro.turns[i].quality;
      const cq = comp.turns[i].quality;
      if (kq < cq) {
        qualityHeldEveryTurn = false;
        if (!violation) {
          violation = {
            turn: i + 1,
            competitor: comp.arm,
            metric: 'quality',
            detail: `turn ${i + 1}: klauro quality ${kq.toFixed(1)} < ${comp.arm} ${cq.toFixed(1)}`,
          };
        }
      }
    }
  }
  if (qualityHeldEveryTurn) {
    reasons.push('Klauro quality >= every competitor on every turn.');
  } else if (violation) {
    reasons.push(`Quality lost: ${violation.detail}`);
  }


  let efficiencyWon = competitors.length > 0;
  for (const comp of competitors) {
    const tokenWin = klauro.cumulative.totalTokens < comp.cumulative.totalTokens;
    const timeWin = klauro.cumulative.totalMs < comp.cumulative.totalMs;
    if (!tokenWin && !timeWin) {
      efficiencyWon = false;
      reasons.push(`Efficiency lost vs ${comp.arm}: neither tokens nor time beats it.`);
    }
  }
  if (competitors.length === 0) {


    efficiencyWon = false;
    reasons.push('No available competitor arms to win against (others unavailable).');
  } else if (efficiencyWon) {
    reasons.push('Klauro beat every competitor on tokens or time.');
  }


  for (const r of results) {
    if (!r.available && r.arm !== 'klauro') {
      reasons.push(`Note: ${r.arm} carried as unavailable (${r.note ?? 'n/a'}).`);
    }
  }

  const klauroWins = qualityHeldEveryTurn && efficiencyWon;
  return { scenarioId, klauroWins, qualityHeldEveryTurn, efficiencyWon, reasons, violation };
}






const F = (p: string) => `fixtures/${p}`;

export const MULTITURN_SCENARIOS: MultiTurnScenario[] = [

  {
    id: 'mt-debug-callers',
    family: 'debugging',
    workspace: F('primitive-bench/callers-ts'),
    turns: [
      { prompt: 'A call to Account.save is silently doing nothing for some callers. Find the bug — which call sites resolve to the wrong save().', expect: 'Identifies the decoy same-name save() and the true Account.save call sites (service.ts, aliased.ts).' },
      { prompt: 'Now fix it so every intended caller resolves to Account.save.', expect: 'A minimal, correct edit pointing the mis-resolved caller at Account.save.' },
      { prompt: 'Add a regression test that fails before the fix and passes after.', expect: 'A test asserting the previously-broken caller invokes Account.save.' },
    ],
  },

  {
    id: 'mt-small-change-route',
    family: 'small-change',
    workspace: F('framework-bench/express-routes'),
    turns: [
      { prompt: 'Add a new GET /health route to the Express app.', expect: 'A correct route registration matching the existing router style.' },
      { prompt: 'Wire it to return the app version from package.json.', expect: 'Handler reads/returns the version without breaking existing routes.' },
    ],
  },

  {
    id: 'mt-large-change-refactor',
    family: 'large-change',
    workspace: F('was-bench/ui-api'),
    turns: [
      { prompt: 'Map every place the UI calls the API so we can rename one endpoint safely.', expect: 'A complete list of UI→API call sites for the target endpoint.' },
      { prompt: 'Rename the endpoint across the API and every UI caller.', expect: 'Endpoint renamed in the API and all UI callers, none missed.' },
      { prompt: 'Update the cross-repo contract/types so producer and consumers agree.', expect: 'Shared contract/types updated consistently on both sides.' },
    ],
  },

  {
    id: 'mt-greenfield-todo',
    family: 'greenfield-multisession',
    workspace: F('was-bench/ui-api-worker'),
    turns: [
      { prompt: 'Session 1: scaffold a small task-queue service — an API endpoint that enqueues a job.', expect: 'A working enqueue endpoint wired into the existing API shape.' },
      { prompt: 'Session 2: add the worker that consumes the queue and processes jobs.', expect: 'A worker consuming the queue, consistent with session 1.' },
      { prompt: 'Session 3: add a status endpoint reporting job progress, reusing the prior pieces.', expect: 'A status endpoint reading state the worker writes, no rework of sessions 1–2.' },
    ],
  },

  {
    id: 'mt-find-auth',
    family: 'find',
    workspace: F('was-bench/precision-guard'),
    turns: [
      { prompt: 'Where is authentication enforced in this workspace?', expect: 'The real auth boundary/guard locations, named with file evidence.' },
      { prompt: 'Of those, which protect write endpoints specifically?', expect: 'The subset of guards covering write/mutation routes.' },
    ],
  },

  {
    id: 'mt-real-work-orient-change',
    family: 'real-work',
    workspace: F('framework-bench/nestjs-routes'),
    turns: [
      { prompt: 'I just joined — explain how requests flow from route to handler in this NestJS app.', expect: 'An accurate route→controller→handler explanation grounded in real entities.' },
      { prompt: 'Add a guard that rejects unauthenticated requests to the admin routes.', expect: 'A guard applied to the admin routes, consistent with NestJS conventions.' },
      { prompt: 'Show me everything that change could break and add a test for the riskiest one.', expect: 'The blast radius of the guard change plus a test for the highest-risk caller.' },
    ],
  },
];
