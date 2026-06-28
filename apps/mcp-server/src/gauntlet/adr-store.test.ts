import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import { saveAdr, getAdrs } from '../adr-store';

test('ADR store persists, lists, and supersedes across calls', async () => {
  const dir = path.join(os.tmpdir(), `klauro-adr-test-${process.pid}`);
  await fs.ensureDir(dir);
  try {
    const empty = await getAdrs(dir);
    assert.equal(empty.total, 0);

    const a = await saveAdr(dir, { title: 'Use TypeORM', decision: 'Adopt TypeORM for persistence', context: 'Need an ORM', date: '2026-01-01T00:00:00Z' });
    assert.equal(a.id, 'adr-0001');
    assert.equal(a.status, 'accepted');

    const after = await getAdrs(dir);
    assert.equal(after.total, 1);
    assert.equal(after.adrs[0].title, 'Use TypeORM');

    const b = await saveAdr(dir, { title: 'Switch to Prisma', decision: 'Replace TypeORM with Prisma', supersedes: 'adr-0001', date: '2026-02-01T00:00:00Z' });
    assert.equal(b.id, 'adr-0002');
    const final = await getAdrs(dir);
    assert.equal(final.total, 2);
    assert.equal(final.adrs.find(x => x.id === 'adr-0001')!.status, 'superseded', 'superseded ADR marked');
  } finally {
    await fs.remove(dir);
  }
});
