import { performance } from 'perf_hooks';
import { EventEmitter } from 'events';
import * as http from 'http';
import * as https from 'https';

export interface UnravlConfig {
  projectId: string;
  apiKey: string;
  endpoint?: string;
  environment?: string;
  serviceName?: string;
  batchSize?: number;
  flushInterval?: number;
  debug?: boolean;
}

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startTime: number;
  name: string;
  attributes?: Record<string, any>;
  events?: TraceEvent[];
}

export interface TraceEvent {
  name: string;
  timestamp: number;
  attributes?: Record<string, any>;
}

export interface Metric {
  name: string;
  value: number;
  timestamp: number;
  tags?: Record<string, string>;
  unit?: string;
}

export interface ErrorReport {
  error: Error;
  timestamp: number;
  context?: any;
  stackTrace?: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
}

export interface CASRuntimeEvent {
  type: 'request' | 'error' | 'exit' | 'log' | 'custom';
  timestamp?: string;
  schema_version?: string;
  service_name?: string;
  environment?: string;
  signal?: string;
  static_id?: string;
  node_id?: string;
  entry_point_id?: string;
  exit_point_id?: string;
  call_chain_id?: string;
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
  method?: string;
  route?: string;
  path?: string;
  status_code?: number;
  duration_ms?: number;
  error_message?: string;
  stack?: string;
  attributes?: Record<string, unknown>;
}

export class Trace {
  private context: TraceContext;
  private sdk: UnravlSDK;
  private ended: boolean = false;

  constructor(name: string, sdk: UnravlSDK, parentSpanId?: string) {
    this.sdk = sdk;
    this.context = {
      traceId: this.generateId(),
      spanId: this.generateId(),
      parentSpanId,
      startTime: performance.now(),
      name,
      attributes: {},
      events: [],
    };
  }

  addEvent(name: string, attributes?: Record<string, any>): void {
    if (this.ended) return;
    this.context.events?.push({
      name,
      timestamp: performance.now(),
      attributes,
    });
  }

  setAttribute(key: string, value: any): void {
    if (this.ended) return;
    if (!this.context.attributes) {
      this.context.attributes = {};
    }
    this.context.attributes[key] = value;
  }

  setAttributes(attributes: Record<string, any>): void {
    if (this.ended) return;
    this.context.attributes = { ...this.context.attributes, ...attributes };
  }

  end(): void {
    if (this.ended) return;
    const duration = performance.now() - this.context.startTime;
    this.setAttribute('duration_ms', duration);
    this.ended = true;
    this.sdk.submitTrace(this.context);
  }

  private generateId(): string {
    return Math.random().toString(36).substring(2, 15) + 
           Math.random().toString(36).substring(2, 15);
  }
}

export class UnravlSDK extends EventEmitter {
  private config: Required<UnravlConfig>;
  private buffer: Array<TraceContext | Metric | ErrorReport | CASRuntimeEvent> = [];
  private flushTimer?: NodeJS.Timeout;
  private activeTraces = new Map<string, Trace>();
  private originalHttpRequest?: typeof http.request;
  private originalHttpsRequest?: typeof https.request;

  constructor(config: UnravlConfig) {
    super();
    this.config = {
      projectId: config.projectId,
      apiKey: config.apiKey,
      endpoint: config.endpoint || 'https://api.unravl.io',
      environment: config.environment || 'production',
      serviceName: config.serviceName || 'default',
      batchSize: config.batchSize || 100,
      flushInterval: config.flushInterval || 5000,
      debug: config.debug || false,
    };

    this.startFlushTimer();
  }

  // Auto-instrumentation
  autoInstrument(): void {
    this.instrumentHttp();
    this.instrumentConsole();
    this.instrumentPromises();
    this.instrumentTimers();
  }

  // Manual instrumentation
  startTrace(name: string, parentSpanId?: string): Trace {
    const trace = new Trace(name, this, parentSpanId);
    this.activeTraces.set(trace['context'].spanId, trace);
    return trace;
  }

