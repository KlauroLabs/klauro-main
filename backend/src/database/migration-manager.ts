import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../services/logger.service';

export interface Migration {
  id: number;
  name: string;
  filename: string;
  up: (pool: Pool) => Promise<void>;
  down: (pool: Pool) => Promise<void>;
  applied_at?: Date;
}

export class MigrationManager {
  private pool: Pool;
  private logger = new Logger('MigrationManager');
  private migrationsPath: string;
  
  constructor(pool: Pool, migrationsPath?: string) {
    this.pool = pool;
    this.migrationsPath = migrationsPath || path.join(process.cwd(), 'src', 'database', 'migrations', 'scripts');
  }
  
  async initialize(): Promise<void> {
    await this.createMigrationsTable();
  }
  
  private async createMigrationsTable(): Promise<void> {
    const query = `
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        filename VARCHAR(255) NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        checksum VARCHAR(64) NOT NULL
      );
      
      CREATE INDEX IF NOT EXISTS idx_migrations_name ON migrations(name);
      CREATE INDEX IF NOT EXISTS idx_migrations_applied_at ON migrations(applied_at);
    `;
    
    try {
      await this.pool.query(query);
      this.logger.info('Migrations table initialized');
    } catch (error) {
      this.logger.error('Failed to create migrations table', error);
      throw error;
    }
  }
  
  async getMigrations(): Promise<Migration[]> {
    if (!fs.existsSync(this.migrationsPath)) {
      fs.mkdirSync(this.migrationsPath, { recursive: true });
    }
    
    const files = fs.readdirSync(this.migrationsPath)
      .filter(file => file.endsWith('.ts') || file.endsWith('.js'))
      .sort();
    
    const migrations: Migration[] = [];
    
    for (const file of files) {
      const match = file.match(/^(\d{3})_(.+)\.(ts|js)$/);
      if (!match) {
        this.logger.warn(`Skipping invalid migration filename: ${file}`);
        continue;
      }
      
      const [, idStr, name] = match;
      const id = parseInt(idStr, 10);
      const filePath = path.join(this.migrationsPath, file);
      
      try {
        const migration = await import(filePath);
        migrations.push({
          id,
          name,
          filename: file,
          up: migration.up,
          down: migration.down,
        });
      } catch (error) {
        this.logger.error(`Failed to load migration ${file}`, error);
        throw error;
      }
    }
    
    return migrations;
  }
  
  async getAppliedMigrations(): Promise<Set<string>> {
    const query = 'SELECT name FROM migrations ORDER BY id';
    const result = await this.pool.query(query);
    return new Set(result.rows.map(row => row.name));
  }
  
  async getPendingMigrations(): Promise<Migration[]> {
    const migrations = await this.getMigrations();
    const applied = await this.getAppliedMigrations();
    
    return migrations.filter(m => !applied.has(m.name));
  }
  
  async migrate(): Promise<void> {
    const pending = await this.getPendingMigrations();
    
    if (pending.length === 0) {
      this.logger.info('No pending migrations');
      return;
    }
    
    this.logger.info(`Found ${pending.length} pending migrations`);
    
    for (const migration of pending) {
      await this.runMigration(migration);
    }
    
    this.logger.info('All migrations completed successfully');
  }
  
