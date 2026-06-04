import { HfInference } from '@huggingface/inference';
import { AIProvider, AIAnalysisContext, AIRiskAssessment, AIRecommendation, AICodeAnalysis, AIRiskCategory } from '../ai-service';
import { AIConfig } from '../../config/ai.config';
import * as winston from 'winston';

export class FallbackProvider implements AIProvider {
  public readonly name = 'fallback';
  private hf?: HfInference;
  private logger: winston.Logger;
  private config: AIConfig;

  constructor(config: AIConfig) {
    this.config = config;

    // Initialize Hugging Face client if API key is available
    if (config.huggingface.apiKey) {
      this.hf = new HfInference(config.huggingface.apiKey);
    }

    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      defaultMeta: { provider: 'fallback' },
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
    // Fallback is always available with local processing
    return true;
  }

  async generateDescription(context: AIAnalysisContext): Promise<string> {
    this.logger.info('Using fallback description generation');

    // Try Hugging Face first if available
    if (this.hf && context.code) {
      try {
        return await this.generateHuggingFaceDescription(context);
      } catch (error) {
        this.logger.warn('Hugging Face description generation failed, using rule-based fallback:', error);
      }
    }

    // Rule-based fallback
    return this.generateRuleBasedDescription(context);
  }

  async assessRisk(context: AIAnalysisContext): Promise<AIRiskAssessment> {
    this.logger.info('Using fallback risk assessment');

    // Try Hugging Face first if available
    if (this.hf && context.code) {
      try {
        return await this.generateHuggingFaceRiskAssessment(context);
      } catch (error) {
        this.logger.warn('Hugging Face risk assessment failed, using rule-based fallback:', error);
      }
    }

    // Rule-based fallback
    return this.generateRuleBasedRiskAssessment(context);
  }

  async generateRecommendations(context: AIAnalysisContext): Promise<AIRecommendation[]> {
    this.logger.info('Using fallback recommendation generation');

    // For recommendations, we'll use rule-based approach since it requires domain knowledge
    return this.generateRuleBasedRecommendations(context);
  }

  async analyzeCode(context: AIAnalysisContext): Promise<AICodeAnalysis> {
    this.logger.info('Using fallback code analysis');

    if (!context.code) {
      throw new Error('Code context is required for code analysis');
    }

    // Try Hugging Face first if available
    if (this.hf) {
      try {
        return await this.generateHuggingFaceCodeAnalysis(context);
      } catch (error) {
        this.logger.warn('Hugging Face code analysis failed, using rule-based fallback:', error);
      }
    }

    // Rule-based fallback
    return this.generateRuleBasedCodeAnalysis(context);
  }

  private async generateHuggingFaceDescription(context: AIAnalysisContext): Promise<string> {
    if (!this.hf || !context.code) {
      throw new Error('Hugging Face client or code not available');
    }

    const prompt = `Analyze this ${context.language || 'code'} component and provide a brief description of what it does:\n\n${context.code.substring(0, 2000)}`;

    const response = await this.hf.textGeneration({
      model: this.config.huggingface.model,
      inputs: prompt,
      parameters: {
        max_new_tokens: 150,
        temperature: 0.3,
        do_sample: true,
      },
    });

    return response.generated_text?.replace(prompt, '').trim() || 'Code component analysis';
  }

  private async generateHuggingFaceRiskAssessment(context: AIAnalysisContext): Promise<AIRiskAssessment> {
    if (!this.hf || !context.code) {
      throw new Error('Hugging Face client or code not available');
    }

    const prompt = `Analyze this code for potential risks and issues:\n\n${context.code.substring(0, 1500)}\n\nRisk level (low/medium/high):`;

    const response = await this.hf.textGeneration({
      model: this.config.huggingface.model,
      inputs: prompt,
      parameters: {
        max_new_tokens: 200,
        temperature: 0.2,
        do_sample: true,
      },
    });

    const analysis = response.generated_text?.replace(prompt, '').trim() || '';
    
    return {
      riskLevel: this.extractRiskLevelFromText(analysis),
      confidence: 0.4, // Lower confidence for simple models
      reasons: this.extractReasonsFromText(analysis),
      suggestions: this.extractSuggestionsFromText(analysis),
      categories: []
    };
  }

