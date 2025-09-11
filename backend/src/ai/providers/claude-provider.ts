import Anthropic from '@anthropic-ai/sdk';
import pLimit from 'p-limit';
import pRetry from 'p-retry';
import { aiConfig } from '../../config/ai.config';
import { AIRequest, AIResponse } from './openai-provider';

export class ClaudeProvider {
  private client: Anthropic | null = null;
  private rateLimiter: ReturnType<typeof pLimit>;
  private tokenUsage = {
    current: 0,
    resetTime: Date.now() + 60000,
  };
  
  constructor(private config = aiConfig.anthropic) {
    if (config.apiKey) {
      this.client = new Anthropic({
        apiKey: config.apiKey,
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
    const pricing = aiConfig.costTracking.pricing.anthropic;
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
      throw new Error('Anthropic client not initialized. Please provide an API key.');
    }
    
    const estimatedInputTokens = Math.ceil(request.prompt.length / 4);
    this.checkTokenLimit(estimatedInputTokens + (request.maxTokens || this.config.maxTokens));
    
    return this.rateLimiter(async () => {
      return pRetry(
        async () => {
          const systemPrompt = request.systemPrompt || 'You are a helpful AI assistant specialized in code analysis and software architecture.';
          
          const message = await this.client!.messages.create({
            model: this.config.model,
            max_tokens: request.maxTokens || this.config.maxTokens,
            temperature: request.temperature ?? this.config.temperature,
            system: systemPrompt,
            messages: [
              {
                role: 'user',
                content: request.prompt,
              },
            ],
          });
          
          const content = message.content[0];
          const textContent = content.type === 'text' ? content.text : '';
          
          const usage = message.usage || { input_tokens: 0, output_tokens: 0 };
          const totalTokens = usage.input_tokens + usage.output_tokens;
          
          this.tokenUsage.current += totalTokens;
          
          const cost = this.calculateCost(
            this.config.model,
            usage.input_tokens,
            usage.output_tokens
          );
          
          return {
            content: textContent,
            model: this.config.model,
            usage: {
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
              totalTokens,
            },
            cost,
            provider: 'anthropic',
          };
        },
        {
          retries: this.config.maxRetries,
          onFailedAttempt: (error) => {
            const errorMessage = (error as any).message || error.toString();
            console.warn(`Anthropic API attempt ${error.attemptNumber} failed:`, errorMessage);
            
            if (errorMessage.includes('rate_limit') || errorMessage.includes('429')) {
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
    const analysisPrompts = {
      description: `Analyze this code and provide a comprehensive description of its functionality, architecture, and purpose. Focus on:
- Core business logic and objectives
- Key components and their interactions
- Data flow and processing patterns
- Integration points and dependencies`,
      
      risks: `Perform a risk assessment of this code, identifying:
- Critical vulnerabilities and security issues
- Performance bottlenecks and scalability concerns
- Maintainability problems and technical debt
- Single points of failure
- Compliance and regulatory risks`,
      
      improvements: `Suggest architectural and implementation improvements for this code:
- Design pattern recommendations
- Refactoring opportunities
- Performance optimizations
- Code organization improvements
- Best practices that should be applied`,
      
      security: `Conduct a thorough security analysis:
- Identify specific vulnerabilities (injection, XSS, CSRF, etc.)
- Authentication and authorization issues
- Data exposure and privacy concerns
- Cryptographic weaknesses
- Supply chain vulnerabilities
Provide specific remediation steps for each issue.`,
      
      performance: `Analyze performance characteristics:
- Time complexity of algorithms
- Memory usage patterns
- I/O bottlenecks
- Database query efficiency
- Caching opportunities
- Concurrency and parallelization potential`,
    };
    
    const systemPrompt = `You are Claude, an expert software architect and security analyst working with the Unravl platform.
Your analysis should be detailed, actionable, and focused on ${analysis}.
${context ? `Additional context: ${JSON.stringify(context)}` : ''}
Provide your response in JSON format with clear structure.`;
    
    const request: AIRequest = {
      prompt: `${analysisPrompts[analysis]}\n\nCode to analyze:\n\`\`\`\n${code}\n\`\`\`\n\nProvide your analysis in JSON format.`,
      systemPrompt,
      maxTokens: 3000,
      temperature: 0.2,
    };
    
    return this.complete(request);
  }
  
  async generateDocumentation(
    component: any,
    format: 'markdown' | 'jsdoc' | 'inline'
  ): Promise<AIResponse> {
    const systemPrompt = `You are a technical documentation expert creating clear, comprehensive documentation.
Focus on clarity, completeness, and following documentation best practices.`;
    
    const formatTemplates = {
      markdown: `Create comprehensive Markdown documentation with:
# Component Name
## Overview
## Installation/Setup
## API Reference
## Usage Examples
## Configuration
## Troubleshooting`,
      
      jsdoc: `Generate complete JSDoc/TSDoc comments including:
- Function/class descriptions
- @param tags with types and descriptions
- @returns descriptions
- @throws for exceptions
- @example code snippets
- @see references`,
      
      inline: `Add helpful inline comments that:
- Explain complex algorithms
- Clarify business logic
- Document edge cases
- Note performance considerations
- Explain architectural decisions`,
    };
    
    const request: AIRequest = {
      prompt: `Generate ${format} documentation for:\n\n${JSON.stringify(component, null, 2)}\n\nFormat requirements:\n${formatTemplates[format]}`,
      systemPrompt,
      maxTokens: 4000,
    };
    
    return this.complete(request);
  }
  
  async assessArchitecture(
    blueprint: any,
    focusArea?: 'scalability' | 'security' | 'maintainability' | 'performance'
  ): Promise<AIResponse> {
    const focusPrompts = {
      scalability: `Focus on horizontal/vertical scaling, bottlenecks, distributed system concerns, and growth capacity.`,
      security: `Focus on attack surfaces, defense in depth, zero-trust principles, and compliance requirements.`,
      maintainability: `Focus on code organization, coupling/cohesion, technical debt, and development velocity.`,
      performance: `Focus on response times, throughput, resource utilization, and optimization opportunities.`,
    };
    
    const systemPrompt = `You are a senior solutions architect reviewing system architecture for the Unravl platform.
Provide strategic, actionable recommendations based on industry best practices and modern architectural patterns.
${focusArea ? focusPrompts[focusArea] : 'Provide a comprehensive architectural assessment.'}`;
    
    const request: AIRequest = {
      prompt: `Assess this system architecture and provide detailed recommendations:\n\n${JSON.stringify(blueprint, null, 2)}\n\nStructure your response as JSON with sections for: findings, risks, recommendations, and priorities.`,
      systemPrompt,
      responseFormat: 'json',
      maxTokens: 5000,
    };
    
    return this.complete(request);
  }
  
  async generateTestSuggestions(
    code: string,
    existingTests?: string[]
  ): Promise<AIResponse> {
    const systemPrompt = `You are a test automation expert suggesting comprehensive test strategies.`;
    
    const request: AIRequest = {
      prompt: `Suggest test cases for this code:\n\`\`\`\n${code}\n\`\`\`\n\n${
        existingTests ? `Existing tests: ${existingTests.join(', ')}` : ''
      }\n\nProvide test suggestions including unit tests, integration tests, edge cases, and error scenarios.`,
      systemPrompt,
      responseFormat: 'json',
      maxTokens: 3000,
    };
    
    return this.complete(request);
  }
  
  getUsageStats() {
    return {
      tokenUsage: this.tokenUsage,
      rateLimitRemaining: this.config.rateLimit.requestsPerMinute - this.rateLimiter.pendingCount,
      provider: 'anthropic',
      model: this.config.model,
    };
  }
}