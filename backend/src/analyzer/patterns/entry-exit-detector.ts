/**
 * Entry/Exit Point Detector
 * Identifies system entry points (API endpoints, CLI commands, webhooks, etc.)
 * and exit points (database queries, external APIs, file operations, etc.)
 */

import { EntryPoint, ExitPoint, ComponentNode, EntryPointType, ExitPointType, 
         AuthenticationInfo, RateLimitInfo, RetryPolicy, CircuitBreakerConfig,
         CachingStrategy, DataTransformation, MonitoringConfig } from '../../types';
import { telemetry, TelemetryEvent } from '../../telemetry/telemetry-schema';
import * as path from 'path';
import * as fs from 'fs-extra';

export interface EntryPointPattern {
  type: EntryPointType;
  patterns: RegExp[];
  extractors: EntryPointExtractor[];
  confidence: number;
  framework?: string;
}

export interface ExitPointPattern {
  type: ExitPointType;
  patterns: RegExp[];
  extractors: ExitPointExtractor[];
  confidence: number;
  category?: string;
}

export interface EntryPointExtractor {
  pattern: RegExp;
  extract: (match: RegExpMatchArray, content: string, filePath: string) => Partial<EntryPoint>;
}

export interface ExitPointExtractor {
  pattern: RegExp;
  extract: (match: RegExpMatchArray, content: string, filePath: string) => Partial<ExitPoint>;
}

export class EntryExitDetector {
  private entryPatterns: Map<string, EntryPointPattern[]> = new Map();
  private exitPatterns: Map<string, ExitPointPattern[]> = new Map();
  private detectedEntryPoints: EntryPoint[] = [];
  private detectedExitPoints: ExitPoint[] = [];
  private componentMap: Map<string, ComponentNode> = new Map();

  constructor() {
    this.initializePatterns();
  }

