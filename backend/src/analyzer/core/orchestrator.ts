import { BaseAnalyzer, CASAnalysisResult, CASNode, CASEdge, AnalysisContext } from './base-analyzer';
import {
  CASOutput,
  CASContribution,
  CASProgressiveLevels,
  CASCategories,
  CASPattern,
  CASBehavior,
  CASTag,
  CASIndex,
  CASPerspective
} from '../../types/cas.types';

export { CASOutput } from '../../types/cas.types';
import * as fs from 'fs';
import * as path from 'path';

export interface AnalyzerRegistration {
  id: string;
  name: string;
  type: 'language' | 'framework' | 'library' | 'pattern';
  version: string;
  detectPatterns: {
    files?: string[];
    dependencies?: string[];
    imports?: string[];
    content?: RegExp[];
  };
  requires?: string[];
  enhances?: string[];
  analyzer: BaseAnalyzer;
}


export class AnalyzerOrchestrator {
  private analyzers: Map<string, AnalyzerRegistration> = new Map();

  registerAnalyzer(registration: AnalyzerRegistration): void {
    this.analyzers.set(registration.id, registration);
  }

  async detectAnalyzers(projectPath: string): Promise<AnalyzerRegistration[]> {
    const detected: AnalyzerRegistration[] = [];

    for (const registration of this.analyzers.values()) {
      if (await this.shouldUseAnalyzer(projectPath, registration)) {
        detected.push(registration);
      }
    }

    return this.orderAnalyzers(detected);
  }

