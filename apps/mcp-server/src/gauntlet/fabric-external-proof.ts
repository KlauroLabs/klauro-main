import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { hostname } from 'node:os';
import { lookup } from 'node:dns/promises';

import type { FlowConcept } from '../../../../packages/analyzer-core/src/types/cas.types';
import { getAnalysis } from '../analyzer';
import * as query from '../query';
import { buildConceptIndex, deriveConceptualCoordinate } from '../coordination/conceptual-scope';
import {
  remoteActive,
  remoteClaim,
  remoteExtend,
  remoteMergelessMetrics,
  remotePublishInFlight,
  remoteRelease,
  type RemoteActiveResult,
} from '../coordination/remote-transport';
import type { ConceptualCoordinate } from '../coordination/types';
import {
  operationLedgerDigest,
  validateExternalFabricProofReceipt,
  type ExternalFabricMachineAttestation,
  type ExternalFabricOperationReceipt,
  type ExternalFabricProofReceipt,
  type ExternalFabricServerAttestation,
  type ExternalFabricVisibilityReceipt,
} from './fabric-external-proof-contract';

interface ClientHostConfig {
  ssh_target: string;
  checkout_path: string;
  artifact_path: string;
  repo_path: string;
  coordination_dir: string;
  participant_id: string;
  symbol: string;
  claim_path: string;
}

export interface ExternalFabricProofConfig {
  expected_source_sha: string;
  expected_client_artifact_sha256: string;
  expected_server_image_digest: string;
  server_url: string;
  workspace: string;
  token_env: string;
  allow_service_restart: true;
  clients: [ClientHostConfig, ClientHostConfig];
  server_control: { ssh_target: string; container_name: string };
  server_memory_budget_bytes: number;
  client_rss_budget_bytes: number;
  output_path?: string;
}

type ClientAction = 'attest' | 'claim' | 'extend' | 'in-flight' | 'observe' | 'release' | 'cleanup-in-flight' | 'reconcile' | 'metrics';

interface ClientRequest {
  action: ClientAction;
  expected_source_sha: string;
  expected_client_artifact_sha256: string;
  server_url: string;
  token: string;
  workspace: string;
  host: ClientHostConfig;
  concept?: ConceptualCoordinate;
  claim_id?: string;
  queued_extension?: boolean;
}

interface WorkerEnvelope<T = unknown> {
  value: T;
  max_rss_bytes: number;
}

interface ClaimValue {
  claim_id: string;
  operation_id: string;
  conceptual_overlap_observed: boolean;
}

interface OperationValue {
  operation_id: string;
  queued?: boolean;
}

interface DockerInspect {
  Id?: string;
  Image?: string;
  State?: { StartedAt?: string };
  HostConfig?: { Memory?: number };
}

