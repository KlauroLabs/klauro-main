import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCapabilityDescription, type CapabilityDescriptionSelection } from './capability-description-selection';

const select = (existing: CapabilityDescriptionSelection, generated = '', preferGenerated = false) =>
  selectCapabilityDescription({ existing, generated, preferGenerated, sanitize: text => text.trim() || undefined,
    validate: text => ({ ok: !text.includes('invalid') }), budgetMs: 20000 });

test('retaining the real self-analysis README text preserves deterministic provenance', () => {
  const existing: CapabilityDescriptionSelection = {
    description: 'Understand what a codebase actually built.',
    description_source: 'deterministic',
    description_generation: { status: 'deterministic_kept', attempted: false, reason: 'grounded-first-party-outcome' },
  };
  assert.deepEqual(select(existing), existing);
  assert.notEqual(select(existing)?.description_generation, existing.description_generation);
});

test('accepted existing AI text preserves its original generation timestamp and budget', () => {
  const existing: CapabilityDescriptionSelection = { description: 'Record pet visits.', description_source: 'ai',
    description_generation: { status: 'ai_applied', attempted: true, generated_at: '2026-09-06T00:00:00Z', budget_ms: 4000 } };
  assert.deepEqual(select(existing, 'invalid replacement', true), existing);
});

test('sanitization preserves manual and reused origins rather than becoming AI authorship', () => {
  for (const source of ['manual', 'reused'] as const) {
    const existing: CapabilityDescriptionSelection = { description: '  Record pet visits.  ', description_source: source,
      description_generation: source === 'reused' ? { status: 'reused_previous', attempted: false, origin_source: 'manual' } : undefined };
    assert.deepEqual(select(existing), { ...existing, description: 'Record pet visits.' });
  }
});

test('a selected fresh model response receives fresh AI provenance', () => {
  const selected = select({ description: 'Existing prose', description_source: 'manual' }, 'Record a pet visit.', true);
  assert.equal(selected?.description, 'Record a pet visit.');
  assert.equal(selected?.description_source, 'ai');
  assert.equal(selected?.description_generation?.status, 'ai_applied');
  assert.equal(selected?.description_generation?.attempted, true);
  assert.equal(selected?.description_generation?.budget_ms, 20000);
  assert.ok(selected?.description_generation?.generated_at);
});

test('invalid existing prose can be replaced but neither invalid candidate can be published', () => {
  assert.equal(select({ description: 'invalid existing' }, 'Record a pet visit.')?.description_source, 'ai');
  assert.equal(select({ description: 'invalid existing' }, 'invalid generated'), undefined);
});

test('unknown existing provenance is preserved as unknown, never invented', () => {
  assert.deepEqual(select({ description: 'Record a pet visit.' }), {
    description: 'Record a pet visit.', description_source: undefined, description_generation: undefined,
  });
});