  private async generateHuggingFaceCodeAnalysis(context: AIAnalysisContext): Promise<AICodeAnalysis> {
    if (!this.hf || !context.code) {
      throw new Error('Hugging Face client or code not available');
    }

    const prompt = `Analyze this code for complexity, patterns, and issues:\n\n${context.code.substring(0, 1500)}`;

    const response = await this.hf.textGeneration({
      model: this.config.huggingface.model,
      inputs: prompt,
      parameters: {
        max_new_tokens: 300,
        temperature: 0.2,
        do_sample: true,
      },
    });

    const analysis = response.generated_text?.replace(prompt, '').trim() || '';

    return {
      summary: analysis.substring(0, 200) + '...',
      complexity: this.estimateComplexityFromCode(context.code),
      patterns: [],
      issues: this.extractIssuesFromText(analysis),
      suggestions: this.extractSuggestionsFromAnalysis(analysis),
      testability: this.estimateTestability(context.code),
      documentation: analysis
    };
  }

  private generateRuleBasedDescription(context: AIAnalysisContext): string {
    if (!context.component) {
      return 'Component analysis using rule-based fallback method';
    }

    const component = context.component;
    let description = `This is a ${component.type} component`;

    // Add framework-specific information
    if (component.framework) {
      description += ` built with ${component.framework}`;
    }

    // Add responsibility information
    if (component.metadata.responsibilities.length > 0) {
      description += ` that handles ${component.metadata.responsibilities.join(', ')}`;
    }

    // Add complexity information
    if (component.metadata.complexity > 7) {
      description += '. This component is highly complex';
    } else if (component.metadata.complexity > 4) {
      description += '. This component has moderate complexity';
    } else {
      description += '. This is a simple component';
    }

    // Add dependency information
    if (component.dependencies.length > 0) {
      description += ` and depends on ${component.dependencies.length} other components`;
    }

    // Add usage information
    if (component.dependents.length > 0) {
      description += `. It is used by ${component.dependents.length} other components`;
    }

    // Add HTTP method information for routes
    if (component.metadata.httpMethods && component.metadata.httpMethods.length > 0) {
      description += ` and supports ${component.metadata.httpMethods.join(', ')} HTTP methods`;
    }

    // Add database query information
    if (component.metadata.dbQueries && component.metadata.dbQueries.length > 0) {
      description += ` with ${component.metadata.dbQueries.length} database queries`;
    }

    return description + '.';
  }

