import { AIService, aiService, AIAnalysisContext } from '../../ai/ai-service';

// generateCacheKey is private; reached via a typed `any` handle.
const svc = aiService as any;

describe('AIService.generateCacheKey', () => {
  it('is stable for an identical context', () => {
    const ctx: AIAnalysisContext = { additionalContext: { systemName: 'alpha' } };
    expect(svc.generateCacheKey('description', ctx)).toBe(
      svc.generateCacheKey('description', ctx),
    );
  });

  it('differs when additionalContext differs', () => {
    const a: AIAnalysisContext = { additionalContext: { systemName: 'alpha' } };
    const b: AIAnalysisContext = { additionalContext: { systemName: 'beta' } };
    expect(svc.generateCacheKey('description', a)).not.toBe(
      svc.generateCacheKey('description', b),
    );
  });

  it('does not collide for two structural-fact contexts (the cross-repo leak bug)', () => {
    // Both contexts have no component and no code — before the fix they both
    // collapsed onto "description:global:unknown:unknown".
    const repoA: AIAnalysisContext = {
      additionalContext: { systemName: 'cleanmusic', frameworks: ['FastAPI'] },
    };
    const repoB: AIAnalysisContext = {
      additionalContext: { systemName: 'bundler', frameworks: ['Python'] },
    };
    expect(svc.generateCacheKey('description', repoA)).not.toBe(
      svc.generateCacheKey('description', repoB),
    );
  });

  it('differs by operation', () => {
    const ctx: AIAnalysisContext = { additionalContext: { systemName: 'alpha' } };
    expect(svc.generateCacheKey('description', ctx)).not.toBe(
      svc.generateCacheKey('risk', ctx),
    );
  });
});

describe('AIService provider-chain model routing', () => {
  it('uses the chain entry model when an unscoped model hint belongs to another provider', async () => {
    let receivedModel = '';
    const service = Object.create(AIService.prototype) as any;
    service.providerChain = [{
      entry: {
        name: 'local-llm',
        baseURL: 'http://100.64.0.1:11434/v1',
        apiKey: 'local',
        model: 'qwen2.5-coder:14b',
        structuredModel: 'qwen2.5-coder:14b',
      },
      provider: {
        generateDescription: async (context: AIAnalysisContext) => {
          receivedModel = String(context.additionalContext?.model || '');
          return '{"capabilities":[]}';
        },
      },
    }];
    service.updateUsageStats = () => undefined;
    service.logger = { info: () => undefined, warn: () => undefined };

    await service.generateDescriptionViaChain({
      additionalContext: {
        model: 'mistralai/Mistral-Small-3.2-24B-Instruct-2506',
        responseFormat: 'json',
      },
    });

    expect(receivedModel).toBe('qwen2.5-coder:14b');
  });
});
