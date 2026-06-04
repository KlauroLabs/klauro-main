import * as path from 'node:path';
import { createRequire } from 'node:module';
import type { VectorStoreFactoryOptions } from '../../../packages/analyzer-core/src/analyzer/embedding/vector-store-factory';

type Pool = NonNullable<VectorStoreFactoryOptions['pgPool']>;

interface PgModule {
  Pool: new (config: { connectionString: string }) => Pool;
}

let cachedPool: Pool | null = null;
let cachedConnectionString: string | null = null;
let resolutionFailed = false;

function loadPgModule(): PgModule | null {
  try {
    return require('pg') as PgModule;
  } catch {
  }
  try {
    const backendRequire = createRequire(
      path.resolve(__dirname, '../../../packages/analyzer-core/package.json'),
    );
    return backendRequire('pg') as PgModule;
  } catch {
    return null;
  }
}

export function resolvePgConnectionString(databaseUrlEnv: string): string | null {
  const fromConfigured = databaseUrlEnv ? process.env[databaseUrlEnv] : undefined;
  const value = (fromConfigured || '').trim();
  return value.length > 0 ? value : null;
}

export function getPgPool(connectionString: string | null): Pool | null {
  if (!connectionString) return null;
  if (resolutionFailed) return null;

  if (cachedPool && cachedConnectionString === connectionString) {
    return cachedPool;
  }

  const pg = loadPgModule();
  if (!pg) {
    resolutionFailed = true;
    return null;
  }

  try {
    const pool = new pg.Pool({ connectionString });
    pool.on('error', (error: unknown) => {
      console.warn(
        `[Klauro] pgvector pool error: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    cachedPool = pool;
    cachedConnectionString = connectionString;
    return pool;
  } catch (error) {
    console.warn(
      `[Klauro] pgvector pool could not be created: ${error instanceof Error ? error.message : String(error)}`,
    );
    resolutionFailed = true;
    return null;
  }
}
