import express from 'express';
import { Pool } from 'pg';
import * as path from 'path';
import * as fs from 'fs-extra';
import { Logger } from '../services/logger.service';
import { CASAnalyzerService } from '../analyzer/services/cas-analyzer.service';

const logger = new Logger('CASAnalyzerAPI');
const casAnalyzerService = new CASAnalyzerService();

export function createAnalyzerRoutes(pool: Pool | null) {
  const router = express.Router();

  // CAS analysis endpoint
  router.post('/projects/:id/analyze', async (req, res) => {
    const projectId = req.params.id;
    const startTime = Date.now();

    try {
      const { repositoryPath, options = {} } = req.body;

      if (!repositoryPath) {
        return res.status(400).json({
          success: false,
          error: 'Repository path is required',
          timestamp: new Date().toISOString()
        });
      }

      logger.info(`Starting CAS analysis for project ${projectId} at ${repositoryPath}`);

      const casResult = await casAnalyzerService.analyzeProject({
        projectPath: repositoryPath,
        options: {
          includeTests: options.includeTests || false,
          maxDepth: options.maxDepth || 5,
          filters: options.filters || ['node_modules/**', 'dist/**', 'build/**', '.git/**'],
          ...options
        }
      });

      const processingTime = Date.now() - startTime;

      // Store in database if pool is available
      if (pool) {
        try {
          await pool.query(
            'INSERT INTO analysis_runs (project_id, result, processing_time, timestamp) VALUES ($1, $2, $3, $4)',
            [projectId, JSON.stringify(casResult), processingTime, new Date()]
          );
          logger.info(`Analysis results stored for project ${projectId}`);
        } catch (dbError) {
          logger.warn(`Failed to store analysis results: ${(dbError as Error).message}`);
        }
      }

      const response = {
        success: true,
        projectId,
        processingTime,
        ...casResult,
        metadata: {
          processingTime,
          timestamp: new Date().toISOString()
        }
      };

      logger.info(`CAS analysis completed for project ${projectId} in ${processingTime}ms`);
      logger.info(`Found: ${casResult.nodes.length} nodes, ${casResult.edges.length} edges`);

      res.json(response);
    } catch (error: any) {
      const processingTime = Date.now() - startTime;

      logger.error(`CAS analysis failed for project ${projectId}:`, error);
      res.status(500).json({
        success: false,
        projectId,
        error: error.message || 'Analysis failed',
        processingTime,
        timestamp: new Date().toISOString()
      });
    }
  });

  // Get detected analyzers endpoint
  router.get('/projects/:id/detected-analyzers', async (req, res) => {
    try {
      const { repositoryPath } = req.query;

      if (!repositoryPath || typeof repositoryPath !== 'string') {
        return res.status(400).json({
          error: 'Repository path query parameter is required'
        });
      }

      const detectedAnalyzers = await casAnalyzerService.getDetectedAnalyzers(repositoryPath);

      res.json({
        projectId: req.params.id,
        repositoryPath,
        detectedAnalyzers: detectedAnalyzers.map(a => ({
          id: a.id,
          name: a.name,
          type: a.type,
          version: a.version,
          detectPatterns: a.detectPatterns
        })),
        timestamp: new Date().toISOString()
      });
    } catch (error: any) {
      logger.error(`Failed to detect analyzers: ${error.message}`);
      res.status(500).json({
        error: error.message || 'Failed to detect analyzers',
        timestamp: new Date().toISOString()
      });
    }
  });

  // Health check endpoint
  router.get('/health', async (req, res) => {
    try {
      res.json({
        status: 'healthy',
        service: 'CAS Analyzer API',
        timestamp: new Date().toISOString(),
        version: '1.0.0'
      });
    } catch (error) {
      res.status(500).json({
        status: 'unhealthy',
        error: (error as Error).message,
        timestamp: new Date().toISOString()
      });
    }
  });

  return router;
}