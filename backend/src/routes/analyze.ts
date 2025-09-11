import express from 'express';
import { AnalysisRequest, AnalysisResponse } from '../types';
import { AnalyzerFactory } from '../analyzer/base-analyzer';
import { SystemTopologyAnalyzer } from '../analyzer/system-topology-analyzer';

export const analyzeRoutes = express.Router();

// Register the new system topology analyzer (works with any language/framework)
AnalyzerFactory.registerAnalyzer(new SystemTopologyAnalyzer());

analyzeRoutes.post('/repository', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const request: AnalysisRequest = req.body;
    
    if (!request.repositoryPath) {
      return res.status(400).json({
        success: false,
        error: 'Repository path is required',
        processingTime: Date.now() - startTime
      });
    }

    console.log(`🔍 Starting analysis of repository: ${request.repositoryPath}`);
    
    // Auto-detect and create appropriate analyzer
    const analyzer = await AnalyzerFactory.createAnalyzer(request.repositoryPath);
    console.log(`🎯 Using ${analyzer.getAnalyzerName()}`);
    
    // Run the analysis
    const blueprint = await analyzer.analyzeRepository(request.repositoryPath, request.options);
    
    const response: AnalysisResponse = {
      success: true,
      blueprint,
      processingTime: Date.now() - startTime
    };

    console.log(`✅ Analysis complete in ${response.processingTime}ms`);
    console.log(`📊 Results: ${blueprint.components.length} components, ${blueprint.connections.length} connections, ${blueprint.riskAreas.length} risk areas`);
    
    return res.json(response);

  } catch (error) {
    console.error('❌ Analysis failed:', error);
    
    const response: AnalysisResponse = {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
      processingTime: Date.now() - startTime
    };

    return res.status(500).json(response);
  }
});

// Get information about available analyzers
analyzeRoutes.get('/analyzers', (req, res) => {
  const analyzers = AnalyzerFactory.getAvailableAnalyzers();
  
  return res.json({
    success: true,
    analyzers,
    message: `${analyzers.length} analyzers available`
  });
});

// Get available sample projects for testing
analyzeRoutes.get('/samples', (req, res) => {
  return res.json({
    samples: [
      {
        name: 'Express Todo API',
        path: './samples/express-todo',
        description: 'Simple Express.js REST API with controllers and middleware',
        language: 'javascript',
        framework: 'express'
      },
      {
        name: 'NestJS E-commerce API', 
        path: './samples/nestjs-ecommerce',
        description: 'Complex NestJS application with TypeScript, decorators, and modules',
        language: 'typescript',
        framework: 'nestjs'
      },
      {
        name: 'React Frontend App',
        path: './samples/react-app',
        description: 'React application with components, hooks, and state management',
        language: 'typescript',
        framework: 'react'
      }
    ]
  });
});