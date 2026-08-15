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
    ttl: z.number().default(86400),
    maxSize: z.number().default(1000),
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
    maxDailyCost: z.number().default(10),
    maxMonthlyCost: z.number().default(100),
    alertThreshold: z.number().default(0.8),
    pricing: z.object({
      openai: z.object({
        'gpt-4': z.object({
          input: z.number().default(0.03),
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




export const DEFAULT_DEEPINFRA_MODEL = 'mistralai/Mistral-Small-3.2-24B-Instruct-2506';

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




  return '30000';
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



        (hasDeepInfraConfig() || (openAICompatibleBaseURL && /deepinfra/i.test(openAICompatibleBaseURL))
          ? DEFAULT_DEEPINFRA_MODEL
          : 'gpt-4o-mini'),
      maxTokens: parseInt(process.env.OPENAI_MAX_TOKENS || '2000'),




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







export interface AIProviderChainEntry {
  name: string;
  baseURL: string;
  apiKey: string;
  model: string;
  structuredModel?: string;


  maxTokens?: number;
}












export function getAIProviderChain(env: NodeJS.ProcessEnv = process.env): AIProviderChainEntry[] {
  const resolveKey = (spec: { key_env?: string; api_key?: string }): string | undefined => {
    if (spec.api_key) return spec.api_key;
    if (spec.key_env && env[spec.key_env]) return env[spec.key_env];
    return undefined;
  };


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

    }
  }


  const chain: AIProviderChainEntry[] = [];





  const openAICompatibleDeepInfra = Boolean(env.OPENAI_BASE_URL && /deepinfra/i.test(env.OPENAI_BASE_URL));
  const deepInfraKey = env.DEEPINFRA_API_KEY || (openAICompatibleDeepInfra ? env.OPENAI_API_KEY : undefined);
  if (deepInfraKey) {
    const primaryModel = env.DEEPINFRA_MODEL || env.OPENAI_MODEL || DEFAULT_DEEPINFRA_MODEL;
    const structuredModel = env.DEEPINFRA_STRUCTURED_MODEL || env.OPENAI_STRUCTURED_MODEL || primaryModel;
    const baseURL = env.DEEPINFRA_BASE_URL || (openAICompatibleDeepInfra ? env.OPENAI_BASE_URL : undefined) || DEEPINFRA_OPENAI_BASE_URL;
    chain.push({
      name: 'deepinfra',
      baseURL,
      apiKey: deepInfraKey,
      model: primaryModel,
      structuredModel,
    });
    const fastFallbackModel = env.DEEPINFRA_FAST_FALLBACK_MODEL || env.OPENAI_STRUCTURED_MODEL ||
      'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo';
    if (fastFallbackModel !== primaryModel) {
      chain.push({
        name: 'deepinfra-fast-fallback',
        baseURL,
        apiKey: deepInfraKey,
        model: fastFallbackModel,
        structuredModel: fastFallbackModel,
      });
    }



    chain.push({
      name: 'deepinfra-retry',
      baseURL,
      apiKey: deepInfraKey,
      model: primaryModel,
      structuredModel: primaryModel,
    });
  }




  if (env.KLAURO_ALLOW_LOCAL_AI === '1' && env.LOCAL_LLM_BASE_URL) {
    const primaryModel = env.LOCAL_LLM_MODEL || 'qwen2.5:7b-instruct';
    const structuredModel = env.LOCAL_LLM_STRUCTURED_MODEL || primaryModel;
    const maxTokens = env.LOCAL_LLM_MAX_TOKENS ? parseInt(env.LOCAL_LLM_MAX_TOKENS) : undefined;
    chain.push({
      name: 'local-llm',
      baseURL: env.LOCAL_LLM_BASE_URL,
      apiKey: (env.LOCAL_LLM_API_KEY && env.LOCAL_LLM_API_KEY) || 'local',
      model: primaryModel,
      structuredModel,
      maxTokens,
    });
    const fallbackModels = String(env.LOCAL_LLM_FALLBACK_MODELS || '')
      .split(',')
      .map(model => model.trim())
      .filter(Boolean)
      .filter((model, index, models) => model !== primaryModel && models.indexOf(model) === index);
    for (const [index, model] of fallbackModels.entries()) {
      chain.push({
        name: `local-llm-fallback-${index + 1}`,
        baseURL: env.LOCAL_LLM_BASE_URL,
        apiKey: (env.LOCAL_LLM_API_KEY && env.LOCAL_LLM_API_KEY) || 'local',
        model,
        structuredModel: model,
        maxTokens,
      });
    }
  }




  if (env.OPENROUTER_API_KEY) {
    chain.push({
      name: 'openrouter',
      baseURL: env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      apiKey: env.OPENROUTER_API_KEY,
      model: env.OPENROUTER_MODEL || 'tencent/hy3',
      structuredModel: env.OPENROUTER_STRUCTURED_MODEL || env.OPENROUTER_MODEL || 'tencent/hy3',
      maxTokens: env.OPENROUTER_MAX_TOKENS ? parseInt(env.OPENROUTER_MAX_TOKENS) : 4000,
    });
  }

  return chain;
}
