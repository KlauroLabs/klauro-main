import { z } from 'zod';

const AIConfigSchema = z.object({
  openai: z.object({
    apiKey: z.string().optional(),
    organization: z.string().optional(),
    baseURL: z.string().optional(),
    model: z.string().default('gpt-4o-mini'),
    maxTokens: z.number().default(2000),
    temperature: z.number().default(0.3),
    timeout: z.number().default(30000),
    maxRetries: z.number().default(3),
    rateLimit: z.object({
      requestsPerMinute: z.number().default(50),
      tokensPerMinute: z.number().default(40000),
    }),
  }),
  
  anthropic: z.object({
    apiKey: z.string().optional(),
    model: z.string().default('claude-3-haiku-20240307'),
    maxTokens: z.number().default(2000),
    temperature: z.number().default(0.3),
    timeout: z.number().default(30000),
    maxRetries: z.number().default(3),
    rateLimit: z.object({
      requestsPerMinute: z.number().default(50),
      tokensPerMinute: z.number().default(100000),
    }),
  }),
  
  huggingface: z.object({
    apiKey: z.string().optional(),
    model: z.string().default('microsoft/codebert-base'),
    endpoint: z.string().default('https://api-inference.huggingface.co'),
    timeout: z.number().default(30000),
    maxRetries: z.number().default(3),
  }),

  cache: z.object({
    enabled: z.boolean().default(true),
    ttl: z.number().default(86400), // 24 hours in seconds
    maxSize: z.number().default(1000), // Maximum cached items
    redis: z.object({
      host: z.string().default('localhost'),
      port: z.number().default(6379),
      password: z.string().optional(),
      db: z.number().default(1),
      keyPrefix: z.string().default('ai:cache:'),
    }),
  }),
  
  costTracking: z.object({
    enabled: z.boolean().default(true),
    maxDailyCost: z.number().default(10), // USD
    maxMonthlyCost: z.number().default(100), // USD
    alertThreshold: z.number().default(0.8), // Alert at 80% of limit
    pricing: z.object({
      openai: z.object({
        'gpt-4': z.object({
          input: z.number().default(0.03), // per 1K tokens
          output: z.number().default(0.06),
        }),
        'gpt-4o': z.object({
          input: z.number().default(0.005),
          output: z.number().default(0.015),
        }),
        'gpt-4o-mini': z.object({
          input: z.number().default(0.00015),
          output: z.number().default(0.0006),
        }),
        'gpt-3.5-turbo': z.object({
          input: z.number().default(0.0005),
          output: z.number().default(0.0015),
        }),
      }),
      anthropic: z.object({
        'claude-3-opus-20240229': z.object({
          input: z.number().default(0.015),
          output: z.number().default(0.075),
        }),
        'claude-3-sonnet-20240229': z.object({
          input: z.number().default(0.003),
          output: z.number().default(0.015),
        }),
        'claude-3-haiku-20240307': z.object({
          input: z.number().default(0.00025),
          output: z.number().default(0.00125),
        }),
      }),
    }),
  }),
  
  features: z.object({
    codeAnalysis: z.boolean().default(true),
    naturalLanguageDescriptions: z.boolean().default(true),
    riskAssessment: z.boolean().default(true),
    architecturalRecommendations: z.boolean().default(true),
    securityAnalysis: z.boolean().default(true),
    performanceAnalysis: z.boolean().default(true),
    testSuggestions: z.boolean().default(false),
    documentationGeneration: z.boolean().default(false),
  }),
  
  fallback: z.object({
    enabled: z.boolean().default(true),
    strategy: z.enum(['cascade', 'loadbalance', 'failover']).default('cascade'),
    providers: z.array(z.enum(['openai', 'claude', 'fallback'])).default(['openai', 'claude', 'fallback']),
  }),
  
  prompts: z.object({
    maxContextLength: z.number().default(8000),
    includeCodeContext: z.boolean().default(true),
    includeArchitectureContext: z.boolean().default(true),
    responseFormat: z.enum(['json', 'markdown', 'structured']).default('structured'),
  }),
});

