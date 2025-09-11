import { HfInference } from '@huggingface/inference';
import pLimit from 'p-limit';
import pRetry from 'p-retry';
import { aiConfig } from '../../config/ai.config';
import { AIRequest, AIResponse } from './openai-provider';

export class FallbackProvider {
  private hfClient: HfInference | null = null;
  private rateLimiter: ReturnType<typeof pLimit>;
  private localPatterns: Map<string, (code: string) => any>;
  
  constructor(private config = aiConfig.huggingface) {
    if (config.apiKey) {
      this.hfClient = new HfInference(config.apiKey);
    }
    
    this.rateLimiter = pLimit(10); // Conservative rate limit for free tier
    this.localPatterns = this.initializeLocalPatterns();
  }
  
  private initializeLocalPatterns(): Map<string, (code: string) => any> {
    const patterns = new Map();
    
    // Simple pattern-based analysis for when AI is unavailable
    patterns.set('complexity', (code: string) => {
      const lines = code.split('\n').filter(l => l.trim().length > 0);
      const functions = (code.match(/function\s+\w+|=>\s*{|async\s+\w+/g) || []).length;
      const conditions = (code.match(/if\s*\(|switch\s*\(|\?\s*:/g) || []).length;
      const loops = (code.match(/for\s*\(|while\s*\(|\.map\(|\.forEach\(/g) || []).length;
      
      const complexity = functions * 2 + conditions * 1.5 + loops * 2;
      
      return {
        linesOfCode: lines.length,
        functions,
        conditions,
        loops,
        complexityScore: Math.min(10, complexity / 10),
        assessment: complexity > 50 ? 'high' : complexity > 20 ? 'medium' : 'low',
      };
    });
    
    patterns.set('security', (code: string) => {
      const issues = [];
      
      // Check for common security patterns
      if (code.includes('eval(') || code.includes('Function(')) {
        issues.push({ type: 'critical', message: 'Potential code injection via eval()' });
      }
      
      if (code.match(/innerHTML\s*=/)) {
        issues.push({ type: 'high', message: 'Potential XSS via innerHTML' });
      }
      
      if (code.match(/password|secret|key|token/i) && code.match(/["'`][\w\d]{8,}/)) {
        issues.push({ type: 'critical', message: 'Potential hardcoded secrets detected' });
      }
      
      if (code.includes('http://') && !code.includes('localhost')) {
        issues.push({ type: 'medium', message: 'Insecure HTTP protocol usage' });
      }
      
      if (code.match(/SELECT.*FROM.*WHERE/i) && code.includes('${') || code.includes('" +')) {
        issues.push({ type: 'critical', message: 'Potential SQL injection vulnerability' });
      }
      
      if (!code.match(/try\s*{/) && code.match(/async|await|Promise/)) {
        issues.push({ type: 'low', message: 'Missing error handling for async operations' });
      }
      
      return {
        vulnerabilities: issues,
        securityScore: Math.max(0, 10 - issues.filter(i => i.type === 'critical').length * 3 - issues.filter(i => i.type === 'high').length * 2),
        recommendations: this.generateSecurityRecommendations(issues),
      };
    });
    
    patterns.set('performance', (code: string) => {
      const issues = [];
      
      // Check for performance anti-patterns
      if (code.match(/for.*for|map.*map|filter.*filter/)) {
        issues.push('Nested loops detected - consider optimization');
      }
      
      if (code.match(/await.*for\s*\(|await.*\.forEach/)) {
        issues.push('Sequential async operations - consider Promise.all()');
      }
      
      if (code.match(/document\.querySelector|getElementById/g)?.length > 5) {
        issues.push('Multiple DOM queries - consider caching elements');
      }
      
      if (code.includes('JSON.parse') && code.includes('JSON.stringify')) {
        issues.push('JSON serialization overhead - consider alternatives');
      }
      
      if (code.match(/new RegExp/g)?.length > 3) {
        issues.push('Multiple RegExp instantiations - consider caching');
      }
      
      return {
        issues,
        performanceScore: Math.max(0, 10 - issues.length * 2),
        suggestions: this.generatePerformanceSuggestions(issues),
      };
    });
    
    return patterns;
  }
  
  private generateSecurityRecommendations(issues: any[]): string[] {
    const recommendations = [];
    
    if (issues.some(i => i.message.includes('injection'))) {
      recommendations.push('Use parameterized queries or prepared statements');
      recommendations.push('Implement input validation and sanitization');
    }
    
    if (issues.some(i => i.message.includes('XSS'))) {
      recommendations.push('Use textContent instead of innerHTML when possible');
      recommendations.push('Sanitize user input before rendering');
    }
    
    if (issues.some(i => i.message.includes('secrets'))) {
      recommendations.push('Use environment variables for sensitive data');
      recommendations.push('Implement proper secret management');
    }
    
    return recommendations;
  }
  
  private generatePerformanceSuggestions(issues: string[]): string[] {
    const suggestions = [];
    
    if (issues.some(i => i.includes('Nested loops'))) {
      suggestions.push('Consider using Map/Set for O(1) lookups');
      suggestions.push('Optimize algorithm complexity');
    }
    
    if (issues.some(i => i.includes('Sequential async'))) {
      suggestions.push('Use Promise.all() for parallel execution');
      suggestions.push('Consider batching operations');
    }
    
    if (issues.some(i => i.includes('DOM queries'))) {
      suggestions.push('Cache DOM references in variables');
      suggestions.push('Use event delegation for dynamic elements');
    }
    
    return suggestions;
  }
  
  isAvailable(): boolean {
    return true; // Always available as fallback
  }
  
  async complete(request: AIRequest): Promise<AIResponse> {
    // Try HuggingFace first if available
    if (this.hfClient && this.config.apiKey) {
      try {
        return await this.completeWithHuggingFace(request);
      } catch (error) {
        console.warn('HuggingFace completion failed, using local patterns:', error);
      }
    }
    
    // Fall back to local pattern matching
    return this.completeWithLocalPatterns(request);
  }
  
  private async completeWithHuggingFace(request: AIRequest): Promise<AIResponse> {
    return this.rateLimiter(async () => {
      return pRetry(
        async () => {
          const response = await this.hfClient!.textGeneration({
            model: this.config.model,
            inputs: `${request.systemPrompt || ''}\n\n${request.prompt}`,
            parameters: {
              max_new_tokens: request.maxTokens || 500,
              temperature: request.temperature || 0.7,
              return_full_text: false,
            },
          });
          
          const content = response.generated_text;
          const estimatedTokens = Math.ceil(content.length / 4);
          
          return {
            content,
            model: this.config.model,
            usage: {
              inputTokens: Math.ceil(request.prompt.length / 4),
              outputTokens: estimatedTokens,
              totalTokens: Math.ceil(request.prompt.length / 4) + estimatedTokens,
            },
            cost: 0, // Free tier
            provider: 'huggingface',
          };
        },
        {
          retries: this.config.maxRetries,
          onFailedAttempt: (error) => {
            const errorMessage = (error as any).message || error.toString();
            console.warn(`HuggingFace attempt ${error.attemptNumber} failed:`, errorMessage);
          },
        }
      );
    });
  }
  
  private async completeWithLocalPatterns(request: AIRequest): Promise<AIResponse> {
    // Extract code from the prompt
    const codeMatch = request.prompt.match(/```[\s\S]*?```/);
    const code = codeMatch ? codeMatch[0].replace(/```/g, '').trim() : request.prompt;
    
    // Determine analysis type from prompt
    let analysisType = 'complexity';
    if (request.prompt.toLowerCase().includes('security') || request.prompt.toLowerCase().includes('vulnerabilit')) {
      analysisType = 'security';
    } else if (request.prompt.toLowerCase().includes('performance') || request.prompt.toLowerCase().includes('optimiz')) {
      analysisType = 'performance';
    }
    
    const analyzer = this.localPatterns.get(analysisType);
    const result = analyzer ? analyzer(code) : { message: 'Basic analysis completed' };
    
    return {
      content: JSON.stringify(result, null, 2),
      model: 'local-patterns',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      cost: 0,
      provider: 'fallback',
    };
  }
  
  async analyzeCode(
    code: string,
    analysis: 'description' | 'risks' | 'improvements' | 'security' | 'performance',
    context?: Record<string, any>
  ): Promise<AIResponse> {
    const analysisMap = {
      description: 'complexity',
      risks: 'security',
      improvements: 'performance',
      security: 'security',
      performance: 'performance',
    };
    
    const analyzer = this.localPatterns.get(analysisMap[analysis]);
    if (!analyzer) {
      return {
        content: JSON.stringify({ error: 'Analysis not available in fallback mode' }),
        model: 'local-patterns',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        cost: 0,
        provider: 'fallback',
      };
    }
    
    const result = analyzer(code);
    
    // Add context if provided
    if (context) {
      result.context = context;
    }
    
    return {
      content: JSON.stringify(result, null, 2),
      model: 'local-patterns',
      usage: {
        inputTokens: Math.ceil(code.length / 4),
        outputTokens: Math.ceil(JSON.stringify(result).length / 4),
        totalTokens: Math.ceil(code.length / 4) + Math.ceil(JSON.stringify(result).length / 4),
      },
      cost: 0,
      provider: 'fallback',
    };
  }
  
  async generateDocumentation(component: any, format: string): Promise<AIResponse> {
    // Simple documentation generation
    const doc = {
      name: component.name || 'Component',
      description: `Automatically generated documentation for ${component.name || 'component'}`,
      properties: Object.keys(component).map(key => ({
        name: key,
        type: typeof component[key],
        value: typeof component[key] === 'object' ? '[Object]' : component[key],
      })),
      generated: new Date().toISOString(),
      format,
    };
    
    return {
      content: JSON.stringify(doc, null, 2),
      model: 'local-patterns',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      cost: 0,
      provider: 'fallback',
    };
  }
  
  async assessArchitecture(blueprint: any, focusArea?: string): Promise<AIResponse> {
    // Basic architecture assessment
    const assessment = {
      components: blueprint.components?.length || 0,
      connections: blueprint.connections?.length || 0,
      complexity: this.calculateArchitecturalComplexity(blueprint),
      risks: this.identifyArchitecturalRisks(blueprint),
      focusArea,
      recommendations: [
        'Consider implementing proper error boundaries',
        'Ensure consistent logging and monitoring',
        'Review dependency management strategy',
        'Implement proper caching strategies',
      ],
    };
    
    return {
      content: JSON.stringify(assessment, null, 2),
      model: 'local-patterns',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      cost: 0,
      provider: 'fallback',
    };
  }
  
  private calculateArchitecturalComplexity(blueprint: any): string {
    const components = blueprint.components?.length || 0;
    const connections = blueprint.connections?.length || 0;
    const ratio = connections / Math.max(1, components);
    
    if (ratio > 3) return 'high';
    if (ratio > 1.5) return 'medium';
    return 'low';
  }
  
  private identifyArchitecturalRisks(blueprint: any): string[] {
    const risks = [];
    
    if (blueprint.orphanedComponents?.length > 0) {
      risks.push('Orphaned components detected');
    }
    
    if (blueprint.riskAreas?.some((r: any) => r.riskLevel === 'high')) {
      risks.push('High-risk areas identified in architecture');
    }
    
    const components = blueprint.components || [];
    const highComplexity = components.filter((c: any) => c.metadata?.complexity > 7);
    if (highComplexity.length > 0) {
      risks.push(`${highComplexity.length} high-complexity components detected`);
    }
    
    return risks;
  }
  
  getUsageStats() {
    return {
      provider: 'fallback',
      model: this.hfClient ? this.config.model : 'local-patterns',
      available: true,
      costEffective: true,
    };
  }
}