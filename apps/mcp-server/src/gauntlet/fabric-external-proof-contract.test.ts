import test from 'node:test';
import assert from 'node:assert/strict';

import {
  operationLedgerDigest,
  validateExternalFabricProofReceipt,
  type ExternalFabricProofReceipt,
} from './fabric-external-proof-contract';

const SOURCE = 'a'.repeat(40);
const ARTIFACT = 'b'.repeat(64);
const IMAGE = `sha256:${'c'.repeat(64)}`;

function receipt(): ExternalFabricProofReceipt {
  const operationIds = ['op-claim-a', 'op-claim-b', 'op-extend-a', 'op-queued', 'op-flight-a', 'op-flight-b', 'op-clear-a', 'op-clear-b', 'op-release-a', 'op-release-b'];
  const digest = operationLedgerDigest(operationIds);
  const server = (startedAt: string) => ({
    health_source_sha: SOURCE,
    health_dirty: false,
    image_digest: IMAGE,
    container_id: 'container-proof',
    started_at: startedAt,
    memory_limit_bytes: 1_610_612_736,
    memory_peak_bytes: 402_653_184,
    memory_events: { low: 0, high: 0, max: 0, oom: 0, oom_kill: 0 },
  });
  const visible = {
    epoch: 'epoch-proof',
    max_seq: 4,
    active_participants: ['participant-a', 'participant-b'],
    in_flight_participants: ['participant-a', 'participant-b'],
    conceptual_overlap_observed: true,
    state_sha256: 'f'.repeat(64),
  };
  return {
    version: 1,
    expected_source_sha: SOURCE,
    expected_client_artifact_sha256: ARTIFACT,
    expected_server_image_digest: IMAGE,
    server_url: 'https://fabric.proof.example',
    workspace: 'fabric-external-proof-contract',
    clients: [
      {
        participant_id: 'participant-a', machine_id_sha256: '1'.repeat(64), boot_id_sha256: '2'.repeat(64), hostname_sha256: '3'.repeat(64), physical_host_id_sha256: '9'.repeat(64), server_addresses: ['203.0.113.10'],
        source_sha: SOURCE, source_clean: true, analysis_source_sha: SOURCE, client_artifact_sha256: ARTIFACT, cas_evidence_sha256: '4'.repeat(64),
        concept: { flow_id: 'flow-real', step_id: 'step-real', entities: ['Order'], source: 'derived' }, max_rss_bytes: 120_000_000,
      },
      {
        participant_id: 'participant-b', machine_id_sha256: '5'.repeat(64), boot_id_sha256: '6'.repeat(64), hostname_sha256: '7'.repeat(64), physical_host_id_sha256: 'a'.repeat(64), server_addresses: ['203.0.113.10'],
        source_sha: SOURCE, source_clean: true, analysis_source_sha: SOURCE, client_artifact_sha256: ARTIFACT, cas_evidence_sha256: '4'.repeat(64),
        concept: { flow_id: 'flow-real', step_id: 'step-real', entities: ['Order'], source: 'derived' }, max_rss_bytes: 130_000_000,
      },
    ],
    server_before_restart: server('2026-08-27T00:00:00.000Z'),
    server_after_restart: server('2026-08-27T00:01:00.000Z'),
    visibility_before_restart: visible,
    visibility_after_restart: { ...visible, max_seq: 5 },
    visibility_after_cleanup: { epoch: 'epoch-proof', max_seq: 7, active_participants: [], in_flight_participants: [], conceptual_overlap_observed: false, state_sha256: 'e'.repeat(64) },
    operations: [
      { kind: 'claim', participant_id: 'participant-a', operation_id: 'op-claim-a', status: 'acknowledged' },
      { kind: 'claim', participant_id: 'participant-b', operation_id: 'op-claim-b', status: 'acknowledged' },
      { kind: 'extend', participant_id: 'participant-a', operation_id: 'op-extend-a', status: 'acknowledged' },
      { kind: 'in-flight', participant_id: 'participant-a', operation_id: 'op-flight-a', status: 'acknowledged' },
      { kind: 'in-flight', participant_id: 'participant-b', operation_id: 'op-flight-b', status: 'acknowledged' },
      { kind: 'extend', participant_id: 'participant-a', operation_id: 'op-queued', status: 'queued' },
      { kind: 'extend', participant_id: 'participant-a', operation_id: 'op-queued', status: 'replayed' },
      { kind: 'in-flight', participant_id: 'participant-a', operation_id: 'op-clear-a', status: 'acknowledged' },
      { kind: 'release', participant_id: 'participant-a', operation_id: 'op-release-a', status: 'acknowledged' },
      { kind: 'in-flight', participant_id: 'participant-b', operation_id: 'op-clear-b', status: 'acknowledged' },
      { kind: 'release', participant_id: 'participant-b', operation_id: 'op-release-b', status: 'acknowledged' },
    ],
    queued_operation_id: 'op-queued',
    replayed_operation_id: 'op-queued',
    ledger: {
      expected_operation_count: operationIds.length,
      observed_operation_count: operationIds.length,
      acknowledged_operation_count: operationIds.length,
      permanently_lost_operation_count: 0,
      expected_operation_ledger_digest: digest,
      observed_operation_ledger_digest: digest,
      source_identities: [SOURCE],
    },
    server_memory_budget_bytes: 1_610_612_736,
    client_rss_budget_bytes: 268_435_456,
  };
}

test('accepts a complete external two-host proof and seals its receipt', () => {
  const result = validateExternalFabricProofReceipt(receipt());
  assert.match(result.receipt_sha256 ?? '', /^[0-9a-f]{64}$/);
});

