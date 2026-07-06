/**
 * fab-remote-e2e.ts — loopback "two machines" proof for the cross-machine
 * coordination fabric (docs/FABRIC-REMOTE.md), driven through the CONFIG
 * PATH: no FAB_* env vars anywhere in the client processes.
 *
 * Boots the REAL analyzer service (createRemoteAnalyzerHttpServer, Bearer
 * token ON) on an ephemeral port, then simulates the documented second-machine
 * flow for TWO "machines" (separate repo dirs, separate processes, separate
 * local coord stores):
 *
 *   [stored login]                (seeded auth.json via KLAURO_AUTH_CONFIG_PATH)
 *   klauro init <repo>            (THE one onboarding: writes .klaurorc AND
 *                                  enables the fabric by default — no
 *                                  separate `fabric on` needed)
 *   fab.ts claim/check/release    (cwd = repo; transport resolved FROM CONFIG)
 *
 * Each "machine" gets its OWN isolated KLAURO_COORD_DIR, so the only channel
 * through which they can possibly see each other is the HTTP API — exactly
 * the second-machine-at-mcp.klauro.com topology, minus the WAN.
 *
 * Proves:
 *   0. ONE `klauro init` connects the repo end to end: resolves endpoint+token
 *      from stored credentials/config, persists {fabric:{enabled,endpoint,
 *      workspace}} by DEFAULT, NEVER writes the token into .klaurorc, and
 *      re-running init is idempotent (refresh, not an error).
 *   1. A claims a path -> B's check sees the conflict (cross-machine).
 *   2. B's claim warns inline (advisory: succeeds anyway).
 *   3. A releases -> B's check clears.
 *   4. Degrade: `fabric on` (surviving fine control) pointed at a dead URL
 *      persists with a loud warning, and a fab command in that repo warns +
 *      falls back to local (exit 0 — the advisory system never crashes the
 *      caller).
 *   5. `fabric status` shows enabled/endpoint/workspace/active claims;
 *      `fabric off` (the rare explicit opt-out) returns the repo to the local
 *      fabric — and a re-run of `klauro init` RESPECTS that opt-out.
 *   6. No config + no env = the original LOCAL fabric, unchanged (a repo that
 *      was never init'd stays local).
 *   7. Stress: 20 concurrent remote claims from 2 simulated machines — no
 *      lost/duplicate seq, all visible; reports p50/p95 HTTP claim latency.
 *
 *   npx tsx apps/mcp-server/scripts/fab-remote-e2e.ts
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createRemoteAnalyzerHttpServer } from '../src/remote-analyzer-service';
import { remoteActive, remoteClaim } from '../src/coordination/remote-transport';

const TOKEN = 'e2e-fabric-token';
const WS = 'e2e-two-machines';
const FAB = path.join(__dirname, 'fab.ts');
const CLI = path.join(__dirname, '..', 'src', 'cli.ts');
const TSX = path.join(__dirname, '..', '..', '..', 'node_modules', '.bin', 'tsx');

interface ChildRun {
  stdout: string;
  stderr: string;
  status: number;
}

/**
 * Env for every child process: inherit, but SCRUB every fabric/credential
 * env var — the whole point of this e2e is that the config file + stored
 * auth drive the transport, so any FAB_ / KLAURO_ token or URL leaking in
 * from the host shell would invalidate the proof.
 */
function scrubbedEnv(extra: Record<string, string>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of [
    'FAB_REMOTE_URL', 'FAB_REMOTE_TOKEN', 'FAB_WS', 'FAB_TTL_MS',
    'KLAURO_ACCOUNT_TOKEN', 'KLAURO_AUTH_TOKEN', 'KLAURO_ANALYZER_TOKEN',
    'KLAURO_API_URL', 'KLAURO_ANALYZER_URL', 'KLAURO_URL',
    'KLAURO_AUTH_CONFIG_PATH', 'KLAURO_COORD_DIR',
  ]) delete env[key];
  return { ...env, ...extra };
}

/**
 * Run a script as a REAL separate OS process, as one "machine". Async on
 * purpose: the analyzer service lives in THIS process, so a spawnSync here
 * would block the event loop and the server could never answer the child
 * (self-inflicted deadlock — the child times out "unreachable").
 */
