import { AIAnalysisContext } from './ai-service';

export interface PromptTemplate {
  systemPrompt: string;
  userPromptTemplate: string;
  variables: string[];
  maxTokens: number;
  temperature: number;
}

export class AIPrompts {
  public readonly systemPrompts = {
    description: `You are a senior software engineer and architect with expertise in code analysis and system design. Your role is to provide clear, accurate, and insightful descriptions of software components.

Guidelines:
- Focus on the component's purpose, responsibility, and role in the system
- Explain what the component does in simple, non-technical language that stakeholders can understand
- Mention key technologies, patterns, or frameworks when relevant
- Keep descriptions concise but comprehensive (2-3 sentences)
- Be objective and factual, avoiding speculation
- Avoid vague labels such as functionality, module, area, or system piece when a concrete behavior or relationship is available
- Do not add business, compliance, security, scale, or user-impact claims unless the provided facts explicitly support them`,

    riskAssessment: `You are a security and quality expert specializing in code risk assessment. Your job is to identify potential risks, vulnerabilities, and quality issues in software components.

Analyze the provided component and respond with ONLY valid JSON in this exact format:
{
  "riskLevel": "low|medium|high|critical",
  "confidence": 0.0-1.0,
  "reasons": ["array", "of", "risk", "reasons"],
  "suggestions": ["array", "of", "improvement", "suggestions"],
  "categories": [
    {
      "category": "security|performance|maintainability|scalability|reliability",
      "score": 0-100,
      "issues": ["specific", "issues"],
      "recommendations": ["specific", "recommendations"]
    }
  ]
}

Consider these risk factors:
- Security vulnerabilities (injection, XSS, authentication bypass, etc.)
- Performance issues (N+1 queries, memory leaks, inefficient algorithms)
- Maintainability problems (high complexity, tight coupling, lack of tests)
- Scalability concerns (resource contention, bottlenecks)
- Reliability risks (error handling, external dependencies, single points of failure)`,

    recommendations: `You are an experienced software architect and consultant. Your role is to provide actionable architectural and code improvement recommendations.

Analyze the provided component and respond with ONLY valid JSON in this exact format:
{
  "recommendations": [
    {
      "type": "architectural|security|performance|testing|refactoring",
      "priority": "low|medium|high|critical",
      "title": "Brief recommendation title",
      "description": "Detailed description of the issue and why it needs attention",
      "implementation": "Specific steps to implement the recommendation",
      "impact": "Expected benefits and improvements",
      "effort": "low|medium|high",
      "confidence": 0.0-1.0,
      "tags": ["relevant", "tags"]
    }
  ]
}

Focus on:
- Architectural improvements (SOLID principles, design patterns, separation of concerns)
- Security enhancements (input validation, authentication, encryption)
- Performance optimizations (caching, query optimization, algorithmic improvements)
- Testing strategies (unit tests, integration tests, test coverage)
- Code quality (refactoring, documentation, error handling)
- Best practices for the specific technology stack`,

    codeAnalysis: `You are a code quality expert and static analysis specialist. Your role is to provide comprehensive code analysis including complexity metrics, pattern detection, and quality assessment.

Analyze the provided code and respond with ONLY valid JSON in this exact format:
{
  "summary": "Brief summary of the code analysis",
  "complexity": {
    "cognitive": 1-15,
    "cyclomatic": 1-12,
    "maintainability": 1-10
  },
  "patterns": [
    {
      "name": "Pattern name",
      "type": "design-pattern|anti-pattern|architectural-pattern",
      "confidence": 0.0-1.0,
      "description": "Pattern description",
      "impact": "positive|negative|neutral"
    }
  ],
  "issues": [
    {
      "type": "bug|vulnerability|code-smell|performance|maintainability",
      "severity": "info|warning|error|critical",
      "message": "Issue description",
      "line": 123,
      "column": 45,
      "suggestion": "How to fix the issue"
    }
  ],
  "suggestions": [
    {
      "type": "optimization|refactoring|testing|documentation",
      "message": "Suggestion description",
      "example": "Code example if applicable",
      "priority": 1-10
    }
  ],
  "testability": 1-10,
  "documentation": "Assessment of code documentation quality and suggestions"
}

Analyze for:
- Code complexity and maintainability metrics
- Design patterns and anti-patterns
- Code smells and potential bugs
- Security vulnerabilities
- Performance optimization opportunities
- Testing and documentation quality`
  };