  recordMetric(name: string, value: number, tags?: Record<string, string>, unit?: string): void {
    const metric: Metric = {
      name,
      value,
      timestamp: Date.now(),
      tags: {
        ...tags,
        environment: this.config.environment,
        service: this.config.serviceName,
      },
      unit,
    };
    this.addToBuffer(metric);
  }

  reportError(error: Error, context?: any, severity?: ErrorReport['severity']): void {
    const errorReport: ErrorReport = {
      error,
      timestamp: Date.now(),
      context: {
        ...context,
        environment: this.config.environment,
        service: this.config.serviceName,
      },
      stackTrace: error.stack,
      severity: severity || this.calculateSeverity(error),
    };
    this.addToBuffer(errorReport);
    
    // Immediate flush for critical errors
    if (severity === 'critical') {
      this.flush();
    }
  }

  recordCasEvent(event: CASRuntimeEvent): void {
    this.addToBuffer({
      schema_version: event.schema_version || '1.0.0',
      timestamp: event.timestamp || new Date().toISOString(),
      service_name: event.service_name || this.config.serviceName,
      environment: event.environment || this.config.environment,
      ...event,
      attributes: {
        ...event.attributes,
        project_id: this.config.projectId,
      },
    });
  }

  recordCasRequest(input: Omit<CASRuntimeEvent, 'type'>): void {
    this.recordCasEvent({ ...input, type: 'request' });
  }

  recordCasExit(input: Omit<CASRuntimeEvent, 'type'>): void {
    this.recordCasEvent({ ...input, type: 'exit' });
  }

  // Express middleware
  expressMiddleware() {
    return (req: any, res: any, next: any) => {
      const trace = this.startTrace(`${req.method} ${req.path}`);
      
      trace.setAttributes({
        'http.method': req.method,
        'http.path': req.path,
        'http.url': req.url,
        'http.user_agent': req.headers['user-agent'],
        'http.remote_addr': req.ip,
      });

      const originalSend = res.send;
      const originalJson = res.json;
      const startTime = Date.now();

      const finishTrace = () => {
        trace.setAttribute('http.status_code', res.statusCode);
        trace.setAttribute('http.response_time', Date.now() - startTime);
        trace.end();
      };

      res.send = function(...args: any[]) {
        finishTrace();
        return originalSend.apply(res, args);
      };

      res.json = function(...args: any[]) {
        finishTrace();
        return originalJson.apply(res, args);
      };

      next();
    };
  }

  // Database interceptors
  instrumentDatabase(client: any): void {
    // PostgreSQL instrumentation
    if (client.query && typeof client.query === 'function') {
      const originalQuery = client.query.bind(client);
      client.query = (...args: any[]) => {
        const trace = this.startTrace('db.query');
        const query = args[0];
        
        trace.setAttributes({
          'db.type': 'postgresql',
          'db.statement': typeof query === 'string' ? query : query.text,
        });

        const startTime = performance.now();
        
        const promise = originalQuery(...args);
        
        promise
          .then((result: any) => {
            trace.setAttribute('db.rows_affected', result.rowCount);
            trace.setAttribute('db.duration_ms', performance.now() - startTime);
            trace.end();
            return result;
          })
          .catch((error: Error) => {
            trace.setAttribute('db.error', error.message);
            trace.setAttribute('db.duration_ms', performance.now() - startTime);
            trace.end();
            this.reportError(error, { query });
            throw error;
          });

        return promise;
      };
    }

    // MongoDB instrumentation
    if (client.collection && typeof client.collection === 'function') {
      const collections = new Map<string, any>();
      const originalCollection = client.collection.bind(client);
      
      client.collection = (name: string) => {
        if (collections.has(name)) {
          return collections.get(name);
        }

        const collection = originalCollection(name);
        const instrumentedCollection = this.instrumentMongoCollection(collection, name);
        collections.set(name, instrumentedCollection);
        return instrumentedCollection;
      };
    }
  }

  // Internal methods
  submitTrace(context: TraceContext): void {
    this.addToBuffer(context);
    this.activeTraces.delete(context.spanId);
  }

