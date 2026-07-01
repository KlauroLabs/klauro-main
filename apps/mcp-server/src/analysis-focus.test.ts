import test from 'node:test';
import assert from 'node:assert/strict';
import { getAnalysisFocusProfiles, recommendAnalysisFocus, withAnalysisFocus } from './analysis-focus';

const focusKeys = [
  'KLAURO_ANALYSIS_FOCUS',
  'KLAURO_AI_INTERPRETATION',
  'KLAURO_AI_INTERPRETATION_FORCE',
  'KLAURO_AI_INTERPRETATION_ALLOW_DETERMINISTIC_KEEP',
  'KLAURO_AI_INTERPRETATION_BUDGET_MS',
  'KLAURO_AI_ELEMENT_DESCRIPTION_BUDGET_MS',
  'KLAURO_AI_ELEMENT_DESCRIPTION_BATCH_SIZE',
  'KLAURO_AI_ELEMENT_DESCRIPTION_LIMIT',
  'KLAURO_AI_ELEMENT_DESCRIPTIONS',
  'KLAURO_EMBEDDING_ENABLED',
  'KLAURO_FULL_REBUILD_ON_CONFIG_CHANGE',
  'OPENAI_MODEL',
] as const;

test('ui-overview focus enables AI enrichment without silently opting into local AI', async () => {
  await withCleanFocusEnv(async () => {
    const seen = await withAnalysisFocus('ui-overview', async () => ({
      focus: process.env.KLAURO_ANALYSIS_FOCUS,
      interpretation: process.env.KLAURO_AI_INTERPRETATION,
      force: process.env.KLAURO_AI_INTERPRETATION_FORCE,
      deterministicKeep: process.env.KLAURO_AI_INTERPRETATION_ALLOW_DETERMINISTIC_KEEP,
      interpretationBudget: process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS,
      elementBudget: process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BUDGET_MS,
      elementBatchSize: process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BATCH_SIZE,
      elementLimit: process.env.KLAURO_AI_ELEMENT_DESCRIPTION_LIMIT,
      elements: process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS,
      embeddings: process.env.KLAURO_EMBEDDING_ENABLED,
    }));

    assert.equal(seen.focus, 'ui-overview');
    assert.equal(seen.interpretation, 'true');
    assert.equal(seen.force, 'true');
    assert.equal(seen.deterministicKeep, 'false');
    assert.equal(seen.interpretationBudget, '45000');
    assert.equal(seen.elementBudget, '90000');
    assert.equal(seen.elementBatchSize, '4');
    assert.equal(seen.elementLimit, '8');
    assert.equal(seen.elements, 'true');
    assert.equal(seen.embeddings, 'false');
  });
});

test('ui-overview focus restores hosted provider env without introducing local model env', async () => {
  await withCleanFocusEnv(async () => {
    process.env.OPENAI_MODEL = 'hosted-model';
    process.env.KLAURO_AI_ELEMENT_DESCRIPTION_LIMIT = '3';

    const seen = await withAnalysisFocus('ui-overview', async () => ({
      model: process.env.OPENAI_MODEL,
      limit: process.env.KLAURO_AI_ELEMENT_DESCRIPTION_LIMIT,
      localModel: process.env.OLLAMA_MODEL,
    }));

    assert.equal(seen.model, 'hosted-model');
    assert.equal(seen.limit, '3');
    assert.equal(seen.localModel, undefined);
    assert.equal(process.env.OPENAI_MODEL, 'hosted-model');
    assert.equal(process.env.KLAURO_AI_ELEMENT_DESCRIPTION_LIMIT, '3');
  });
});

