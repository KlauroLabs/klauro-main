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

  local: z.object({
    enabled: z.boolean().default(true),
    model: z.string().default('onnx-community/Qwen2.5-0.5B-Instruct'),
    maxTokens: z.number().default(512),
    temperature: z.number().default(0.3),
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
    providers: z.array(z.enum(['openai', 'claude', 'local', 'fallback'])).default(['openai', 'claude', 'local', 'fallback']),
  }),
  
  prompts: z.object({
    maxContextLength: z.number().default(8000),
    includeCodeContext: z.boolean().default(true),
    includeArchitectureContext: z.boolean().default(true),
    responseFormat: z.enum(['json', 'markdown', 'structured']).default('structured'),
  }),
});

export type AIConfig = z.infer<typeof AIConfigSchema>;

function hasAzureOpenAIConfig(): boolean {
  return Boolean(
    process.env.AZURE_OPENAI_API_KEY &&
    process.env.AZURE_OPENAI_ENDPOINT &&
    (process.env.AZURE_OPENAI_DEPLOYMENT || process.env.AZURE_OPENAI_MODEL)
  );
}

function localOpenAIBaseURL(): string | undefined {
  const explicit = process.env.OPENAI_BASE_URL || process.env.LOCAL_OPENAI_BASE_URL;
  if (explicit) return explicit;
  const ollama = process.env.OLLAMA_BASE_URL;
  if (ollama) return `${ollama.replace(/\/$/, '')}/v1`;
  if (process.env.KLAURO_OLLAMA_AUTO === 'true' || process.env.KLAURO_OLLAMA_AUTO === '1') return 'http://127.0.0.1:11434/v1';
  return undefined;
}

export function getAIConfig(): AIConfig {
  const openAICompatibleBaseURL = localOpenAIBaseURL();
  const config = {
    openai: {
      apiKey: process.env.OPENAI_API_KEY ||
        (openAICompatibleBaseURL ? process.env.LOCAL_OPENAI_API_KEY || process.env.OLLAMA_API_KEY || 'local-openai-compatible' : undefined) ||
        (hasAzureOpenAIConfig() ? process.env.AZURE_OPENAI_API_KEY : undefined),
      organization: process.env.OPENAI_ORGANIZATION,
      baseURL: openAICompatibleBaseURL,
      model: process.env.OPENAI_MODEL ||
        process.env.LOCAL_OPENAI_MODEL ||
        process.env.OLLAMA_MODEL ||
        process.env.AZURE_OPENAI_DEPLOYMENT ||
        process.env.AZURE_OPENAI_MODEL ||
        (openAICompatibleBaseURL?.includes('127.0.0.1:11434') || openAICompatibleBaseURL?.includes('localhost:11434') ? 'qwen3:8b' : 'gpt-4o-mini'),
      maxTokens: parseInt(process.env.OPENAI_MAX_TOKENS || '2000'),
      temperature: parseFloat(process.env.OPENAI_TEMPERATURE || '0.3'),
      timeout: parseInt(process.env.AI_TIMEOUT || '30000'),
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

    local: {
      enabled: process.env.AI_LOCAL_ENABLED !== 'false',
      model: process.env.AI_LOCAL_MODEL || 'onnx-community/Qwen2.5-0.5B-Instruct',
      maxTokens: parseInt(process.env.AI_LOCAL_MAX_TOKENS || '512'),
      temperature: parseFloat(process.env.AI_LOCAL_TEMPERATURE || '0.3'),
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
      providers: (process.env.AI_FALLBACK_PROVIDERS?.split(',') as any[]) || ['openai', 'claude', 'local', 'fallback'],
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
