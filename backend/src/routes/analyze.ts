import express from 'express';
import { AnalysisRequest, AnalysisResponse } from '../types';
import { CASAnalyzerService } from '../analyzer/services/cas-analyzer.service';

export const analyzeRoutes = express.Router();

const casAnalyzerService = new CASAnalyzerService();

analyzeRoutes.post('/repository', async (req, res) => {
  const startTime = Date.now();

  try {
    const request: AnalysisRequest = req.body;

    if (!request.repositoryPath) {
      return res.status(400).json({
        success: false,
        error: 'Repository path is required',
        timestamp: new Date().toISOString()
      });
    }

    console.log(`Starting CAS analysis for ${request.repositoryPath}`);

    const casResult = await casAnalyzerService.analyzeProject({
      projectPath: request.repositoryPath,
      options: {
        includeTests: request.options?.includeTests || false,
        maxDepth: 5,
        filters: ['node_modules/**', 'dist/**', 'build/**', '.git/**']
      }
    });

    const processingTime = Date.now() - startTime;

    const response: any = {
      success: true,
      processingTime,
      cas_version: casResult.cas_version,
      analysis_timestamp: casResult.analysis_timestamp,
      analysis_id: casResult.analysis_id,
      system: casResult.system,
      nodes: casResult.nodes,
      edges: casResult.edges,
      entry_points: casResult.entry_points,
      exit_points: casResult.exit_points,
      libraries: casResult.libraries,
      analyzer_contributions: casResult.analyzer_contributions,
      metadata: {
        processingTime,
        timestamp: new Date().toISOString()
      }
    };

    console.log(`CAS analysis completed in ${processingTime}ms`);
    console.log(`Found: ${casResult.nodes.length} nodes, ${casResult.edges.length} edges`);
    console.log(`Analyzers: ${casResult.analyzer_contributions.map(c => c.analyzer_name).join(', ')}`);

    res.json(response);
  } catch (error: any) {
    const processingTime = Date.now() - startTime;

    console.error('CAS analysis failed:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Analysis failed',
      processingTime,
      timestamp: new Date().toISOString()
    });
  }
});

// Health check endpoint
analyzeRoutes.get('/health', async (req, res) => {
  try {
    res.json({
      status: 'healthy',
      service: 'CAS Analyzer',
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