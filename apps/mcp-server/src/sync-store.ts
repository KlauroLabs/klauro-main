import * as fs from 'fs-extra';
import * as path from 'node:path';

export interface SyncPushChange {
  id: string;
  op: 'put' | 'delete';
  record: unknown;
  lamport: number;
  idempotencyKey: string;
}

export interface SyncPushAccepted {
  id: string;
  serverSeq: number;
}

export interface SyncPushRejected {
  id: string;
  reason: string;
}

export interface SyncPulledChange {
  id: string;
  record: unknown;
  serverSeq: number;
  deletedAt: string | null;
}

interface SyncRecord {
  userId: string;
  entityClass: string;
  id: string;
  record: unknown;
  serverSeq: number;
  deviceId: string;
  idempotencyKey: string;
  deletedAt: string | null;
  updatedAt: string;
}

interface SyncDatabase {
  version: 1;
  nextSeq: number;
  records: SyncRecord[];
}

const MAX_PULL_LIMIT = 500;
const DEFAULT_PULL_LIMIT = 200;

function maxRecordBytes(): number {
  return Number(process.env.KLAURO_SYNC_MAX_RECORD_BYTES) || 256 * 1024;
}

function maxRecordsPerAccountClass(): number {
  return Number(process.env.KLAURO_SYNC_MAX_RECORDS_PER_ACCOUNT_CLASS) || 5_000;
}

export class SyncStore {
  private readonly filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'sync', 'sync.json');
  }

  async pushChanges(userId: string, entityClass: string, deviceId: string, changes: SyncPushChange[]): Promise<{ accepted: SyncPushAccepted[]; rejected: SyncPushRejected[] }> {
    return this.mutate(db => {
      const accepted: SyncPushAccepted[] = [];
      const rejected: SyncPushRejected[] = [];
      for (const change of changes) {
        if (!change.id || (change.op !== 'put' && change.op !== 'delete')) {
          rejected.push({ id: change.id || '', reason: 'invalid change' });
          continue;
        }
        const recordBytes = Buffer.byteLength(JSON.stringify(change.record ?? null), 'utf8');
        const recordLimit = maxRecordBytes();
        if (recordBytes > recordLimit) {
          rejected.push({ id: change.id, reason: `record too large (${recordBytes} bytes, max ${recordLimit})` });
          continue;
        }
        const existing = db.records.find(r => r.userId === userId && r.entityClass === entityClass && r.id === change.id);
        if (existing && existing.idempotencyKey === change.idempotencyKey) {
          accepted.push({ id: change.id, serverSeq: existing.serverSeq });
          continue;
        }
        if (!existing) {
          const classLimit = maxRecordsPerAccountClass();
          const countForClass = db.records.reduce((n, r) => n + (r.userId === userId && r.entityClass === entityClass ? 1 : 0), 0);
          if (countForClass >= classLimit) {
            rejected.push({ id: change.id, reason: `this account has reached the ${classLimit}-record limit for ${entityClass}` });
            continue;
          }
        }
        const serverSeq = ++db.nextSeq;
        const now = new Date().toISOString();
        if (existing) {
          existing.record = change.record;
          existing.serverSeq = serverSeq;
          existing.deviceId = deviceId;
          existing.idempotencyKey = change.idempotencyKey;
          existing.deletedAt = change.op === 'delete' ? now : null;
          existing.updatedAt = now;
        } else {
          db.records.push({
            userId,
            entityClass,
            id: change.id,
            record: change.record,
            serverSeq,
            deviceId,
            idempotencyKey: change.idempotencyKey,
            deletedAt: change.op === 'delete' ? now : null,
            updatedAt: now,
          });
        }
        accepted.push({ id: change.id, serverSeq });
      }
      return { accepted, rejected };
    });
  }

  async pullChanges(userId: string, entityClass: string, since: number, limit?: number): Promise<{ changes: SyncPulledChange[]; nextSince: number }> {
    const db = await this.load();
    const capped = Math.min(Math.max(1, limit || DEFAULT_PULL_LIMIT), MAX_PULL_LIMIT);
    const matching = db.records
      .filter(r => r.userId === userId && r.entityClass === entityClass && r.serverSeq > since)
      .sort((a, b) => a.serverSeq - b.serverSeq)
      .slice(0, capped);
    const changes = matching.map(r => ({ id: r.id, record: r.record, serverSeq: r.serverSeq, deletedAt: r.deletedAt }));
    const nextSince = changes.length ? changes[changes.length - 1].serverSeq : since;
    return { changes, nextSince };
  }

  private async load(): Promise<SyncDatabase> {
    if (!(await fs.pathExists(this.filePath))) {
      return { version: 1, nextSeq: 0, records: [] };
    }
    const db = await fs.readJson(this.filePath) as SyncDatabase;
    return {
      version: 1,
      nextSeq: typeof db.nextSeq === 'number' ? db.nextSeq : 0,
      records: Array.isArray(db.records) ? db.records : [],
    };
  }

  private async mutate<T>(fn: (db: SyncDatabase) => T): Promise<T> {
    const task = this.writeQueue.then(async () => {
      const db = await this.load();
      const result = fn(db);
      await this.writeToDisk(db);
      return result;
    });
    this.writeQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  private async writeToDisk(db: SyncDatabase): Promise<void> {
    await fs.ensureDir(path.dirname(this.filePath));
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeJson(tmpPath, db, { spaces: 2 });
    await fs.rename(tmpPath, this.filePath);
  }
}
