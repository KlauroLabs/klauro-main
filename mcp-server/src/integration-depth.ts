import type { CASOutput } from '../../backend/src/types/cas.types';

type IntegrationCategory = 'queue' | 'message-broker' | 'auth' | 'payments' | 'ai-sdk' | 'infrastructure' | 'observability' | 'cache' | 'database';
type IntegrationStatus = 'covered' | 'partial' | 'missing-depth';

interface IntegrationRule {
  category: IntegrationCategory;
  label: string;
  packages: string[];
  keywords: string[];
  expected: string[];
}

interface IntegrationEvidence {
  kind: 'dependency' | 'library' | 'framework' | 'node' | 'entry_point' | 'exit_point' | 'external_service' | 'configuration' | 'runtime_link';
  value: string;
  file?: string;
  line?: number;
  confidence: number;
}

interface IntegrationDepthRow {
  id: string;
  category: IntegrationCategory;
  label: string;
  status: IntegrationStatus;
  score: number;
  detected: boolean;
  evidence: IntegrationEvidence[];
  found_surfaces: string[];
  missing_surfaces: string[];
  recommended_analyzers: string[];
}

const RULES: IntegrationRule[] = [
  rule('queue', 'Background jobs', ['bull', 'bullmq', 'bee-queue', 'agenda', 'celery', 'rq', 'sidekiq', 'resque', 'hangfire', 'apscheduler', 'cron', 'node-cron'], ['queue', 'job', 'worker', 'schedule', 'cron'], ['job producers', 'job handlers', 'schedule entries', 'retry/error behavior']),
  rule('message-broker', 'Message brokers', ['kafka', 'kafkajs', 'amqplib', 'rabbitmq', 'nats', '@aws-sdk/client-sqs', '@aws-sdk/client-sns', '@google-cloud/pubsub'], ['broker', 'topic', 'queue', 'publish', 'subscribe', 'consumer', 'producer', 'exchange', 'routing key'], ['message producers', 'message consumers', 'message schemas', 'broker resources']),
  rule('auth', 'Authentication and authorization', ['passport', 'jsonwebtoken', 'jwks-rsa', 'next-auth', '@auth/core', '@clerk/clerk-sdk-node', '@clerk/nextjs', 'firebase-admin', '@supabase/supabase-js', 'django-allauth', 'fastapi-users', 'oauthlib', 'spring-security'], ['auth', 'login', 'jwt', 'oauth', 'guard', 'permission', 'session', 'role'], ['identity provider', 'guards/middleware', 'protected entry points', 'roles and permissions']),
  rule('payments', 'Payments', ['stripe', '@stripe/stripe-js', 'braintree', '@paypal/checkout-server-sdk', 'square', '@adyen/api-library'], ['payment', 'checkout', 'invoice', 'subscription', 'webhook', 'refund'], ['payment SDK calls', 'webhook entry points', 'billing data entities', 'idempotency and retry behavior']),
  rule('ai-sdk', 'AI SDKs', ['openai', '@ai-sdk/openai', 'ai', 'anthropic', '@anthropic-ai/sdk', 'langchain', 'llamaindex', 'cohere-ai', 'cohere'], ['openai', 'anthropic', 'prompt', 'completion', 'embedding', 'agent', 'llm', 'vector'], ['model providers', 'prompt flows', 'tool calls', 'token-sensitive boundaries']),
  rule('infrastructure', 'Infrastructure as code and deployment', ['terraform', 'pulumi', 'serverless', 'sst', 'aws-cdk-lib', 'constructs'], ['docker-compose', 'kubernetes', 'helm', 'fly.toml', 'render.yaml', 'vercel.json', 'netlify.toml', 'terraform', 'pulumi', 'serverless'], ['deployment files', 'environment services', 'runtime dependencies', 'health checks']),
  rule('observability', 'Observability', ['@opentelemetry/api', '@opentelemetry/sdk-node', '@sentry/node', '@sentry/nextjs', 'dd-trace', 'newrelic', 'prom-client'], ['sentry', 'opentelemetry', 'trace', 'span', 'metric', 'log', 'monitoring', 'health'], ['tracing setup', 'metrics endpoints', 'error capture', 'runtime correlation']),
  rule('cache', 'Cache and key-value stores', ['redis', 'ioredis', '@redis/client', 'memcached', 'node-cache'], ['cache', 'redis', 'memcached', 'ttl', 'invalidate'], ['cache clients', 'cache keys', 'read/write operations', 'invalidation paths']),
  rule('database', 'Database and persistence', ['prisma', '@prisma/client', 'typeorm', 'mikro-orm', '@mikro-orm/core', 'sequelize', 'mongoose', 'knex', 'pg', 'mysql2', 'sqlite3', 'sqlalchemy', 'django'], ['database', 'repository', 'entity', 'model', 'schema', 'migration', 'query'], ['data schema', 'CRUD lifecycle', 'repository calls', 'migration/config evidence']),
];

