import { DEEPINFRA_OPENAI_BASE_URL, describeConfiguredAIProvider, getAIConfig } from '../../config/ai.config';

const AI_ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENAI_STRUCTURED_MODEL',
  'DEEPINFRA_API_KEY',
  'DEEPINFRA_BASE_URL',
  'DEEPINFRA_MODEL',
  'DEEPINFRA_STRUCTURED_MODEL',
  'LOCAL_OPENAI_BASE_URL',
  'LOCAL_OPENAI_MODEL',
  'LOCAL_OPENAI_API_KEY',
  'OLLAMA_BASE_URL',
  'OLLAMA_MODEL',
  'OLLAMA_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_DEPLOYMENT',
  'AZURE_OPENAI_MODEL',
];

describe('getAIConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    for (const key of AI_ENV_KEYS) delete process.env[key];
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('ignores loopback OpenAI-compatible URLs in product config', () => {
    process.env.OPENAI_BASE_URL = 'http://127.0.0.1:1234/v1';
    process.env.OPENAI_MODEL = 'local-model';

    const config = getAIConfig();
    const provider = describeConfiguredAIProvider();

    expect(config.openai.baseURL).toBeUndefined();
    expect(config.openai.model).toBe('local-model');
    expect(config.openai.apiKey).toBeUndefined();
    expect(provider.provider).toBe('fallback');
    expect(provider.hosted).toBe(false);
  });

  it('does not map Ollama shorthand into the product AI provider path', () => {
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434/';
    process.env.OLLAMA_MODEL = 'llama3.1';

    const config = getAIConfig();
    const provider = describeConfiguredAIProvider();

    expect(config.openai.baseURL).toBeUndefined();
    expect(config.openai.model).toBe('gpt-4o-mini');
    expect(config.openai.apiKey).toBeUndefined();
    expect(provider.provider).toBe('fallback');
  });

  it('does not treat an Azure key alone as a usable OpenAI provider', () => {
    process.env.AZURE_OPENAI_API_KEY = 'azure-key';

    const config = getAIConfig();

    expect(config.openai.apiKey).toBeUndefined();
    expect(config.openai.baseURL).toBeUndefined();
  });

  it('uses Azure OpenAI only when endpoint and deployment are also configured', () => {
    process.env.AZURE_OPENAI_API_KEY = 'azure-key';
    process.env.AZURE_OPENAI_ENDPOINT = 'https://example.openai.azure.com';
    process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-4o-mini-deployment';

    const config = getAIConfig();

    expect(config.openai.apiKey).toBe('azure-key');
    expect(config.openai.model).toBe('gpt-4o-mini-deployment');
  });

  it('maps DeepInfra directly to the OpenAI-compatible provider', () => {
    process.env.DEEPINFRA_API_KEY = 'deepinfra-key';
    process.env.DEEPINFRA_MODEL = 'meta-llama/Meta-Llama-3.3-70B-Instruct';
    process.env.DEEPINFRA_STRUCTURED_MODEL = 'meta-llama/Meta-Llama-3.1-8B-Instruct';

    const config = getAIConfig();
    const provider = describeConfiguredAIProvider();

    expect(config.openai.apiKey).toBe('deepinfra-key');
    expect(config.openai.baseURL).toBe(DEEPINFRA_OPENAI_BASE_URL);
    expect(config.openai.model).toBe('meta-llama/Meta-Llama-3.3-70B-Instruct');
    expect(provider.provider).toBe('deepinfra');
    expect(provider.structuredModel).toBe('meta-llama/Meta-Llama-3.1-8B-Instruct');
    expect(provider.hosted).toBe(true);
  });

  it('recognizes DeepInfra when configured through generic OpenAI-compatible env vars', () => {
    process.env.OPENAI_BASE_URL = DEEPINFRA_OPENAI_BASE_URL;
    process.env.OPENAI_API_KEY = 'deepinfra-key';
    process.env.OPENAI_MODEL = 'Qwen/Qwen2.5-72B-Instruct';

    const provider = describeConfiguredAIProvider();

    expect(provider.provider).toBe('deepinfra');
    expect(provider.baseURL).toBe(DEEPINFRA_OPENAI_BASE_URL);
    expect(provider.model).toBe('Qwen/Qwen2.5-72B-Instruct');
  });
});
