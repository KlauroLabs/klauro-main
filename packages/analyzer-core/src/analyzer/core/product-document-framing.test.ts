import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractProductDocumentFraming } from './product-document-framing';
import { buildFirstPartyProductEvidence, firstPartyProductEvidenceRefreshDecision } from './first-party-product-evidence';
import type { SystemCapability } from '../../types/cas.types';
import { deriveCapabilityCatalogOutcomeRequirements } from './capability-catalog-outcome-coverage';

test('structured outcome declarations retain individual boundaries including short and unfamiliar actions', () => {
  const outcomes = ['Know what will break before changing something', 'Pay bills', 'Hail a ride'];
  const signal = {
    productDocSummary: 'The product builds a relationship graph.',
    productDocStatements: outcomes.map(value => ({ role: 'feature' as const, value })),
  };
  const candidates = ['assess_change_risk', 'bill_payment', 'ride_hailing'].map(id => ({
    id, name: id, description: '', category: 'core', criticality: 'medium', criticality_factors: [],
    related_entities: [], related_domains: [],
    operations: [{ entry_point_id: id, entry_point_type: 'api', action: id }],
  } as SystemCapability));
  const requirements = deriveCapabilityCatalogOutcomeRequirements(signal, candidates);
  assert.deepEqual(requirements.map(requirement => requirement.statement), outcomes);
  assert.deepEqual(requirements.map(requirement => requirement.firstPartyOutcomeText), outcomes);
  assert.deepEqual(requirements.map(requirement => requirement.candidateIds), candidates.map(candidate => [candidate.id]));
  assert.equal(new Set(requirements.map(requirement => requirement.id)).size, outcomes.length);
  const evidence = buildFirstPartyProductEvidence({ ...signal, productDocSource: 'README.md' });
  assert.deepEqual(evidence?.statements?.map(statement => statement.value), outcomes);
});

test('retains document roles and unknown feature language without claiming implementation', () => {
  const framing = extractProductDocumentFraming([
    '# Demand planning',
    '',
    'The system builds a statistical model from warehouse records.',
    '',
    '## Features',
    '',
    '- Predict customer demand.',
    '- Pay bills.',
    '',
    'For example:',
    '- Which warehouse runs out first?',
    '',
    '## Architecture Overview',
    '',
    '- Statistical model training jobs.',
  ].join('\n'));
  const statements = framing.statements || [];
  assert.ok(statements.some(statement => statement.role === 'overview' && /statistical model/.test(statement.value)));
  assert.deepEqual(statements.filter(statement => statement.role === 'feature').map(statement => statement.value),
    ['Predict customer demand.', 'Pay bills.']);
  assert.ok(statements.some(statement => statement.role === 'example' && /Which warehouse/.test(statement.value)));
  assert.ok(statements.some(statement => statement.role === 'context' && /training jobs/.test(statement.value)));
  const evidence = buildFirstPartyProductEvidence({
    productDocTitle: framing.title, productDocSummary: framing.summary,
    productDocSource: 'README.md', productDocStatements: statements,
  });
  assert.deepEqual(evidence?.statements?.map(({ source, ...statement }) => {
    assert.equal(source, 'README.md');
    return statement;
  }), statements);
  assert.equal('capabilities' in (evidence || {}), false);
});

test('explicit product declarations do not turn overview mechanisms into extra required outcomes', () => {
  const content = fs.readFileSync(path.join(__dirname, '../../../../../README.md'), 'utf8');
  const framing = extractProductDocumentFraming(content);
  const declared = (framing.statements || []).filter(statement => statement.role === 'feature');
  assert.equal(declared.length, 5);
  const requirements = deriveCapabilityCatalogOutcomeRequirements({
    productDocSummary: framing.summary,
    productDocStatements: framing.statements,
  }, [{
    id: 'coordination', name: 'Concurrent codebase work', description: 'People and agents coordinate codebase work.',
    category: 'core', criticality: 'medium', criticality_factors: [],
    related_entities: [], related_domains: [],
    operations: [{ entry_point_id: 'coordination', entry_point_type: 'message', action: 'coordinate_overlapping_work' }],
  } as SystemCapability, {
    id: 'risk', name: 'Change risk assessment', description: 'Assess connected change risk.',
    category: 'core', criticality: 'medium', criticality_factors: [],
    related_entities: [], related_domains: [],
    operations: [{ entry_point_id: 'risk', entry_point_type: 'api', action: 'assess_change_risk' }],
  } as SystemCapability]);
  assert.deepEqual(requirements.map(requirement => requirement.statement),
    declared.map(statement => statement.value.replace(/[.!?]+$/, '')));
  assert.ok((framing.statements || []).some(statement => statement.role === 'overview' && /relationship graph/.test(statement.value)));
  assert.match(framing.summary || '', /relationship graph/);
  assert.ok(requirements.every(requirement => !/builds a trustworthy|turns that graph|correlates static/.test(requirement.statement)));
});

