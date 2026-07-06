import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { ObservabilityAnalyzer } from './observability-analyzer';

async function makeFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'observability-analyzer-'));

  await fs.writeJson(path.join(dir, 'package.json'), {
    name: 'observability-fixture',
    dependencies: {
      '@opentelemetry/api': '^1.9.0',
      '@sentry/node': '^8.0.0',
      'prom-client': '^15.0.0',
      pino: '^9.0.0',
    },
  });
  await fs.writeFile(path.join(dir, 'requirements.txt'), 'structlog==24.1.0\nsentry-sdk==2.0.0\n');
  await fs.writeFile(
    path.join(dir, 'build.gradle'),
    "implementation 'io.micrometer:micrometer-core:1.12.0'\nimplementation 'io.opentelemetry:opentelemetry-api:1.36.0'\n"
  );

  await fs.writeFile(
    path.join(dir, 'server.ts'),
    [
      `import { trace } from '@opentelemetry/api';`,
      `import * as Sentry from '@sentry/node';`,
      `import { Counter, Histogram } from 'prom-client';`,
      `import pino from 'pino';`,
      '',
      `const tracer = trace.getTracer('orders-api');`,
      `const logger = pino();`,
      `const requests = new Counter({ name: 'http_requests_total', help: 'requests' });`,
      `const latency = new Histogram({ name: 'http_request_duration_seconds', help: 'latency' });`,
      '',
      'export async function handleOrder(error: Error) {',
      `  return tracer.startSpan('orders.handle', span => {`,
      '    requests.inc();',
      '    latency.observe(0.2);',
      '    logger.error({ err: error }, "order failed");',
      '    Sentry.captureException(error);',
      '    span.end();',
      '  });',
      '}',
      '',
    ].join('\n')
  );

  await fs.writeFile(
    path.join(dir, 'worker.py'),
    [
      'import logging',
      'import structlog',
      'import sentry_sdk',
      'from sentry_sdk import capture_exception',
      '',
      'logger = structlog.get_logger("worker")',
      'plain_logger = logging.getLogger("plain-worker")',
      '',
      'def run(exc):',
      '    sentry_sdk.init(dsn="example")',
      '    capture_exception(exc)',
      '    logger.error("worker.failed", exc=exc)',
      '    plain_logger.exception("plain failed")',
      '',
    ].join('\n')
  );

  await fs.writeFile(
    path.join(dir, 'Metrics.java'),
    [
      'import io.micrometer.core.instrument.Counter;',
      'import io.micrometer.core.instrument.Timer;',
      'import io.opentelemetry.extension.annotations.WithSpan;',
      '',
      'class Metrics {',
      '  Counter counter = Counter.builder("jobs_total").register(registry);',
      '  Timer timer = Timer.builder("jobs_duration").register(registry);',
      '',
      '  @WithSpan("jobs.handle")',
      '  void handle() {}',
      '}',
      '',
    ].join('\n')
  );

  return dir;
}

test('ObservabilityAnalyzer emits telemetry, span, metric, logger nodes and instrumentation edges', async () => {
  const dir = await makeFixture();
  try {
    const analyzer = new ObservabilityAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true, 'canAnalyze should detect observability evidence');

    const contribution = await analyzer.analyze({ projectPath: dir });
    const { nodes, edges } = contribution;

    assert.ok(nodes.find(node => node.type === 'span' && node.name === 'OpenTelemetry JS: orders.handle'), 'expected OTel span node');
    assert.ok(nodes.find(node => node.type === 'metric' && (node.metadata as any)?.identifier === 'http_requests_total'), 'expected prom-client counter node');
    assert.ok(nodes.find(node => node.type === 'telemetry' && (node.metadata as any)?.operation === 'exception capture'), 'expected Sentry capture node');
    assert.ok(nodes.find(node => node.type === 'logger' && (node.metadata as any)?.observability_system === 'Pino'), 'expected Pino logger node');
    assert.ok(nodes.find(node => node.type === 'logger' && (node.metadata as any)?.observability_system === 'structlog'), 'expected structlog logger node');
    assert.ok(nodes.find(node => node.type === 'metric' && (node.metadata as any)?.identifier === 'jobs_total'), 'expected Micrometer counter node');
    assert.ok(edges.find(edge => edge.type === 'instruments' && edge.category === 'observability'), 'expected instrumentation edge to module node');

    const meta = contribution.analyzer_metadata as any;
    assert.equal(meta.instrumentation_nodes, nodes.filter(node => ['telemetry', 'span', 'metric', 'logger'].includes(node.type)).length);
    assert.ok(meta.metrics >= 4, 'expected metric inventory count');
    assert.ok(meta.loggers >= 4, 'expected logger inventory count');
    assert.ok(meta.exception_capture_sites >= 2, 'expected exception capture inventory count');
    assert.ok(contribution.libraries?.some(library => library.category === 'observability' && library.name === '@sentry/node'), 'expected observability library inventory');
  } finally {
    await fs.remove(dir);
  }
});

