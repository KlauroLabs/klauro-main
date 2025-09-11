import { ComponentNode, ArchitectureBlueprint, RiskArea } from '../types';
import { AIService } from './ai-service';
import { AIPromptTemplates, PromptContext } from './ai-prompts';
import { aiConfig } from '../config/ai.config';

export interface AIAnalysisResult {
  component: string;
  analysis: {
    description?: string;
    risks?: any[];
    improvements?: any[];
    security?: any;
    performance?: any;
    tests?: any;
    documentation?: string;
  };
  metadata: {
    provider: string;
    model: string;
    cached: boolean;
    processingTime: number;
    cost: number;
  };
}

export interface AIEnhancedBlueprint extends ArchitectureBlueprint {
  aiAnalysis?: {
    summary: string;
    insights: any;
    recommendations: any[];
    risks: any[];
    timestamp: Date;
  };
}

export class AIAnalyzer {
  private aiService: AIService;
  private analysisQueue: Map<string, Promise<AIAnalysisResult>> = new Map();
  
  constructor(aiService?: AIService) {
    this.aiService = aiService || new AIService();
  }
  
  async enhanceBlueprint(blueprint: ArchitectureBlueprint): Promise<AIEnhancedBlueprint> {
    const startTime = Date.now();
    console.log(`Enhancing blueprint with AI analysis for ${blueprint.projectName}...`);
    
    try {
      // Generate intelligent summary
      const summaryPrompt = AIPromptTemplates.intelligentSummary(blueprint);
      const summaryResponse = await this.aiService.complete({
        prompt: summaryPrompt.user,
        systemPrompt: summaryPrompt.system,
        responseFormat: 'json',
      });
      
      const summary = JSON.parse(summaryResponse.content);
      
      // Get architectural recommendations
      const archPrompt = AIPromptTemplates.architecturalRecommendations(blueprint);
      const archResponse = await this.aiService.complete({
        prompt: archPrompt.user,
        systemPrompt: archPrompt.system,
        responseFormat: 'json',
      });
      
      const recommendations = JSON.parse(archResponse.content);
      
      // Analyze high-risk components
      const highRiskComponents = blueprint.components.filter(
        c => c.metadata.complexity > 7 || blueprint.riskAreas.some(r => r.componentId === c.id && r.riskLevel === 'high')
      );
      
      const riskAnalyses = await Promise.all(
        highRiskComponents.slice(0, 5).map(component => this.analyzeComponentRisks(component))
      );
      
      const enhancedBlueprint: AIEnhancedBlueprint = {
        ...blueprint,
        aiAnalysis: {
          summary: summary.executiveSummary || 'AI analysis completed',
          insights: {
            technical: summary.technicalSummary,
            strengths: summary.keyStrengths,
            concerns: summary.primaryConcerns,
            metrics: summary.metrics,
          },
          recommendations: recommendations.recommendations || [],
          risks: riskAnalyses.filter(r => r.analysis.risks).flatMap(r => r.analysis.risks),
          timestamp: new Date(),
        },
      };
      
      // Add AI descriptions to components if enabled
      if (aiConfig.features.naturalLanguageDescriptions) {
        await this.addComponentDescriptions(enhancedBlueprint, 10); // Top 10 components
      }
      
      const processingTime = Date.now() - startTime;
      console.log(`AI enhancement completed in ${processingTime}ms`);
      
      return enhancedBlueprint;
    } catch (error) {
      console.error('Failed to enhance blueprint with AI:', error);
      // Return original blueprint if AI fails
      return blueprint;
    }
  }
  
  async analyzeComponent(
    component: ComponentNode,
    code?: string,
    analysisTypes: Array<'description' | 'risks' | 'improvements' | 'security' | 'performance' | 'tests'> = ['description']
  ): Promise<AIAnalysisResult> {
    const startTime = Date.now();
    const cacheKey = `${component.id}:${analysisTypes.join(',')}`;
    
    // Check if analysis is already in progress
    if (this.analysisQueue.has(cacheKey)) {
      return this.analysisQueue.get(cacheKey)!;
    }
    
    const analysisPromise = this.performComponentAnalysis(component, code, analysisTypes, startTime);
    this.analysisQueue.set(cacheKey, analysisPromise);
    
    try {
      const result = await analysisPromise;
      return result;
    } finally {
      this.analysisQueue.delete(cacheKey);
    }
  }
  