export type AIConfig = z.infer<typeof AIConfigSchema>;

export const DEEPINFRA_OPENAI_BASE_URL = 'https://api.deepinfra.com/v1/openai';

// Cheap, valid default for the DeepInfra endpoint the product uses. Replaces stale
// defaults (Meta-Llama-3.3-70B-Instruct, which DeepInfra 404s) and the gpt-4o-mini
// fallback that a DeepInfra base URL would otherwise resolve to. ~$0.02–0.05/Mtok.
export const DEFAULT_DEEPINFRA_MODEL = 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo';

function hasAzureOpenAIConfig(): boolean {
  return Boolean(
    process.env.AZURE_OPENAI_API_KEY &&
    process.env.AZURE_OPENAI_ENDPOINT &&
    (process.env.AZURE_OPENAI_DEPLOYMENT || process.env.AZURE_OPENAI_MODEL)
  );
}

function hasDeepInfraConfig(): boolean {
  return Boolean(process.env.DEEPINFRA_API_KEY);
}

function isLoopbackUrl(value?: string): boolean {
  return Boolean(value && /(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])/i.test(value));
}

function localOpenAIBaseURL(): string | undefined {
  if (hasDeepInfraConfig()) return process.env.DEEPINFRA_BASE_URL || DEEPINFRA_OPENAI_BASE_URL;
  const explicit = process.env.OPENAI_BASE_URL;
  if (explicit && !isLoopbackUrl(explicit)) return explicit;
  return undefined;
}

export function describeConfiguredAIProvider(env: NodeJS.ProcessEnv = process.env): {
  provider: 'deepinfra' | 'azure-openai' | 'openai-compatible' | 'openai' | 'anthropic' | 'fallback';
  baseURL?: string;
  model?: string;
  structuredModel?: string;
  hosted: boolean;
} {
  if (env.DEEPINFRA_API_KEY) {
    return {
      provider: 'deepinfra',
      baseURL: env.DEEPINFRA_BASE_URL || DEEPINFRA_OPENAI_BASE_URL,
      model: env.DEEPINFRA_MODEL || env.OPENAI_MODEL || DEFAULT_DEEPINFRA_MODEL,
      structuredModel: env.DEEPINFRA_STRUCTURED_MODEL || env.OPENAI_STRUCTURED_MODEL || DEFAULT_DEEPINFRA_MODEL,
      hosted: true,
    };
  }
  if (env.AZURE_OPENAI_API_KEY && env.AZURE_OPENAI_ENDPOINT && (env.AZURE_OPENAI_DEPLOYMENT || env.AZURE_OPENAI_MODEL)) {
    return {
      provider: 'azure-openai',
      baseURL: env.AZURE_OPENAI_ENDPOINT,
      model: env.AZURE_OPENAI_DEPLOYMENT || env.AZURE_OPENAI_MODEL,
      structuredModel: env.OPENAI_STRUCTURED_MODEL,
      hosted: true,
    };
  }
  if (env.OPENAI_BASE_URL && !isLoopbackUrl(env.OPENAI_BASE_URL)) {
    const isDeepInfra = /deepinfra\.com/i.test(env.OPENAI_BASE_URL);
    return {
      provider: isDeepInfra ? 'deepinfra' : 'openai-compatible',
      baseURL: env.OPENAI_BASE_URL,
      // A DeepInfra base URL must never fall through to gpt-4o-mini (404 there).
      model: env.OPENAI_MODEL || (isDeepInfra ? DEFAULT_DEEPINFRA_MODEL : undefined),
      structuredModel: env.OPENAI_STRUCTURED_MODEL || (isDeepInfra ? DEFAULT_DEEPINFRA_MODEL : undefined),
      hosted: true,
    };
  }
  if (env.OPENAI_API_KEY) {
    return {
      provider: 'openai',
      model: env.OPENAI_MODEL || 'gpt-4o-mini',
      structuredModel: env.OPENAI_STRUCTURED_MODEL,
      hosted: true,
    };
  }
  if (env.ANTHROPIC_API_KEY) {
    return {
      provider: 'anthropic',
      model: env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307',
      hosted: true,
    };
  }
  return { provider: 'fallback', hosted: false };
}

