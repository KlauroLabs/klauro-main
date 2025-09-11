-- =============================================================================
-- UNRAVL DEVELOPMENT SEED DATA
-- Realistic test data for development and testing environments
-- This file contains production-like data for realistic testing
-- =============================================================================

-- Clear existing data (development only!)
DO $$ 
BEGIN
    -- Only run in development environment
    IF current_database() NOT LIKE '%prod%' AND current_database() NOT LIKE '%production%' THEN
        -- Clear data in dependency order
        TRUNCATE TABLE background_tasks CASCADE;
        TRUNCATE TABLE retention_policies CASCADE;
        TRUNCATE TABLE telemetry_events CASCADE;
        TRUNCATE TABLE performance_metrics CASCADE;
        TRUNCATE TABLE error_tracking CASCADE;
        TRUNCATE TABLE user_sessions CASCADE;
        TRUNCATE TABLE api_keys CASCADE;
        TRUNCATE TABLE usage_tracking CASCADE;
        TRUNCATE TABLE subscriptions CASCADE;
        TRUNCATE TABLE security_vulnerabilities CASCADE;
        TRUNCATE TABLE dependencies CASCADE;
        TRUNCATE TABLE test_coverage CASCADE;
        TRUNCATE TABLE testing_info CASCADE;
        TRUNCATE TABLE technology_stacks CASCADE;
        TRUNCATE TABLE risk_areas CASCADE;
        TRUNCATE TABLE exit_points CASCADE;
        TRUNCATE TABLE entry_points CASCADE;
        TRUNCATE TABLE connections CASCADE;
        TRUNCATE TABLE function_calls CASCADE;
        TRUNCATE TABLE functions CASCADE;
        TRUNCATE TABLE components CASCADE;
        TRUNCATE TABLE analysis_runs CASCADE;
        TRUNCATE TABLE projects CASCADE;
        TRUNCATE TABLE memberships CASCADE;
        TRUNCATE TABLE teams CASCADE;
        TRUNCATE TABLE users CASCADE;
        TRUNCATE TABLE organizations CASCADE;
        -- Keep subscription_plans as they're configuration data
        
        RAISE NOTICE 'Development data cleared successfully';
    ELSE
        RAISE EXCEPTION 'Seed data can only be loaded in development databases';
    END IF;
END $$;

-- =============================================================================
-- ORGANIZATIONS
-- =============================================================================

INSERT INTO organizations (id, name, slug, description, website_url, billing_email, settings, created_at, updated_at) VALUES
(
    '01234567-89ab-cdef-0123-456789abcdef',
    'Acme Software Inc',
    'acme-software',
    'Leading provider of innovative software solutions for enterprise customers',
    'https://acmesoftware.com',
    'billing@acmesoftware.com',
    '{"theme": "dark", "notifications": true, "auto_analysis": true, "slack_webhook": "https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX"}',
    NOW() - INTERVAL '6 months',
    NOW() - INTERVAL '1 week'
),
(
    '12345678-9abc-def0-1234-56789abcdef0',
    'TechStart Ventures',
    'techstart',
    'Fast-growing startup focused on AI-powered developer tools',
    'https://techstart.io',
    'founders@techstart.io',
    '{"theme": "light", "notifications": true, "auto_analysis": false}',
    NOW() - INTERVAL '3 months',
    NOW() - INTERVAL '2 days'
),
(
    '23456789-abcd-ef01-2345-6789abcdef01',
    'DevTools Corp',
    'devtools-corp',
    'Enterprise development tooling company serving Fortune 500 clients',
    'https://devtools-corp.com',
    'accounts@devtools-corp.com',
    '{"theme": "auto", "notifications": false, "auto_analysis": true, "custom_branding": true}',
    NOW() - INTERVAL '2 years',
    NOW() - INTERVAL '3 hours'
);

-- =============================================================================
-- TEAMS
-- =============================================================================

