import { Migration } from '@mikro-orm/migrations';

export class Migration20250920000000PhaseWorkspaceCodebaseRestructure extends Migration {
  async up(): Promise<void> {
    // 1. Create workspaces table
    this.addSql(`
      CREATE TABLE workspaces (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(100) UNIQUE NOT NULL,
        description TEXT,
        visibility VARCHAR(20) NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public', 'internal')),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
        settings JSONB,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP WITH TIME ZONE,
        CONSTRAINT workspace_owner_check CHECK (
          (user_id IS NOT NULL AND organization_id IS NULL) OR
          (user_id IS NULL AND organization_id IS NOT NULL)
        )
      );
    `);

    // Create indexes for workspaces
    this.addSql('CREATE INDEX idx_workspaces_slug ON workspaces(slug);');
    this.addSql('CREATE INDEX idx_workspaces_user ON workspaces(user_id);');
    this.addSql('CREATE INDEX idx_workspaces_organization ON workspaces(organization_id);');
    this.addSql('CREATE INDEX idx_workspaces_visibility ON workspaces(visibility);');

    // 2. Create workspace_access table
    this.addSql(`
      CREATE TABLE workspace_access (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
        status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'revoked')),
        granted_by_id UUID REFERENCES users(id),
        granted_at TIMESTAMP WITH TIME ZONE,
        revoked_at TIMESTAMP WITH TIME ZONE,
        revoked_by_id UUID REFERENCES users(id),
        expires_at TIMESTAMP WITH TIME ZONE,
        notes TEXT,
        permissions JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP WITH TIME ZONE,
        UNIQUE(workspace_id, user_id)
      );
    `);

    // Create indexes for workspace_access
    this.addSql('CREATE INDEX idx_workspace_access_workspace ON workspace_access(workspace_id);');
    this.addSql('CREATE INDEX idx_workspace_access_user ON workspace_access(user_id);');
    this.addSql('CREATE INDEX idx_workspace_access_role ON workspace_access(role);');
    this.addSql('CREATE INDEX idx_workspace_access_status ON workspace_access(status);');

    // 3. Create tags table
    this.addSql(`
      CREATE TABLE tags (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(100) NOT NULL,
        description VARCHAR(255),
        color VARCHAR(20) NOT NULL DEFAULT 'blue' CHECK (color IN ('red', 'orange', 'yellow', 'green', 'blue', 'indigo', 'purple', 'pink', 'gray')),
        type VARCHAR(20) NOT NULL CHECK (type IN ('workspace', 'codebase')),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        entity_id UUID,
        is_active BOOLEAN DEFAULT TRUE,
        metadata JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP WITH TIME ZONE,
        UNIQUE(name, workspace_id, type)
      );
    `);

    // Create indexes for tags
    this.addSql('CREATE INDEX idx_tags_name ON tags(name);');
    this.addSql('CREATE INDEX idx_tags_workspace ON tags(workspace_id);');
    this.addSql('CREATE INDEX idx_tags_type ON tags(type);');
    this.addSql('CREATE INDEX idx_tags_entity ON tags(entity_id);');

    // 4. Create codebases table (renamed from projects)
    this.addSql(`
      CREATE TABLE codebases (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        owner_id UUID REFERENCES users(id),
        name VARCHAR(255) NOT NULL,
        description TEXT,
        repository_url VARCHAR(500),
        repository_provider VARCHAR(50) CHECK (repository_provider IN ('github', 'gitlab', 'bitbucket', 'azure_devops', 'custom')),
        repository_id VARCHAR(255),
        default_branch VARCHAR(100) DEFAULT 'main',
        language VARCHAR(100),
        framework VARCHAR(100),
        status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'analyzing', 'error')),
        settings JSONB,
        last_analyzed_at TIMESTAMP WITH TIME ZONE,
        analysis_metadata JSONB,
        analysis_count INTEGER DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP WITH TIME ZONE
      );
    `);

    // Create indexes for codebases
    this.addSql('CREATE INDEX idx_codebases_workspace ON codebases(workspace_id);');
    this.addSql('CREATE INDEX idx_codebases_owner ON codebases(owner_id);');
    this.addSql('CREATE INDEX idx_codebases_status ON codebases(status);');
    this.addSql('CREATE INDEX idx_codebases_language ON codebases(language);');
    this.addSql('CREATE INDEX idx_codebases_framework ON codebases(framework);');

    // 5. Create codebase_connections table
    this.addSql(`
      CREATE TABLE codebase_connections (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source_codebase_id UUID NOT NULL REFERENCES codebases(id) ON DELETE CASCADE,
        target_codebase_id UUID NOT NULL REFERENCES codebases(id) ON DELETE CASCADE,
        type VARCHAR(50) NOT NULL CHECK (type IN ('api_call', 'database_shared', 'message_queue', 'event_stream', 'file_dependency', 'package_dependency', 'service_mesh', 'microservice', 'monorepo', 'custom')),
        strength VARCHAR(20) NOT NULL DEFAULT 'moderate' CHECK (strength IN ('weak', 'moderate', 'strong', 'critical')),
        status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'deprecated', 'broken')),
        name VARCHAR(255),
        description TEXT,
        endpoint VARCHAR(500),
        protocol VARCHAR(100),
        method VARCHAR(50),
        metadata JSONB,
        configuration JSONB,
        discovered_by_id UUID REFERENCES users(id),
        discovered_at TIMESTAMP WITH TIME ZONE,
        last_verified_at TIMESTAMP WITH TIME ZONE,
        usage_count INTEGER DEFAULT 0,
        last_used_at TIMESTAMP WITH TIME ZONE,
        is_auto_discovered BOOLEAN DEFAULT FALSE,
        confidence_score DECIMAL(3,2),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP WITH TIME ZONE,
        UNIQUE(source_codebase_id, target_codebase_id, type)
      );
    `);

    // Create indexes for codebase_connections
    this.addSql('CREATE INDEX idx_codebase_connections_source ON codebase_connections(source_codebase_id);');
    this.addSql('CREATE INDEX idx_codebase_connections_target ON codebase_connections(target_codebase_id);');
    this.addSql('CREATE INDEX idx_codebase_connections_type ON codebase_connections(type);');
    this.addSql('CREATE INDEX idx_codebase_connections_status ON codebase_connections(status);');

    // 6. Add new fields to users table
    this.addSql('ALTER TABLE users ADD COLUMN onboarding_completed BOOLEAN DEFAULT FALSE;');
    this.addSql('ALTER TABLE users ADD COLUMN billing_tier VARCHAR(20) DEFAULT \'free\' CHECK (billing_tier IN (\'free\', \'starter\', \'professional\', \'enterprise\'));');

    // 7. Add new fields to organizations table
    this.addSql('ALTER TABLE organizations ADD COLUMN owner_id UUID NOT NULL REFERENCES users(id);');
    this.addSql('ALTER TABLE organizations ADD COLUMN billing_tier VARCHAR(20) DEFAULT \'starter\' CHECK (billing_tier IN (\'starter\', \'professional\', \'enterprise\'));');
    this.addSql('ALTER TABLE organizations ADD COLUMN billing_status VARCHAR(20) DEFAULT \'trial\' CHECK (billing_status IN (\'active\', \'past_due\', \'cancelled\', \'suspended\', \'trial\'));');
    this.addSql('ALTER TABLE organizations ADD COLUMN billing_customer_id VARCHAR(255);');
    this.addSql('ALTER TABLE organizations ADD COLUMN billing_subscription_id VARCHAR(255);');
    this.addSql('ALTER TABLE organizations ADD COLUMN trial_ends_at TIMESTAMP WITH TIME ZONE;');
    this.addSql('ALTER TABLE organizations ADD COLUMN billing_period_starts_at TIMESTAMP WITH TIME ZONE;');
    this.addSql('ALTER TABLE organizations ADD COLUMN billing_period_ends_at TIMESTAMP WITH TIME ZONE;');

    // Create index for organization owner
    this.addSql('CREATE INDEX idx_organizations_owner ON organizations(owner_id);');

    // 8. Migrate data from projects to codebases via workspaces
    // First, create default workspaces for existing projects
    this.addSql(`
      INSERT INTO workspaces (id, name, slug, description, user_id, organization_id, visibility, is_active, created_at, updated_at)
      SELECT
        gen_random_uuid(),
        COALESCE(o.name || ' Workspace', 'Default Workspace'),
        COALESCE(o.slug || '-workspace', 'default-workspace-' || SUBSTRING(p.organization_id::text, 1, 8)),
        'Default workspace created during migration',
        NULL,
        p.organization_id,
        'private',
        TRUE,
        p.created_at,
        p.updated_at
      FROM projects p
      JOIN organizations o ON p.organization_id = o.id
      GROUP BY p.organization_id, o.name, o.slug, p.created_at, p.updated_at;
    `);

    // Then migrate projects to codebases
    this.addSql(`
      INSERT INTO codebases (
        id, workspace_id, owner_id, name, description, repository_url, repository_provider,
        repository_id, default_branch, language, framework, status, settings,
        last_analyzed_at, created_at, updated_at, deleted_at
      )
      SELECT
        p.id,
        w.id,
        p.owner_id,
        p.name,
        p.description,
        p.repository_url,
        p.repository_provider,
        p.repository_id,
        p.default_branch,
        p.language,
        p.framework,
        p.status,
        p.settings,
        p.last_analyzed_at,
        p.created_at,
        p.updated_at,
        p.deleted_at
      FROM projects p
      JOIN organizations o ON p.organization_id = o.id
      JOIN workspaces w ON w.organization_id = o.id;
    `);

    // 9. Update analysis_runs to reference codebases instead of projects
    this.addSql('ALTER TABLE analysis_runs RENAME COLUMN project_id TO codebase_id;');

    // 10. Update any other tables that reference projects (if they exist)
    // Check if components table exists and update it
    this.addSql(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_name = 'components' AND column_name = 'project_id'
        ) THEN
          ALTER TABLE components RENAME COLUMN project_id TO codebase_id;
        END IF;
      END $$;
    `);

    // 11. Drop the old projects table (after data migration)
    this.addSql('DROP TABLE IF EXISTS projects CASCADE;');
  }

  async down(): Promise<void> {
    // Reverse migration - recreate projects table and migrate data back
    this.addSql(`
      CREATE TABLE projects (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        owner_id UUID REFERENCES users(id),
        name VARCHAR(255) NOT NULL,
        description TEXT,
        repository_url VARCHAR(500),
        repository_provider VARCHAR(50) CHECK (repository_provider IN ('github', 'gitlab', 'bitbucket', 'azure_devops', 'custom')),
        repository_id VARCHAR(255),
        default_branch VARCHAR(100) DEFAULT 'main',
        language VARCHAR(100),
        framework VARCHAR(100),
        status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'analyzing', 'error')),
        settings JSONB,
        last_analyzed_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP WITH TIME ZONE
      );
    `);

    // Migrate data back from codebases to projects
    this.addSql(`
      INSERT INTO projects (
        id, organization_id, owner_id, name, description, repository_url, repository_provider,
        repository_id, default_branch, language, framework, status, settings,
        last_analyzed_at, created_at, updated_at, deleted_at
      )
      SELECT
        c.id, w.organization_id, c.owner_id, c.name, c.description, c.repository_url,
        c.repository_provider, c.repository_id, c.default_branch, c.language,
        c.framework, c.status, c.settings, c.last_analyzed_at,
        c.created_at, c.updated_at, c.deleted_at
      FROM codebases c
      JOIN workspaces w ON c.workspace_id = w.id
      WHERE w.organization_id IS NOT NULL;
    `);

    // Update analysis_runs back to reference projects
    this.addSql('ALTER TABLE analysis_runs RENAME COLUMN codebase_id TO project_id;');

    // Update components table if it exists
    this.addSql(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_name = 'components' AND column_name = 'codebase_id'
        ) THEN
          ALTER TABLE components RENAME COLUMN codebase_id TO project_id;
        END IF;
      END $$;
    `);

    // Remove new fields from organizations
    this.addSql('ALTER TABLE organizations DROP COLUMN IF EXISTS owner_id;');
    this.addSql('ALTER TABLE organizations DROP COLUMN IF EXISTS billing_tier;');
    this.addSql('ALTER TABLE organizations DROP COLUMN IF EXISTS billing_status;');
    this.addSql('ALTER TABLE organizations DROP COLUMN IF EXISTS billing_customer_id;');
    this.addSql('ALTER TABLE organizations DROP COLUMN IF EXISTS billing_subscription_id;');
    this.addSql('ALTER TABLE organizations DROP COLUMN IF EXISTS trial_ends_at;');
    this.addSql('ALTER TABLE organizations DROP COLUMN IF EXISTS billing_period_starts_at;');
    this.addSql('ALTER TABLE organizations DROP COLUMN IF EXISTS billing_period_ends_at;');

    // Remove new fields from users
    this.addSql('ALTER TABLE users DROP COLUMN IF EXISTS onboarding_completed;');
    this.addSql('ALTER TABLE users DROP COLUMN IF EXISTS billing_tier;');

    // Drop new tables
    this.addSql('DROP TABLE IF EXISTS codebase_connections CASCADE;');
    this.addSql('DROP TABLE IF EXISTS codebases CASCADE;');
    this.addSql('DROP TABLE IF EXISTS tags CASCADE;');
    this.addSql('DROP TABLE IF EXISTS workspace_access CASCADE;');
    this.addSql('DROP TABLE IF EXISTS workspaces CASCADE;');
  }
}