export function getIntegrationDepthReport(cas: CASOutput) {
  const evidence = collectEvidence(cas);
  const rows = RULES.map(integration => evaluateRule(cas, integration, evidence));
  const detected = rows.filter(row => row.detected);
  const relevantRows = detected.length > 0 ? detected : rows.filter(row => row.evidence.length > 0);
  const score = relevantRows.length
    ? Math.round(relevantRows.reduce((sum, row) => sum + row.score, 0) / relevantRows.length)
    : 100;

  return {
    generated_at: new Date().toISOString(),
    status: score >= 90 ? 'covered' : score >= 70 ? 'partial' : 'missing-depth',
    score,
    detected_integrations: detected.length,
    integrations: rows,
    missing_depth: rows
      .filter(row => row.detected && row.status !== 'covered')
      .flatMap(row => row.missing_surfaces.map(surface => `${row.label}: ${surface}`)),
    recommended_mcp_followups: [
      'get_external_services',
      'get_exit_points',
      'get_entry_points',
      'get_runtime_instrumentation_plan',
      'get_analysis_facts',
    ],
  };
}

function evaluateRule(cas: CASOutput, integration: IntegrationRule, allEvidence: IntegrationEvidence[]): IntegrationDepthRow {
  const evidence = allEvidence.filter(item => matchesIntegration(item.value, integration));
  const foundSurfaces = foundSurfacesFor(cas, integration, evidence);
  const expectedCount = integration.expected.length;
  const score = evidence.length === 0
    ? 100
    : Math.round(((foundSurfaces.length / Math.max(1, expectedCount)) * 70) + Math.min(30, evidence.length * 5));
  const missingSurfaces = integration.expected.filter(surface => !surfaceCovered(surface, foundSurfaces));

  return {
    id: slugify(`${integration.category}-${integration.label}`),
    category: integration.category,
    label: integration.label,
    status: evidence.length === 0 ? 'covered' : score >= 90 ? 'covered' : score >= 70 ? 'partial' : 'missing-depth',
    score: evidence.length === 0 ? 100 : Math.min(100, score),
    detected: evidence.length > 0,
    evidence: evidence.slice(0, 25),
    found_surfaces: foundSurfaces,
    missing_surfaces: evidence.length === 0 ? [] : missingSurfaces,
    recommended_analyzers: evidence.length === 0 || missingSurfaces.length === 0
      ? []
      : [`${integration.category} analyzer`, `${integration.label.toLowerCase()} contract extractor`],
  };
}

function collectEvidence(cas: CASOutput): IntegrationEvidence[] {
  const evidence: IntegrationEvidence[] = [];
  for (const dependency of cas.dependencies?.packages || []) {
    evidence.push({ kind: 'dependency', value: dependency.name, confidence: dependency.direct ? 0.95 : 0.75 });
  }
  for (const library of cas.libraries || []) {
    evidence.push({ kind: 'library', value: library.name, confidence: 0.9 });
    for (const pattern of library.usage_patterns || []) {
      evidence.push({ kind: 'library', value: `${library.name} ${pattern.pattern || ''}`, confidence: 0.82 });
    }
  }
  for (const framework of cas.system?.technologies?.frameworks || []) {
    evidence.push({ kind: 'framework', value: framework.name, confidence: framework.confidence || 0.8 });
  }
  for (const file of cas.configuration?.config_files || []) {
    if (file.path) evidence.push({ kind: 'configuration', value: file.path, confidence: 0.85 });
  }
  for (const service of cas.configuration?.required_services || []) {
    if (service.service) evidence.push({ kind: 'configuration', value: service.service, confidence: 0.85 });
  }
  for (const service of cas.external_services || []) {
    evidence.push({ kind: 'external_service', value: [service.name, service.type, service.provider].filter(Boolean).join(' '), confidence: 0.85 });
  }
  for (const node of cas.nodes || []) {
    evidence.push({
      kind: 'node',
      value: [node.name, node.type, node.qualified_name, node.source?.file, node.metadata?.framework, ...(node.tags || [])].filter(Boolean).join(' '),
      file: node.source?.file,
      line: node.source?.line,
      confidence: 0.65,
    });
  }
  for (const entry of cas.entry_points || []) {
    evidence.push({ kind: 'entry_point', value: [entry.name, entry.type, entry.trigger?.path, entry.trigger?.event].filter(Boolean).join(' '), file: entry.handler?.file, line: entry.handler?.line, confidence: 0.8 });
  }
  for (const exitPoint of cas.exit_points || []) {
    evidence.push({ kind: 'exit_point', value: [exitPoint.name, exitPoint.type, exitPoint.target?.sdk, exitPoint.target?.service_id, exitPoint.target?.endpoint, exitPoint.target?.resource].filter(Boolean).join(' '), confidence: 0.8 });
  }
  for (const link of cas.runtime_static_links || []) {
    evidence.push({ kind: 'runtime_link', value: [link.runtime_signal, link.kind, link.telemetry_status].filter(Boolean).join(' '), confidence: link.confidence || 0.75 });
  }
  return evidence.filter(item => item.value.trim().length > 0);
}