test('agent-fast focus keeps required AI summary and capability enrichment without auto-starting local AI', async () => {
  await withCleanFocusEnv(async () => {
    const seen = await withAnalysisFocus('agent-fast', async () => ({
      focus: process.env.KLAURO_ANALYSIS_FOCUS,
      interpretation: process.env.KLAURO_AI_INTERPRETATION,
      force: process.env.KLAURO_AI_INTERPRETATION_FORCE,
      deterministicKeep: process.env.KLAURO_AI_INTERPRETATION_ALLOW_DETERMINISTIC_KEEP,
      interpretationBudget: process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS,
      elementLimit: process.env.KLAURO_AI_ELEMENT_DESCRIPTION_LIMIT,
      elementBatchSize: process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BATCH_SIZE,
      elements: process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS,
      embeddings: process.env.KLAURO_EMBEDDING_ENABLED,
      excludeLegacy: process.env.KLAURO_AGENT_FAST_EXCLUDE_LEGACY,
      fullRebuildOnConfig: process.env.KLAURO_FULL_REBUILD_ON_CONFIG_CHANGE,
    }));

    assert.equal(seen.focus, 'agent-fast');
    assert.equal(seen.interpretation, 'true');
    assert.equal(seen.force, 'true');
    assert.equal(seen.deterministicKeep, 'false');
    assert.equal(seen.interpretationBudget, '30000');
    assert.equal(seen.elements, 'true');
    assert.equal(seen.elementLimit, '8');
    assert.equal(seen.elementBatchSize, '4');
    assert.equal(seen.embeddings, 'false');
    assert.equal(seen.excludeLegacy, 'true');
    assert.equal(seen.fullRebuildOnConfig, 'false');
  });
});

test('deep-context focus enables semantic depth without bulk element descriptions', async () => {
  await withCleanFocusEnv(async () => {
    const seen = await withAnalysisFocus('deep-context', async () => ({
      focus: process.env.KLAURO_ANALYSIS_FOCUS,
      interpretation: process.env.KLAURO_AI_INTERPRETATION,
      force: process.env.KLAURO_AI_INTERPRETATION_FORCE,
      deterministicKeep: process.env.KLAURO_AI_INTERPRETATION_ALLOW_DETERMINISTIC_KEEP,
      interpretationBudget: process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS,
      elementLimit: process.env.KLAURO_AI_ELEMENT_DESCRIPTION_LIMIT,
      elements: process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS,
      embeddings: process.env.KLAURO_EMBEDDING_ENABLED,
    }));

    assert.equal(seen.focus, 'deep-context');
    assert.equal(seen.interpretation, 'true');
    assert.equal(seen.force, 'false');
    assert.equal(seen.deterministicKeep, 'false');
    assert.equal(seen.interpretationBudget, '60000');
    assert.equal(seen.elementLimit, '8');
    assert.equal(seen.elements, 'true');
    assert.equal(seen.embeddings, 'true');
  });
});

test('focus recommendation defaults MCP coding work to agent-fast', () => {
  const result = getAnalysisFocusProfiles({ trigger: 'mcp', taskType: 'modify' });

  assert.equal(result.recommendation.recommended_focus, 'agent-fast');
  assert.equal(result.recommendation.recommended_layer, 'agent-fast-refresh');
  assert.equal(result.recommendation.token_policy, 'minimize-first-turn');
  assert.ok(result.profiles.find(profile => profile.focus === 'agent-fast')?.produces.includes('AI-written system narrative'));
  assert.ok(result.recommendation.deferred_until_needed.includes('lazy AI entity/flow/node descriptions'));
  assert.ok(result.profiles.some(profile => profile.focus === 'ui-overview'));
});

test('focus recommendation routes human description work to ui-overview', () => {
  const result = recommendAnalysisFocus({ trigger: 'manual-description', taskType: 'describe entity' });

  assert.equal(result.recommended_focus, 'ui-overview');
  assert.equal(result.recommended_layer, 'ui-overview-refresh');
  assert.equal(result.token_policy, 'spend-on-human-narrative');
});

test('focus recommendation routes runtime and audit work to deep-context', () => {
  const runtime = recommendAnalysisFocus({ trigger: 'runtime' });
  const audit = recommendAnalysisFocus({ trigger: 'mcp', taskType: 'architecture audit' });

  assert.equal(runtime.recommended_focus, 'deep-context');
  assert.equal(audit.recommended_focus, 'deep-context');
  assert.equal(audit.recommended_layer, 'deep-context-refresh');
});

async function withCleanFocusEnv(run: () => Promise<void>): Promise<void> {
  const previous = Object.fromEntries(focusKeys.map(key => [key, process.env[key]]));
  for (const key of focusKeys) delete process.env[key];
  try {
    await run();
  } finally {
    for (const key of focusKeys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
