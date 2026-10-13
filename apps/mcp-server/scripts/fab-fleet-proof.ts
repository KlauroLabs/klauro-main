import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface Concept {
  capability_id?: string;
  flow_id?: string;
  step_id?: string;
  entities?: string[];
}

interface Claimed {
  agent_id: string;
  file: string;
  concepts: Concept[];
  awareness: Array<{ agent_id: string; verdict: string; shared_step_id?: string; shared_flow_id?: string; shared_capability_id?: string }>;
  analysis_ref?: { analysis_id?: string; commit?: string };
  ms: number;
}

const serverUrl = (process.env.KLAURO_URL || 'https://mcp.klauro.com').replace(/\/$/, '');
const workspace = process.env.FLEET_WORKSPACE || '';
const repo = path.resolve(process.env.FLEET_REPO || process.cwd());
const folders = (process.env.FLEET_FOLDERS || 'apps/mcp-server/src/coordination').split(',');
const fleetSize = Number(process.env.FLEET_SIZE || 12);
const run = `fleet-${Date.now().toString(36)}`;

function token(): string {
  if (process.env.KLAURO_ACCOUNT_TOKEN) return process.env.KLAURO_ACCOUNT_TOKEN;
  const stored = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.klauro', 'auth.json'), 'utf8'));
  const held = stored.accounts?.[serverUrl]?.token;
  if (!held) throw new Error(`no stored account for ${serverUrl}; sign in with the CLI first`);
  return held;
}

async function post(route: string, body: unknown): Promise<any> {
  const response = await fetch(`${serverUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${route} answered ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function get(route: string): Promise<any> {
  const response = await fetch(`${serverUrl}${route}`, { headers: { authorization: `Bearer ${bearer}` } });
  const text = await response.text();
  if (!response.ok) throw new Error(`${route} answered ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

let failed = 0;
function check(holds: boolean, label: string, detail?: string): void {
  console.log(`  ${holds ? 'PASS' : 'FAIL'}  ${label}${!holds && detail ? `\n        ${detail}` : ''}`);
  if (!holds) failed += 1;
}

function relation(a: Concept[], b: Concept[]): 'step' | 'flow' | 'entity' | 'capability' | undefined {
  let best: 'step' | 'flow' | 'entity' | 'capability' | undefined;
  const rank = { step: 0, entity: 1, flow: 2, capability: 3 } as const;
  const keep = (found: keyof typeof rank) => { if (!best || rank[found] < rank[best]) best = found; };
  for (const x of a) {
    for (const y of b) {
      if (x.flow_id && x.flow_id === y.flow_id) keep(x.step_id && x.step_id === y.step_id ? 'step' : 'flow');
      else if (x.entities?.some((entity) => y.entities?.includes(entity))) keep('entity');
      else if (x.capability_id && x.capability_id === y.capability_id) keep('capability');
    }
  }
  return best;
}

function reported(neighbour: Claimed['awareness'][number]): 'step' | 'flow' | 'entity' | 'capability' {
  if (neighbour.shared_step_id) return 'step';
  if (neighbour.shared_flow_id) return 'flow';
  if (neighbour.verdict === 'conceptual_conflict') return 'entity';
  return 'capability';
}

const bearer = token();

async function main(): Promise<void> {
  if (!workspace) throw new Error('FLEET_WORKSPACE (a hosted project id) is required');
  const files = execFileSync('git', ['-C', repo, 'ls-files', '--', ...folders], { encoding: 'utf8' })
    .split('\n')
    .filter((file) => file && !/\.test\.|\.spec\.|__tests__/.test(file))
    .slice(0, fleetSize);
  console.log(`fleet of ${files.length} agents on ${workspace} at ${serverUrl}\n`);
  const claimed: Claimed[] = [];
  try {
    for (const [index, file] of files.entries()) {
      const agentId = `${run}-${index}`;
      const started = Date.now();
      const answer = await post('/v1/coordination/claim', {
        mode: 'advisory', workspace, agent_id: agentId, agent_kind: 'other', intent: `fleet proof edit of ${file}`, paths: [file], symbols: [], ttl_ms: 300_000,
      });
      claimed.push({ agent_id: agentId, file, concepts: answer.concepts ?? [], awareness: answer.conceptual_awareness ?? [], analysis_ref: answer.analysis_ref, ms: Date.now() - started });
    }
    const placed = claimed.filter((claim) => claim.concepts.length > 0);
    check(placed.length > 0, `${placed.length} of ${claimed.length} claims were placed on analysed flow steps`);
    check(claimed.every((claim) => claim.analysis_ref?.analysis_id), 'every claim names the analysis it was placed against',
      claimed.filter((claim) => !claim.analysis_ref?.analysis_id).map((claim) => claim.file).join(', '));

    let crossFile = 0;
    let mismatches = 0;
    for (const [later, claim] of claimed.entries()) {
      for (const earlier of claimed.slice(0, later)) {
        const expected = relation(claim.concepts, earlier.concepts);
        const told = claim.awareness.find((neighbour) => neighbour.agent_id === earlier.agent_id);
        if ((expected === undefined) !== (told === undefined) || (told && reported(told) !== expected)) {
          mismatches += 1;
          if (mismatches <= 5) console.log(`        ${claim.file} vs ${earlier.file}: expected ${expected ?? 'nothing'}, told ${told ? reported(told) : 'nothing'}`);
        }
        if (told && claim.file !== earlier.file) crossFile += 1;
      }
    }
    check(mismatches === 0, 'each agent is told exactly the fleet members it shares a step, flow, entity or capability with');
    check(crossFile > 0, `${crossFile} pair(s) working in different files learned they share part of the product`);

    const latencies = claimed.map((claim) => claim.ms).sort((a, b) => a - b);
    const p95 = latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)];
    console.log(`\n  claim latency p50 ${latencies[Math.floor(latencies.length / 2)]} ms, p95 ${p95} ms`);
  } finally {
    for (const claim of claimed) await post('/v1/coordination/release', { workspace, agent_id: claim.agent_id }).catch(() => undefined);
  }
  const active = await get(`/v1/coordination/active?workspace=${encodeURIComponent(workspace)}`);
  const left = (active.active ?? []).filter((claim: { agent_id: string }) => claim.agent_id.startsWith(run));
  check(left.length === 0, 'releasing every fleet claim leaves none of them on the board');
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