  generateDescriptionPrompt(context: AIAnalysisContext): string {
    const { component, blueprint, code, language, framework, additionalContext } = context;

    let prompt = '';

    if (component) {
      prompt += `Component Analysis Request:

Component Details:
- Name: ${component.name}
- Type: ${component.type}
- Path: ${component.path}
- Language: ${component.language || language || 'Unknown'}
- Framework: ${component.framework || framework || 'Unknown'}
- Complexity Score: ${component.metadata.complexity}/10
- Line Count: ${component.metadata.lineCount}
- Dependencies: ${component.dependencies.length} components
- Dependents: ${component.dependents.length} components`;

      if (component.metadata.responsibilities.length > 0) {
        prompt += `\n- Responsibilities: ${component.metadata.responsibilities.join(', ')}`;
      }

      if (component.metadata.httpMethods && component.metadata.httpMethods.length > 0) {
        prompt += `\n- HTTP Methods: ${component.metadata.httpMethods.join(', ')}`;
      }

      if (component.metadata.dbQueries && component.metadata.dbQueries.length > 0) {
        prompt += `\n- Database Queries: ${component.metadata.dbQueries.length}`;
      }

      if (component.metadata.externalCalls && component.metadata.externalCalls.length > 0) {
        prompt += `\n- External API Calls: ${component.metadata.externalCalls.length}`;
      }

      if (component.metadata.testCoverage !== undefined) {
        prompt += `\n- Test Coverage: ${component.metadata.testCoverage}%`;
      }

      if (component.metadata.isEntry) {
        prompt += `\n- Entry Point: Yes`;
      }

      if (component.metadata.isOrphaned) {
        prompt += `\n- Orphaned: Yes (no dependencies or dependents)`;
      }
    }

    if (blueprint) {
      prompt += `\n\nSystem Context:
- Project: ${blueprint.projectName}
- Framework: ${blueprint.framework}
- Total Components: ${blueprint.components.length}
- Entry Points: ${blueprint.entryPoints.length}
- Risk Areas: ${blueprint.riskAreas.length}`;
    }

    if (code && code.length <= 2000) {
      prompt += `\n\nCode Sample:\n\`\`\`${language || 'text'}\n${code}\n\`\`\``;
    } else if (code) {
      prompt += `\n\nCode Sample (truncated):\n\`\`\`${language || 'text'}\n${code.substring(0, 2000)}...\n\`\`\``;
    }

    if (additionalContext) {
      const serializedContext = additionalContext.compactPrompt === true || additionalContext.compact_prompt === true
        ? JSON.stringify(additionalContext)
        : JSON.stringify(additionalContext, null, 2);
      prompt += `\n\nAdditional Context:\n${serializedContext}`;
    }

    const taskText = typeof additionalContext?.task === 'string' ? additionalContext.task : '';
    if (/return only valid json/i.test(taskText)) {
      prompt += `\n\nReturn exactly the requested JSON object. Do not add markdown, commentary, or prose outside the JSON.`;
    } else {
      prompt += `\n\nPlease provide a clear, concise description of this component that explains its purpose, behavior, and role in the system. Use only the provided facts; avoid promotional phrasing, vague words like "functionality", and inferred business outcomes unless they are explicit in the context.`;
    }

    return prompt;
  }


