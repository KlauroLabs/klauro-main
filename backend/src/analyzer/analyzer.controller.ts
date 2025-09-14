import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  HttpCode,
  HttpStatus,
  BadRequestException,
  NotFoundException,
  Logger,
  ValidationPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiBody } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RateLimitInterceptor } from '../common/interceptors/rate-limit.interceptor';
import { PythonAnalyzer } from './languages/python-analyzer';
import { JavaAnalyzer } from './languages/java-analyzer';
import { CSharpAnalyzer } from './languages/csharp-analyzer';
import { GoAnalyzer } from './languages/go-analyzer';
import { PatternDetector } from './patterns/pattern-detector';
import { ComponentNode, Connection } from '../types';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs-extra';

interface AnalysisRequest {
  projectPath: string;
  language: 'python' | 'java' | 'csharp' | 'go' | 'auto';
  options?: {
    maxFileSize?: number;
    excludePatterns?: string[];
    includeTests?: boolean;
  };
}

interface AnalysisResponse {
  success: boolean;
  projectId: string;
  language: string;
  components: ComponentNode[];
  connections: Connection[];
  patterns?: any;
  metrics: {
    totalFiles: number;
    analyzedFiles: number;
    skippedFiles: number;
    totalComponents: number;
    totalConnections: number;
    analysisTime: number;
  };
  timestamp: Date;
}

@ApiTags('Analyzer')
@Controller('api/analyze')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
@UseInterceptors(RateLimitInterceptor)
export class AnalyzerController {
  private readonly logger = new Logger(AnalyzerController.name);
  private readonly analyzers = new Map<string, any>();

  constructor(private readonly patternDetector: PatternDetector) {
    // Initialize language analyzers
    this.analyzers.set('python', PythonAnalyzer);
    this.analyzers.set('java', JavaAnalyzer);
    this.analyzers.set('csharp', CSharpAnalyzer);
    this.analyzers.set('go', GoAnalyzer);
  }

  @Post('python')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Analyze Python codebase' })
  @ApiBody({ type: Object, description: 'Analysis request' })
  @ApiResponse({ status: 200, description: 'Analysis completed' })
  @ApiResponse({ status: 400, description: 'Invalid request' })
  async analyzePython(@Body(new ValidationPipe()) request: AnalysisRequest) {
    return this.analyzeProject({ ...request, language: 'python' });
  }

  @Post('java')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Analyze Java codebase' })
  @ApiBody({ type: Object, description: 'Analysis request' })
  @ApiResponse({ status: 200, description: 'Analysis completed' })
  @ApiResponse({ status: 400, description: 'Invalid request' })
  async analyzeJava(@Body(new ValidationPipe()) request: AnalysisRequest) {
    return this.analyzeProject({ ...request, language: 'java' });
  }

