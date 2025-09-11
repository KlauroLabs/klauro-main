import { ComponentNode, ArchitectureBlueprint, Connection } from '../types';

export interface PromptContext {
  language?: string;
  framework?: string;
  componentType?: string;
  dependencies?: string[];
  metrics?: any;
  architecture?: Partial<ArchitectureBlueprint>;
}

export class AIPromptTemplates {
  static readonly MAX_CODE_LENGTH = 4000;
  static readonly MAX_CONTEXT_LENGTH = 2000;
  
  static truncateCode(code: string, maxLength: number = this.MAX_CODE_LENGTH): string {
    if (code.length <= maxLength) return code;
    
    const half = Math.floor(maxLength / 2);
    return `${code.substring(0, half)}\n\n... [truncated ${code.length - maxLength} characters] ...\n\n${code.substring(code.length - half)}`;
  }
  
  static formatContext(context: PromptContext): string {
    const parts = [];
    
    if (context.language) parts.push(`Language: ${context.language}`);
    if (context.framework) parts.push(`Framework: ${context.framework}`);
    if (context.componentType) parts.push(`Component Type: ${context.componentType}`);
    if (context.dependencies?.length) {
      parts.push(`Dependencies: ${context.dependencies.slice(0, 10).join(', ')}${context.dependencies.length > 10 ? '...' : ''}`);
    }
    
    return parts.join('\n');
  }
  
  static codeDescription(code: string, context?: PromptContext): { system: string; user: string } {
    return {
      system: `You are an expert software architect analyzing code for the Unravl visualization platform.
Your task is to generate clear, concise descriptions that help developers understand code at a glance.
Focus on: purpose, key functionality, architectural role, and business value.
${context ? `\nContext:\n${this.formatContext(context)}` : ''}`,
      
      user: `Analyze this code and provide a structured description in JSON format:
{
  "summary": "One-line description of what this code does",
  "purpose": "Why this code exists and its business value",
  "functionality": ["Key function 1", "Key function 2", ...],
  "architecturalRole": "How this fits in the system architecture",
  "dependencies": "What this code depends on",
  "consumers": "What depends on this code",
  "dataFlow": "How data moves through this component"
}

Code to analyze:
\`\`\`
${this.truncateCode(code)}
\`\`\``,
    };
  }
  
