import { strict as assert } from 'assert';
import { test } from 'node:test';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { preservePreviousAIDescriptions } from './analyzer';

function outputWith(purpose: Record<string, unknown>, capabilities: unknown[] = []): CASOutput {
  return {
    enhanced_system_purpose: {
      primary_type: 'web-application',
      confidence: 0.8,
      evidence: [],
      primary_domain: 'content-management',
      core_concepts: [],
      inferred_description: 'A content management system that organizes detected workflows.',
      description_source: 'deterministic',
      description_generation: {
        status: 'ai_skipped',
        attempted: false,
        reason: 'disabled-by-env',
        generated_at: new Date().toISOString(),
      },
      supporting_workflow_ids: [],
      ...purpose,
    },
    system_capabilities: capabilities,
  } as unknown as CASOutput;
}

test('AI-off full re-analysis preserves the stored AI description and domain with reused provenance', () => {
  const previous = outputWith({
    primary_domain: 'game-world-management',
    domain_source: 'ai',
    inferred_description: 'A tabletop RPG world manager that tracks campaigns, characters, and encounters for game masters.',
    description_source: 'ai',
    description_generation: { status: 'ai_applied', attempted: true },
  });
  const next = outputWith({});

  const result = preservePreviousAIDescriptions(previous, next);
  const purpose = result.enhanced_system_purpose!;

  assert.equal(purpose.inferred_description, previous.enhanced_system_purpose!.inferred_description);
  assert.equal(purpose.description_source, 'reused');
  assert.equal(purpose.description_generation?.status, 'reused_previous');
  assert.equal(purpose.description_generation?.attempted, false);
  assert.equal(purpose.description_generation?.may_be_stale, true);
  assert.equal(purpose.primary_domain, 'game-world-management');
  assert.equal(purpose.domain_source, 'reused');
});

test('a previously reused AI description keeps being carried forward', () => {
  const previous = outputWith({
    inferred_description: 'A music library cleaner that deduplicates tracks and repairs metadata.',
    description_source: 'reused',
    description_generation: { status: 'reused_previous', attempted: false },
  });
  const next = outputWith({});

  const result = preservePreviousAIDescriptions(previous, next);
  assert.equal(result.enhanced_system_purpose?.inferred_description, previous.enhanced_system_purpose!.inferred_description);
  assert.equal(result.enhanced_system_purpose?.description_source, 'reused');
});

test('AI-attempted-and-rejected keeps the fresh deterministic description', () => {
  const previous = outputWith({
    inferred_description: 'An AI description from an earlier run.',
    description_source: 'ai',
    description_generation: { status: 'ai_applied', attempted: true },
  });
  const next = outputWith({
    description_generation: { status: 'ai_rejected', attempted: true, reason: 'unsupported-marketing-language' },
  });
  const freshDescription = next.enhanced_system_purpose!.inferred_description;

  const result = preservePreviousAIDescriptions(previous, next);
  assert.equal(result.enhanced_system_purpose?.inferred_description, freshDescription);
  assert.equal(result.enhanced_system_purpose?.description_source, 'deterministic');
});

test('a prior deterministic description is not treated as AI-enriched', () => {
  const previous = outputWith({
    inferred_description: 'A deterministic description from an earlier AI-off run.',
    description_source: 'deterministic',
  });
  const next = outputWith({});
  const freshDescription = next.enhanced_system_purpose!.inferred_description;

  const result = preservePreviousAIDescriptions(previous, next);
  assert.equal(result.enhanced_system_purpose?.inferred_description, freshDescription);
  assert.equal(result.enhanced_system_purpose?.description_source, 'deterministic');
});

test('AI capability descriptions are carried forward by capability id on AI-off full rebuilds', () => {
  const previous = outputWith(
    { description_source: 'ai', description_generation: { status: 'ai_applied', attempted: true } },
    [
      { id: 'cap_orders', name: 'Order Management', related_domains: ['order'], description: 'Order Management lets operators maintain order intake and fulfillment records for customer orders.', description_source: 'ai' },
      { id: 'cap_misc', description: 'Deterministic capability text.', description_source: 'deterministic' },
    ],
  );
  const next = outputWith({}, [
    { id: 'cap_orders', name: 'Order Management', related_domains: ['order'], description: 'Order operations.', description_source: 'deterministic' },
    { id: 'cap_misc', description: 'Other deterministic text.', description_source: 'deterministic' },
  ]);

  const result = preservePreviousAIDescriptions(previous, next);
  const capabilities = result.system_capabilities as Array<{ id: string; description: string; description_source?: string }>;
  const orders = capabilities.find(capability => capability.id === 'cap_orders')!;
  const misc = capabilities.find(capability => capability.id === 'cap_misc')!;

  assert.equal(orders.description, 'Order Management lets operators maintain order intake and fulfillment records for customer orders.');
  assert.equal(orders.description_source, 'reused');
  assert.equal(misc.description, 'Other deterministic text.');
  assert.equal(misc.description_source, 'deterministic');
});

test('AI capability descriptions are not carried across reused ids with different subjects', () => {
  const previous = outputWith(
    { description_source: 'ai', description_generation: { status: 'ai_applied', attempted: true } },
    [
      { id: 'cap_1', name: 'Slack Management', related_domains: ['slack'], description: 'Slack Management sends Slack notifications for approval workflows.', description_source: 'ai' },
    ],
  );
  const next = outputWith({}, [
    { id: 'cap_1', name: 'Google Management', related_domains: ['google'], description: 'Google operations.', description_source: 'deterministic' },
  ]);

  const result = preservePreviousAIDescriptions(previous, next);
  const capabilities = result.system_capabilities as Array<{ id: string; description: string; description_source?: string }>;
  const google = capabilities.find(capability => capability.id === 'cap_1')!;

  assert.equal(google.description, 'Google operations.');
  assert.equal(google.description_source, 'deterministic');
});
