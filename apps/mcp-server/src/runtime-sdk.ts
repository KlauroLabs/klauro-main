import * as crypto from 'crypto';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { getRuntimeEventContract } from './runtime-contract';
import { telemetrySdkReadiness } from './telemetry-sdk-readiness';

interface RuntimeSdkFile {
  path: string;
  language: string;
  sha256: string;
  content: string;
}


const JS_PACKAGE = '@klauro/telemetry';
const PY_PACKAGE = 'klauro-telemetry';

type Stack = 'node' | 'python';

interface FrameworkSnippet {
  framework: string;
  stack: Stack;
  install: string;
  init: string;
  docs: string;
}





function detectStack(cas: CASOutput): { stack: Stack; framework: string } {
  const frameworks = (cas.system.technologies?.frameworks || [])
    .map(f => (f?.name || '').toLowerCase())
    .filter(Boolean);
  const runtime = (cas.system.technologies?.runtime || '').toLowerCase();
  const languages = cas.system.technologies?.languages || [];
  const has = (needle: string) => frameworks.some(f => f.includes(needle));


  if (has('fastapi') || has('starlette')) return { stack: 'python', framework: 'fastapi' };
  if (has('flask')) return { stack: 'python', framework: 'flask' };
  if (has('django')) return { stack: 'python', framework: 'django' };


  if (has('nest')) return { stack: 'node', framework: 'nestjs' };
  if (has('fastify')) return { stack: 'node', framework: 'fastify' };
  if (has('koa')) return { stack: 'node', framework: 'koa' };
  if (has('express')) return { stack: 'node', framework: 'express' };


  const dominantLanguage = [...languages]
    .sort((left, right) => (right.percentage || right.files || 0) - (left.percentage || left.files || 0))[0]
    ?.name.toLowerCase() || '';
  const isPython = runtime.includes('python') || dominantLanguage === 'python' || frameworks.some(f => f.includes('python'));
  if (isPython) return { stack: 'python', framework: 'python' };
  return { stack: 'node', framework: 'node' };
}

export function isRuntimeSdkPackageReady(sdkPackage: ReturnType<typeof getRuntimeSdkPackage>): boolean {
  return sdkPackage.proof.installable
    && Boolean(sdkPackage.install.command)
    && sdkPackage.files.some(file => file.path === 'cas-runtime-contract.json' && file.sha256.length === 64);
}

function snippetFor(framework: string, service: string): FrameworkSnippet {
  const svc = JSON.stringify(service);
  switch (framework) {
    case 'express':
      return {
        framework,
        stack: 'node',
        install: `npm install ${JS_PACKAGE}`,
        init: [
          `import { init } from '${JS_PACKAGE}';`,
          `import { klauroExpress } from '${JS_PACKAGE}/express';`,
          `init({ apiKey: process.env.KLAURO_API_KEY, projectId: '<project id>', service: ${svc}, environment: process.env.NODE_ENV });`,
          `app.use(klauroExpress());`,
        ].join('\n'),
        docs: `${JS_PACKAGE}/express`,
      };
    case 'fastify':
      return {
        framework,
        stack: 'node',
        install: `npm install ${JS_PACKAGE}`,
        init: [
          `import { init } from '${JS_PACKAGE}';`,
          `import { klauroFastify } from '${JS_PACKAGE}/fastify';`,
          `init({ apiKey: process.env.KLAURO_API_KEY, projectId: '<project id>', service: ${svc}, environment: process.env.NODE_ENV });`,
          `await app.register(klauroFastify());`,
        ].join('\n'),
        docs: `${JS_PACKAGE}/fastify`,
      };
    case 'koa':
      return {
        framework,
        stack: 'node',
        install: `npm install ${JS_PACKAGE}`,
        init: [
          `import { init } from '${JS_PACKAGE}';`,
          `import { klauroKoa } from '${JS_PACKAGE}/koa';`,
          `init({ apiKey: process.env.KLAURO_API_KEY, projectId: '<project id>', service: ${svc}, environment: process.env.NODE_ENV });`,
          `app.use(klauroKoa());`,
        ].join('\n'),
        docs: `${JS_PACKAGE}/koa`,
      };
    case 'nestjs':
      return {
        framework,
        stack: 'node',
        install: `npm install ${JS_PACKAGE}`,
        init: [
          `import { init } from '${JS_PACKAGE}';`,
          `import { KlauroInterceptor } from '${JS_PACKAGE}/nestjs';`,
          `init({ apiKey: process.env.KLAURO_API_KEY, projectId: '<project id>', service: ${svc}, environment: process.env.NODE_ENV });`,
          `app.useGlobalInterceptors(new KlauroInterceptor());`,
        ].join('\n'),
        docs: `${JS_PACKAGE}/nestjs`,
      };
    case 'fastapi':
      return {
        framework,
        stack: 'python',
        install: `pip install "${PY_PACKAGE}[fastapi]"`,
        init: [
          `from klauro_telemetry import init`,
          `from klauro_telemetry.middleware import KlauroASGIMiddleware`,
          `init(api_key=os.environ["KLAURO_API_KEY"], project_id="<project id>", service=${svc}, environment=os.environ.get("ENV"))`,
          `app.add_middleware(KlauroASGIMiddleware)`,
        ].join('\n'),
        docs: `${PY_PACKAGE} (FastAPI/Starlette)`,
      };
    case 'flask':
      return {
        framework,
        stack: 'python',
        install: `pip install "${PY_PACKAGE}[flask]"`,
        init: [
          `from klauro_telemetry import init`,
          `from klauro_telemetry.middleware import init_flask`,
          `init(api_key=os.environ["KLAURO_API_KEY"], project_id="<project id>", service=${svc}, environment=os.environ.get("ENV"))`,
          `init_flask(app)`,
        ].join('\n'),
        docs: `${PY_PACKAGE} (Flask)`,
      };
    case 'django':
      return {
        framework,
        stack: 'python',
        install: `pip install "${PY_PACKAGE}[django]"`,
        init: [
          `# settings.py`,
          `from klauro_telemetry import init`,
          `init(api_key=os.environ["KLAURO_API_KEY"], project_id="<project id>", service=${svc}, environment=os.environ.get("ENV"))`,
          `MIDDLEWARE = [*MIDDLEWARE, "klauro_telemetry.middleware.KlauroDjangoMiddleware"]`,
        ].join('\n'),
        docs: `${PY_PACKAGE} (Django)`,
      };
    case 'python':
      return {
        framework,
        stack: 'python',
        install: `pip install ${PY_PACKAGE}`,
        init: [
          `from klauro_telemetry import init, record`,
          `init(api_key=os.environ["KLAURO_API_KEY"], project_id="<project id>", service=${svc}, environment=os.environ.get("ENV"))`,
          `record("service.started")`,
        ].join('\n'),
        docs: PY_PACKAGE,
      };
    default:
      return {
        framework: 'node',
        stack: 'node',
        install: `npm install ${JS_PACKAGE}`,
        init: [
          `import { init, record } from '${JS_PACKAGE}';`,
          `init({ apiKey: process.env.KLAURO_API_KEY, projectId: '<project id>', service: ${svc}, environment: process.env.NODE_ENV });`,
          `record('service.started');`,
        ].join('\n'),
        docs: JS_PACKAGE,
      };
  }
}

