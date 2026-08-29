import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateTelemetryExternalProof,
  type TelemetryExternalProofEvidence,
} from './telemetry-external-proof-contract';

const serverSha = 'a'.repeat(40);
const sdkReleaseProofSha256 = 'b'.repeat(64);
const expected = { serverSha, sdkReleaseProofSha256, artifactSha256: { javascript: 'c'.repeat(64), python: 'd'.repeat(64) } };

function evidence(): TelemetryExternalProofEvidence {
  return {
    schema_version: 1,
    endpoint_url: 'https://telemetry-proof.example.com',
    server_sha: serverSha,
    sdk_release_proof_sha256: sdkReleaseProofSha256,
    clients: [
      {
        runtime: 'javascript',
        artifact_sha256: 'c'.repeat(64),
        isolated_install: true,
        sent_event_ids: ['js-event'],
        acknowledged_count: 1,
      },
      {
        runtime: 'python',
        artifact_sha256: 'd'.repeat(64),
        isolated_install: true,
        sent_event_ids: ['py-event'],
        acknowledged_count: 1,
      },
    ],
    auth: { missing_token_status: 401, invalid_token_status: 401, cross_project_status: 401 },
    delivery: {
      attempted_event_ids: ['js-event', 'py-event'],
      persisted_event_ids: ['js-event', 'py-event'],
      retried_event_ids: ['js-event'],
    },
    backfill: {
      preanalysis_unmatched: 2,
      analysis_id: 'analysis-proof',
      upgraded: 2,
      remaining_unmatched: 0,
    },
    observed: {
      runtime_static_links: [{ id: 'runtime-link', static_id: 'node-handler' }],
      flows: [{ flow_id: 'flow', static_ids: ['entry-route', 'node-handler'], capability_ids: ['capability'] }],
      capability_ids: ['capability'],
      event_provenance: [
        { event_id: 'js-event', runtime_static_link_id: 'runtime-link', static_id: 'node-handler', flow_id: 'flow', capability_id: 'capability' },
        { event_id: 'py-event', runtime_static_link_id: 'runtime-link', static_id: 'node-handler', flow_id: 'flow', capability_id: 'capability' },
      ],
    },
    started_at: '2026-08-27T12:00:00.000Z',
    completed_at: '2026-08-27T12:05:00.000Z',
  };
}

test('accepts only complete external hosted telemetry evidence', () => {
  const receipt = validateTelemetryExternalProof(evidence(), expected);
  assert.match(receipt.evidence_sha256, /^[0-9a-f]{64}$/);
});

test('rejects loopback, duplicate persistence, incomplete backfill, and missing conceptual observations', () => {
  const loopback = evidence();
  loopback.endpoint_url = 'http://127.0.0.1:3000';
  assert.throws(() => validateTelemetryExternalProof(loopback, expected), /public HTTPS/);

  const duplicate = evidence();
  duplicate.delivery.persisted_event_ids.push('js-event');
  assert.throws(() => validateTelemetryExternalProof(duplicate, expected), /exactly once/);

  const incomplete = evidence();
  incomplete.backfill.remaining_unmatched = 1;
  assert.throws(() => validateTelemetryExternalProof(incomplete, expected), /backfill/);

  const missingCapability = evidence();
  missingCapability.observed.capability_ids = [];
  assert.throws(() => validateTelemetryExternalProof(missingCapability, expected), /links, flows, and capabilities/);
});

test('rejects source, artifact, auth, client, acknowledgement, and retry omissions', () => {
  assert.throws(
    () => validateTelemetryExternalProof(evidence(), { ...expected, serverSha: 'e'.repeat(40) }),
    /server SHA/,
  );
  const oneClient = evidence();
  oneClient.clients = oneClient.clients.slice(0, 1);
  assert.throws(() => validateTelemetryExternalProof(oneClient, expected), /JavaScript and Python/);
  const badArtifact = evidence();
  badArtifact.clients[0].artifact_sha256 = 'e'.repeat(64);
  assert.throws(() => validateTelemetryExternalProof(badArtifact, expected), /verified artifact/);
  const badAuth = evidence();
  badAuth.auth.cross_project_status = 200;
  assert.throws(() => validateTelemetryExternalProof(badAuth, expected), /project isolation/);
  const badAck = evidence();
  badAck.clients[1].acknowledged_count = 0;
  assert.throws(() => validateTelemetryExternalProof(badAck, expected), /acknowledgement/);
  const noRetry = evidence();
  noRetry.delivery.retried_event_ids = [];
  assert.throws(() => validateTelemetryExternalProof(noRetry, expected), /stable-id retry/);
});


test('rejects fabricated, missing, or non-causal per-event observed provenance', () => {
  const fabricatedFlow = evidence();
  fabricatedFlow.observed.event_provenance[0].flow_id = 'flow-fabricated';
  assert.throws(() => validateTelemetryExternalProof(fabricatedFlow, expected), /causal runtime-link/);

  const wrongNode = evidence();
  wrongNode.observed.event_provenance[0].static_id = 'node-unrelated';
  assert.throws(() => validateTelemetryExternalProof(wrongNode, expected), /causal runtime-link/);

  const missingEvent = evidence();
  missingEvent.observed.event_provenance = missingEvent.observed.event_provenance.slice(0, 1);
  assert.throws(() => validateTelemetryExternalProof(missingEvent, expected), /every submitted event/);

  const duplicateEvent = evidence();
  duplicateEvent.observed.event_provenance[1] = { ...duplicateEvent.observed.event_provenance[0] };
  assert.throws(() => validateTelemetryExternalProof(duplicateEvent, expected), /duplicated or outside/);
});
