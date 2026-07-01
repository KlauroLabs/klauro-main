import OpenAI from 'openai';
import { AIProvider, AIAnalysisContext, AIRiskAssessment, AIRecommendation, AICodeAnalysis } from '../ai-service';
import { AIConfig } from '../../config/ai.config';
import { prompts } from '../ai-prompts';
import * as winston from 'winston';
import pRetry from 'p-retry';

function resolveOllamaBaseURL(openAIBaseURL?: string): string | undefined {
  const explicit = process.env.OLLAMA_BASE_URL;
  if (explicit) return explicit.replace(/\/$/, '');
  if (!openAIBaseURL) return undefined;

  try {
    const url = new URL(openAIBaseURL);
    if (url.port === '11434' || /(^|\.)ollama($|\.)/i.test(url.hostname)) {
      url.pathname = url.pathname.replace(/\/v1\/?$/, '') || '/';
      url.search = '';
      url.hash = '';
      return url.toString().replace(/\/$/, '');
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export class OpenAIProvider implements AIProvider {
  public readonly name: string;
  private client: OpenAI;
  private logger: winston.Logger;
  private config: AIConfig;
  private ollamaBaseURL?: string;

  constructor(config: AIConfig) {
    this.config = config;
    this.ollamaBaseURL = resolveOllamaBaseURL(config.openai.baseURL);
    this.name = this.resolveProviderName();
    
    if (!config.openai.apiKey) {
      throw new Error('OpenAI API key is required');
    }

    const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const azureDeployment = process.env.AZURE_OPENAI_DEPLOYMENT || process.env.AZURE_OPENAI_MODEL;
    const azureApiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-10-21';
    const azureEnabled = Boolean(process.env.AZURE_OPENAI_API_KEY && azureEndpoint && azureDeployment && config.openai.apiKey === process.env.AZURE_OPENAI_API_KEY);

    this.client = new OpenAI(azureEnabled
      ? {
        apiKey: config.openai.apiKey,
        baseURL: `${azureEndpoint!.replace(/\/$/, '')}/openai/deployments/${azureDeployment}`,
        defaultQuery: { 'api-version': azureApiVersion },
        defaultHeaders: { 'api-key': config.openai.apiKey },
        timeout: config.openai.timeout,
        maxRetries: config.openai.maxRetries,
      }
      : config.openai.baseURL
        ? {
          apiKey: config.openai.apiKey,
          baseURL: config.openai.baseURL,
          timeout: config.openai.timeout,
          maxRetries: config.openai.maxRetries,
        }
        : {
        apiKey: config.openai.apiKey,
        organization: config.openai.organization,
        timeout: config.openai.timeout,
        maxRetries: config.openai.maxRetries,
      });

    this.logger = winston.createLogger({
      level: process.env.KLAURO_LOG_LEVEL || 'warn',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      defaultMeta: { provider: this.name },
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
  }

  private resolveProviderName(): string {
    const baseURL = this.config.openai.baseURL || '';
    if (process.env.DEEPINFRA_API_KEY && this.config.openai.apiKey === process.env.DEEPINFRA_API_KEY) return 'deepinfra';
    if (process.env.AZURE_OPENAI_API_KEY && this.config.openai.apiKey === process.env.AZURE_OPENAI_API_KEY) return 'azure-openai';
    if (/deepinfra\.com/i.test(baseURL)) return 'deepinfra';
    if (baseURL) return this.ollamaBaseURL ? 'ollama' : 'openai-compatible';
    return 'openai';
  }

  get available(): boolean {
    return !!this.config.openai.apiKey;
  }

  async generateDescription(context: AIAnalysisContext): Promise<string> {
    const prompt = prompts.generateDescriptionPrompt(context);
    const requestedMaxTokens = Number(context.additionalContext?.maxTokens || context.additionalContext?.max_tokens || '');
    const responseFormat = context.additionalContext?.responseFormat === 'json' || context.additionalContext?.response_format === 'json'
      ? 'json'
      : 'text';
    
    try {
      const response = await this.makeRequest(prompt, {
        temperature: 0.3,
        maxTokens: Number.isFinite(requestedMaxTokens) && requestedMaxTokens > 0
          ? requestedMaxTokens
          : Math.max(500, this.config.openai.maxTokens),
        systemPrompt: prompts.systemPrompts.description,
        responseFormat,
        model: typeof context.additionalContext?.model === 'string' ? context.additionalContext.model : undefined,
      });

      return this.extractContent(response);
    } catch (error) {
      this.logger.error('Failed to generate description:', error);
      throw error;
    }
  }

  async assessRisk(context: AIAnalysisContext): Promise<AIRiskAssessment> {
    const prompt = prompts.generateRiskAssessmentPrompt(context);
    
    try {
      const response = await this.makeRequest(prompt, {
        temperature: 0.2,
        maxTokens: 1000,
        systemPrompt: prompts.systemPrompts.riskAssessment,
        responseFormat: 'json'
      });

      const content = this.extractContent(response);
      return this.parseRiskAssessment(content);
    } catch (error) {
      this.logger.error('Failed to assess risk:', error);
      throw error;
    }
  }

  async generateRecommendations(context: AIAnalysisContext): Promise<AIRecommendation[]> {
    const prompt = prompts.generateRecommendationsPrompt(context);
    
    try {
      const response = await this.makeRequest(prompt, {
        temperature: 0.4,
        maxTokens: 1500,
        systemPrompt: prompts.systemPrompts.recommendations,
        responseFormat: 'json'
      });

      const content = this.extractContent(response);
      return this.parseRecommendations(content);
    } catch (error) {
      this.logger.error('Failed to generate recommendations:', error);
      throw error;
    }
  }

  async analyzeCode(context: AIAnalysisContext): Promise<AICodeAnalysis> {
    if (!context.code) {
      throw new Error('Code context is required for code analysis');
    }

    const prompt = prompts.generateCodeAnalysisPrompt(context);
    
    try {
      const response = await this.makeRequest(prompt, {
        temperature: 0.2,
        maxTokens: 2000,
        systemPrompt: prompts.systemPrompts.codeAnalysis,
        responseFormat: 'json'
      });

      const content = this.extractContent(response);
      return this.parseCodeAnalysis(content);
    } catch (error) {
      this.logger.error('Failed to analyze code:', error);
      throw error;
    }
  }

  private async makeRequest(
    prompt: string, 
    options: {
      temperature?: number;
      maxTokens?: number;
      systemPrompt?: string;
      responseFormat?: 'text' | 'json';
      model?: string;
    } = {}
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const {
      temperature = this.config.openai.temperature,
      maxTokens = this.config.openai.maxTokens,
      systemPrompt,
      responseFormat = 'text',
      model
    } = options;

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

    if (systemPrompt) {
      messages.push({
        role: 'system',
        content: systemPrompt
      });
    }

    messages.push({
      role: 'user',
      content: prompt
    });

    // Per-call model override: structured-extraction calls (capability catalog /
    // workspace merge) can point at a faster, more reliable model than the prose
    // model via options.model, since shared 70B inference latency is highly
    // variable and those calls are on the analysis critical path.
    const requestParams: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
      model: model || this.config.openai.model,
      messages,
      temperature,
      max_tokens: maxTokens,
    };

    if (responseFormat === 'json') {
      requestParams.response_format = { type: 'json_object' };
    }

    if (this.ollamaBaseURL) {
      return await this.makeOllamaRequest(messages, requestParams, responseFormat);
    }

    return await pRetry(
      async () => {
        this.logger.debug(`Making OpenAI request with model ${this.config.openai.model}`);
        const start = Date.now();
        
        const response = await this.client.chat.completions.create(requestParams);
        
        const duration = Date.now() - start;
        this.logger.debug(`OpenAI request completed in ${duration}ms`);
        
        // Log token usage for cost tracking
        if (response.usage) {
          this.logger.info('Token usage:', {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens
          });
        }

        return response;
      },
      {
        retries: Math.max(0, Number(process.env.KLAURO_OLLAMA_MAX_RETRIES ?? this.config.openai.maxRetries)),
        onFailedAttempt: (error) => {
          this.logger.warn(`OpenAI request attempt ${error.attemptNumber} failed:`, error.message);
        },
        factor: 2,
        minTimeout: 1000,
        maxTimeout: 30000,
      }
    );
  }

  private async makeOllamaRequest(
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    requestParams: OpenAI.Chat.Completions.ChatCompletionCreateParams,
    responseFormat: 'text' | 'json',
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const timeoutMs = Math.max(
      1,
      Number(process.env.KLAURO_OLLAMA_TIMEOUT_MS || this.config.openai.timeout || 60000)
    );

    return await pRetry(
      async () => {
        this.logger.debug(`Making Ollama request with model ${this.config.openai.model}`);
        const start = Date.now();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        timeout.unref?.();

        let response: Response;
        try {
          response = await fetch(`${this.ollamaBaseURL}/api/chat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              model: this.config.openai.model,
              messages: messages.map(message => ({
                role: message.role,
                content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
              })),
              stream: false,
              think: process.env.OLLAMA_THINK === 'true' || process.env.OLLAMA_THINK === '1',
              format: responseFormat === 'json' ? 'json' : undefined,
              options: {
                temperature: requestParams.temperature ?? this.config.openai.temperature,
                num_predict: requestParams.max_tokens ?? this.config.openai.maxTokens,
              },
            }),
          });
        } catch (error) {
          if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError') {
            throw new Error(`Ollama request timed out after ${timeoutMs}ms`);
          }
          throw error;
        } finally {
          clearTimeout(timeout);
        }

        const body = await response.json().catch(() => ({})) as Record<string, any>;
        if (!response.ok) {
          throw new Error(`Ollama returned ${response.status}: ${JSON.stringify(body)}`);
        }

        const content = typeof body.message?.content === 'string' ? body.message.content : '';
        const duration = Date.now() - start;
        this.logger.debug(`Ollama request completed in ${duration}ms`);

        return {
          id: `ollama-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: this.config.openai.model,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content,
            },
            finish_reason: body.done_reason || 'stop',
          }],
          usage: {
            prompt_tokens: body.prompt_eval_count || 0,
            completion_tokens: body.eval_count || 0,
            total_tokens: (body.prompt_eval_count || 0) + (body.eval_count || 0),
          },
        } as OpenAI.Chat.Completions.ChatCompletion;
      },
      {
        retries: Math.max(0, Number(process.env.KLAURO_OLLAMA_MAX_RETRIES ?? this.config.openai.maxRetries)),
        onFailedAttempt: (error) => {
          this.logger.warn(`Ollama request attempt ${error.attemptNumber} failed:`, error.message);
        },
        factor: 2,
        minTimeout: 1000,
        maxTimeout: 30000,
      }
    );
  }

  private extractContent(response: OpenAI.Chat.Completions.ChatCompletion): string {
    const choice = response.choices[0];
    if (!choice || !choice.message?.content) {
      throw new Error('No content in OpenAI response');
    }

    return choice.message.content.trim();
  }

  private parseRiskAssessment(content: string): AIRiskAssessment {
    try {
      const parsed = JSON.parse(content);
      
      return {
        riskLevel: parsed.riskLevel || 'low',
        confidence: parsed.confidence || 0.5,
        reasons: Array.isArray(parsed.reasons) ? parsed.reasons : [],
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
        categories: Array.isArray(parsed.categories) ? parsed.categories : []
      };
    } catch (error) {
      this.logger.warn('Failed to parse risk assessment JSON, using fallback');
      
      // Fallback parsing - extract key information from text
      return {
        riskLevel: this.extractRiskLevel(content),
        confidence: 0.6,
        reasons: this.extractList(content, 'reason'),
        suggestions: this.extractList(content, 'suggest'),
        categories: []
      };
    }
  }

  private parseRecommendations(content: string): AIRecommendation[] {
    try {
      const parsed = JSON.parse(content);
      
      if (!Array.isArray(parsed.recommendations)) {
        return [];
      }

      return parsed.recommendations.map((rec: any) => ({
        type: rec.type || 'architectural',
        priority: rec.priority || 'medium',
        title: rec.title || 'Recommendation',
        description: rec.description || '',
        implementation: rec.implementation || '',
        impact: rec.impact || '',
        effort: rec.effort || 'medium',
        confidence: rec.confidence || 0.7,
        tags: Array.isArray(rec.tags) ? rec.tags : []
      }));
    } catch (error) {
      this.logger.warn('Failed to parse recommendations JSON, using fallback');
      
      // Fallback: extract basic recommendations from text
      const lines = content.split('\n').filter(line => line.trim());
      const recommendations: AIRecommendation[] = [];
      
      for (const line of lines) {
        if (line.match(/^\d+\.|\-|\*/)) {
          recommendations.push({
            type: 'architectural',
            priority: 'medium',
            title: line.replace(/^\d+\.|\-|\*/, '').trim(),
            description: line.trim(),
            implementation: 'See description',
            impact: 'Moderate improvement expected',
            effort: 'medium',
            confidence: 0.6,
            tags: []
          });
        }
      }
      
      return recommendations;
    }
  }

  private parseCodeAnalysis(content: string): AICodeAnalysis {
    try {
      const parsed = JSON.parse(content);
      
      return {
        summary: parsed.summary || 'Code analysis completed',
        complexity: {
          cognitive: parsed.complexity?.cognitive || 1,
          cyclomatic: parsed.complexity?.cyclomatic || 1,
          maintainability: parsed.complexity?.maintainability || 8
        },
        patterns: Array.isArray(parsed.patterns) ? parsed.patterns : [],
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
        testability: parsed.testability || 7,
        documentation: parsed.documentation || 'No additional documentation generated'
      };
    } catch (error) {
      this.logger.warn('Failed to parse code analysis JSON, using fallback');
      
      return {
        summary: 'Basic analysis completed - JSON parsing failed',
        complexity: {
          cognitive: 5,
          cyclomatic: 3,
          maintainability: 6
        },
        patterns: [],
        issues: [],
        suggestions: [],
        testability: 5,
        documentation: content.substring(0, 500) + '...'
      };
    }
  }

  private extractRiskLevel(content: string): 'low' | 'medium' | 'high' | 'critical' {
    const lowerContent = content.toLowerCase();
    
    if (lowerContent.includes('critical') || lowerContent.includes('severe')) {
      return 'critical';
    } else if (lowerContent.includes('high')) {
      return 'high';
    } else if (lowerContent.includes('medium') || lowerContent.includes('moderate')) {
      return 'medium';
    }
    
    return 'low';
  }

  private extractList(content: string, keyword: string): string[] {
    const lines = content.split('\n');
    const items: string[] = [];
    
    for (const line of lines) {
      if (line.toLowerCase().includes(keyword)) {
        const cleaned = line.replace(/^\d+\.|\-|\*/, '').trim();
        if (cleaned) {
          items.push(cleaned);
        }
      }
    }
    
    return items;
  }
}