function foundSurfacesFor(cas: CASOutput, integration: IntegrationRule, evidence: IntegrationEvidence[]): string[] {
  const found = new Set<string>();
  if (evidence.some(item => item.kind === 'dependency' || item.kind === 'library')) found.add('dependency/library evidence');
  if ((cas.entry_points || []).some(entry => entrySurfaceMatches(entry.type, entry.name, integration))) found.add('entry points');
  if ((cas.exit_points || []).some(exitPoint => exitSurfaceMatches(exitPoint.type, exitPoint.name, integration))) found.add('exit points');
  if ((cas.external_services || []).some(service => matchesIntegration(`${service.name} ${service.type} ${service.provider || ''}`, integration))) found.add('external services');
  if ((cas.runtime_static_links || []).some(link => matchesIntegration(`${link.runtime_signal} ${link.kind}`, integration))) found.add('runtime correlation');
  if (cas.analysis_facts?.length) found.add('evidence facts');
  if (integration.category === 'database' && ((cas.database_schema?.entities?.length || 0) > 0 || (cas.data_entities?.length || 0) > 0)) found.add('data schema');
  if (integration.category === 'auth' && (cas.security_boundaries?.length || cas.security_summary)) found.add('security boundaries');
  if (integration.category === 'infrastructure' && ((cas.configuration?.config_files?.length || 0) > 0 || Boolean(cas.runtime?.deployment))) found.add('deployment/configuration');
  return Array.from(found).sort();
}

function entrySurfaceMatches(type: string, name: string, integration: IntegrationRule): boolean {
  if (integration.category === 'queue' && (type === 'schedule' || type === 'message' || type === 'event')) return true;
  if (integration.category === 'message-broker' && (type === 'message' || type === 'event')) return true;
  if (integration.category === 'payments' && type === 'websocket') return false;
  return matchesIntegration(name, integration);
}

function exitSurfaceMatches(type: string, name: string, integration: IntegrationRule): boolean {
  if (integration.category === 'message-broker' && (type === 'message' || type === 'event')) return true;
  if (integration.category === 'cache' && type === 'cache') return true;
  if (integration.category === 'database' && type === 'database') return true;
  if (integration.category === 'ai-sdk' && type === 'sdk') return true;
  return matchesIntegration(name, integration);
}

function surfaceCovered(expected: string, found: string[]): boolean {
  const lowerExpected = expected.toLowerCase();
  return found.some(surface => {
    const lowerSurface = surface.toLowerCase();
    return lowerExpected.includes(lowerSurface) || lowerSurface.includes(lowerExpected.split(' ')[0]);
  });
}

function matchesIntegration(value: string, integration: IntegrationRule): boolean {
  const lower = value.toLowerCase();
  return [...integration.packages, ...integration.keywords].some(candidate => {
    const token = candidate.toLowerCase();
    return lower === token || lower.includes(token);
  });
}

function rule(category: IntegrationCategory, label: string, packages: string[], keywords: string[], expected: string[]): IntegrationRule {
  return { category, label, packages, keywords, expected };
}

function slugify(input: string): string {
  return input
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .substring(0, 80);
}
