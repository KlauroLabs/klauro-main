import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { aiService, isProviderUnavailableFailure, AI_PROVIDER_UNAVAILABLE_MARKER } from '../../ai/ai-service';
import { SystemCapability } from '../../types/cas.types';

/**
 * P0 (2026-07-27 live comprehension audit): a per-capability grounding
 * rejection must not take the SYSTEM comprehension down with it.
 *
 * On a 27,520-node repository, 2 of 59 capability descriptions failed the
 * grounding validators. applyAIInterpretation threw, which rejected the whole
 * L5 pass, so the stored analysis came back with description null,
 * primary_domain null, product_map.identity.description "" and domain
 * "unknown" — no answer at all to "what is this system", because two sentences
 * somewhere in the catalog used a banned word.
 *
 * The correct blast radius: the offending capability degrades to its
 * deterministic structural description (flagged, never passed off as AI
 * comprehension) and everything else survives. The system NARRATIVE keeps its
 * no-deterministic-substitute doctrine and still fails the analysis when it
 * cannot be grounded — that is asserted here too, so the containment fix cannot
 * quietly turn into "L5 never fails".
 */

const orch = new AnalyzerOrchestrator() as any;

const AI_ENV_KEYS = [
  'OPENAI_API_KEY',
  'KLAURO_AI_INTERPRETATION',
  'KLAURO_AI_INTERPRETATION_FORCE',
  'KLAURO_AI_INTERPRETATION_BUDGET_MS',
  // src/__tests__/setup.ts defaults this to 'false' for the suite; the whole
  // point of these tests is the per-CAPABILITY description pass, so it must be
  // on here.
  'KLAURO_AI_ELEMENT_DESCRIPTIONS',
];

// Four grammatical sentences, product nouns only, no marketing language — the
// shape the system-description gate accepts.
const GROUNDED_SYSTEM_DESCRIPTION =
  'Klauro builds relationship graphs from source repositories so coding agents can reason about a codebase before touching it. '
  + 'It parses code into structural facts and layers comprehension over them, grounding every description in the evidence bundle it gathered. '
  + 'One analysis request yields one stored analysis record for the requested repository. '
  + 'It hands that analysis to agents over a single hosted service.';

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

function capability(id: string, name: string, description: string): SystemCapability {
  return {
    id,
    name,
    structural_label: name,
    description,
    description_source: 'deterministic',
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

describe('L5 capability-description failures are contained (do not null the system comprehension)', () => {
  it('keeps the system description and the deterministic capability text when every capability description is rejected', async () => {
    // The model returns a groundable SYSTEM description but no per-capability
    // prose at all, so every capability target is rejected ('missing-
    // description') and survives the repair pass still rejected. Before the
    // fix this threw and nulled everything.
    const spy = jest.spyOn(aiService, 'generateComponentDescription').mockResolvedValue(JSON.stringify({
      system_description: GROUNDED_SYSTEM_DESCRIPTION,
      domain: '',
      descriptions: [],
      capabilities: [],
    }));
    const purpose = freshPurpose();
    const capabilities = [
      capability('cap_1', 'Analyze source repositories', 'Handles analysis of source repositories.'),
      capability('cap_2', 'Store analysis records', 'Handles storage of analysis records.'),
    ];
    try {
      await withAiEnv(() => runInterpretation(purpose, capabilities));
    } finally {
      spy.mockRestore();
    }

    // The system narrative survived — this is the whole point.
    expect(purpose.inferred_description).toBeTruthy();
    expect(purpose.description_source).toBe('ai');

    // Every rejected capability degraded rather than being blanked, and says so.
    expect(Array.isArray(purpose.capability_description_degradations)).toBe(true);
    expect(purpose.capability_description_degradations.length).toBe(capabilities.length);
    for (const item of purpose.capability_description_degradations) {
      expect(typeof item.reason).toBe('string');
      expect(['provider-unavailable', 'failed-grounding']).toContain(item.failure_class);
    }
    for (const item of capabilities) {
      expect(item.description).toBeTruthy();
      expect(item.description_source).toBe('deterministic');
      // The honesty record must never claim AI comprehension it did not get.
      expect(item.description_generation?.status).toBe('ai_rejected');
      expect(item.description_generation?.reason).toBeTruthy();
    }
  });

  it('still FAILS the analysis when the system description itself cannot be grounded', async () => {
    // The no-deterministic-substitute doctrine for the system narrative is
    // unchanged: containment applies to capabilities only.
    const spy = jest.spyOn(aiService, 'generateComponentDescription').mockResolvedValue(JSON.stringify({
      system_description: 'A blazing-fast, best-in-class, revolutionary platform that seamlessly empowers everything.',
      domain: '',
      descriptions: [],
      capabilities: [],
    }));
    const purpose = freshPurpose();
    let thrown: unknown;
    try {
      await withAiEnv(() => runInterpretation(purpose, [capability('cap_1', 'Analyze source repositories', 'Handles analysis.')]));
    } catch (error) {
      thrown = error;
    } finally {
      spy.mockRestore();
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String((thrown as Error).message)).toMatch(/system description/i);
  });

  it('reports a total provider outage as provider-availability, not as a grounding failure', async () => {
    const spy = jest.spyOn(aiService, 'generateComponentDescription').mockRejectedValue(
      new Error(`${AI_PROVIDER_UNAVAILABLE_MARKER}: all AI providers in the chain failed: deepinfra: timed out | deepinfra-fast-fallback: timed out`),
    );
    const purpose = freshPurpose();
    let thrown: unknown;
    try {
      await withAiEnv(() => runInterpretation(purpose, []));
    } catch (error) {
      thrown = error;
    } finally {
      spy.mockRestore();
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = String((thrown as Error).message);
    expect(message).toMatch(/provider-availability failure, not a grounding failure/);
    expect(message).not.toMatch(/grounding gate/);
  });
});

describe('isProviderUnavailableFailure', () => {
  it('classifies delivery failures as provider-unavailable', () => {
    expect(isProviderUnavailableFailure(`${AI_PROVIDER_UNAVAILABLE_MARKER}: all AI providers in the chain failed`)).toBe(true);
    expect(isProviderUnavailableFailure('request timed out after 30000ms')).toBe(true);
    expect(isProviderUnavailableFailure('HTTP 429 rate limit exceeded')).toBe(true);
    expect(isProviderUnavailableFailure('provider returned empty content')).toBe(true);
    expect(isProviderUnavailableFailure('ECONNRESET')).toBe(true);
  });

  it('does NOT classify a quality-gate rejection as provider-unavailable', () => {
    expect(isProviderUnavailableFailure('unsupported-marketing-language: metrics')).toBe(false);
    expect(isProviderUnavailableFailure('read-only-capability-claims-mutation')).toBe(false);
    expect(isProviderUnavailableFailure('missing-description')).toBe(false);
    expect(isProviderUnavailableFailure(undefined)).toBe(false);
  });
});
