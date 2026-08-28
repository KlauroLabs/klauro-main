import { createHash } from 'node:crypto';

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;

export interface TelemetryExternalProofEvidence {
  schema_version: 1;
  endpoint_url: string;
  server_sha: string;
  sdk_release_proof_sha256: string;
  clients: Array<{
    runtime: 'javascript' | 'python';
    artifact_sha256: string;
    isolated_install: boolean;
    sent_event_ids: string[];
    acknowledged_count: number;
  }>;
  auth: {
    missing_token_status: number;
    invalid_token_status: number;
    cross_project_status: number;
  };
  delivery: {
    attempted_event_ids: string[];
    persisted_event_ids: string[];
    retried_event_ids: string[];
  };
  backfill: {
    preanalysis_unmatched: number;
    analysis_id: string;
    upgraded: number;
    remaining_unmatched: number;
  };
  observed: {
    runtime_static_link_ids: string[];
    flow_ids: string[];
    capability_ids: string[];
  };
  started_at: string;
  completed_at: string;
}

export interface TelemetryExternalProofReceipt extends TelemetryExternalProofEvidence {
  evidence_sha256: string;
}

export function validateTelemetryExternalProof(
  evidence: TelemetryExternalProofEvidence,
  expected: { serverSha: string; sdkReleaseProofSha256: string; artifactSha256: { javascript: string; python: string } },
): TelemetryExternalProofReceipt {
  const endpoint = new URL(evidence.endpoint_url);
  if (endpoint.protocol !== 'https:' || isLoopbackOrPrivate(endpoint.hostname)) {
    throw new Error('External telemetry proof requires a public HTTPS hosted endpoint.');
  }
  if (!GIT_SHA.test(evidence.server_sha) || evidence.server_sha !== expected.serverSha) {
    throw new Error('External telemetry proof server SHA does not match the exact expected source.');
  }
  if (!SHA256.test(evidence.sdk_release_proof_sha256)
    || evidence.sdk_release_proof_sha256 !== expected.sdkReleaseProofSha256) {
    throw new Error('External telemetry proof SDK release receipt digest does not match.');
  }
  if (evidence.clients.length !== 2
    || new Set(evidence.clients.map(client => client.runtime)).size !== 2
    || !evidence.clients.some(client => client.runtime === 'javascript')
    || !evidence.clients.some(client => client.runtime === 'python')) {
    throw new Error('External telemetry proof requires independently installed JavaScript and Python clients.');
  }
  for (const client of evidence.clients) {
    if (!client.isolated_install || !SHA256.test(client.artifact_sha256) || client.artifact_sha256 !== expected.artifactSha256[client.runtime]) {
      throw new Error(`${client.runtime} client is not bound to an isolated verified artifact.`);
    }
    if (client.sent_event_ids.length === 0 || client.acknowledged_count !== client.sent_event_ids.length) {
      throw new Error(`${client.runtime} client acknowledgement count is incomplete.`);
    }
  }
  if (evidence.auth.missing_token_status !== 401 || evidence.auth.invalid_token_status !== 401
    || ![403, 404].includes(evidence.auth.cross_project_status)) {
    throw new Error('External telemetry proof did not fail closed for authentication and project isolation.');
  }
  const attempted = new Set(evidence.delivery.attempted_event_ids);
  const persisted = new Set(evidence.delivery.persisted_event_ids);
  if (attempted.size === 0 || persisted.size !== attempted.size
    || [...attempted].some(id => !persisted.has(id))
    || evidence.delivery.persisted_event_ids.length !== persisted.size) {
    throw new Error('External telemetry proof did not preserve every event exactly once.');
  }
  if (evidence.delivery.retried_event_ids.length === 0
    || evidence.delivery.retried_event_ids.some(id => !attempted.has(id))) {
    throw new Error('External telemetry proof did not exercise stable-id retry.');
  }
  if (evidence.backfill.preanalysis_unmatched < 1 || !evidence.backfill.analysis_id
    || evidence.backfill.upgraded < 1 || evidence.backfill.remaining_unmatched !== 0) {
    throw new Error('External telemetry proof did not complete pre-analysis persistence and canonical backfill.');
  }
  if (evidence.observed.runtime_static_link_ids.length === 0
    || evidence.observed.flow_ids.length === 0
    || evidence.observed.capability_ids.length === 0) {
    throw new Error('External telemetry proof did not expose observed runtime links, flows, and capabilities.');
  }
  const started = Date.parse(evidence.started_at);
  const completed = Date.parse(evidence.completed_at);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) {
    throw new Error('External telemetry proof timestamps are invalid.');
  }
  return {
    ...evidence,
    evidence_sha256: createHash('sha256').update(canonical(evidence)).digest('hex'),
  };
}

function isLoopbackOrPrivate(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1') return true;
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  return octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
