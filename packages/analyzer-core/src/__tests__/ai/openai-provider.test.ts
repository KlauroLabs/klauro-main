import * as http from 'http';
import { getAIConfig } from '../../config/ai.config';
import { OpenAIProvider } from '../../ai/providers/openai-provider';

describe('OpenAIProvider local-compatible endpoint support', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('sends chat completions to a configured OpenAI-compatible base URL', async () => {
    const seen: Array<{ url?: string; authorization?: string }> = [];
    const server = http.createServer((req, res) => {
      seen.push({
        url: req.url,
        authorization: req.headers.authorization,
      });
      req.resume();
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

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP test server');
      process.env.OPENAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
      process.env.OPENAI_MODEL = 'local-test-model';
      process.env.OPENAI_API_KEY = 'local-test-key';

      const provider = new OpenAIProvider(getAIConfig());
      const description = await provider.generateDescription({
        additionalContext: { systemName: 'local-provider-test' },
      });

      expect(description).toBe('This local endpoint generated a grounded test description.');
      expect(seen[0]?.url).toBe('/v1/chat/completions');
      expect(seen[0]?.authorization).toBe('Bearer local-test-key');
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

      const provider = new OpenAIProvider(getAIConfig());
      const description = await provider.generateDescription({
        additionalContext: { systemName: 'ollama-native-test' },
      });

      expect(description).toBe('Ollama generated the grounded description without reasoning output.');
      expect(seen[0]?.url).toBe('/api/chat');
      expect(seen[0]?.body?.think).toBe(false);
      expect(seen[0]?.body?.model).toBe('qwen3:8b');
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

      const provider = new OpenAIProvider(getAIConfig());
      await expect(provider.generateDescription({
        additionalContext: { systemName: 'ollama-timeout-test' },
      })).rejects.toThrow('Ollama request timed out after 20ms');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
