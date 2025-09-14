import express, { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';
import * as fs from 'fs-extra';
import { Logger } from '../services/logger.service';
import { SystemTopologyAnalyzer } from '../analyzer/system-topology-analyzer';
import { projectRepository, Project, ProjectWithStats } from '../database/repositories/project-repository';

const logger = new Logger('ProjectAPI');

export interface AnalysisRequest {
  repositoryPath?: string;
  repositoryUrl?: string;
  branch?: string;
  commitSha?: string;
  type?: 'full' | 'incremental' | 'manual' | 'scheduled';
}

export interface AnalysisResult {
  id: string;
  projectId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: number;
  currentOperation?: string;
  startedAt?: Date;
  completedAt?: Date;
  blueprint?: any;
  error?: string;
}

class AnalysisTracker {
  private static analyses = new Map<string, AnalysisResult>();
  
  static create(projectId: string): AnalysisResult {
    const analysis: AnalysisResult = {
      id: uuidv4(),
      projectId,
      status: 'pending',
      progress: 0
    };
    this.analyses.set(analysis.id, analysis);
    return analysis;
  }
  
  static update(id: string, updates: Partial<AnalysisResult>): void {
    const analysis = this.analyses.get(id);
    if (analysis) {
      Object.assign(analysis, updates);
    }
  }
  
  static get(id: string): AnalysisResult | undefined {
    return this.analyses.get(id);
  }
  
  static getByProject(projectId: string): AnalysisResult[] {
    return Array.from(this.analyses.values()).filter(a => a.projectId === projectId);
  }
}

export function createProjectRoutes(pool: Pool) {
  const router = express.Router();

  // Get all projects
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      logger.info('Fetching all projects');
      
      // For demo purposes, using a fixed organization ID
      const organizationId = req.query.organizationId as string || 'demo-org';
      
      const result = await projectRepository.find({
        organizationId,
        pagination: {
          page: parseInt(req.query.page as string) || 1,
          limit: parseInt(req.query.limit as string) || 20
        }
      });

      // If no projects exist, create demo projects
      if (result.data.length === 0) {
        logger.info('No projects found, creating demo projects');
        
        const demoProjects = [
          {
            id: uuidv4(),
            organization_id: organizationId,
            name: 'Frontend Application',
            description: 'React-based frontend with TypeScript',
            repository_url: 'https://github.com/example/frontend',
            language: 'TypeScript',
            framework: 'React',
            status: 'active' as const,
            settings: {},
            created_at: new Date(),
            default_branch: 'main'
          },
          {
            id: uuidv4(),
            organization_id: organizationId,
            name: 'Backend API',
            description: 'Node.js Express API service',
            repository_url: 'https://github.com/example/backend',
            language: 'TypeScript',
            framework: 'Express',
            status: 'active' as const,
            settings: {},
            created_at: new Date(),
            default_branch: 'main'
          },
          {
            id: uuidv4(),
            organization_id: organizationId,
            name: 'Mobile App',
            description: 'React Native mobile application',
            repository_url: 'https://github.com/example/mobile',
            language: 'TypeScript',
            framework: 'React Native',
            status: 'active' as const,
            settings: {},
            created_at: new Date(),
            default_branch: 'main'
          }
        ];

        // Add demo projects (without DB for now)
        const projects = demoProjects.map(p => ({
          ...p,
          updated_at: p.created_at,
          last_analyzed_at: undefined
        }));

        res.json({
          data: projects,
          pagination: {
            page: 1,
            limit: 20,
            total: projects.length,
            pages: 1
          }
        });
      } else {
        res.json(result);
      }
    } catch (error) {
      logger.error('Failed to fetch projects:', error);
      res.status(500).json({
        error: 'Failed to fetch projects',
        message: (error as Error).message
      });
    }
  });

  // Get project by ID
  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const organizationId = req.query.organizationId as string || 'demo-org';
      
      logger.info(`Fetching project ${id}`);
      
      const project = await projectRepository.findWithStats(id, organizationId);
      
      if (!project) {
        // Return demo project for testing
        const demoProject: ProjectWithStats = {
          id,
          organization_id: organizationId,
          name: 'Demo Project',
          description: 'This is a demo project for testing',
          repository_url: 'https://github.com/example/demo',
          language: 'TypeScript',
          framework: 'React',
          status: 'active',
          settings: {},
          created_at: new Date(),
          updated_at: new Date(),
          default_branch: 'main',
          analysis_count: 0,
          component_count: 0,
          error_count: 0,
          telemetry_events_count: 0,
          health_score: 85
        };
        
        return res.json(demoProject);
      }
      
      res.json(project);
    } catch (error) {
      logger.error(`Failed to fetch project ${req.params.id}:`, error);
      res.status(500).json({
        error: 'Failed to fetch project',
        message: (error as Error).message
      });
    }
  });

  // Get project architecture
  router.get('/:id/architecture', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      logger.info(`Fetching architecture for project ${id}`);
      
      // Check if we have a completed analysis
      const analyses = AnalysisTracker.getByProject(id);
      const completedAnalysis = analyses.find(a => a.status === 'completed');
      
      if (!completedAnalysis || !completedAnalysis.blueprint) {
        return res.json({
          projectId: id,
          message: 'No architecture data available. Please run analysis first.',
          architecture: {
            layers: [],
            components: [],
            relationships: [],
            entryPoints: [],
            exitPoints: [],
            riskAreas: [],
            callGraph: {
              nodes: [],
              edges: [],
              entryPoints: [],
              cycles: [],
              layers: [],
              hotPaths: [],
              deadCode: []
            }
          }
        });
      }
      
      // Return the actual analyzed architecture
      const blueprint = completedAnalysis.blueprint;
      res.json({
        projectId: id,
        timestamp: completedAnalysis.completedAt,
        architecture: {
          layers: blueprint.topology?.layers || [],
          components: blueprint.components || [],
          relationships: blueprint.relationships || [],
          entryPoints: blueprint.topology?.entryPoints || [],
          exitPoints: blueprint.topology?.exitPoints || [],
          riskAreas: blueprint.topology?.patterns?.filter((p: any) => p.type === 'risk') || [],
          callGraph: {
            nodes: blueprint.components?.map((c: any) => ({
              id: c.id,
              name: c.name,
              type: c.type,
              layer: c.metadata?.layer
            })) || [],
            edges: blueprint.relationships?.map((r: any) => ({
              from: r.from,
              to: r.to,
              type: r.type,
              weight: r.weight || 1
            })) || [],
            entryPoints: blueprint.topology?.entryPoints || [],
            cycles: [],
            layers: blueprint.topology?.layers || [],
            hotPaths: [],
            deadCode: []
          }
        },
        statistics: blueprint.statistics || {}
      });
    } catch (error) {
      logger.error(`Failed to fetch architecture for project ${req.params.id}:`, error);
      res.status(500).json({
        error: 'Failed to fetch architecture',
        message: (error as Error).message
      });
    }
  });

  // Get component details
  router.get('/:id/components/:componentId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id, componentId } = req.params;
      logger.info(`Fetching component ${componentId} for project ${id}`);
      
      // Get the latest analysis
      const analyses = AnalysisTracker.getByProject(id);
      const completedAnalysis = analyses.find(a => a.status === 'completed');
      
      if (!completedAnalysis || !completedAnalysis.blueprint) {
        return res.status(404).json({
          error: 'No analysis data',
          message: 'Please run analysis first to get component details'
        });
      }
      
      // Find the component in the blueprint
      const component = completedAnalysis.blueprint.components?.find(
        (c: any) => c.id === componentId
      );
      
      if (!component) {
        return res.status(404).json({
          error: 'Component not found',
          message: `Component ${componentId} not found in project ${id}`
        });
      }
      
      // Get related connections
      const incomingConnections = completedAnalysis.blueprint.relationships?.filter(
        (r: any) => r.to === componentId
      ) || [];
      
      const outgoingConnections = completedAnalysis.blueprint.relationships?.filter(
        (r: any) => r.from === componentId
      ) || [];
      
      res.json({
        projectId: id,
        component: {
          ...component,
          connections: {
            incoming: incomingConnections,
            outgoing: outgoingConnections,
            total: incomingConnections.length + outgoingConnections.length
          }
        }
      });
    } catch (error) {
      logger.error(`Failed to fetch component ${req.params.componentId}:`, error);
      res.status(500).json({
        error: 'Failed to fetch component',
        message: (error as Error).message
      });
    }
  });

  // Trigger analysis
  router.post('/analyze', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { repositoryPath, projectId = 'demo-project' } = req.body as AnalysisRequest & { projectId?: string };
      
      if (!repositoryPath) {
        return res.status(400).json({
          error: 'Repository path required',
          message: 'Please provide repositoryPath in the request body'
        });
      }
      
      // Verify path exists
      if (!await fs.pathExists(repositoryPath)) {
        return res.status(404).json({
          error: 'Repository not found',
          message: `Path ${repositoryPath} does not exist`
        });
      }
      
      logger.info(`Starting analysis for ${repositoryPath}`);
      
      // Create analysis tracking
      const analysis = AnalysisTracker.create(projectId);
      
      // Start analysis asynchronously
      setImmediate(async () => {
        try {
          AnalysisTracker.update(analysis.id, {
            status: 'running',
            progress: 10,
            currentOperation: 'Initializing analyzer',
            startedAt: new Date()
          });
          
          // Create system topology analyzer
          const analyzer = new SystemTopologyAnalyzer();
          
          AnalysisTracker.update(analysis.id, {
            progress: 30,
            currentOperation: 'Analyzing codebase structure'
          });
          
          // Run analysis
          const result = await analyzer.analyzeTopology(repositoryPath);
          
          AnalysisTracker.update(analysis.id, {
            progress: 90,
            currentOperation: 'Processing results'
          });
          
          // Store the blueprint
          const blueprint = {
            components: result.components.map(comp => ({
              id: comp.id,
              name: comp.name,
              type: comp.type,
              path: comp.path,
              dependencies: comp.dependencies,
              dependents: comp.dependents,
              metadata: {
                ...comp.metadata,
                lastModified: comp.metadata.lastModified?.toISOString(),
                functions: comp.metadata.functions?.map(func => ({
                  ...func,
                  calls: func.calls?.map(call => ({
                    target: call.target,
                    count: call.count
                  }))
                }))
              }
            })),
            relationships: result.relationships.map(rel => ({
              from: rel.from,
              to: rel.to,
              type: rel.type,
              weight: rel.weight || 1,
              metadata: rel.metadata || {}
            })),
            topology: {
              layers: result.topology.layers,
              flows: result.topology.flows,
              patterns: result.topology.patterns,
              entryPoints: result.topology.entryPoints,
              integrations: result.topology.integrations,
              exitPoints: []
            },
            statistics: {
              totalComponents: result.components.length,
              totalConnections: result.relationships.length,
              avgComplexity: result.components.length > 0 ? 
                result.components.reduce((sum, c) => sum + c.metadata.complexity, 0) / result.components.length : 0,
              totalLines: result.components.reduce((sum, c) => sum + c.metadata.lineCount, 0),
              languagesDetected: [...new Set(result.components.map(c => c.metadata.layer))],
              frameworksDetected: result.topology.patterns.filter(p => p.type === 'architectural').map(p => p.name)
            }
          };
          
          AnalysisTracker.update(analysis.id, {
            status: 'completed',
            progress: 100,
            currentOperation: 'Analysis complete',
            completedAt: new Date(),
            blueprint
          });
          
          logger.info(`Analysis ${analysis.id} completed successfully`);
        } catch (error) {
          logger.error(`Analysis ${analysis.id} failed:`, error);
          AnalysisTracker.update(analysis.id, {
            status: 'failed',
            progress: 0,
            error: (error as Error).message,
            completedAt: new Date()
          });
        }
      });
      
      // Return immediate response
      res.json({
        analysisId: analysis.id,
        projectId,
        status: 'pending',
        message: 'Analysis started',
        statusUrl: `/api/analyze/${analysis.id}/status`
      });
    } catch (error) {
      logger.error('Failed to start analysis:', error);
      res.status(500).json({
        error: 'Failed to start analysis',
        message: (error as Error).message
      });
    }
  });

  // Get analysis status
  router.get('/analyze/:id/status', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const analysis = AnalysisTracker.get(id);
      
      if (!analysis) {
        return res.status(404).json({
          error: 'Analysis not found',
          message: `No analysis found with ID ${id}`
        });
      }
      
      res.json({
        id: analysis.id,
        projectId: analysis.projectId,
        status: analysis.status,
        progress: analysis.progress,
        currentOperation: analysis.currentOperation,
        startedAt: analysis.startedAt,
        completedAt: analysis.completedAt,
        error: analysis.error,
        hasResults: analysis.status === 'completed' && !!analysis.blueprint
      });
    } catch (error) {
      logger.error(`Failed to get analysis status ${req.params.id}:`, error);
      res.status(500).json({
        error: 'Failed to get analysis status',
        message: (error as Error).message
      });
    }
  });

  // Create new project
  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const organizationId = req.body.organizationId || 'demo-org';
      const projectData = {
        ...req.body,
        id: uuidv4(),
        organization_id: organizationId,
        status: 'active' as const,
        settings: req.body.settings || {},
        created_at: new Date(),
        updated_at: new Date(),
        default_branch: req.body.default_branch || 'main'
      };
      
      logger.info('Creating new project:', projectData.name);
      
      // For demo, just return the created project
      res.status(201).json(projectData);
    } catch (error) {
      logger.error('Failed to create project:', error);
      res.status(500).json({
        error: 'Failed to create project',
        message: (error as Error).message
      });
    }
  });

  // Update project
  router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const organizationId = req.body.organizationId || 'demo-org';
      
      logger.info(`Updating project ${id}`);
      
      const updated = await projectRepository.update(id, req.body, organizationId);
      
      if (!updated) {
        return res.status(404).json({
          error: 'Project not found',
          message: `Project ${id} not found`
        });
      }
      
      res.json(updated);
    } catch (error) {
      logger.error(`Failed to update project ${req.params.id}:`, error);
      res.status(500).json({
        error: 'Failed to update project',
        message: (error as Error).message
      });
    }
  });

  // Delete project
  router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const organizationId = req.query.organizationId as string || 'demo-org';
      
      logger.info(`Archiving project ${id}`);
      
      const success = await projectRepository.archiveProject(id, organizationId);
      
      if (!success) {
        return res.status(404).json({
          error: 'Project not found',
          message: `Project ${id} not found`
        });
      }
      
      res.status(204).send();
    } catch (error) {
      logger.error(`Failed to delete project ${req.params.id}:`, error);
      res.status(500).json({
        error: 'Failed to delete project',
        message: (error as Error).message
      });
    }
  });

  return router;
}