  private async performComponentAnalysis(
    component: ComponentNode,
    code: string | undefined,
    analysisTypes: Array<'description' | 'risks' | 'improvements' | 'security' | 'performance' | 'tests'>,
    startTime: number
  ): Promise<AIAnalysisResult> {
    const analysis: any = {};
    let totalCost = 0;
    let cached = false;
    let provider = 'unknown';
    let model = 'unknown';
    
    const context: PromptContext = {
      language: component.language,
      framework: component.framework,
      componentType: component.type,
      dependencies: component.dependencies,
      metrics: component.metrics,
    };
    
    for (const type of analysisTypes) {
      try {
        let response;
        
        switch (type) {
          case 'description':
            if (code) {
              const prompt = AIPromptTemplates.codeDescription(code, context);
              response = await this.aiService.complete({
                prompt: prompt.user,
                systemPrompt: prompt.system,
                responseFormat: 'json',
              });
              analysis.description = JSON.parse(response.content);
            }
            break;
            
          case 'risks':
            const riskPrompt = AIPromptTemplates.riskAssessment(component, code);
            response = await this.aiService.complete({
              prompt: riskPrompt.user,
              systemPrompt: riskPrompt.system,
              responseFormat: 'json',
            });
            analysis.risks = JSON.parse(response.content).risks;
            break;
            
          case 'security':
            if (code) {
              const secPrompt = AIPromptTemplates.securityAnalysis(code, context);
              response = await this.aiService.complete({
                prompt: secPrompt.user,
                systemPrompt: secPrompt.system,
                responseFormat: 'json',
              });
              analysis.security = JSON.parse(response.content);
            }
            break;
            
          case 'performance':
            if (code) {
              const perfPrompt = AIPromptTemplates.performanceAnalysis(code, component.metrics);
              response = await this.aiService.complete({
                prompt: perfPrompt.user,
                systemPrompt: perfPrompt.system,
                responseFormat: 'json',
              });
              analysis.performance = JSON.parse(response.content);
            }
            break;
            
          case 'tests':
            const testPrompt = AIPromptTemplates.testStrategy(component, code);
            response = await this.aiService.complete({
              prompt: testPrompt.user,
              systemPrompt: testPrompt.system,
              responseFormat: 'json',
            });
            analysis.tests = JSON.parse(response.content);
            break;
            
          case 'improvements':
            // Use architectural recommendations for improvements
            const archPrompt = AIPromptTemplates.architecturalRecommendations(
              { components: [component], connections: [], metadata: {} as any } as any,
              'maintainability'
            );
            response = await this.aiService.complete({
              prompt: archPrompt.user,
              systemPrompt: archPrompt.system,
              responseFormat: 'json',
            });
            const recommendations = JSON.parse(response.content);
            analysis.improvements = recommendations.recommendations;
            break;
        }
        
        if (response) {
          totalCost += response.cost;
          cached = cached || response.cached || false;
          provider = response.provider;
          model = response.model;
        }
      } catch (error) {
        console.error(`Failed to analyze ${type} for component ${component.name}:`, error);
      }
    }
    
    return {
      component: component.id,
      analysis,
      metadata: {
        provider,
        model,
        cached,
        processingTime: Date.now() - startTime,
        cost: totalCost,
      },
    };
  }
  
  async analyzeComponentRisks(component: ComponentNode, code?: string): Promise<AIAnalysisResult> {
    return this.analyzeComponent(component, code, ['risks', 'security']);
  }
  
  async generateComponentDocumentation(
    component: ComponentNode,
    format: 'api' | 'user' | 'technical' = 'technical'
  ): Promise<string> {
    const prompt = AIPromptTemplates.documentationGeneration(component, format);
    const response = await this.aiService.complete({
      prompt: prompt.user,
      systemPrompt: prompt.system,
      responseFormat: 'json',
    });
    
    const doc = JSON.parse(response.content);
    return this.formatDocumentation(doc, format);
  }
  
  private formatDocumentation(doc: any, format: string): string {
    const sections = doc.sections || [];
    let markdown = `# ${doc.title}\n\n${doc.overview}\n\n`;
    
    for (const section of sections) {
      markdown += `## ${section.heading}\n\n${section.content}\n\n`;
      
      if (section.examples?.length) {
        markdown += '### Examples\n\n';
        section.examples.forEach((ex: string, i: number) => {
          markdown += `${i + 1}. ${ex}\n`;
        });
        markdown += '\n';
      }
      
      if (section.notes?.length) {
        markdown += '### Notes\n\n';
        section.notes.forEach((note: string) => {
          markdown += `- ${note}\n`;
        });
        markdown += '\n';
      }
    }
    
    if (doc.troubleshooting?.length) {
      markdown += '## Troubleshooting\n\n';
      doc.troubleshooting.forEach((item: any) => {
        markdown += `**Issue:** ${item.issue}\n`;
        markdown += `**Solution:** ${item.solution}\n\n`;
      });
    }
    
    return markdown;
  }
  