  private generateRuleBasedRiskAssessment(context: AIAnalysisContext): AIRiskAssessment {
    const component = context.component;
    let riskLevel: 'low' | 'medium' | 'high' | 'critical' = 'low';
    const reasons: string[] = [];
    const suggestions: string[] = [];
    const categories: AIRiskCategory[] = [];

    if (!component) {
      return {
        riskLevel: 'low',
        confidence: 0.3,
        reasons: ['No component data available for analysis'],
        suggestions: ['Provide component metadata for better analysis'],
        categories: []
      };
    }

    // Complexity-based risk assessment
    if (component.metadata.complexity > 8) {
      riskLevel = 'high';
      reasons.push('Extremely high complexity score');
      suggestions.push('Consider breaking this component into smaller, more manageable pieces');
      
      categories.push({
        category: 'maintainability',
        score: 20,
        issues: ['High cognitive complexity'],
        recommendations: ['Refactor into smaller functions', 'Apply SOLID principles']
      });
    } else if (component.metadata.complexity > 6) {
      riskLevel = riskLevel === 'low' ? 'medium' : 'high';
      reasons.push('High complexity score');
      suggestions.push('Monitor complexity and consider refactoring');
      
      categories.push({
        category: 'maintainability',
        score: 60,
        issues: ['Moderate complexity'],
        recommendations: ['Add more documentation', 'Consider extracting helper functions']
      });
    }

    // Dependency-based risk assessment
    if (component.dependencies.length > 15) {
      riskLevel = 'high';
      reasons.push('Very high number of dependencies');
      suggestions.push('Review and reduce dependencies where possible');
      
      categories.push({
        category: 'scalability',
        score: 30,
        issues: ['High coupling'],
        recommendations: ['Apply dependency injection', 'Use interfaces for abstraction']
      });
    } else if (component.dependencies.length > 8) {
      riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
      reasons.push('High number of dependencies');
      suggestions.push('Consider dependency injection patterns');
    }

    // Test coverage-based risk assessment
    if (component.metadata.testCoverage !== undefined) {
      if (component.metadata.testCoverage < 40) {
        riskLevel = riskLevel === 'low' ? 'medium' : 'high';
        reasons.push('Very low test coverage');
        suggestions.push('Increase test coverage to at least 80%');
        
        categories.push({
          category: 'reliability',
          score: 25,
          issues: ['Insufficient testing'],
          recommendations: ['Add unit tests', 'Add integration tests', 'Set up continuous testing']
        });
      } else if (component.metadata.testCoverage < 60) {
        riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
        reasons.push('Low test coverage');
        suggestions.push('Improve test coverage');
      }
    }

    // External API calls risk
    if (component.metadata.externalCalls && component.metadata.externalCalls.length > 0) {
      reasons.push('Makes external API calls');
      suggestions.push('Implement proper error handling and retry mechanisms for external calls');
      
      categories.push({
        category: 'reliability',
        score: 70,
        issues: ['External dependencies'],
        recommendations: ['Add circuit breaker pattern', 'Implement timeout handling']
      });
    }

    // Database queries risk
    if (component.metadata.dbQueries && component.metadata.dbQueries.length > 5) {
      reasons.push('High number of database queries');
      suggestions.push('Review database queries for N+1 problems and optimization opportunities');
      
      categories.push({
        category: 'performance',
        score: 60,
        issues: ['Potential database performance issues'],
        recommendations: ['Add query optimization', 'Consider database indexing', 'Implement caching']
      });
    }

    // Entry point risk (higher scrutiny needed)
    if (component.metadata.isEntry) {
      reasons.push('This is an entry point to the system');
      suggestions.push('Ensure proper input validation and security measures');
      
      categories.push({
        category: 'security',
        score: 50,
        issues: ['Public interface'],
        recommendations: ['Add input validation', 'Implement rate limiting', 'Add security headers']
      });
    }

    // Orphaned component risk
    if (component.metadata.isOrphaned) {
      reasons.push('This component appears to be orphaned (unused)');
      suggestions.push('Consider removing if truly unused, or document its purpose');
    }

    return {
      riskLevel,
      confidence: 0.7,
      reasons,
      suggestions,
      categories
    };
  }

  private generateRuleBasedRecommendations(context: AIAnalysisContext): AIRecommendation[] {
    const recommendations: AIRecommendation[] = [];
    const component = context.component;

    if (!component) {
      return recommendations;
    }

    // Complexity recommendations
    if (component.metadata.complexity > 6) {
      recommendations.push({
        type: 'refactoring',
        priority: component.metadata.complexity > 8 ? 'high' : 'medium',
        title: 'Reduce Complexity',
        description: 'This component has high complexity and would benefit from refactoring',
        implementation: 'Break down large functions into smaller, single-purpose functions. Apply the Single Responsibility Principle.',
        impact: 'Improved maintainability, reduced bugs, easier testing',
        effort: 'medium',
        confidence: 0.8,
        tags: ['complexity', 'maintainability', 'refactoring']
      });
    }

    // Test coverage recommendations
    if (component.metadata.testCoverage !== undefined && component.metadata.testCoverage < 70) {
      recommendations.push({
        type: 'testing',
        priority: component.metadata.testCoverage < 40 ? 'high' : 'medium',
        title: 'Improve Test Coverage',
        description: `Test coverage is ${component.metadata.testCoverage}%, which is below recommended levels`,
        implementation: 'Add unit tests for all public methods. Add integration tests for complex workflows.',
        impact: 'Increased confidence in code changes, reduced production bugs',
        effort: 'medium',
        confidence: 0.9,
        tags: ['testing', 'quality', 'reliability']
      });
    }

    // Performance recommendations for database-heavy components
    if (component.metadata.dbQueries && component.metadata.dbQueries.length > 3) {
      recommendations.push({
        type: 'performance',
        priority: 'medium',
        title: 'Optimize Database Access',
        description: 'Component makes multiple database queries which could impact performance',
        implementation: 'Review queries for N+1 problems. Consider using batch operations, joins, or caching.',
        impact: 'Reduced database load, faster response times',
        effort: 'medium',
        confidence: 0.7,
        tags: ['performance', 'database', 'optimization']
      });
    }

    // Security recommendations for entry points
    if (component.metadata.isEntry) {
      recommendations.push({
        type: 'security',
        priority: 'high',
        title: 'Security Review for Entry Point',
        description: 'As an entry point, this component requires thorough security review',
        implementation: 'Implement input validation, rate limiting, authentication, and authorization checks.',
        impact: 'Reduced security vulnerabilities, better system protection',
        effort: 'high',
        confidence: 0.9,
        tags: ['security', 'validation', 'authentication']
      });
    }

    // Architectural recommendations for highly coupled components
    if (component.dependencies.length > 10) {
      recommendations.push({
        type: 'architectural',
        priority: 'medium',
        title: 'Reduce Coupling',
        description: 'Component has many dependencies which increases coupling',
        implementation: 'Apply dependency injection, use interfaces for abstraction, consider the facade pattern.',
        impact: 'Improved testability, better separation of concerns, easier maintenance',
        effort: 'high',
        confidence: 0.6,
        tags: ['architecture', 'coupling', 'dependencies']
      });
    }

    return recommendations;
  }