export function getRuntimeSdkPackage(cas: CASOutput, opts: {
  limit?: number;
  releaseCandidateDir?: string;
  releaseSourceSha?: string;
} = {}) {
  const contract = getRuntimeEventContract(cas, { limit: opts.limit || 25 });
  const { stack, framework } = detectStack(cas);
  const service = cas.system.name;
  const release = telemetrySdkReadiness(stack, { candidateDir: opts.releaseCandidateDir, sourceSha: opts.releaseSourceSha });
  const snippet = snippetFor(framework, service);
  const pkg = stack === 'python' ? PY_PACKAGE : JS_PACKAGE;

  const manifest = {
    package: pkg,
    stack,
    framework: snippet.framework,
    cas_analysis_id: cas.analysis_id,
    cas_version: cas.cas_version,
    generated_at: new Date().toISOString(),
    service_name: service,
  };




  const files: RuntimeSdkFile[] = [
    sdkFile('cas-runtime-contract.json', 'json', JSON.stringify(contract, null, 2)),
  ];

  return {
    manifest,

    install: {
      command: snippet.install,
      package: pkg,
      stack,
      framework: snippet.framework,
      docs: snippet.docs,
    },
    quick_start: {
      instrument_in_3_lines: snippet.init,
      config: {
        endpoint: contract.transport.ingest_path.startsWith('http')
          ? '<backend origin>'
          : 'https://mcp.klauro.com',
        projectId: '<project id>',
        apiKey: '<telemetry api key>',
        service,
        environment: '<environment>',
      },
      manual_api: {
        node: `import { record, startSpan, captureError } from '${JS_PACKAGE}';`,
        python: `from klauro_telemetry import record, start_span, capture_error`,
      }[stack],
    },
    transport: contract.transport,
    files,
    verify: {
      after_deploy: 'Call get_runtime_observations to see ingested events, or correlate_runtime_event to map one event back to CAS static structure.',
      endpoint: `POST {endpoint}${contract.transport.ingest_path.replace(':projectId', '<project id>')}`,
      body_shape: '{ "events": [ CasRuntimeEvent, ... ] }',
    },
    proof: {
      installable: release.installable,
      locally_installable: release.locally_installable,
      distributable: release.distributable,
      publishable: release.publishable,
      release_blockers: release.blockers,
      release_status: release.status,
      release_reason: release.reason,
      ...(release.artifact_sha256 ? { artifact_sha256: release.artifact_sha256, source_sha: release.source_sha } : {}),
      runtime_static_links: contract.totals.runtime_static_links,
      included_contracts: contract.contracts.length,
      sdk_methods:
        stack === 'python'
          ? ['init', 'record', 'record_event', 'start_span', 'capture_error', 'increment_counter', 'record_gauge', 'flush']
          : ['init', 'record', 'recordEvent', 'startSpan', 'captureError', 'incrementCounter', 'recordGauge', 'flush'],
      middlewares:
        stack === 'python'
          ? ['KlauroASGIMiddleware (FastAPI)', 'init_flask (Flask)', 'KlauroDjangoMiddleware (Django)']
          : ['klauroExpress', 'klauroFastify', 'klauroKoa', 'KlauroInterceptor (NestJS)'],
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
