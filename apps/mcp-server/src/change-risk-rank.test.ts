import assert from 'node:assert/strict';
import test from 'node:test';
import { changeRiskRank, rankChangeRisks } from './change-risk-rank';

test('change risk rank scores level, factor severity, and missing direct tests', () => {
  assert.equal(changeRiskRank({ risk_level: 'critical' }), 400);
  assert.equal(changeRiskRank({ risk_level: 'HIGH', risk_factors: [{ severity: 'high' }, { severity: 'medium' }, { severity: 'low' }, { severity: 'other' }] }), 317);
  assert.equal(changeRiskRank({ risk_level: 'medium', test_protection: { has_direct_tests: false } }), 215);
  assert.equal(changeRiskRank({ risk_level: 'low', test_protection: { has_direct_tests: true } }), 100);
  assert.equal(changeRiskRank({ risk_level: 'unknown', risk_factors: 'not-an-array' }), 0);
  assert.equal(changeRiskRank(null), 0);
});

test('ranking is complete, descending, and stable in original order on ties', () => {
  const risks = [
    { node_id: 'a', risk_level: 'low' },
    { node_id: 'b', risk_level: 'high' },
    { node_id: 'c', risk_level: 'low' },
    { node_id: 'd', risk_level: 'high', test_protection: { has_direct_tests: false } },
  ];
  assert.deepEqual(rankChangeRisks(risks), [
    { ordinal: 3, node_id: 'd', rank: 315 },
    { ordinal: 1, node_id: 'b', rank: 300 },
    { ordinal: 0, node_id: 'a', rank: 100 },
    { ordinal: 2, node_id: 'c', rank: 100 },
  ]);
  assert.deepEqual(rankChangeRisks([]), []);
});
