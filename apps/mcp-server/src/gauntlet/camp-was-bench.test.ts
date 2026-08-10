/**
 * FIRST-CLASS workspace-level-CAS bench — measured, never faked.
 *
 * Asserts the cross-repo win is real on the ui-api-worker fixture:
 *   - reposCrossed >= 2 (it is a multi-repo workspace);
 *   - >= 6 of the 8 W-groups emit > 0 facts;
 *   - the DEFINING cross-repo win — W2 (integration seams) OR W3 (data flow) —
 *     emits > 0 (the fused fetch->route seam / data crossing a repo boundary).
 *
 * Counts come from the REAL buildCrossCodebaseSystemGraph over a REAL fixture; a
 * W-group that emits 0 on this fixture is recorded honestly as 0.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCampWASReport, _resetCampWASCache, type WGroup } from './camp-was-bench';

test('WAS bench crosses >=2 repos, >=6 W-groups emit, and the cross-repo seam/flow win is real', async () => {
  _resetCampWASCache();
  const report = await buildCampWASReport();

  // Multi-repo workspace.
  assert.equal(report.repos >= 2, true, `expected >=2 repos, got ${report.repos}`);
  assert.equal(
    report.aggregate.reposCrossed >= 2,
    true,
    `expected reposCrossed >=2, got ${report.aggregate.reposCrossed}`,
  );

  // All 8 W-groups represented as dimensions, out-of-category flag set.
  assert.equal(report.dimensions.length, 8, 'expected 8 W-group dimensions');
  assert.equal(report.outOfCategory, true);
  const groups = new Set(report.dimensions.map(d => d.group));
  for (const g of ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8'] as WGroup[]) {
    assert.equal(groups.has(g), true, `missing W-group ${g}`);
  }

  // >= 6 of 8 W-groups emit > 0 facts.
  const emitting = report.dimensions.filter(d => d.emitted > 0);
  assert.equal(
    emitting.length >= 6,
    true,
    `expected >=6 W-groups to emit >0, got ${emitting.length}: ` +
      report.dimensions.map(d => `${d.group}=${d.emitted}`).join(' '),
  );

  // The DEFINING cross-repo win: integration seams (W2) OR data flow (W3) > 0.
  const w2 = report.dimensions.find(d => d.group === 'W2');
  const w3 = report.dimensions.find(d => d.group === 'W3');
  assert.ok(w2 && w3, 'W2 and W3 dimensions must exist');
  assert.equal(
    (w2!.emitted > 0) || (w3!.emitted > 0),
    true,
    `defining cross-repo win missing: W2=${w2!.emitted} W3=${w3!.emitted}`,
  );

  // Every emitted dimension carries a campABCannot statement and the cas fields it counts.
  for (const d of report.dimensions) {
    assert.equal(typeof d.campABCannot, 'string');
    assert.equal(d.campABCannot.length > 0, true, `${d.group} missing campABCannot`);
    assert.equal(d.casFields.length > 0, true, `${d.group} missing casFields`);
    assert.equal(d.emitted >= 0, true);
  }

  // totalEmitted is the honest sum.
  const sum = report.dimensions.reduce((s, d) => s + d.emitted, 0);
  assert.equal(report.aggregate.totalEmitted, sum);

  // Print the W-group summary (group -> emitted, a couple examples).
  // eslint-disable-next-line no-console
  console.log(`\nWAS first-class bench — workspace "${report.workspace}" (${report.repos} repos, reposCrossed=${report.aggregate.reposCrossed})`);
  for (const d of report.dimensions) {
    // eslint-disable-next-line no-console
    console.log(`  ${d.group} ${d.label}: emitted=${d.emitted}` +
      (d.examples.length ? `\n      e.g. ${d.examples.slice(0, 2).join(' | ')}` : ''));
  }
  // eslint-disable-next-line no-console
  console.log(`  TOTAL emitted=${report.aggregate.totalEmitted} across ${emitting.length}/8 emitting W-groups\n`);
});