function run(script: string, args: string[], env: Record<string, string>, cwd?: string): Promise<ChildRun> {
  return new Promise((resolve) => {
    const child = spawn(fs.existsSync(TSX) ? TSX : 'npx', fs.existsSync(TSX) ? [script, ...args] : ['tsx', script, ...args], {
      env: scrubbedEnv(env),
      cwd,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ stdout, stderr, status: status ?? -1 }));
  });
}

function assert(cond: boolean, label: string, detail?: string): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    console.error(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
    process.exitCode = 1;
  }
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-fab-remote-e2e-'));
  // SERVER-side store (the shared truth) — isolated from both "machines".
  process.env.KLAURO_COORD_DIR = path.join(root, 'server-coord');
  process.env.KLAURO_REMOTE_ANALYZER_DATA = path.join(root, 'server-data');

  const server = createRemoteAnalyzerHttpServer({ dataDir: path.join(root, 'server-data'), token: TOKEN });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`analyzer service up at ${baseUrl} (Bearer auth ON)\n`);

  // The stored credential file `klauro init`/`klauro login` would have
  // written (~/.klauro/auth.json in real life) — the ONLY place the token
  // lives on a "machine". Both machines share the same account, as a real
  // team would.
  const authPath = path.join(root, 'auth.json');
  fs.writeFileSync(authPath, JSON.stringify({
    version: 1,
    defaultServerUrl: baseUrl,
    accounts: {
      [baseUrl]: { token: TOKEN, email: 'e2e@klauro.test', updated_at: new Date().toISOString() },
      // A second stored login for the "service is down" scenario [7]: the
      // user authenticated against it earlier; it is currently unreachable.
      'http://127.0.0.1:1': { token: TOKEN, email: 'e2e@klauro.test', updated_at: new Date().toISOString() },
    },
  }, null, 2));

  // Two "machines": separate repo dirs, separate processes, separate local
  // coord dirs. NO FAB_* env vars — the .klaurorc written by `fabric on` is
  // the only transport configuration. The ONLY shared state is the HTTP API.
  const repoA = path.join(root, 'machine-a', 'repo');
  const repoB = path.join(root, 'machine-b', 'repo');
  fs.mkdirSync(repoA, { recursive: true });
  fs.mkdirSync(repoB, { recursive: true });
  const machineA = { KLAURO_AUTH_CONFIG_PATH: authPath, KLAURO_COORD_DIR: path.join(root, 'machine-a-coord') };
  const machineB = { KLAURO_AUTH_CONFIG_PATH: authPath, KLAURO_COORD_DIR: path.join(root, 'machine-b-coord') };
  const fabA = (args: string[]) => run(FAB, args, machineA, repoA);
  const fabB = (args: string[]) => run(FAB, args, machineB, repoB);

  try {
    console.log('[0] second-machine flow: ONE `klauro init` per machine (fabric on by default, config-driven)');
    for (const [name, repo, env] of [['A', repoA, machineA], ['B', repoB, machineB]] as const) {
      const init = await run(CLI, ['init', repo, '--workspace', WS, '--server-url', baseUrl, '--json'], env);
      let payload: any = {};
      try { payload = JSON.parse(init.stdout); } catch { /* asserted below */ }
      assert(init.status === 0 && fs.existsSync(path.join(repo, '.klaurorc')), `machine ${name}: klauro init writes .klaurorc`, init.stdout + init.stderr);
      assert(payload.status === 'connected' && payload.signed_in === true,
        `machine ${name}: init reused the STORED credentials (no prompt, no env var)`, init.stdout + init.stderr);
      assert(payload.fabric?.enabled === true && payload.fabric.endpoint === baseUrl && payload.fabric.workspace === WS,
        `machine ${name}: init enabled the fabric BY DEFAULT with endpoint+workspace (no separate \`fabric on\`)`, init.stdout + init.stderr);
      const fabricStep = (payload.steps || []).find((s: any) => s.step === 'fabric');
      assert(fabricStep?.status === 'ok' && /reachable/.test(fabricStep?.detail || ''),
        `machine ${name}: init verified the fabric service with the STORED token`, init.stdout + init.stderr);
      const rc = fs.readFileSync(path.join(repo, '.klaurorc'), 'utf8');
      const parsed = JSON.parse(rc);
      assert(parsed.fabric?.enabled === true && parsed.fabric.endpoint === baseUrl && parsed.fabric.workspace === WS,
        `machine ${name}: .klaurorc carries {fabric:{enabled,endpoint,workspace}}`, rc);
      assert(!rc.includes(TOKEN), `machine ${name}: the token is NEVER written into .klaurorc`, rc);
    }

    console.log('[0b] re-running init is idempotent (refresh, not an error)');
    const reInit = await run(CLI, ['init', repoA, '--json'], machineA);
    let reInitPayload: any = {};
    try { reInitPayload = JSON.parse(reInit.stdout); } catch { /* asserted below */ }
    assert(reInit.status === 0 && reInitPayload.status === 'connected' && reInitPayload.idempotent === true,
      're-init exits 0 and reports the existing connection', reInit.stdout + reInit.stderr);
    assert(reInitPayload.fabric?.enabled === true && reInitPayload.fabric.endpoint === baseUrl && reInitPayload.fabric.workspace === WS,
      're-init preserves the fabric section (endpoint + workspace unchanged)', reInit.stdout + reInit.stderr);

    console.log('[1] machine A claims src/payments/charge.ts (no env vars — config only)');
    const aClaim = await fabA(['claim', 'agent-A', 'rework charge flow', 'src/payments/charge.ts']);
    assert(aClaim.status === 0 && /claimed seq=\d+/.test(aClaim.stdout) && aClaim.stdout.includes('[remote'), 'A claim granted via remote API', aClaim.stdout + aClaim.stderr);

    console.log('[2] machine B checks the same path — must see A across machines');
    const bCheck = await fabB(['check', 'agent-B', 'src/payments/charge.ts']);
    assert(bCheck.status === 0 && bCheck.stdout.includes('CONFLICT') && bCheck.stdout.includes('agent-A'), "B's check sees agent-A's claim (cross-machine)", bCheck.stdout + bCheck.stderr);

    console.log('[3] machine B claims anyway — advisory: succeeds WITH a warning');
    const bClaim = await fabB(['claim', 'agent-B', 'fix charge rounding', 'src/payments/charge.ts']);
    assert(bClaim.status === 0 && /claimed seq=\d+/.test(bClaim.stdout), "B's claim still succeeds (advisory, never a lockout)", bClaim.stdout + bClaim.stderr);
    assert(bClaim.stderr.includes('agent-A'), "B's claim warns inline, naming agent-A", bClaim.stderr);

    console.log('[4] fabric status on machine A shows the shared awareness surface');
    const status = await run(CLI, ['fabric', 'status', repoA, '--json'], machineA);
    let statusPayload: any = {};
    try { statusPayload = JSON.parse(status.stdout); } catch { /* asserted below */ }
    assert(status.status === 0 && statusPayload.enabled === true && statusPayload.workspace === WS
      && Array.isArray(statusPayload.active_claims)
      && statusPayload.active_claims.some((c: any) => c.agent_id === 'agent-B'),
      'fabric status: enabled + endpoint + workspace + cross-machine active claims', status.stdout + status.stderr);

    console.log('[5] machine A releases');
    const aRelease = await fabA(['release', 'agent-A']);
    assert(aRelease.status === 0 && /released agent-A \(1 claim\)/.test(aRelease.stdout), 'A releases its claim via remote API', aRelease.stdout + aRelease.stderr);

    console.log('[6] machine B re-checks — conflict cleared');
    const bRecheck = await fabB(['check', 'agent-B', 'src/payments/charge.ts']);
    assert(bRecheck.status === 0 && bRecheck.stdout.includes('OK: no conflicting'), "B's check clears after A's release", bRecheck.stdout + bRecheck.stderr);
    await fabB(['release', 'agent-B']);

    console.log('[7] degrade: fabric on to a DEAD endpoint persists with a warning; fab falls back to local');
    const deadOn = await run(CLI, ['fabric', 'on', repoB, '--workspace', WS, '--server-url', 'http://127.0.0.1:1', '--json'], machineB);
    let deadPayload: any = {};
    try { deadPayload = JSON.parse(deadOn.stdout); } catch { /* asserted below */ }
    assert(deadOn.status === 0 && deadPayload.status === 'enabled' && deadPayload.reachable === false,
      'fabric on persists even when the service is unreachable (advisory: loud, not fatal)', deadOn.stdout + deadOn.stderr);
    const dead = await fabB(['check', 'agent-B', 'src/anything.ts']);
    assert(dead.status === 0, 'degraded command exits 0', `status=${dead.status} ${dead.stderr}`);
    assert(dead.stderr.includes('Degrading to LOCAL fabric'), 'degrade is announced loudly on stderr', dead.stderr);
    assert(dead.stdout.includes('OK: no conflicting'), 'local fallback still answers', dead.stdout);

    console.log('[8] fabric off returns the repo to the local fabric');
    const off = await run(CLI, ['fabric', 'off', repoB, '--json'], machineB);
    assert(off.status === 0 && off.stdout.includes('"disabled"'), 'fabric off flips the config', off.stdout + off.stderr);
    const localAfterOff = await fabB(['active']);
    assert(localAfterOff.status === 0 && !localAfterOff.stdout.includes('[remote') && !localAfterOff.stderr.includes('Degrading'),
      'after fabric off, fab is cleanly LOCAL (no remote attempt, no degrade warning)', localAfterOff.stdout + localAfterOff.stderr);

    console.log('[8b] re-running init RESPECTS the explicit fabric opt-out');
    const initAfterOff = await run(CLI, ['init', repoB, '--json'], machineB);
    let initAfterOffPayload: any = {};
    try { initAfterOffPayload = JSON.parse(initAfterOff.stdout); } catch { /* asserted below */ }
    const fabricStepAfterOff = (initAfterOffPayload.steps || []).find((s: any) => s.step === 'fabric');
    assert(initAfterOff.status === 0 && initAfterOffPayload.fabric?.enabled === false && fabricStepAfterOff?.status === 'skip',
      'init does not flip a deliberately disabled fabric back on', initAfterOff.stdout + initAfterOff.stderr);

    console.log('[9] no config + no env = the original local fabric, unchanged');
    const plain = path.join(root, 'plain-dir');
    fs.mkdirSync(plain, { recursive: true });
    const plainRun = await run(FAB, ['check', 'agent-X', 'src/anything.ts'], { KLAURO_COORD_DIR: path.join(root, 'plain-coord') }, plain);
    assert(plainRun.status === 0 && plainRun.stdout.includes('OK: no conflicting') && !plainRun.stdout.includes('[remote'),
      'unconfigured dir stays byte-for-byte local', plainRun.stdout + plainRun.stderr);

    console.log('\n[10] stress: 20 concurrent remote claims across 2 simulated machines');
    const config = { baseUrl, token: TOKEN };
    const stressWs = 'e2e-stress';
    const latencies: number[] = [];
    const results = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const started = Date.now();
        const res = await remoteClaim(config, {
          workspace: stressWs,
          agentId: `machine-${i % 2 === 0 ? 'A' : 'B'}-agent-${i}`,
          intent: `stress task ${i}`,
          paths: [`src/stress/task-${i}.ts`],
        });
        latencies.push(Date.now() - started);
        return res;
      })
    );
    const seqs = new Set(results.map((r) => r.seq));
    assert(seqs.size === 20, '20/20 claims got distinct server seq (no lost/corrupt claims)', `distinct=${seqs.size}`);
    const active = await remoteActive(config, stressWs);
    assert(active.count === 20, '20/20 claims visible in shared /active view', `count=${active.count}`);
    const sorted = [...latencies].sort((x, y) => x - y);
    console.log(
      `  HTTP claim latency over loopback (lower bound for WAN): ` +
        `p50=${percentile(sorted, 50)}ms p95=${percentile(sorted, 95)}ms max=${sorted[sorted.length - 1]}ms (n=20, concurrent)`
    );

    console.log(`\n${process.exitCode ? 'E2E FAILED' : 'E2E PASSED'} — two machines coordinated purely over HTTP at ${baseUrl}, configured only by one \`klauro init\` each (fabric included by default)`);
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
