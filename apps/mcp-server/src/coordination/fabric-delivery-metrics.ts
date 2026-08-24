import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { getStoreDir, withWorkspaceLock } from './local-store';

export interface FabricDeliveryStage {
  workspace: string;
  operation_id: string;
  operation_kind: string;
  source_identity?: string;
  participant_id?: string;
  captured_at?: string;
  client_persisted_at?: string;
  acknowledged_at?: string;
  visible_at?: string;
  reconciled_at?: string;
  delivery_attempt?: number;
}

export interface FabricDeliveryMetadata {
  operation_id?: string;
  client_persisted_at?: string;
  source_identity?: string;
  delivery_attempt?: number;
  captured_at?: string;
}

interface DeliveryRecord extends Omit<FabricDeliveryStage, 'workspace'> {
  first_seen_at: string;
  last_seen_at: string;
}

interface LatencyTotals {
  count: number;
  total_ms: number;
  max_ms: number;
}

interface DeliveryTotals {
  operation_count: number;
  ack_count: number;
  visible_count: number;
  reconciled_count: number;
  retry_count: number;
  transport_loss_count: number;
  recovered_operation_count: number;
  capture_to_persist: LatencyTotals;
  persist_to_visible: LatencyTotals;
  visible_to_reconciled: LatencyTotals;
  capture_to_reconciled: LatencyTotals;
}

interface DeliveryState {
  version: 1;
  archived: DeliveryTotals;
  operations: Record<string, DeliveryRecord>;
  ledger_floor_at?: string;
  source_identities: string[];
}

export interface FabricLatencyMetric {
  count: number;
  average_ms: number | null;
  max_ms: number | null;
}

export interface FabricDeliveryMetrics {
  operation_count: number;
  ack_count: number;
  visible_count: number;
  reconciled_count: number;
  unreconciled_count: number;
  retry_count: number;
  transport_loss_count: number;
  recovered_operation_count: number;
  permanent_loss_count: null;
  loss_definition: string;
  recent_operation_ledger_count: number;
  recent_operation_ledger_limit: number;
  recent_operation_ledger_floor_at?: string;
  recent_operation_ledger_digest: string;
  source_identities: string[];
  capture_to_persist: FabricLatencyMetric;
  persist_to_visible: FabricLatencyMetric;
  visible_to_reconciled: FabricLatencyMetric;
  capture_to_reconciled: FabricLatencyMetric;
}

const RECENT_OPERATION_LIMIT = 20_000;

function zeroLatency(): LatencyTotals {
  return { count: 0, total_ms: 0, max_ms: 0 };
}

function zeroTotals(): DeliveryTotals {
  return {
    operation_count: 0,
    ack_count: 0,
    visible_count: 0,
    reconciled_count: 0,
    retry_count: 0,
    transport_loss_count: 0,
    recovered_operation_count: 0,
    capture_to_persist: zeroLatency(),
    persist_to_visible: zeroLatency(),
    visible_to_reconciled: zeroLatency(),
    capture_to_reconciled: zeroLatency(),
  };
}

function statePath(workspace: string): string {
  return path.join(getStoreDir(workspace), 'fabric-delivery-metrics.json');
}

