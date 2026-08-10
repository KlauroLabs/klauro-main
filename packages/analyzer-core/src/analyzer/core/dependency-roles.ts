// Tier 2 GAP FIX — §6.3 of docs/analysis-scope/SPECIFICATION.md ("Library
// and dependency roles"). dependency_manifest (Tier 1 fact, see its own doc
// comment) MUST NOT carry interpretation; this module produces the missing,
// SEPARATE Tier 2 field (`CASOutput.dependency_roles`) that joins back to it
// by name. This is the concrete mechanism the spec cites as the missing
// input behind the integrations-never-become-capability-candidates defect.
//
// Tier discipline: reads only exit_points (Tier 1, closed-vocabulary `type`
// per EXIT_POINT_TYPES) and dependency_manifest (Tier 1 raw fact). No AI /
// comprehension output is read.
//
// Two evidence tiers, in priority order:
//
//  1. EXIT-POINT EVIDENCE (source: 'exit-point-evidence', confidence 0.9).
//     Some library analyzers already stamp the literal dependency name onto
//     the exit points their own detected calls produce — the outbound HTTP
//     client analyzers (`libraries/http/outbound-http-client-analyzer.ts`,
//     `reqwest-analyzer.ts`) set `metadata.library`; the messaging analyzer
//     (`libraries/messaging/messaging-analyzer.ts`) sets `metadata.system`
//     on every producer/consumer exit point. Where that literal name matches
//     a declared dependency, the exit point IS the structural evidence: this
//     dependency produced a real outbound call in this repo, not merely a
//     name in a manifest.
//
//  2. KNOWN-PACKAGE FALLBACK (source: 'known-package-list', confidence 0.6).
//     Used only for roles the current analyzer set cannot yet ground in
//     exit-point evidence — see the comment on KNOWN_PACKAGE_ROLES below for
//     why, per role. Each list is a small, explicit citation of real package
//     identifiers (the same class of "framework/library identifier used as
//     structural evidence" the hard constraints permit), not a brand or
//     domain-word categorizer — it never inspects what a package's NAME
//     means, only whether a declared name IS one of these known ones.

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

/**
 * SMALL, JUSTIFIED FALLBACK REGISTRY. Each entry below exists because the
 * current library-analyzer set does not yet emit exit-point-level evidence
 * for that role, so there is nothing to derive from:
 *  - 'database-driver' / 'orm': `libraries/database/index.ts` is a stub
 *    ("Database driver analyzers will be exported here" — no analyzers
 *    registered yet) and ORM analyzers (typeorm/sequelize/mongoose/efcore/
 *    sqlalchemy) emit nodes/edges for entities, not exit points naming the
 *    driver package.
 *  - 'cache': cache-shaped exit points exist only inside framework-specific
 *    dependency classifiers (e.g. nestjs-analyzer's classifyNestDependency)
 *    with per-framework metadata shapes, not a shared field this module can
 *    read generically today.
 *  - 'observability' / 'auth': observability-analyzer.ts and auth-analyzer.ts
 *    currently produce instrumentation-site nodes/tags, not exit points —
 *    there is no call-shaped evidence to cite yet.
 *  - 'realtime' / 'graphql-client' / 'workflow': thin/no exit-point coverage
 *    from the current analyzer set for the same reason.
 * 'http-client' and 'message-broker' are intentionally left EMPTY here:
 * those two roles already have real exit-point evidence (see above) and a
 * name-only fallback would only ever be reached for a declared HTTP/queue
 * client this repo never actually calls — worth leaving unclassified rather
 * than guessed.
 */
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
      const exitIds = [...new Set(matchingHints.map(h => h.exitId))].slice(0, 5);
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
