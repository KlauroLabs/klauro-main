import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { aiService } from '../../ai/ai-service';
import { SystemCapability } from '../../types/cas.types';

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
    structural_label: name,
    description: `${name} for the audited product.`,
    description_source: 'ai',
    category: 'core',
    operations: [],
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
    purpose, 'klauro', [], [], [], [], orch.emptyFlowGraph(), [],
    capabilities, [], [], [], { concepts: [], evidence: [] }, [],
    undefined, [], [], [], [],
  );
}

describe('applyAIInterpretation partial mutation on later failure (root cause of the summary/product_map contradiction)', () => {
  it('leaves the capabilities array holding AI-polished names even though the pass as a whole throws', async () => {
    // Bypass the capability-catalog's own network/quality-gate machinery
    // entirely (that machinery is owned elsewhere) and go straight to what
    // matters here: what applyAIInterpretation does with a RECONCILED
    // catalog result once it has one. This is exactly the audited shape --
    // real, non-duplicate, AI-polished capability names.
    const catalogSpy = jest.spyOn(orch, 'runCapabilityCatalogWithQualityGate').mockResolvedValue([
      aiCapability('cap_ai_1', 'Manage vehicle fleets'),
      aiCapability('cap_ai_2', 'Monitor driver safety'),
    ]);
    // The system-description call is a SEPARATE step; make it return an
    // ungroundable narrative so the pass fails downstream of the catalog
    // reconciliation (marketing language the grounding gate rejects).
    const descriptionSpy = jest.spyOn(aiService, 'generateComponentDescription').mockResolvedValue(JSON.stringify({
      system_description: 'A blazing-fast, best-in-class, revolutionary platform that seamlessly empowers everything.',
      domain: '',
      descriptions: [],
      capabilities: [],
    }));

    // Raw/deterministic input capabilities, standing in for the audited
    // response's "28 duplicate-laden" raw catalog -- a smaller, duplicated
    // set is enough to prove the mechanism.
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

    // The pass DID fail overall (system description ungroundable) --
    // matches the audited response's ai_enrichment:"error".
    expect(thrown).toBeInstanceOf(Error);
    expect(String((thrown as Error).message)).toMatch(/system description/i);

    // And yet: the capabilities array the caller already held a reference to
    // was mutated in place with the AI-polished names BEFORE the throw. This
    // is the exact partial-mutation window the orchestrator-level fix (the
    // deferred-enrichment closure's try/catch around runAiInterpretation)
    // detects and rolls back so it never reaches a served response.
    const namesAfterThrow = capabilities.map(c => c.name);
    expect(namesAfterThrow).not.toEqual(rawNames);
    expect(namesAfterThrow).toEqual(['Manage vehicle fleets', 'Monitor driver safety']);
  });
});
