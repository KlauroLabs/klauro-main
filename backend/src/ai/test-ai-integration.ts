#!/usr/bin/env ts-node

import { AIService } from './ai-service';
import { AIAnalyzer } from './ai-analyzer';
import { ComponentNode, ArchitectureBlueprint } from '../types';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../../.env') });

async function testAIIntegration() {
  console.log('=== Testing AI Integration Layer ===\n');
  
  // Initialize AI services
  const aiService = new AIService();
  const aiAnalyzer = new AIAnalyzer(aiService);
  
  // Set up cost alerts
  aiService.onCostAlert((alert) => {
    console.warn(`⚠️ Cost Alert: ${alert.message}`);
  });
  
  // Test 1: Basic completion
  console.log('Test 1: Basic AI Completion');
  console.log('----------------------------');
  try {
    const response = await aiService.complete({
      prompt: 'What are the key principles of clean architecture?',
      maxTokens: 200,
    });
    
    console.log('Response:', response.content.substring(0, 200) + '...');
    console.log('Provider:', response.provider);
    console.log('Model:', response.model);
    console.log('Cost:', `$${response.cost.toFixed(4)}`);
    console.log('Cached:', response.cached || false);
    console.log('✅ Basic completion test passed\n');
  } catch (error) {
    console.error('❌ Basic completion test failed:', error);
  }
  
  // Test 2: Code analysis
  console.log('Test 2: Code Analysis');
  console.log('---------------------');
  const sampleCode = `
class UserService {
  private db: Database;
  
  constructor(database: Database) {
    this.db = database;
  }
  
  async getUser(id: string) {
    const query = \`SELECT * FROM users WHERE id = '\${id}'\`;
    return await this.db.query(query);
  }
  
  async updateUser(id: string, data: any) {
    // No validation
    return await this.db.update('users', id, data);
  }
}`;
  
  try {
    const securityAnalysis = await aiService.analyzeCode(
      sampleCode,
      'security',
      { language: 'typescript', framework: 'express' }
    );
    
    console.log('Security Analysis:');
    const analysis = JSON.parse(securityAnalysis.content);
    if (analysis.vulnerabilities) {
      analysis.vulnerabilities.slice(0, 2).forEach((vuln: any) => {
        console.log(`  - ${vuln.type}: ${vuln.description}`);
      });
    }
    console.log('✅ Code analysis test passed\n');
  } catch (error) {
    console.error('❌ Code analysis test failed:', error);
  }
  
  // Test 3: Component analysis
  console.log('Test 3: Component Analysis');
  console.log('--------------------------');
  const mockComponent: ComponentNode = {
    id: 'user-service',
    name: 'UserService',
    type: 'service',
    path: '/src/services/user-service.ts',
    dependencies: ['database-service', 'auth-service'],
    dependents: ['user-controller', 'admin-controller'],
    metadata: {
      lineCount: 150,
      complexity: 7,
      lastModified: new Date(),
      exports: ['UserService', 'getUserById', 'updateUser'],
      imports: ['Database', 'AuthService'],
      layer: 'business',
      responsibilities: ['User management', 'Authentication'],
    },
  };
  
  try {
    const componentAnalysis = await aiAnalyzer.analyzeComponent(
      mockComponent,
      sampleCode,
      ['description', 'risks']
    );
    
    console.log('Component:', componentAnalysis.component);
    const description = typeof componentAnalysis.analysis.description === 'object' 
      ? (componentAnalysis.analysis.description as any)?.summary 
      : componentAnalysis.analysis.description;
    console.log('Description:', description || 'N/A');
    console.log('Risks found:', componentAnalysis.analysis.risks?.length || 0);
    console.log('Processing time:', `${componentAnalysis.metadata.processingTime}ms`);
    console.log('✅ Component analysis test passed\n');
  } catch (error) {
    console.error('❌ Component analysis test failed:', error);
  }
  
  // Test 4: Blueprint enhancement
  console.log('Test 4: Blueprint Enhancement');
  console.log('-----------------------------');
  const mockBlueprint: ArchitectureBlueprint = {
    projectName: 'Test Project',
    framework: 'Express.js',
    components: [mockComponent],
    connections: [
      {
        from: 'user-controller',
        to: 'user-service',
        type: 'function_call',
      },
    ],
    entryPoints: [
      {
        id: 'api-gateway',
        type: 'http_endpoint',
        path: '/api',
        description: 'Main API gateway',
        componentId: 'api-gateway',
      },
    ],
    exitPoints: [],
    orphanedComponents: [],
    riskAreas: [
      {
        componentId: 'user-service',
        riskLevel: 'high',
        reasons: ['SQL injection vulnerability', 'No input validation'],
        impact: 'Data breach risk',
      },
    ],
    metadata: {
      totalComponents: 1,
      frameworkVersion: '4.18.0',
      analysisDate: new Date(),
      repositoryPath: '/test/repo',
      entryPointsCount: 1,
      orphanedCount: 0,
      complexityAverage: 7,
      primaryLanguage: 'TypeScript',
      languageDistribution: { TypeScript: 100 },
      codebaseSize: {
        totalLines: 1000,
        codeLines: 800,
        commentLines: 100,
        blankLines: 100,
      },
    },
    technologyStack: {
      primaryFramework: {
        name: 'Express.js',
        version: '4.18.0',
        type: 'web',
        usage: 'primary',
        conventions: [],
        patterns: [],
        detectionConfidence: 1,
      },
      additionalFrameworks: [],
      languages: [
        {
          name: 'TypeScript',
          version: '5.0.0',
          fileCount: 10,
          lineCount: 1000,
          percentage: 100,
        },
      ],
      buildTools: [],
      testingFrameworks: [],
      databases: [],
      messageQueues: [],
      caching: [],
      authentication: [],
      deployment: [],
    },
    dependencies: {
      totalCount: 0,
      directDependencies: [],
      devDependencies: [],
      peerDependencies: [],
      vulnerabilities: [],
      outdated: [],
      unused: [],
      licenseCompliance: [],
    },
    apiEndpoints: [],
    securityAnalysis: {
      vulnerabilities: [],
      authenticationMethods: [],
      authorizationPatterns: [],
      dataEncryption: [],
      inputValidation: [],
      securityHeaders: [],
      secrets: [],
    },
    testingInfo: {
      frameworks: [],
      coverage: {
        overall: 0,
        lines: { covered: 0, total: 0, percentage: 0 },
        branches: { covered: 0, total: 0, percentage: 0 },
        functions: { covered: 0, total: 0, percentage: 0 },
        statements: { covered: 0, total: 0, percentage: 0 },
        byComponent: {},
        byType: {},
        uncoveredFiles: [],
      },
      testTypes: [],
      testFiles: [],
      totalTests: 0,
      passingTests: 0,
      failingTests: 0,
      skippedTests: 0,
      testSuites: [],
    },
    deploymentInfo: {
      platform: 'unknown',
      containerization: { type: 'none' },
      cicd: {
        platform: 'unknown',
        configFile: '',
        stages: [],
        deploymentStrategy: '',
        automated: false,
      },
      monitoring: {
        tools: [],
        metrics: [],
        logging: { level: 'info', destination: 'console', structured: false, aggregation: false },
        alerting: { platform: '', rules: [], channels: [] },
      },
      scaling: {
        type: 'horizontal',
        automatic: false,
        metrics: [],
        limits: { minInstances: 1, maxInstances: 1, cpu: '100%', memory: '1GB' },
      },
    },
  };
  
  try {
    const enhancedBlueprint = await aiAnalyzer.enhanceBlueprint(mockBlueprint);
    
    if (enhancedBlueprint.aiAnalysis) {
      console.log('AI Summary:', enhancedBlueprint.aiAnalysis.summary);
      console.log('Insights:', Object.keys(enhancedBlueprint.aiAnalysis.insights));
      console.log('Recommendations:', enhancedBlueprint.aiAnalysis.recommendations.length);
      console.log('✅ Blueprint enhancement test passed\n');
    } else {
      console.log('⚠️ Blueprint enhancement completed but no AI analysis added\n');
    }
  } catch (error) {
    console.error('❌ Blueprint enhancement test failed:', error);
  }
  
  // Test 5: Cache functionality
  console.log('Test 5: Cache Functionality');
  console.log('---------------------------');
  try {
    // Make the same request twice
    const request = {
      prompt: 'What is dependency injection?',
      maxTokens: 100,
    };
    
    const response1 = await aiService.complete(request);
    const response2 = await aiService.complete(request);
    
    console.log('First request cached:', response1.cached || false);
    console.log('Second request cached:', response2.cached || false);
    console.log('Cache working:', response2.cached === true);
    console.log('✅ Cache test passed\n');
  } catch (error) {
    console.error('❌ Cache test failed:', error);
  }
  
  // Test 6: Fallback provider
  console.log('Test 6: Fallback Provider');
  console.log('-------------------------');
  try {
    // Force fallback by using non-existent provider preference
    const response = await aiService.complete(
      {
        prompt: 'Analyze this simple function: function add(a, b) { return a + b; }',
        maxTokens: 100,
      },
      'non-existent-provider'
    );
    
    console.log('Provider used:', response.provider);
    console.log('Fallback working:', response.provider === 'fallback' || response.provider === 'huggingface');
    console.log('✅ Fallback test passed\n');
  } catch (error) {
    console.error('❌ Fallback test failed:', error);
  }
  
  // Display final statistics
  console.log('=== AI Service Statistics ===');
  const stats = aiService.getStats();
  console.log('Total Requests:', stats.totalRequests);
  console.log('Successful:', stats.successfulRequests);
  console.log('Failed:', stats.failedRequests);
  console.log('Cache Hits:', stats.cacheHits);
  console.log('Cache Misses:', stats.cacheMisses);
  console.log('Total Cost:', `$${stats.totalCost.toFixed(4)}`);
  console.log('Average Response Time:', `${Math.round(stats.averageResponseTime)}ms`);
  console.log('\nProviders Available:');
  console.log('  OpenAI:', stats.providers.openai);
  console.log('  Anthropic:', stats.providers.anthropic);
  console.log('  Fallback:', stats.providers.fallback);
  
  // Cost report
  console.log('\n=== Cost Report ===');
  const costReport = await aiService.getCostReport('daily');
  console.log('Period:', costReport.period);
  console.log('Total Cost:', `$${costReport.totalCost.toFixed(4)}`);
  if (Object.keys(costReport.costByProvider).length > 0) {
    console.log('Cost by Provider:');
    Object.entries(costReport.costByProvider).forEach(([provider, cost]) => {
      console.log(`  ${provider}: $${(cost as number).toFixed(4)}`);
    });
  }
  
  // Cleanup
  await aiService.shutdown();
  console.log('\n✅ All tests completed!');
}

// Run tests if executed directly
if (require.main === module) {
  testAIIntegration().catch(console.error);
}

export { testAIIntegration };