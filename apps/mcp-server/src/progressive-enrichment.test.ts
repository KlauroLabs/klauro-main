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

test('default (non-deferred) analyze annotates ai_enrichment=synchronous and is otherwise unchanged', async () => {
  await withScopedStorage(async repo => {
    const result = await analyzeProject(repo);
    assert.equal(result.ai_enrichment, 'synchronous', 'default path must mark the result synchronous');
    assert.ok(result.nodes.length > 0, 'default path still produces the full graph');
    assert.ok(hasDescriptions(result), 'default path produces a system description');

    // The stored copy matches the returned copy (byte-for-byte behavior of the
    // synchronous path is preserved; the marker is a pure annotation).
    const stored = await getAnalysis(repo);
    assert.equal(stored.ai_enrichment, 'synchronous');
  });
});

test('deferred analyze returns the deterministic result fast, then the background AI enrichment upgrades the store', async () => {
  await withScopedStorage(async repo => {
    const startedAt = Date.now();
    const { output, enrichment } = await analyzeProjectDeferred(repo);
    const deterministicMs = Date.now() - startedAt;

    assert.ok(output.nodes.length > 0, 'deterministic result still produces the full graph');
    assert.ok(hasDescriptions(output), 'deterministic result carries deterministic descriptions');

    if (!aiConfigured) {
      // No provider → nothing to enrich; the deterministic result is final.
      assert.equal(output.ai_enrichment, 'disabled');
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