test('rejects loopback and duplicate machine evidence', () => {
  const loopback = receipt();
  loopback.server_url = 'https://127.0.0.1:8788';
  assert.throws(() => validateExternalFabricProofReceipt(loopback), /non-loopback HTTPS/);
  const duplicate = receipt();
  duplicate.clients[1].machine_id_sha256 = duplicate.clients[0].machine_id_sha256;
  assert.throws(() => validateExternalFabricProofReceipt(duplicate), /same machine/);
  const colocated = receipt();
  const loopbackResolution = receipt();
  loopbackResolution.clients[0].server_addresses = ['127.0.0.1'];
  assert.throws(() => validateExternalFabricProofReceipt(loopbackResolution), /resolved.*loopback/);
  colocated.clients[1].physical_host_id_sha256 = colocated.clients[0].physical_host_id_sha256;
  assert.throws(() => validateExternalFabricProofReceipt(colocated), /same physical host/);
});

test('rejects dirty or mismatched source and artifact identities', () => {
  const dirty = receipt();
  dirty.clients[0].source_clean = false;
  assert.throws(() => validateExternalFabricProofReceipt(dirty), /expected clean source/);
  const artifact = receipt();
  artifact.clients[1].client_artifact_sha256 = 'd'.repeat(64);
  assert.throws(() => validateExternalFabricProofReceipt(artifact), /artifact digest/);
  const staleCas = receipt();
  staleCas.clients[0].analysis_source_sha = 'e'.repeat(40);
  assert.throws(() => validateExternalFabricProofReceipt(staleCas), /CAS was not generated from the expected source/);
  const server = receipt();
  server.server_after_restart.health_source_sha = 'e'.repeat(40);
  assert.throws(() => validateExternalFabricProofReceipt(server), /server health/);
});

test('rejects declared, disjoint, or incomplete concept evidence', () => {
  const declared = receipt();
  declared.clients[0].concept.source = 'declared';
  assert.throws(() => validateExternalFabricProofReceipt(declared), /not CAS-derived/);
  const disjoint = receipt();
  disjoint.clients[1].concept = { flow_id: 'other-flow', step_id: 'other-step', entities: ['Invoice'], source: 'derived' };
  assert.throws(() => validateExternalFabricProofReceipt(disjoint), /do not overlap conceptually/);
  const differentCas = receipt();
  differentCas.clients[1].cas_evidence_sha256 = 'd'.repeat(64);
  assert.throws(() => validateExternalFabricProofReceipt(differentCas), /same canonical CAS evidence/);
});

test('rejects fake restart, missing persisted state, and incomplete cleanup', () => {
  const noRestart = receipt();
  noRestart.server_after_restart.started_at = noRestart.server_before_restart.started_at;
  assert.throws(() => validateExternalFabricProofReceipt(noRestart), /not actually restarted/);
  const lost = receipt();
  lost.visibility_after_restart.active_participants = ['participant-a'];
  assert.throws(() => validateExternalFabricProofReceipt(lost), /both claims were not visible/);
  const changed = receipt();
  changed.visibility_after_restart.state_sha256 = '0'.repeat(64);
  assert.throws(() => validateExternalFabricProofReceipt(changed), /state changed across restart/);
  const residue = receipt();
  residue.visibility_after_cleanup.in_flight_participants = ['participant-b'];
  assert.throws(() => validateExternalFabricProofReceipt(residue), /not cleaned up/);
  const foreignCleanup = receipt();
  foreignCleanup.visibility_after_cleanup.epoch = 'other-board';
  assert.throws(() => validateExternalFabricProofReceipt(foreignCleanup), /persisted board/);
});

test('rejects changed replay identity, ledger loss, OOM, and RSS over budget', () => {
  const replay = receipt();
  replay.replayed_operation_id = 'different-operation';
  assert.throws(() => validateExternalFabricProofReceipt(replay), /identity was not preserved/);
  const ledger = receipt();
  ledger.ledger.permanently_lost_operation_count = 1;
  assert.throws(() => validateExternalFabricProofReceipt(ledger), /loss is nonzero/);
  const staleSequence = receipt();
  staleSequence.visibility_after_restart.max_seq = staleSequence.visibility_before_restart.max_seq;
  assert.throws(() => validateExternalFabricProofReceipt(staleSequence), /sequence did not advance/);
  const incompleteLedger = receipt();
  incompleteLedger.ledger.observed_operation_count -= 1;
  assert.throws(() => validateExternalFabricProofReceipt(incompleteLedger), /operation count differs/);
  const wrongSource = receipt();
  wrongSource.ledger.source_identities = ['other'];
  assert.throws(() => validateExternalFabricProofReceipt(wrongSource), /expected source identity/);
  const tampered = validateExternalFabricProofReceipt(receipt());
  tampered.workspace = 'tampered';
  assert.throws(() => validateExternalFabricProofReceipt(tampered), /receipt digest/);
  const oom = receipt();
  oom.server_after_restart.memory_events.oom_kill = 1;
  assert.throws(() => validateExternalFabricProofReceipt(oom), /recorded an OOM/);
  const missingOomCounters = receipt();
  missingOomCounters.server_after_restart.memory_events = {};
  assert.throws(() => validateExternalFabricProofReceipt(missingOomCounters), /counters are missing/);
  const rss = receipt();
  rss.clients[1].max_rss_bytes = rss.client_rss_budget_bytes + 1;
  assert.throws(() => validateExternalFabricProofReceipt(rss), /RSS budget/);
});