INSERT INTO teams (id, organization_id, name, description, slug, settings, created_at, updated_at) VALUES
-- Acme Software teams
(
    '34567890-bcde-f012-3456-789abcdef012',
    '01234567-89ab-cdef-0123-456789abcdef',
    'Backend Engineering',
    'Core backend services and APIs team',
    'backend-eng',
    '{"code_review_required": true, "deployment_approval": "lead"}',
    NOW() - INTERVAL '5 months',
    NOW() - INTERVAL '1 week'
),
(
    '45678901-cdef-0123-4567-89abcdef0123',
    '01234567-89ab-cdef-0123-456789abcdef',
    'Frontend Engineering',
    'User interface and web application team',
    'frontend-eng',
    '{"code_review_required": true, "deployment_approval": "any"}',
    NOW() - INTERVAL '5 months',
    NOW() - INTERVAL '2 days'
),
(
    '56789012-def0-1234-5678-9abcdef01234',
    '01234567-89ab-cdef-0123-456789abcdef',
    'DevOps & Infrastructure',
    'Platform reliability and infrastructure automation',
    'devops',
    '{"incident_notifications": true, "deployment_approval": "lead"}',
    NOW() - INTERVAL '4 months',
    NOW() - INTERVAL '1 day'
),

-- TechStart teams
(
    '67890123-ef01-2345-6789-abcdef012345',
    '12345678-9abc-def0-1234-56789abcdef0',
    'Full Stack Team',
    'Small but mighty full-stack development team',
    'fullstack',
    '{"code_review_required": false, "deployment_approval": "any"}',
    NOW() - INTERVAL '2 months',
    NOW() - INTERVAL '1 hour'
),

-- DevTools Corp teams
(
    '78901234-f012-3456-789a-bcdef0123456',
    '23456789-abcd-ef01-2345-6789abcdef01',
    'Platform Engineering',
    'Core platform and infrastructure services',
    'platform',
    '{"code_review_required": true, "deployment_approval": "lead", "security_scanning": true}',
    NOW() - INTERVAL '18 months',
    NOW() - INTERVAL '4 hours'
),
(
    '89012345-0123-4567-89ab-cdef01234567',
    '23456789-abcd-ef01-2345-6789abcdef01',
    'Product Engineering',
    'Customer-facing product development team',
    'product',
    '{"code_review_required": true, "deployment_approval": "any", "feature_flags": true}',
    NOW() - INTERVAL '1 year',
    NOW() - INTERVAL '30 minutes'
);

-- =============================================================================
-- USERS
-- =============================================================================

INSERT INTO users (id, email, first_name, last_name, avatar_url, timezone, locale, email_verified_at, last_login_at, settings, created_at, updated_at) VALUES
-- Acme Software users
(
    '9abc0123-4567-89ab-cdef-0123456789ab',
    'sarah.chen@acmesoftware.com',
    'Sarah',
    'Chen',
    'https://avatars.githubusercontent.com/u/1234567',
    'America/Los_Angeles',
    'en',
    NOW() - INTERVAL '6 months',
    NOW() - INTERVAL '2 hours',
    '{"email_notifications": true, "dashboard_layout": "compact", "theme": "dark"}',
    NOW() - INTERVAL '6 months',
    NOW() - INTERVAL '2 hours'
),
(
    'abcd1234-5678-9abc-def0-123456789abc',
    'mike.rodriguez@acmesoftware.com',
    'Mike',
    'Rodriguez',
    'https://avatars.githubusercontent.com/u/2345678',
    'America/New_York',
    'en',
    NOW() - INTERVAL '5 months',
    NOW() - INTERVAL '1 day',
    '{"email_notifications": true, "dashboard_layout": "detailed", "theme": "light"}',
    NOW() - INTERVAL '5 months',
    NOW() - INTERVAL '1 day'
),
(
    'bcde2345-6789-abcd-ef01-23456789abcd',
    'emma.johnson@acmesoftware.com',
    'Emma',
    'Johnson',
    'https://avatars.githubusercontent.com/u/3456789',
    'Europe/London',
    'en',
    NOW() - INTERVAL '4 months',
    NOW() - INTERVAL '6 hours',
    '{"email_notifications": false, "dashboard_layout": "compact", "theme": "auto"}',
    NOW() - INTERVAL '4 months',
    NOW() - INTERVAL '6 hours'
),

