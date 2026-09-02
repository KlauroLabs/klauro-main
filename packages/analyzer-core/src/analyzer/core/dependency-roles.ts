
































import { CASDependencyManifest, CASDependencyRole, CASDependencyRoleKind, CASExitPoint } from '../../types/cas.types';

function normalizePackageToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function looseMatch(a: string, b: string): boolean {
  const na = normalizePackageToken(a);
  const nb = normalizePackageToken(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

























const KNOWN_PACKAGE_ROLES: Record<CASDependencyRoleKind, string[]> = {
  'http-client': [],
  'message-broker': [],
  'database-driver': [
    'pg', 'postgres', 'mysql2', 'mysql', 'sqlite3', 'pymongo', 'mongodb',
    'psycopg2', 'psycopg', 'mariadb', 'oracledb', 'cassandra-driver',
    'go-sql-driver/mysql', 'lib/pq', 'database/sql', 'mongo-driver',
    'jdbc', 'npgsql', 'mysql-connector-python', 'rusqlite', 'sqlx',
  ],
  'orm': [
    'typeorm', 'sequelize', 'prisma', 'mongoose', 'sqlalchemy',
    'django.db', 'activerecord', 'hibernate', 'entityframeworkcore',
    'gorm.io/gorm', 'diesel', 'ecto', 'doctrine/orm', 'drizzle-orm',
  ],
  'cache': [
    'redis', 'ioredis', 'memcached', 'node-cache', 'django-redis',
    'go-redis/redis', 'stackexchange.redis', 'redis-py',
  ],
  'observability': [
    '@opentelemetry/api', 'opentelemetry', 'opentelemetry-sdk', 'dd-trace',
    '@sentry/node', '@sentry/browser', 'sentry-sdk', 'prom-client',
    'hot-shots', 'micrometer-core', 'newrelic', 'rollbar', '@bugsnag/js',
  ],
  'auth': [
    'passport', 'passport-jwt', 'jsonwebtoken', 'pyjwt', 'devise',
    'django.contrib.auth', 'spring-security-core', 'warden', 'jwt-go',
    'golang-jwt/jwt', 'auth0', '@okta/okta-sdk-nodejs',
  ],
  'realtime': ['socket.io', 'ws', 'signalr', 'actioncable', 'pusher'],
  'graphql-client': ['@apollo/client', 'urql', 'graphql-request', 'graphql'],
  'workflow': ['temporal', 'celery', 'airflow', 'sidekiq', 'bullmq'],
  'other': [],
};

interface ExitPointHint {
  role: CASDependencyRoleKind;
  name: string;
  exitId: string;
}

function extractExitPointHints(exitPoints: CASExitPoint[]): ExitPointHint[] {
  const hints: ExitPointHint[] = [];
  for (const exit of exitPoints) {
    const metadata = exit.metadata || {};
    if (exit.type === 'api' && typeof metadata.library === 'string' && metadata.library) {
      hints.push({ role: 'http-client', name: metadata.library, exitId: exit.id });
    }
    if ((exit.type === 'message' || exit.type === 'event') && typeof metadata.system === 'string' && metadata.system) {
      hints.push({ role: 'message-broker', name: metadata.system, exitId: exit.id });
    }
  }
  return hints;
}

export function deriveDependencyRoles(
  dependencyManifest: CASDependencyManifest | undefined,
  exitPoints: CASExitPoint[],
): CASDependencyRole[] {
  if (!dependencyManifest || dependencyManifest.dependencies.length === 0) return [];

  const hints = extractExitPointHints(exitPoints);
  const roles: CASDependencyRole[] = [];

  for (const dependency of dependencyManifest.dependencies) {
    const matchingHints = hints.filter(hint => looseMatch(dependency.name, hint.name));
    if (matchingHints.length > 0) {
      const role = matchingHints[0].role;
      const exitIds = [...new Set(matchingHints.map(h => h.exitId))];
      roles.push({
        name: dependency.name,
        ecosystem: dependency.ecosystem,
        role,
        confidence: 0.9,
        evidence: exitIds.map(id => `exit_point:${id}`),
        source: 'exit-point-evidence',
      });
      continue;
    }

    let matchedRole: CASDependencyRoleKind | undefined;
    for (const [role, packages] of Object.entries(KNOWN_PACKAGE_ROLES) as Array<[CASDependencyRoleKind, string[]]>) {
      if (packages.some(pkg => looseMatch(dependency.name, pkg))) {
        matchedRole = role;
        break;
      }
    }
    if (matchedRole) {
      roles.push({
        name: dependency.name,
        ecosystem: dependency.ecosystem,
        role: matchedRole,
        confidence: 0.6,
        evidence: [`known-package-list:${matchedRole}`],
        source: 'known-package-list',
      });
    }
  }

  return roles;
}