function defaultRequestTimeoutMs(): string {
  // Hosted 70B catalog/narrative calls send a large fact bundle and return
  // structured JSON; a 30s timeout was below real latency, so the SDK aborted and
  // burned its retry budget (3 x 30s) before any result. 90s lets one attempt
  // finish even on a slow shared-inference moment (the catalog race budget is 75s,
  // so this never cuts a call the race would otherwise allow to finish).
  return '90000';
}

export function getAIConfig(): AIConfig {
  const openAICompatibleBaseURL = localOpenAIBaseURL();
  const config = {
    openai: {
      apiKey: process.env.OPENAI_API_KEY ||
        (hasDeepInfraConfig() ? process.env.DEEPINFRA_API_KEY : undefined) ||
        (hasAzureOpenAIConfig() ? process.env.AZURE_OPENAI_API_KEY : undefined),
      organization: process.env.OPENAI_ORGANIZATION,
      baseURL: openAICompatibleBaseURL,
      model: process.env.OPENAI_MODEL ||
        process.env.DEEPINFRA_MODEL ||
        process.env.AZURE_OPENAI_DEPLOYMENT ||
        process.env.AZURE_OPENAI_MODEL ||
        // When the endpoint is DeepInfra (the product's hosted provider), a cheap
        // VALID model — never gpt-4o-mini, which 404s there. Only fall back to
        // gpt-4o-mini for genuine OpenAI.
        (hasDeepInfraConfig() || (openAICompatibleBaseURL && /deepinfra/i.test(openAICompatibleBaseURL))
          ? DEFAULT_DEEPINFRA_MODEL
          : 'gpt-4o-mini'),
      maxTokens: parseInt(process.env.OPENAI_MAX_TOKENS || '2000'),
      // Klauro interprets/extracts from deterministic facts — determinism is
      // always desired. temp 0 dramatically stabilizes structured capability
      // extraction/merge (high-temp samples leak routes, vary wrapper keys, and
      // make the merge fall back). Override with OPENAI_TEMPERATURE if needed.
      temperature: parseFloat(process.env.OPENAI_TEMPERATURE || '0'),
      timeout: parseInt(process.env.AI_TIMEOUT || defaultRequestTimeoutMs()),
      maxRetries: parseInt(process.env.AI_MAX_RETRIES || '3'),
      rateLimit: {
        requestsPerMinute: parseInt(process.env.OPENAI_RATE_LIMIT_RPM || '50'),
        tokensPerMinute: parseInt(process.env.OPENAI_RATE_LIMIT_TPM || '40000'),
      },
    },
    
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307',
      maxTokens: parseInt(process.env.ANTHROPIC_MAX_TOKENS || '2000'),
      temperature: parseFloat(process.env.ANTHROPIC_TEMPERATURE || '0.3'),
      timeout: parseInt(process.env.AI_TIMEOUT || '30000'),
      maxRetries: parseInt(process.env.AI_MAX_RETRIES || '3'),
      rateLimit: {
        requestsPerMinute: parseInt(process.env.ANTHROPIC_RATE_LIMIT_RPM || '50'),
        tokensPerMinute: parseInt(process.env.ANTHROPIC_RATE_LIMIT_TPM || '100000'),
      },
    },
    
    huggingface: {
      apiKey: process.env.HUGGINGFACE_API_KEY,
      model: process.env.HUGGINGFACE_MODEL || 'microsoft/codebert-base',
      endpoint: process.env.HUGGINGFACE_ENDPOINT || 'https://api-inference.huggingface.co',
      timeout: parseInt(process.env.AI_TIMEOUT || '30000'),
      maxRetries: parseInt(process.env.AI_MAX_RETRIES || '3'),
    },

    cache: {
      enabled: process.env.AI_CACHE_ENABLED !== 'false',
      ttl: parseInt(process.env.AI_CACHE_TTL || '86400'),
      maxSize: parseInt(process.env.AI_CACHE_MAX_SIZE || '1000'),
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        password: process.env.REDIS_PASSWORD,
        db: parseInt(process.env.REDIS_DB || '1'),
        keyPrefix: process.env.AI_CACHE_PREFIX || 'ai:cache:',
      },
    },
    
    costTracking: {
      enabled: process.env.AI_COST_TRACKING_ENABLED !== 'false',
      maxDailyCost: parseFloat(process.env.AI_MAX_DAILY_COST || '10'),
      maxMonthlyCost: parseFloat(process.env.AI_MAX_MONTHLY_COST || '100'),
      alertThreshold: parseFloat(process.env.AI_COST_ALERT_THRESHOLD || '0.8'),
      pricing: {
        openai: {
          'gpt-4': {
            input: 0.03,
            output: 0.06,
          },
          'gpt-4o': {
            input: 0.005,
            output: 0.015,
          },
          'gpt-4o-mini': {
            input: 0.00015,
            output: 0.0006,
          },
          'gpt-3.5-turbo': {
            input: 0.0005,
            output: 0.0015,
          },
        },
        anthropic: {
          'claude-3-opus-20240229': {
            input: 0.015,
            output: 0.075,
          },
          'claude-3-sonnet-20240229': {
            input: 0.003,
            output: 0.015,
          },
          'claude-3-haiku-20240307': {
            input: 0.00025,
            output: 0.00125,
          },
        },
      },
    },
    
    features: {
      codeAnalysis: process.env.AI_FEATURE_CODE_ANALYSIS !== 'false',
      naturalLanguageDescriptions: process.env.AI_FEATURE_NL_DESCRIPTIONS !== 'false',
      riskAssessment: process.env.AI_FEATURE_RISK_ASSESSMENT !== 'false',
      architecturalRecommendations: process.env.AI_FEATURE_ARCH_RECOMMENDATIONS !== 'false',
      securityAnalysis: process.env.AI_FEATURE_SECURITY_ANALYSIS !== 'false',
      performanceAnalysis: process.env.AI_FEATURE_PERFORMANCE_ANALYSIS !== 'false',
      testSuggestions: process.env.AI_FEATURE_TEST_SUGGESTIONS === 'true',
      documentationGeneration: process.env.AI_FEATURE_DOC_GENERATION === 'true',
    },
    
    fallback: {
      enabled: process.env.AI_FALLBACK_ENABLED !== 'false',
      strategy: (process.env.AI_FALLBACK_STRATEGY as any) || 'cascade',
      providers: (process.env.AI_FALLBACK_PROVIDERS?.split(',') as any[]) || ['openai', 'claude', 'fallback'],
    },
    
    prompts: {
      maxContextLength: parseInt(process.env.AI_MAX_CONTEXT_LENGTH || '8000'),
      includeCodeContext: process.env.AI_INCLUDE_CODE_CONTEXT !== 'false',
      includeArchitectureContext: process.env.AI_INCLUDE_ARCH_CONTEXT !== 'false',
      responseFormat: (process.env.AI_RESPONSE_FORMAT as any) || 'structured',
    },
  };
  
  return AIConfigSchema.parse(config);
}