-- TechStart users
(
    'cdef3456-789a-bcde-f012-3456789abcde',
    'alex.kim@techstart.io',
    'Alex',
    'Kim',
    'https://avatars.githubusercontent.com/u/4567890',
    'America/Los_Angeles',
    'en',
    NOW() - INTERVAL '3 months',
    NOW() - INTERVAL '30 minutes',
    '{"email_notifications": true, "dashboard_layout": "detailed", "theme": "dark"}',
    NOW() - INTERVAL '3 months',
    NOW() - INTERVAL '30 minutes'
),
(
    'def04567-89ab-cdef-0123-456789abcdef',
    'jordan.taylor@techstart.io',
    'Jordan',
    'Taylor',
    'https://avatars.githubusercontent.com/u/5678901',
    'America/Chicago',
    'en',
    NOW() - INTERVAL '2 months',
    NOW() - INTERVAL '2 hours',
    '{"email_notifications": true, "dashboard_layout": "compact", "theme": "light"}',
    NOW() - INTERVAL '2 months',
    NOW() - INTERVAL '2 hours'
),

-- DevTools Corp users
(
    'ef015678-9abc-def0-1234-56789abcdef0',
    'david.lee@devtools-corp.com',
    'David',
    'Lee',
    'https://avatars.githubusercontent.com/u/6789012',
    'America/Los_Angeles',
    'en',
    NOW() - INTERVAL '2 years',
    NOW() - INTERVAL '1 hour',
    '{"email_notifications": true, "dashboard_layout": "detailed", "theme": "dark"}',
    NOW() - INTERVAL '2 years',
    NOW() - INTERVAL '1 hour'
),
(
    'f0126789-abcd-ef01-2345-6789abcdef01',
    'lisa.wang@devtools-corp.com',
    'Lisa',
    'Wang',
    'https://avatars.githubusercontent.com/u/7890123',
    'Asia/Shanghai',
    'en',
    NOW() - INTERVAL '18 months',
    NOW() - INTERVAL '4 hours',
    '{"email_notifications": true, "dashboard_layout": "compact", "theme": "auto"}',
    NOW() - INTERVAL '18 months',
    NOW() - INTERVAL '4 hours'
);

-- =============================================================================
-- MEMBERSHIPS
-- =============================================================================

INSERT INTO memberships (id, user_id, organization_id, team_id, role, permissions, invited_by, invited_at, joined_at, created_at) VALUES
-- Acme Software memberships
(
    '01267890-abcd-ef01-2345-6789abcdef02',
    '9abc0123-4567-89ab-cdef-0123456789ab',
    '01234567-89ab-cdef-0123-456789abcdef',
    NULL,
    'owner',
    '["org:admin", "billing:admin", "projects:admin", "teams:admin"]',
    NULL,
    NULL,
    NOW() - INTERVAL '6 months',
    NOW() - INTERVAL '6 months'
),
(
    '12678901-bcde-f012-3456-789abcdef012',
    'abcd1234-5678-9abc-def0-123456789abc',
    '01234567-89ab-cdef-0123-456789abcdef',
    '34567890-bcde-f012-3456-789abcdef012',
    'admin',
    '["projects:admin", "team:admin"]',
    '9abc0123-4567-89ab-cdef-0123456789ab',
    NOW() - INTERVAL '5 months',
    NOW() - INTERVAL '5 months',
    NOW() - INTERVAL '5 months'
),
(
    '23789012-cdef-0123-4567-89abcdef0123',
    'bcde2345-6789-abcd-ef01-23456789abcd',
    '01234567-89ab-cdef-0123-456789abcdef',
    '45678901-cdef-0123-4567-89abcdef0123',
    'member',
    '["projects:read", "projects:write"]',
    '9abc0123-4567-89ab-cdef-0123456789ab',
    NOW() - INTERVAL '4 months',
    NOW() - INTERVAL '4 months',
    NOW() - INTERVAL '4 months'
),