  generateRiskAssessmentPrompt(context: AIAnalysisContext): string {
    const { component, blueprint, code, language, framework } = context;

    let prompt = `Risk Assessment Request:

Please analyze the following component for potential risks, vulnerabilities, and quality issues.

`;

    if (component) {
      prompt += `Component Information:
- Name: ${component.name}
- Type: ${component.type}
- Language: ${component.language || language || 'Unknown'}
- Framework: ${component.framework || framework || 'Unknown'}
- Complexity: ${component.metadata.complexity}/10
- Dependencies: ${component.dependencies.length}
- Dependents: ${component.dependents.length}
- Line Count: ${component.metadata.lineCount}`;

      if (component.metadata.testCoverage !== undefined) {
        prompt += `\n- Test Coverage: ${component.metadata.testCoverage}%`;
      }

      if (component.metadata.isEntry) {
        prompt += `\n- Is Entry Point: Yes`;
      }

      if (component.metadata.httpMethods?.length) {
        prompt += `\n- HTTP Methods: ${component.metadata.httpMethods.join(', ')}`;
      }

      if (component.metadata.dbQueries?.length) {
        prompt += `\n- Database Queries: ${component.metadata.dbQueries.length}`;
      }

      if (component.metadata.externalCalls?.length) {
        prompt += `\n- External Calls: ${component.metadata.externalCalls.length}`;
      }
    }

    if (code && code.length <= 3000) {
      prompt += `\n\nCode to Analyze:\n\`\`\`${language || 'text'}\n${code}\n\`\`\``;
    } else if (code) {
      prompt += `\n\nCode to Analyze (truncated):\n\`\`\`${language || 'text'}\n${code.substring(0, 3000)}...\n\`\`\``;
    }

    if (blueprint) {
      prompt += `\n\nSystem Context:
- Framework: ${blueprint.framework}
- Total Components: ${blueprint.components.length}
- Known Risk Areas: ${blueprint.riskAreas.length}`;
    }

    prompt += `\n\nAnalyze this component for:
1. Security vulnerabilities and attack vectors
2. Performance bottlenecks and scalability issues
3. Maintainability and code quality problems
4. Reliability and error handling concerns
5. Architectural and design issues

Provide your assessment in the required JSON format with specific, actionable insights.`;

    return prompt;
  }


  generateRecommendationsPrompt(context: AIAnalysisContext): string {
    const { component, blueprint, code, language, framework } = context;

    let prompt = `Architectural Recommendations Request:

Please analyze the following component and provide specific, actionable recommendations for improvement.

`;

    if (component) {
      prompt += `Component Details:
- Name: ${component.name}
- Type: ${component.type}
- Language: ${component.language || language || 'Unknown'}
- Framework: ${component.framework || framework || 'Unknown'}
- Complexity: ${component.metadata.complexity}/10
- Dependencies: ${component.dependencies.length}
- Dependents: ${component.dependents.length}
- Line Count: ${component.metadata.lineCount}`;

      if (component.metadata.testCoverage !== undefined) {
        prompt += `\n- Test Coverage: ${component.metadata.testCoverage}%`;
      }

      if (component.metadata.responsibilities.length > 0) {
        prompt += `\n- Responsibilities: ${component.metadata.responsibilities.join(', ')}`;
      }
    }

    if (blueprint) {
      prompt += `\n\nSystem Architecture Context:
- Framework: ${blueprint.framework}
- Total Components: ${blueprint.components.length}
- Technology Stack: ${blueprint.technologyStack?.primaryFramework?.name || 'Unknown'}`;

      if (blueprint.riskAreas.length > 0) {
        prompt += `\n- Existing Risk Areas: ${blueprint.riskAreas.length}`;
      }
    }

    if (code && code.length <= 4000) {
      prompt += `\n\nCode for Analysis:\n\`\`\`${language || 'text'}\n${code}\n\`\`\``;
    } else if (code) {
      prompt += `\n\nCode for Analysis (truncated):\n\`\`\`${language || 'text'}\n${code.substring(0, 4000)}...\n\`\`\``;
    }

    prompt += `\n\nPlease provide recommendations focusing on:

1. **Architectural Improvements**: SOLID principles, design patterns, separation of concerns
2. **Security Enhancements**: Input validation, authentication, authorization, data protection
3. **Performance Optimizations**: Caching strategies, query optimization, algorithmic improvements
4. **Testing Strategies**: Unit tests, integration tests, coverage improvements
5. **Code Quality**: Refactoring opportunities, documentation, error handling
6. **Maintainability**: Code organization, naming conventions, complexity reduction

Prioritize recommendations based on:
- Impact on system reliability and security
- Development effort required
- Business value provided
- Technical debt reduction

Provide specific implementation guidance and expected outcomes for each recommendation.`;

    return prompt;
  }


