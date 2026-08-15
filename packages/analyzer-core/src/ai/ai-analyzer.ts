import { aiService, AIAnalysisContext } from './ai-service';
import { ComponentNode, ArchitectureBlueprint, RiskArea } from '../types';
import * as winston from 'winston';
import * as fs from 'fs-extra';
import * as path from 'path';

export class AIAnalyzer {
  private logger: winston.Logger;

  constructor() {
    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      defaultMeta: { component: 'ai-analyzer' },
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

  async enhanceBlueprint(blueprint: ArchitectureBlueprint): Promise<ArchitectureBlueprint> {
    this.logger.info(`Enhancing blueprint with AI analysis for ${blueprint.components.length} components`);

    const enhancedComponents = await this.enhanceComponents(blueprint);
    const enhancedRiskAreas = await this.enhanceRiskAreas(blueprint);
    const aiGeneratedSummary = await this.generateProjectSummary(blueprint);

    return {
      ...blueprint,
      components: enhancedComponents,
      riskAreas: enhancedRiskAreas,
      metadata: {
        ...blueprint.metadata,
        aiGeneratedSummary
      }
    };
  }

  async enhanceComponents(blueprint: ArchitectureBlueprint): Promise<ComponentNode[]> {
    const enhancedComponents: ComponentNode[] = [];


    const batchSize = 5;
    const batches = this.chunkArray(blueprint.components, batchSize);

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      this.logger.info(`Processing component batch ${i + 1}/${batches.length} (${batch.length} components)`);

      const batchPromises = batch.map(component => this.enhanceComponent(component, blueprint));
      const enhancedBatch = await Promise.allSettled(batchPromises);

      enhancedBatch.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          enhancedComponents.push(result.value);
        } else {
          this.logger.error(`Failed to enhance component ${batch[index].name}:`, result.reason);

          enhancedComponents.push(batch[index]);
        }
      });


      if (i < batches.length - 1) {
        await this.delay(1000);
      }
    }

    return enhancedComponents;
  }

  async enhanceComponent(component: ComponentNode, blueprint: ArchitectureBlueprint): Promise<ComponentNode> {
    try {

      let sourceCode: string | undefined;

      try {
        const fullPath = path.isAbsolute(component.path)
          ? component.path
          : path.join(blueprint.metadata.repositoryPath, component.path);

        if (await fs.pathExists(fullPath)) {
          sourceCode = await fs.readFile(fullPath, 'utf-8');


          if (sourceCode.length > 10000) {
            sourceCode = sourceCode.substring(0, 10000) + '\n// ... (truncated for AI analysis)';
          }
        }
      } catch (error) {
        this.logger.debug(`Could not read source code for ${component.path}:`, error);
      }

      const context: AIAnalysisContext = {
        component,
        blueprint,
        code: sourceCode,
        language: component.language,
        framework: component.framework
      };


      const aiDescription = await aiService.generateComponentDescription(context);


      const riskAssessment = await aiService.assessComponentRisk(context);


      const recommendations = await aiService.generateArchitecturalRecommendations(context);


      let codeAnalysis;
      if (sourceCode) {
        try {
          codeAnalysis = await aiService.analyzeCode(context);
        } catch (error) {
          this.logger.warn(`Code analysis failed for ${component.name}:`, error);
        }
      }


      const enhancedComponent: ComponentNode = {
        ...component,
        metadata: {
          ...component.metadata,
          aiDescription,
          aiRiskAssessment: riskAssessment,
          aiRecommendations: recommendations,
          aiCodeAnalysis: codeAnalysis
        }
      };

      this.logger.debug(`Enhanced component: ${component.name}`);
      return enhancedComponent;

    } catch (error) {
      this.logger.error(`Failed to enhance component ${component.name}:`, error);
      return component;
    }
  }

  async enhanceRiskAreas(blueprint: ArchitectureBlueprint): Promise<RiskArea[]> {
    const enhancedRiskAreas: RiskArea[] = [];


    for (const riskArea of blueprint.riskAreas) {
      try {
        const component = blueprint.components.find(c => c.id === riskArea.componentId);
        if (!component) {
          enhancedRiskAreas.push(riskArea);
          continue;
        }

        const context: AIAnalysisContext = {
          component,
          blueprint,
          language: component.language,
          framework: component.framework
        };

        const riskAssessment = await aiService.assessComponentRisk(context);


        const enhancedRiskArea: RiskArea = {
          ...riskArea,
          reasons: [...riskArea.reasons, ...riskAssessment.reasons],
          aiInsights: {
            confidence: riskAssessment.confidence,
            suggestions: riskAssessment.suggestions,
            categories: riskAssessment.categories
          }
        };

        enhancedRiskAreas.push(enhancedRiskArea);

      } catch (error) {
        this.logger.error(`Failed to enhance risk area for component ${riskArea.componentId}:`, error);
        enhancedRiskAreas.push(riskArea);
      }
    }


    const newRisks = await this.discoverAdditionalRisks(blueprint);
    enhancedRiskAreas.push(...newRisks);

    return enhancedRiskAreas;
  }

  async discoverAdditionalRisks(blueprint: ArchitectureBlueprint): Promise<RiskArea[]> {
    const additionalRisks: RiskArea[] = [];


    const existingRiskComponentIds = new Set(blueprint.riskAreas.map(r => r.componentId));

    const highRiskComponents = blueprint.components.filter(component => {
      return !existingRiskComponentIds.has(component.id) && (
        component.metadata.complexity > 7 ||
        component.dependencies.length > 10 ||
        component.metadata.isEntry ||
        (component.metadata.testCoverage !== undefined && component.metadata.testCoverage < 50)
      );
    });


    const componentsToAnalyze = highRiskComponents.slice(0, 10);

    for (const component of componentsToAnalyze) {
      try {
        const context: AIAnalysisContext = {
          component,
          blueprint,
          language: component.language,
          framework: component.framework
        };

        const riskAssessment = await aiService.assessComponentRisk(context);


        if (riskAssessment.riskLevel !== 'low') {
          const riskArea: RiskArea = {
            componentId: component.id,
            riskLevel: riskAssessment.riskLevel,
            reasons: riskAssessment.reasons,
            impact: `AI-identified risk: ${riskAssessment.categories.map(c => c.category).join(', ')}`,
            aiInsights: {
              confidence: riskAssessment.confidence,
              suggestions: riskAssessment.suggestions,
              categories: riskAssessment.categories
            }
          };

          additionalRisks.push(riskArea);
        }

      } catch (error) {
        this.logger.error(`Failed to analyze component ${component.name} for additional risks:`, error);
      }
    }

    this.logger.info(`Discovered ${additionalRisks.length} additional risk areas through AI analysis`);
    return additionalRisks;
  }

  async generateProjectSummary(blueprint: ArchitectureBlueprint): Promise<string> {
    try {

      const context: AIAnalysisContext = {
        blueprint,
        framework: blueprint.framework,
        additionalContext: {
          totalComponents: blueprint.components.length,
          totalConnections: blueprint.connections.length,
          entryPoints: blueprint.entryPoints.length,
          riskAreas: blueprint.riskAreas.length,
          primaryLanguage: blueprint.metadata.primaryLanguage,
          frameworkVersion: blueprint.metadata.frameworkVersion,
          complexityStats: this.calculateComplexityStats(blueprint.components),
          testCoverageStats: this.calculateTestCoverageStats(blueprint.components),
          dependencyStats: this.calculateDependencyStats(blueprint.components)
        }
      };

      const summary = await aiService.generateComponentDescription(context);
      return summary;

    } catch (error) {
      this.logger.error('Failed to generate AI project summary:', error);
      return this.generateFallbackSummary(blueprint);
    }
  }

  async generateComponentInsights(component: ComponentNode, code?: string): Promise<{
    description?: string;
    risks?: any;
    recommendations?: any[];
    codeAnalysis?: any;
  }> {
    const context: AIAnalysisContext = {
      component,
      code,
      language: component.language,
      framework: component.framework
    };

    const results: any = {};

    try {
      results.description = await aiService.generateComponentDescription(context);
    } catch (error) {
      this.logger.error(`Failed to generate description for ${component.name}:`, error);
    }

    try {
      results.risks = await aiService.assessComponentRisk(context);
    } catch (error) {
      this.logger.error(`Failed to assess risks for ${component.name}:`, error);
    }

    try {
      results.recommendations = await aiService.generateArchitecturalRecommendations(context);
    } catch (error) {
      this.logger.error(`Failed to generate recommendations for ${component.name}:`, error);
    }

    if (code) {
      try {
        results.codeAnalysis = await aiService.analyzeCode(context);
      } catch (error) {
        this.logger.error(`Failed to analyze code for ${component.name}:`, error);
      }
    }

    return results;
  }

  private calculateComplexityStats(components: ComponentNode[]): any {
    const complexities = components.map(c => c.metadata.complexity);

    return {
      average: complexities.length > 0 ? complexities.reduce((a, b) => a + b, 0) / complexities.length : 0,
      max: Math.max(...complexities),
      min: Math.min(...complexities),
      highComplexityCount: complexities.filter(c => c > 7).length
    };
  }

  private calculateTestCoverageStats(components: ComponentNode[]): any {
    const coverageValues = components
      .map(c => c.metadata.testCoverage)
      .filter(c => c !== undefined) as number[];

    if (coverageValues.length === 0) {
      return { average: 0, componentsWithCoverage: 0 };
    }

    return {
      average: coverageValues.reduce((a, b) => a + b, 0) / coverageValues.length,
      componentsWithCoverage: coverageValues.length,
      lowCoverageCount: coverageValues.filter(c => c < 60).length
    };
  }

  private calculateDependencyStats(components: ComponentNode[]): any {
    const dependencyCounts = components.map(c => c.dependencies.length);

    return {
      average: dependencyCounts.length > 0 ? dependencyCounts.reduce((a, b) => a + b, 0) / dependencyCounts.length : 0,
      max: Math.max(...dependencyCounts),
      highDependencyCount: dependencyCounts.filter(c => c > 10).length
    };
  }

  private generateFallbackSummary(blueprint: ArchitectureBlueprint): string {
    const stats = this.calculateComplexityStats(blueprint.components);
    const testStats = this.calculateTestCoverageStats(blueprint.components);

    return `This ${blueprint.framework} project contains ${blueprint.components.length} components ` +
           `with an average complexity of ${stats.average.toFixed(1)}. ` +
           `The system has ${blueprint.entryPoints.length} entry points and ${blueprint.riskAreas.length} identified risk areas. ` +
           `Test coverage information is available for ${testStats.componentsWithCoverage} components ` +
           `with an average coverage of ${testStats.average.toFixed(1)}%.`;
  }

  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async getUsageStats() {
    return aiService.getUsageStats();
  }

  async clearCache() {
    await aiService.clearCache();
  }

  getAvailableProviders() {
    return aiService.getAvailableProviders();
  }
}


declare module '../types' {
  interface ComponentMetadata {
    aiDescription?: string;
    aiRiskAssessment?: any;
    aiRecommendations?: any[];
    aiCodeAnalysis?: any;
  }

  interface RiskArea {
    aiInsights?: {
      confidence: number;
      suggestions: string[];
      categories: any[];
    };
  }
}

export const aiAnalyzer = new AIAnalyzer();