  private async runMigration(migration: Migration): Promise<void> {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      this.logger.info(`Running migration: ${migration.name}`);
      
      await migration.up(this.pool);
      
      const checksum = this.calculateChecksum(migration.filename);
      
      const insertQuery = `
        INSERT INTO migrations (name, filename, checksum)
        VALUES ($1, $2, $3)
      `;
      await client.query(insertQuery, [migration.name, migration.filename, checksum]);
      
      await client.query('COMMIT');
      
      this.logger.info(`Migration completed: ${migration.name}`);
    } catch (error) {
      await client.query('ROLLBACK');
      this.logger.error(`Migration failed: ${migration.name}`, error);
      throw error;
    } finally {
      client.release();
    }
  }
  
  async rollback(steps: number = 1): Promise<void> {
    const query = `
      SELECT * FROM migrations
      ORDER BY id DESC
      LIMIT $1
    `;
    const result = await this.pool.query(query, [steps]);
    
    if (result.rows.length === 0) {
      this.logger.info('No migrations to rollback');
      return;
    }
    
    const migrations = await this.getMigrations();
    const migrationMap = new Map(migrations.map(m => [m.name, m]));
    
    for (const row of result.rows) {
      const migration = migrationMap.get(row.name);
      if (!migration) {
        this.logger.warn(`Migration not found for rollback: ${row.name}`);
        continue;
      }
      
      await this.rollbackMigration(migration);
    }
    
    this.logger.info(`Rolled back ${result.rows.length} migrations`);
  }
  
  private async rollbackMigration(migration: Migration): Promise<void> {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      this.logger.info(`Rolling back migration: ${migration.name}`);
      
      await migration.down(this.pool);
      
      const deleteQuery = 'DELETE FROM migrations WHERE name = $1';
      await client.query(deleteQuery, [migration.name]);
      
      await client.query('COMMIT');
      
      this.logger.info(`Rollback completed: ${migration.name}`);
    } catch (error) {
      await client.query('ROLLBACK');
      this.logger.error(`Rollback failed: ${migration.name}`, error);
      throw error;
    } finally {
      client.release();
    }
  }
  
  async reset(): Promise<void> {
    const applied = await this.getAppliedMigrations();
    
    if (applied.size === 0) {
      this.logger.info('No migrations to reset');
      return;
    }
    
    await this.rollback(applied.size);
    
    this.logger.info('Database reset completed');
  }
  
  async status(): Promise<void> {
    const migrations = await this.getMigrations();
    const applied = await this.getAppliedMigrations();
    
    this.logger.info('Migration Status:');
    this.logger.info(`Total migrations: ${migrations.length}`);
    this.logger.info(`Applied migrations: ${applied.size}`);
    this.logger.info(`Pending migrations: ${migrations.length - applied.size}`);
    
    if (migrations.length > 0) {
      this.logger.info('\nMigrations:');
      for (const migration of migrations) {
        const status = applied.has(migration.name) ? '✓' : '✗';
        this.logger.info(`  ${status} ${migration.id.toString().padStart(3, '0')}_${migration.name}`);
      }
    }
  }
  
  private calculateChecksum(filename: string): string {
    const crypto = require('crypto');
    const filePath = path.join(this.migrationsPath, filename);
    const content = fs.readFileSync(filePath, 'utf8');
    return crypto.createHash('sha256').update(content).digest('hex');
  }
  
  async validateChecksums(): Promise<boolean> {
    const query = 'SELECT name, filename, checksum FROM migrations';
    const result = await this.pool.query(query);
    
    let valid = true;
    
    for (const row of result.rows) {
      const currentChecksum = this.calculateChecksum(row.filename);
      if (currentChecksum !== row.checksum) {
        this.logger.error(`Checksum mismatch for migration: ${row.name}`);
        this.logger.error(`  Expected: ${row.checksum}`);
        this.logger.error(`  Got: ${currentChecksum}`);
        valid = false;
      }
    }
    
    return valid;
  }
  
  async createMigration(name: string, template?: string): Promise<string> {
    const migrations = await this.getMigrations();
    const nextId = migrations.length > 0 
      ? Math.max(...migrations.map(m => m.id)) + 1 
      : 1;
    
    const filename = `${nextId.toString().padStart(3, '0')}_${name}.ts`;
    const filePath = path.join(this.migrationsPath, filename);
    
    if (fs.existsSync(filePath)) {
      throw new Error(`Migration already exists: ${filename}`);
    }
    
    const content = template || this.getDefaultTemplate(name);
    fs.writeFileSync(filePath, content);
    
    this.logger.info(`Created migration: ${filename}`);
    return filePath;
  }
  
  private getDefaultTemplate(name: string): string {
    return `import { Pool } from 'pg';

/**
 * Migration: ${name}
 * Created: ${new Date().toISOString()}
 */

export async function up(pool: Pool): Promise<void> {
  // Add your migration logic here
  const query = \`
    -- Add your SQL here
  \`;
  
  await pool.query(query);
}

export async function down(pool: Pool): Promise<void> {
  // Add your rollback logic here
  const query = \`
    -- Add your rollback SQL here
  \`;
  
  await pool.query(query);
}
`;
  }
}

export async function runMigrations(pool: Pool): Promise<void> {
  const manager = new MigrationManager(pool);
  await manager.initialize();
  await manager.migrate();
}