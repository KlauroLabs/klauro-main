-- =============================================================================
-- API KEYS TABLE
-- Manages API keys for programmatic access
-- =============================================================================

-- API keys table for service authentication
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    key_hash VARCHAR(255) NOT NULL,
    key_prefix VARCHAR(20) NOT NULL, -- First 12 chars for identification
    scopes JSONB DEFAULT '[]',
    last_used_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    revoked_at TIMESTAMP WITH TIME ZONE,
    
    -- Metadata
    user_agent TEXT,
    ip_address INET,
    
    -- Ensure unique keys
    CONSTRAINT api_keys_key_hash_unique UNIQUE (key_hash)
);

-- Indexes for performance
CREATE INDEX idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX idx_api_keys_organization_id ON api_keys(organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX idx_api_keys_key_prefix ON api_keys(key_prefix);
CREATE INDEX idx_api_keys_key_hash ON api_keys(key_hash) WHERE revoked_at IS NULL;

-- Function to update last_used_at
CREATE OR REPLACE FUNCTION update_api_key_last_used(
    p_key_hash VARCHAR(255)
) RETURNS void AS $$
BEGIN
    UPDATE api_keys 
    SET last_used_at = NOW()
    WHERE key_hash = p_key_hash 
    AND revoked_at IS NULL 
    AND (expires_at IS NULL OR expires_at > NOW());
END;
$$ LANGUAGE plpgsql;