-- TechStart memberships
(
    '34890123-def0-1234-5678-9abcdef01234',
    'cdef3456-789a-bcde-f012-3456789abcde',
    '12345678-9abc-def0-1234-56789abcdef0',
    NULL,
    'owner',
    '["org:admin", "billing:admin", "projects:admin", "teams:admin"]',
    NULL,
    NULL,
    NOW() - INTERVAL '3 months',
    NOW() - INTERVAL '3 months'
),
(
    '45901234-ef01-2345-6789-abcdef012345',
    'def04567-89ab-cdef-0123-456789abcdef',
    '12345678-9abc-def0-1234-56789abcdef0',
    '67890123-ef01-2345-6789-abcdef012345',
    'member',
    '["projects:read", "projects:write"]',
    'cdef3456-789a-bcde-f012-3456789abcde',
    NOW() - INTERVAL '2 months',
    NOW() - INTERVAL '2 months',
    NOW() - INTERVAL '2 months'
),

-- DevTools Corp memberships
(
    '56012345-f012-3456-789a-bcdef0123456',
    'ef015678-9abc-def0-1234-56789abcdef0',
    '23456789-abcd-ef01-2345-6789abcdef01',
    NULL,
    'owner',
    '["org:admin", "billing:admin", "projects:admin", "teams:admin"]',
    NULL,
    NULL,
    NOW() - INTERVAL '2 years',
    NOW() - INTERVAL '2 years'
),
(
    '67123456-0123-4567-89ab-cdef01234567',
    'f0126789-abcd-ef01-2345-6789abcdef01',
    '23456789-abcd-ef01-2345-6789abcdef01',
    '78901234-f012-3456-789a-bcdef0123456',
    'admin',
    '["projects:admin", "team:admin"]',
    'ef015678-9abc-def0-1234-56789abcdef0',
    NOW() - INTERVAL '18 months',
    NOW() - INTERVAL '18 months',
    NOW() - INTERVAL '18 months'
);

-- =============================================================================
-- SUBSCRIPTIONS
-- =============================================================================

INSERT INTO subscriptions (id, organization_id, plan_id, status, current_period_start, current_period_end, cancel_at_period_end, trial_start, trial_end, stripe_subscription_id, stripe_customer_id, created_at, updated_at) VALUES
(
    '78234567-1234-5678-9abc-def012345678',
    '01234567-89ab-cdef-0123-456789abcdef',
    (SELECT id FROM subscription_plans WHERE name = 'Professional' LIMIT 1),
    'active',
    DATE_TRUNC('month', NOW()),
    DATE_TRUNC('month', NOW()) + INTERVAL '1 month',
    false,
    NULL,
    NULL,
    'sub_acme_professional_2024',
    'cus_acme_software_inc',
    NOW() - INTERVAL '3 months',
    NOW() - INTERVAL '1 week'
),
(
    '89345678-2345-6789-abcd-ef0123456789',
    '12345678-9abc-def0-1234-56789abcdef0',
    (SELECT id FROM subscription_plans WHERE name = 'Starter' LIMIT 1),
    'active',
    DATE_TRUNC('month', NOW()),
    DATE_TRUNC('month', NOW()) + INTERVAL '1 month',
    false,
    NOW() - INTERVAL '3 months',
    NOW() - INTERVAL '2 months',
    'sub_techstart_starter_2024',
    'cus_techstart_ventures',
    NOW() - INTERVAL '3 months',
    NOW() - INTERVAL '1 day'
),
(
    '90456789-3456-789a-bcde-f01234567890',
    '23456789-abcd-ef01-2345-6789abcdef01',
    (SELECT id FROM subscription_plans WHERE name = 'Enterprise' LIMIT 1),
    'active',
    DATE_TRUNC('month', NOW()),
    DATE_TRUNC('month', NOW()) + INTERVAL '1 month',
    false,
    NULL,
    NULL,
    'sub_devtools_enterprise_2024',
    'cus_devtools_corp',
    NOW() - INTERVAL '1 year',
    NOW() - INTERVAL '2 days'
);

