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
  CASPerspective,
  CASArchitectureSummary,
  CASRouteTableEntry,
  CASDatabaseSchema,
  CASDatabaseEntity,
  CASExternalService,
  CASEntryPoint,
  CASExitPoint
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
    const context: AnalysisContext = {
      projectPath,
      filters: ['**/src/analyzer/**', '**/analyzer/**', '**/analyzers/**']
    };

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

    const architectureSummary = this.buildArchitectureSummary(allNodes, allEntryPoints, allExitPoints, contributions);
    const routeTable = this.buildRouteTable(allEntryPoints);
    const databaseSchema = this.buildDatabaseSchema(allNodes, allLibraries);
    const externalServices = this.buildExternalServices(allNodes, allExitPoints, allLibraries);

    const detectedPatterns = this.detectPatterns(allNodes, allEdges);
    allPatterns.push(...detectedPatterns);

    return {
      cas_version: '1.5.0',
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
      architecture_summary: architectureSummary,
      route_table: routeTable.length > 0 ? routeTable : undefined,
      database_schema: databaseSchema.entities.length > 0 ? databaseSchema : undefined,
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
      external_services: externalServices.length > 0 ? externalServices : undefined,
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

  private buildArchitectureSummary(
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
    contributions: any[]
  ): CASArchitectureSummary {
    const fileNodes = nodes.filter(n => n.type === 'file');
    const httpEntryPoints = entryPoints.filter(ep => ep.type === 'http');

    const frameworkContribution = contributions.find(c => c.analyzer_type === 'framework');
    const systemType = frameworkContribution?.analyzer_name?.replace(' Analyzer', '') || 'Application';

    const controllers = nodes.filter(n => n.type === 'controller' || n.subcategories?.includes('controller'));
    const services = nodes.filter(n => n.type === 'service' || n.subcategories?.includes('service'));
    const entities = nodes.filter(n => n.type === 'entity' || n.subcategories?.includes('entity'));
    const repositories = nodes.filter(n => n.type === 'repository' || n.subcategories?.includes('repository'));
    const guards = nodes.filter(n => n.type === 'guard' || n.subcategories?.includes('guard'));
    const middleware = nodes.filter(n => n.type === 'middleware' || n.subcategories?.includes('middleware'));
    const modules = nodes.filter(n => n.type === 'module');
    const components = nodes.filter(n => n.type === 'component');
    const pages = nodes.filter(n => n.type === 'page' || n.subcategories?.includes('page'));
    const migrations = nodes.filter(n => n.type === 'migration' || n.source?.file?.includes('migration'));

    const authenticatedEndpoints = httpEntryPoints.filter(ep => ep.security?.authenticated);
    const publicEndpoints = httpEntryPoints.filter(ep => !ep.security?.authenticated);

    const methodCounts: Record<string, number> = {};
    httpEntryPoints.forEach(ep => {
      const method = ep.trigger?.method?.toUpperCase() || 'UNKNOWN';
      methodCounts[method] = (methodCounts[method] || 0) + 1;
    });

    const uniqueGuards = new Set<string>();
    httpEntryPoints.forEach(ep => {
      const epGuards = ep.metadata?.guards as string[] | undefined;
      if (epGuards) {
        epGuards.forEach(g => uniqueGuards.add(g));
      }
    });

    let authStrategy: string | undefined;
    if (uniqueGuards.has('JwtAuthGuard') || uniqueGuards.has('JwtGuard')) {
      authStrategy = 'JWT';
    } else if (uniqueGuards.has('SessionGuard')) {
      authStrategy = 'Session';
    } else if (uniqueGuards.has('AuthGuard')) {
      authStrategy = 'Custom';
    }

    return {
      system_type: systemType,
      total_files: fileNodes.length,
      layers: {
        presentation: {
          controllers: controllers.length > 0 ? controllers.length : undefined,
          guards: guards.length > 0 ? guards.length : undefined,
          middleware: middleware.length > 0 ? middleware.length : undefined,
          endpoints: httpEntryPoints.length > 0 ? httpEntryPoints.length : undefined,
          components: components.length > 0 ? components.length : undefined,
          pages: pages.length > 0 ? pages.length : undefined
        },
        business: {
          services: services.length > 0 ? services.length : undefined
        },
        data: {
          repositories: repositories.length > 0 ? repositories.length : undefined,
          entities: entities.length > 0 ? entities.length : undefined,
          migrations: migrations.length > 0 ? migrations.length : undefined
        },
        infrastructure: {
          modules: modules.length > 0 ? modules.length : undefined
        }
      },
      api_surface: httpEntryPoints.length > 0 ? {
        total_endpoints: httpEntryPoints.length,
        by_auth: {
          authenticated: authenticatedEndpoints.length,
          public: publicEndpoints.length
        },
        by_method: methodCounts
      } : undefined,
      security: authenticatedEndpoints.length > 0 ? {
        auth_strategy: authStrategy,
        protected_endpoints: authenticatedEndpoints.length,
        guards: Array.from(uniqueGuards)
      } : undefined
    };
  }

  private buildRouteTable(entryPoints: CASEntryPoint[]): CASRouteTableEntry[] {
    const httpEntryPoints = entryPoints.filter(ep => ep.type === 'http');

    return httpEntryPoints.map(ep => {
      const metadata = ep.metadata || {};
      const controllerName = metadata.controller as string || 'Unknown';
      const handlerName = metadata.handler as string || metadata.method_name as string || ep.name;

      return {
        method: ep.trigger?.method?.toUpperCase() || 'GET',
        path: ep.trigger?.path || '/',
        controller: controllerName,
        handler: handlerName,
        auth: ep.security?.authenticated || false,
        guards: metadata.guards as string[] | undefined,
        source_node: ep.source_node,
        description: ep.description
      };
    }).sort((a, b) => {
      if (a.path !== b.path) return a.path.localeCompare(b.path);
      return a.method.localeCompare(b.method);
    });
  }

  private buildDatabaseSchema(nodes: CASNode[], libraries: any[]): CASDatabaseSchema {
    const entities: CASDatabaseEntity[] = [];
    const relationships: string[] = [];

    let orm: string | undefined;
    const mikroormLib = libraries.find(l => l.name?.includes('mikro-orm') || l.name?.includes('@mikro-orm'));
    const typeormLib = libraries.find(l => l.name?.includes('typeorm'));
    const prismaLib = libraries.find(l => l.name?.includes('prisma'));

    if (mikroormLib) orm = 'MikroORM';
    else if (typeormLib) orm = 'TypeORM';
    else if (prismaLib) orm = 'Prisma';

    if (!orm) {
      const importNodes = nodes.filter(n => n.type === 'import');
      if (importNodes.some(n => n.name?.includes('@mikro-orm') || n.metadata?.attributes?.source?.includes('@mikro-orm'))) {
        orm = 'MikroORM';
      } else if (importNodes.some(n => n.name?.includes('typeorm') || n.metadata?.attributes?.source?.includes('typeorm'))) {
        orm = 'TypeORM';
      } else if (importNodes.some(n => n.name?.includes('prisma') || n.metadata?.attributes?.source?.includes('prisma'))) {
        orm = 'Prisma';
      }
    }

    const entityNodes = nodes.filter(n =>
      n.type === 'entity' ||
      n.type === 'model' ||
      n.subcategories?.includes('entity') ||
      n.metadata?.annotations?.some(a => a.includes('Entity')) ||
      (n.type === 'class' && n.source?.file?.includes('/entities/'))
    );

    entityNodes.forEach(entityNode => {
      const fields: CASDatabaseEntity['fields'] = [];
      const entityRelationships: CASDatabaseEntity['relationships'] = [];

      const propertyNodes = nodes.filter(n =>
        n.parent === entityNode.id &&
        (n.type === 'property' || n.type === 'field' || n.type === 'attribute' || n.type === 'variable')
      );

      propertyNodes.forEach(prop => {
        const annotations = prop.metadata?.annotations || [];
        const isPrimary = annotations.some(a => a.includes('PrimaryKey') || a.includes('PrimaryGeneratedColumn'));
        const isUnique = annotations.some(a => a.includes('Unique'));

        let relationType: string | undefined;
        let relTarget: string | undefined;

        for (const ann of annotations) {
          if (ann.includes('OneToMany')) relationType = 'OneToMany';
          else if (ann.includes('ManyToOne')) relationType = 'ManyToOne';
          else if (ann.includes('OneToOne')) relationType = 'OneToOne';
          else if (ann.includes('ManyToMany')) relationType = 'ManyToMany';

          const targetMatch = ann.match(/\(\)\s*=>\s*(\w+)/);
          if (targetMatch) relTarget = targetMatch[1];
        }

        if (relationType && relTarget) {
          entityRelationships.push({
            type: relationType as any,
            target: relTarget,
            field: prop.name
          });

          const cardinality = relationType === 'OneToMany' ? '1:N' :
            relationType === 'ManyToOne' ? 'N:1' :
            relationType === 'ManyToMany' ? 'N:M' : '1:1';
          relationships.push(`${entityNode.name} ${cardinality} ${relTarget} (via ${prop.name})`);
        } else {
          fields.push({
            name: prop.name,
            type: prop.signature?.return_type || 'unknown',
            primary: isPrimary,
            unique: isUnique
          });
        }
      });

      entities.push({
        name: entityNode.name,
        table: entityNode.metadata?.attributes?.tableName as string,
        source_file: entityNode.source?.file,
        fields,
        relationships: entityRelationships
      });
    });

    return {
      orm,
      entities,
      relationships_summary: [...new Set(relationships)]
    };
  }

  private buildExternalServices(
    nodes: CASNode[],
    exitPoints: CASExitPoint[],
    libraries: any[]
  ): CASExternalService[] {
    const services: CASExternalService[] = [];
    const serviceMap = new Map<string, CASExternalService>();

    const jsBuiltins = new Set([
      'console', 'path', 'fs', 'os', 'crypto', 'http', 'https', 'url', 'util',
      'stream', 'buffer', 'events', 'child_process', 'cluster', 'dgram', 'dns',
      'net', 'readline', 'repl', 'tls', 'tty', 'v8', 'vm', 'zlib', 'assert',
      'Object', 'Array', 'String', 'Number', 'Boolean', 'Date', 'Math', 'JSON',
      'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'Proxy', 'Reflect',
      'Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError',
      'RegExp', 'Function', 'Buffer', 'process', 'global', 'setTimeout',
      'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate',
      'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURI', 'decodeURI',
      'encodeURIComponent', 'decodeURIComponent', 'escape', 'unescape', 'eval',
      'Intl', 'Atomics', 'SharedArrayBuffer', 'ArrayBuffer', 'DataView',
      'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
      'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array',
      'BigUint64Array', 'BigInt', 'Infinity', 'NaN', 'undefined', 'null'
    ]);

    exitPoints.forEach(ep => {
      if (ep.type === 'database') {
        const dbKey = ep.target?.service_id || 'primary_database';
        if (!serviceMap.has(dbKey)) {
          serviceMap.set(dbKey, {
            id: `ext_${dbKey}`,
            name: ep.name || 'Database',
            type: 'database',
            purpose: 'bidirectional',
            connected_nodes: [],
            exit_points: []
          });
        }
        const svc = serviceMap.get(dbKey)!;
        if (ep.source_node && !svc.connected_nodes?.includes(ep.source_node)) {
          svc.connected_nodes?.push(ep.source_node);
        }
        svc.exit_points?.push(ep.id);
      } else if (ep.type === 'cache') {
        const cacheKey = 'redis_cache';
        if (!serviceMap.has(cacheKey)) {
          serviceMap.set(cacheKey, {
            id: `ext_${cacheKey}`,
            name: 'Redis',
            type: 'cache',
            purpose: 'bidirectional',
            usage_pattern: {
              operations: []
            },
            connected_nodes: [],
            exit_points: []
          });
        }
        const svc = serviceMap.get(cacheKey)!;
        if (ep.source_node && !svc.connected_nodes?.includes(ep.source_node)) {
          svc.connected_nodes?.push(ep.source_node);
        }
        svc.exit_points?.push(ep.id);
      } else if (ep.type === 'api' || ep.type === 'sdk') {
        const sdkName = ep.target?.sdk || ep.name || 'External API';

        if (jsBuiltins.has(sdkName)) {
          return;
        }

        const key = sdkName.toLowerCase().replace(/\s+/g, '_');

        if (!serviceMap.has(key)) {
          serviceMap.set(key, {
            id: `ext_${key}`,
            name: sdkName,
            type: ep.type === 'sdk' ? 'sdk' : 'api',
            purpose: 'consumption',
            connected_nodes: [],
            exit_points: []
          });
        }
        const svc = serviceMap.get(key)!;
        if (ep.source_node && !svc.connected_nodes?.includes(ep.source_node)) {
          svc.connected_nodes?.push(ep.source_node);
        }
        svc.exit_points?.push(ep.id);
      }
    });

    const aiLibraries = libraries.filter(l =>
      l.name?.includes('openai') ||
      l.name?.includes('anthropic') ||
      l.name?.includes('@anthropic-ai')
    );

    aiLibraries.forEach(lib => {
      const key = lib.name?.includes('openai') ? 'openai' : 'anthropic';
      if (!serviceMap.has(key)) {
        serviceMap.set(key, {
          id: `ext_${key}`,
          name: key === 'openai' ? 'OpenAI' : 'Anthropic',
          type: 'ai_provider',
          purpose: 'consumption',
          configuration: {
            library: lib.name,
            version: lib.version
          }
        });
      }
    });

    serviceMap.forEach(svc => services.push(svc));

    return services;
  }

  private detectPatterns(nodes: CASNode[], edges: CASEdge[]): CASPattern[] {
    const patterns: CASPattern[] = [];

    this.detectRepositoryPattern(nodes, edges, patterns);
    this.detectServiceLayerPattern(nodes, edges, patterns);
    this.detectControllerPattern(nodes, edges, patterns);
    this.detectDependencyInjectionPattern(nodes, edges, patterns);
    this.detectModulePattern(nodes, edges, patterns);
    this.detectGuardPattern(nodes, edges, patterns);
    this.detectGodObjectAntiPattern(nodes, patterns);
    this.detectCircularDependencyAntiPattern(nodes, edges, patterns);

    return patterns;
  }

  private detectRepositoryPattern(nodes: CASNode[], edges: CASEdge[], patterns: CASPattern[]): void {
    const repositories = nodes.filter(n =>
      n.type === 'repository' ||
      n.subcategories?.includes('repository') ||
      n.name.toLowerCase().endsWith('repository') ||
      n.name.toLowerCase().endsWith('repo')
    );

    if (repositories.length === 0) return;

    const diRepositories = repositories.filter(n =>
      n.metadata?.annotations?.some(a => a.includes('Injectable')) ||
      n.subcategories?.includes('injectable')
    );

    const manualRepositories = repositories.filter(n =>
      !n.metadata?.annotations?.some(a => a.includes('Injectable')) &&
      !n.subcategories?.includes('injectable')
    );

    const variations: CASPattern['variations'] = [];
    const deviations: CASPattern['deviations'] = [];

    if (diRepositories.length > 0) {
      variations.push({
        id: 'var-repository-di',
        implementation: 'dependency-injection',
        description: 'Repository managed by DI container with @Injectable decorator',
        instances: diRepositories.map(n => n.id),
        percentage: Math.round((diRepositories.length / repositories.length) * 100)
      });
    }

    if (manualRepositories.length > 0) {
      variations.push({
        id: 'var-repository-manual',
        implementation: 'manual-instantiation',
        description: 'Repository instantiated manually without DI',
        instances: manualRepositories.map(n => n.id),
        percentage: Math.round((manualRepositories.length / repositories.length) * 100)
      });
    }

    if (variations.length > 1) {
      const dominant = variations.reduce((a, b) => a.percentage > b.percentage ? a : b);
      const minority = variations.filter(v => v.id !== dominant.id);

      if (dominant.percentage < 90) {
        deviations.push({
          type: 'mixed-styles',
          severity: 'warning',
          description: `Mixed repository implementation styles: ${variations.map(v => `${v.percentage}% ${v.implementation}`).join(', ')}`,
          affected_instances: minority.flatMap(v => v.instances),
          recommendation: `Consider standardizing on ${dominant.implementation} for consistency`
        });
      }
    }

    patterns.push({
      id: 'repository-pattern',
      name: 'Repository Pattern',
      description: 'Data access abstraction through repository pattern',
      confidence: 0.9,
      instances: repositories.map(n => n.id),
      variations: variations.length > 0 ? variations : undefined,
      deviations: deviations.length > 0 ? deviations : undefined
    });
  }

  private detectServiceLayerPattern(nodes: CASNode[], edges: CASEdge[], patterns: CASPattern[]): void {
    const services = nodes.filter(n =>
      n.type === 'service' ||
      n.subcategories?.includes('service') ||
      (n.name.toLowerCase().endsWith('service') && n.type === 'class')
    );

    if (services.length === 0) return;

    const diServices = services.filter(n =>
      n.metadata?.annotations?.some(a => a.includes('Injectable'))
    );

    const nonDiServices = services.filter(n =>
      !n.metadata?.annotations?.some(a => a.includes('Injectable'))
    );

    const variations: CASPattern['variations'] = [];
    const deviations: CASPattern['deviations'] = [];

    if (diServices.length > 0) {
      variations.push({
        id: 'var-service-di',
        implementation: 'dependency-injection',
        description: 'Service managed by DI container',
        instances: diServices.map(n => n.id),
        percentage: Math.round((diServices.length / services.length) * 100)
      });
    }

    if (nonDiServices.length > 0) {
      variations.push({
        id: 'var-service-standalone',
        implementation: 'standalone',
        description: 'Service without DI management',
        instances: nonDiServices.map(n => n.id),
        percentage: Math.round((nonDiServices.length / services.length) * 100)
      });
    }

    if (nonDiServices.length > 0 && diServices.length > 0) {
      deviations.push({
        type: 'inconsistent-adoption',
        severity: 'info',
        description: `${nonDiServices.length} services are not using dependency injection`,
        affected_instances: nonDiServices.map(n => n.id),
        recommendation: 'Consider using @Injectable for all services for consistent dependency management'
      });
    }

    patterns.push({
      id: 'service-layer-pattern',
      name: 'Service Layer Pattern',
      description: 'Business logic encapsulated in service layer',
      confidence: 0.85,
      instances: services.map(n => n.id),
      variations: variations.length > 0 ? variations : undefined,
      deviations: deviations.length > 0 ? deviations : undefined
    });
  }

  private detectControllerPattern(nodes: CASNode[], edges: CASEdge[], patterns: CASPattern[]): void {
    const controllers = nodes.filter(n =>
      n.type === 'controller' ||
      n.subcategories?.includes('controller') ||
      n.metadata?.annotations?.some(a => a.includes('Controller'))
    );

    if (controllers.length === 0) return;

    const restControllers = controllers.filter(n =>
      n.metadata?.annotations?.some(a =>
        a.includes('Get') || a.includes('Post') || a.includes('Put') ||
        a.includes('Delete') || a.includes('Patch')
      )
    );

    const graphqlResolvers = controllers.filter(n =>
      n.metadata?.annotations?.some(a =>
        a.includes('Resolver') || a.includes('Query') || a.includes('Mutation')
      )
    );

    const variations: CASPattern['variations'] = [];

    if (restControllers.length > 0) {
      variations.push({
        id: 'var-controller-rest',
        implementation: 'rest-api',
        description: 'REST API controllers with HTTP method decorators',
        instances: restControllers.map(n => n.id),
        percentage: Math.round((restControllers.length / controllers.length) * 100)
      });
    }

    if (graphqlResolvers.length > 0) {
      variations.push({
        id: 'var-controller-graphql',
        implementation: 'graphql-resolver',
        description: 'GraphQL resolvers',
        instances: graphqlResolvers.map(n => n.id),
        percentage: Math.round((graphqlResolvers.length / controllers.length) * 100)
      });
    }

    patterns.push({
      id: 'controller-pattern',
      name: 'Controller Pattern',
      description: 'Request handling through controller pattern',
      confidence: 0.9,
      instances: controllers.map(n => n.id),
      variations: variations.length > 0 ? variations : undefined
    });
  }

  private detectDependencyInjectionPattern(nodes: CASNode[], edges: CASEdge[], patterns: CASPattern[]): void {
    const dependsOnEdges = edges.filter(e => e.type === 'depends_on');
    const injectableNodes = nodes.filter(n =>
      n.metadata?.annotations?.some(a => a.includes('Injectable')) ||
      n.subcategories?.includes('injectable')
    );

    if (dependsOnEdges.length === 0 && injectableNodes.length === 0) return;

    const constructorInjected = nodes.filter(n => {
      const incomingDeps = dependsOnEdges.filter(e => e.target === n.id);
      return incomingDeps.length > 0;
    });

    const providedByModules = nodes.filter(n =>
      edges.some(e => e.type === 'provides' && e.target === n.id)
    );

    const variations: CASPattern['variations'] = [];

    if (constructorInjected.length > 0) {
      variations.push({
        id: 'var-di-constructor',
        implementation: 'constructor-injection',
        description: 'Dependencies injected via constructor',
        instances: constructorInjected.map(n => n.id),
        percentage: injectableNodes.length > 0
          ? Math.round((constructorInjected.length / injectableNodes.length) * 100)
          : 100
      });
    }

    patterns.push({
      id: 'dependency-injection-pattern',
      name: 'Dependency Injection Pattern',
      description: 'Dependencies managed through injection container',
      confidence: 0.9,
      instances: injectableNodes.map(n => n.id),
      variations: variations.length > 0 ? variations : undefined
    });
  }

  private detectModulePattern(nodes: CASNode[], edges: CASEdge[], patterns: CASPattern[]): void {
    const modules = nodes.filter(n =>
      n.type === 'module' ||
      n.metadata?.annotations?.some(a => a.includes('Module'))
    );

    if (modules.length === 0) return;

    const featureModules = modules.filter(n =>
      !n.name.toLowerCase().includes('app') &&
      !n.name.toLowerCase().includes('root') &&
      !n.name.toLowerCase().includes('core')
    );

    const coreModules = modules.filter(n =>
      n.name.toLowerCase().includes('app') ||
      n.name.toLowerCase().includes('root') ||
      n.name.toLowerCase().includes('core')
    );

    const variations: CASPattern['variations'] = [];

    if (featureModules.length > 0) {
      variations.push({
        id: 'var-module-feature',
        implementation: 'feature-module',
        description: 'Feature-specific modules for domain separation',
        instances: featureModules.map(n => n.id),
        percentage: Math.round((featureModules.length / modules.length) * 100)
      });
    }

    if (coreModules.length > 0) {
      variations.push({
        id: 'var-module-core',
        implementation: 'core-module',
        description: 'Core/root application modules',
        instances: coreModules.map(n => n.id),
        percentage: Math.round((coreModules.length / modules.length) * 100)
      });
    }

    patterns.push({
      id: 'module-pattern',
      name: 'Module Pattern',
      description: 'Application organized into modules for encapsulation',
      confidence: 0.85,
      instances: modules.map(n => n.id),
      variations: variations.length > 0 ? variations : undefined
    });
  }

  private detectGuardPattern(nodes: CASNode[], edges: CASEdge[], patterns: CASPattern[]): void {
    const guards = nodes.filter(n =>
      n.type === 'guard' ||
      n.subcategories?.includes('guard') ||
      n.name.toLowerCase().includes('guard')
    );

    if (guards.length === 0) return;

    const authGuards = guards.filter(n =>
      n.name.toLowerCase().includes('auth') ||
      n.name.toLowerCase().includes('jwt')
    );

    const roleGuards = guards.filter(n =>
      n.name.toLowerCase().includes('role') ||
      n.name.toLowerCase().includes('permission')
    );

    const otherGuards = guards.filter(n =>
      !authGuards.includes(n) && !roleGuards.includes(n)
    );

    const variations: CASPattern['variations'] = [];

    if (authGuards.length > 0) {
      variations.push({
        id: 'var-guard-auth',
        implementation: 'authentication-guard',
        description: 'Guards for authentication verification',
        instances: authGuards.map(n => n.id),
        percentage: Math.round((authGuards.length / guards.length) * 100)
      });
    }

    if (roleGuards.length > 0) {
      variations.push({
        id: 'var-guard-role',
        implementation: 'role-based-guard',
        description: 'Guards for role/permission verification',
        instances: roleGuards.map(n => n.id),
        percentage: Math.round((roleGuards.length / guards.length) * 100)
      });
    }

    if (otherGuards.length > 0) {
      variations.push({
        id: 'var-guard-custom',
        implementation: 'custom-guard',
        description: 'Custom guards for specific validation',
        instances: otherGuards.map(n => n.id),
        percentage: Math.round((otherGuards.length / guards.length) * 100)
      });
    }

    patterns.push({
      id: 'guard-pattern',
      name: 'Guard Pattern',
      description: 'Authorization and validation through guards',
      confidence: 0.85,
      instances: guards.map(n => n.id),
      variations: variations.length > 0 ? variations : undefined
    });
  }

  private detectGodObjectAntiPattern(nodes: CASNode[], patterns: CASPattern[]): void {
    const godObjects = nodes.filter(n => {
      const lineCount = n.metadata?.metrics?.lines_of_code || 0;
      const complexity = n.metadata?.complexity?.cyclomatic || 0;
      const methodCount = nodes.filter(m => m.parent === n.id && m.type === 'method').length;

      return lineCount > 1000 || complexity > 50 || methodCount > 30;
    });

    if (godObjects.length === 0) return;

    patterns.push({
      id: 'god-object-anti-pattern',
      name: 'God Object Anti-Pattern',
      description: 'Components with excessive complexity or size',
      confidence: 0.7,
      instances: godObjects.map(n => n.id),
      deviations: [{
        type: 'anti-pattern',
        severity: 'warning',
        description: `${godObjects.length} component(s) have excessive complexity or size`,
        affected_instances: godObjects.map(n => n.id),
        recommendation: 'Consider breaking down large components into smaller, focused units'
      }]
    });
  }

  private detectCircularDependencyAntiPattern(nodes: CASNode[], edges: CASEdge[], patterns: CASPattern[]): void {
    const dependencyEdges = edges.filter(e =>
      e.type === 'depends_on' || e.type === 'imports' || e.type === 'uses'
    );

    const adjacency = new Map<string, string[]>();
    dependencyEdges.forEach(edge => {
      if (!adjacency.has(edge.source)) {
        adjacency.set(edge.source, []);
      }
      adjacency.get(edge.source)!.push(edge.target);
    });

    const visited = new Set<string>();
    const visiting = new Set<string>();
    const cycles: string[][] = [];

    const detectCycle = (nodeId: string, path: string[]): boolean => {
      if (visiting.has(nodeId)) {
        const cycleStart = path.indexOf(nodeId);
        if (cycleStart !== -1) {
          cycles.push(path.slice(cycleStart));
        }
        return true;
      }

      if (visited.has(nodeId)) return false;

      visiting.add(nodeId);
      path.push(nodeId);

      const deps = adjacency.get(nodeId) || [];
      for (const dep of deps) {
        detectCycle(dep, [...path]);
      }

      visiting.delete(nodeId);
      visited.add(nodeId);
      return false;
    };

    adjacency.forEach((_, nodeId) => {
      if (!visited.has(nodeId)) {
        detectCycle(nodeId, []);
      }
    });

    if (cycles.length === 0) return;

    const uniqueCycles = cycles.filter((cycle, i) =>
      cycles.findIndex(c => c.join('->') === cycle.join('->')) === i
    );

    patterns.push({
      id: 'circular-dependency-anti-pattern',
      name: 'Circular Dependency Anti-Pattern',
      description: 'Circular dependencies detected in component graph',
      confidence: 0.9,
      instances: [...new Set(uniqueCycles.flat())],
      deviations: uniqueCycles.map((cycle, i) => ({
        type: 'anti-pattern' as const,
        severity: 'error' as const,
        description: `Circular dependency: ${cycle.join(' -> ')} -> ${cycle[0]}`,
        affected_instances: cycle,
        recommendation: 'Break the cycle by introducing an interface or restructuring dependencies'
      }))
    });
  }
}