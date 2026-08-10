import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { aiService } from '../../../packages/analyzer-core/src/ai/ai-service';
import { analyzeProjectLayered, analyzeProjectDeferred, getAnalysis } from './analyzer';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

/**
 * Regression harness for the L5 AI-enrichment dispatch chain (the deferred /
 * remote path). Reproduces the deployed-VPS symptom: after the Camp-C surgery
 * made comprehension AI-only-or-throw, a FAILED AI pass left L5 stuck
 * `layers_ready` 'pending' forever (never 'error'), and product_map stamped
 * `description_source:'deterministic'` on empty output.
 *
 * These tests MOCK the AI provider (no real key) so they run deterministically:
 *  - MOCKED SUCCESS  -> L5 reaches 'ready', ai_enrichment='ready',
 *                       enhanced_system_purpose.description_source='ai'.
 *  - MOCKED FAILURE  -> L5 reaches 'error' (NOT pending), ai_enrichment='error',
 *                       and NO 'deterministic' comprehension provenance is written.
 */

const repoRoot = path.resolve(__dirname, '..');
const fixturePath = path.join(repoRoot, 'fixtures', 'analysis-truth', 'express-mongoose');

const realGenerate = aiService.generateComponentDescription.bind(aiService);

async function withScopedStorage<T>(fn: (repo: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-l5-regression-'));
  const repo = path.join(root, 'repo');
  const storage = path.join(root, 'storage');
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  const previousKey = process.env.OPENAI_API_KEY;
  const previousBudget = process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS;
  process.env.KLAURO_STORAGE_PATH = storage;
  // Make hasAIInterpretationProviderConfigured() true so the deferred path marks
  // ai_enrichment='pending' and registers the enrichment closure — a provider IS
  // configured (as in the hosted product); the mock decides success/failure.
  process.env.OPENAI_API_KEY = 'test-mock-key';
  process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS = '60000';
  await fs.copy(fixturePath, repo);
  try {
    return await fn(repo);
  } finally {
    if (previousStorage === undefined) delete process.env.KLAURO_STORAGE_PATH; else process.env.KLAURO_STORAGE_PATH = previousStorage;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
    if (previousBudget === undefined) delete process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS; else process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS = previousBudget;
    (aiService as any).generateComponentDescription = realGenerate;
    await fs.remove(root).catch(() => undefined);
  }
}

/**
 * Build a grounded system_description from the exact facts the orchestrator
 * hands the model, so it clears the AI grounding gate without a real provider.
 * The gate requires >=160 chars, >=2 sentences, and grounding tokens present.
 */
function groundedDescriptionFor(ctx: any): string {
  const facts = ctx || {};
  const frameworks: string[] = Array.isArray(facts.frameworks) ? facts.frameworks : [];
  const entities: string[] = Array.isArray(facts.databaseEntities) ? facts.databaseEntities : [];
  const deps: string[] = Array.isArray(facts.dependencies) ? facts.dependencies : [];
  const tokens: string[] = Array.isArray(facts.structuralTokens) ? facts.structuralTokens : [];
  const grounding = [...frameworks, ...entities, ...deps, ...tokens].filter(Boolean);
  const lead = grounding.slice(0, 6).join(', ') || 'persisted records';
  const stack = frameworks.join(', ') || deps.slice(0, 3).join(', ') || 'a Node runtime';
  // Written against the v2 four-question contract + the current gate: no
  // "built with <framework>" lead (framework-led-product-narrative), no
  // source-bucket restatement ("HTTP endpoints", "route handlers"), 4-6 full
  // sentences answering what it is / what it does / how it works / how built.
  return (
    `This system is a record-management service that keeps ${entities.slice(0, 3).join(', ') || 'domain records'} ` +
    `accurate and retrievable for its callers. It lets a caller create, read, update, and delete those records, ` +
    `grounded in ${lead}. It works by accepting each incoming request, validating the submitted fields, and ` +
    `persisting the resulting record to its datastore before confirming the change. ` +
    `The implementation composes ${stack} on a Node runtime, with schema definitions enforcing the shape of every stored record.`
  );
}

function mockSuccess(): void {
  (aiService as any).generateComponentDescription = async (context: any): Promise<string> => {
    const ac = context?.additionalContext || {};
    const items: Array<{ id: string; name?: string; relatedDomains?: string[] }> = Array.isArray(ac.items) ? ac.items : [];
    const descriptions = items.map(item => {
      const name = item.name || item.id;
      const subject = item.relatedDomains?.join(' ') || name;
      return {
        id: item.id,
        description: `${name} enforces ${subject} rules when requests enter the product and persists accepted record changes. The resulting ${subject} state remains available to later product workflows.`,
      };
    });
    return JSON.stringify({
      system_description: groundedDescriptionFor(ac),
      domain: 'http-api-record-management',
      descriptions,
      quality_check: { used_facts: (ac.databaseEntities || []).slice(0, 3), unsupported_claims: [] },
    });
  };
}

function mockFailure(): void {
  (aiService as any).generateComponentDescription = async (): Promise<string> => {
    throw new Error('mock provider outage: model endpoint unreachable');
  };
}

/**
 * A system_description that mentions an integration the facts never named
 * (no externalServices on this fixture) — the same rejection FAMILY as the
 * live defect ('unsupported-external-service-claim' / sibling
 * 'unnamed-external-service-claim': see orchestrator.ts's
 * validateGeneratedAIInterpretation). Long/structured enough to clear every
 * OTHER gate (length, sentence count, no source-symbol leakage).
 *
 * The unsupported claim is placed in the FIRST (subject-carrying) sentence
 * deliberately: `sanitizeAIInterpretation`'s per-sentence clause-strip repair
 * (the exact mechanism that legitimately auto-heals most ungrounded-
 * integration mentions) explicitly refuses to drop the opening sentence —
 * "dropping it leaves pronoun-headed prose with no referent" — and returns
 * the text UNCHANGED when the offending clause lives there. That is what
 * makes this description a genuine, persistent rejection (surviving every
 * repair round, exactly like the live Kotlin/Android regression) rather than
 * one the existing auto-repair silently fixes before the gate ever sees it.
 */
function ungroundedIntegrationDescriptionFor(ctx: any): string {
  const facts = ctx || {};
  const entities: string[] = Array.isArray(facts.databaseEntities) ? facts.databaseEntities : [];
  return (
    `This system connects to an external payment gateway to keep ${entities.slice(0, 3).join(', ') || 'domain records'} ` +
    `accurate and retrievable for its callers. It lets a caller create, read, update, and delete those records. ` +
    `It works by accepting each incoming request, validating the submitted fields, and persisting the resulting ` +
    `record to its datastore before confirming the change. The implementation composes a Node runtime, with schema ` +
    `definitions enforcing the shape of every stored record.`
  );
}

/**
 * Mocks a run where the AI PROVIDER responds every time (never throws — this
 * is not a provider-outage scenario), the SYSTEM-LEVEL narrative always names
 * an integration no supplied fact corroborates (so `validateGeneratedAIInterpretation`
 * rejects it on every attempt, including both repair rounds), but per-item
 * capability/entity description batches (`additionalContext.items`, handled by
 * `applyAIElementDescriptions`) are answered with real, evidence-grounded prose.
 * Reproduces the shape of the live regression: one ungrounded system paragraph,
 * with everything else the model was asked for perfectly fine.
 */
function mockDegradedSystemDescriptionOnly(): void {
  (aiService as any).generateComponentDescription = async (context: any): Promise<string> => {
    const ac = context?.additionalContext || {};
    const items: Array<{ id: string; name?: string; relatedDomains?: string[] }> = Array.isArray(ac.items) ? ac.items : [];
    const descriptions = items.map(item => {
      const name = item.name || item.id;
      const subject = item.relatedDomains?.join(' ') || name;
      return {
        id: item.id,
        description: `${name} enforces ${subject} rules when requests enter the product and persists accepted record changes. The resulting ${subject} state remains available to later product workflows.`,
      };
    });
    return JSON.stringify({
      system_description: ungroundedIntegrationDescriptionFor(ac),
      domain: 'http-api-record-management',
      descriptions,
      quality_check: { used_facts: (ac.databaseEntities || []).slice(0, 3), unsupported_claims: [] },
    });
  };
}

function noDeterministicComprehension(cas: CASOutput): void {
  const purposeSource = cas.enhanced_system_purpose?.description_source;
  assert.notEqual(purposeSource, 'deterministic', 'enhanced_system_purpose.description_source must never be deterministic');
  const domainSource = cas.enhanced_system_purpose?.domain_source;
  assert.notEqual(domainSource, 'deterministic', 'domain_source must never be deterministic');
  const identity = cas.product_map?.identity;
  if (identity) {
    assert.notEqual(identity.description_source, 'deterministic', 'product_map identity description_source must never be deterministic');
    assert.notEqual(identity.domain_source, 'deterministic', 'product_map identity domain_source must never be deterministic');
  }
  for (const cap of cas.system_capabilities || []) {
    assert.notEqual(cap.description_source, 'deterministic', `capability ${cap.id} must never carry a deterministic description`);
  }
}

function l5Status(cas: CASOutput): string | undefined {
  return cas.layers_ready?.layers.find(l => l.layer === 'L5')?.status;
}

test('MOCKED SUCCESS: L5 reaches ready, description_source=ai, no deterministic leak', async () => {
  await withScopedStorage(async repo => {
    mockSuccess();
    const layered = await analyzeProjectLayered(repo);
    await layered.l0;
    const rest = await layered.rest;
    // Drain the background enrichment (fire-and-forget) so L5 settles.
    await rest.enrichment;

    const stored = await getAnalysis(repo);
    assert.equal(stored.ai_enrichment, 'ready', 'ai_enrichment must be ready after a successful AI pass');
    assert.equal(l5Status(stored), 'ready', 'L5 layers_ready must be ready after success');
    assert.equal(
      stored.enhanced_system_purpose?.description_source,
      'ai',
      'a successful AI pass must write an ai-sourced system description',
    );
    assert.ok(
      (stored.enhanced_system_purpose?.inferred_description || '').trim().length > 0,
      'description must be non-empty on success',
    );
    noDeterministicComprehension(stored);
  });
});

test('MOCKED FAILURE: L5 reaches error (never pending), ai_enrichment=error, no deterministic description', async () => {
  await withScopedStorage(async repo => {
    mockFailure();
    const layered = await analyzeProjectLayered(repo);
    await layered.l0;
    const rest = await layered.rest;
    await rest.enrichment;

    const stored = await getAnalysis(repo);
    assert.equal(stored.ai_enrichment, 'error', 'a failed AI pass must mark ai_enrichment=error, not leave it pending');
    assert.equal(l5Status(stored), 'error', 'L5 must reach error on failure — never sit pending forever');
    assert.notEqual(l5Status(stored), 'pending', 'L5 must NOT be pending after a terminal AI failure');
    // Comprehension is AI-only (docs/cas/DETERMINISM-BOUNDARY.md): on failure the
    // description text stays EMPTY (never a deterministic substitute string) and
    // no 'deterministic' provenance is stamped. The attempted-but-failed AI pass
    // is recorded via description_generation.status='ai_failed'.
    assert.ok(
      !(stored.enhanced_system_purpose?.inferred_description || '').trim(),
      'no comprehension description text is written on failure',
    );
    assert.equal(
      stored.enhanced_system_purpose?.description_generation?.status,
      'ai_failed',
      'the failed AI attempt is recorded as ai_failed, not silently dropped',
    );
    // The served product_map identity must not present a fabricated description.
    assert.ok(
      !(stored.product_map?.identity?.description || '').trim(),
      'product_map identity description is empty on failure — no deterministic frame',
    );
    noDeterministicComprehension(stored);
  });
});

test('MOCKED DEGRADED SYSTEM DESCRIPTION: a rejected system paragraph must not blast-radius the rest of L5 comprehension', async () => {
  await withScopedStorage(async repo => {
    mockDegradedSystemDescriptionOnly();
    const layered = await analyzeProjectLayered(repo);
    await layered.l0;
    const rest = await layered.rest;
    await rest.enrichment;

    const stored = await getAnalysis(repo);

    // The system_description itself has no deterministic substitute and must
    // ship NOTHING rather than fabricated text — the doctrine this whole file
    // guards is unchanged.
    assert.ok(
      !(stored.enhanced_system_purpose?.inferred_description || '').trim(),
      'a system description that never clears the grounding gate ships no text — never a fabricated substitute',
    );
    assert.ok(
      !(stored.product_map?.identity?.description || '').trim(),
      'product_map identity description stays empty when the system narrative was rejected',
    );

    // The rejection is a visible, honest degradation — never silent.
    const degradation = stored.enhanced_system_purpose?.system_description_degradation;
    assert.ok(degradation, 'system_description_degradation must be recorded when the gate rejects every attempt');
    assert.equal(degradation?.failure_class, 'failed-grounding');
    assert.ok((degradation?.reason || '').length > 0);

    // BUT: this is the blast-radius fix under test. A rejected system
    // paragraph alone must not fail the whole L5 pass — ai_enrichment reaches
    // 'ready', not 'error', and per-item comprehension survives.
    assert.equal(
      stored.ai_enrichment,
      'ready',
      'a system-description-only rejection must still reach ready — it is not a total AI failure',
    );
    assert.equal(l5Status(stored), 'ready');
    const aiCapabilities = (stored.system_capabilities || []).filter(cap => cap.description_source === 'ai');
    assert.ok(
      aiCapabilities.length > 0,
      'capability descriptions must survive a system-description-only rejection, not roll back to the raw pre-AI snapshot',
    );
  });
});

test('MOCKED FAILURE via analyzeProjectDeferred directly: ai_enrichment=error persisted', async () => {
  await withScopedStorage(async repo => {
    mockFailure();
    const { output, enrichment } = await analyzeProjectDeferred(repo);
    assert.equal(output.ai_enrichment, 'pending', 'deferred structure ships with enrichment pending');
    await enrichment;
    assert.equal(output.ai_enrichment, 'error', 'the in-memory output flips to error on failed enrichment');
    const stored = await getAnalysis(repo);
    assert.equal(stored.ai_enrichment, 'error', 'the STORED analysis reflects the visible error state');
    noDeterministicComprehension(stored);
  });
});
