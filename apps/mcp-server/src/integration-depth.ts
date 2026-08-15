import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

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
  unobserved_surfaces: string[];
  recommended_analyzers: string[];
}

const RULES: IntegrationRule[] = [
  rule('queue', 'Background jobs', ['bull', 'bullmq', 'bee-queue', 'agenda', 'celery', 'rq', 'sidekiq', 'resque', 'hangfire', 'apscheduler', 'cron', 'node-cron'], ['worker', 'scheduler', 'schedule', 'cron', 'enqueue'], ['job producers', 'job handlers', 'schedule entries', 'retry/error behavior']),
  rule('message-broker', 'Message brokers', ['kafka', 'kafkajs', 'amqplib', 'rabbitmq', 'nats', '@aws-sdk/client-sqs', '@aws-sdk/client-sns', '@google-cloud/pubsub'], ['broker', 'topic', 'consumer', 'producer', 'routing key', 'sqs', 'sns', 'pubsub'], ['message producers', 'message consumers', 'message schemas', 'broker resources']),
  rule('auth', 'Authentication and authorization', ['passport', 'jsonwebtoken', 'jwks-rsa', 'next-auth', '@auth/core', '@clerk/clerk-sdk-node', '@clerk/nextjs', 'firebase-admin', '@supabase/supabase-js', 'django-allauth', 'fastapi-users', 'oauthlib', 'spring-security', 'auth0'], ['auth', 'login', 'jwt', 'oauth', 'guard'], ['identity provider', 'guards/middleware', 'protected entry points', 'roles and permissions']),
  rule('payments', 'Payments', ['stripe', '@stripe/stripe-js', 'braintree', '@paypal/checkout-server-sdk', 'square', '@adyen/api-library'], ['payment', 'checkout', 'invoice', 'billing', 'stripe', 'webhook', 'refund'], ['payment SDK calls', 'webhook entry points', 'billing data entities', 'idempotency and retry behavior']),
  rule('ai-sdk', 'AI SDKs', ['openai', '@ai-sdk/openai', 'ai', 'anthropic', '@anthropic-ai/sdk', 'langchain', 'llamaindex', 'cohere-ai', 'cohere'], ['openai', 'anthropic', 'prompt', 'completion', 'embedding', 'llm', 'vector'], ['model providers', 'prompt flows', 'tool calls', 'token-sensitive boundaries']),
  rule('infrastructure', 'Infrastructure as code and deployment', ['terraform', 'pulumi', 'serverless', 'sst', 'aws-cdk-lib', 'constructs'], ['docker-compose', 'kubernetes', 'helm', 'fly.toml', 'render.yaml', 'vercel.json', 'netlify.toml', 'terraform', 'pulumi', 'serverless'], ['deployment files', 'environment services', 'runtime dependencies', 'health checks']),
  rule('observability', 'Observability', ['@opentelemetry/api', '@opentelemetry/sdk-node', '@sentry/node', '@sentry/nextjs', 'dd-trace', 'newrelic', 'prom-client'], ['sentry', 'opentelemetry', 'trace', 'span', 'metric', 'log', 'monitoring', 'health'], ['tracing setup', 'metrics endpoints', 'error capture', 'runtime correlation']),
  rule('cache', 'Cache and key-value stores', ['redis', 'ioredis', '@redis/client', 'memcached', 'node-cache'], ['cache', 'redis', 'memcached', 'ttl', 'invalidate'], ['cache clients', 'cache keys', 'read/write operations', 'invalidation paths']),
  rule('database', 'Database and persistence', ['prisma', '@prisma/client', 'typeorm', 'mikro-orm', '@mikro-orm/core', 'sequelize', 'mongoose', 'knex', 'pg', 'mysql2', 'sqlite3', 'sqlalchemy', 'django'], ['database', 'repository', 'entity', 'migration', 'sql', 'db'], ['data schema', 'CRUD lifecycle', 'repository calls', 'migration/config evidence']),
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
    status: score >= 90 ? 'covered' : score >= 40 ? 'partial' : 'missing-depth',
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
  const detected = hasStrongIntegrationDetection(cas, integration, evidence);
  const coveredSurfaces = integration.expected.filter(surface => surfaceCovered(surface, foundSurfaces));
  const applicableSurfaces = integration.expected.filter(surface =>
    surfaceCovered(surface, foundSurfaces) || surfaceApplicable(cas, integration, surface, evidence)
  );
  const missingSurfaces = applicableSurfaces.filter(surface => !coveredSurfaces.includes(surface));
  const unobservedSurfaces = integration.expected.filter(surface =>
    !coveredSurfaces.includes(surface) && !applicableSurfaces.includes(surface)
  );
  const expectedCount = applicableSurfaces.length || coveredSurfaces.length || 1;
  const score = !detected
    ? 100
    : missingSurfaces.length === 0
      ? 100
    : Math.round(((coveredSurfaces.length / Math.max(1, expectedCount)) * 80) + Math.min(20, evidence.length * 4));

  return {
    id: slugify(`${integration.category}-${integration.label}`),
    category: integration.category,
    label: integration.label,
    status: !detected ? 'covered' : score >= 90 ? 'covered' : score >= 40 ? 'partial' : 'missing-depth',
    score: !detected ? 100 : Math.min(100, score),
    detected,
    evidence: evidence.slice(0, 25),
    found_surfaces: foundSurfaces.sort(),
    missing_surfaces: !detected ? [] : missingSurfaces,
    unobserved_surfaces: !detected ? [] : unobservedSurfaces,
    recommended_analyzers: !detected || missingSurfaces.length === 0
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
  const evidenceText = evidence.map(item => item.value).join(' ').toLowerCase();
  if (evidence.some(item => item.kind === 'dependency' || item.kind === 'library')) found.add('dependency/library evidence');
  const matchingEntries = (cas.entry_points || []).filter(entry => entrySurfaceMatches(entry.type, entry.name, integration));
  const matchingExits = (cas.exit_points || []).filter(exitPoint => exitSurfaceMatches(exitPoint.type, exitPoint.name, integration));
  if (matchingEntries.length > 0) found.add('entry points');
  if (matchingExits.length > 0) found.add('exit points');
  if ((cas.external_services || []).some(service => matchesIntegration(`${service.name} ${service.type} ${service.provider || ''}`, integration))) found.add('external services');
  if ((cas.runtime_static_links || []).some(link => matchesIntegration(`${link.runtime_signal} ${link.kind}`, integration))) found.add('runtime correlation');
  if (cas.analysis_facts?.length) found.add('evidence facts');

  switch (integration.category) {
    case 'queue':
      if (matchingEntries.some(entry => entry.type === 'schedule') || /\b(beat_schedule|cron|schedule|scheduler)\b/.test(evidenceText)) found.add('schedule entries');
      if (matchingEntries.some(entry => entry.type === 'schedule' || entry.type === 'message' || entry.type === 'event') || /\b(worker|job handler|scheduler|cron|bull|bullmq|celery|rq|sidekiq|hangfire)\b/.test(evidenceText)) found.add('job handlers');
      if (matchingExits.some(exitPoint => exitPoint.type === 'message' || exitPoint.type === 'event') || /\b(enqueue|dispatch|publish|producer|bull|bullmq|celery|rq|sidekiq|hangfire)\b/.test(evidenceText)) found.add('job producers');
      if (/\b(retry|dead.?letter|backoff|timeout|failure|error)\b/.test(evidenceText) || matchingExits.some(exitPoint => exitPoint.reliability?.retry_attempts)) found.add('retry/error behavior');
      break;
    case 'message-broker':
      if (matchingExits.some(exitPoint => exitPoint.type === 'message' || exitPoint.type === 'event') || /\b(publish|producer|send message)\b/.test(evidenceText)) found.add('message producers');
      if (matchingEntries.some(entry => entry.type === 'message' || entry.type === 'event') || /\b(subscribe|consumer|listener|handler)\b/.test(evidenceText)) found.add('message consumers');
      if (matchingEntries.some(entry => Boolean(entry.input?.schema || entry.input?.type)) || matchingExits.some(exitPoint => Boolean(exitPoint.data?.input_type || exitPoint.data?.output_type))) found.add('message schemas');
      if (matchingExits.some(exitPoint => Boolean(exitPoint.target?.resource || exitPoint.target?.service_id)) || /\b(topic|queue|routing key|broker|sqs|sns|kafka|rabbitmq|nats)\b/.test(evidenceText)) found.add('broker resources');
      break;
    case 'auth':
      if (/\b(clerk|supabase|oauth|jwt|passport|firebase|next-auth|auth0)\b/.test(evidenceText)) found.add('identity provider');
      if ((cas.security_boundaries?.length || 0) > 0 || /\b(guard|middleware|permission|policy)\b/.test(evidenceText)) found.add('guards/middleware');
      if ((cas.entry_points || []).some(entry => entry.security?.authenticated || entry.security?.authorized_roles?.length || entry.security?.guards?.length) || (cas.security_boundaries?.length || 0) > 0) found.add('protected entry points');
      if (!found.has('identity provider') && /\b(auth|login|logout|session|password|credential|token|bearer)\b/.test(evidenceText)) found.add('identity provider');
      if ((cas.entry_points || []).some(entry => entry.security?.roles?.length || entry.security?.permissions?.length || entry.security?.authorized_roles?.length) || /\b(role|permission|policy|rbac|admin)\b/.test(evidenceText)) found.add('roles and permissions');
      break;
    case 'payments':
      const hasPaymentSdk = /\b(stripe|braintree|paypal|adyen|square)\b/.test(evidenceText) || matchingExits.some(exitPoint => /\b(stripe|braintree|paypal|adyen|square|payment|checkout)\b/i.test(`${exitPoint.name} ${exitPoint.target?.sdk || ''} ${exitPoint.target?.service_id || ''}`));
      if (hasPaymentSdk) found.add('payment SDK calls');
      if (matchingEntries.some(entry => /webhook/i.test(`${entry.name} ${entry.trigger?.path || ''}`))) found.add('webhook entry points');
      if (hasPaymentSdk && [...(cas.database_schema?.entities || []), ...(cas.entities || [])].some(entity => /\b(payment|invoice|subscription|billing|checkout|refund)\b/i.test(entity.name))) found.add('billing data entities');
      if (/\b(idempot|retry|refund|webhook secret|signature)\b/.test(evidenceText) || matchingExits.some(exitPoint => Boolean(exitPoint.reliability?.retry_attempts))) found.add('idempotency and retry behavior');
      break;
    case 'ai-sdk':
      if (/\b(openai|anthropic|cohere|llama|langchain|model|embedding)\b/.test(evidenceText)) found.add('model providers');
      if (/\b(prompt|completion|embedding|chat|response|agent)\b/.test(evidenceText)) found.add('prompt flows');
      if (/\b(tool|function call|function_call|tool_call|agent action)\b/.test(evidenceText)) found.add('tool calls');
      if (/\b(token|usage|cost|rate limit|context window)\b/.test(evidenceText)) found.add('token-sensitive boundaries');
      break;
    case 'infrastructure':
      if ((cas.configuration?.config_files || []).some(file => /\b(docker|compose|kubernetes|helm|fly\.toml|render\.yaml|vercel\.json|netlify\.toml|terraform|pulumi|serverless)\b/i.test(file.path || ''))) found.add('deployment files');
      if (evidence.length > 0 && ((cas.configuration?.required_services || []).length || (cas.external_services || []).length || /\b(env|service|database|redis|postgres|container)\b/.test(evidenceText))) found.add('environment services');
      if (Boolean(cas.runtime?.deployment) || /\b(runtime|container|docker|node|python|java|postgres|redis|kubernetes|terraform|pulumi)\b/.test(evidenceText)) found.add('runtime dependencies');
      if ((cas.entry_points || []).some(entry => /\b(health|ready|live|status|metrics)\b/i.test(`${entry.name} ${entry.trigger?.path || ''}`))) found.add('health checks');
      break;
    case 'observability':
      if (/\b(opentelemetry|trace|tracer|instrument)\b/.test(evidenceText)) found.add('tracing setup');
      if ((cas.entry_points || []).some(entry => /\b(metrics|monitor)\b/i.test(`${entry.name} ${entry.trigger?.path || ''}`)) || /\b(prometheus|metric|counter|histogram|gauge)\b/.test(evidenceText)) found.add('metrics endpoints');
      if (/\b(sentry|error capture|exception|logger|logging|log error)\b/.test(evidenceText)) found.add('error capture');
      if ((cas.runtime_static_links || []).length > 0) found.add('runtime correlation');
      break;
    case 'cache':
      if (/\b(redis|memcached|cache client|ioredis|node-cache)\b/.test(evidenceText) || (cas.external_services || []).some(service => /redis|cache|memcached/i.test(`${service.name} ${service.type}`))) found.add('cache clients');
      if (/\b(cache key|cachekey|key prefix|ttl)\b/.test(evidenceText) || matchingExits.some(exitPoint => Boolean(exitPoint.target?.resource))) found.add('cache keys');
      if (matchingExits.some(exitPoint => exitPoint.type === 'cache') || /\b(cache\.get|cache\.set|redis\.get|redis\.set|hget|hset|lpush|rpop)\b/.test(evidenceText)) found.add('read/write operations');
      if (/\b(invalidate|evict|expire|delete cache|cache\.del|redis\.del|ttl)\b/.test(evidenceText)) found.add('invalidation paths');
      break;
    case 'database':
      if ((cas.database_schema?.entities?.length || 0) > 0) found.add('data schema');
      if ((cas.entities || []).some(entity => Object.values(entity.lifecycle || {}).some(nodes => nodes.length > 0)) || matchingExits.some(exitPoint => exitPoint.type === 'database')) found.add('CRUD lifecycle');
      if (matchingExits.some(exitPoint => exitPoint.type === 'database') || (cas.nodes || []).some(node => node.type === 'repository' || node.subcategories?.includes('repository')) || /\b(repository|asyncsession|sessionmaker|get_db|db\.|database client|sqlalchemy|prisma|mongoose|knex|entitymanager)\b/.test(evidenceText)) found.add('repository calls');
      if ((cas.configuration?.config_files || []).some(file => /migration|prisma|schema\.prisma|alembic/i.test(file.path || '')) || (cas.nodes || []).some(node => /(^|\/)(migrations?|schema\.prisma|alembic)(\/|$)/i.test(node.source?.file || ''))) found.add('migration/config evidence');
      break;
  }

  return Array.from(found);
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

function surfaceApplicable(cas: CASOutput, integration: IntegrationRule, surface: string, evidence: IntegrationEvidence[]): boolean {
  const evidenceText = evidence.map(item => item.value).join(' ').toLowerCase();
  const entries = cas.entry_points || [];
  const exits = cas.exit_points || [];

  switch (integration.category) {
    case 'queue':
      if (surface === 'schedule entries') return /\b(beat_schedule|cron|schedule|scheduler)\b/.test(evidenceText) || entries.some(entry => entry.type === 'schedule');
      if (surface === 'retry/error behavior') return /\b(retry|dead.?letter|backoff|timeout|failure|error)\b/.test(evidenceText) || exits.some(exitPoint => Boolean(exitPoint.reliability?.retry_attempts));
      return true;
    case 'message-broker':
      if (surface === 'message producers') return /\b(publish|producer|send message)\b/.test(evidenceText) || exits.some(exitPoint => exitPoint.type === 'message' || exitPoint.type === 'event');
      if (surface === 'message consumers') return /\b(subscribe|consumer|listener|handler)\b/.test(evidenceText) || entries.some(entry => entry.type === 'message' || entry.type === 'event');
      if (surface === 'message schemas') return /\b(schema|payload|message type|contract)\b/.test(evidenceText) || entries.some(entry => Boolean(entry.input?.schema || entry.input?.type)) || exits.some(exitPoint => Boolean(exitPoint.data?.input_type || exitPoint.data?.output_type));
      if (surface === 'broker resources') return /\b(topic|queue|routing key|broker|sqs|sns|kafka|rabbitmq|nats)\b/.test(evidenceText) || exits.some(exitPoint => Boolean(exitPoint.target?.resource || exitPoint.target?.service_id));
      return true;
    case 'auth':
      if (surface === 'identity provider') return /\b(auth|login|logout|session|password|credential|token|bearer|oauth|jwt|passport|clerk|supabase|firebase|next-auth|auth0)\b/.test(evidenceText);
      if (surface === 'guards/middleware') return /\b(guard|middleware|policy|permission|auth)\b/.test(evidenceText) || (cas.security_boundaries?.length || 0) > 0;
      if (surface === 'protected entry points') return (cas.security_boundaries?.length || 0) > 0 || entries.some(entry => Boolean(entry.security?.authenticated || entry.security?.guards?.length || entry.security?.roles?.length || entry.security?.permissions?.length || entry.security?.authorized_roles?.length));
      if (surface === 'roles and permissions') return /\b(role|permission|policy|rbac|admin)\b/.test(evidenceText) || entries.some(entry => Boolean(entry.security?.roles?.length || entry.security?.permissions?.length || entry.security?.authorized_roles?.length));
      return true;
    case 'payments':
      if (surface === 'webhook entry points') return /\b(webhook)\b/.test(evidenceText) || entries.some(entry => /webhook/i.test(`${entry.name} ${entry.trigger?.path || ''}`));
      if (surface === 'billing data entities') return [...(cas.database_schema?.entities || []), ...(cas.entities || [])].some(entity => /\b(payment|invoice|subscription|billing|checkout|refund)\b/i.test(entity.name));
      if (surface === 'idempotency and retry behavior') return /\b(idempot|retry|refund|webhook secret|signature)\b/.test(evidenceText) || exits.some(exitPoint => Boolean(exitPoint.reliability?.retry_attempts));
      return true;
    case 'ai-sdk':
      if (surface === 'prompt flows') return /\b(prompt|completion|chat|response|agent)\b/.test(evidenceText);
      if (surface === 'tool calls') return /\b(tool|function call|function_call|tool_call|agent action)\b/.test(evidenceText);
      if (surface === 'token-sensitive boundaries') return /\b(token|usage|cost|rate limit|context window)\b/.test(evidenceText);
      return true;
    case 'observability':
      if (surface === 'tracing setup') return /\b(opentelemetry|trace|tracer|instrument)\b/.test(evidenceText);
      if (surface === 'metrics endpoints') return /\b(prometheus|metric|counter|histogram|gauge)\b/.test(evidenceText) || entries.some(entry => /\b(metrics|monitor)\b/i.test(`${entry.name} ${entry.trigger?.path || ''}`));
      if (surface === 'error capture') return /\b(sentry|error capture|exception|logger|logging|log error)\b/.test(evidenceText);
      if (surface === 'runtime correlation') return (cas.runtime_static_links || []).length > 0;
      return true;
    case 'cache':
      if (surface === 'cache clients') return /\b(redis|memcached|cache client|ioredis|node-cache)\b/.test(evidenceText);
      if (surface === 'cache keys') return /\b(cache key|cachekey|key prefix|ttl)\b/.test(evidenceText) || exits.some(exitPoint => Boolean(exitPoint.target?.resource));
      if (surface === 'read/write operations') return exits.some(exitPoint => exitPoint.type === 'cache') || /\b(cache\.get|cache\.set|redis\.get|redis\.set|hget|hset|lpush|rpop)\b/.test(evidenceText);
      if (surface === 'invalidation paths') return /\b(invalidate|evict|expire|delete cache|cache\.del|redis\.del|ttl)\b/.test(evidenceText);
      return true;
    case 'database':
      if (surface === 'data schema') return (cas.database_schema?.entities?.length || 0) > 0 || /\b(entity|model|schema)\b/.test(evidenceText);
      if (surface === 'CRUD lifecycle') return (cas.entities || []).some(entity => Object.values(entity.lifecycle || {}).some(nodes => nodes.length > 0)) || exits.some(exitPoint => exitPoint.type === 'database') || /\b(create|read|update|delete|insert|select|query|save|session)\b/.test(evidenceText);
      if (surface === 'repository calls') return exits.some(exitPoint => exitPoint.type === 'database') || (cas.nodes || []).some(node => node.type === 'repository' || node.subcategories?.includes('repository')) || /\b(repository|asyncsession|sessionmaker|get_db|db\.|database client|sqlalchemy|prisma|mongoose|knex|entitymanager)\b/.test(evidenceText);
      if (surface === 'migration/config evidence') return (cas.configuration?.config_files || []).some(file => /migration|prisma|schema\.prisma|alembic/i.test(file.path || '')) || (cas.nodes || []).some(node => /(^|\/)(migrations?|schema\.prisma|alembic)(\/|$)/i.test(node.source?.file || ''));
      return true;
    case 'infrastructure':
      return true;
  }
}

function hasStrongIntegrationDetection(cas: CASOutput, integration: IntegrationRule, evidence: IntegrationEvidence[]): boolean {
  const evidenceText = evidence.map(item => item.value).join(' ').toLowerCase();
  const dependencies = evidence.filter(item => item.kind === 'dependency' || item.kind === 'library');
  const external = evidence.filter(item => item.kind === 'external_service');

  switch (integration.category) {
    case 'queue':
      return /\b(bull|bullmq|bee-queue|agenda|celery|rq|sidekiq|resque|hangfire|apscheduler|node-cron|beat_schedule)\b/.test(evidenceText) ||
        (cas.entry_points || []).some(entry => entry.type === 'schedule' || entry.type === 'message');
    case 'message-broker':
      return /\b(kafka|kafkajs|amqplib|rabbitmq|nats|sqs|sns|pubsub|topic|broker)\b/.test(evidenceText) ||
        (cas.entry_points || []).some(entry => entry.type === 'message' || entry.type === 'event') ||
        (cas.exit_points || []).some(exitPoint => exitPoint.type === 'message' || exitPoint.type === 'event');
    case 'auth':
      return (cas.security_boundaries?.length || 0) > 0 ||
        (cas.entry_points || []).some(entry => Boolean(entry.security?.authenticated || entry.security?.guards?.length || entry.security?.roles?.length || entry.security?.permissions?.length || entry.security?.authorized_roles?.length)) ||
        /\b(auth0|clerk|supabase|oauth|jwt|passport|next-auth|spring-security|firebase-admin|fastapi-users)\b/.test(evidenceText);
    case 'payments':
      return /\b(stripe|braintree|paypal|adyen|square)\b/.test(evidenceText);
    case 'ai-sdk':
      return dependencies.length > 0 ||
        external.some(item => /\b(openai|anthropic|cohere|llm|embedding|ai_provider)\b/.test(item.value.toLowerCase())) ||
        /\b(openai|anthropic|cohere|langchain|llamaindex|llm|embedding)\b/.test(evidenceText);
    case 'infrastructure':
      return (cas.configuration?.config_files || []).some(file => /\b(docker|compose|kubernetes|helm|fly\.toml|render\.yaml|vercel\.json|netlify\.toml|terraform|pulumi|serverless)\b/i.test(file.path || '')) ||
        dependencies.length > 0;
    case 'observability':
      return /\b(opentelemetry|sentry|prometheus|prom-client|dd-trace|newrelic|metric|tracer)\b/.test(evidenceText) ||
        (cas.entry_points || []).some(entry => /\bmetrics\b/i.test(`${entry.name} ${entry.trigger?.path || ''}`));
    case 'cache':
      return /\b(redis|ioredis|memcached|node-cache)\b/.test(evidenceText) ||
        (cas.exit_points || []).some(exitPoint => exitPoint.type === 'cache');
    case 'database':
      return dependencies.length > 0 ||
        external.length > 0 ||
        (cas.exit_points || []).some(exitPoint => exitPoint.type === 'database') ||
        /\b(prisma|typeorm|mikro-orm|sequelize|mongoose|knex|sqlalchemy|django|postgres|pg|mysql|sqlite|database_url|asyncsession|sessionmaker|get_db|db\.|entitymanager)\b/.test(evidenceText);
  }
}

function matchesIntegration(value: string, integration: IntegrationRule): boolean {
  const lower = value.toLowerCase();
  return [...integration.packages, ...integration.keywords].some(candidate => {
    const token = candidate.toLowerCase();
    if (lower === token) return true;
    if (/^[a-z0-9][a-z0-9_-]*$/i.test(token)) {
      return new RegExp(`(^|[^a-z0-9])${escapeRegex(token)}($|[^a-z0-9])`, 'i').test(lower);
    }
    return lower.includes(token);
  });
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
