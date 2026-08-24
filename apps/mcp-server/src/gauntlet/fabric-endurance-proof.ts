import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { createRemoteAnalyzerHttpServer } from '../remote-analyzer-service';
import {
  remoteClaim,
  remoteExtend,
  remoteMergelessMetrics,
  remotePublishInFlight,
  remoteRelease,
} from '../coordination/remote-transport';

interface ClientResult {
  status: 'acknowledged' | 'queued';
  operation_id: string;
  claim_id?: string;
}

interface ExpectedOperation {
  operation_id: string;
  kind: 'claim' | 'extend' | 'release' | 'in-flight';
  participant_id: string;
}

export interface FabricEnduranceResult {
  source_identity: string;
  server_replica_count: 1;
  independent_client_processes: number;
  expected_operation_count: number;
  acknowledged_operation_count: number;
  permanently_lost_operation_count: number;
  recovered_operation_count: number;
  retry_count: number;
  transport_loss_count: number;
  expected_operation_ledger_digest: string;
  observed_operation_ledger_digest: string;
  capture_to_persist: unknown;
  persist_to_visible: unknown;
  visible_to_reconciled: unknown;
  duration_ms: number;
}

interface EnduranceOptions {
  participantCount?: number;
  sourceIdentity?: string;
}

const TOKEN = 'fabric-endurance-token';
const WORKSPACE = 'fabric-endurance-workspace';
const TSX = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');

function operationDigest(operationIds: string[]): string {
  return createHash('sha256').update([...operationIds].sort().join('\n')).digest('hex');
}

function sourceIdentity(): string {
  const require = createRequire(__filename);
  const resolver = require('../../scripts/build-source-identity.cjs') as {
    resolveBuildGitSha: (cwd: string, environment?: NodeJS.ProcessEnv) => string;
  };
  return process.env.KLAURO_SOURCE_IDENTITY || resolver.resolveBuildGitSha(path.resolve(__dirname, '..', '..'));
}