const SCRIPT_PATH = 'apps/mcp-server/src/gauntlet/fabric-external-proof.ts';
const SHA256 = /^[0-9a-f]{64}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const SAFE_CONTAINER = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function fileSha256(file: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

function gitOutput(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function maxRssBytes(): number {
  return process.resourceUsage().maxRSS * 1024;
}

function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized === 'localhost' || normalized === '::1' || normalized === '0.0.0.0' || normalized.startsWith('127.') || normalized.startsWith('::ffff:127.');
}

async function readWorkerRequest(): Promise<ClientRequest> {
  let body = '';
  for await (const chunk of process.stdin) body += chunk;
  return JSON.parse(body) as ClientRequest;
}

function clientConfig(request: ClientRequest): { baseUrl: string; token: string } {
  process.env.KLAURO_COORD_DIR = request.host.coordination_dir;
  process.env.KLAURO_SOURCE_IDENTITY = request.expected_source_sha;
  return { baseUrl: request.server_url, token: request.token };
}

async function attest(request: ClientRequest): Promise<ExternalFabricMachineAttestation> {
  const sourceSha = gitOutput(request.host.checkout_path, ['rev-parse', 'HEAD']);
  const sourceClean = gitOutput(request.host.checkout_path, ['status', '--porcelain', '-uall']) === '';
  const serverHostname = new URL(request.server_url).hostname;
  const serverAddresses = await lookup(serverHostname, { all: true });
  if (!serverAddresses.length || serverAddresses.some((entry) => isLoopbackAddress(entry.address))) throw new Error('Fabric service resolved to loopback');
  const artifactDigest = await fileSha256(request.host.artifact_path);
  if (sourceSha !== request.expected_source_sha || !sourceClean) throw new Error('client source is not the expected clean commit');
  if (artifactDigest !== request.expected_client_artifact_sha256) throw new Error('client artifact digest mismatch');

  const cas = await getAnalysis(request.host.repo_path, { sections: ['comprehension'] });
  if (cas.base_commit !== request.expected_source_sha) throw new Error('client CAS was not generated from the expected commit');
  const { flows } = query.getFlowConcepts(cas, { maxFlows: 2_000, detail: 'full' }) as { flows: FlowConcept[] };
  const concept = deriveConceptualCoordinate({ scope: { paths: [], symbols: [request.host.symbol] } }, buildConceptIndex(flows));
  if (!concept?.flow_id || !concept.step_id || concept.source !== 'derived') throw new Error('proof symbol does not resolve to a CAS-derived flow step');
  const selectedFlow = flows.find((flow) => flow.flow_id === concept.flow_id);
  const selectedStep = selectedFlow?.steps.find((step) => step.step_id === concept.step_id);
  const casEvidence = JSON.stringify({
    flow_id: concept.flow_id,
    step_id: concept.step_id,
    capability_id: concept.capability_id ?? null,
    entities: [...(concept.entities ?? [])].sort(),
    functions: selectedStep?.functions.map((fn) => fn.function_id).sort() ?? [],
  });
  return {
    participant_id: request.host.participant_id,
    machine_id_sha256: sha256((await fsp.readFile('/etc/machine-id', 'utf8')).trim()),
    server_addresses: serverAddresses.map((entry) => entry.address).sort(),
    boot_id_sha256: sha256((await fsp.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()),
    hostname_sha256: sha256(hostname()),
    physical_host_id_sha256: sha256((await fsp.readFile('/sys/class/dmi/id/product_uuid', 'utf8')).trim()),
    source_sha: sourceSha,
    source_clean: sourceClean,
    analysis_source_sha: cas.base_commit,
    client_artifact_sha256: artifactDigest,
    cas_evidence_sha256: sha256(casEvidence),
    concept,
    max_rss_bytes: maxRssBytes(),
  };
}

function queuedOperationId(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes('queued durably')) return undefined;
  return message.match(/op_[a-z0-9_-]+/i)?.[0];
}

function conceptsOverlap(left?: ConceptualCoordinate, right?: ConceptualCoordinate): boolean {
  if (!left || !right) return false;
  if (left.flow_id && left.flow_id === right.flow_id && left.step_id && left.step_id === right.step_id) return true;
  const rightEntities = new Set(right.entities ?? []);
  return (left.entities ?? []).some((entity) => rightEntities.has(entity));
}

function visibility(active: RemoteActiveResult): ExternalFabricVisibilityReceipt {
  const state = {
    active: active.active.map((claim) => ({
      agent_id: claim.agent_id,
      claim_id: claim.claim_id,
      paths: [...claim.paths].sort(),
      symbols: [...claim.symbols].sort(),
      concept: claim.concept ?? null,
    })).sort((left, right) => left.agent_id.localeCompare(right.agent_id)),
    in_flight: (active.in_flight ?? []).filter((snapshot) => snapshot.changes_count > 0).map((snapshot) => ({
      agent_id: snapshot.agent_id,
      base_commit: snapshot.base_commit,
      attribution_source: snapshot.attribution_source,
      changes: snapshot.changes.map((change) => ({
        symbol_id: change.symbol_id,
        file: change.file,
        change_kind: change.change_kind,
      })).sort((left, right) => left.symbol_id.localeCompare(right.symbol_id)),
    })).sort((left, right) => left.agent_id.localeCompare(right.agent_id)),
  };
  return {
    epoch: active.epoch ?? '',
    max_seq: active.max_seq,
    active_participants: active.active.map((claim) => claim.agent_id).sort(),
    in_flight_participants: (active.in_flight ?? [])
      .filter((snapshot) => snapshot.changes_count > 0)
      .map((snapshot) => snapshot.agent_id)
      .sort(),
    conceptual_overlap_observed: active.active.some((claim, index) =>
      active.active.slice(index + 1).some((other) => conceptsOverlap(claim.concept, other.concept))),
    state_sha256: sha256(JSON.stringify(state)),
  };
}

async function executeClient(request: ClientRequest): Promise<unknown> {
  if (request.action === 'attest') return attest(request);
  const config = clientConfig(request);
  if (request.action === 'claim') {
    if (!request.concept) throw new Error('claim requires a derived concept');
    const result = await remoteClaim(config, {
      workspace: request.workspace,
      agentId: request.host.participant_id,
      intent: `external proof ${request.host.participant_id}`,
      paths: [request.host.claim_path],
      symbols: [request.host.symbol],
      concept: request.concept,
    });
    return {
      claim_id: result.claim_id,
      operation_id: result.delivery_operation_id,
      conceptual_overlap_observed: (result.conceptual_awareness ?? []).length > 0,
    } satisfies ClaimValue;
  }
  if (request.action === 'extend') {
    if (!request.claim_id || !request.concept) throw new Error('extend requires claim and concept');
    try {
      const result = await remoteExtend(config, {
        workspace: request.workspace,
        claimId: request.claim_id,
        addPaths: [`${request.host.claim_path}.extended`],
        addSymbols: [`${request.host.symbol}:extended`],
        concept: request.concept,
      });
      return { operation_id: result.delivery_operation_id } satisfies OperationValue;
    } catch (error) {
      const operationId = queuedOperationId(error);
      if (!request.queued_extension || !operationId) throw error;
      return { operation_id: operationId, queued: true } satisfies OperationValue;
    }
  }
  if (request.action === 'in-flight' || request.action === 'cleanup-in-flight') {
    const cleanup = request.action === 'cleanup-in-flight';
    const result = await remotePublishInFlight(config, {
      workspace: request.workspace,
      agentId: request.host.participant_id,
      baseCommit: request.expected_source_sha,
      attributionSource: 'participant-worktree',
      diffContext: '{}',
      capturedAt: new Date().toISOString(),
      changes: cleanup ? [] : [{
        symbol_id: request.host.symbol,
        name: request.host.symbol,
        file: request.host.claim_path,
        change_kind: 'body',
      }],
    });
    return { operation_id: result.delivery_operation_id } satisfies OperationValue;
  }
  if (request.action === 'release') {
    const result = await remoteRelease(config, { workspace: request.workspace, agentId: request.host.participant_id });
    if (result.status !== 'released' || result.released_count < 1) throw new Error('release did not remove the participant claim');
    return { operation_id: result.delivery_operation_id } satisfies OperationValue;
  }
  if (request.action === 'observe') return visibility(await remoteActive(config, request.workspace));
  if (request.action === 'reconcile') {
    const response = await fetch(`${request.server_url.replace(/\/+$/, '')}/v1/coordination/intent-merge`, {
      method: 'POST',
      headers: { authorization: `Bearer ${request.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: request.workspace, agent_id: request.host.participant_id }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`reconciliation failed with HTTP ${response.status}`);
    return { reconciled: true };
  }
  if (request.action === 'metrics') return remoteMergelessMetrics(config, request.workspace);
  throw new Error(`unsupported client action ${request.action}`);
}

async function clientMain(): Promise<void> {
  const value = await executeClient(await readWorkerRequest());
  process.stdout.write(`${JSON.stringify({ value, max_rss_bytes: maxRssBytes() } satisfies WorkerEnvelope)}\n`);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function runProcess(executable: string, args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => status === 0 ? resolve(stdout) : reject(new Error(`${executable} exited ${status}: ${stderr || stdout}`)));
    child.stdin.end(stdin);
  });
}

function rejectLocalTarget(target: string): void {
  const host = target.split('@').at(-1)?.split(':')[0]?.toLowerCase() ?? '';
  if (!host || host === 'localhost' || host === '::1' || host === '0.0.0.0' || host.startsWith('127.')) {
    throw new Error(`SSH target must be a non-loopback host: ${target}`);
  }
}

async function runRemote<T>(host: ClientHostConfig, request: ClientRequest): Promise<WorkerEnvelope<T>> {
  rejectLocalTarget(host.ssh_target);
  const command = `cd ${shellQuote(host.checkout_path)} && ./node_modules/.bin/tsx ${shellQuote(SCRIPT_PATH)} --client`;
  const output = await runProcess('ssh', ['-T', host.ssh_target, command], JSON.stringify(request));
  return JSON.parse(output) as WorkerEnvelope<T>;
}

async function runServerCommand(config: ExternalFabricProofConfig, command: string): Promise<string> {
  rejectLocalTarget(config.server_control.ssh_target);
  return runProcess('ssh', ['-T', config.server_control.ssh_target, command]);
}

async function containerHealth(config: ExternalFabricProofConfig): Promise<{ build?: { git_sha?: string; dirty?: boolean } }> {
  const container = config.server_control.container_name;
  const script = 'fetch("http://127.0.0.1:8788/health").then(async response => { if (!response.ok) process.exit(2); process.stdout.write(await response.text()); }).catch(() => process.exit(3))';
  const output = await runServerCommand(
    config,
    `docker exec ${shellQuote(container)} node -e ${shellQuote(script)}`,
  );
  return JSON.parse(output) as { build?: { git_sha?: string; dirty?: boolean } };
}

async function inspectServer(config: ExternalFabricProofConfig): Promise<ExternalFabricServerAttestation> {
  const container = config.server_control.container_name;
  if (!SAFE_CONTAINER.test(container)) throw new Error('server container name is unsafe');
  const raw = await runServerCommand(config, `docker inspect ${shellQuote(container)}`);
  const inspect = (JSON.parse(raw) as DockerInspect[])[0];
  if (!inspect?.Id || !inspect.Image || !inspect.State?.StartedAt) throw new Error('docker inspect omitted server identity');
  const cgroup = await runServerCommand(
    config,
    `docker exec ${shellQuote(container)} sh -c ${shellQuote('cat /sys/fs/cgroup/memory.peak; cat /sys/fs/cgroup/memory.events')}`,
  );
  const [peakLine, ...eventLines] = cgroup.trim().split('\n');
  const events = Object.fromEntries(eventLines.map((line) => {
    const [name, count] = line.trim().split(/\s+/);
    return [name, Number(count)];
  }));
  const body = await containerHealth(config);
  return {
    health_source_sha: body.build?.git_sha ?? '',
    health_dirty: body.build?.dirty !== false,
    image_digest: inspect.Image,
    container_id: inspect.Id,
    started_at: inspect.State.StartedAt,
    memory_limit_bytes: inspect.HostConfig?.Memory ?? 0,
    memory_peak_bytes: Number(peakLine),
    memory_events: events,
  };
}

async function waitForHealth(config: ExternalFabricProofConfig): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      if ((await containerHealth(config)).build?.git_sha) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Fabric server did not become healthy after restart');
}

function operation(kind: ExternalFabricOperationReceipt['kind'], participant: string, value: OperationValue, status: ExternalFabricOperationReceipt['status']): ExternalFabricOperationReceipt {
  return { kind, participant_id: participant, operation_id: value.operation_id, status };
}

export async function runExternalFabricProof(config: ExternalFabricProofConfig): Promise<ExternalFabricProofReceipt> {
  if (!FULL_SHA.test(config.expected_source_sha)) throw new Error('expected_source_sha must be a full commit SHA');
  if (!SHA256.test(config.expected_client_artifact_sha256)) throw new Error('expected client artifact digest is invalid');
  if (!/^sha256:[0-9a-f]{64}$/.test(config.expected_server_image_digest)) throw new Error('expected server image digest is invalid');
  if (config.clients[0].ssh_target === config.clients[1].ssh_target) throw new Error('two distinct SSH client targets are required');
  const serverUrl = new URL(config.server_url);
  if (serverUrl.protocol !== 'https:' || isLoopbackAddress(serverUrl.hostname)) throw new Error('server_url must be non-loopback HTTPS');
  if (!config.workspace.startsWith('fabric-external-proof-')) throw new Error('proof workspace must use the fabric-external-proof- prefix');
  if (config.allow_service_restart !== true) throw new Error('allow_service_restart must explicitly authorize the isolated service restart');
  if (!Number.isSafeInteger(config.server_memory_budget_bytes) || config.server_memory_budget_bytes <= 0) throw new Error('server memory budget is invalid');
  if (!Number.isSafeInteger(config.client_rss_budget_bytes) || config.client_rss_budget_bytes <= 0) throw new Error('client RSS budget is invalid');
  if (!SAFE_CONTAINER.test(config.server_control.container_name)) throw new Error('server container name is unsafe');
  const token = process.env[config.token_env];
  if (!token) throw new Error(`missing Fabric token environment variable ${config.token_env}`);

  const baseRequest = (host: ClientHostConfig, action: ClientAction): ClientRequest => ({
    action,
    expected_source_sha: config.expected_source_sha,
    expected_client_artifact_sha256: config.expected_client_artifact_sha256,
    server_url: config.server_url,
    token,
    workspace: config.workspace,
    host,
  });
  const rss = new Map(config.clients.map((client) => [client.participant_id, 0]));
  const invoke = async <T>(index: 0 | 1, request: ClientRequest): Promise<T> => {
    const envelope = await runRemote<T>(config.clients[index], request);
    rss.set(config.clients[index].participant_id, Math.max(rss.get(config.clients[index].participant_id) ?? 0, envelope.max_rss_bytes));
    return envelope.value;
  };

  const attestations = await Promise.all([
    invoke<ExternalFabricMachineAttestation>(0, baseRequest(config.clients[0], 'attest')),
    invoke<ExternalFabricMachineAttestation>(1, baseRequest(config.clients[1], 'attest')),
  ]) as [ExternalFabricMachineAttestation, ExternalFabricMachineAttestation];
  if (attestations[0].machine_id_sha256 === attestations[1].machine_id_sha256
    || attestations[0].physical_host_id_sha256 === attestations[1].physical_host_id_sha256
    || attestations[0].hostname_sha256 === attestations[1].hostname_sha256) {
    throw new Error('two independently attested client machines are required');
  }
  if (attestations[0].cas_evidence_sha256 !== attestations[1].cas_evidence_sha256
    || !conceptsOverlap(attestations[0].concept, attestations[1].concept)) {
    throw new Error('clients did not derive the same overlapping CAS concept');
  }
  if (attestations.some((entry) => entry.max_rss_bytes > config.client_rss_budget_bytes)) throw new Error('client attestation exceeded the RSS budget');
  const serverBeforeRestart = await inspectServer(config);
  if (serverBeforeRestart.health_source_sha !== config.expected_source_sha || serverBeforeRestart.health_dirty
    || serverBeforeRestart.image_digest !== config.expected_server_image_digest
    || serverBeforeRestart.memory_limit_bytes <= 0 || serverBeforeRestart.memory_limit_bytes > config.server_memory_budget_bytes) {
    throw new Error('server is not the expected source, image, or cgroup envelope');
  }
  const operations: ExternalFabricOperationReceipt[] = [];
  const claims: ClaimValue[] = [];
  for (const index of [0, 1] as const) {
    const request = { ...baseRequest(config.clients[index], 'claim'), concept: attestations[index].concept };
    const claimed = await invoke<ClaimValue>(index, request);
    claims[index] = claimed;
    operations.push(operation('claim', config.clients[index].participant_id, claimed, 'acknowledged'));
  }
  if (!claims[1].conceptual_overlap_observed) throw new Error('second host did not observe the first host conceptual claim');

  const initialExtend = await invoke<OperationValue>(0, {
    ...baseRequest(config.clients[0], 'extend'), concept: attestations[0].concept, claim_id: claims[0].claim_id,
  });
  operations.push(operation('extend', config.clients[0].participant_id, initialExtend, 'acknowledged'));
  for (const index of [0, 1] as const) {
    const inFlight = await invoke<OperationValue>(index, baseRequest(config.clients[index], 'in-flight'));
    operations.push(operation('in-flight', config.clients[index].participant_id, inFlight, 'acknowledged'));
  }
  const visibilityBeforeRestart = await invoke<ExternalFabricVisibilityReceipt>(1, baseRequest(config.clients[1], 'observe'));

  let queued: OperationValue | undefined;
  let restartRequested = false;
  try {
    restartRequested = true;
    await runServerCommand(config, `docker stop ${shellQuote(config.server_control.container_name)}`);
    queued = await invoke<OperationValue>(0, {
      ...baseRequest(config.clients[0], 'extend'), concept: attestations[0].concept, claim_id: claims[0].claim_id, queued_extension: true,
    });
    if (!queued.queued) throw new Error('operation sent during outage was not queued');
  } finally {
    if (restartRequested) await runServerCommand(config, `docker start ${shellQuote(config.server_control.container_name)}`);
    if (restartRequested) await waitForHealth(config);
  }
  if (!queued) throw new Error('faulted operation did not produce a durable receipt');
  operations.push(operation('extend', config.clients[0].participant_id, queued, 'queued'));
  const replayed = await invoke<OperationValue>(0, {
    ...baseRequest(config.clients[0], 'extend'), concept: attestations[0].concept, claim_id: claims[0].claim_id,
  });
  operations.push(operation('extend', config.clients[0].participant_id, replayed, 'replayed'));
  const visibilityAfterRestart = await invoke<ExternalFabricVisibilityReceipt>(1, baseRequest(config.clients[1], 'observe'));
  const serverAfterRestart = await inspectServer(config);

  await invoke(1, baseRequest(config.clients[1], 'reconcile'));
  for (const index of [0, 1] as const) {
    const cleared = await invoke<OperationValue>(index, baseRequest(config.clients[index], 'cleanup-in-flight'));
    operations.push(operation('in-flight', config.clients[index].participant_id, cleared, 'acknowledged'));
    const released = await invoke<OperationValue>(index, baseRequest(config.clients[index], 'release'));
    operations.push(operation('release', config.clients[index].participant_id, released, 'acknowledged'));
  }
  const visibilityAfterCleanup = await invoke<ExternalFabricVisibilityReceipt>(1, baseRequest(config.clients[1], 'observe'));
  await invoke(1, baseRequest(config.clients[1], 'reconcile'));
  const metrics = await invoke<Awaited<ReturnType<typeof remoteMergelessMetrics>>>(1, baseRequest(config.clients[1], 'metrics'));

  for (const attestation of attestations) attestation.max_rss_bytes = rss.get(attestation.participant_id) ?? attestation.max_rss_bytes;
  const acknowledgedIds = operations.filter((entry) => entry.status !== 'queued').map((entry) => entry.operation_id);
  const expectedDigest = operationLedgerDigest(acknowledgedIds);
  const receipt: ExternalFabricProofReceipt = {
    version: 1,
    expected_source_sha: config.expected_source_sha,
    expected_client_artifact_sha256: config.expected_client_artifact_sha256,
    expected_server_image_digest: config.expected_server_image_digest,
    server_url: config.server_url,
    workspace: config.workspace,
    clients: attestations,
    server_before_restart: serverBeforeRestart,
    server_after_restart: serverAfterRestart,
    visibility_before_restart: visibilityBeforeRestart,
    visibility_after_restart: visibilityAfterRestart,
    visibility_after_cleanup: visibilityAfterCleanup,
    operations,
    queued_operation_id: queued.operation_id,
    replayed_operation_id: replayed.operation_id,
    ledger: {
      expected_operation_count: new Set(acknowledgedIds).size,
      acknowledged_operation_count: metrics.delivery.ack_count,
      permanently_lost_operation_count: Math.max(0, new Set(acknowledgedIds).size - metrics.delivery.ack_count),
      observed_operation_count: metrics.delivery.operation_count,
      expected_operation_ledger_digest: expectedDigest,
      observed_operation_ledger_digest: metrics.delivery.recent_operation_ledger_digest,
      source_identities: metrics.delivery.source_identities,
    },
    server_memory_budget_bytes: config.server_memory_budget_bytes,
    client_rss_budget_bytes: config.client_rss_budget_bytes,
  };
  const validated = validateExternalFabricProofReceipt(receipt);
  if (config.output_path) await fsp.writeFile(config.output_path, `${JSON.stringify(validated, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return validated;
}

async function main(): Promise<void> {
  if (process.argv[2] === '--client') return clientMain();
  const configPath = process.argv[2];
  if (!configPath) throw new Error('usage: fabric-external-proof <config.json>');
  const config = JSON.parse(await fsp.readFile(path.resolve(configPath), 'utf8')) as ExternalFabricProofConfig;
  process.stdout.write(`${JSON.stringify(await runExternalFabricProof(config), null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
