import { Pool } from 'pg';

/**
 * Migration: initial_schema
 * Creates the initial database schema for Klauro
 */

export async function up(pool: Pool): Promise<void> {
  const queries = [
    // Enable UUID extension
    `CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`,
    
    // Users table
    `CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255),
      first_name VARCHAR(100),
      last_name VARCHAR(100),
      avatar_url TEXT,
      email_verified_at TIMESTAMP,
      timezone VARCHAR(50) DEFAULT 'UTC',
      locale VARCHAR(10) DEFAULT 'en',
      settings JSONB DEFAULT '{}',
      last_login_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      deleted_at TIMESTAMP
    );`,
    
    // Organizations table
    `CREATE TABLE IF NOT EXISTS organizations (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      name VARCHAR(255) NOT NULL,
      slug VARCHAR(255) NOT NULL UNIQUE,
      description TEXT,
      website_url TEXT,
      logo_url TEXT,
      billing_email VARCHAR(255),
      settings JSONB DEFAULT '{}',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      deleted_at TIMESTAMP
    );`,
    
    // Teams table
    `CREATE TABLE IF NOT EXISTS teams (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      slug VARCHAR(255) NOT NULL,
      description TEXT,
      settings JSONB DEFAULT '{}',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(organization_id, slug)
    );`,
    
    // Memberships table
    `CREATE TABLE IF NOT EXISTS memberships (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
      role VARCHAR(50) NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
      invited_by UUID REFERENCES users(id),
      invited_at TIMESTAMP,
      joined_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, organization_id, team_id)
    );`,
    
    // Projects table
    `CREATE TABLE IF NOT EXISTS projects (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      slug VARCHAR(255) NOT NULL,
      description TEXT,
      repository_url TEXT,
      repository_type VARCHAR(50),
      settings JSONB DEFAULT '{}',
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      deleted_at TIMESTAMP,
      UNIQUE(organization_id, slug)
    );`,
    
    // Refresh tokens table
    `CREATE TABLE IF NOT EXISTS refresh_tokens (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMP NOT NULL,
      revoked_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );`,
    
    // API keys table
    `CREATE TABLE IF NOT EXISTS api_keys (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      key_hash VARCHAR(255) NOT NULL UNIQUE,
      key_prefix VARCHAR(20) NOT NULL,
      last_used_at TIMESTAMP,
      expires_at TIMESTAMP,
      revoked_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CHECK ((user_id IS NOT NULL) OR (organization_id IS NOT NULL))
    );`,
    
    // OAuth accounts table
    `CREATE TABLE IF NOT EXISTS oauth_accounts (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider VARCHAR(50) NOT NULL,
      provider_account_id VARCHAR(255) NOT NULL,
      access_token TEXT,
      refresh_token TEXT,
      expires_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(provider, provider_account_id)
    );`,
    
    // Email verification tokens
    `CREATE TABLE IF NOT EXISTS email_verification_tokens (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token VARCHAR(255) NOT NULL UNIQUE,
      expires_at TIMESTAMP NOT NULL,
      used_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );`,
    
    // Password reset tokens
    `CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token VARCHAR(255) NOT NULL UNIQUE,
      expires_at TIMESTAMP NOT NULL,
      used_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );`,
    
    // Invitations table
    `CREATE TABLE IF NOT EXISTS invitations (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
      email VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL,
      token VARCHAR(255) NOT NULL UNIQUE,
      invited_by UUID NOT NULL REFERENCES users(id),
      expires_at TIMESTAMP NOT NULL,
      accepted_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );`,
    
    // Audit logs table
    `CREATE TABLE IF NOT EXISTS audit_logs (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID REFERENCES users(id),
      organization_id UUID REFERENCES organizations(id),
      action VARCHAR(255) NOT NULL,
      resource_type VARCHAR(100),
      resource_id UUID,
      details JSONB,
      ip_address INET,
      user_agent TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );`,
    
    // Security logs table
    `CREATE TABLE IF NOT EXISTS security_logs (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID REFERENCES users(id),
      event_type VARCHAR(100) NOT NULL,
      ip_address INET,
      user_agent TEXT,
      details JSONB,
      threat_level VARCHAR(20),
      blocked BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );`,
    
    // Indexes for performance
    `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE deleted_at IS NULL;`,
    `CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON users(deleted_at);`,
    `CREATE INDEX IF NOT EXISTS idx_organizations_slug ON organizations(slug) WHERE deleted_at IS NULL;`,
    `CREATE INDEX IF NOT EXISTS idx_teams_org_id ON teams(organization_id);`,
    `CREATE INDEX IF NOT EXISTS idx_memberships_user_id ON memberships(user_id);`,
    `CREATE INDEX IF NOT EXISTS idx_memberships_org_id ON memberships(organization_id);`,
    `CREATE INDEX IF NOT EXISTS idx_projects_org_id ON projects(organization_id) WHERE deleted_at IS NULL;`,
    `CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);`,
    `CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token ON refresh_tokens(token) WHERE revoked_at IS NULL;`,
    `CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id) WHERE revoked_at IS NULL;`,
    `CREATE INDEX IF NOT EXISTS idx_api_keys_org_id ON api_keys(organization_id) WHERE revoked_at IS NULL;`,
    `CREATE INDEX IF NOT EXISTS idx_oauth_accounts_user_id ON oauth_accounts(user_id);`,
    `CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);`,
    `CREATE INDEX IF NOT EXISTS idx_audit_logs_org_id ON audit_logs(organization_id);`,
    `CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);`,
    `CREATE INDEX IF NOT EXISTS idx_security_logs_user_id ON security_logs(user_id);`,
    `CREATE INDEX IF NOT EXISTS idx_security_logs_created_at ON security_logs(created_at);`,
  ];
  
  for (const query of queries) {
    await pool.query(query);
  }
}

export async function down(pool: Pool): Promise<void> {
  const queries = [
    `DROP TABLE IF EXISTS security_logs CASCADE;`,
    `DROP TABLE IF EXISTS audit_logs CASCADE;`,
    `DROP TABLE IF EXISTS invitations CASCADE;`,
    `DROP TABLE IF EXISTS password_reset_tokens CASCADE;`,
    `DROP TABLE IF EXISTS email_verification_tokens CASCADE;`,
    `DROP TABLE IF EXISTS oauth_accounts CASCADE;`,
    `DROP TABLE IF EXISTS api_keys CASCADE;`,
    `DROP TABLE IF EXISTS refresh_tokens CASCADE;`,
    `DROP TABLE IF EXISTS projects CASCADE;`,
    `DROP TABLE IF EXISTS memberships CASCADE;`,
    `DROP TABLE IF EXISTS teams CASCADE;`,
    `DROP TABLE IF EXISTS organizations CASCADE;`,
    `DROP TABLE IF EXISTS users CASCADE;`,
  ];
  
  for (const query of queries) {
    await pool.query(query);
  }
}