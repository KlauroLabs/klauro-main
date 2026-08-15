import test from 'node:test';
import assert from 'node:assert/strict';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { getRuntimeSdkPackage, isRuntimeSdkPackageReady } from './runtime-sdk';

function cas(frameworks: string[], runtime?: string, languages: string[] = []): CASOutput {
  return {
    cas_version: '1.11.0',
    analysis_id: 'analysis_test',
    analysis_timestamp: new Date().toISOString(),
    system: {
      id: 'sys',
      name: 'items-api',
      type: 'service',
      root_path: '/tmp/items-api',
      technologies: {
        frameworks: frameworks.map(name => ({ name })),
        runtime,
        languages: languages.map(name => ({ name })),
      },
    },
    nodes: [],
    edges: [],
    analyzer_contributions: [],
    runtime_static_links: [],
  } as unknown as CASOutput;
}

test('serves a real npm install command and Express init for an Express app', () => {
  const out = getRuntimeSdkPackage(cas(['Express']));
  assert.equal(out.manifest.stack, 'node');
  assert.equal(out.manifest.framework, 'express');
  assert.equal(out.install.command, 'npm install @klauro/telemetry');
  assert.match(out.quick_start.instrument_in_3_lines, /@klauro\/telemetry\/express/);
  assert.match(out.quick_start.instrument_in_3_lines, /klauroExpress\(\)/);
  assert.equal(out.proof.installable, true);
});

test('picks the NestJS interceptor snippet when Nest is detected', () => {
  const out = getRuntimeSdkPackage(cas(['NestJS', 'Express']));
  assert.equal(out.manifest.framework, 'nestjs');
  assert.match(out.quick_start.instrument_in_3_lines, /KlauroInterceptor/);
});

test('serves pip install and FastAPI middleware for a FastAPI app', () => {
  const out = getRuntimeSdkPackage(cas(['FastAPI'], 'python'));
  assert.equal(out.manifest.stack, 'python');
  assert.equal(out.install.command, 'pip install "klauro-telemetry[fastapi]"');
  assert.match(out.quick_start.instrument_in_3_lines, /KlauroASGIMiddleware/);
  assert.ok(out.proof.middlewares.some(m => m.includes('FastAPI')));
});

test('serves Django middleware wiring for a Django app', () => {
  const out = getRuntimeSdkPackage(cas(['Django'], 'python'));
  assert.equal(out.install.command, 'pip install "klauro-telemetry[django]"');
  assert.match(out.quick_start.instrument_in_3_lines, /KlauroDjangoMiddleware/);
});

test('falls back to python by language when no web framework is detected', () => {
  const out = getRuntimeSdkPackage(cas([], undefined, ['Python']));
  assert.equal(out.manifest.stack, 'python');
  assert.equal(out.install.command, 'pip install klauro-telemetry');
});

test('uses the dominant language for a polyglot repository without a supported framework', () => {
  const fixture = cas([], undefined, []);
  fixture.system.technologies!.languages = [
    { name: 'TypeScript/JavaScript', percentage: 99.2, files: 1500 },
    { name: 'Python', percentage: 0.8, files: 9 },
  ];
  const out = getRuntimeSdkPackage(fixture);
  assert.equal(out.manifest.stack, 'node');
  assert.equal(out.install.command, 'npm install @klauro/telemetry');
});

test('defaults to the Node package when nothing is detected', () => {
  const out = getRuntimeSdkPackage(cas([]));
  assert.equal(out.manifest.stack, 'node');
  assert.equal(out.install.command, 'npm install @klauro/telemetry');
});

test('emits a pinned per-analysis contract file and correct verify endpoint', () => {
  const out = getRuntimeSdkPackage(cas(['Express']));
  const contractFile = out.files.find(f => f.path === 'cas-runtime-contract.json');
  assert.ok(contractFile, 'contract file is included');
  assert.equal(contractFile!.language, 'json');
  assert.ok(contractFile!.sha256.length === 64);
  assert.match(out.verify.endpoint, /\/api\/telemetry\/runtime-events\/<project id>/);
  assert.equal(out.transport.batch_key, 'events');
  assert.equal(isRuntimeSdkPackageReady(out), true);
});