  private async addComponentDescriptions(blueprint: AIEnhancedBlueprint, limit: number = 10): Promise<void> {
    // Sort components by importance (entry points, high complexity, many dependencies)
    const importantComponents = [...blueprint.components]
      .sort((a, b) => {
        const aScore = (a.metadata.isEntry ? 10 : 0) + 
                      a.metadata.complexity + 
                      a.dependencies.length + 
                      a.dependents.length;
        const bScore = (b.metadata.isEntry ? 10 : 0) + 
                      b.metadata.complexity + 
                      b.dependencies.length + 
                      b.dependents.length;
        return bScore - aScore;
      })
      .slice(0, limit);
    
    const descriptions = await Promise.all(
      importantComponents.map(async (component) => {
        try {
          const context: PromptContext = {
            language: component.language,
            framework: component.framework,
            componentType: component.type,
            dependencies: component.dependencies.slice(0, 5),
          };
          
          // Generate a simple description without code
          const response = await this.aiService.complete({
            prompt: `Generate a brief, clear description for a ${component.type} component named "${component.name}" in a ${component.framework || component.language || 'software'} application. The component has ${component.dependencies.length} dependencies and ${component.dependents.length} dependents. Complexity: ${component.metadata.complexity}/10. Provide a 1-2 sentence description of its likely purpose and role.`,
            systemPrompt: 'You are a software architect providing concise component descriptions.',
            maxTokens: 100,
          });
          
          return {
            componentId: component.id,
            description: response.content,
          };
        } catch (error) {
          console.error(`Failed to generate description for ${component.name}:`, error);
          return null;
        }
      })
    );
    
    // Add descriptions to components
    descriptions.forEach(desc => {
      if (desc) {
        const component = blueprint.components.find(c => c.id === desc.componentId);
        if (component) {
          component.metadata.aiDescription = desc.description;
        }
      }
    });
  }
  
  async identifyArchitecturalPatterns(blueprint: ArchitectureBlueprint): Promise<any> {
    const prompt = AIPromptTemplates.architecturalRecommendations(blueprint);
    const response = await this.aiService.complete({
      prompt: prompt.user,
      systemPrompt: prompt.system,
      responseFormat: 'json',
    });
    
    const analysis = JSON.parse(response.content);
    return {
      patterns: analysis.patterns,
      antiPatterns: analysis.patterns?.antiPatterns || [],
      recommendations: analysis.recommendations,
    };
  }
  
  async assessSystemSecurity(blueprint: ArchitectureBlueprint): Promise<any> {
    // Analyze overall system security
    const systemPrompt = `You are a security architect assessing the overall security posture of a software system.
Consider: authentication, authorization, data protection, network security, and compliance.`;
    
    const userPrompt = `Assess the security of this system architecture:
    
System: ${blueprint.projectName}
Components: ${blueprint.components.length}
Entry Points: ${blueprint.entryPoints.length}
External Dependencies: ${blueprint.dependencies?.directDependencies?.length || 0}
Technologies: ${blueprint.technologyStack?.languages?.map(l => l.name).join(', ')}

Component Types:
${Object.entries(
  blueprint.components.reduce((acc, c) => {
    acc[c.type] = (acc[c.type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>)
).map(([type, count]) => `- ${type}: ${count}`).join('\n')}

Provide a security assessment in JSON format with vulnerabilities, recommendations, and compliance considerations.`;
    
    const response = await this.aiService.complete({
      prompt: userPrompt,
      systemPrompt,
      responseFormat: 'json',
    });
    
    return JSON.parse(response.content);
  }
  
  async suggestPerformanceOptimizations(blueprint: ArchitectureBlueprint): Promise<any> {
    const prompt = AIPromptTemplates.architecturalRecommendations(blueprint, 'performance');
    const response = await this.aiService.complete({
      prompt: prompt.user,
      systemPrompt: prompt.system,
      responseFormat: 'json',
    });
    
    return JSON.parse(response.content);
  }
  
  getAnalysisStats() {
    return {
      queueSize: this.analysisQueue.size,
      aiServiceStats: this.aiService.getStats(),
    };
  }
}