test('ObservabilityAnalyzer detects Datadog browser and mobile SDK instrumentation', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'observability-analyzer-datadog-'));
  try {
    await fs.writeJson(path.join(dir, 'package.json'), {
      name: 'datadog-sdk-fixture',
      dependencies: {
        '@datadog/browser-logs': '^4.50.0',
        '@datadog/browser-rum': '^4.50.0',
        '@datadog/mobile-react-native': '^1.8.5',
      },
    });

    // Mirrors the real soon-ui shape (datadogRum/datadogLogs init + createLogger + addError).
    await fs.writeFile(
      path.join(dir, 'data-dog.ts'),
      [
        `import { datadogRum } from '@datadog/browser-rum';`,
        `import { datadogLogs } from '@datadog/browser-logs';`,
        '',
        'export function initDataDog() {',
        `  datadogRum.init({ applicationId: 'app', clientToken: 'token', service: 'soon-platform' });`,
        `  datadogLogs.init({ clientToken: 'token', service: 'ui' });`,
        `  const auditLogger = datadogLogs.createLogger('ui-audit', { handler: 'http', level: 'info' });`,
        '}',
        '',
        'export function logError(error: Error) {',
        '  datadogRum.addError(error, { source: "app" });',
        '}',
        '',
      ].join('\n')
    );

    // Mirrors the real mobile-ui shape (DdSdkReactNative initialize + DdLogs calls).
    await fs.writeFile(
      path.join(dir, 'datadog-mobile.ts'),
      [
        // Multi-line import, exactly like the real mobile-ui common/datadog/index.ts.
        'import {',
        '  DdSdkReactNative,',
        '  DdSdkReactNativeConfiguration,',
        '  DdLogs',
        `} from '@datadog/mobile-react-native';`,
        '',
        'export async function init() {',
        `  const config = new DdSdkReactNativeConfiguration('token', 'env', 'app', true, true, true);`,
        '  await DdSdkReactNative.initialize(config);',
        '}',
        '',
        'export function logError(error: Error) {',
        '  DdLogs.error(error.message, error);',
        '}',
        '',
      ].join('\n')
    );

    const analyzer = new ObservabilityAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true, 'canAnalyze should detect Datadog SDK dependencies');

    const contribution = await analyzer.analyze({ projectPath: dir });
    const { nodes } = contribution;

    assert.ok(nodes.find(node => (node.metadata as any)?.identifier === 'dd-rum-init'), 'expected datadogRum.init node');
    assert.ok(nodes.find(node => (node.metadata as any)?.identifier === 'dd-logs-init'), 'expected datadogLogs.init node');
    assert.ok(nodes.find(node => node.type === 'logger' && (node.metadata as any)?.identifier === 'ui-audit'), 'expected named browser logger node');
    assert.ok(nodes.find(node => (node.metadata as any)?.operation === 'error capture'), 'expected datadogRum.addError capture node');
    assert.ok(nodes.find(node => (node.metadata as any)?.identifier === 'dd-rn-init'), 'expected DdSdkReactNative.initialize node');
    assert.ok(nodes.find(node => node.type === 'logger' && (node.metadata as any)?.identifier === 'dd-rn-log-call'), 'expected DdLogs call node');
    assert.ok(
      contribution.libraries?.some(library => library.category === 'observability' && library.name.startsWith('@datadog/browser-')),
      'expected Datadog browser library inventory'
    );
  } finally {
    await fs.remove(dir);
  }
});

test('ObservabilityAnalyzer gates bare logger and metric calls on import evidence', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'observability-analyzer-negative-'));
  try {
    await fs.writeFile(
      path.join(dir, 'plain.ts'),
      [
        'const logger = { error() {} };',
        'const requests = { inc() {} };',
        'logger.error("not structured logging evidence");',
        'requests.inc();',
        '',
      ].join('\n')
    );

    const analyzer = new ObservabilityAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: dir });
    assert.equal(contribution.nodes.length, 0, 'expected no observability facts without import evidence');
    assert.equal(contribution.edges.length, 0, 'expected no instrumentation edges without import evidence');
  } finally {
    await fs.remove(dir);
  }
});