function millisecondsBetween(start?: string, end?: string): number | undefined {
  if (!start || !end) return undefined;
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function latencyContribution(value?: number): LatencyTotals {
  return value === undefined ? zeroLatency() : { count: 1, total_ms: value, max_ms: value };
}

function recordContribution(record: DeliveryRecord): DeliveryTotals {
  const attempts = Math.max(1, Math.floor(record.delivery_attempt ?? 1));
  const retries = Math.max(0, attempts - 1);
  return {
    operation_count: 1,
    ack_count: record.acknowledged_at ? 1 : 0,
    visible_count: record.visible_at ? 1 : 0,
    reconciled_count: record.reconciled_at ? 1 : 0,
    retry_count: retries,
    transport_loss_count: retries,
    recovered_operation_count: record.acknowledged_at && retries > 0 ? 1 : 0,
    capture_to_persist: latencyContribution(millisecondsBetween(record.captured_at, record.client_persisted_at)),
    persist_to_visible: latencyContribution(millisecondsBetween(record.client_persisted_at, record.visible_at)),
    visible_to_reconciled: latencyContribution(millisecondsBetween(record.visible_at, record.reconciled_at)),
    capture_to_reconciled: latencyContribution(millisecondsBetween(record.captured_at, record.reconciled_at)),
  };
}

function addLatency(left: LatencyTotals, right: LatencyTotals): LatencyTotals {
  return {
    count: left.count + right.count,
    total_ms: left.total_ms + right.total_ms,
    max_ms: Math.max(left.max_ms, right.max_ms),
  };
}

function addTotals(left: DeliveryTotals, right: DeliveryTotals): DeliveryTotals {
  return {
    operation_count: left.operation_count + right.operation_count,
    ack_count: left.ack_count + right.ack_count,
    visible_count: left.visible_count + right.visible_count,
    reconciled_count: left.reconciled_count + right.reconciled_count,
    retry_count: left.retry_count + right.retry_count,
    transport_loss_count: left.transport_loss_count + right.transport_loss_count,
    recovered_operation_count: left.recovered_operation_count + right.recovered_operation_count,
    capture_to_persist: addLatency(left.capture_to_persist, right.capture_to_persist),
    persist_to_visible: addLatency(left.persist_to_visible, right.persist_to_visible),
    visible_to_reconciled: addLatency(left.visible_to_reconciled, right.visible_to_reconciled),
    capture_to_reconciled: addLatency(left.capture_to_reconciled, right.capture_to_reconciled),
  };
}

async function readState(workspace: string): Promise<DeliveryState> {
  try {
    const parsed = JSON.parse(await fsp.readFile(statePath(workspace), 'utf8')) as DeliveryState;
    if (parsed.version === 1 && parsed.archived && parsed.operations) {
      return { ...parsed, source_identities: parsed.source_identities ?? [] };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { version: 1, archived: zeroTotals(), operations: {}, source_identities: [] };
}

async function writeState(workspace: string, state: DeliveryState): Promise<void> {
  const target = statePath(workspace);
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  const handle = await fsp.open(temporary, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(temporary, target);
  const directory = await fsp.open(path.dirname(target), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function mergeRecord(current: DeliveryRecord | undefined, stage: FabricDeliveryStage): DeliveryRecord {
  const now = new Date().toISOString();
  return {
    operation_id: stage.operation_id,
    operation_kind: stage.operation_kind || current?.operation_kind || 'unknown',
    source_identity: stage.source_identity ?? current?.source_identity,
    participant_id: stage.participant_id ?? current?.participant_id,
    captured_at: stage.captured_at ?? current?.captured_at,
    client_persisted_at: stage.client_persisted_at ?? current?.client_persisted_at,
    acknowledged_at: stage.acknowledged_at ?? current?.acknowledged_at,
    visible_at: stage.visible_at ?? current?.visible_at,
    reconciled_at: stage.reconciled_at ?? current?.reconciled_at,
    delivery_attempt: Math.max(stage.delivery_attempt ?? 0, current?.delivery_attempt ?? 0) || undefined,
    first_seen_at: current?.first_seen_at ?? now,
    last_seen_at: now,
  };
}

export async function recordFabricDeliveryStage(stage: FabricDeliveryStage): Promise<void> {
  if (!stage.operation_id) return;
  await withWorkspaceLock(stage.workspace, async () => {
    const state = await readState(stage.workspace);
    state.operations[stage.operation_id] = mergeRecord(state.operations[stage.operation_id], stage);
    if (stage.source_identity) {
      state.source_identities = [...new Set([...state.source_identities, stage.source_identity])].sort().slice(-100);
    }
    const entries = Object.values(state.operations).sort((a, b) => a.last_seen_at.localeCompare(b.last_seen_at));
    const overflow = entries.slice(0, Math.max(0, entries.length - RECENT_OPERATION_LIMIT));
    for (const record of overflow) {
      state.archived = addTotals(state.archived, recordContribution(record));
      delete state.operations[record.operation_id];
      state.ledger_floor_at = record.last_seen_at;
    }
    await writeState(stage.workspace, state);
  });
}

export async function recordVisibleFabricOperation(
  workspace: string,
  operationKind: string,
  participantId: string | undefined,
  body: FabricDeliveryMetadata,
  acknowledgedAt = new Date().toISOString(),
): Promise<string> {
  const visibleAt = new Date().toISOString();
  if (body.operation_id) {
    await recordFabricDeliveryStage({
      workspace,
      operation_id: body.operation_id,
      operation_kind: operationKind,
      participant_id: participantId,
      captured_at: body.captured_at,
      client_persisted_at: body.client_persisted_at,
      acknowledged_at: acknowledgedAt,
      visible_at: visibleAt,
      delivery_attempt: body.delivery_attempt,
      source_identity: body.source_identity,
    });
  }
  return visibleAt;
}

function publicLatency(value: LatencyTotals): FabricLatencyMetric {
  return {
    count: value.count,
    average_ms: value.count > 0 ? value.total_ms / value.count : null,
    max_ms: value.count > 0 ? value.max_ms : null,
  };
}

export async function getFabricDeliveryMetrics(workspace: string): Promise<FabricDeliveryMetrics> {
  const state = await readState(workspace);
  const records = Object.values(state.operations);
  const totals = records.reduce((result, record) => addTotals(result, recordContribution(record)), state.archived);
  return {
    operation_count: totals.operation_count,
    ack_count: totals.ack_count,
    visible_count: totals.visible_count,
    reconciled_count: totals.reconciled_count,
    unreconciled_count: Math.max(0, totals.ack_count - totals.reconciled_count),
    retry_count: totals.retry_count,
    transport_loss_count: totals.transport_loss_count,
    recovered_operation_count: totals.recovered_operation_count,
    permanent_loss_count: null,
    loss_definition: 'transport_loss_count records failed delivery attempts preceding acknowledgement; permanent loss requires an expected-operation ledger',
    recent_operation_ledger_count: records.length,
    recent_operation_ledger_limit: RECENT_OPERATION_LIMIT,
    recent_operation_ledger_floor_at: state.ledger_floor_at,
    recent_operation_ledger_digest: createHash('sha256').update(records.map((record) => record.operation_id).sort().join('\n')).digest('hex'),
    source_identities: state.source_identities,
    capture_to_persist: publicLatency(totals.capture_to_persist),
    persist_to_visible: publicLatency(totals.persist_to_visible),
    visible_to_reconciled: publicLatency(totals.visible_to_reconciled),
    capture_to_reconciled: publicLatency(totals.capture_to_reconciled),
  };
}
