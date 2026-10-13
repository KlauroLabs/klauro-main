import * as crypto from 'node:crypto';
import type { PublicAccountUser } from './account-store';

const DEVICE_CODE_TTL_MS = 1000 * 60 * 15;
const POLL_INTERVAL_SEC = 5;
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const REGISTERED_CLIENTS: Record<string, string> = {
  'agent-desktop': 'Agent Desktop',
  'klauro-cli': 'Klauro CLI',
};

export interface DeviceAuthorization {
  status: 'pending' | 'approved' | 'denied';
  clientId: string;
  deviceCode: string;
  userCode: string;
  issuedAt: number;
  expiresAt: number;
  lastPolledAt: number;
  approvedToken?: string;
  approvedUser?: PublicAccountUser;
}

export interface DeviceCodeIssued {
  device_code: string;
  user_code: string;
  expires_in: number;
  interval: number;
}

export type DevicePollOutcome =
  | { kind: 'approved'; token: string; user: PublicAccountUser }
  | { kind: 'pending' }
  | { kind: 'slow_down' }
  | { kind: 'expired' }
  | { kind: 'denied' }
  | { kind: 'not_found' };

export type DeviceCodeOrRejection = { ok: true; issued: DeviceCodeIssued } | { ok: false; error: 'unknown_client' };

function randomUserCode(): string {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += USER_CODE_ALPHABET[bytes[i] % USER_CODE_ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

export class DeviceAuthStore {
  private readonly byDeviceCode = new Map<string, DeviceAuthorization>();
  private readonly byUserCode = new Map<string, string>();

  issue(clientId: string): DeviceCodeOrRejection {
    if (!Object.prototype.hasOwnProperty.call(REGISTERED_CLIENTS, clientId)) {
      return { ok: false, error: 'unknown_client' };
    }
    this.sweep();
    const deviceCode = crypto.randomBytes(32).toString('hex');
    let userCode = randomUserCode();
    while (this.byUserCode.has(userCode)) userCode = randomUserCode();
    const now = Date.now();
    const record: DeviceAuthorization = {
      status: 'pending',
      clientId,
      deviceCode,
      userCode,
      issuedAt: now,
      expiresAt: now + DEVICE_CODE_TTL_MS,
      lastPolledAt: 0,
    };
    this.byDeviceCode.set(deviceCode, record);
    this.byUserCode.set(userCode, deviceCode);
    return { ok: true, issued: { device_code: deviceCode, user_code: userCode, expires_in: DEVICE_CODE_TTL_MS / 1000, interval: POLL_INTERVAL_SEC } };
  }

  findByUserCode(userCode: string): DeviceAuthorization | undefined {
    const deviceCode = this.byUserCode.get(normalizeUserCode(userCode));
    if (!deviceCode) return undefined;
    const record = this.byDeviceCode.get(deviceCode);
    if (!record || record.expiresAt <= Date.now()) return undefined;
    return record;
  }

  approve(userCode: string, token: string, user: PublicAccountUser): boolean {
    const record = this.findByUserCode(userCode);
    if (!record || record.status !== 'pending') return false;
    record.status = 'approved';
    record.approvedToken = token;
    record.approvedUser = user;
    return true;
  }

  deny(userCode: string): boolean {
    const record = this.findByUserCode(userCode);
    if (!record || record.status !== 'pending') return false;
    record.status = 'denied';
    return true;
  }

  poll(deviceCode: string, clientId: string): DevicePollOutcome {
    const record = this.byDeviceCode.get(deviceCode);
    if (!record || record.clientId !== clientId) return { kind: 'not_found' };
    if (record.expiresAt <= Date.now()) {
      this.forget(record);
      return { kind: 'expired' };
    }
    const now = Date.now();
    if (now - record.lastPolledAt < (POLL_INTERVAL_SEC - 1) * 1000) {
      return { kind: 'slow_down' };
    }
    record.lastPolledAt = now;
    if (record.status === 'denied') {
      this.forget(record);
      return { kind: 'denied' };
    }
    if (record.status === 'approved' && record.approvedToken && record.approvedUser) {
      const outcome: DevicePollOutcome = { kind: 'approved', token: record.approvedToken, user: record.approvedUser };
      this.forget(record);
      return outcome;
    }
    return { kind: 'pending' };
  }

  private forget(record: DeviceAuthorization): void {
    this.byDeviceCode.delete(record.deviceCode);
    this.byUserCode.delete(record.userCode);
  }

  private sweep(): void {
    const now = Date.now();
    for (const record of this.byDeviceCode.values()) {
      if (record.expiresAt <= now) this.forget(record);
    }
  }
}

function normalizeUserCode(userCode: string): string {
  const compact = userCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return compact.length === 8 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact;
}
