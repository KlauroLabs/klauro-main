import * as http from 'http';
import { getAIConfig } from '../../config/ai.config';
import { OpenAIProvider } from '../../ai/providers/openai-provider';

describe('OpenAIProvider compatible endpoint support', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('sends chat completions to a configured OpenAI-compatible base URL', async () => {
    const seen: Array<{ url?: string; authorization?: string; body?: any }> = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        seen.push({
          url: req.url,
          authorization: req.headers.authorization,
          body: raw ? JSON.parse(raw) : undefined,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-local-test',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'local-test-model',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: 'This local endpoint generated a grounded test description.',
            },
            finish_reason: 'stop',
          }],
        }));
      });
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP test server');
      const config = getAIConfig();
      config.openai.baseURL = `http://127.0.0.1:${address.port}/v1`;
      config.openai.model = 'local-test-model';
      config.openai.apiKey = 'local-test-key';
      config.openai.temperature = 0;

      const provider = new OpenAIProvider(config);
      const description = await provider.generateDescription({
        additionalContext: { systemName: 'local-provider-test' },
      });

      expect(description).toBe('This local endpoint generated a grounded test description.');
      expect(seen[0]?.url).toBe('/v1/chat/completions');
      expect(seen[0]?.authorization).toBe('Bearer local-test-key');
      expect(seen[0]?.body?.temperature).toBe(0);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('labels DeepInfra as the selected OpenAI-compatible provider', () => {
    process.env.DEEPINFRA_API_KEY = 'deepinfra-key';
    process.env.DEEPINFRA_MODEL = 'meta-llama/Meta-Llama-3.3-70B-Instruct';

    const provider = new OpenAIProvider(getAIConfig());

    expect(provider.name).toBe('deepinfra');
  });

  it('honors request-specific timeout and retry controls', async () => {
    let requests = 0;
    const server = http.createServer((req, res) => {
      requests += 1;
      req.resume();
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-timeout-override',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'local-test-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'completed' }, finish_reason: 'stop' }],
        }));
      }, 40);
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP test server');
      const config = getAIConfig();
      config.openai.baseURL = `http://127.0.0.1:${address.port}/v1`;
      config.openai.model = 'local-test-model';
      config.openai.apiKey = 'local-test-key';
      config.openai.timeout = 10;
      config.openai.maxRetries = 3;

      const provider = new OpenAIProvider(config);
      const description = await provider.generateDescription({
        additionalContext: { requestTimeoutMs: 100, requestRetries: 0 },
      });

      expect(description).toBe('completed');
      expect(requests).toBe(1);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('uses Ollama native chat with thinking disabled when OLLAMA_BASE_URL is configured', async () => {
    const seen: Array<{ url?: string; body?: any }> = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        seen.push({
          url: req.url,
          body: raw ? JSON.parse(raw) : undefined,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          model: 'qwen3:8b',
          created_at: new Date().toISOString(),
          message: {
            role: 'assistant',
            content: 'Ollama generated the grounded description without reasoning output.',
          },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 12,
          eval_count: 8,
        }));
      });
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP test server');
      process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${address.port}`;
      process.env.OLLAMA_MODEL = 'qwen3:8b';
      const config = getAIConfig();
      config.openai.apiKey = 'explicit-self-hosted-test-key';
      config.openai.baseURL = `http://127.0.0.1:${address.port}/v1`;
      config.openai.model = 'qwen3:8b';

      const provider = new OpenAIProvider(config);
      const description = await provider.generateDescription({
        additionalContext: { systemName: 'ollama-native-test' },
      });

      expect(description).toBe('Ollama generated the grounded description without reasoning output.');
      expect(seen[0]?.url).toBe('/api/chat');
      expect(seen[0]?.body?.think).toBe(false);
      expect(seen[0]?.body?.model).toBe('qwen3:8b');
      expect(seen[0]?.body?.options?.num_ctx).toBe(10512);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('honors an explicit Ollama context window', async () => {
    let requestBody: any;
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        requestBody = JSON.parse(raw);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: { role: 'assistant', content: 'bounded' }, done: true }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP test server');
      process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${address.port}`;
      process.env.OLLAMA_NUM_CTX = '32768';
      const config = getAIConfig();
      config.openai.apiKey = 'local';
      config.openai.baseURL = `http://127.0.0.1:${address.port}/v1`;
      config.openai.model = 'local-model';
      await new OpenAIProvider(config).generateDescription({ additionalContext: { maxTokens: 900 } });
      expect(requestBody.options.num_ctx).toBe(32768);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('surfaces native Ollama errors returned with a successful HTTP status', async () => {
    const server = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'model runner stopped unexpectedly' }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP test server');
      process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${address.port}`;
      const config = getAIConfig();
      config.openai.apiKey = 'local';
      config.openai.baseURL = `http://127.0.0.1:${address.port}/v1`;
      config.openai.model = 'local-model';
      config.openai.maxRetries = 0;
      await expect(new OpenAIProvider(config).generateDescription({
        additionalContext: { requestRetries: 0 },
      })).rejects.toThrow('model runner stopped unexpectedly');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('surfaces native Ollama completion diagnostics when the response is empty', async () => {
    const server = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        message: { role: 'assistant', content: '' },
        done: true,
        done_reason: 'length',
        prompt_eval_count: 16384,
        eval_count: 0,
      }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP test server');
      process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${address.port}`;
      const config = getAIConfig();
      config.openai.apiKey = 'local';
      config.openai.baseURL = `http://127.0.0.1:${address.port}/v1`;
      config.openai.model = 'local-model';
      config.openai.maxRetries = 0;
      await expect(new OpenAIProvider(config).generateDescription({
        additionalContext: { requestRetries: 0 },
      })).rejects.toThrow('Ollama returned no content (done_reason=length, prompt_tokens=16384, completion_tokens=0)');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('times out native Ollama requests instead of hanging analysis', async () => {
    const server = http.createServer((req, _res) => {
      req.resume();
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP test server');
      process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${address.port}`;
      process.env.OLLAMA_MODEL = 'qwen3:8b';
      process.env.KLAURO_OLLAMA_TIMEOUT_MS = '20';
      process.env.AI_MAX_RETRIES = '0';
      const config = getAIConfig();
      config.openai.apiKey = 'explicit-self-hosted-test-key';
      config.openai.baseURL = `http://127.0.0.1:${address.port}/v1`;
      config.openai.model = 'qwen3:8b';
      config.openai.maxRetries = 0;

      const provider = new OpenAIProvider(config);
      await expect(provider.generateDescription({
        additionalContext: { systemName: 'ollama-timeout-test' },
      })).rejects.toThrow('Ollama request timed out after 20ms');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
