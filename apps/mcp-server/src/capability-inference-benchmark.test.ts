import assert from 'node:assert/strict';
import test from 'node:test';
import { runCapabilityInferenceBenchmark } from './capability-inference-benchmark';

test('capability inference benchmark prefers domain capabilities over framework entry noise', async () => {
  const report = await runCapabilityInferenceBenchmark();

  assert.equal(report.status, 'pass');
  assert.equal(report.score, 100);
  // Domain comprehension is AI-only: through a product server with no AI
  // provider the domain is honestly ABSENT (ai_skipped provenance); when the
  // product ran with AI it must be AI-sourced. Either way it must never be a
  // deterministic hardcoded stamp — the primary-domain-provenance gate (part
  // of report.status above) enforces exactly that, so no literal label here.
  assert.equal(report.summary.generic_capability_count, 0);
  // Match each domain concept over name + description, case-insensitively, with
  // concept synonyms (invoice settlement/billing). Capability phrasing is AI-derived
  // and varies run-to-run; a case-sensitive name-only substring was cold-AI-flaky.
  const capabilityText = report.capabilities.map(capability => `${capability.name} ${capability.description || ''}`.toLowerCase());
  assert.ok(capabilityText.some(text => /fuel/.test(text)), `no fuel capability: ${capabilityText.join(' | ')}`);
  assert.ok(capabilityText.some(text => /vehicle|fleet/.test(text)), `no vehicle capability: ${capabilityText.join(' | ')}`);
  assert.ok(capabilityText.some(text => /invoice|settle|billing/.test(text)), `no invoice capability: ${capabilityText.join(' | ')}`);
});
