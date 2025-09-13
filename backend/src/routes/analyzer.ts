import express from 'express';
import { Pool } from 'pg';
import * as path from 'path';
import { IntegratedSystemAnalyzer } from '../analyzer/integrated-system-analyzer';
import { pluginRegistry } from '../analyzer/plugin-registry';
import { Logger } from '../services/logger.service';
import { SpatialLayoutEngine, MetaphorMapper } from '../spatial';

// Import all language analyzers
import { TypeScriptJavaScriptAnalyzer } from '../analyzer/languages/typescript-javascript-analyzer';
import { PythonAnalyzer } from '../analyzer/languages/python-analyzer';
import { JavaAnalyzer } from '../analyzer/languages/java-analyzer';
import { CSharpAnalyzer } from '../analyzer/languages/csharp-analyzer';
import { GoAnalyzer } from '../analyzer/languages/go-analyzer';
import { RustAnalyzer } from '../analyzer/languages/rust-analyzer';
import { PHPAnalyzer } from '../analyzer/languages/php-analyzer';

// Import all framework analyzers
import { ReactAnalyzer } from '../analyzer/frameworks/frontend/react-analyzer';
import { VueAnalyzer } from '../analyzer/frameworks/frontend/vue-analyzer';
import { AngularAnalyzer } from '../analyzer/frameworks/frontend/angular-analyzer';
import { NextJSAnalyzer } from '../analyzer/frameworks/frontend/nextjs-analyzer';
import { ExpressAnalyzer } from '../analyzer/frameworks/backend/express-analyzer';
import { NestJSAnalyzer } from '../analyzer/frameworks/backend/nestjs-analyzer';
import { DjangoAnalyzer } from '../analyzer/frameworks/backend/django-analyzer';
import { FlaskAnalyzer } from '../analyzer/frameworks/backend/flask-analyzer';
import { FastAPIAnalyzer } from '../analyzer/frameworks/backend/fastapi-analyzer';
import { SpringBootAnalyzer } from '../analyzer/frameworks/backend/springboot-analyzer';
import { LaravelAnalyzer } from '../analyzer/frameworks/backend/laravel-analyzer';
import { GinAnalyzer } from '../analyzer/frameworks/backend/gin-analyzer';
import { ActixWebAnalyzer } from '../analyzer/frameworks/backend/actixweb-analyzer';
import { AspNetCoreAnalyzer } from '../analyzer/frameworks/backend/aspnetcore-analyzer';

const logger = new Logger('AnalyzerRouter');

