import { createHash } from 'node:crypto';

import type { ConceptualCoordinate } from '../coordination/types';

export interface ExternalFabricMachineAttestation {
  participant_id: string;
  machine_id_sha256: string;
  boot_id_sha256: string;
  hostname_sha256: string;
  physical_host_id_sha256: string;
  server_addresses: string[];
  source_sha: string;
  source_clean: boolean;
  analysis_source_sha: string;
  client_artifact_sha256: string;
  cas_evidence_sha256: string;
  concept: ConceptualCoordinate;
  max_rss_bytes: number;
}

export interface ExternalFabricServerAttestation {
  health_source_sha: string;
  health_dirty: boolean;
  image_digest: string;
  container_id: string;
  started_at: string;
  memory_limit_bytes: number;
  memory_peak_bytes: number;
  memory_events: Record<string, number>;
}

export interface ExternalFabricOperationReceipt {
  kind: 'claim' | 'extend' | 'in-flight' | 'release';
  participant_id: string;
  operation_id: string;
  status: 'acknowledged' | 'queued' | 'replayed';
}

export interface ExternalFabricVisibilityReceipt {
  epoch: string;
  max_seq: number;
  active_participants: string[];
  in_flight_participants: string[];
  conceptual_overlap_observed: boolean;
  state_sha256: string;
}

export interface ExternalFabricLedgerReceipt {
  expected_operation_count: number;
  observed_operation_count: number;
  acknowledged_operation_count: number;
  permanently_lost_operation_count: number;
  expected_operation_ledger_digest: string;
  observed_operation_ledger_digest: string;
  source_identities: string[];
}

export interface ExternalFabricProofReceipt {
  version: 1;
  expected_source_sha: string;
  expected_client_artifact_sha256: string;
  expected_server_image_digest: string;
  server_url: string;
  workspace: string;
  clients: [ExternalFabricMachineAttestation, ExternalFabricMachineAttestation];
  server_before_restart: ExternalFabricServerAttestation;
  server_after_restart: ExternalFabricServerAttestation;
  visibility_before_restart: ExternalFabricVisibilityReceipt;
  visibility_after_restart: ExternalFabricVisibilityReceipt;
  visibility_after_cleanup: ExternalFabricVisibilityReceipt;
  operations: ExternalFabricOperationReceipt[];
  queued_operation_id: string;
  replayed_operation_id: string;
  ledger: ExternalFabricLedgerReceipt;
  server_memory_budget_bytes: number;
  client_rss_budget_bytes: number;
  receipt_sha256?: string;
}

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;

function fail(message: string): never {
  throw new Error(`External Fabric proof invalid: ${message}`);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function externalFabricReceiptDigest(receipt: ExternalFabricProofReceipt): string {
  const { receipt_sha256: _digest, ...unsigned } = receipt;
  return createHash('sha256').update(canonical(unsigned)).digest('hex');
}

export function operationLedgerDigest(operationIds: string[]): string {
  return createHash('sha256').update([...new Set(operationIds)].sort().join('\n')).digest('hex');
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '::1' || normalized === '0.0.0.0' || normalized.startsWith('127.');
}

function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized === '::1' || normalized === '0.0.0.0' || normalized.startsWith('127.') || normalized.startsWith('::ffff:127.');
}

function conceptsOverlap(left: ConceptualCoordinate, right: ConceptualCoordinate): boolean {
  if (left.flow_id && left.flow_id === right.flow_id && left.step_id && left.step_id === right.step_id) return true;
  const rightEntities = new Set(right.entities ?? []);
  return (left.entities ?? []).some((entity) => rightEntities.has(entity));
}

function validateMachine(
  machine: ExternalFabricMachineAttestation,
  expectedSourceSha: string,
  expectedArtifactSha: string,
  clientRssBudgetBytes: number,
): void {
  if (!machine.participant_id.trim()) fail('client participant id is blank');
  for (const [label, value] of [
    ['machine identity', machine.machine_id_sha256],
    ['boot identity', machine.boot_id_sha256],
    ['hostname identity', machine.hostname_sha256],
    ['physical host identity', machine.physical_host_id_sha256],
    ['client artifact', machine.client_artifact_sha256],
    ['CAS evidence', machine.cas_evidence_sha256],
  ] as const) {
    if (!SHA256.test(value)) fail(`${label} is not a SHA-256 digest`);
  }
  if (!machine.source_clean || machine.source_sha !== expectedSourceSha) fail(`${machine.participant_id} is not the expected clean source`);
  if (machine.analysis_source_sha !== expectedSourceSha) fail(`${machine.participant_id} CAS was not generated from the expected source`);
  if (machine.client_artifact_sha256 !== expectedArtifactSha) fail(`${machine.participant_id} artifact digest does not match`);
  if (!machine.server_addresses.length || machine.server_addresses.some(isLoopbackAddress)) {
    fail(`${machine.participant_id} resolved the Fabric service to a loopback address`);
  }
  if (machine.concept.source !== 'derived') fail(`${machine.participant_id} concept was not CAS-derived`);
  if (!machine.concept.flow_id || !machine.concept.step_id) fail(`${machine.participant_id} concept lacks a flow and step`);
  if (!Number.isSafeInteger(machine.max_rss_bytes) || machine.max_rss_bytes <= 0 || machine.max_rss_bytes > clientRssBudgetBytes) {
    fail(`${machine.participant_id} exceeded the client RSS budget`);
  }
}

