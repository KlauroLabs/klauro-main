import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { analyzeProject, analyzeProjectDeferred, getAnalysis } from './analyzer';

const repoRoot = path.resolve(__dirname, '..');
const fixturePath = path.join(repoRoot, 'fixtures', 'analysis-truth', 'express-mongoose');

// AI is configured when any hosted-LLM provider key is present. The deferred
// upgrade only happens when AI can actually run; without a provider the
// deterministic result is final (ai_enrichment='disabled'), so the
// enrichment-specific assertions are gated on this.
const aiConfigured = Boolean(
  process.env.DEEPINFRA_API_KEY ||
  (process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_ENDPOINT) ||
  process.env.OPENAI_API_KEY ||
  process.env.ANTHROPIC_API_KEY,
);

// The synchronous AI phase budget; the deferred deterministic return must be far
// under this. Kept generous so the "fast" assertion is about a phase being
// skipped, not about machine speed.
const SYNC_AI_BUDGET_MS = 8000;

async function withScopedStorage<T>(fn: (repo: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-progressive-'));
  const repo = path.join(root, 'repo');
  const storage = path.join(root, 'storage');
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  process.env.KLAURO_STORAGE_PATH = storage;
  await fs.copy(fixturePath, repo);
  try {
    return await fn(repo);
  } finally {
    if (previousStorage === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previousStorage;
    await fs.remove(root).catch(() => undefined);
  }
}

function hasDescriptions(cas: import('../../../packages/analyzer-core/src/types/cas.types').CASOutput): boolean {
  const systemDescription = cas.enhanced_system_purpose?.inferred_description;
  return Boolean(systemDescription && systemDescription.trim().length > 0);
}

function anyAiDescriptionSource(cas: import('../../../packages/analyzer-core/src/types/cas.types').CASOutput): boolean {
  if (cas.enhanced_system_purpose?.description_source === 'ai') return true;
  return (cas.system_capabilities || []).some(capability => capability.description_source === 'ai');
}

test('default (non-deferred) analyze marks synchronous when AI is available, and is comprehension-AI-only', async () => {
  await withScopedStorage(async repo => {
    if (!aiConfigured) {
      // No AI provider = structure-only mode: comprehension is skipped and left
      // UNSET — never a deterministic substitute. Structure still ships. (In the
      // hosted product a provider is always configured; a configured-but-failing
      // provider is what throws, covered by the analyzer-core determinism tests.)
      const structureOnly = await analyzeProject(repo);
      assert.ok(structureOnly.nodes.length > 0, 'structure ships with AI unavailable');
      assert.notEqual(structureOnly.enhanced_system_purpose?.description_source, 'deterministic');
      assert.equal(hasDescriptions(structureOnly), false, 'no deterministic comprehension is written');
      return;
    }
    const result = await analyzeProject(repo);
    assert.equal(result.ai_enrichment, 'synchronous', 'default path must mark the result synchronous');
    assert.ok(result.nodes.length > 0, 'default path still produces the full graph');
    assert.ok(hasDescriptions(result), 'with AI configured the synchronous path produces a system description');

    const stored = await getAnalysis(repo);
    assert.equal(stored.ai_enrichment, 'synchronous');
  });
});

test('deferred analyze returns the deterministic STRUCTURE fast, then background AI enrichment writes comprehension', async () => {
  await withScopedStorage(async repo => {
    const startedAt = Date.now();
    const { output, enrichment } = await analyzeProjectDeferred(repo);
    const deterministicMs = Date.now() - startedAt;

    // Camp-B STRUCTURE ships immediately; comprehension is deferred (AI-only).
    assert.ok(output.nodes.length > 0, 'deterministic result still produces the full graph');
    // Comprehension is NOT deterministic: while pending/disabled, the system
    // description is unset (empty) — never a deterministic substitute.
    assert.notEqual(output.enhanced_system_purpose?.description_source, 'deterministic');

    if (!aiConfigured) {
      // No provider → nothing to enrich; structure is final, comprehension unset.
      assert.equal(output.ai_enrichment, 'disabled');
      assert.equal(hasDescriptions(output), false, 'no deterministic comprehension is written');
      await enrichment; // resolves immediately
      return;
    }

    // The whole point: the deterministic return skipped the ~multi-second AI
    // phase. Assert it came back well under the synchronous AI budget.
    assert.equal(output.ai_enrichment, 'pending', 'AI is configured, so enrichment should be pending');
    assert.ok(
      deterministicMs < SYNC_AI_BUDGET_MS,
      `deterministic return should be far under the AI budget (was ${deterministicMs}ms, budget ${SYNC_AI_BUDGET_MS}ms)`,
    );
    // Descriptions are still deterministic while pending.
    assert.equal(output.enhanced_system_purpose?.description_source !== 'ai', true, 'pending descriptions are deterministic');

    // Await the background enrichment, then confirm the stored analysis upgraded.
    await enrichment;
    assert.equal(output.ai_enrichment, 'ready', 'returned output object is upgraded in place to ready');

    const stored = await getAnalysis(repo);
    assert.equal(stored.ai_enrichment, 'ready', 'stored analysis is upgraded to ready');
    assert.ok(
      anyAiDescriptionSource(stored),
      'at least one description in the enriched store has source "ai"',
    );

    // Report the observed timing for the verification record.
    console.error(`[progressive-test] deterministic return: ${deterministicMs}ms (AI budget ${SYNC_AI_BUDGET_MS}ms)`);
  });
});