  async orchestrateAnalysis(projectPath: string): Promise<CASOutput> {
    const startTime = Date.now();
    const analysisId = `analysis_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const detectedAnalyzers = await this.detectAnalyzers(projectPath);
    const context: AnalysisContext = { projectPath };

    const allNodes: CASNode[] = [];
    const allEdges: CASEdge[] = [];
    const allEntryPoints: any[] = [];
    const allExitPoints: any[] = [];
    const allLibraries: any[] = [];
    const allBehaviors: CASBehavior[] = [];
    const allPatterns: CASPattern[] = [];
    const allTags: CASTag[] = [];
    const allPerspectives: CASPerspective[] = [];
    const categories: CASCategories = {};
    const contributions: any[] = [];

    for (const registration of detectedAnalyzers) {
      try {
        const analyzerStartTime = Date.now();

        context.existingAnalysis = [{
          nodes: allNodes,
          edges: allEdges,
          entry_points: allEntryPoints,
          exit_points: allExitPoints,
          analyzer_metadata: {
            analyzer_id: 'merged',
            analyzer_name: 'Merged Analysis',
            version: '1.0.0',
            contribution_type: 'pattern',
            nodes_contributed: allNodes.length,
            edges_contributed: allEdges.length,
            contributed_entry_points: allEntryPoints.length,
            contributed_exit_points: allExitPoints.length
          }
        }];

        const result = await registration.analyzer.analyze(context);
        const executionTime = Date.now() - analyzerStartTime;

        this.mergeAnalysisResult(
          { allNodes, allEdges, allEntryPoints, allExitPoints },
          result
        );

        if (result.behaviors) allBehaviors.push(...result.behaviors);
        if (result.patterns) allPatterns.push(...result.patterns);
        if (result.categories) this.mergeCategories(categories, result.categories);
        if (result.tags) allTags.push(...result.tags);
        if (result.perspectives) allPerspectives.push(...result.perspectives);

        contributions.push({
          analyzer_id: registration.id,
          analyzer_name: registration.name,
          analyzer_version: registration.version,
          analyzer_type: registration.type,
          execution_time_ms: executionTime,
          nodes_created: result.nodes?.length || 0,
          edges_created: result.edges?.length || 0,
          confidence: 1.0,
          contributed_categories: result.categories ? Object.keys(result.categories).length : 0,
          provided_perspectives: result.provided_perspectives || []
        });

        if (result.libraries) {
          allLibraries.push(...result.libraries);
        }

      } catch (error) {
        console.error(`Error running analyzer ${registration.id}:`, error);
      }
    }

    const systemName = path.basename(projectPath);
    const progressiveLevels = this.buildProgressiveLevels(allNodes, categories);
    const index = this.buildIndex(allNodes, allEntryPoints, allExitPoints, allPerspectives);

    return {
      cas_version: '1.2.0',
      analysis_timestamp: new Date().toISOString(),
      analysis_id: analysisId,
      system: {
        id: `system_${systemName}`,
        name: systemName,
        type: this.determineSystemType(allNodes) as 'monorepo' | 'application' | 'library' | 'service' | 'package',
        root_path: projectPath,
        technologies: this.extractTechnologies(contributions, allLibraries),
        quality: this.calculateQualityMetrics(allNodes)
      },
      nodes: allNodes,
      edges: allEdges,
      entry_points: allEntryPoints,
      exit_points: allExitPoints,
      behaviors: allBehaviors.length > 0 ? allBehaviors : undefined,
      patterns: allPatterns.length > 0 ? allPatterns : undefined,
      categories: Object.keys(categories).length > 0 ? categories : undefined,
      tags: allTags.length > 0 ? allTags : undefined,
      perspectives: allPerspectives.length > 0 ? allPerspectives : undefined,
      index,
      libraries: allLibraries.length > 0 ? allLibraries : undefined,
      analyzer_contributions: contributions,
      progressive_levels: progressiveLevels
    } as CASOutput;
  }

  queryAnalysis(casOutput: CASOutput, options: {
    level?: number;
    type?: string;
    nameFilter?: string;
    includeEdges?: boolean;
  } = {}): { nodes: CASNode[]; edges?: CASEdge[] } {
    let filteredNodes = casOutput.nodes;

    if (options.level !== undefined) {
      filteredNodes = filteredNodes.filter(node =>
        node.level === undefined || node.level <= options.level!
      );
    }

    if (options.type) {
      filteredNodes = filteredNodes.filter(node => node.type === options.type);
    }

    if (options.nameFilter) {
      const regex = new RegExp(options.nameFilter, 'i');
      filteredNodes = filteredNodes.filter(node => regex.test(node.name));
    }

    const result: { nodes: CASNode[]; edges?: CASEdge[] } = { nodes: filteredNodes };

    if (options.includeEdges !== false) {
      const nodeIds = new Set(filteredNodes.map(node => node.id));
      result.edges = casOutput.edges.filter(edge =>
        nodeIds.has(edge.source) && nodeIds.has(edge.target)
      );
    }

    return result;
  }

  private async shouldUseAnalyzer(
    projectPath: string,
    registration: AnalyzerRegistration
  ): Promise<boolean> {
    try {
      return await registration.analyzer.canAnalyze(projectPath);
    } catch (error) {
      return false;
    }
  }

  private orderAnalyzers(analyzers: AnalyzerRegistration[]): AnalyzerRegistration[] {
    const typeOrder = { language: 0, framework: 1, library: 2, pattern: 3 };

    return analyzers.sort((a, b) => {
      const aOrder = typeOrder[a.type] ?? 999;
      const bOrder = typeOrder[b.type] ?? 999;
      return aOrder - bOrder;
    });
  }

  private mergeAnalysisResult(
    target: {
      allNodes: CASNode[];
      allEdges: CASEdge[];
      allEntryPoints: any[];
      allExitPoints: any[];
    },
    source: CASContribution
  ): void {
    const existingNodeIds = new Set(target.allNodes.map(n => n.id));
    const existingEdgeIds = new Set(target.allEdges.map(e => e.id));

    for (const node of source.nodes || []) {
      if (existingNodeIds.has(node.id)) {
        const existingNode = target.allNodes.find(n => n.id === node.id);
        if (existingNode) {
          // Enhanced merge logic for node collaboration
          if (node.metadata) {
            existingNode.metadata = { ...existingNode.metadata, ...node.metadata };
          }
          if (node.subcategories && node.subcategories.length > 0) {
            // Use the enhanced subcategories from the framework analyzer
            existingNode.subcategories = [...new Set([...(existingNode.subcategories || []), ...node.subcategories])];
          }
          if (node.level !== undefined && node.level !== existingNode.level) {
            existingNode.level = node.level; // Framework analyzers can promote level
          }
          if (node.level_name && node.level_name !== existingNode.level_name) {
            existingNode.level_name = node.level_name;
          }
          if (node.description && node.description !== existingNode.description) {
            existingNode.description = node.description; // Framework-specific descriptions take precedence
          }
          if (node.tags && node.tags.length > 0) {
            existingNode.tags = [...new Set([...(existingNode.tags || []), ...node.tags])];
          }
          if (node.type && node.type !== existingNode.type) {
            // Framework analyzers can specialize the type (e.g., 'class' -> 'controller')
            existingNode.type = node.type;
          }
        }
      } else {
        target.allNodes.push(node);
        existingNodeIds.add(node.id);
      }
    }

    for (const edge of source.edges || []) {
      if (!existingEdgeIds.has(edge.id)) {
        target.allEdges.push(edge);
        existingEdgeIds.add(edge.id);
      }
    }

    if (source.entry_points) target.allEntryPoints.push(...source.entry_points);
    if (source.exit_points) target.allExitPoints.push(...source.exit_points);
  }

  private determineSystemType(nodes: CASNode[]): string {
    const types = nodes.map(n => n.type);

    if (types.includes('controller')) return 'service';
    if (types.includes('component')) return 'application';
    if (types.includes('package')) return 'library';
    if (types.includes('module') && types.includes('controller')) return 'monorepo';

    return 'application';
  }

  private buildProgressiveLevels(nodes: CASNode[], categories: CASCategories): CASProgressiveLevels {
    const levelCounts = new Map<number, number>();
    const levelExamples = new Map<number, string[]>();
    const levelCategories = new Map<number, Set<string>>();

    nodes.forEach(node => {
      const level = node.level || 0;
      levelCounts.set(level, (levelCounts.get(level) || 0) + 1);

      const examples = levelExamples.get(level) || [];
      if (examples.length < 3) {
        examples.push(node.id);
        levelExamples.set(level, examples);
      }

      if (node.category) {
        const cats = levelCategories.get(level) || new Set();
        cats.add(node.category);
        levelCategories.set(level, cats);
      }
    });

    const sortedLevels = Array.from(levelCounts.keys()).sort((a, b) => a - b);
    const maxLevel = sortedLevels[sortedLevels.length - 1] || 3;

    const levelDefinitions = sortedLevels.map(level => ({
      level,
      name: this.getLevelName(level),
      description: this.getLevelDescription(level),
      node_count: levelCounts.get(level) || 0,
      recommended_for: this.getRecommendedFor(level),
      example_nodes: levelExamples.get(level) || [],
      time_to_understand: this.getTimeToUnderstand(level),
      contains: {
        categories: Array.from(levelCategories.get(level) || []),
        entry_points: level <= 1 ? 'included' : 'referenced',
        exit_points: level <= 2 ? 'included' : 'referenced',
        key_connections: level <= 2 ? 'all' : 'primary'
      }
    }));

    return {
      total_levels: maxLevel + 1,
      level_definitions: levelDefinitions,
      query_patterns: {
        level_specific: {
          description: 'Get nodes at a specific level',
          example: 'level=1',
          use_case: 'View high-level architecture'
        },
        level_range: {
          description: 'Get nodes up to a certain level',
          example: 'maxLevel=2',
          use_case: 'Progressive exploration'
        },
        discover_levels: {
          description: 'Discover what levels are available',
          example: 'query=levels',
          response: 'List of level definitions'
        },
        category_with_level: {
          description: 'Get specific category at level',
          example: 'category=controllers&level=1',
          use_case: 'Focused exploration'
        },
        children_progressive: {
          description: 'Get children of node progressively',
          example: 'nodeId=xxx&depth=1',
          use_case: 'Drill-down navigation'
        }
      },
      consumer_recommendations: {
        mcp_servers: {
          initial_load: 'Start with levels 0-1 for context',
          on_demand: 'Request deeper levels as needed',
          benefit: 'Reduces token usage by 10-20x',
          adaptive: 'Adjust based on query complexity'
        },
        ui_visualization: {
          overview_mode: 'Show levels 0-1 initially',
          detail_mode: 'Expand to level 2-3 on interaction',
          debug_mode: 'Show all levels with filtering',
          benefit: 'Progressive disclosure improves UX'
        },
        documentation_tools: {
          architecture_docs: 'Use levels 0-1',
          api_docs: 'Use levels 1-2 for endpoints',
          implementation_docs: 'Use levels 2-4',
          benefit: 'Right detail for right audience'
        }
      },
      level_strategy: {
        flexible_depth: 'Analyzers can define custom levels',
        minimum_levels: 2,
        maximum_levels: 'Unlimited, typically 4-6',
        common_range: '3-5 levels',
        examples: {
          'simple_script': '2 levels',
          'web_application': '4 levels',
          'enterprise_system': '5+ levels'
        }
      }
    };
  }

  private getLevelName(level: number): string {
    const names = [
      'System Overview',
      'Major Components',
      'Implementation Details',
      'Function Level',
      'Code Details',
      'Deep Implementation'
    ];
    return names[level] || `Level ${level}`;
  }

  private getLevelDescription(level: number): string {
    const descriptions = [
      'Top-level system architecture and entry points',
      'Major components, services, and their relationships',
      'Classes, modules, and detailed structure',
      'Functions, methods, and their interactions',
      'Variables, parameters, and low-level details',
      'AST nodes and implementation specifics'
    ];
    return descriptions[level] || `Details at level ${level}`;
  }

  private getRecommendedFor(level: number): string[] {
    const recommendations: Record<number, string[]> = {
      0: ['System overview', 'Architecture review', 'Initial exploration'],
      1: ['Component understanding', 'API discovery', 'Service mapping'],
      2: ['Implementation review', 'Code navigation', 'Refactoring planning'],
      3: ['Debugging', 'Detailed analysis', 'Performance optimization'],
      4: ['Deep debugging', 'Security audit', 'Complete understanding']
    };
    return recommendations[level] || ['Detailed analysis'];
  }

  private getTimeToUnderstand(level: number): string {
    const times = ['30 seconds', '2 minutes', '5 minutes', '10 minutes', '20 minutes', '30+ minutes'];
    return times[level] || '30+ minutes';
  }

  private buildIndex(nodes: CASNode[], entryPoints: any[], exitPoints: any[], perspectives: CASPerspective[]): CASIndex {
    const index: CASIndex = {
      by_type: {},
      by_name: {},
      by_perspective: {},
      entry_points: entryPoints.map(ep => ep.id),
      exit_points: exitPoints.map(ep => ep.id)
    };

    nodes.forEach(node => {
      if (!index.by_type![node.type]) {
        index.by_type![node.type] = [];
      }
      index.by_type![node.type].push(node.id);

      const nameKey = node.name.toLowerCase();
      if (!index.by_name![nameKey]) {
        index.by_name![nameKey] = [];
      }
      if (!Array.isArray(index.by_name![nameKey])) {
        index.by_name![nameKey] = [];
      }
      index.by_name![nameKey].push(node.id);

      if (node.perspectives) {
        node.perspectives.forEach(perspectiveId => {
          if (!index.by_perspective![perspectiveId]) {
            index.by_perspective![perspectiveId] = [];
          }
          index.by_perspective![perspectiveId].push(node.id);
        });
      }
    });

    perspectives.forEach(perspective => {
      if (!index.by_perspective![perspective.id]) {
        index.by_perspective![perspective.id] = [];
      }
    });

    return index;
  }

  private mergeCategories(target: CASCategories, source: Partial<CASCategories>): void {
    for (const [level, levelCategories] of Object.entries(source)) {
      if (!target[level]) {
        target[level] = {};
      }
      for (const [category, categoryData] of Object.entries(levelCategories || {})) {
        if (!target[level][category]) {
          target[level][category] = categoryData;
        } else {
          target[level][category] = {
            ...target[level][category],
            ...categoryData,
            types: [...new Set([...(target[level][category].types || []), ...(categoryData.types || [])])],
            frameworks: [...new Set([...(target[level][category].frameworks || []), ...(categoryData.frameworks || [])])],
            languages: [...new Set([...(target[level][category].languages || []), ...(categoryData.languages || [])])]
          };
        }
      }
    }
  }

  private extractTechnologies(contributions: any[], libraries: any[]): any {
    const languages = new Map<string, { count: number; percentage?: number }>();
    const frameworks = new Map<string, { version?: string; confidence: number }>();

    contributions.forEach(contrib => {
      if (contrib.analyzer_type === 'language') {
        const langName = contrib.analyzer_name.replace(' Analyzer', '');
        languages.set(langName, {
          count: contrib.nodes_created,
          percentage: 0
        });
      } else if (contrib.analyzer_type === 'framework') {
        const frameworkName = contrib.analyzer_name.replace(' Analyzer', '');
        frameworks.set(frameworkName, {
          confidence: contrib.confidence || 1.0
        });
      }
    });

    const totalNodes = Array.from(languages.values()).reduce((sum, l) => sum + l.count, 0);
    languages.forEach((value, key) => {
      value.percentage = totalNodes > 0 ? (value.count / totalNodes) * 100 : 0;
    });

    return {
      languages: Array.from(languages.entries()).map(([name, data]) => ({
        name,
        percentage: data.percentage,
        files: data.count
      })),
      frameworks: Array.from(frameworks.entries()).map(([name, data]) => ({
        name,
        confidence: data.confidence
      }))
    };
  }

  private calculateQualityMetrics(nodes: CASNode[]): any {
    const totalNodes = nodes.length;
    const documentedNodes = nodes.filter(n => n.description || n.metadata?.documentation).length;
    const testedNodes = nodes.filter(n => n.metadata?.is_test || n.testing?.tested_by).length;

    const complexitySum = nodes.reduce((sum, node) => {
      return sum + (node.metadata?.complexity?.cyclomatic || 0);
    }, 0);

    return {
      documentation_coverage: totalNodes > 0 ? (documentedNodes / totalNodes) * 100 : 0,
      test_coverage: totalNodes > 0 ? (testedNodes / totalNodes) * 100 : 0,
      complexity_score: totalNodes > 0 ? complexitySum / totalNodes : 0,
      maintainability_index: 100
    };
  }
}