import * as fs from 'fs-extra';
import { open } from 'node:fs/promises';
import * as path from 'node:path';
import type { RuntimeObservation } from './product';
import { syncDirectory } from './filesystem-mutation-lock';
import { randomUUID } from 'node:crypto';

export async function readTelemetryJournal(filePath: string): Promise<RuntimeObservation[]> {
  try {
    if (filePath.endsWith('.jsonl')) {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed: RuntimeObservation[] = [];
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          parsed.push(JSON.parse(trimmed) as RuntimeObservation);
        } catch {
        }
      }
      return parsed.reverse();
    }
    const array = await fs.readJson(filePath);
    return Array.isArray(array) ? array : [];
  } catch {
    return [];
  }
}

export async function appendTelemetryJournal(
  filePath: string,
  observations: RuntimeObservation[],
  rowByteLimit: number,
  assertOwned: () => Promise<void>,
): Promise<void> {
  const lines: string[] = [];
  let batchBytes = 0;
  for (const observation of observations) {
    const line = `${JSON.stringify(observation)}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > rowByteLimit) {
      throw new RangeError(`A telemetry observation exceeds the ${rowByteLimit}-byte daily journal limit`);
    }
    batchBytes += bytes;
    if (batchBytes > rowByteLimit) {
      throw new RangeError(`A telemetry batch exceeds the ${rowByteLimit}-byte daily journal limit`);
    }
    lines.push(line);
  }
  if (lines.length === 0) {
    return;
  }
  let separatesIncompleteRecord = false;
  const existed = await fs.pathExists(filePath);
  try {
    const handle = await open(filePath, 'r');
    try {
      const { size } = await handle.stat();
      if (size > 0) {
        const lastByte = Buffer.allocUnsafe(1);
        await handle.read(lastByte, 0, 1, size - 1);
        separatesIncompleteRecord = lastByte[0] !== 0x0a;
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const handle = await open(filePath, 'a');
  try {
    await assertOwned();
    await handle.writeFile(`${separatesIncompleteRecord ? '\n' : ''}${lines.join('')}`, 'utf8');
    await handle.sync();
    await assertOwned();
  } finally {
    await handle.close();
  }
  if (!existed) await syncDirectory(path.dirname(filePath));
}

export function dedupeTelemetryObservations(observations: RuntimeObservation[]): RuntimeObservation[] {
  const byId = new Map<string, RuntimeObservation>();
  for (const observation of observations) {
    const eventId = observation.event.attributes?.telemetry_event_id;
    const key = typeof eventId === 'string' && eventId ? `event:${eventId}` : `observation:${observation.id}`;
    if (!byId.has(key)) byId.set(key, observation);
  }
  return [...byId.values()].sort((left, right) => right.recorded_at.localeCompare(left.recorded_at));
}

export function compactTelemetryObservations(
  observations: RuntimeObservation[],
  rowLimit: number,
  byteLimit: number,
): RuntimeObservation[] {
  const compacted: RuntimeObservation[] = [];
  let bytes = 0;
  for (const observation of dedupeTelemetryObservations(observations)) {
    if (compacted.length >= rowLimit) break;
    const observationBytes = Buffer.byteLength(`${JSON.stringify(observation)}\n`);
    if (bytes + observationBytes > byteLimit) continue;
    compacted.push(observation);
    bytes += observationBytes;
  }
  return compacted;
}

export async function writeTelemetryJournal(
  filePath: string,
  newestFirst: RuntimeObservation[],
  assertOwned: () => Promise<void>,
): Promise<void> {
  const chronological = [...newestFirst].reverse();
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, 'wx');
  try {
    for (const observation of chronological) await handle.writeFile(`${JSON.stringify(observation)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await assertOwned();
    await fs.rename(temporaryPath, filePath);
    await syncDirectory(path.dirname(filePath));
  } finally {
    await fs.remove(temporaryPath).catch(() => undefined);
  }
}