test('retains declared items beyond the former line, item and summary excerpt limits', () => {
  const features = Array.from({ length: 30 }, (_, index) => 'Predict demand for warehouse ' + index + ' using customer orders, regional patterns, seasonality and historical delivery schedules across every distribution region.');
  const framing = extractProductDocumentFraming([
    '# Forecasting', '', 'A forecasting application for warehouse operators.', '',
    ...Array.from({ length: 510 }, () => ''),
    '## Features', '', ...features.map(feature => '- ' + feature),
  ].join('\n'));
  assert.deepEqual((framing.statements || []).filter(statement => statement.role === 'feature').map(statement => statement.value), features);
  const evidence = buildFirstPartyProductEvidence({
    productDocSummary: framing.summary, productDocStatements: framing.statements, productDocSource: 'README.md',
  });
  assert.equal(evidence?.statements?.filter(statement => statement.role === 'feature').length, 30);
  assert.match(evidence!.statements!.at(-1)!.value, /warehouse 29/);
  assert.ok(features.join(' ').length > 3000);
});

test('legacy unstructured documents still supply discovery and requirement context', () => {
  const signal = { productDocSummary: 'Feature: Track warehouse inventory.' };
  const legacy = deriveCapabilityCatalogOutcomeRequirements(signal, []);
  const structuredWithoutDeclarations = deriveCapabilityCatalogOutcomeRequirements({
    ...signal, productDocStatements: [{ role: 'overview' as const, value: signal.productDocSummary }],
  }, []);
  assert.deepEqual(structuredWithoutDeclarations, legacy);
  assert.equal(legacy.length, 1);
});

test('document evidence changes invalidate interpretation reuse beyond legacy excerpts', () => {
  const overview = 'A stable overview excerpt.';
  const previous = { overview: { value: overview, source: 'README.md' }, statements: [{ role: 'feature' as const, value: 'Predict demand.', source: 'README.md' }] };
  assert.equal(firstPartyProductEvidenceRefreshDecision(previous, structuredClone(previous)), undefined);
  const changed = structuredClone(previous);
  changed.statements[0].value = 'Predict demand and reserve warehouse capacity.';
  assert.deepEqual(firstPartyProductEvidenceRefreshDecision(previous, changed), {
    refresh: true, reason: 'first-party-product-evidence-changed',
  });
  assert.ok(firstPartyProductEvidenceRefreshDecision(previous, undefined)?.refresh);
  assert.equal(firstPartyProductEvidenceRefreshDecision(undefined, {}), undefined);
});

test('document roles affect reuse but JSON property order does not', () => {
  const previous = { statements: [{ role: 'feature' as const, value: 'Predict demand.', source: 'README.md' }] };
  const same = { statements: [{ source: 'README.md', value: 'Predict demand.', role: 'feature' as const }] };
  assert.equal(firstPartyProductEvidenceRefreshDecision(previous, same), undefined);
  assert.ok(firstPartyProductEvidenceRefreshDecision(previous, {
    statements: [{ ...previous.statements[0], role: 'example' }],
  })?.refresh);
});

test('a feature declaration is not proof that a quality or unfamiliar action is implemented', () => {
  const framing = extractProductDocumentFraming('# Planning\n\nA planning system.\n\n## Features\n\n- Predict customer demand.\n- Exceptionally fast.\n');
  const evidence = buildFirstPartyProductEvidence({
    productDocStatements: framing.statements, productDocSource: 'README.md',
  });
  assert.deepEqual(evidence?.statements?.filter(statement => statement.role === 'feature').map(statement => statement.value),
    ['Predict customer demand.', 'Exceptionally fast.']);
  assert.deepEqual(deriveCapabilityCatalogOutcomeRequirements({
    productDocSummary: framing.summary, productDocStatements: framing.statements,
  }, []), []);
});
