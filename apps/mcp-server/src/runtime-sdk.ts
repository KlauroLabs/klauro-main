import * as crypto from 'crypto';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { getRuntimeEventContract } from './runtime-contract';

interface RuntimeSdkFile {
  path: string;
  language: string;
  sha256: string;
  content: string;
}

export function getRuntimeSdkPackage(cas: CASOutput, opts: { limit?: number } = {}) {
  const contract = getRuntimeEventContract(cas, { limit: opts.limit || 25 });
  const clientSource = buildTypeScriptClientSource();
  const manifest = {
    name: `@klauro/runtime-${slugify(cas.system.name)}`,
    version: '1.0.0',
    cas_analysis_id: cas.analysis_id,
    cas_version: cas.cas_version,
    generated_at: new Date().toISOString(),
    service_name: cas.system.name,
  };
  const files: RuntimeSdkFile[] = [
    sdkFile('package.json', 'json', JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      type: 'module',
      main: './dist/klauro-runtime.js',
      types: './dist/klauro-runtime.d.ts',
      scripts: {
        build: 'tsc -p tsconfig.json',
      },
      dependencies: {},
      devDependencies: {
        typescript: '^5.0.0',
      },
    }, null, 2)),
    sdkFile('tsconfig.json', 'json', JSON.stringify({
      compilerOptions: {
        target: 'ES2020',
        module: 'ES2020',
        moduleResolution: 'Bundler',
        declaration: true,
        outDir: 'dist',
        strict: true,
      },
      include: ['src/**/*.ts'],
    }, null, 2)),
    sdkFile('src/klauro-runtime.ts', 'typescript', clientSource),
    sdkFile('src/cas-runtime-contract.json', 'json', JSON.stringify(contract, null, 2)),
  ];

  return {
    manifest,
    transport: contract.transport,
    files,
    quick_start: {
      config: {
        endpoint: '<backend origin>',
        projectId: '<project id>',
        apiKey: '<telemetry api key>',
        serviceName: cas.system.name,
        environment: '<environment>',
      },
      first_call: 'client.recordCasEvent({ type: "custom", signal: "<runtime_signal>" })',
      flush: 'await client.flush()',
    },
    proof: {
      runtime_static_links: contract.totals.runtime_static_links,
      included_contracts: contract.contracts.length,
      sdk_methods: ['recordCasEvent', 'flush', 'wrapFetch', 'expressMiddleware'],
      minimum_event_fields: contract.fields.filter(field => field.required).map(field => field.name),
    },
  };
}

function sdkFile(filePath: string, language: string, content: string): RuntimeSdkFile {
  return {
    path: filePath,
    language,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
    content,
  };
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
}

function buildTypeScriptClientSource(): string {
  return `export type CasRuntimeEventType = 'request' | 'error' | 'exit' | 'log' | 'custom';

export interface CasRuntimeEvent {
  type: CasRuntimeEventType;
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

export interface KlauroRuntimeConfig {
  endpoint: string;
  projectId: string;
  apiKey?: string;
  serviceName?: string;
  environment?: string;
  batchSize?: number;
  fetchImpl?: typeof fetch;
}

export class KlauroRuntimeClient {
  private readonly queue: CasRuntimeEvent[] = [];
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: KlauroRuntimeConfig) {
    this.fetchImpl = config.fetchImpl || fetch;
  }

  recordCasEvent(event: CasRuntimeEvent): void {
    this.queue.push(this.normalize(event));
    if (this.queue.length >= (this.config.batchSize || 25)) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const events = this.queue.splice(0, this.queue.length);
    const response = await this.fetchImpl(this.ingestUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.config.apiKey ? { authorization: \`Bearer \${this.config.apiKey}\` } : {}),
      },
      body: JSON.stringify({ events }),
    });
    if (!response.ok) {
      this.queue.unshift(...events);
      throw new Error(\`Klauro runtime ingest failed: \${response.status}\`);
    }
  }

  wrapFetch(input: RequestInfo | URL, init: RequestInit = {}, event: Partial<CasRuntimeEvent> = {}): Promise<Response> {
    const startedAt = Date.now();
    const method = String(init.method || 'GET').toUpperCase();
    const path = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return this.fetchImpl(input, init).then(response => {
      this.recordCasEvent({
        type: 'exit',
        method,
        path,
        status_code: response.status,
        duration_ms: Date.now() - startedAt,
        ...event,
      });
      return response;
    }).catch(error => {
      this.recordCasEvent({
        type: 'error',
        method,
        path,
        duration_ms: Date.now() - startedAt,
        error_message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        ...event,
      });
      throw error;
    });
  }

  expressMiddleware(routeResolver?: (req: any) => Partial<CasRuntimeEvent>) {
    return (req: any, res: any, next: () => void) => {
      const startedAt = Date.now();
      res.on('finish', () => {
        const route = req.route?.path || req.path || req.url;
        this.recordCasEvent({
          type: 'request',
          method: req.method,
          route,
          path: req.originalUrl || req.url,
          status_code: res.statusCode,
          duration_ms: Date.now() - startedAt,
          ...(routeResolver ? routeResolver(req) : {}),
        });
      });
      next();
    };
  }

  private normalize(event: CasRuntimeEvent): CasRuntimeEvent {
    return {
      schema_version: '1.0.0',
      timestamp: new Date().toISOString(),
      service_name: this.config.serviceName,
      environment: this.config.environment,
      ...event,
    };
  }

  private ingestUrl(): string {
    return \`\${this.config.endpoint.replace(/\\/$/, '')}/api/telemetry/runtime-events/\${encodeURIComponent(this.config.projectId)}\`;
  }
}
`;
}