-- =============================================================================
-- USAGE TRACKING
-- =============================================================================

INSERT INTO usage_tracking (id, organization_id, metric_name, metric_value, period_start, period_end, created_at, updated_at) VALUES
-- Acme Software current month usage
(
    'a1456789-4567-89ab-cdef-012345678901',
    '01234567-89ab-cdef-0123-456789abcdef',
    'projects',
    8,
    DATE_TRUNC('month', NOW()),
    DATE_TRUNC('month', NOW()) + INTERVAL '1 month',
    NOW() - INTERVAL '15 days',
    NOW() - INTERVAL '1 day'
),
(
    'b2567890-5678-9abc-def0-123456789012',
    '01234567-89ab-cdef-0123-456789abcdef',
    'team_members',
    12,
    DATE_TRUNC('month', NOW()),
    DATE_TRUNC('month', NOW()) + INTERVAL '1 month',
    NOW() - INTERVAL '15 days',
    NOW() - INTERVAL '2 hours'
),
(
    'c3678901-6789-abcd-ef01-234567890123',
    '01234567-89ab-cdef-0123-456789abcdef',
    'telemetry_events',
    2847293,
    DATE_TRUNC('month', NOW()),
    DATE_TRUNC('month', NOW()) + INTERVAL '1 month',
    NOW() - INTERVAL '15 days',
    NOW() - INTERVAL '10 minutes'
),

-- TechStart current month usage
(
    'd4789012-789a-bcde-f012-345678901234',
    '12345678-9abc-def0-1234-56789abcdef0',
    'projects',
    3,
    DATE_TRUNC('month', NOW()),
    DATE_TRUNC('month', NOW()) + INTERVAL '1 month',
    NOW() - INTERVAL '10 days',
    NOW() - INTERVAL '1 hour'
),
(
    'e5890123-89ab-cdef-0123-456789012345',
    '12345678-9abc-def0-1234-56789abcdef0',
    'team_members',
    4,
    DATE_TRUNC('month', NOW()),
    DATE_TRUNC('month', NOW()) + INTERVAL '1 month',
    NOW() - INTERVAL '10 days',
    NOW() - INTERVAL '30 minutes'
),

-- DevTools Corp current month usage
(
    'f6901234-9abc-def0-1234-567890123456',
    '23456789-abcd-ef01-2345-6789abcdef01',
    'projects',
    25,
    DATE_TRUNC('month', NOW()),
    DATE_TRUNC('month', NOW()) + INTERVAL '1 month',
    NOW() - INTERVAL '20 days',
    NOW() - INTERVAL '6 hours'
),
(
    '01012345-abcd-ef01-2345-678901234567',
    '23456789-abcd-ef01-2345-6789abcdef01',
    'team_members',
    47,
    DATE_TRUNC('month', NOW()),
    DATE_TRUNC('month', NOW()) + INTERVAL '1 month',
    NOW() - INTERVAL '20 days',
    NOW() - INTERVAL '1 hour'
);

-- =============================================================================
-- PROJECTS
-- =============================================================================