  static riskAssessment(component: ComponentNode, code?: string): { system: string; user: string } {
    return {
      system: `You are a senior security architect performing risk assessment for the Unravl platform.
Identify vulnerabilities, anti-patterns, and potential failure points.
Consider: security, performance, scalability, maintainability, and reliability.`,
      
      user: `Perform a comprehensive risk assessment for this component:

Component Information:
- Name: ${component.name}
- Type: ${component.type}
- Path: ${component.path}
- Dependencies: ${component.dependencies.length} components
- Complexity: ${component.metadata.complexity}/10
${component.metrics ? `- Lines of Code: ${component.metrics.linesOfCode}` : ''}

${code ? `\nCode Sample:\n\`\`\`\n${this.truncateCode(code, 2000)}\n\`\`\`` : ''}

Provide assessment in JSON format:
{
  "risks": [
    {
      "type": "security|performance|reliability|maintainability",
      "severity": "critical|high|medium|low",
      "description": "Clear description of the risk",
      "impact": "What could happen if this risk materializes",
      "likelihood": "high|medium|low",
      "mitigation": "Specific steps to address this risk"
    }
  ],
  "overallRiskLevel": "critical|high|medium|low",
  "prioritizedActions": ["Action 1", "Action 2", ...],
  "technicalDebt": "Assessment of technical debt",
  "securityPosture": "Current security status"
}`,
    };
  }
  
  static architecturalRecommendations(
    blueprint: Partial<ArchitectureBlueprint>,
    focusArea?: string
  ): { system: string; user: string } {
    return {
      system: `You are a principal architect reviewing system architecture for optimization and improvement.
Provide strategic, actionable recommendations based on modern architectural patterns and best practices.
${focusArea ? `Focus specifically on: ${focusArea}` : 'Provide comprehensive architectural assessment.'}`,
      
      user: `Review this system architecture and provide recommendations:

System Overview:
- Components: ${blueprint.components?.length || 0}
- Connections: ${blueprint.connections?.length || 0}
- Entry Points: ${blueprint.entryPoints?.length || 0}
- Technologies: ${blueprint.technologyStack?.languages?.map(l => l.name).join(', ') || 'Unknown'}
- Framework: ${blueprint.framework || 'Unknown'}

Component Distribution:
${blueprint.components ? Object.entries(
  blueprint.components.reduce((acc, c) => {
    acc[c.type] = (acc[c.type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>)
).map(([type, count]) => `- ${type}: ${count}`).join('\n') : 'No component data'}

${blueprint.riskAreas?.length ? `\nIdentified Risks:\n${blueprint.riskAreas.map(r => `- ${r.riskLevel}: ${r.reasons[0]}`).slice(0, 5).join('\n')}` : ''}

Provide recommendations in JSON format:
{
  "findings": {
    "strengths": ["Strength 1", "Strength 2", ...],
    "weaknesses": ["Weakness 1", "Weakness 2", ...],
    "opportunities": ["Opportunity 1", "Opportunity 2", ...],
    "threats": ["Threat 1", "Threat 2", ...]
  },
  "recommendations": [
    {
      "category": "architecture|performance|security|scalability|maintainability",
      "priority": "critical|high|medium|low",
      "title": "Clear recommendation title",
      "description": "Detailed description of what to do",
      "implementation": "How to implement this recommendation",
      "effort": "low|medium|high",
      "impact": "Expected positive impact",
      "risks": "Any risks in implementing this"
    }
  ],
  "patterns": {
    "current": ["Pattern 1", "Pattern 2", ...],
    "recommended": ["Pattern 1", "Pattern 2", ...],
    "antiPatterns": ["Anti-pattern 1", "Anti-pattern 2", ...]
  },
  "modernization": {
    "currentMaturity": "initial|developing|defined|managed|optimized",
    "targetMaturity": "initial|developing|defined|managed|optimized",
    "roadmap": ["Step 1", "Step 2", ...]
  }
}`,
    };
  }
  
  static securityAnalysis(code: string, context?: PromptContext): { system: string; user: string } {
    return {
      system: `You are a security expert specializing in application security and secure coding practices.
Identify vulnerabilities following OWASP Top 10 and CWE classifications.
Provide specific, actionable remediation guidance.`,
      
      user: `Perform a detailed security analysis of this code:

${context ? `Context:\n${this.formatContext(context)}\n` : ''}

Code to analyze:
\`\`\`
${this.truncateCode(code)}
\`\`\`

Provide security analysis in JSON format:
{
  "vulnerabilities": [
    {
      "type": "SQL Injection|XSS|CSRF|etc",
      "cwe": "CWE-XXX",
      "owasp": "A01:2021|A02:2021|etc",
      "severity": "critical|high|medium|low",
      "location": "Line numbers or code section",
      "description": "What the vulnerability is",
      "exploitability": "How it could be exploited",
      "impact": "Potential damage",
      "remediation": {
        "immediate": "Quick fix",
        "longTerm": "Proper solution",
        "example": "Code example of fix"
      }
    }
  ],
  "secureCodePatterns": ["Pattern 1", "Pattern 2", ...],
  "insecurePatterns": ["Pattern 1", "Pattern 2", ...],
  "dependencies": {
    "vulnerable": ["Package 1", "Package 2", ...],
    "outdated": ["Package 1", "Package 2", ...]
  },
  "recommendations": {
    "authentication": "Recommendations if applicable",
    "authorization": "Recommendations if applicable",
    "dataProtection": "Recommendations if applicable",
    "inputValidation": "Recommendations if applicable",
    "errorHandling": "Recommendations if applicable"
  },
  "complianceIssues": ["Issue 1", "Issue 2", ...],
  "securityScore": 0-10
}`,
    };
  }
  
  static performanceAnalysis(code: string, metrics?: any): { system: string; user: string } {
    return {
      system: `You are a performance engineering expert analyzing code for optimization opportunities.
Focus on time complexity, space complexity, I/O operations, and resource utilization.
Provide specific, measurable improvements.`,
      
      user: `Analyze the performance characteristics of this code:

${metrics ? `Current Metrics:\n${JSON.stringify(metrics, null, 2)}\n` : ''}

Code to analyze:
\`\`\`
${this.truncateCode(code)}
\`\`\`

Provide performance analysis in JSON format:
{
  "complexity": {
    "time": "O(n)|O(n²)|O(log n)|etc",
    "space": "O(1)|O(n)|etc",
    "explanation": "Why this complexity"
  },
  "bottlenecks": [
    {
      "location": "Function/line",
      "issue": "What's slow",
      "impact": "Performance impact",
      "solution": "How to fix"
    }
  ],
  "optimizations": [
    {
      "type": "algorithm|caching|parallelization|io|memory",
      "current": "Current implementation",
      "proposed": "Optimized implementation",
      "improvement": "Expected improvement percentage",
      "tradeoffs": "Any tradeoffs"
    }
  ],
  "antiPatterns": [
    {
      "pattern": "Pattern name",
      "location": "Where found",
      "impact": "Performance impact",
      "fix": "How to fix"
    }
  ],
  "recommendations": {
    "immediate": ["Quick win 1", "Quick win 2", ...],
    "shortTerm": ["Improvement 1", "Improvement 2", ...],
    "longTerm": ["Major refactor 1", "Major refactor 2", ...]
  },
  "estimatedImprovements": {
    "responseTime": "XX% faster",
    "throughput": "XX% increase",
    "memoryUsage": "XX% reduction",
    "cpuUsage": "XX% reduction"
  }
}`,
    };
  }
  
  static testStrategy(component: ComponentNode, code?: string): { system: string; user: string } {
    return {
      system: `You are a test automation architect designing comprehensive test strategies.
Consider unit tests, integration tests, edge cases, and error scenarios.
Focus on high-value, maintainable tests that ensure reliability.`,
      
      user: `Design a test strategy for this component:

Component: ${component.name}
Type: ${component.type}
Dependencies: ${component.dependencies.join(', ') || 'None'}
Complexity: ${component.metadata.complexity}/10

${code ? `\nCode Sample:\n\`\`\`\n${this.truncateCode(code, 2000)}\n\`\`\`` : ''}

Provide test strategy in JSON format:
{
  "testCases": [
    {
      "type": "unit|integration|e2e|performance|security",
      "name": "Test case name",
      "description": "What this tests",
      "priority": "critical|high|medium|low",
      "setup": "Required setup",
      "assertions": ["Assertion 1", "Assertion 2", ...],
      "edgeCases": ["Edge case 1", "Edge case 2", ...],
      "example": "Code example if applicable"
    }
  ],
  "coverage": {
    "targetPercentage": 80-100,
    "criticalPaths": ["Path 1", "Path 2", ...],
    "focusAreas": ["Area 1", "Area 2", ...]
  },
  "mockingStrategy": {
    "dependencies": ["What to mock", ...],
    "approach": "How to mock"
  },
  "dataStrategy": {
    "fixtures": ["Fixture 1", "Fixture 2", ...],
    "generators": ["Generator 1", "Generator 2", ...]
  },
  "automationRecommendations": ["Recommendation 1", "Recommendation 2", ...]
}`,
    };
  }
  
  static documentationGeneration(
    component: ComponentNode,
    format: 'api' | 'user' | 'technical'
  ): { system: string; user: string } {
    const formatInstructions = {
      api: 'Generate API documentation with endpoints, parameters, responses, and examples.',
      user: 'Generate user-facing documentation explaining features and usage.',
      technical: 'Generate technical documentation for developers including architecture and implementation details.',
    };
    
    return {
      system: `You are a technical writer creating clear, comprehensive documentation.
Focus on clarity, completeness, and practical examples.
Documentation format: ${format}`,
      
      user: `Generate ${format} documentation for this component:

Component Information:
${JSON.stringify({
  name: component.name,
  type: component.type,
  path: component.path,
  exports: component.metadata.exports,
  imports: component.metadata.imports,
  httpMethods: component.metadata.httpMethods,
}, null, 2)}

Requirements: ${formatInstructions[format]}

Provide documentation in JSON format:
{
  "title": "Documentation title",
  "overview": "Component overview",
  "sections": [
    {
      "heading": "Section heading",
      "content": "Section content (can include markdown)",
      "examples": ["Example 1", "Example 2", ...],
      "notes": ["Note 1", "Note 2", ...]
    }
  ],
  "apiReference": {
    "endpoints": [...] // if applicable
  },
  "configuration": {
    "options": [...] // if applicable
  },
  "troubleshooting": [
    {
      "issue": "Common issue",
      "solution": "How to fix"
    }
  ],
  "relatedLinks": ["Link 1", "Link 2", ...]
}`,
    };
  }
  
  static intelligentSummary(blueprint: ArchitectureBlueprint): { system: string; user: string } {
    return {
      system: `You are creating an executive summary of a software system architecture.
Focus on business value, technical highlights, risks, and recommendations.
Make it accessible to both technical and non-technical stakeholders.`,
      
      user: `Create an intelligent summary of this system architecture:

System: ${blueprint.projectName}
Framework: ${blueprint.framework}
Components: ${blueprint.components.length}
Technologies: ${blueprint.technologyStack?.languages?.map(l => `${l.name} (${l.percentage}%)`).join(', ')}

Key Metrics:
- Complexity Average: ${blueprint.metadata.complexityAverage}
- Code Lines: ${blueprint.metadata.codebaseSize?.totalLines}
- Entry Points: ${blueprint.entryPoints.length}
- Risk Areas: ${blueprint.riskAreas.filter(r => r.riskLevel === 'high').length} high, ${blueprint.riskAreas.filter(r => r.riskLevel === 'medium').length} medium

Provide summary in JSON format:
{
  "executiveSummary": "2-3 sentence overview for executives",
  "technicalSummary": "Technical overview for developers",
  "keyStrengths": ["Strength 1", "Strength 2", ...],
  "primaryConcerns": ["Concern 1", "Concern 2", ...],
  "businessImpact": {
    "opportunities": ["Opportunity 1", ...],
    "risks": ["Risk 1", ...],
    "recommendations": ["Recommendation 1", ...]
  },
  "technicalHighlights": {
    "architecture": "Architecture style and patterns",
    "scalability": "Scalability assessment",
    "maintainability": "Maintainability assessment",
    "security": "Security posture"
  },
  "nextSteps": [
    {
      "priority": "high|medium|low",
      "action": "What to do",
      "rationale": "Why it matters"
    }
  ],
  "metrics": {
    "healthScore": 0-100,
    "technicalDebtRatio": 0-1,
    "modernizationNeeded": true/false
  }
}`,
    };
  }
}