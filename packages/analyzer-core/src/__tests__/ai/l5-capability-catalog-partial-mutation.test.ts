import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { aiService } from '../../ai/ai-service';
import { SystemCapability } from '../../types/cas.types';
import { emptyFlowGraph } from '../helpers/empty-flow-graph';

/**
 * CONSISTENCY-AND-COUNTING defect (2026-08 blackbox audit of a desktop app):
 * a single analysis response served summary.top_capabilities with 6
 * AI-polished names while ai_enrichment:"error", AND product_map.capabilities
 * with 28 raw duplicate-laden entries -- two irreconcilable answers to "how
 * many capabilities does this app have" in the SAME response.
 *
 * Root cause, pinned here: applyAIInterpretation runs the capability-catalog
 * request and the system-description/grounding-gate request as two
 * independent steps within the SAME pass. The catalog reconciliation
 * (systemCapabilities.splice(0, systemCapabilities.length, ...reconciled),
 * orchestrator.ts ~line 12979) commits its AI-polished names into the
 * caller's array IN PLACE, and that splice happens BEFORE the
 * system-description grounding gate has run -- so when the system
 * description later fails to ground and the whole call throws, the
 * capabilities array the caller already held a reference to is left holding
 * the AI-polished names, with no signal that the overall pass failed.
 *
 * Consistency is restored one layer up, in orchestrateAnalysis's
 * deferred-enrichment closure (orchestrator.ts, around
 * `this.deferredAiEnrichments.set(output, async () => { ... })`): it now
 * snapshots the raw pre-AI capabilities before calling applyAIInterpretation
 * (via runAiInterpretation), and on any throw rolls system_capabilities back
 * to that raw snapshot AND rebuilds product_map from the same rolled-back
 * state, so a response with ai_enrichment==='error' never presents
 * AI-polished capability names in one field while another field is stuck on
 * stale raw data. This test documents the underlying partial-mutation
 * mechanism that fix guards against.
 *
 * UPDATE (2026-08 blast-radius audit): that guard is a double-edged sword —
 * catching EVERY throw, including "the system narrative alone failed its
 * grounding gate after every repair", meant the rollback undid an already-
 * good, already-AI-named capability catalog just because one unrelated
 * paragraph could not be grounded (confirmed live: a client-shaped codebase
 * shipped 21 capabilities as raw mechanism names, one visibly garbled, with
 * zero AI comprehension anywhere, even though capability naming had already
 * succeeded). applyAIInterpretation no longer throws for THAT case — see
 * orchestrator.ts's system_description rejection block and
 * EnhancedSystemPurpose.system_description_degradation — so the rollback
 * this file documents now fires only for genuine total failures (the AI
 * provider never answering at all), not for a contained, per-field
 * degradation. Both shapes are asserted below.
 */

const orch = new AnalyzerOrchestrator() as any;

const AI_ENV_KEYS = [
  'OPENAI_API_KEY',
  'KLAURO_AI_INTERPRETATION',
  'KLAURO_AI_INTERPRETATION_FORCE',
  'KLAURO_AI_INTERPRETATION_BUDGET_MS',
  'KLAURO_AI_ELEMENT_DESCRIPTIONS',
];