INSERT INTO projects (id, organization_id, team_id, name, description, repository_url, repository_provider, repository_id, default_branch, language, framework, status, settings, last_analyzed_at, created_at, updated_at) VALUES
-- Acme Software projects
(
    '11123456-bcde-f012-3456-789012345678',
    '01234567-89ab-cdef-0123-456789abcdef',
    '34567890-bcde-f012-3456-789abcdef012',
    'User Authentication Service',
    'Microservice handling user authentication, authorization, and session management',
    'https://github.com/acmesoftware/auth-service',
    'github',
    'acmesoftware/auth-service',
    'main',
    'TypeScript',
    'Express.js',
    'active',
    '{"auto_deploy": true, "test_required": true, "security_scan": true}',
    NOW() - INTERVAL '2 hours',
    NOW() - INTERVAL '4 months',
    NOW() - INTERVAL '2 hours'
),
(
    '22234567-cdef-0123-4567-890123456789',
    '01234567-89ab-cdef-0123-456789abcdef',
    '45678901-cdef-0123-4567-89abcdef0123',
    'Customer Dashboard',
    'React-based customer-facing dashboard with real-time analytics',
    'https://github.com/acmesoftware/customer-dashboard',
    'github',
    'acmesoftware/customer-dashboard',
    'main',
    'TypeScript',
    'React',
    'active',
    '{"auto_deploy": false, "test_required": true, "lighthouse_checks": true}',
    NOW() - INTERVAL '6 hours',
    NOW() - INTERVAL '3 months',
    NOW() - INTERVAL '6 hours'
),
(
    '33345678-def0-1234-5678-901234567890',
    '01234567-89ab-cdef-0123-456789abcdef',
    '34567890-bcde-f012-3456-789abcdef012',
    'Payment Processing API',
    'High-throughput payment processing service with fraud detection',
    'https://github.com/acmesoftware/payment-api',
    'github',
    'acmesoftware/payment-api',
    'main',
    'Go',
    'Gin',
    'active',
    '{"auto_deploy": false, "test_required": true, "security_scan": true, "load_test": true}',
    NOW() - INTERVAL '1 day',
    NOW() - INTERVAL '6 months',
    NOW() - INTERVAL '1 day'
),

-- TechStart projects
(
    '44456789-ef01-2345-6789-012345678901',
    '12345678-9abc-def0-1234-56789abcdef0',
    '67890123-ef01-2345-6789-abcdef012345',
    'AI Code Assistant',
    'AI-powered code completion and suggestion tool for developers',
    'https://github.com/techstart/ai-code-assistant',
    'github',
    'techstart/ai-code-assistant',
    'develop',
    'Python',
    'FastAPI',
    'analyzing',
    '{"auto_deploy": true, "test_required": false, "ml_model_validation": true}',
    NOW() - INTERVAL '30 minutes',
    NOW() - INTERVAL '2 months',
    NOW() - INTERVAL '30 minutes'
),
(
    '55567890-f012-3456-789a-123456789012',
    '12345678-9abc-def0-1234-56789abcdef0',
    '67890123-ef01-2345-6789-abcdef012345',
    'Developer Portal',
    'Web portal for developers to interact with AI assistant and manage projects',
    'https://github.com/techstart/dev-portal',
    'github',
    'techstart/dev-portal',
    'main',
    'TypeScript',
    'Next.js',
    'active',
    '{"auto_deploy": true, "test_required": true}',
    NOW() - INTERVAL '4 hours',
    NOW() - INTERVAL '1 month',
    NOW() - INTERVAL '4 hours'
),

-- DevTools Corp projects
(
    '66678901-0123-4567-89ab-234567890123',
    '23456789-abcd-ef01-2345-6789abcdef01',
    '78901234-f012-3456-789a-bcdef0123456',
    'Enterprise CI/CD Platform',
    'Scalable continuous integration and deployment platform for enterprise teams',
    'https://github.com/devtools-corp/cicd-platform',
    'github',
    'devtools-corp/cicd-platform',
    'master',
    'Java',
    'Spring Boot',
    'active',
    '{"auto_deploy": false, "test_required": true, "security_scan": true, "performance_test": true}',
    NOW() - INTERVAL '3 hours',
    NOW() - INTERVAL '18 months',
    NOW() - INTERVAL '3 hours'
),
(
    '77789012-1234-5678-9abc-345678901234',
    '23456789-abcd-ef01-2345-6789abcdef01',
    '89012345-0123-4567-89ab-cdef01234567',
    'Code Analytics Dashboard',
    'Advanced analytics and insights dashboard for development teams',
    'https://github.com/devtools-corp/analytics-dashboard',
    'github',
    'devtools-corp/analytics-dashboard',
    'main',
    'TypeScript',
    'Vue.js',
    'active',
    '{"auto_deploy": true, "test_required": true, "accessibility_check": true}',
    NOW() - INTERVAL '8 hours',
    NOW() - INTERVAL '1 year',
    NOW() - INTERVAL '8 hours'
);

