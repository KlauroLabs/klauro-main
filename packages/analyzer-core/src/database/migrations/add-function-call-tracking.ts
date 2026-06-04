import { Migration } from '@mikro-orm/migrations';

export class AddFunctionCallTracking extends Migration {
  async up(): Promise<void> {
    // Create function_calls table
    this.addSql(`
      CREATE TABLE IF NOT EXISTS function_calls (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        analysis_run_id UUID NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
        caller_component_id UUID NOT NULL REFERENCES components(id),
        caller_function VARCHAR(255) NOT NULL,
        caller_signature VARCHAR(500) NOT NULL,
        target_component_id UUID REFERENCES components(id),
        target_function VARCHAR(255) NOT NULL,
        target_signature VARCHAR(500),
        line INTEGER NOT NULL,
        "column" INTEGER NOT NULL,
        call_location VARCHAR(100) NOT NULL,
        call_type VARCHAR(50) NOT NULL CHECK (call_type IN ('direct', 'method', 'callback', 'async', 'hook', 'dynamic', 'recursive')),
        argument_count INTEGER DEFAULT 0,
        is_async BOOLEAN DEFAULT FALSE,
        is_conditional BOOLEAN DEFAULT FALSE,
        is_in_loop BOOLEAN DEFAULT FALSE,
        is_recursive BOOLEAN DEFAULT FALSE,
        arguments JSONB,
        context VARCHAR(500),
        depth INTEGER DEFAULT 0,
        frequency INTEGER DEFAULT 1,
        metadata JSONB,
        is_potential_bottleneck BOOLEAN DEFAULT FALSE,
        is_hot_path BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create indexes for function_calls
    this.addSql('CREATE INDEX idx_function_calls_analysis_run ON function_calls(analysis_run_id);');
    this.addSql('CREATE INDEX idx_function_calls_caller_component ON function_calls(caller_component_id);');
    this.addSql('CREATE INDEX idx_function_calls_target_component ON function_calls(target_component_id);');
    this.addSql('CREATE INDEX idx_function_calls_caller_function ON function_calls(caller_function);');
    this.addSql('CREATE INDEX idx_function_calls_target_function ON function_calls(target_function);');
    this.addSql('CREATE UNIQUE INDEX idx_function_calls_unique ON function_calls(caller_component_id, caller_function, target_component_id, target_function, call_location);');

    // Create call_chains table
    this.addSql(`
      CREATE TABLE IF NOT EXISTS call_chains (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        analysis_run_id UUID NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
        chain_id VARCHAR(255) NOT NULL,
        chain_type VARCHAR(50) NOT NULL CHECK (chain_type IN ('entry-to-exit', 'circular', 'recursive', 'dead-end', 'hot-path', 'critical-path')),
        entry_component_id UUID NOT NULL REFERENCES components(id),
        entry_function VARCHAR(255) NOT NULL,
        exit_component_id UUID REFERENCES components(id),
        exit_function VARCHAR(255),
        path JSONB NOT NULL,
        length INTEGER DEFAULT 0,
        max_depth INTEGER DEFAULT 0,
        frequency INTEGER DEFAULT 1,
        average_execution_time FLOAT,
        total_execution_time FLOAT,
        is_circular BOOLEAN DEFAULT FALSE,
        is_recursive BOOLEAN DEFAULT FALSE,
        is_critical BOOLEAN DEFAULT FALSE,
        is_hot_path BOOLEAN DEFAULT FALSE,
        has_external_calls BOOLEAN DEFAULT FALSE,
        has_database_calls BOOLEAN DEFAULT FALSE,
        has_async_calls BOOLEAN DEFAULT FALSE,
        component_ids JSONB NOT NULL,
        component_count INTEGER DEFAULT 0,
        function_names JSONB NOT NULL,
        unique_function_count INTEGER DEFAULT 0,
        complexity INTEGER DEFAULT 0,
        risk_level VARCHAR(20) NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
        risk_factors JSONB,
        bottlenecks JSONB,
        business_process VARCHAR(500),
        user_action VARCHAR(500),
        tags JSONB,
        ai_description TEXT,
        metadata JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create indexes for call_chains
    this.addSql('CREATE INDEX idx_call_chains_analysis_run ON call_chains(analysis_run_id);');
    this.addSql('CREATE INDEX idx_call_chains_chain_id ON call_chains(chain_id);');
    this.addSql('CREATE INDEX idx_call_chains_entry_component ON call_chains(entry_component_id);');
    this.addSql('CREATE INDEX idx_call_chains_exit_component ON call_chains(exit_component_id);');
    this.addSql('CREATE INDEX idx_call_chains_chain_type ON call_chains(chain_type);');
    this.addSql('CREATE INDEX idx_call_chains_risk_level ON call_chains(risk_level);');
    this.addSql('CREATE INDEX idx_call_chains_hot_path ON call_chains(is_hot_path) WHERE is_hot_path = TRUE;');
    this.addSql('CREATE INDEX idx_call_chains_critical ON call_chains(is_critical) WHERE is_critical = TRUE;');

    // Create junction table for call_chain <-> function_call relationship
    this.addSql(`
      CREATE TABLE IF NOT EXISTS call_chains_function_calls (
        call_chain_id UUID NOT NULL REFERENCES call_chains(id) ON DELETE CASCADE,
        function_call_id UUID NOT NULL REFERENCES function_calls(id) ON DELETE CASCADE,
        PRIMARY KEY (call_chain_id, function_call_id)
      );
    `);

    // Add function analysis columns to components table if not exists
    this.addSql(`
      ALTER TABLE components
      ADD COLUMN IF NOT EXISTS function_count INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS average_function_complexity FLOAT,
      ADD COLUMN IF NOT EXISTS max_function_complexity INTEGER;
    `);

    // Create triggers for updating timestamps
    this.addSql(`
      CREATE OR REPLACE FUNCTION update_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    this.addSql(`
      CREATE TRIGGER function_calls_updated_at
      BEFORE UPDATE ON function_calls
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at();
    `);

    this.addSql(`
      CREATE TRIGGER call_chains_updated_at
      BEFORE UPDATE ON call_chains
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at();
    `);
  }

  async down(): Promise<void> {
    // Drop triggers
    this.addSql('DROP TRIGGER IF EXISTS function_calls_updated_at ON function_calls;');
    this.addSql('DROP TRIGGER IF EXISTS call_chains_updated_at ON call_chains;');
    this.addSql('DROP FUNCTION IF EXISTS update_updated_at();');

    // Drop junction table
    this.addSql('DROP TABLE IF EXISTS call_chains_function_calls;');

    // Drop main tables
    this.addSql('DROP TABLE IF EXISTS call_chains;');
    this.addSql('DROP TABLE IF EXISTS function_calls;');

    // Remove columns from components table
    this.addSql(`
      ALTER TABLE components
      DROP COLUMN IF EXISTS function_count,
      DROP COLUMN IF EXISTS average_function_complexity,
      DROP COLUMN IF EXISTS max_function_complexity;
    `);
  }
}