  generateCodeAnalysisPrompt(context: AIAnalysisContext): string {
    const { code, language, framework, component } = context;

    if (!code) {
      throw new Error('Code is required for code analysis');
    }

    let prompt = `Code Analysis Request:

Please perform a comprehensive static analysis of the following code.

`;

    if (component) {
      prompt += `Component Context:
- Name: ${component.name}
- Type: ${component.type}
- Path: ${component.path}`;
    }

    prompt += `
Language: ${language || 'Auto-detect'}
Framework: ${framework || 'Unknown'}

Code to Analyze:
\`\`\`${language || 'text'}
${code}
\`\`\`

Please analyze this code for:

**Complexity Metrics:**
- Cognitive complexity (how hard it is to understand)
- Cyclomatic complexity (number of execution paths)
- Maintainability index (ease of maintenance)

**Code Patterns:**
- Design patterns (Singleton, Factory, Observer, etc.)
- Anti-patterns (God Object, Spaghetti Code, etc.)
- Architectural patterns (MVC, MVP, MVVM, etc.)

**Quality Issues:**
- Code smells (long methods, duplicate code, etc.)
- Potential bugs or logic errors
- Security vulnerabilities
- Performance bottlenecks
- Maintainability concerns

**Improvement Suggestions:**
- Refactoring opportunities
- Optimization recommendations
- Testing suggestions
- Documentation improvements

**Testability Assessment:**
- How easy is this code to test?
- Are there dependencies that make testing difficult?
- Are functions/methods properly isolated?

Provide your analysis in the required JSON format with specific line numbers where applicable and concrete examples for suggestions.`;

    return prompt;
  }




  estimateTokenCount(text: string): number {

    return Math.ceil(text.length / 4);
  }


  optimizePromptForTokens(prompt: string, maxTokens: number): string {
    const estimatedTokens = this.estimateTokenCount(prompt);

    if (estimatedTokens <= maxTokens) {
      return prompt;
    }


    const targetLength = Math.floor(prompt.length * (maxTokens / estimatedTokens) * 0.9);


    const codeBlockRegex = /```[\s\S]*?```/g;
    const codeBlocks = prompt.match(codeBlockRegex);

    if (codeBlocks && codeBlocks.length > 0) {
      let optimizedPrompt = prompt;

      for (const block of codeBlocks) {
        if (optimizedPrompt.length > targetLength) {
          const lines = block.split('\n');
          const language = lines[0].replace('```', '');
          const codeLines = lines.slice(1, -1);


          const keepLines = Math.floor((targetLength - optimizedPrompt.length + block.length) / 50);

          if (keepLines < codeLines.length && keepLines > 4) {
            const start = codeLines.slice(0, keepLines / 2);
            const end = codeLines.slice(-(keepLines / 2));
            const truncatedBlock = `\`\`\`${language}\n${start.join('\n')}\n... (truncated ${codeLines.length - keepLines} lines) ...\n${end.join('\n')}\n\`\`\``;
            optimizedPrompt = optimizedPrompt.replace(block, truncatedBlock);
          }
        }
      }

      return optimizedPrompt;
    }


    return prompt.substring(0, targetLength) + '... (truncated for token limits)';
  }


  getSystemPrompt(analysisType: 'description' | 'risk' | 'recommendations' | 'code'): string {
    switch (analysisType) {
      case 'description':
        return this.systemPrompts.description;
      case 'risk':
        return this.systemPrompts.riskAssessment;
      case 'recommendations':
        return this.systemPrompts.recommendations;
      case 'code':
        return this.systemPrompts.codeAnalysis;
      default:
        return this.systemPrompts.description;
    }
  }


  generateContextAwarePrompt(context: AIAnalysisContext, analysisType: string): string {
    const hasCode = Boolean(context.code);
    const hasComponent = Boolean(context.component);


    switch (analysisType) {
      case 'description':
        if (hasComponent) {
          return this.generateDescriptionPrompt(context);
        } else if (hasCode) {
          return `Analyze this ${context.language || 'code'} and provide a description:\n\`\`\`\n${context.code}\n\`\`\``;
        }
        break;

      case 'risk':
        return this.generateRiskAssessmentPrompt(context);

      case 'recommendations':
        return this.generateRecommendationsPrompt(context);

      case 'code':
        if (hasCode) {
          return this.generateCodeAnalysisPrompt(context);
        }
        break;
    }


    return `Please analyze the provided information and generate insights about this software component.`;
  }
}

export const prompts = new AIPrompts();
