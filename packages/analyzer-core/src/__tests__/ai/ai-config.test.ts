import { getAIConfig } from '../../config/ai.config';

const AI_ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
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

  it('uses an OpenAI-compatible local base URL without requiring a hosted OpenAI key', () => {
    process.env.OPENAI_BASE_URL = 'http://127.0.0.1:1234/v1';
    process.env.OPENAI_MODEL = 'local-model';

    const config = getAIConfig();

    expect(config.openai.baseURL).toBe('http://127.0.0.1:1234/v1');
    expect(config.openai.model).toBe('local-model');
    expect(config.openai.apiKey).toBe('local-openai-compatible');
  });

  it('maps Ollama shorthand to its OpenAI-compatible /v1 endpoint', () => {
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434/';
    process.env.OLLAMA_MODEL = 'llama3.1';

    const config = getAIConfig();

    expect(config.openai.baseURL).toBe('http://127.0.0.1:11434/v1');
    expect(config.openai.model).toBe('llama3.1');
    expect(config.openai.apiKey).toBe('local-openai-compatible');
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
});