function validateServer(
  server: ExternalFabricServerAttestation,
  expectedSourceSha: string,
  expectedImageDigest: string,
  memoryBudgetBytes: number,
): void {
  if (server.health_source_sha !== expectedSourceSha || server.health_dirty) fail('server health is not the expected clean source');
  if (server.image_digest !== expectedImageDigest) fail('server image digest does not match');
  if (!server.container_id || !server.started_at) fail('server container identity is incomplete');
  if (!Number.isSafeInteger(server.memory_limit_bytes) || server.memory_limit_bytes <= 0 || server.memory_limit_bytes > memoryBudgetBytes) {
    fail('server does not have the required cgroup memory limit');
  }
  if (!Number.isSafeInteger(server.memory_peak_bytes) || server.memory_peak_bytes <= 0 || server.memory_peak_bytes > server.memory_limit_bytes) {
    fail('server memory peak exceeded its cgroup limit');
  }
  if (!Number.isSafeInteger(server.memory_events.oom) || !Number.isSafeInteger(server.memory_events.oom_kill)) fail('server cgroup OOM counters are missing');
  if (server.memory_events.oom !== 0 || server.memory_events.oom_kill !== 0) fail('server cgroup recorded an OOM');
}

function validateVisibility(receipt: ExternalFabricProofReceipt): void {
  const participants = new Set(receipt.clients.map((client) => client.participant_id));
  if (participants.size !== 2) fail('participant identities are not distinct');
  for (const visibility of [receipt.visibility_before_restart, receipt.visibility_after_restart]) {
    if (!SHA256.test(visibility.state_sha256)) fail('visible Fabric state digest is invalid');
    if (!visibility.epoch || visibility.max_seq < 1) fail('visible board identity is incomplete');
    if (!visibility.conceptual_overlap_observed) fail('conceptual overlap was not observed');
    if (![...participants].every((participant) => visibility.active_participants.includes(participant))) fail('both claims were not visible');
    if (![...participants].every((participant) => visibility.in_flight_participants.includes(participant))) fail('both in-flight streams were not visible');
  }
  if (receipt.visibility_before_restart.epoch !== receipt.visibility_after_restart.epoch) fail('board epoch changed across restart');
  if (receipt.visibility_before_restart.state_sha256 !== receipt.visibility_after_restart.state_sha256) fail('claim or in-flight state changed across restart');
  if (receipt.visibility_after_restart.max_seq <= receipt.visibility_before_restart.max_seq) fail('board sequence did not advance through queued replay');
  if (!SHA256.test(receipt.visibility_after_cleanup.state_sha256)) fail('cleanup state digest is invalid');
  if (receipt.visibility_after_cleanup.active_participants.length || receipt.visibility_after_cleanup.in_flight_participants.length) {
    fail('proof state was not cleaned up');
  }
  if (receipt.visibility_after_cleanup.epoch !== receipt.visibility_after_restart.epoch
    || receipt.visibility_after_cleanup.max_seq <= receipt.visibility_after_restart.max_seq) {
    fail('cleanup was not observed on the persisted board');
  }
}