export const aiConfig = getAIConfig();

/**
 * One entry in the ordered AI provider fallback chain. Each is an
 * OpenAI-compatible endpoint tried in order; on error / 429 / empty content the
 * next is tried, so a slow-or-rate-limited provider never causes L5 comprehension
 * to silently skip.
 */
export interface AIProviderChainEntry {
  name: string;
  baseURL: string;
  apiKey: string;
  model: string;
  structuredModel?: string;
  /** Reasoning models (e.g. OpenRouter hy3) burn output budget on hidden
   * reasoning tokens and return empty content unless given generous room. */
  maxTokens?: number;
}

/**
 * Build the ordered provider fallback chain. Priority:
 *   1. KLAURO_AI_PROVIDER_CHAIN — a JSON array of
 *      {name?, base_url, key_env?|api_key?, model, structured_model?, max_tokens?}
 *      giving explicit, ordered control (DeepInfra -> local Mac -> OpenRouter).
 *   2. Otherwise a sensible default chain from the discrete env vars:
 *      DeepInfra (primary) -> optional local LLM (LOCAL_LLM_BASE_URL) ->
 *      OpenRouter (OPENROUTER_API_KEY, reasoning-safe max_tokens).
 * Entries missing a base URL or resolvable key are dropped. Returns [] when
 * nothing is configured (the caller then uses its single-provider path).
 */