  private generateRuleBasedCodeAnalysis(context: AIAnalysisContext): AICodeAnalysis {
    if (!context.code) {
      throw new Error('Code context is required');
    }

    const code = context.code;
    const lines = code.split('\n');

    return {
      summary: `Rule-based analysis of ${lines.length} lines of ${context.language || 'code'}`,
      complexity: this.estimateComplexityFromCode(code),
      patterns: this.detectPatternsInCode(code, context.language),
      issues: this.detectIssuesInCode(code, context.language),
      suggestions: this.generateCodeSuggestions(code, context.language),
      testability: this.estimateTestability(code),
      documentation: this.generateCodeDocumentation(code, context.language)
    };
  }

  private estimateComplexityFromCode(code: string): { cognitive: number; cyclomatic: number; maintainability: number } {
    const complexityKeywords = [
      'if', 'else', 'while', 'for', 'switch', 'case', 'try', 'catch', 'finally',
      '&&', '||', '?', ':', 'and', 'or', 'not'
    ];

    let complexity = 1;
    for (const keyword of complexityKeywords) {
      // Escape special regex characters
      const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      try {
        const matches = code.match(new RegExp(`\\b${escapedKeyword}\\b`, 'g'));
        if (matches) {
          complexity += matches.length;
        }
      } catch (error) {
        // If regex fails, try simple string matching
        const simpleMatches = code.split(keyword).length - 1;
        complexity += simpleMatches;
      }
    }

    const cognitive = Math.min(complexity, 15);
    const cyclomatic = Math.min(Math.floor(complexity * 0.8), 12);
    const maintainability = Math.max(1, 10 - Math.floor(complexity / 3));

    return { cognitive, cyclomatic, maintainability };
  }

  private detectPatternsInCode(code: string, language?: string): any[] {
    const patterns: any[] = [];

    // Singleton pattern detection
    if (code.includes('getInstance') || code.includes('instance') && code.includes('static')) {
      patterns.push({
        name: 'Singleton',
        type: 'design-pattern',
        confidence: 0.6,
        description: 'Possible singleton pattern implementation',
        impact: 'neutral'
      });
    }

    // Factory pattern detection
    if (code.includes('Factory') || code.includes('create') && code.includes('new')) {
      patterns.push({
        name: 'Factory',
        type: 'design-pattern',
        confidence: 0.5,
        description: 'Possible factory pattern implementation',
        impact: 'positive'
      });
    }

    // Observer pattern detection
    if (code.includes('addEventListener') || code.includes('observer') || code.includes('notify')) {
      patterns.push({
        name: 'Observer',
        type: 'design-pattern',
        confidence: 0.6,
        description: 'Possible observer pattern implementation',
        impact: 'positive'
      });
    }

    return patterns;
  }

