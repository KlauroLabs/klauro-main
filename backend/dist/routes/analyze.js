"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeRoutes = void 0;
const express_1 = __importDefault(require("express"));
const base_analyzer_1 = require("../analyzer/base-analyzer");
const system_topology_analyzer_1 = require("../analyzer/system-topology-analyzer");
exports.analyzeRoutes = express_1.default.Router();
base_analyzer_1.AnalyzerFactory.registerAnalyzer(new system_topology_analyzer_1.SystemTopologyAnalyzer());
exports.analyzeRoutes.post('/repository', async (req, res) => {
    const startTime = Date.now();
    try {
        const request = req.body;
        if (!request.repositoryPath) {
            return res.status(400).json({
                success: false,
                error: 'Repository path is required',
                processingTime: Date.now() - startTime
            });
        }
        console.log(`🔍 Starting analysis of repository: ${request.repositoryPath}`);
        const analyzer = await base_analyzer_1.AnalyzerFactory.createAnalyzer(request.repositoryPath);
        console.log(`🎯 Using ${analyzer.getAnalyzerName()}`);
        const blueprint = await analyzer.analyzeRepository(request.repositoryPath, request.options);
        const response = {
            success: true,
            blueprint,
            processingTime: Date.now() - startTime
        };
        console.log(`✅ Analysis complete in ${response.processingTime}ms`);
        console.log(`📊 Results: ${blueprint.components.length} components, ${blueprint.connections.length} connections, ${blueprint.riskAreas.length} risk areas`);
        return res.json(response);
    }
    catch (error) {
        console.error('❌ Analysis failed:', error);
        const response = {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error occurred',
            processingTime: Date.now() - startTime
        };
        return res.status(500).json(response);
    }
});
exports.analyzeRoutes.get('/analyzers', (req, res) => {
    const analyzers = base_analyzer_1.AnalyzerFactory.getAvailableAnalyzers();
    return res.json({
        success: true,
        analyzers,
        message: `${analyzers.length} analyzers available`
    });
});
exports.analyzeRoutes.get('/samples', (req, res) => {
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