  private instrumentHttp(): void {
    // Instrument HTTP module
    if (!this.originalHttpRequest) {
      this.originalHttpRequest = http.request;
      const sdk = this;
      
      (http as any).request = function(...args: any[]): http.ClientRequest {
        const trace = sdk.startTrace('http.request');
        const options = args[0];
        
        trace.setAttributes({
          'http.method': options.method || 'GET',
          'http.host': options.hostname || options.host,
          'http.port': options.port || 80,
          'http.path': options.path || '/',
        });

        const req = (sdk.originalHttpRequest as any)(...args);
        
        req.on('response', (res: http.IncomingMessage) => {
          trace.setAttribute('http.status_code', res.statusCode);
          trace.end();
        });

        req.on('error', (error: Error) => {
          trace.setAttribute('http.error', error.message);
          trace.end();
          sdk.reportError(error);
        });

        return req;
      };
    }

    // Instrument HTTPS module
    if (!this.originalHttpsRequest) {
      this.originalHttpsRequest = https.request;
      const sdk = this;
      
      (https as any).request = function(...args: any[]): http.ClientRequest {
        const trace = sdk.startTrace('https.request');
        const options = args[0];
        
        trace.setAttributes({
          'http.method': options.method || 'GET',
          'http.host': options.hostname || options.host,
          'http.port': options.port || 443,
          'http.path': options.path || '/',
          'http.scheme': 'https',
        });

        const req = (sdk.originalHttpsRequest as any)(...args);
        
        req.on('response', (res: http.IncomingMessage) => {
          trace.setAttribute('http.status_code', res.statusCode);
          trace.end();
        });

        req.on('error', (error: Error) => {
          trace.setAttribute('http.error', error.message);
          trace.end();
          sdk.reportError(error);
        });

        return req;
      };
    }
  }

  private instrumentConsole(): void {
    const originalError = console.error;
    const sdk = this;
    
    console.error = function(...args: any[]) {
      const error = args[0] instanceof Error ? args[0] : new Error(args.join(' '));
      sdk.reportError(error, { source: 'console.error' });
      originalError.apply(console, args);
    };
  }

  private instrumentPromises(): void {
    if (typeof process !== 'undefined') {
      process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
        const error = reason instanceof Error ? reason : new Error(String(reason));
        this.reportError(error, { 
          source: 'unhandledRejection',
          promise: promise.toString()
        }, 'high');
      });

