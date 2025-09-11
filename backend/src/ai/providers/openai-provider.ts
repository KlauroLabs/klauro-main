import OpenAI from 'openai';
import pLimit from 'p-limit';
import pRetry from 'p-retry';
import { aiConfig } from '../../config/ai.config';

export interface AIResponse {
  content: string;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  cost: number;
  provider: string;
  cached?: boolean;
}

export interface AIRequest {
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  responseFormat?: 'json' | 'text';
  context?: Record<string, any>;
}

export class OpenAIProvider {
  private client: OpenAI | null = null;
  private rateLimiter: ReturnType<typeof pLimit>;
  private tokenUsage = {
    current: 0,
    resetTime: Date.now() + 60000,
  };
  
  constructor(private config = aiConfig.openai) {
    if (config.apiKey) {
      this.client = new OpenAI({
        apiKey: config.apiKey,
        organization: config.organization,
        timeout: config.timeout,
      });
    }
    
    this.rateLimiter = pLimit(config.rateLimit.requestsPerMinute);
  }
  
  isAvailable(): boolean {
    return this.client !== null;
  }
  
  private checkTokenLimit(estimatedTokens: number): void {
    const now = Date.now();
    
    if (now > this.tokenUsage.resetTime) {
      this.tokenUsage.current = 0;
      this.tokenUsage.resetTime = now + 60000;
    }
    
    if (this.tokenUsage.current + estimatedTokens > this.config.rateLimit.tokensPerMinute) {
      throw new Error('Token rate limit exceeded. Please try again later.');
    }
  }
  
  private calculateCost(model: string, inputTokens: number, outputTokens: number): number {
    const pricing = aiConfig.costTracking.pricing.openai;
    const modelPricing = pricing[model as keyof typeof pricing];
    
    if (!modelPricing) {
      console.warn(`No pricing information for model ${model}`);
      return 0;
    }
    
    const inputCost = (inputTokens / 1000) * modelPricing.input;
    const outputCost = (outputTokens / 1000) * modelPricing.output;
    
    return inputCost + outputCost;
  }
  
  async complete(request: AIRequest): Promise<AIResponse> {
    if (!this.client) {
      throw new Error('OpenAI client not initialized. Please provide an API key.');
    }
    
    const estimatedInputTokens = Math.ceil(request.prompt.length / 4);
    this.checkTokenLimit(estimatedInputTokens + (request.maxTokens || this.config.maxTokens));
    
    return this.rateLimiter(async () => {
      return pRetry(
        async () => {
          const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
          
          if (request.systemPrompt) {
            messages.push({
              role: 'system',
              content: request.systemPrompt,
            });
          }
          
          messages.push({
            role: 'user',
            content: request.prompt,
          });
          
          const completion = await this.client!.chat.completions.create({
            model: this.config.model,
            messages,
            max_tokens: request.maxTokens || this.config.maxTokens,
            temperature: request.temperature ?? this.config.temperature,
            response_format: request.responseFormat === 'json' 
              ? { type: 'json_object' } 
              : undefined,
          });
          
          const response = completion.choices[0];
          const usage = completion.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
          
          this.tokenUsage.current += usage.total_tokens;
          
          const cost = this.calculateCost(
            this.config.model,
            usage.prompt_tokens,
            usage.completion_tokens
          );
          
          return {
            content: response.message?.content || '',
            model: this.config.model,
            usage: {
              inputTokens: usage.prompt_tokens,
              outputTokens: usage.completion_tokens,
              totalTokens: usage.total_tokens,
            },
            cost,
            provider: 'openai',
          };
        },
        {
          retries: this.config.maxRetries,
          onFailedAttempt: (error) => {
            const errorMessage = (error as any).message || error.toString();
            console.warn(`OpenAI API attempt ${error.attemptNumber} failed:`, errorMessage);
            
            if (errorMessage.includes('rate_limit')) {
              const delay = Math.min(1000 * Math.pow(2, error.attemptNumber), 30000);
              return new Promise(resolve => setTimeout(resolve, delay));
            }
          },
        }
      );
    });
  }
  
  async analyzeCode(
    code: string,
    analysis: 'description' | 'risks' | 'improvements' | 'security' | 'performance',
    context?: Record<string, any>
  ): Promise<AIResponse> {
    const prompts = {
      description: `Analyze this code and provide a clear, concise description of what it does, its purpose, and key functionality. Focus on business logic and architectural significance.`,
      risks: `Identify potential risks, vulnerabilities, and problematic patterns in this code. Consider security, performance, maintainability, and reliability issues.`,
      improvements: `Suggest architectural and code improvements for this component. Focus on design patterns, best practices, and maintainability.`,
      security: `Perform a security analysis of this code. Identify vulnerabilities, insecure patterns, and provide specific remediation suggestions.`,
      performance: `Analyze the performance characteristics of this code. Identify bottlenecks, inefficiencies, and suggest optimizations.`,
    };
    
    const systemPrompt = `You are an expert software architect analyzing code for the Unravl platform. 
Provide detailed, actionable insights focused on ${analysis}.
${context ? `Context: ${JSON.stringify(context)}` : ''}

Code to analyze:`;
    
    const request: AIRequest = {
      prompt: `${prompts[analysis]}\n\n\`\`\`\n${code}\n\`\`\``,
      systemPrompt,
      responseFormat: 'json',
      context,
    };
    
    return this.complete(request);
  }
  
  async generateDocumentation(
    component: any,
    format: 'markdown' | 'jsdoc' | 'inline'
  ): Promise<AIResponse> {
    const systemPrompt = `You are a technical documentation expert. Generate clear, comprehensive documentation for code components.`;
    
    const formatInstructions = {
      markdown: 'Generate Markdown documentation with sections for Overview, Usage, API, and Examples.',
      jsdoc: 'Generate JSDoc/TSDoc comments following standard conventions.',
      inline: 'Generate inline code comments explaining complex logic and decisions.',
    };
    
    const request: AIRequest = {
      prompt: `Generate ${format} documentation for this component:\n\n${JSON.stringify(component, null, 2)}\n\n${formatInstructions[format]}`,
      systemPrompt,
      maxTokens: 3000,
    };
    
    return this.complete(request);
  }
  
  async assessArchitecture(
    blueprint: any,
    focusArea?: 'scalability' | 'security' | 'maintainability' | 'performance'
  ): Promise<AIResponse> {
    const systemPrompt = `You are a senior solutions architect reviewing system architecture. 
Provide strategic insights and recommendations ${focusArea ? `focusing on ${focusArea}` : ''}.`;
    
    const request: AIRequest = {
      prompt: `Assess this system architecture and provide recommendations:\n\n${JSON.stringify(blueprint, null, 2)}`,
      systemPrompt,
      responseFormat: 'json',
      maxTokens: 4000,
    };
    
    return this.complete(request);
  }
  
  getUsageStats() {
    return {
      tokenUsage: this.tokenUsage,
      rateLimitRemaining: this.config.rateLimit.requestsPerMinute - this.rateLimiter.pendingCount,
      provider: 'openai',
      model: this.config.model,
    };
  }
}