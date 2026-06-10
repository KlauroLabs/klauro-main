import Anthropic from '@anthropic-ai/sdk';
import { AIProvider, AIAnalysisContext, AIRiskAssessment, AIRecommendation, AICodeAnalysis } from '../ai-service';
import { AIConfig } from '../../config/ai.config';
import { prompts } from '../ai-prompts';
import * as winston from 'winston';
import pRetry from 'p-retry';

export class ClaudeProvider implements AIProvider {
  public readonly name = 'claude';
  private client: Anthropic;
  private logger: winston.Logger;
  private config: AIConfig;

  constructor(config: AIConfig) {
    this.config = config;
    
    if (!config.anthropic.apiKey) {
      throw new Error('Anthropic API key is required');
    }

    this.client = new Anthropic({
      apiKey: config.anthropic.apiKey,
      timeout: config.anthropic.timeout,
      maxRetries: config.anthropic.maxRetries,
    });

    this.logger = winston.createLogger({
      level: process.env.KLAURO_LOG_LEVEL || 'warn',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      defaultMeta: { provider: 'claude' },
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
    return !!this.config.anthropic.apiKey;
  }

  async generateDescription(context: AIAnalysisContext): Promise<string> {
    const prompt = prompts.generateDescriptionPrompt(context);
    const systemPrompt = prompts.systemPrompts.description;
    
    try {
      const response = await this.makeRequest(prompt, {
        temperature: 0.3,
        maxTokens: 500,
        systemPrompt
      });

      return this.extractContent(response);
    } catch (error) {
      this.logger.error('Failed to generate description:', error);
      throw error;
    }
  }

  async assessRisk(context: AIAnalysisContext): Promise<AIRiskAssessment> {
    const prompt = prompts.generateRiskAssessmentPrompt(context);
    const systemPrompt = prompts.systemPrompts.riskAssessment + '\n\nPlease respond with valid JSON only.';
    
    try {
      const response = await this.makeRequest(prompt, {
        temperature: 0.2,
        maxTokens: 1000,
        systemPrompt
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
    const systemPrompt = prompts.systemPrompts.recommendations + '\n\nPlease respond with valid JSON only.';
    
    try {
      const response = await this.makeRequest(prompt, {
        temperature: 0.4,
        maxTokens: 1500,
        systemPrompt
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
    const systemPrompt = prompts.systemPrompts.codeAnalysis + '\n\nPlease respond with valid JSON only.';
    
    try {
      const response = await this.makeRequest(prompt, {
        temperature: 0.2,
        maxTokens: 2000,
        systemPrompt
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
    } = {}
  ): Promise<Anthropic.Messages.Message> {
    const {
      temperature = this.config.anthropic.temperature,
      maxTokens = this.config.anthropic.maxTokens,
      systemPrompt
    } = options;

    const requestParams: Anthropic.Messages.MessageCreateParams = {
      model: this.config.anthropic.model,
      max_tokens: maxTokens,
      temperature,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    };

    if (systemPrompt) {
      requestParams.system = systemPrompt;
    }

    return await pRetry(
      async () => {
        this.logger.debug(`Making Claude request with model ${this.config.anthropic.model}`);
        const start = Date.now();
        
        const response = await this.client.messages.create(requestParams);
        
        const duration = Date.now() - start;
        this.logger.debug(`Claude request completed in ${duration}ms`);
        
        // Log token usage for cost tracking
        if (response.usage) {
          this.logger.info('Token usage:', {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens
          });
        }

        return response;
      },
      {
        retries: this.config.anthropic.maxRetries,
        onFailedAttempt: (error) => {
          this.logger.warn(`Claude request attempt ${error.attemptNumber} failed:`, error.message);
        },
        factor: 2,
        minTimeout: 1000,
        maxTimeout: 30000,
      }
    );
  }

  private extractContent(response: Anthropic.Messages.Message): string {
    if (!response.content || response.content.length === 0) {
      throw new Error('No content in Claude response');
    }

    // Claude returns an array of content blocks
    const textBlocks = response.content.filter(
      (block): block is Anthropic.Messages.TextBlock => block.type === 'text'
    );

    if (textBlocks.length === 0) {
      throw new Error('No text content in Claude response');
    }

    return textBlocks.map(block => block.text).join('\n').trim();
  }

  private parseRiskAssessment(content: string): AIRiskAssessment {
    try {
      // Try to extract JSON from the response (Claude sometimes wraps JSON in backticks)
      const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/) || content.match(/(\{[\s\S]*\})/);
      const jsonStr = jsonMatch ? jsonMatch[1] : content;
      
      const parsed = JSON.parse(jsonStr);
      
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
      // Try to extract JSON from the response
      const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/) || content.match(/(\{[\s\S]*\})/);
      const jsonStr = jsonMatch ? jsonMatch[1] : content;
      
      const parsed = JSON.parse(jsonStr);
      
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
      // Try to extract JSON from the response
      const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/) || content.match(/(\{[\s\S]*\})/);
      const jsonStr = jsonMatch ? jsonMatch[1] : content;
      
      const parsed = JSON.parse(jsonStr);
      
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
