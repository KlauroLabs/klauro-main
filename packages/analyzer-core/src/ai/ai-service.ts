import { aiConfig, AIConfig, getAIConfig, getAIProviderChain, type AIProviderChainEntry } from '../config/ai.config';
import { OpenAIProvider } from './providers/openai-provider';
import { ClaudeProvider } from './providers/claude-provider';
import { FallbackProvider } from './providers/fallback-provider';
import { AICache } from './ai-cache';
import { ComponentNode, ArchitectureBlueprint, RiskArea } from '../types';
import { prompts } from './ai-prompts';
import { recordSemanticDecision } from './semantic-dataset';
import * as winston from 'winston';

/**
 * Prefix on the aggregate error thrown when EVERY provider in the chain failed
 * to answer. It marks a delivery failure (timeout, 429, auth, dropped
 * connection, empty completion), NOT a quality judgement about model output.
 *
 * These two need different remediations and the 2026-07-27 comprehension audit
 * caught them being reported identically: two 30s provider timeouts (with
 * retries defaulted to zero) surfaced to the operator as "could not produce
 * grounded AI descriptions", pointing them at prompts and evidence when the
 * actual problem was that nothing had answered.
 */
export const AI_PROVIDER_UNAVAILABLE_MARKER = 'ai-provider-unavailable';

/**
 * True when a failure reason describes the provider never delivering an answer,
 * rather than an answer that failed a grounding/quality gate. Matches the
 * marker above plus the shapes that reach callers from single-provider paths.
 */
export function isProviderUnavailableFailure(reason: unknown): boolean {
  const text = String(reason ?? '').toLowerCase();
  if (!text) return false;
  return text.includes(AI_PROVIDER_UNAVAILABLE_MARKER)
    || text.includes('no generative ai provider is available')
    || text.includes('provider returned empty content')
    || /\b(etimedout|econnreset|econnrefused|enotfound|socket hang up)\b/.test(text)
    || /\b(timed out|timeout|rate limit|429|502|503|504)\b/.test(text);
}

export interface AIProvider {
  name: string;
  available: boolean;
  generateDescription(context: AIAnalysisContext): Promise<string>;
  assessRisk(context: AIAnalysisContext): Promise<AIRiskAssessment>;
  generateRecommendations(context: AIAnalysisContext): Promise<AIRecommendation[]>;
  analyzeCode(context: AIAnalysisContext): Promise<AICodeAnalysis>;
}

export interface AIAnalysisContext {
  component?: ComponentNode;
  blueprint?: ArchitectureBlueprint;
  code?: string;
  language?: string;
  framework?: string;
  additionalContext?: Record<string, any>;
}

export interface AIRiskAssessment {
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  confidence: number;
  reasons: string[];
  suggestions: string[];
  categories: AIRiskCategory[];
}

export interface AIRiskCategory {
  category: 'security' | 'performance' | 'maintainability' | 'scalability' | 'reliability';
  score: number; // 0-100
  issues: string[];
  recommendations: string[];
}

export interface AIRecommendation {
  type: 'architectural' | 'security' | 'performance' | 'testing' | 'refactoring';
  priority: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  description: string;
  implementation: string;
  impact: string;
  effort: 'low' | 'medium' | 'high';
  confidence: number;
  tags: string[];
}

export interface AICodeAnalysis {
  summary: string;
  complexity: {
    cognitive: number;
    cyclomatic: number;
    maintainability: number;
  };
  patterns: AIPattern[];
  issues: AIIssue[];
  suggestions: AISuggestion[];
  testability: number;
  documentation: string;
}

export interface AIPattern {
  name: string;
  type: 'design-pattern' | 'anti-pattern' | 'architectural-pattern';
  confidence: number;
  description: string;
  location?: string;
  impact: 'positive' | 'negative' | 'neutral';
}

export interface AIIssue {
  type: 'bug' | 'vulnerability' | 'code-smell' | 'performance' | 'maintainability';
  severity: 'info' | 'warning' | 'error' | 'critical';
  message: string;
  line?: number;
  column?: number;
  suggestion?: string;
}

export interface AISuggestion {
  type: 'optimization' | 'refactoring' | 'testing' | 'documentation';
  message: string;
  example?: string;
  priority: number; // 1-10
}

export interface AIUsageStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  totalTokens: number;
  totalCost: number;
  averageResponseTime: number;
  hitRate: number;
  costBreakdown: Record<string, number>;
  requestsByProvider: Record<string, number>;
}