export function createAnalyzerRoutes(pool: Pool) {
  const router = express.Router();

  // Register all analyzers with the plugin registry on startup
  async function registerAllAnalyzers() {
    try {
      // Register language analyzers
      // Note: registerPlugin expects an AnalyzerPlugin object, not an analyzer instance
      // We need to create plugin wrappers for each analyzer
      const languageAnalyzers = [
        { name: 'TypeScriptJavaScript', analyzer: TypeScriptJavaScriptAnalyzer },
        { name: 'Python', analyzer: PythonAnalyzer },
        { name: 'Java', analyzer: JavaAnalyzer },
        { name: 'CSharp', analyzer: CSharpAnalyzer },
        { name: 'Go', analyzer: GoAnalyzer },
        { name: 'Rust', analyzer: RustAnalyzer },
        { name: 'PHP', analyzer: PHPAnalyzer }
      ];

      for (const { name, analyzer } of languageAnalyzers) {
        await pluginRegistry.registerPlugin({
          id: `${name.toLowerCase()}-analyzer`,
          name: `${name}Analyzer`,
          version: '1.0.0',
          description: `Language analyzer for ${name}`,
          author: 'Unravl Team',
          analyzer: analyzer as any,
          supportedLanguages: [name],
          supportedFrameworks: [],
          type: 'internal',
          category: 'language',
          priority: 50,
          metadata: {
            minEngineVersion: '1.0.0',
            license: 'MIT',
            keywords: [name.toLowerCase(), 'language', 'analyzer'],
            maintainers: ['Unravl Team'],
            lastUpdated: new Date(),
            verified: true
          },
          dependencies: []
        });
      }

      // Register frontend framework analyzers
      const frontendAnalyzers = [
        { name: 'React', analyzer: ReactAnalyzer },
        { name: 'Vue', analyzer: VueAnalyzer },
        { name: 'Angular', analyzer: AngularAnalyzer },
        { name: 'NextJS', analyzer: NextJSAnalyzer }
      ];

      for (const { name, analyzer } of frontendAnalyzers) {
        await pluginRegistry.registerPlugin({
          id: `${name.toLowerCase()}-analyzer`,
          name: `${name}Analyzer`,
          version: '1.0.0',
          description: `Frontend framework analyzer for ${name}`,
          author: 'Unravl Team',
          analyzer: analyzer as any,
          supportedLanguages: [],
          supportedFrameworks: [name],
          type: 'internal',
          category: 'framework',
          priority: 60,
          metadata: {
            minEngineVersion: '1.0.0',
            license: 'MIT',
            keywords: [name.toLowerCase(), 'frontend', 'framework', 'analyzer'],
            maintainers: ['Unravl Team'],
            lastUpdated: new Date(),
            verified: true
          },
          dependencies: []
        });
      }

      // Register backend framework analyzers
      const backendAnalyzers = [
        { name: 'Express', analyzer: ExpressAnalyzer },
        { name: 'NestJS', analyzer: NestJSAnalyzer },
        { name: 'Django', analyzer: DjangoAnalyzer },
        { name: 'Flask', analyzer: FlaskAnalyzer },
        { name: 'FastAPI', analyzer: FastAPIAnalyzer },
        { name: 'SpringBoot', analyzer: SpringBootAnalyzer },
        { name: 'Laravel', analyzer: LaravelAnalyzer },
        { name: 'Gin', analyzer: GinAnalyzer },
        { name: 'ActixWeb', analyzer: ActixWebAnalyzer },
        { name: 'AspNetCore', analyzer: AspNetCoreAnalyzer }
      ];

      for (const { name, analyzer } of backendAnalyzers) {
        await pluginRegistry.registerPlugin({
          id: `${name.toLowerCase()}-analyzer`,
          name: `${name}Analyzer`,
          version: '1.0.0',
          description: `Backend framework analyzer for ${name}`,
          author: 'Unravl Team',
          analyzer: analyzer as any,
          supportedLanguages: [],
          supportedFrameworks: [name],
          type: 'internal',
          category: 'framework',
          priority: 60,
          metadata: {
            minEngineVersion: '1.0.0',
            license: 'MIT',
            keywords: [name.toLowerCase(), 'backend', 'framework', 'analyzer'],
            maintainers: ['Unravl Team'],
            lastUpdated: new Date(),
            verified: true
          },
          dependencies: []
        });
      }

      logger.info('All analyzers registered successfully');
    } catch (error) {
      logger.error('Failed to register analyzers:', error);
    }
  }

  // Register analyzers on router initialization
  registerAllAnalyzers();

  // Analyze repository endpoint - now using IntegratedSystemAnalyzer
  router.post('/analyze', async (req, res) => {
    try {
      const { repositoryPath, projectName, options = {} } = req.body;
      
      if (!repositoryPath) {
        return res.status(400).json({
          error: 'Repository path is required'
        });
      }

      logger.info(`Starting comprehensive analysis of repository: ${repositoryPath}`);

      // Create integrated analyzer instance
      const integratedAnalyzer = new IntegratedSystemAnalyzer();

      // Configure analysis options
      const analysisOptions = {
        ...options,
        persistResults: options.persistResults !== false,
        generateManifest: options.generateManifest !== false,
        usePluginRegistry: true,
        enableTelemetry: true,
        manifestOutputPath: options.manifestOutputPath,
        projectId: projectName || path.basename(repositoryPath)
      };

      // Run comprehensive analysis using all registered analyzers
      const result = await integratedAnalyzer.analyzeProject(repositoryPath, analysisOptions);

      // Extract all the data from the blueprint
      const blueprint = result.blueprint;

      // Generate spatial visualization if requested
      let spatialBlueprint = null;
      if (options.generateSpatialVisualization !== false) {
        try {
          logger.info('Generating spatial visualization...');
          
          // Initialize spatial layout engine (2D/2.5D isometric only, no 3D)
          const spatialEngine = new SpatialLayoutEngine({
            enableRealTimeUpdates: options.enableRealTimeUpdates || false,
            optimizationLevel: 'medium',
            collisionDetection: true,
            renderingQuality: 'high'
          });
          
          // Transform to spatial representation
          spatialBlueprint = await spatialEngine.generateSpatialLayout(blueprint);
          
          logger.info('Spatial visualization generated successfully');
        } catch (spatialError: any) {
          logger.warn('Failed to generate spatial visualization:', spatialError);
          // Continue without spatial - it's optional
        }
      }

      // Enhance the response with all available data
      const enhancedBlueprint = {
        ...blueprint,
        id: result.analysisId,
        projectId: analysisOptions.projectId,
        projectName: projectName || path.basename(repositoryPath),
        
        // Add analysis metadata
        metadata: {
          ...blueprint.metadata,
          analysisDate: new Date(),
          repositoryPath,
          analyzer: result.metadata.analyzer,
          version: '2.0.0',
          duration: result.duration,
          pluginsUsed: result.metadata.pluginsUsed,
          totalComponents: blueprint.components?.length || 0,
          frameworkVersion: blueprint.technologyStack?.primaryFramework?.version || null,
          primaryLanguage: blueprint.technologyStack?.primaryFramework?.language || 'Unknown',
          languageDistribution: blueprint.technologyStack?.languages?.reduce((acc: any, lang: any) => {
            acc[lang.name] = lang.percentage / 100;
            return acc;
          }, {}) || {},
          codebaseSize: {
            totalLines: blueprint.components?.reduce((sum: number, c: any) => 
              sum + (c.metadata?.lineCount || 0), 0) || 0,
            codeLines: blueprint.components?.reduce((sum: number, c: any) => 
              sum + (c.metadata?.linesOfCode || 0), 0) || 0,
            commentLines: 0,
            blankLines: 0
          }
        },

        // Statistics
        statistics: {
          totalComponents: blueprint.components?.length || 0,
          totalConnections: blueprint.connections?.length || 0,
          averageComplexity: blueprint.components?.reduce((sum: number, c: any) => 
            sum + (c.metadata?.complexity || 0), 0) / Math.max(blueprint.components?.length || 1, 1) || 0,
          riskAreas: blueprint.riskAreas?.length || 0,
          orphanedCount: blueprint.orphanedComponents?.length || 0,
          cyclomaticComplexity: blueprint.components?.reduce((sum: number, c: any) => 
            sum + (c.metadata?.complexity || 0), 0) || 0,
          technicalDebt: blueprint.components?.reduce((sum: number, c: any) => 
            sum + (c.metrics?.technicalDebt || 0), 0) || 0
        }
      };

      // Get list of all analyzers that were actually used
      const analyzersUsed = await getUsedAnalyzers(blueprint);

      logger.info(`Analysis completed for ${repositoryPath}. Duration: ${result.duration}ms`);

      res.json({
        success: true,
        blueprint: enhancedBlueprint,
        spatialVisualization: spatialBlueprint,
        analysisId: result.analysisId,
        manifest: result.manifest,
        manifestPath: result.manifestPath,
        analyzersRun: analyzersUsed,
        metadata: result.metadata
      });

    } catch (error) {
      logger.error('Analysis failed:', error);
      res.status(500).json({
        error: 'Analysis failed',
        message: error instanceof Error ? error.message : 'Unknown error occurred',
        details: process.env.NODE_ENV !== 'production' ? error : undefined
      });
    }
  });

  // Get available analyzers - now returns all registered analyzers
  router.get('/analyzers', async (req, res) => {
    const stats = pluginRegistry.getStatistics();
    const analyzers = pluginRegistry.getPlugins();

    res.json({
      totalAnalyzers: stats.totalPlugins,
      categories: {
        language: analyzers.filter((a: any) => a.type === 'language'),
        framework: analyzers.filter((a: any) => a.type === 'framework'),
        pattern: analyzers.filter((a: any) => a.type === 'pattern'),
        custom: analyzers.filter((a: any) => a.type === 'custom')
      },
      supportedLanguages: stats.supportedLanguages,
      supportedFrameworks: stats.supportedFrameworks,
      availableAnalyzers: [
        {
          name: 'IntegratedSystemAnalyzer',
          description: 'Master orchestrator that coordinates all available analyzers',
          capabilities: ['automatic analyzer selection', 'comprehensive analysis', 'manifest generation', 'telemetry integration']
        },
        {
          name: 'Language Analyzers',
          description: 'Language-specific analysis engines',
          analyzers: ['TypeScript/JavaScript', 'Python', 'Java', 'C#', 'Go', 'Rust', 'PHP']
        },
        {
          name: 'Frontend Framework Analyzers',
          description: 'Frontend framework-specific analyzers',
          analyzers: ['React', 'Vue', 'Angular', 'Next.js']
        },
        {
          name: 'Backend Framework Analyzers',
          description: 'Backend framework-specific analyzers',
          analyzers: ['Express', 'NestJS', 'Django', 'Flask', 'FastAPI', 'Spring Boot', 'Laravel', 'Gin', 'Actix Web', 'ASP.NET Core']
        },
        {
          name: 'Pattern Analyzers',
          description: 'Architectural and design pattern detection',
          analyzers: ['SystemTopologyAnalyzer', 'FrameworkDetector', 'DependencyMapper', 'EntryExitDetector']
        }
      ]
    });
  });

  // Get analyzer statistics
  router.get('/analyzers/stats', (req, res) => {
    const stats = pluginRegistry.getStatistics();
    res.json(stats);
  });

  // Analyze with specific analyzer
  router.post('/analyze/specific', async (req, res) => {
    try {
      const { repositoryPath, analyzerName, options = {} } = req.body;
      
      if (!repositoryPath || !analyzerName) {
        return res.status(400).json({
          error: 'Repository path and analyzer name are required'
        });
      }

      logger.info(`Running specific analysis with ${analyzerName} on ${repositoryPath}`);

      // Get specific analyzer from registry
      const plugin = pluginRegistry.getPlugin(analyzerName);
      const analyzer = plugin ? new (plugin.analyzer as any)() : null;
      
      if (!analyzer) {
        return res.status(404).json({
          error: `Analyzer '${analyzerName}' not found`
        });
      }

      // Run analysis with specific analyzer
      const result = await analyzer.analyzeRepository(repositoryPath, options);

      res.json({
        success: true,
        blueprint: result,
        analyzer: analyzerName
      });

    } catch (error) {
      logger.error('Specific analysis failed:', error);
      res.status(500).json({
        error: 'Analysis failed',
        message: error instanceof Error ? error.message : 'Unknown error occurred'
      });
    }
  });

  // Generate spatial visualization for existing blueprint
  router.post('/spatial/transform', async (req, res) => {
    try {
      const { blueprint, options = {} } = req.body;
      
      if (!blueprint) {
        return res.status(400).json({
          error: 'Blueprint is required for spatial transformation'
        });
      }

      logger.info('Transforming blueprint to spatial visualization...');

      // Initialize spatial layout engine (2D/2.5D isometric only, no 3D)
      const spatialEngine = new SpatialLayoutEngine({
        enableRealTimeUpdates: options.enableRealTimeUpdates || false,
        optimizationLevel: options.optimizationLevel || 'medium',
        collisionDetection: options.collisionDetection !== false,
        renderingQuality: options.renderingQuality || 'high'
      });

      // Generate spatial layout
      const spatialBlueprint = await spatialEngine.generateSpatialLayout(blueprint);

      // Get metaphor mappings for the components
      const metaphorMapper = new MetaphorMapper();
      const metaphors = blueprint.components?.map((component: any) => ({
        componentId: component.id,
        roomType: metaphorMapper.mapComponentToRoomType(component)
      }));

      logger.info('Spatial transformation completed successfully');

      res.json({
        success: true,
        spatialVisualization: spatialBlueprint,
        metaphorMappings: metaphors,
        layoutType: spatialBlueprint.layout?.type || 'unknown',
        totalRooms: spatialBlueprint.rooms?.length || 0,
        totalBuildings: spatialBlueprint.buildings?.length || 0,
        totalPathways: spatialBlueprint.pathways?.length || 0
      });

    } catch (error) {
      logger.error('Spatial transformation failed:', error);
      res.status(500).json({
        error: 'Spatial transformation failed',
        message: error instanceof Error ? error.message : 'Unknown error occurred'
      });
    }
  });

  return router;
}

