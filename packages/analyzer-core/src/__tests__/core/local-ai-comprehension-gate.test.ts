import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';

const providerEnvironmentKeys = [
  'ANTHROPIC_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_DEPLOYMENT',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_MODEL',
  'DEEPINFRA_API_KEY',
  'KLAURO_AI_PROVIDER_CHAIN',
  'KLAURO_ALLOW_LOCAL_AI',
  'LOCAL_LLM_BASE_URL',
  'LOCAL_LLM_MODEL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
] as const;

describe('local AI comprehension gate', () => {
  const originalEnvironment = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of providerEnvironmentKeys) {
      originalEnvironment.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of providerEnvironmentKeys) {
      const value = originalEnvironment.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    originalEnvironment.clear();
  });

  it('enables comprehension when an explicitly allowed local provider is the only provider', () => {
    process.env.KLAURO_ALLOW_LOCAL_AI = '1';
    process.env.LOCAL_LLM_BASE_URL = 'http://100.64.0.1:11434/v1';
    process.env.LOCAL_LLM_MODEL = 'qwen2.5-coder:14b';
    const orchestrator = new AnalyzerOrchestrator() as any;

    expect(orchestrator.hasAIInterpretationProviderConfigured()).toBe(true);
    expect(orchestrator.configuredAiInterpretationProviders()).toContain('local-llm');
  });

  it('keeps local comprehension disabled without explicit opt-in', () => {
    process.env.LOCAL_LLM_BASE_URL = 'http://100.64.0.1:11434/v1';
    process.env.LOCAL_LLM_MODEL = 'qwen2.5-coder:14b';
    const orchestrator = new AnalyzerOrchestrator() as any;

    expect(orchestrator.hasAIInterpretationProviderConfigured()).toBe(false);
  });
});