function listen(server: http.Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve((server.address() as { port: number }).port);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function runClient(args: string[], environment: NodeJS.ProcessEnv): Promise<ClientResult> {
  return new Promise((resolve, reject) => {
    const executable = fs.existsSync(TSX) ? TSX : 'npx';
    const executableArgs = fs.existsSync(TSX)
      ? [__filename, '--client', ...args]
      : ['tsx', __filename, '--client', ...args];
    const child = spawn(executable, executableArgs, { env: { ...process.env, ...environment } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => {
      if (status !== 0) {
        reject(new Error(`Fabric endurance client exited ${status}: ${stderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()) as ClientResult);
      } catch {
        reject(new Error(`Fabric endurance client returned invalid JSON: ${stdout}${stderr}`));
      }
    });
  });
}

async function clientMain(args: string[]): Promise<void> {
  const [kind, baseUrl, workspace, participantId, value] = args;
  const config = { baseUrl, token: TOKEN };
  try {
    if (kind === 'claim') {
      const result = await remoteClaim(config, {
        workspace,
        agentId: participantId,
        intent: `endurance work ${participantId}`,
        paths: [`src/${participantId}.ts`],
      });
      process.stdout.write(JSON.stringify({ status: 'acknowledged', operation_id: result.delivery_operation_id, claim_id: result.claim_id }));
      return;
    }
    if (kind === 'extend') {
      const result = await remoteExtend(config, { workspace, claimId: value, addPaths: [`src/${participantId}-extended.ts`] });
      process.stdout.write(JSON.stringify({ status: 'acknowledged', operation_id: result.delivery_operation_id, claim_id: result.claim_id }));
      return;
    }
    if (kind === 'release') {
      const result = await remoteRelease(config, { workspace, agentId: participantId });
      process.stdout.write(JSON.stringify({ status: 'acknowledged', operation_id: result.delivery_operation_id }));
      return;
    }
    if (kind === 'in-flight') {
      const result = await remotePublishInFlight(config, {
        workspace,
        agentId: participantId,
        attributionSource: 'participant-worktree',
        diffContext: '{}',
        changes: [{ symbol_id: `sym:${participantId}`, name: participantId, file: `src/${participantId}.ts`, change_kind: 'body' }],
        capturedAt: value,
      });
      process.stdout.write(JSON.stringify({ status: 'acknowledged', operation_id: result.delivery_operation_id }));
      return;
    }
    throw new Error(`Unsupported client operation ${kind}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const operationId = message.match(/op_[a-z0-9_-]+/i)?.[0];
    if (!operationId || !message.includes('queued durably')) throw error;
    process.stdout.write(JSON.stringify({ status: 'queued', operation_id: operationId }));
  }
}

export async function runFabricEnduranceProof(options: EnduranceOptions = {}): Promise<FabricEnduranceResult> {
  const startedAt = Date.now();
  const participantCount = Math.max(2, options.participantCount ?? 12);
  const identity = options.sourceIdentity ?? sourceIdentity();
  if (!identity.trim() || identity === 'unknown') {
    throw new Error('Fabric endurance proof requires KLAURO_SOURCE_IDENTITY or a build source identity');
  }
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'klauro-fabric-endurance-'));
  const serverData = path.join(root, 'server');
  const serverCoordination = path.join(serverData, 'coordination');
  process.env.KLAURO_REMOTE_ANALYZER_DATA = serverData;
  process.env.KLAURO_COORD_DIR = serverCoordination;
  let server = createRemoteAnalyzerHttpServer({ dataDir: serverData, token: TOKEN });
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  const expected: ExpectedOperation[] = [];
  const clientEnvironment = (participantId: string) => ({
    KLAURO_COORD_DIR: path.join(root, 'clients', participantId),
    KLAURO_SOURCE_IDENTITY: identity,
  });
  try {
    const claims = await Promise.all(Array.from({ length: participantCount }, async (_, index) => {
      const participantId = `participant-${index}`;
      const result = await runClient(['claim', baseUrl, WORKSPACE, participantId, ''], clientEnvironment(participantId));
      expected.push({ operation_id: result.operation_id, kind: 'claim', participant_id: participantId });
      return { participantId, claimId: result.claim_id as string };
    }));
    const capturedAt = new Date().toISOString();
    const snapshots = await Promise.all(claims.map(async ({ participantId }) => {
      const result = await runClient(['in-flight', baseUrl, WORKSPACE, participantId, capturedAt], clientEnvironment(participantId));
      expected.push({ operation_id: result.operation_id, kind: 'in-flight', participant_id: participantId });
      return result;
    }));
    if (snapshots.some((snapshot) => snapshot.status !== 'acknowledged')) throw new Error('Online snapshot unexpectedly queued');

    const extended = await runClient(
      ['extend', baseUrl, WORKSPACE, claims[0].participantId, claims[0].claimId],
      clientEnvironment(claims[0].participantId),
    );
    expected.push({ operation_id: extended.operation_id, kind: 'extend', participant_id: claims[0].participantId });

    await close(server);
    const faultParticipant = 'participant-fault';
    const faultEnvironment = clientEnvironment(faultParticipant);
    const queued = await runClient(['claim', baseUrl, WORKSPACE, faultParticipant, ''], faultEnvironment);
    if (queued.status !== 'queued') throw new Error('Faulted operation was not queued durably');
    expected.push({ operation_id: queued.operation_id, kind: 'claim', participant_id: faultParticipant });
    server = createRemoteAnalyzerHttpServer({ dataDir: serverData, token: TOKEN });
    await listen(server, port);
    const recovered = await runClient(['claim', baseUrl, WORKSPACE, faultParticipant, ''], faultEnvironment);
    if (recovered.status !== 'acknowledged' || recovered.operation_id !== queued.operation_id) {
      throw new Error('Faulted operation did not recover with its original identity');
    }

    const release = await runClient(
      ['release', baseUrl, WORKSPACE, claims.at(-1)!.participantId, ''],
      clientEnvironment(claims.at(-1)!.participantId),
    );
    expected.push({ operation_id: release.operation_id, kind: 'release', participant_id: claims.at(-1)!.participantId });

    const reconciliation = await fetch(`${baseUrl}/v1/coordination/intent-merge`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: WORKSPACE, agent_id: 'endurance-observer' }),
    });
    if (!reconciliation.ok) throw new Error(`Reconciliation failed with HTTP ${reconciliation.status}`);

    const metrics = await remoteMergelessMetrics({ baseUrl, token: TOKEN }, WORKSPACE);
    const expectedDigest = operationDigest(expected.map((operation) => operation.operation_id));
    const observedDigest = metrics.delivery.recent_operation_ledger_digest;
    const permanentLoss = Math.max(0, expected.length - metrics.delivery.ack_count);
    if (metrics.delivery.operation_count !== expected.length || expectedDigest !== observedDigest || permanentLoss !== 0) {
      throw new Error(`Operation ledger mismatch: expected=${expected.length}/${expectedDigest} observed=${metrics.delivery.operation_count}/${observedDigest}`);
    }
    return {
      source_identity: identity,
      server_replica_count: 1,
      independent_client_processes: participantCount * 2 + 4,
      expected_operation_count: expected.length,
      acknowledged_operation_count: metrics.delivery.ack_count,
      permanently_lost_operation_count: permanentLoss,
      recovered_operation_count: metrics.delivery.recovered_operation_count,
      retry_count: metrics.delivery.retry_count,
      transport_loss_count: metrics.delivery.transport_loss_count,
      expected_operation_ledger_digest: expectedDigest,
      observed_operation_ledger_digest: observedDigest,
      capture_to_persist: metrics.delivery.capture_to_persist,
      persist_to_visible: metrics.delivery.persist_to_visible,
      visible_to_reconciled: metrics.delivery.visible_to_reconciled,
      duration_ms: Date.now() - startedAt,
    };
  } finally {
    if (server.listening) await close(server);
    await fsp.rm(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--client') {
  clientMain(process.argv.slice(3)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
} else if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  runFabricEnduranceProof().then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