      process.on('uncaughtException', (error: Error) => {
        this.reportError(error, { source: 'uncaughtException' }, 'critical');
      });
    }
  }

  private instrumentTimers(): void {
    const originalSetTimeout = global.setTimeout;
    const originalSetInterval = global.setInterval;
    const sdk = this;

    global.setTimeout = function(callback: any, delay: number, ...args: any[]) {
      const wrappedCallback = function() {
        const trace = sdk.startTrace('timer.timeout');
        trace.setAttribute('timer.delay', delay);
        
        try {
          callback(...args);
          trace.end();
        } catch (error) {
          trace.setAttribute('timer.error', (error as Error).message);
          trace.end();
          sdk.reportError(error as Error, { type: 'setTimeout', delay });
          throw error;
        }
      };

      return originalSetTimeout(wrappedCallback, delay);
    } as any;

    global.setInterval = function(callback: any, delay: number, ...args: any[]) {
      const wrappedCallback = function() {
        const trace = sdk.startTrace('timer.interval');
        trace.setAttribute('timer.delay', delay);
        
        try {
          callback(...args);
          trace.end();
        } catch (error) {
          trace.setAttribute('timer.error', (error as Error).message);
          trace.end();
          sdk.reportError(error as Error, { type: 'setInterval', delay });
          throw error;
        }
      };

      return originalSetInterval(wrappedCallback, delay);
    } as any;
  }

  private instrumentMongoCollection(collection: any, name: string): any {
    const sdk = this;
    const methods = ['find', 'findOne', 'insertOne', 'insertMany', 'updateOne', 
                    'updateMany', 'deleteOne', 'deleteMany', 'aggregate'];

    const instrumented = Object.create(collection);

    methods.forEach(method => {
      if (typeof collection[method] === 'function') {
        instrumented[method] = function(...args: any[]) {
          const trace = sdk.startTrace(`mongodb.${method}`);
          trace.setAttributes({
            'db.type': 'mongodb',
            'db.collection': name,
            'db.operation': method,
          });

          const startTime = performance.now();
          const result = collection[method](...args);

          if (result && typeof result.then === 'function') {
            return result
              .then((data: any) => {
                trace.setAttribute('db.duration_ms', performance.now() - startTime);
                trace.end();
                return data;
              })
              .catch((error: Error) => {
                trace.setAttribute('db.error', error.message);
                trace.setAttribute('db.duration_ms', performance.now() - startTime);
                trace.end();
                sdk.reportError(error, { collection: name, method });
                throw error;
              });
          }

          trace.end();
          return result;
        };
      }
    });

    return instrumented;
  }

  private calculateSeverity(error: Error): ErrorReport['severity'] {
    const message = error.message.toLowerCase();
    
    if (message.includes('critical') || message.includes('fatal')) {
      return 'critical';
    }
    if (message.includes('error') || message.includes('exception')) {
      return 'high';
    }
    if (message.includes('warning') || message.includes('warn')) {
      return 'medium';
    }
    return 'low';
  }

  private addToBuffer(data: TraceContext | Metric | ErrorReport | CASRuntimeEvent): void {
    this.buffer.push(data);
    
    if (this.buffer.length >= this.config.batchSize) {
      this.flush();
    }
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      if (this.buffer.length > 0) {
        this.flush();
      }
    }, this.config.flushInterval);
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const batch = this.buffer.splice(0, this.config.batchSize);
    
    try {
      await this.sendBatch(batch);
      this.emit('flush', batch.length);
    } catch (error) {
      this.emit('error', error);
      // Re-add failed batch to buffer for retry
      this.buffer.unshift(...batch);
    }
  }

  private async sendBatch(batch: Array<TraceContext | Metric | ErrorReport | CASRuntimeEvent>): Promise<void> {
    await Promise.all(batch.map(item => this.sendTelemetryMessage(item)));
  }

  private async sendTelemetryMessage(item: TraceContext | Metric | ErrorReport | CASRuntimeEvent): Promise<void> {
    const response = await fetch(`${this.config.endpoint}/api/telemetry/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(this.toTelemetryMessage(item)),
    });

    if (!response.ok) {
      throw new Error(`Failed to send telemetry: ${response.statusText}`);
    }
  }

  private toTelemetryMessage(item: TraceContext | Metric | ErrorReport | CASRuntimeEvent) {
    const payloadType = this.payloadType(item);
    return {
      version: '1.0',
      timestamp: Date.now(),
      projectId: this.config.projectId,
      type: payloadType,
      payload: {
        type: payloadType,
        data: this.payloadData(item),
      },
      metadata: {
        sdkVersion: '1.0.0',
        runtime: `node:${process.version}`,
        hostname: process.env.HOSTNAME || '',
        environment: this.config.environment,
      },
    };
  }

  private payloadType(item: TraceContext | Metric | ErrorReport | CASRuntimeEvent): 'metric' | 'trace' | 'event' {
    if ('value' in item && 'name' in item) return 'metric';
    if ('traceId' in item && 'spanId' in item) return 'trace';
    return 'event';
  }

  private payloadData(item: TraceContext | Metric | ErrorReport | CASRuntimeEvent): Record<string, unknown> {
    if ('error' in item) {
      return {
        type: 'error',
        timestamp: new Date(item.timestamp).toISOString(),
        error_message: item.error.message,
        stack: item.stackTrace,
        severity: item.severity,
        attributes: item.context,
      };
    }
    return item as unknown as Record<string, unknown>;
  }

  shutdown(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
    
    // Final flush
    this.flush();
    
    // Restore original functions
    if (this.originalHttpRequest) {
      (http as any).request = this.originalHttpRequest;
    }
    if (this.originalHttpsRequest) {
      (https as any).request = this.originalHttpsRequest;
    }
  }
}

// Export convenience function
export function createSDK(config: UnravlConfig): UnravlSDK {
  return new UnravlSDK(config);
}