  @Post('csharp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Analyze C# codebase' })
  @ApiBody({ type: Object, description: 'Analysis request' })
  @ApiResponse({ status: 200, description: 'Analysis completed' })
  @ApiResponse({ status: 400, description: 'Invalid request' })
  async analyzeCSharp(@Body(new ValidationPipe()) request: AnalysisRequest) {
    return this.analyzeProject({ ...request, language: 'csharp' });
  }

  @Post('go')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Analyze Go codebase' })
  @ApiBody({ type: Object, description: 'Analysis request' })
  @ApiResponse({ status: 200, description: 'Analysis completed' })
  @ApiResponse({ status: 400, description: 'Invalid request' })
  async analyzeGo(@Body(new ValidationPipe()) request: AnalysisRequest) {
    return this.analyzeProject({ ...request, language: 'go' });
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Auto-detect language and analyze codebase' })
  @ApiBody({ type: Object, description: 'Analysis request' })
  @ApiResponse({ status: 200, description: 'Analysis completed' })
  @ApiResponse({ status: 400, description: 'Invalid request' })
  async analyzeAuto(@Body(new ValidationPipe()) request: AnalysisRequest) {
    return this.analyzeProject({ ...request, language: 'auto' });
  }

  @Get('patterns/:projectId')
  @ApiOperation({ summary: 'Get detected patterns for project' })
  @ApiResponse({ status: 200, description: 'Detected patterns' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async getPatterns(@Param('projectId') projectId: string) {
    try {
      // In a real implementation, this would fetch from database
      // For now, we'll return a placeholder
      return {
        projectId,
        patterns: [],
        antiPatterns: [],
        architectureType: 'unknown',
        confidenceScore: 0,
        recommendations: [],
        timestamp: new Date(),
      };
    } catch (error) {
      this.logger.error(`Failed to get patterns: ${(error as Error).message}`, (error as Error).stack);
      throw error;
    }
  }

  @Get('performance/:projectId')
  @ApiOperation({ summary: 'Get performance metrics for project' })
  @ApiResponse({ status: 200, description: 'Performance metrics' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async getPerformanceMetrics(@Param('projectId') projectId: string) {
    try {
      // In a real implementation, this would fetch from database
      return {
        projectId,
        metrics: {
          complexity: 0,
          maintainability: 0,
          testCoverage: 0,
          technicalDebt: 0,
        },
        timestamp: new Date(),
      };
    } catch (error) {
      this.logger.error(`Failed to get performance metrics: ${(error as Error).message}`, (error as Error).stack);
      throw error;
    }
  }

  @Post('python/ast')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Parse Python file using AST' })
  @ApiBody({ 
    schema: {
      type: 'object',
      properties: {
        filePath: { type: 'string' }
      }
    }
  })
  @ApiResponse({ status: 200, description: 'AST analysis result' })
  async analyzePythonAST(@Body() body: { filePath: string }) {
    try {
      const { filePath } = body;
      
      if (!await fs.pathExists(filePath)) {
        throw new BadRequestException('File not found');
      }

      const scriptPath = path.join(__dirname, 'scripts', 'python_ast_parser.py');
      
      return new Promise((resolve, reject) => {
        const pythonProcess = spawn('python3', [scriptPath, filePath]);
        let output = '';
        let error = '';

        pythonProcess.stdout.on('data', (data) => {
          output += data.toString();
        });

        pythonProcess.stderr.on('data', (data) => {
          error += data.toString();
        });

        pythonProcess.on('close', (code) => {
          if (code !== 0) {
            reject(new BadRequestException(`Python AST parsing failed: ${error}`));
          } else {
            try {
              const result = JSON.parse(output);
              resolve(result);
            } catch (parseError) {
              reject(new BadRequestException('Failed to parse Python AST output'));
            }
          }
        });
      });
    } catch (error) {
      this.logger.error(`Failed to analyze Python AST: ${(error as Error).message}`, (error as Error).stack);
      throw error;
    }
  }

  private async analyzeProject(request: AnalysisRequest): Promise<AnalysisResponse> {
    const startTime = Date.now();
    
    try {
      const { projectPath, language, options } = request;
      
      // Validate project path
      if (!await fs.pathExists(projectPath)) {
        throw new BadRequestException('Project path does not exist');
      }

      // Auto-detect language if needed
      let detectedLanguage: string = language;
      if (language === 'auto') {
        const detected = await this.detectLanguage(projectPath);
        if (!detected) {
          throw new BadRequestException('Could not detect project language');
        }
        detectedLanguage = detected;
      }

      // Get analyzer for language
      const AnalyzerClass = this.analyzers.get(detectedLanguage);
      if (!AnalyzerClass) {
        throw new BadRequestException(`Unsupported language: ${detectedLanguage}`);
      }

      // Create analyzer instance
      const analyzer = new AnalyzerClass(projectPath, options || {});
      
      // Run analysis
      this.logger.log(`Starting ${detectedLanguage} analysis for ${projectPath}`);
      const result = await analyzer.analyze();
      
      // Detect patterns
      let patterns = null;
      if (result.components && result.connections) {
        patterns = await this.patternDetector.detectPatterns(
          result.components,
          result.connections,
          this.generateProjectId(projectPath)
        );
      }

      const analysisTime = Date.now() - startTime;
      
      return {
        success: true,
        projectId: this.generateProjectId(projectPath),
        language: detectedLanguage,
        components: result.components || [],
        connections: result.connections || [],
        patterns,
        metrics: {
          totalFiles: result.metrics?.totalFiles || 0,
          analyzedFiles: result.metrics?.analyzedFiles || 0,
          skippedFiles: result.metrics?.skippedFiles || 0,
          totalComponents: result.components?.length || 0,
          totalConnections: result.connections?.length || 0,
          analysisTime,
        },
        timestamp: new Date(),
      };
    } catch (error) {
      this.logger.error(`Analysis failed: ${(error as Error).message}`, (error as Error).stack);
      throw error;
    }
  }

  private async detectLanguage(projectPath: string): Promise<string | null> {
    // Simple language detection based on file extensions
    const files = await fs.readdir(projectPath);
    
    if (files.some(f => f.endsWith('.py'))) return 'python';
    if (files.some(f => f.endsWith('.java'))) return 'java';
    if (files.some(f => f.endsWith('.cs'))) return 'csharp';
    if (files.some(f => f.endsWith('.go'))) return 'go';
    
    // Check for language-specific files
    if (files.includes('requirements.txt') || files.includes('setup.py')) return 'python';
    if (files.includes('pom.xml') || files.includes('build.gradle')) return 'java';
    if (files.includes('*.csproj') || files.includes('*.sln')) return 'csharp';
    if (files.includes('go.mod')) return 'go';
    
    return null;
  }

  private generateProjectId(projectPath: string): string {
    // Generate a unique project ID based on path
    const crypto = require('crypto');
    return crypto
      .createHash('sha256')
      .update(projectPath)
      .digest('hex')
      .substring(0, 16);
  }
}