  private initializePatterns(): void {
    // HTTP Endpoint Patterns
    this.addEntryPattern('express', {
      type: 'http_endpoint',
      confidence: 0.95,
      patterns: [
        /app\.(get|post|put|delete|patch|head|options)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
        /router\.(get|post|put|delete|patch|head|options)\s*\(\s*['"`]([^'"`]+)['"`]/gi
      ],
      extractors: [{
        pattern: /app\.(get|post|put|delete|patch|head|options)\s*\(\s*['"`]([^'"`]+)['"`](?:,\s*(\[[\s\S]*?\]|[\w.]+))?(?:,\s*(?:async\s+)?(?:function\s*)?(\w+|\([^)]*\)\s*=>))?/gi,
        extract: (match, content, filePath) => ({
          type: 'http_endpoint' as EntryPointType,
          path: match[2],
          methods: [match[1].toUpperCase()],
          handler: match[4] || 'anonymous',
          middleware: this.extractMiddleware(match[3]),
          description: `${match[1].toUpperCase()} ${match[2]}`
        })
      }]
    });

    this.addEntryPattern('nestjs', {
      type: 'http_endpoint',
      confidence: 0.98,
      patterns: [
        /@(Get|Post|Put|Delete|Patch|Head|Options)\s*\(\s*['"`]?([^'"`\)]*?)['"`]?\s*\)/gi,
        /@Controller\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/gi
      ],
      extractors: [{
        pattern: /@(Get|Post|Put|Delete|Patch|Head|Options)\s*\(\s*['"`]?([^'"`\)]*?)['"`]?\s*\)\s*(?:@[\w]+\([^)]*\)\s*)*(?:async\s+)?(\w+)/gmi,
        extract: (match, content, filePath) => {
          const controllerPath = this.extractControllerPath(content);
          return {
            type: 'http_endpoint' as EntryPointType,
            path: path.join(controllerPath, match[2] || '').replace(/\\/g, '/'),
            methods: [match[1].toUpperCase()],
            handler: match[3],
            authentication: this.extractNestAuth(content, match.index || 0),
            description: `${match[1].toUpperCase()} ${controllerPath}${match[2] || ''}`
          };
        }
      }]
    });

    this.addEntryPattern('fastapi', {
      type: 'http_endpoint',
      confidence: 0.96,
      patterns: [
        /@app\.(get|post|put|delete|patch|head|options)\s*\(\s*["']([^"']+)["']/gi,
        /router\.(get|post|put|delete|patch|head|options)\s*\(\s*["']([^"']+)["']/gi
      ],
      extractors: [{
        pattern: /@app\.(get|post|put|delete|patch|head|options)\s*\(\s*["']([^"']+)["'].*?\)\s*(?:async\s+)?def\s+(\w+)/gsi,
        extract: (match) => ({
          type: 'http_endpoint' as EntryPointType,
          path: match[2],
          methods: [match[1].toUpperCase()],
          handler: match[3],
          description: `${match[1].toUpperCase()} ${match[2]}`
        })
      }]
    });

    // WebSocket Patterns
    this.addEntryPattern('socket.io', {
      type: 'websocket',
      confidence: 0.92,
      patterns: [
        /io\.on\s*\(\s*['"`]connection['"`]/gi,
        /socket\.on\s*\(\s*['"`]([^'"`]+)['"`]/gi
      ],
      extractors: [{
        pattern: /socket\.on\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*(?:async\s+)?(?:function\s*)?(\w+|\([^)]*\)\s*=>)/gi,
        extract: (match) => ({
          type: 'websocket' as EntryPointType,
          path: `/ws/${match[1]}`,
          handler: match[2],
          description: `WebSocket event: ${match[1]}`
        })
      }]
    });

    // CLI Command Patterns
    this.addEntryPattern('commander', {
      type: 'cli_command',
      confidence: 0.90,
      patterns: [
        /program\.command\s*\(\s*['"`]([^'"`]+)['"`]/gi,
        /\.option\s*\(\s*['"`]([^'"`]+)['"`]/gi
      ],
      extractors: [{
        pattern: /program\.command\s*\(\s*['"`]([^'"`]+)['"`]\s*\)[\s\S]*?\.action\s*\(\s*(?:async\s+)?(?:function\s*)?(\w+|\([^)]*\)\s*=>)/gi,
        extract: (match) => ({
          type: 'cli_command' as EntryPointType,
          path: match[1],
          handler: match[2],
          description: `CLI command: ${match[1]}`
        })
      }]
    });

    // Event Handler Patterns
    this.addEntryPattern('event-emitter', {
      type: 'event_handler',
      confidence: 0.88,
      patterns: [
        /\.on\s*\(\s*['"`]([^'"`]+)['"`]/gi,
        /\.addEventListener\s*\(\s*['"`]([^'"`]+)['"`]/gi,
        /\.subscribe\s*\(\s*['"`]([^'"`]+)['"`]/gi
      ],
      extractors: [{
        pattern: /(\w+)\.on\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*(?:async\s+)?(?:function\s*)?(\w+|\([^)]*\)\s*=>)/gi,
        extract: (match) => ({
          type: 'event_handler' as EntryPointType,
          path: `${match[1]}:${match[2]}`,
          handler: match[3],
          description: `Event handler: ${match[2]} on ${match[1]}`
        })
      }]
    });

    // Scheduler/Cron Patterns
    this.addEntryPattern('cron', {
      type: 'scheduler',
      confidence: 0.91,
      patterns: [
        /cron\.schedule\s*\(\s*['"`]([^'"`]+)['"`]/gi,
        /@Cron\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/gi,
        /setInterval\s*\(\s*(?:async\s+)?(?:function\s*)?(\w+)/gi
      ],
      extractors: [{
        pattern: /cron\.schedule\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*(?:async\s+)?(?:function\s*)?(\w+|\([^)]*\)\s*=>)/gi,
        extract: (match) => ({
          type: 'scheduler' as EntryPointType,
          path: `cron:${match[1]}`,
          handler: match[2],
          description: `Scheduled task: ${match[1]}`
        })
      }]
    });

    // Queue Consumer Patterns
    this.addEntryPattern('bull', {
      type: 'queue_consumer',
      confidence: 0.89,
      patterns: [
        /queue\.process\s*\(\s*['"`]?([^'"`\)]*?)['"`]?\s*,/gi,
        /consumer\.on\s*\(\s*['"`]message['"`]/gi
      ],
      extractors: [{
        pattern: /queue\.process\s*\(\s*['"`]?([^'"`\)]*?)['"`]?\s*,\s*(?:async\s+)?(?:function\s*)?(\w+|\([^)]*\)\s*=>)/gi,
        extract: (match) => ({
          type: 'queue_consumer' as EntryPointType,
          path: `queue:${match[1] || 'default'}`,
          handler: match[2],
          description: `Queue consumer: ${match[1] || 'default'}`
        })
      }]
    });

    // Webhook Patterns
    this.addEntryPattern('webhook', {
      type: 'webhook',
      confidence: 0.87,
      patterns: [
        /webhook\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
        /\/webhooks?\//i
      ],
      extractors: [{
        pattern: /app\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]*webhook[^'"`]*)['"`]/gi,
        extract: (match) => ({
          type: 'webhook' as EntryPointType,
          path: match[2],
          methods: [match[1].toUpperCase()],
          description: `Webhook endpoint: ${match[2]}`
        })
      }]
    });

    // gRPC Service Patterns
    this.addEntryPattern('grpc', {
      type: 'grpc_service',
      confidence: 0.93,
      patterns: [
        /service\s+(\w+)\s*\{[\s\S]*?rpc\s+(\w+)/gi,
        /\.addService\s*\(\s*(\w+)\.service/gi
      ],
      extractors: [{
        pattern: /rpc\s+(\w+)\s*\(\s*(\w+)\s*\)\s*returns\s*\(\s*(\w+)\s*\)/gi,
        extract: (match) => ({
          type: 'grpc_service' as EntryPointType,
          path: `grpc:${match[1]}`,
          handler: match[1],
          description: `gRPC method: ${match[1]}(${match[2]}) returns ${match[3]}`
        })
      }]
    });

    // Exit Point Patterns - Database
    this.addExitPattern('database', {
      type: 'database_query',
      confidence: 0.94,
      category: 'database',
      patterns: [
        /\.(find|findOne|findById|findAll|findMany)\s*\(/gi,
        /\.(create|save|insert|insertMany|insertOne)\s*\(/gi,
        /\.(update|updateOne|updateMany|findAndUpdate)\s*\(/gi,
        /\.(delete|deleteOne|deleteMany|remove|destroy)\s*\(/gi,
        /\.(query|execute|exec|run)\s*\(/gi,
        /SELECT\s+.*?\s+FROM\s+/gi,
        /INSERT\s+INTO\s+/gi,
        /UPDATE\s+.*?\s+SET\s+/gi,
        /DELETE\s+FROM\s+/gi
      ],
      extractors: [{
        pattern: /(\w+)\.(find|findOne|findById|create|save|update|delete|query)\s*\(/gi,
        extract: (match) => ({
          type: 'database_query' as ExitPointType,
          destination: `db:${match[1]}`,
          description: `Database operation: ${match[1]}.${match[2]}()`,
          critical: true
        })
      }]
    });

    // External API Patterns
    this.addExitPattern('external-api', {
      type: 'external_api',
      confidence: 0.92,
      category: 'api',
      patterns: [
        /axios\.(get|post|put|delete|patch)\s*\(/gi,
        /fetch\s*\(\s*['"`]([^'"`]+)['"`]/gi,
        /http\.(get|post|put|delete|patch|request)\s*\(/gi,
        /request\.(get|post|put|delete|patch)\s*\(/gi
      ],
      extractors: [{
        pattern: /axios\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
        extract: (match) => ({
          type: 'external_api' as ExitPointType,
          destination: match[2],
          description: `External API call: ${match[1].toUpperCase()} ${match[2]}`,
          critical: false
        })
      }]
    });

    // Message Queue Patterns
    this.addExitPattern('message-queue', {
      type: 'message_publish',
      confidence: 0.90,
      category: 'messaging',
      patterns: [
        /queue\.(add|publish|send)\s*\(/gi,
        /publisher\.publish\s*\(/gi,
        /channel\.(sendToQueue|publish)\s*\(/gi,
        /producer\.(send|produce)\s*\(/gi
      ],
      extractors: [{
        pattern: /(\w+)\.(add|publish|send|sendToQueue)\s*\(\s*['"`]?([^'"`\),]*)['"`]?/gi,
        extract: (match) => ({
          type: 'message_publish' as ExitPointType,
          destination: `queue:${match[3] || match[1]}`,
          description: `Message publish: ${match[1]}.${match[2]}(${match[3] || ''})`,
          critical: false
        })
      }]
    });

    // File Operation Patterns
    this.addExitPattern('file-operation', {
      type: 'file_operation',
      confidence: 0.88,
      category: 'filesystem',
      patterns: [
        /fs\.(readFile|writeFile|appendFile|unlink|mkdir|rmdir)/gi,
        /createReadStream|createWriteStream/gi,
        /\.(pipe|write|read)\s*\(/gi
      ],
      extractors: [{
        pattern: /fs\.(readFile|writeFile|appendFile|unlink)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
        extract: (match) => ({
          type: 'file_operation' as ExitPointType,
          destination: `file:${match[2]}`,
          description: `File operation: ${match[1]} ${match[2]}`,
          critical: false
        })
      }]
    });

    // Cache Operation Patterns
    this.addExitPattern('cache', {
      type: 'cache_operation',
      confidence: 0.91,
      category: 'cache',
      patterns: [
        /redis\.(get|set|del|expire|hget|hset)\s*\(/gi,
        /cache\.(get|set|delete|clear|has)\s*\(/gi,
        /memcached\.(get|set|delete|flush)\s*\(/gi
      ],
      extractors: [{
        pattern: /(\w+)\.(get|set|del|delete)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
        extract: (match) => ({
          type: 'cache_operation' as ExitPointType,
          destination: `cache:${match[1]}`,
          description: `Cache operation: ${match[1]}.${match[2]}(${match[3]})`,
          critical: false
        })
      }]
    });

    // Email/SMS Patterns
    this.addExitPattern('notification', {
      type: 'email_send',
      confidence: 0.86,
      category: 'notification',
      patterns: [
        /mailer\.(send|sendMail)\s*\(/gi,
        /sendgrid\.(send|sendMultiple)\s*\(/gi,
        /nodemailer\.sendMail\s*\(/gi,
        /twilio\.messages\.create\s*\(/gi,
        /sns\.publish\s*\(/gi
      ],
      extractors: [{
        pattern: /(\w+)\.(send|sendMail|publish)\s*\(/gi,
        extract: (match) => ({
          type: match[1].toLowerCase().includes('sms') || match[1].toLowerCase().includes('twilio') 
            ? 'sms_send' as ExitPointType 
            : 'email_send' as ExitPointType,
          destination: `notification:${match[1]}`,
          description: `Notification: ${match[1]}.${match[2]}()`,
          critical: false
        })
      }]
    });

    // Logging Patterns
    this.addExitPattern('logging', {
      type: 'log_write',
      confidence: 0.85,
      category: 'logging',
      patterns: [
        /logger\.(log|info|warn|error|debug)\s*\(/gi,
        /console\.(log|info|warn|error|debug)\s*\(/gi,
        /winston\.(log|info|warn|error|debug)\s*\(/gi
      ],
      extractors: [{
        pattern: /(\w+)\.(log|info|warn|error|debug)\s*\(/gi,
        extract: (match) => ({
          type: 'log_write' as ExitPointType,
          destination: `log:${match[1]}`,
          description: `Logging: ${match[1]}.${match[2]}()`,
          critical: false
        })
      }]
    });
  }

  public async detectEntryPoints(
    components: ComponentNode[], 
    projectPath: string
  ): Promise<EntryPoint[]> {
    const span = telemetry.createSpan('detectEntryPoints');
    this.detectedEntryPoints = [];
    this.componentMap.clear();

    // Build component map for quick lookup
    for (const component of components) {
      this.componentMap.set(component.path, component);
    }

    // Analyze each component for entry points
    for (const component of components) {
      try {
        const fullPath = path.join(projectPath, component.path);
        const content = await fs.readFile(fullPath, 'utf-8');
        
        // Detect framework
        const framework = this.detectFramework(content, component.path);
        
        // Get patterns for the detected framework
        const patterns = this.entryPatterns.get(framework) || [];
        
        // Also check generic patterns
        const genericPatterns = this.entryPatterns.get('generic') || [];
        const allPatterns = [...patterns, ...genericPatterns];
        
        for (const pattern of allPatterns) {
          const entryPoints = this.extractEntryPoints(
            content, 
            component.path, 
            component, 
            pattern
          );
          
          this.detectedEntryPoints.push(...entryPoints);
        }
        
        // Mark component as entry if entry points found
        if (this.detectedEntryPoints.some(ep => ep.componentId === component.id)) {
          component.metadata.isEntry = true;
        }
        
      } catch (error) {
        telemetry.emit({
          type: 'error_occurred',
          source: { 
            analyzer: 'entry-exit-detector', 
            component: component.path 
          },
          data: {
            error: error instanceof Error ? error.message : String(error),
            component: component.path
          }
        });
      }
    }

    // Emit telemetry
    telemetry.emit({
      type: 'entry_point_found',
      source: { analyzer: 'entry-exit-detector' },
      data: {
        count: this.detectedEntryPoints.length,
        types: this.groupByType(this.detectedEntryPoints)
      }
    });

    span.end();
    return this.detectedEntryPoints;
  }

  public async detectExitPoints(
    components: ComponentNode[], 
    projectPath: string
  ): Promise<ExitPoint[]> {
    const span = telemetry.createSpan('detectExitPoints');
    this.detectedExitPoints = [];

    for (const component of components) {
      try {
        const fullPath = path.join(projectPath, component.path);
        const content = await fs.readFile(fullPath, 'utf-8');
        
        // Check all exit patterns
        for (const [category, patterns] of this.exitPatterns) {
          for (const pattern of patterns) {
            const exitPoints = this.extractExitPoints(
              content, 
              component.path, 
              component, 
              pattern
            );
            
            this.detectedExitPoints.push(...exitPoints);
          }
        }
        
      } catch (error) {
        telemetry.emit({
          type: 'error_occurred',
          source: { 
            analyzer: 'entry-exit-detector', 
            component: component.path 
          },
          data: {
            error: error instanceof Error ? error.message : String(error),
            component: component.path
          }
        });
      }
    }

    // Emit telemetry
    telemetry.emit({
      type: 'exit_point_found',
      source: { analyzer: 'entry-exit-detector' },
      data: {
        count: this.detectedExitPoints.length,
        types: this.groupByType(this.detectedExitPoints)
      }
    });

    span.end();
    return this.detectedExitPoints;
  }

  private extractEntryPoints(
    content: string, 
    filePath: string, 
    component: ComponentNode,
    pattern: EntryPointPattern
  ): EntryPoint[] {
    const entryPoints: EntryPoint[] = [];

    for (const extractor of pattern.extractors) {
      let match;
      const regex = new RegExp(extractor.pattern.source, extractor.pattern.flags);
      
      while ((match = regex.exec(content)) !== null) {
        const partial = extractor.extract(match, content, filePath);
        
        const entryPoint: EntryPoint = {
          id: `${component.id}_ep_${entryPoints.length}`,
          type: partial.type || pattern.type,
          path: partial.path || filePath,
          methods: partial.methods,
          description: partial.description || `Entry point in ${filePath}`,
          componentId: component.id,
          handler: partial.handler,
          middleware: partial.middleware,
          authentication: partial.authentication || this.detectAuthentication(content, match.index || 0),
          rateLimit: this.detectRateLimit(content, match.index || 0),
          parameters: this.extractParameters(content, match.index || 0),
          responseSchema: this.extractResponseSchema(content, match.index || 0),
          async: content.includes('async') || content.includes('await'),
          priority: this.calculatePriority(partial.type || pattern.type),
          ...partial
        };

        entryPoints.push(entryPoint);
      }
    }

    return entryPoints;
  }

  private extractExitPoints(
    content: string, 
    filePath: string, 
    component: ComponentNode,
    pattern: ExitPointPattern
  ): ExitPoint[] {
    const exitPoints: ExitPoint[] = [];

    for (const extractor of pattern.extractors) {
      let match;
      const regex = new RegExp(extractor.pattern.source, extractor.pattern.flags);
      
      while ((match = regex.exec(content)) !== null) {
        const partial = extractor.extract(match, content, filePath);
        
        const exitPoint: ExitPoint = {
          id: `${component.id}_xp_${exitPoints.length}`,
          type: partial.type || pattern.type,
          destination: partial.destination || 'unknown',
          description: partial.description || `Exit point in ${filePath}`,
          componentId: component.id,
          critical: partial.critical !== undefined ? partial.critical : this.isCriticalExit(pattern.type),
          authentication: this.detectExitAuthentication(content, match.index || 0),
          rateLimit: this.detectExitRateLimit(content, match.index || 0),
          errorHandling: this.detectErrorHandling(content, match.index || 0),
          retryPolicy: this.detectRetryPolicy(content, match.index || 0),
          timeout: this.detectTimeout(content, match.index || 0),
          circuitBreaker: this.detectCircuitBreaker(content, match.index || 0),
          caching: this.detectCaching(content, match.index || 0),
          ...partial
        };

        exitPoints.push(exitPoint);
      }
    }

    return exitPoints;
  }

  private detectFramework(content: string, filePath: string): string {
    // Simple framework detection based on imports and patterns
    if (content.includes('express') || content.includes('app.use')) return 'express';
    if (content.includes('@nestjs') || content.includes('@Controller')) return 'nestjs';
    if (content.includes('fastapi') || content.includes('@app.')) return 'fastapi';
    if (content.includes('socket.io')) return 'socket.io';
    if (content.includes('commander') || content.includes('program.command')) return 'commander';
    if (content.includes('bull') || content.includes('Queue')) return 'bull';
    if (content.includes('cron')) return 'cron';
    if (content.includes('grpc')) return 'grpc';
    return 'generic';
  }

  private extractControllerPath(content: string): string {
    const match = content.match(/@Controller\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/);
    return match ? match[1] : '/';
  }

  private extractMiddleware(middlewareStr?: string): string[] {
    if (!middlewareStr) return [];
    
    // Handle array of middleware
    if (middlewareStr.startsWith('[')) {
      try {
        const middlewares = middlewareStr
          .replace(/[\[\]]/g, '')
          .split(',')
          .map(m => m.trim())
          .filter(m => m);
        return middlewares;
      } catch {
        return [];
      }
    }
    
    // Single middleware
    return middlewareStr ? [middlewareStr.trim()] : [];
  }

  private extractNestAuth(content: string, position: number): AuthenticationInfo {
    // Look for NestJS guards before the handler
    const before = content.substring(Math.max(0, position - 500), position);
    
    if (before.includes('@UseGuards')) {
      if (before.includes('JwtAuthGuard')) {
        return { type: 'jwt', required: true };
      }
      if (before.includes('BasicAuthGuard')) {
        return { type: 'basic', required: true };
      }
      if (before.includes('ApiKeyAuthGuard')) {
        return { type: 'api_key', required: true };
      }
    }
    
    if (before.includes('@Public')) {
      return { type: 'none', required: false };
    }
    
    return { type: 'none', required: false };
  }

  private detectAuthentication(content: string, position: number): AuthenticationInfo {
    const context = content.substring(Math.max(0, position - 500), Math.min(content.length, position + 500));
    
    if (context.match(/auth|authenticate|requireAuth|isAuthenticated|passport/i)) {
      if (context.includes('jwt') || context.includes('JWT')) {
        return { type: 'jwt', required: true };
      }
      if (context.includes('oauth') || context.includes('OAuth')) {
        return { type: 'oauth', required: true };
      }
      if (context.includes('api[_-]?key/i')) {
        return { type: 'api_key', required: true };
      }
      return { type: 'bearer', required: true };
    }
    
    return { type: 'none', required: false };
  }

  private detectRateLimit(content: string, position: number): RateLimitInfo | undefined {
    const context = content.substring(Math.max(0, position - 500), Math.min(content.length, position + 500));
    
    const rateLimitMatch = context.match(/rateLimit|throttle|limit.*?(\d+).*?(\d+)/i);
    if (rateLimitMatch) {
      return {
        requests: parseInt(rateLimitMatch[1]) || 100,
        window: '1m',
        strategy: 'sliding'
      };
    }
    
    return undefined;
  }

  private extractParameters(content: string, position: number): any[] {
    // Extract function parameters around the position
    const context = content.substring(Math.max(0, position - 200), Math.min(content.length, position + 500));
    
    const paramMatch = context.match(/\(([^)]*)\)\s*(?:=>|\{)/);
    if (paramMatch && paramMatch[1]) {
      const params = paramMatch[1].split(',').map(p => p.trim()).filter(p => p);
      return params.map(param => {
        const parts = param.split(':').map(p => p.trim());
        return {
          name: parts[0].replace(/[{}]/g, ''),
          type: 'body',
          dataType: parts[1] || 'any',
          required: !param.includes('?')
        };
      });
    }
    
    return [];
  }

  private extractResponseSchema(content: string, position: number): any {
    // Look for response type definitions near the handler
    const context = content.substring(position, Math.min(content.length, position + 1000));
    
    const responseMatch = context.match(/returns?.*?:.*?([A-Z]\w+)|\bResponse<([A-Z]\w+)>/);
    if (responseMatch) {
      return {
        type: responseMatch[1] || responseMatch[2],
        schema: 'reference'
      };
    }
    
    return undefined;
  }

  private calculatePriority(type: EntryPointType): number {
    const priorities: Record<EntryPointType, number> = {
      'http_endpoint': 10,
      'websocket': 9,
      'grpc_service': 8,
      'webhook': 7,
      'cli_command': 6,
      'queue_consumer': 5,
      'event_handler': 4,
      'scheduler': 3
    };
    return priorities[type] || 1;
  }

  private isCriticalExit(type: ExitPointType): boolean {
    const critical: ExitPointType[] = [
      'database_query',
      'message_publish',
      'external_api'
    ];
    return critical.includes(type);
  }

  private detectExitAuthentication(content: string, position: number): AuthenticationInfo | undefined {
    const context = content.substring(Math.max(0, position - 200), Math.min(content.length, position + 200));
    
    if (context.includes('headers') && (context.includes('Authorization') || context.includes('api-key'))) {
      return { type: 'bearer', required: true };
    }
    
    return undefined;
  }

  private detectExitRateLimit(content: string, position: number): RateLimitInfo | undefined {
    const context = content.substring(Math.max(0, position - 200), Math.min(content.length, position + 200));
    
    if (context.includes('throttle') || context.includes('rateLimit')) {
      return {
        requests: 100,
        window: '1m',
        strategy: 'token-bucket'
      };
    }
    
    return undefined;
  }

  private detectErrorHandling(content: string, position: number): string[] {
    const context = content.substring(Math.max(0, position - 500), Math.min(content.length, position + 500));
    const handlers: string[] = [];
    
    if (context.includes('try')) handlers.push('try-catch');
    if (context.includes('.catch')) handlers.push('promise-catch');
    if (context.includes('error')) handlers.push('error-handler');
    if (context.includes('finally')) handlers.push('finally-block');
    
    return handlers;
  }

  private detectRetryPolicy(content: string, position: number): RetryPolicy | undefined {
    const context = content.substring(Math.max(0, position - 300), Math.min(content.length, position + 300));
    
    if (context.includes('retry') || context.includes('Retry')) {
      const maxRetriesMatch = context.match(/(?:max)?retries?.*?(\d+)/i);
      return {
        maxRetries: maxRetriesMatch ? parseInt(maxRetriesMatch[1]) : 3,
        backoffStrategy: context.includes('exponential') ? 'exponential' : 'linear'
      };
    }
    
    return undefined;
  }

  private detectTimeout(content: string, position: number): number | undefined {
    const context = content.substring(Math.max(0, position - 200), Math.min(content.length, position + 200));
    
    const timeoutMatch = context.match(/timeout.*?(\d+)/i);
    if (timeoutMatch) {
      return parseInt(timeoutMatch[1]);
    }
    
    return undefined;
  }

  private detectCircuitBreaker(content: string, position: number): CircuitBreakerConfig | undefined {
    const context = content.substring(Math.max(0, position - 300), Math.min(content.length, position + 300));
    
    if (context.includes('circuit') || context.includes('breaker')) {
      return {
        threshold: 5,
        timeout: 60000,
        resetTimeout: 30000,
        halfOpenRequests: 3
      };
    }
    
    return undefined;
  }

  private detectCaching(content: string, position: number): CachingStrategy | undefined {
    const context = content.substring(Math.max(0, position - 300), Math.min(content.length, position + 300));
    
    if (context.includes('cache') || context.includes('Cache')) {
      const ttlMatch = context.match(/ttl.*?(\d+)/i);
      return {
        enabled: true,
        ttl: ttlMatch ? parseInt(ttlMatch[1]) : 3600,
        strategy: 'read-through'
      };
    }
    
    return undefined;
  }

  private addEntryPattern(framework: string, pattern: EntryPointPattern): void {
    if (!this.entryPatterns.has(framework)) {
      this.entryPatterns.set(framework, []);
    }
    this.entryPatterns.get(framework)!.push(pattern);
  }

  private addExitPattern(category: string, pattern: ExitPointPattern): void {
    if (!this.exitPatterns.has(category)) {
      this.exitPatterns.set(category, []);
    }
    this.exitPatterns.get(category)!.push(pattern);
  }

  private groupByType(points: (EntryPoint | ExitPoint)[]): Record<string, number> {
    const groups: Record<string, number> = {};
    for (const point of points) {
      groups[point.type] = (groups[point.type] || 0) + 1;
    }
    return groups;
  }

  public getStatistics(): {
    entryPoints: Record<string, number>;
    exitPoints: Record<string, number>;
    totalEntry: number;
    totalExit: number;
  } {
    return {
      entryPoints: this.groupByType(this.detectedEntryPoints),
      exitPoints: this.groupByType(this.detectedExitPoints),
      totalEntry: this.detectedEntryPoints.length,
      totalExit: this.detectedExitPoints.length
    };
  }
}