  private detectIssuesInCode(code: string, language?: string): any[] {
    const issues: any[] = [];
    const lines = code.split('\n');

    // Long lines
    lines.forEach((line, index) => {
      if (line.length > 120) {
        issues.push({
          type: 'code-smell',
          severity: 'warning',
          message: 'Line is too long (>120 characters)',
          line: index + 1
        });
      }
    });

    // TODO/FIXME comments
    lines.forEach((line, index) => {
      if (line.includes('TODO') || line.includes('FIXME')) {
        issues.push({
          type: 'maintainability',
          severity: 'info',
          message: 'TODO or FIXME comment found',
          line: index + 1,
          suggestion: 'Consider addressing or creating a proper issue tracker entry'
        });
      }
    });

    // Multiple return statements (potential complexity)
    const returnMatches = code.match(/\breturn\b/g);
    if (returnMatches && returnMatches.length > 3) {
      issues.push({
        type: 'code-smell',
        severity: 'warning',
        message: 'Multiple return statements detected',
        suggestion: 'Consider using a single return point for better maintainability'
      });
    }

    return issues;
  }

  private generateCodeSuggestions(code: string, language?: string): any[] {
    const suggestions: any[] = [];

    // Function length suggestion
    const functions = code.match(/function\s+\w+|def\s+\w+|public\s+\w+|private\s+\w+/g);
    if (functions && functions.length > 0) {
      const avgFunctionSize = code.split('\n').length / functions.length;
      if (avgFunctionSize > 20) {
        suggestions.push({
          type: 'refactoring',
          message: 'Consider breaking down large functions',
          priority: 7
        });
      }
    }

    // Documentation suggestion
    if (!code.includes('/**') && !code.includes('"""') && !code.includes('///')) {
      suggestions.push({
        type: 'documentation',
        message: 'Add documentation comments for better code understanding',
        priority: 5
      });
    }

    return suggestions;
  }

  private estimateTestability(code: string): number {
    let score = 5; // Base score

    // Higher testability if functions are small
    const lines = code.split('\n').length;
    if (lines < 50) score += 2;
    else if (lines < 100) score += 1;

    // Higher testability if no global state
    if (!code.includes('global ') && !code.includes('window.')) {
      score += 2;
    }

    // Higher testability if dependency injection is used
    if (code.includes('inject') || code.includes('constructor')) {
      score += 1;
    }

    return Math.min(score, 10);
  }

  private generateCodeDocumentation(code: string, language?: string): string {
    const lines = code.split('\n').length;
    const functions = code.match(/function\s+\w+|def\s+\w+|public\s+\w+|private\s+\w+/g)?.length || 0;
    
    return `This ${language || 'code'} file contains ${lines} lines with approximately ${functions} functions or methods. ` +
           `Rule-based analysis suggests reviewing complexity and considering additional documentation.`;
  }

  // Helper methods for text parsing
  private extractRiskLevelFromText(text: string): 'low' | 'medium' | 'high' | 'critical' {
    const lowerText = text.toLowerCase();
    if (lowerText.includes('critical') || lowerText.includes('severe')) return 'critical';
    if (lowerText.includes('high')) return 'high';
    if (lowerText.includes('medium') || lowerText.includes('moderate')) return 'medium';
    return 'low';
  }

  private extractReasonsFromText(text: string): string[] {
    const sentences = text.split('.').filter(s => s.trim().length > 10);
    return sentences.slice(0, 3).map(s => s.trim());
  }

  private extractSuggestionsFromText(text: string): string[] {
    const lines = text.split('\n').filter(line => 
      line.includes('suggest') || line.includes('recommend') || line.includes('should')
    );
    return lines.slice(0, 3).map(line => line.trim());
  }

  private extractIssuesFromText(text: string): any[] {
    const lines = text.split('\n').filter(line => 
      line.includes('issue') || line.includes('problem') || line.includes('error')
    );
    return lines.slice(0, 5).map(line => ({
      type: 'code-smell',
      severity: 'warning',
      message: line.trim()
    }));
  }

  private extractSuggestionsFromAnalysis(text: string): any[] {
    const lines = text.split('\n').filter(line => 
      line.includes('improve') || line.includes('optimize') || line.includes('consider')
    );
    return lines.slice(0, 5).map((line, index) => ({
      type: 'optimization',
      message: line.trim(),
      priority: 5 + index
    }));
  }
}