// Helper function to determine which analyzers were used
async function getUsedAnalyzers(blueprint: any): Promise<any[]> {
  const analyzersUsed = [];

  // Check technology stack to see what was detected
  if (blueprint.technologyStack) {
    const techStack = blueprint.technologyStack;
    
    // Language analyzers used
    if (techStack.languages) {
      techStack.languages.forEach((lang: any) => {
        analyzersUsed.push({
          name: `${lang.name}Analyzer`,
          type: 'language',
          status: 'fulfilled'
        });
      });
    }

    // Framework analyzers used
    if (techStack.primaryFramework) {
      analyzersUsed.push({
        name: `${techStack.primaryFramework.name}Analyzer`,
        type: 'framework',
        status: 'fulfilled'
      });
    }

    if (techStack.additionalFrameworks) {
      techStack.additionalFrameworks.forEach((framework: any) => {
        analyzersUsed.push({
          name: `${framework.name}Analyzer`,
          type: 'framework',
          status: 'fulfilled'
        });
      });
    }
  }

  // Pattern analyzers are always used
  analyzersUsed.push(
    { name: 'SystemTopologyAnalyzer', type: 'pattern', status: 'fulfilled' },
    { name: 'FrameworkDetector', type: 'pattern', status: 'fulfilled' },
    { name: 'DependencyMapper', type: 'pattern', status: 'fulfilled' },
    { name: 'EntryExitDetector', type: 'pattern', status: 'fulfilled' }
  );

  return analyzersUsed;
}