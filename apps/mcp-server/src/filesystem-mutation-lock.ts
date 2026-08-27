import * as fs from 'fs-extra';
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { hostname } from 'node:os';
import * as path from 'node:path';

const LOCK_STALE_MS = 5 * 60_000;
const LOCK_WAIT_MS = 30_000;

interface FilesystemMutationLock {
  lockDir: string;
  token: string;
}

interface FilesystemMutationOwner {
  token?: string;
  pid?: number;
  instance?: string;
  boot_id?: string;
  process_start?: string;
}

const mutations = new Map<string, Promise<unknown>>();

export async function serializeFilesystemMutation<T>(
  key: string,
  lockDir: string,
  operation: (assertOwned: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const prior = mutations.get(key) || Promise.resolve();
  const pending = prior.catch(() => undefined).then(async () => {
    const lock = await acquireFilesystemMutationLock(lockDir);
    const heartbeat = setInterval(() => {
      const now = new Date();
      void assertFilesystemLockOwned(lock).then(() => fs.utimes(lockDir, now, now)).catch(() => undefined);
    }, Math.max(1_000, Math.floor(LOCK_STALE_MS / 3)));
    heartbeat.unref?.();
    try {
      return await operation(() => assertFilesystemLockOwned(lock));
    } finally {
      clearInterval(heartbeat);
      await releaseFilesystemMutationLock(lock);
    }
  });
  mutations.set(key, pending);
  try {
    return await pending;
  } finally {
    if (mutations.get(key) === pending) mutations.delete(key);
  }
}

export async function ensureDurableDirectory(dir: string): Promise<void> {
  const existed = await fs.pathExists(dir);
  await fs.ensureDir(dir);
  if (!existed) await syncDirectory(path.dirname(dir));
}

export async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function acquireFilesystemMutationLock(lockDir: string): Promise<FilesystemMutationLock> {
  await ensureDurableDirectory(path.dirname(lockDir));
  const deadline = Date.now() + LOCK_WAIT_MS;
  const currentBootId = await readBootId();
  const currentInstance = lockInstanceIdentity();
  const currentProcessStart = await readProcessStart(process.pid);
  while (true) {
    const token = randomUUID();
    const pendingDir = `${lockDir}.pending-${token}`;
    let published = false;
    try {
      await fs.mkdir(pendingDir);
      const ownerPath = path.join(pendingDir, 'owner.json');
      const handle = await open(ownerPath, 'wx');
      try {
        await handle.writeFile(`${JSON.stringify({
          token,
          pid: process.pid,
          instance: currentInstance,
          ...(currentBootId ? { boot_id: currentBootId } : {}),
          ...(currentProcessStart ? { process_start: currentProcessStart } : {}),
        })}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(pendingDir);
      await fs.rename(pendingDir, lockDir);
      published = true;
      await syncDirectory(path.dirname(lockDir));
      return { lockDir, token };
    } catch (error) {
      await fs.remove(pendingDir).catch(() => undefined);
      const code = (error as NodeJS.ErrnoException).code;
      if (published) {
        await releaseFilesystemMutationLock({ lockDir, token });
        throw error;
      }
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
      const owner = await fs.readJson(path.join(lockDir, 'owner.json')).catch(() => null) as FilesystemMutationOwner | null;
      const sameInstanceAndBoot = Boolean(
        owner?.instance === currentInstance
        && currentBootId
        && owner.boot_id === currentBootId
        && typeof owner.pid === 'number'
        && owner.process_start,
      );
      const priorBoot = Boolean(owner?.instance === currentInstance && currentBootId && owner?.boot_id && owner.boot_id !== currentBootId);
      const ownerProcessStart = sameInstanceAndBoot ? await readProcessStart(owner!.pid!) : undefined;
      const processProvenGoneOrReused = ownerProcessStart === null
        || (typeof ownerProcessStart === 'string' && ownerProcessStart !== owner!.process_start);
      if (priorBoot || (sameInstanceAndBoot && processProvenGoneOrReused)) {
        const staleDir = `${lockDir}.stale-${randomUUID()}`;
        try {
          await fs.rename(lockDir, staleDir);
          await fs.remove(staleDir);
          continue;
        } catch (renameError) {
          if ((renameError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw renameError;
        }
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for filesystem mutation lock: ${lockDir}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
}

async function readBootId(): Promise<string | undefined> {
  const value = await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8').catch(() => '');
  return value.trim() || undefined;
}

function lockInstanceIdentity(): string {
  return process.env.KLAURO_TELEMETRY_LOCK_INSTANCE?.trim() || hostname();
}

async function readProcessStart(pid: number): Promise<string | null | undefined> {
  let value: string;
  try {
    value = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
  }
  const fields = value.slice(value.lastIndexOf(') ') + 2).trim().split(/\s+/);
  return fields.length > 19 ? fields[19] : undefined;
}

async function assertFilesystemLockOwned(lock: FilesystemMutationLock): Promise<void> {
  const owner = await fs.readJson(path.join(lock.lockDir, 'owner.json')).catch(() => null) as { token?: string } | null;
  if (owner?.token !== lock.token) throw new Error('Filesystem mutation lock ownership was lost');
}

async function releaseFilesystemMutationLock(lock: FilesystemMutationLock): Promise<void> {
  const owner = await fs.readJson(path.join(lock.lockDir, 'owner.json')).catch(() => null) as { token?: string } | null;
  if (owner?.token !== lock.token) return;
  const releaseDir = `${lock.lockDir}.release-${lock.token}`;
  try {
    await fs.rename(lock.lockDir, releaseDir);
    await fs.remove(releaseDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
