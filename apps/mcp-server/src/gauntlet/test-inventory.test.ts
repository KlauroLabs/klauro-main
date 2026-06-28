import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTestInventory } from './test-inventory';

test('inventory enumerates the real suite (non-trivial counts)', async () => {
  const inv = await buildTestInventory();
  assert.ok(inv.total_files >= 50, `only ${inv.total_files} files`);
  assert.ok(inv.total_tests >= 400, `only ${inv.total_tests} tests`);
  assert.ok(inv.areas.length >= 3);
});

test('totals are consistent with per-area and per-file sums', async () => {
  const inv = await buildTestInventory();
  const areaSum = inv.areas.reduce((a, x) => a + x.test_count, 0);
  assert.equal(areaSum, inv.total_tests);
  const fileSum = inv.areas.reduce((a, x) => a + x.files.reduce((b, f) => b + f.count, 0), 0);
  assert.equal(fileSum, inv.total_tests);
});

test('areas are sorted by test_count desc; files within an area too', async () => {
  const inv = await buildTestInventory();
  for (let i = 1; i < inv.areas.length; i++) {
    assert.ok(inv.areas[i - 1].test_count >= inv.areas[i].test_count);
  }
  for (const area of inv.areas) {
    for (let i = 1; i < area.files.length; i++) {
      assert.ok(area.files[i - 1].count >= area.files[i].count);
    }
  }
});

test('this very test file is discovered with its tests named', async () => {
  const inv = await buildTestInventory();
  const self = inv.areas.flatMap(a => a.files).find(f => f.file.endsWith('gauntlet/test-inventory.test.ts'));
  assert.ok(self, 'inventory did not find itself');
  assert.ok(self!.count >= 5);
  assert.ok(self!.tests.some(t => t.name.includes('enumerates the real suite')));
});

test('skipped tests are flagged, not counted as passing', async () => {
  const inv = await buildTestInventory();
  // total_skipped is a subset of total_tests
  assert.ok(inv.total_skipped >= 0 && inv.total_skipped <= inv.total_tests);
  const flagged = inv.areas.flatMap(a => a.files).flatMap(f => f.tests).filter(t => t.skipped).length;
  assert.equal(flagged, inv.total_skipped);
});

test('every file has a repo-relative path and a known area', async () => {
  const inv = await buildTestInventory();
  for (const a of inv.areas) {
    for (const f of a.files) {
      assert.match(f.file, /^src\/.*\.test\.ts$/);
      assert.equal(f.area, a.area);
    }
  }
});
