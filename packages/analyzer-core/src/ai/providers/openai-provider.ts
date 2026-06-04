import OpenAI from 'openai';
import { AIProvider, AIAnalysisContext, AIRiskAssessment, AIRecommendation, AICodeAnalysis } from '../ai-service';
import { AIConfig } from '../../config/ai.config';
import { prompts } from '../ai-prompts';
import * as winston from 'winston';
import pRetry from 'p-retry';

export class OpenAIProvider implements AIProvider {
  public readonly name = 'openai';
  private client: OpenAI;
  private logger: winston.Logger;
  private config: AIConfig;

  constructor(config: AIConfig) {
    this.config = config;
    
    if (!config.openai.apiKey) {
      throw new Error('OpenAI API key is required');
    }

    this.client = new OpenAI({
      apiKey: config.openai.apiKey,
      organization: config.openai.organization,
      timeout: config.openai.timeout,
      maxRetries: config.openai.maxRetries,
    });

    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      defaultMeta: { provider: 'openai' },
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

  get available(): boolean {
    return !!this.config.openai.apiKey;
  }

  async generateDescription(context: AIAnalysisContext): Promise<string> {
    const prompt = prompts.generateDescriptionPrompt(context);
    
    try {
      const response = await this.makeRequest(prompt, {
        temperature: 0.3,
        maxTokens: 500,
        systemPrompt: prompts.systemPrompts.description
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
    } = {}
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const {
      temperature = this.config.openai.temperature,
      maxTokens = this.config.openai.maxTokens,
      systemPrompt,
      responseFormat = 'text'
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

    const requestParams: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
      model: this.config.openai.model,
      messages,
      temperature,
      max_tokens: maxTokens,
    };

    if (responseFormat === 'json') {
      requestParams.response_format = { type: 'json_object' };
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
        retries: this.config.openai.maxRetries,
        onFailedAttempt: (error) => {
          this.logger.warn(`OpenAI request attempt ${error.attemptNumber} failed:`, error.message);
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