export function getAIProviderChain(env: NodeJS.ProcessEnv = process.env): AIProviderChainEntry[] {
  const resolveKey = (spec: { key_env?: string; api_key?: string }): string | undefined => {
    if (spec.api_key) return spec.api_key;
    if (spec.key_env && env[spec.key_env]) return env[spec.key_env];
    return undefined;
  };

  // 1) Explicit JSON chain.
  if (env.KLAURO_AI_PROVIDER_CHAIN) {
    try {
      const parsed = JSON.parse(env.KLAURO_AI_PROVIDER_CHAIN);
      if (Array.isArray(parsed)) {
        const chain: AIProviderChainEntry[] = [];
        for (const raw of parsed) {
          const baseURL = raw.base_url || raw.baseURL;
          const model = raw.model;
          const apiKey = resolveKey(raw) || 'local';
          if (!baseURL || !model) continue;
          chain.push({
            name: raw.name || new URL(baseURL).hostname,
            baseURL,
            apiKey,
            model,
            structuredModel: raw.structured_model || raw.structuredModel || model,
            maxTokens: raw.max_tokens ?? raw.maxTokens,
          });
        }
        if (chain.length) return chain;
      }
    } catch {
      // fall through to the default chain on malformed JSON
    }
  }

  // 2) Default chain from discrete env vars.
  const chain: AIProviderChainEntry[] = [];

  // Primary: DeepInfra (cheap hosted 70B, no reasoning-token overhead).
  if (env.DEEPINFRA_API_KEY) {
    chain.push({
      name: 'deepinfra',
      baseURL: env.DEEPINFRA_BASE_URL || DEEPINFRA_OPENAI_BASE_URL,
      apiKey: env.DEEPINFRA_API_KEY,
      model: env.DEEPINFRA_MODEL || DEFAULT_DEEPINFRA_MODEL,
      structuredModel: env.DEEPINFRA_STRUCTURED_MODEL || env.DEEPINFRA_MODEL || DEFAULT_DEEPINFRA_MODEL,
    });
  }

  // Secondary (optional): a local LLM (e.g. a dedicated Mac over Tailscale).
  // Slotted in only when its base URL is set; skipped otherwise.
  if (env.LOCAL_LLM_BASE_URL) {
    chain.push({
      name: 'local-llm',
      baseURL: env.LOCAL_LLM_BASE_URL,
      apiKey: (env.LOCAL_LLM_API_KEY && env.LOCAL_LLM_API_KEY) || 'local',
      model: env.LOCAL_LLM_MODEL || 'qwen2.5:7b-instruct',
      structuredModel: env.LOCAL_LLM_STRUCTURED_MODEL || env.LOCAL_LLM_MODEL || 'qwen2.5:7b-instruct',
      maxTokens: env.LOCAL_LLM_MAX_TOKENS ? parseInt(env.LOCAL_LLM_MAX_TOKENS) : undefined,
    });
  }

  // Fallback: OpenRouter free model. hy3 is a reasoning model, so it needs a
  // generous max_tokens or it returns empty content (which the loop treats as a
  // provider failure and would otherwise thrash).
  if (env.OPENROUTER_API_KEY) {
    chain.push({
      name: 'openrouter',
      baseURL: env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      apiKey: env.OPENROUTER_API_KEY,
      model: env.OPENROUTER_MODEL || 'tencent/hy3:free',
      structuredModel: env.OPENROUTER_STRUCTURED_MODEL || env.OPENROUTER_MODEL || 'tencent/hy3:free',
      maxTokens: env.OPENROUTER_MAX_TOKENS ? parseInt(env.OPENROUTER_MAX_TOKENS) : 4000,
    });
  }

  return chain;
}