function validateOperations(receipt: ExternalFabricProofReceipt): void {
  const requiredKinds = new Set<ExternalFabricOperationReceipt['kind']>(['claim', 'extend', 'in-flight', 'release']);
  for (const operation of receipt.operations) requiredKinds.delete(operation.kind);
  if (requiredKinds.size) fail(`missing operation kinds: ${[...requiredKinds].join(', ')}`);
  if (!receipt.queued_operation_id || receipt.queued_operation_id !== receipt.replayed_operation_id) fail('queued operation identity was not preserved on replay');
  const queued = receipt.operations.filter((operation) => operation.operation_id === receipt.queued_operation_id);
  if (!queued.some((operation) => operation.status === 'queued') || !queued.some((operation) => operation.status === 'replayed')) {
    fail('queued operation does not have both fault and replay evidence');
  }
  for (const client of receipt.clients) {
    const clientKinds = new Set(receipt.operations
      .filter((operation) => operation.participant_id === client.participant_id)
      .map((operation) => operation.kind));
    for (const required of ['claim', 'in-flight', 'release'] as const) {
      if (!clientKinds.has(required)) fail(`${client.participant_id} lacks ${required} operation evidence`);
    }
  }
  const acknowledgedIds = receipt.operations
    .filter((operation) => operation.status !== 'queued')
    .map((operation) => operation.operation_id);
  const expectedDigest = operationLedgerDigest(acknowledgedIds);
  if (receipt.ledger.expected_operation_count !== new Set(acknowledgedIds).size) fail('expected operation count is not unique acknowledged operations');
  if (receipt.ledger.observed_operation_count !== receipt.ledger.expected_operation_count) fail('server operation count differs from the expected ledger');
  if (receipt.ledger.acknowledged_operation_count !== receipt.ledger.expected_operation_count) fail('not every expected operation was acknowledged');
  if (receipt.ledger.permanently_lost_operation_count !== 0) fail('operation loss is nonzero');
  if (receipt.ledger.expected_operation_ledger_digest !== expectedDigest) fail('expected ledger digest is not derived from operation identities');
  if (receipt.ledger.observed_operation_ledger_digest !== expectedDigest) fail('server ledger digest does not match expected operations');
  if (receipt.ledger.source_identities.length !== 1 || receipt.ledger.source_identities[0] !== receipt.expected_source_sha) {
    fail('server ledger is not bound to the expected source identity');
  }
}

export function validateExternalFabricProofReceipt(receipt: ExternalFabricProofReceipt): ExternalFabricProofReceipt {
  if (receipt.version !== 1) fail('unsupported receipt version');
  if (!GIT_SHA.test(receipt.expected_source_sha)) fail('expected source must be an exact 40-character commit SHA');
  if (!SHA256.test(receipt.expected_client_artifact_sha256)) fail('expected client artifact digest is invalid');
  if (!/^sha256:[0-9a-f]{64}$/.test(receipt.expected_server_image_digest)) fail('expected server image digest is invalid');
  let parsed: URL;
  try {
    parsed = new URL(receipt.server_url);
  } catch {
    fail('server URL is invalid');
  }
  if (parsed.protocol !== 'https:' || isLoopbackHostname(parsed.hostname)) fail('server URL must be non-loopback HTTPS');
  if (!receipt.workspace.trim()) fail('workspace is blank');
  if (!Number.isSafeInteger(receipt.server_memory_budget_bytes) || receipt.server_memory_budget_bytes <= 0) fail('server memory budget is invalid');
  if (!Number.isSafeInteger(receipt.client_rss_budget_bytes) || receipt.client_rss_budget_bytes <= 0) fail('client RSS budget is invalid');
  for (const machine of receipt.clients) {
    validateMachine(machine, receipt.expected_source_sha, receipt.expected_client_artifact_sha256, receipt.client_rss_budget_bytes);
  }
  if (receipt.clients[0].machine_id_sha256 === receipt.clients[1].machine_id_sha256) fail('clients ran on the same machine');
  if (receipt.clients[0].physical_host_id_sha256 === receipt.clients[1].physical_host_id_sha256) fail('clients ran on the same physical host');
  if (receipt.clients[0].hostname_sha256 === receipt.clients[1].hostname_sha256) fail('client host identities are duplicated');
  if (receipt.clients[0].cas_evidence_sha256 !== receipt.clients[1].cas_evidence_sha256) fail('clients did not derive the same canonical CAS evidence');
  if (!conceptsOverlap(receipt.clients[0].concept, receipt.clients[1].concept)) fail('client claims do not overlap conceptually');
  validateServer(receipt.server_before_restart, receipt.expected_source_sha, receipt.expected_server_image_digest, receipt.server_memory_budget_bytes);
  validateServer(receipt.server_after_restart, receipt.expected_source_sha, receipt.expected_server_image_digest, receipt.server_memory_budget_bytes);
  if (receipt.server_before_restart.container_id !== receipt.server_after_restart.container_id) fail('restart changed the selected server container');
  if (receipt.server_before_restart.started_at === receipt.server_after_restart.started_at) fail('server was not actually restarted');
  validateVisibility(receipt);
  validateOperations(receipt);
  const digest = externalFabricReceiptDigest(receipt);
  if (receipt.receipt_sha256 && receipt.receipt_sha256 !== digest) fail('receipt digest does not match');
  return { ...receipt, receipt_sha256: digest };
}