-- =============================================================================
-- API KEYS
-- =============================================================================

INSERT INTO api_keys (id, organization_id, project_id, name, key_hash, key_prefix, scopes, last_used_at, expires_at, is_active, created_by, created_at) VALUES
(
    '88890123-2345-6789-abcd-456789012345',
    '01234567-89ab-cdef-0123-456789abcdef',
    '11123456-bcde-f012-3456-789012345678',
    'Auth Service Production Key',
    '$2b$10$rKoZvMzFt8qJg5mWxN3uE.QIjPqJKLMNOPQRSTUVWXYZ123456789',
    'unrl_prod_',
    '["telemetry:write", "telemetry:read"]',
    NOW() - INTERVAL '1 hour',
    NOW() + INTERVAL '1 year',
    true,
    '9abc0123-4567-89ab-cdef-0123456789ab',
    NOW() - INTERVAL '2 months'
),
(
    '99901234-3456-789a-bcde-567890123456',
    '12345678-9abc-def0-1234-56789abcdef0',
    '44456789-ef01-2345-6789-012345678901',
    'AI Assistant Telemetry Key',
    '$2b$10$sLpAwNzGu9rKh6nXyO4vF.RJkQrKLMNOPQRSTUVWXYZ987654321',
    'unrl_dev_',
    '["telemetry:write"]',
    NOW() - INTERVAL '30 minutes',
    NOW() + INTERVAL '6 months',
    true,
    'cdef3456-789a-bcde-f012-3456789abcde',
    NOW() - INTERVAL '1 month'
);

-- =============================================================================
-- SUCCESS MESSAGE
-- =============================================================================

DO $$
DECLARE
    org_count INTEGER;
    user_count INTEGER;
    project_count INTEGER;
    membership_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO org_count FROM organizations;
    SELECT COUNT(*) INTO user_count FROM users;
    SELECT COUNT(*) INTO project_count FROM projects;
    SELECT COUNT(*) INTO membership_count FROM memberships;
    
    RAISE NOTICE '==================================================';
    RAISE NOTICE '🌱 DEVELOPMENT SEED DATA LOADED SUCCESSFULLY';
    RAISE NOTICE '==================================================';
    RAISE NOTICE 'Created:';
    RAISE NOTICE '  • % Organizations', org_count;
    RAISE NOTICE '  • % Users', user_count;
    RAISE NOTICE '  • % Projects', project_count;
    RAISE NOTICE '  • % Memberships', membership_count;
    RAISE NOTICE '';
    RAISE NOTICE 'Test Organizations:';
    RAISE NOTICE '  • Acme Software Inc (acme-software) - Professional Plan';
    RAISE NOTICE '  • TechStart Ventures (techstart) - Starter Plan';
    RAISE NOTICE '  • DevTools Corp (devtools-corp) - Enterprise Plan';
    RAISE NOTICE '';
    RAISE NOTICE 'Sample Login:';
    RAISE NOTICE '  • sarah.chen@acmesoftware.com (Owner, Acme Software)';
    RAISE NOTICE '  • alex.kim@techstart.io (Owner, TechStart)';
    RAISE NOTICE '  • david.lee@devtools-corp.com (Owner, DevTools Corp)';
    RAISE NOTICE '';
    RAISE NOTICE '🚀 Ready for development and testing!';
    RAISE NOTICE '==================================================';
END $$;