function withAiEnv<T>(body: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = Object.fromEntries(
    AI_ENV_KEYS.map(key => [key, process.env[key]]),
  );
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.KLAURO_AI_INTERPRETATION = 'true';
  process.env.KLAURO_AI_INTERPRETATION_FORCE = '1';
  delete process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS;
  delete process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS;
  const restore = () => {
    for (const key of AI_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
  return body().then(
    value => { restore(); return value; },
    error => { restore(); throw error; },
  );
}

function rawCapability(id: string, name: string): SystemCapability {
  return {
    id,
    name,
    structural_label: name,
    description: `Handles ${name.toLowerCase()}.`,
    description_source: 'deterministic',
    category: 'core',
    operations: [],
    related_entities: [],
    related_domains: [],
    criticality: 'medium',
    criticality_factors: [],
  } as SystemCapability;
}

function aiCapability(id: string, name: string): SystemCapability {
  return {
    id,
    name,
    name_source: 'ai',
    structural_label: name,
    description: `${name} for the audited product.`,
    description_source: 'ai',
    category: 'core',
    operations: [{ entry_point_id: `entry_${id}`, entry_point_type: 'http', action: name }],
    related_entities: [],
    related_domains: [],
    criticality: 'medium',
    criticality_factors: [],
  } as SystemCapability;
}

function freshPurpose(): any {
  return {
    primary_type: 'developer-tool',
    confidence: 0.9,
    evidence: [],
    primary_domain: '',
    core_concepts: [],
    inferred_description: '',
    supporting_workflow_ids: [],
  };
}

async function runInterpretation(purpose: any, capabilities: SystemCapability[]): Promise<void> {
  await orch.applyAIInterpretation(
    purpose, 'klauro', [], [], [], [], emptyFlowGraph(), [],
    capabilities, [], [], [], { concepts: [], evidence: [] }, [],
    undefined, [], [], [], [],
  );
}

describe('applyAIInterpretation partial mutation on later failure (root cause of the summary/product_map contradiction)', () => {
  it('leaves the capabilities array untouched when the AI PROVIDER itself never answers (genuine total failure — still throws, before any splice happens)', async () => {
    // Bypass the capability-catalog's own network/quality-gate machinery
    // entirely (that machinery is owned elsewhere).
    const catalogSpy = jest.spyOn(orch, 'runCapabilityCatalogWithQualityGate').mockResolvedValue([
      aiCapability('cap_ai_1', 'Manage vehicle fleets'),
      aiCapability('cap_ai_2', 'Monitor driver safety'),
    ]);
    // The system-narrative call is the FIRST AI call the pass makes; make the
    // PROVIDER ITSELF fail (never answers) rather than answer with
    // ungroundable text — that is the one failure class applyAIInterpretation
    // still throws for, because there is genuinely nothing usable from this
    // pass at all. It throws from inside the try/catch that wraps that very
    // first call, which runs BEFORE the catalog result is ever read or
    // spliced in — so there is nothing to roll back here in the first place.
    const descriptionSpy = jest.spyOn(aiService, 'generateComponentDescription').mockRejectedValue(
      new Error('provider outage: model endpoint unreachable'),
    );

    const capabilities: SystemCapability[] = [
      rawCapability('cap_1', 'Vehicle table'),
      rawCapability('cap_2', 'Vehicle table'),
      rawCapability('cap_3', 'Vehicle table'),
      rawCapability('cap_4', 'Driver alerts'),
    ];
    const rawNames = capabilities.map(c => c.name);

    const purpose = freshPurpose();
    let thrown: unknown;
    try {
      await withAiEnv(() => runInterpretation(purpose, capabilities));
    } catch (error) {
      thrown = error;
    } finally {
      catalogSpy.mockRestore();
      descriptionSpy.mockRestore();
    }

    // The pass DID fail overall (the provider never answered at all) --
    // matches the audited response's ai_enrichment:"error".
    expect(thrown).toBeInstanceOf(Error);
    // Nothing was spliced before the throw — the outer deferred-enrichment
    // closure's rollback-to-raw-snapshot is a no-op here, but harmless.
    expect(capabilities.map(c => c.name)).toEqual(rawNames);
  });

  it('does NOT throw, and keeps the AI-polished capability names, when only the system narrative fails its grounding gate (contained degradation — the blast-radius fix)', async () => {
    const catalogSpy = jest.spyOn(orch, 'runCapabilityCatalogWithQualityGate').mockResolvedValue([
      aiCapability('cap_ai_1', 'Manage vehicle fleets'),
      aiCapability('cap_ai_2', 'Monitor driver safety'),
    ]);
    // The provider DOES answer here — with a narrative the grounding gate
    // rejects on every attempt (marketing language, no evidence), and no
    // per-capability prose at all. This is the "AI answered but the answer
    // was ungrounded/incomplete" class, not a provider outage, and it must no
    // longer take the already-reconciled catalog's NAMES with it — even
    // though each capability's own description text still goes through its
    // own independent per-item grounding check (see l5-capability-
    // degradation.test.ts) and may itself degrade to deterministic text.
    const descriptionSpy = jest.spyOn(aiService, 'generateComponentDescription').mockResolvedValue(JSON.stringify({
      system_description: 'A blazing-fast, best-in-class, revolutionary platform that seamlessly empowers everything.',
      domain: '',
      descriptions: [],
      capabilities: [],
    }));

    const capabilities: SystemCapability[] = [
      rawCapability('cap_1', 'Vehicle table'),
      rawCapability('cap_2', 'Vehicle table'),
      rawCapability('cap_3', 'Vehicle table'),
      rawCapability('cap_4', 'Driver alerts'),
    ];

    const purpose = freshPurpose();
    try {
      await withAiEnv(() => runInterpretation(purpose, capabilities));
    } finally {
      catalogSpy.mockRestore();
      descriptionSpy.mockRestore();
    }

    // No fabricated system description ships — the doctrine holds — but the
    // failure is recorded, not silent.
    expect(purpose.inferred_description).toBeFalsy();
    expect(purpose.system_description_degradation).toBeDefined();

    expect(capabilities.map(capability => capability.name)).toEqual([
      'Monitor driver safety',
    ]);
  });
});