export class AIService {
  private providers: Map<string, AIProvider> = new Map();
  /** Ordered OpenAI-compatible fallback chain (DeepInfra -> local -> OpenRouter).
   * Each entry carries its own model + max_tokens so a reasoning model gets the
   * room it needs. Empty when no chain is configured (single-provider path). */
  private providerChain: Array<{ entry: AIProviderChainEntry; provider: AIProvider }> = [];
  private cache: AICache;
  private logger: winston.Logger;
  private usageStats!: AIUsageStats;
  private costTracker: CostTracker;
  private rateLimiter: RateLimiter;

  constructor() {
    this.logger = winston.createLogger({
      level: process.env.KLAURO_LOG_LEVEL || 'warn',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      transports: [
        new winston.transports.Console({
          stderrLevels: ['error', 'warn', 'info', 'verbose', 'debug', 'silly'],
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
          )
        })
      ]
    });

    this.cache = new AICache();
    this.initializeProviders();
    this.initializeUsageTracking();
    this.costTracker = new CostTracker(aiConfig.costTracking);
    this.rateLimiter = new RateLimiter();
  }

  private initializeProviders(): void {
    try {
      if (aiConfig.openai.apiKey) {
        this.providers.set('openai', new OpenAIProvider(aiConfig));
        this.logger.info('OpenAI provider initialized');
      }
    } catch (error) {
      this.logger.warn('Failed to initialize OpenAI provider:', error);
    }

    try {
      if (aiConfig.anthropic.apiKey) {
        this.providers.set('claude', new ClaudeProvider(aiConfig));
        this.logger.info('Claude provider initialized');
      }
    } catch (error) {
      this.logger.warn('Failed to initialize Claude provider:', error);
    }

    // Fallback provider is always available
    this.providers.set('fallback', new FallbackProvider(aiConfig));
    this.logger.info('Fallback provider initialized');

    this.initializeProviderChain();
  }

  /**
   * Build the ordered OpenAI-compatible provider fallback chain. Each entry is a
   * distinct OpenAIProvider whose config is aiConfig cloned with that entry's
   * baseURL/apiKey/model. Failures here are non-fatal (the discrete single
   * provider above still serves); a broken entry is simply skipped.
   */
  private initializeProviderChain(): void {
    let chain: AIProviderChainEntry[] = [];
    try {
      chain = getAIProviderChain();
    } catch (error) {
      this.logger.warn('Failed to build AI provider chain:', error);
      return;
    }
    for (const entry of chain) {
      try {
        const entryConfig: AIConfig = {
          ...aiConfig,
          openai: {
            ...aiConfig.openai,
            apiKey: entry.apiKey,
            baseURL: entry.baseURL,
            model: entry.model,
            maxTokens: entry.maxTokens ?? aiConfig.openai.maxTokens,
            // Default 2, not 0. With zero retries a single transient provider
            // blip (a 429, a dropped connection, one 30s stall) is indistinguish-
            // able from "this model cannot produce grounded output", and L5
            // comprehension reported a GROUNDING failure for what was really a
            // provider outage — two completely different remediations. Retries
            // are per-provider and sit UNDER the chain fallback, so the worst
            // case is bounded by (retries x providers), not unbounded.
            maxRetries: Math.max(0, Number(process.env.KLAURO_AI_PROVIDER_RETRIES ?? 2)),
          },
        };
        this.providerChain.push({ entry, provider: new OpenAIProvider(entryConfig) });
      } catch (error) {
        this.logger.warn(`Failed to init chain provider ${entry.name}:`, error);
      }
    }
    if (this.providerChain.length) {
      this.logger.info(`AI provider chain: ${this.providerChain.map(p => p.entry.name).join(' -> ')}`);
    }
  }

  private initializeUsageTracking(): void {
    this.usageStats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      totalTokens: 0,
      totalCost: 0,
      averageResponseTime: 0,
      hitRate: 0,
      costBreakdown: {},
      requestsByProvider: {}
    };
  }

  async generateComponentDescription(context: AIAnalysisContext): Promise<string> {
    if (!aiConfig.features.naturalLanguageDescriptions) {
      return 'AI description generation is disabled';
    }

    const cacheKey = this.generateCacheKey('description', context);

    try {
      // Check cache first
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        this.logger.debug('Using cached description');
        return cached;
      }

      // Rate limiting
      await this.rateLimiter.waitForCapacity('description');

      // Ordered fallback chain: try each provider in turn. A provider error
      // (network, 4xx/5xx, 429) OR empty content (the reasoning-model
      // out-of-budget case) advances to the next provider. L5 comprehension must
      // never silently skip because ONE provider is slow/rate-limited, so only
      // when EVERY provider fails do we throw (never a deterministic substitute).
      if (this.providerChain.length > 0) {
        const description = await this.generateDescriptionViaChain(context);
        await this.cache.set(cacheKey, description);
        return description;
      }

      const provider = await this.selectBestProvider();
      if (provider.name === 'fallback' && process.env.AI_DESCRIPTION_ALLOW_RULE_BASED_FALLBACK !== 'true') {
        throw new Error('No generative AI provider is available for description generation');
      }
      const startTime = Date.now();

      this.logger.info(`Generating description using ${provider.name} provider`);

      const description = await provider.generateDescription(context);

      // Track usage
      const responseTime = Date.now() - startTime;
      this.updateUsageStats(provider.name, true, responseTime);

      // Cache result
      await this.cache.set(cacheKey, description);

      return description;
    } catch (error) {
      this.logger.error('Failed to generate description:', error);
      this.updateUsageStats('unknown', false, 0);
      if (process.env.AI_DESCRIPTION_ALLOW_RULE_BASED_FALLBACK !== 'true') {
        throw error;
      }
      return this.generateFallbackDescription(context);
    }
  }

  /**
   * Try each provider in the ordered chain until one returns non-empty content.
   * A thrown error OR empty/whitespace content advances to the next provider
   * (empty content is exactly the reasoning-model-out-of-budget failure). Each
   * entry injects its own model + max_tokens via additionalContext so a caller's
   * explicit per-call model/maxTokens still wins, but chain entries supply a
   * default when the caller left them unset. Throws an aggregate error only when
   * every provider fails, so the AI-only boundary is preserved (no deterministic
   * substitute) while a single slow/rate-limited provider can never skip L5.
   */
  private async generateDescriptionViaChain(context: AIAnalysisContext): Promise<string> {
    const errors: string[] = [];
    const wantsStructured = context.additionalContext?.responseFormat === 'json'
      || context.additionalContext?.response_format === 'json';
    const serializedContextBytes = Buffer.byteLength(JSON.stringify(context.additionalContext || {}), 'utf8');
    for (const { entry, provider } of this.providerChain) {
      const startTime = Date.now();
      try {
        this.logger.info(`Generating description using ${entry.name} provider (chain)`);
        const requestedModelProvider = String(context.additionalContext?.model_provider || '').trim().toLowerCase();
        // A provider-scoped override applies to that provider's PRIMARY entry,
        // not every fallback whose name shares its prefix. Otherwise a
        // requested DeepInfra narrative model overwrites deepinfra-fast-
        // fallback too, turning a diverse chain into repeated calls to the
        // same stalled inference pool.
        const requestedModelApplies = !requestedModelProvider || entry.name.toLowerCase() === requestedModelProvider;
        const perProviderContext: AIAnalysisContext = {
          ...context,
          additionalContext: {
            ...context.additionalContext,
            // Caller-supplied model/maxTokens win; otherwise use the entry's.
            model: (requestedModelApplies ? context.additionalContext?.model : undefined)
              ?? (wantsStructured ? (entry.structuredModel || entry.model) : entry.model),
            maxTokens: context.additionalContext?.maxTokens
              ?? context.additionalContext?.max_tokens
              ?? entry.maxTokens,
          },
        };
        const description = await provider.generateDescription(perProviderContext);
        if (!description || !description.trim()) {
          // Empty content (reasoning model consumed all output budget, or a
          // provider stub) — treat as a failure and fall through to the next.
          throw new Error('provider returned empty content');
        }
        this.updateUsageStats(entry.name, true, Date.now() - startTime);
        recordSemanticDecision({
          ts: Date.now(),
          decision_type: 'ai_provider_attempt',
          provider: entry.name,
          model: perProviderContext.additionalContext?.model as string | undefined,
          input_evidence_digest: {
            context_keys: Object.keys(context.additionalContext || {}).length,
            wants_structured: wantsStructured,
            context_bytes: serializedContextBytes,
            output_bytes: Buffer.byteLength(description, 'utf8'),
            elapsed_ms: Date.now() - startTime,
          },
          raw_output_excerpt: description,
          parse_ok: true,
          gate_verdict: 'accepted',
          final_outcome: 'ai',
        });
        return description;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Chain provider ${entry.name} failed (${message}); trying next`);
        this.updateUsageStats(entry.name, false, Date.now() - startTime);
        errors.push(`${entry.name}: ${message}`);
        recordSemanticDecision({
          ts: Date.now(),
          decision_type: 'ai_provider_attempt',
          provider: entry.name,
          input_evidence_digest: {
            context_keys: Object.keys(context.additionalContext || {}).length,
            wants_structured: wantsStructured,
            context_bytes: serializedContextBytes,
            elapsed_ms: Date.now() - startTime,
          },
          parse_ok: false,
          gate_verdict: 'rejected',
          gate_reason: message,
          // A single provider failure falls through to the next — degraded, not
          // terminal. The aggregate throw below records the terminal 'error'.
          final_outcome: 'degraded',
        });
      }
    }
    recordSemanticDecision({
      ts: Date.now(),
      decision_type: 'ai_provider_attempt',
      input_evidence_digest: {
        context_keys: Object.keys(context.additionalContext || {}).length,
        wants_structured: wantsStructured,
        providers_tried: this.providerChain.length,
      },
      parse_ok: false,
      gate_verdict: 'rejected',
      gate_reason: errors.join(' | '),
      final_outcome: 'error',
    });
    // Stable marker so callers can tell PROVIDER UNAVAILABILITY apart from
    // "the model answered and the answer failed the grounding gate". They need
    // opposite remediations — retry / check credentials and quota, versus fix
    // the evidence or the prompt — and the 2026-07-27 audit showed them being
    // reported identically ("could not produce grounded descriptions") after
    // two provider timeouts. See isProviderUnavailableFailure.
    throw new Error(`${AI_PROVIDER_UNAVAILABLE_MARKER}: all AI providers in the chain failed: ${errors.join(' | ')}`);
  }

  async assessComponentRisk(context: AIAnalysisContext): Promise<AIRiskAssessment> {
    if (!aiConfig.features.riskAssessment) {
      return this.generateBasicRiskAssessment(context);
    }

    const cacheKey = this.generateCacheKey('risk', context);
    
    try {
      // Check cache first
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        this.logger.debug('Using cached risk assessment');
        return cached;
      }

      // Rate limiting
      await this.rateLimiter.waitForCapacity('risk');

      const provider = await this.selectBestProvider();
      const startTime = Date.now();
      
      this.logger.info(`Assessing risk using ${provider.name} provider`);
      
      const assessment = await provider.assessRisk(context);
      
      // Track usage
      const responseTime = Date.now() - startTime;
      this.updateUsageStats(provider.name, true, responseTime);
      
      // Cache result
      await this.cache.set(cacheKey, assessment);
      
      return assessment;
    } catch (error) {
      this.logger.error('Failed to assess risk:', error);
      this.updateUsageStats('unknown', false, 0);
      return this.generateBasicRiskAssessment(context);
    }
  }

  async generateArchitecturalRecommendations(context: AIAnalysisContext): Promise<AIRecommendation[]> {
    if (!aiConfig.features.architecturalRecommendations) {
      return [];
    }

    const cacheKey = this.generateCacheKey('recommendations', context);
    
    try {
      // Check cache first
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        this.logger.debug('Using cached recommendations');
        return cached;
      }

      // Rate limiting
      await this.rateLimiter.waitForCapacity('recommendations');

      const provider = await this.selectBestProvider();
      const startTime = Date.now();
      
      this.logger.info(`Generating recommendations using ${provider.name} provider`);
      
      const recommendations = await provider.generateRecommendations(context);
      
      // Track usage
      const responseTime = Date.now() - startTime;
      this.updateUsageStats(provider.name, true, responseTime);
      
      // Cache result
      await this.cache.set(cacheKey, recommendations);
      
      return recommendations;
    } catch (error) {
      this.logger.error('Failed to generate recommendations:', error);
      this.updateUsageStats('unknown', false, 0);
      return [];
    }
  }

  async analyzeCode(context: AIAnalysisContext): Promise<AICodeAnalysis> {
    if (!aiConfig.features.codeAnalysis) {
      return this.generateBasicCodeAnalysis(context);
    }

    const cacheKey = this.generateCacheKey('analysis', context);
    
    try {
      // Check cache first
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        this.logger.debug('Using cached code analysis');
        return cached;
      }

      // Rate limiting
      await this.rateLimiter.waitForCapacity('analysis');

      const provider = await this.selectBestProvider();
      const startTime = Date.now();
      
      this.logger.info(`Analyzing code using ${provider.name} provider`);
      
      const analysis = await provider.analyzeCode(context);
      
      // Track usage
      const responseTime = Date.now() - startTime;
      this.updateUsageStats(provider.name, true, responseTime);
      
      // Cache result
      await this.cache.set(cacheKey, analysis);
      
      return analysis;
    } catch (error) {
      this.logger.error('Failed to analyze code:', error);
      this.updateUsageStats('unknown', false, 0);
      return this.generateBasicCodeAnalysis(context);
    }
  }

  private async selectBestProvider(): Promise<AIProvider> {
    this.refreshEnvironmentProviders();
    const providers = Array.from(this.providers.values()).filter(p => p.available);
    
    if (providers.length === 0) {
      throw new Error('No AI providers available');
    }

    // Check cost limits
    if (!(await this.costTracker.canMakeRequest())) {
      this.logger.warn('Cost limit reached, using fallback provider');
      return this.providers.get('fallback')!;
    }

    // Apply fallback strategy
    switch (aiConfig.fallback.strategy) {
      case 'cascade':
        for (const providerName of aiConfig.fallback.providers) {
          const provider = this.providers.get(providerName);
          if (provider?.available) {
            return provider;
          }
        }
        break;
        
      case 'loadbalance':
        return providers[Math.floor(Math.random() * providers.length)];
        
      case 'failover':
        // Use the first available provider
        return providers[0];
    }

    // Default to fallback
    return this.providers.get('fallback')!;
  }

  private refreshEnvironmentProviders(): void {
    if (this.providers.has('openai')) return;
    const freshConfig = getAIConfig();
    if (!freshConfig.openai.apiKey) return;
    try {
      this.providers.set('openai', new OpenAIProvider(freshConfig));
      this.logger.info('OpenAI-compatible provider initialized from refreshed environment');
    } catch (error) {
      this.logger.warn('Failed to initialize refreshed OpenAI-compatible provider:', error);
    }
  }

  private generateCacheKey(operation: string, context: AIAnalysisContext): string {
    const keyParts = [
      operation,
      context.component?.id || 'global',
      context.language || 'unknown',
      context.framework || 'unknown'
    ];

    const crypto = require('crypto');

    if (context.code) {
      // Use a hash of the code for cache key
      keyParts.push(crypto.createHash('md5').update(context.code).digest('hex').substring(0, 8));
    }

    // When the request is driven by structural facts rather than a component
    // or raw code (e.g. system-level interpretation), the facts themselves
    // are what distinguish one request from another. Without this, every
    // system-level call collides on `description:global:unknown:unknown` and
    // one project's description leaks into the next.
    //
    // The serialized facts are also the cache key on the content-addressed disk
    // cache, so any RUN- or PATH-specific token in them defeats caching entirely:
    // identical source content re-analyzed from a different absolute path (the
    // common case — the analyzer stages each run in a fresh path-hashed
    // workspace, so `systemName`/`product.name` become a per-path project-id
    // hash) would otherwise produce a different key on every run and never hit.
    // Normalize that noise out BEFORE hashing so identical prompt-relevant facts
    // yield an identical key. This never changes what is SENT to the model — only
    // how the request is keyed — so it cannot alter any generated description.
    if (context.additionalContext && Object.keys(context.additionalContext).length > 0) {
      const serialized = this.normalizeContextForCacheKey(context.additionalContext);
      keyParts.push(crypto.createHash('md5').update(serialized).digest('hex').substring(0, 12));
    }

    return keyParts.join(':');
  }

  /**
   * Stable serialization of `additionalContext` for the cache key. Serializes
   * with sorted object keys (so key ordering never perturbs the hash) and scrubs
   * run-/path-specific noise that carries no semantic meaning for the prompt:
   * absolute/temp paths, path-derived project-id / md5-style hex tokens (the
   * synthetic `systemName`), ISO timestamps, and epoch-millisecond stamps. The
   * scrub is deliberately narrow (only long hex tokens and recognizable
   * path/time shapes) so genuinely different SOURCE content — different entity
   * names, routes, capabilities, real system names — still produces distinct
   * keys and never collides.
   */
  private normalizeContextForCacheKey(additionalContext: Record<string, unknown>): string {
    const stableStringify = (value: unknown): string => {
      if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
      if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
      const keys = Object.keys(value as Record<string, unknown>).sort();
      return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
    };
    const serialized = stableStringify(additionalContext);
    return serialized
      // absolute / temp workspace paths (macOS var/folders, /tmp, /private/tmp, /Users, and the analyzer's path-hashed workspace dirs)
      .replace(/(?:\/private)?\/(?:var\/folders|tmp)\/[^"\\\s]*/gi, '<PATH>')
      .replace(/\/(?:Users|home)\/[^"\\\s]*/gi, '<PATH>')
      .replace(/[A-Za-z]:\\\\[^"\\\s]*/g, '<PATH>')
      // path-derived project-id / md5-style hash tokens (>=12 hex chars, word-bounded) —
      // the synthetic systemName/product.name for a staged workspace is exactly this shape
      .replace(/\b[0-9a-f]{12,64}\b/gi, '<HASH>')
      // absolute timestamps that vary every run
      .replace(/\b20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, '<TS>')
      .replace(/\b1[0-9]{12}\b/g, '<TS>');
  }

  private generateFallbackDescription(context: AIAnalysisContext): string {
    if (!context.component) {
      return 'Component analysis not available';
    }

    const component = context.component;
    let description = `${component.type.charAt(0).toUpperCase() + component.type.slice(1)} component`;
    
    if (component.metadata.responsibilities.length > 0) {
      description += ` responsible for ${component.metadata.responsibilities.join(', ')}`;
    }

    if (component.dependencies.length > 0) {
      description += `. Depends on ${component.dependencies.length} other components`;
    }

    if (component.dependents.length > 0) {
      description += ` and is used by ${component.dependents.length} components`;
    }

    return description + '.';
  }

  private generateBasicRiskAssessment(context: AIAnalysisContext): AIRiskAssessment {
    const component = context.component;
    if (!component) {
      return {
        riskLevel: 'low',
        confidence: 0.3,
        reasons: ['No component data available'],
        suggestions: ['Provide more context for better analysis'],
        categories: []
      };
    }

    let riskLevel: 'low' | 'medium' | 'high' | 'critical' = 'low';
    const reasons: string[] = [];
    const suggestions: string[] = [];

    // Basic heuristics
    if (component.metadata.complexity > 8) {
      riskLevel = 'high';
      reasons.push('High complexity score');
      suggestions.push('Consider refactoring to reduce complexity');
    } else if (component.metadata.complexity > 5) {
      riskLevel = 'medium';
      reasons.push('Moderate complexity');
      suggestions.push('Monitor complexity growth');
    }

    if (component.dependencies.length > 10) {
      riskLevel = riskLevel === 'low' ? 'medium' : 'high';
      reasons.push('High number of dependencies');
      suggestions.push('Consider dependency injection patterns');
    }

    if (component.metadata.testCoverage !== undefined && component.metadata.testCoverage < 60) {
      riskLevel = riskLevel === 'low' ? 'medium' : 'high';
      reasons.push('Low test coverage');
      suggestions.push('Increase test coverage to at least 80%');
    }

    return {
      riskLevel,
      confidence: 0.6,
      reasons,
      suggestions,
      categories: []
    };
  }

  private generateBasicCodeAnalysis(context: AIAnalysisContext): AICodeAnalysis {
    const complexity = context.component?.metadata.complexity || 1;
    
    return {
      summary: 'Basic analysis based on static metrics',
      complexity: {
        cognitive: complexity,
        cyclomatic: Math.floor(complexity * 0.8),
        maintainability: Math.max(1, 10 - complexity)
      },
      patterns: [],
      issues: [],
      suggestions: [],
      testability: context.component?.metadata.testCoverage || 50,
      documentation: 'No AI-powered documentation available'
    };
  }

  private updateUsageStats(providerName: string, success: boolean, responseTime: number): void {
    this.usageStats.totalRequests++;
    
    if (success) {
      this.usageStats.successfulRequests++;
    } else {
      this.usageStats.failedRequests++;
    }

    // Update average response time
    const totalTime = this.usageStats.averageResponseTime * (this.usageStats.totalRequests - 1);
    this.usageStats.averageResponseTime = (totalTime + responseTime) / this.usageStats.totalRequests;

    // Update provider stats
    if (!this.usageStats.requestsByProvider[providerName]) {
      this.usageStats.requestsByProvider[providerName] = 0;
    }
    this.usageStats.requestsByProvider[providerName]++;
  }

  async getUsageStats(): Promise<AIUsageStats> {
    const costBreakdown = await this.costTracker.getCostBreakdown();
    const cacheStats = this.cache.getStats();
    
    return {
      ...this.usageStats,
      totalCost: costBreakdown.total,
      costBreakdown: costBreakdown.byProvider,
      hitRate: cacheStats.hitRate
    };
  }

  async clearCache(): Promise<void> {
    await this.cache.clear();
    this.logger.info('AI cache cleared');
  }

  async close(): Promise<void> {
    await this.cache.close();
  }

  getAvailableProviders(): string[] {
    return Array.from(this.providers.entries())
      .filter(([_, provider]) => provider.available)
      .map(([name, _]) => name);
  }
}

class CostTracker {
  private costs: Map<string, number> = new Map();
  private dailyCost: number = 0;
  private monthlyCost: number = 0;
  private lastReset: Date = new Date();

  constructor(private config: AIConfig['costTracking']) {}

  async canMakeRequest(): Promise<boolean> {
    if (!this.config.enabled) {
      return true;
    }

    this.resetIfNeeded();

    return this.dailyCost < this.config.maxDailyCost &&
           this.monthlyCost < this.config.maxMonthlyCost;
  }

  async recordCost(provider: string, tokens: number, model: string): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    const pricing = this.getPricing(provider, model);
    if (!pricing) {
      return;
    }

    const cost = (tokens / 1000) * pricing.input; // Simplified calculation
    
    this.dailyCost += cost;
    this.monthlyCost += cost;
    
    const providerCost = this.costs.get(provider) || 0;
    this.costs.set(provider, providerCost + cost);

    // Check alert threshold
    if (this.dailyCost / this.config.maxDailyCost > this.config.alertThreshold) {
      winston.warn(`AI cost approaching daily limit: $${this.dailyCost.toFixed(2)}`);
    }
  }

  async getCostBreakdown(): Promise<{ total: number; byProvider: Record<string, number> }> {
    const breakdown: Record<string, number> = {};
    let total = 0;

    for (const [provider, cost] of this.costs.entries()) {
      breakdown[provider] = cost;
      total += cost;
    }

    return { total, byProvider: breakdown };
  }

  private getPricing(provider: string, model: string): { input: number; output: number } | null {
    const providerPricing = (this.config.pricing as any)[provider];
    if (!providerPricing) {
      return null;
    }

    return providerPricing[model] || null;
  }

  private resetIfNeeded(): void {
    const now = new Date();
    const daysSince = Math.floor((now.getTime() - this.lastReset.getTime()) / (1000 * 60 * 60 * 24));

    if (daysSince >= 1) {
      this.dailyCost = 0;
      this.lastReset = now;
    }

    const monthsSince = (now.getFullYear() - this.lastReset.getFullYear()) * 12 + 
                       (now.getMonth() - this.lastReset.getMonth());

    if (monthsSince >= 1) {
      this.monthlyCost = 0;
    }
  }
}

class RateLimiter {
  private limits: Map<string, { count: number; resetTime: number }> = new Map();

  async waitForCapacity(operation: string): Promise<void> {
    const limit = this.getLimit(operation);
    if (!limit) {
      return;
    }

    const now = Date.now();
    const windowStart = Math.floor(now / 60000) * 60000; // 1-minute window
    
    const current = this.limits.get(operation) || { count: 0, resetTime: windowStart };
    
    if (current.resetTime < windowStart) {
      current.count = 0;
      current.resetTime = windowStart;
    }

    if (current.count >= limit) {
      const waitTime = windowStart + 60000 - now;
      await new Promise(resolve => setTimeout(resolve, waitTime));
      current.count = 0;
      current.resetTime = windowStart + 60000;
    }

    current.count++;
    this.limits.set(operation, current);
  }

  private getLimit(operation: string): number | null {
    // Conservative rate limits to prevent abuse
    const limits: Record<string, number> = {
      description: 30, // per minute
      risk: 20,
      recommendations: 10,
      analysis: 15
    };

    return limits[operation] || null;
  }
}

export const aiService = new AIService();
