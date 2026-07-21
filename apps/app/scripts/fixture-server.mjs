#!/usr/bin/env node
// Tiny local fixture API for the render-verified Figma-fidelity loop
// (apps/app/docs/LANE-COMMON.md, DESIGN FIDELITY RULE). Node http only, zero
// deps. Serves realistic-SHAPED payloads for the routes the built app calls
// (src/api.ts) so the 5 designed frames can be rendered against real UI code
// with data that looks like a live analysis, without touching mcp.klauro.com.
//
// Fixture identity is deliberately fictional (no client/benchmark repo names
// per this repo's standing corpus-naming rule) — "Meridian" workspace with 3
// member codebases ("ledger-api", "checkout-web", "risk-engine"), one of
// which ("ledger-api") carries 7 capabilities (some flow-attached, some
// zero-flow) for the Repo overview / Flow List / Flow Overview frames.
//
// Run: node scripts/fixture-server.mjs [port]  (default 4174)
import { createServer } from 'node:http';

const PORT = Number(process.argv[2]) || 4174;
const TOKEN = 'fixture-token';

const now = Date.now();
const isoAgo = (ms) => new Date(now - ms).toISOString();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------
const WORKSPACE_ID = 'wsp_meridian';
const PROJECTS = {
  ledger_api: { id: 'prj_ledger_api', name: 'ledger-api', workspace_id: WORKSPACE_ID, analysis_id: 'an_ledger_api' },
  checkout_web: { id: 'prj_checkout_web', name: 'checkout-web', workspace_id: WORKSPACE_ID, analysis_id: 'an_checkout_web' },
  risk_engine: { id: 'prj_risk_engine', name: 'risk-engine', workspace_id: WORKSPACE_ID, analysis_id: 'an_risk_engine' },
};

const USERS = [
  { id: 'u_claudia', email: 'claudia@meridian.dev', name: 'Claudia Reyes', role: 'owner' },
  { id: 'u_michael', email: 'michael@meridian.dev', name: 'Michael Ortiz', role: 'admin' },
  { id: 'u_james', email: 'james@meridian.dev', name: 'James Whitfield', role: 'member' },
  { id: 'u_sarah', email: 'sarah@meridian.dev', name: 'Sarah Kim', role: 'member' },
  { id: 'u_timothy', email: 'timothy@meridian.dev', name: 'Timothy Osei', role: 'member' },
];

// ---------------------------------------------------------------------------
// /api/workspaces + /api/workspaces/:id/projects + /users
// ---------------------------------------------------------------------------
function workspacesPayload() {
  return {
    workspaces: [
      { id: WORKSPACE_ID, name: 'Meridian', role: 'owner', project_count: 3, user_count: USERS.length },
    ],
  };
}

function projectsForWorkspace() {
  return {
    projects: [
      { ...PROJECTS.ledger_api, repo_url: 'https://github.com/meridian/ledger-api' },
      { ...PROJECTS.checkout_web, repo_url: 'https://github.com/meridian/checkout-web' },
      { ...PROJECTS.risk_engine, repo_url: 'https://github.com/meridian/risk-engine' },
    ],
  };
}

function usersForWorkspace() {
  return { users: USERS };
}

function revisionsForProject(analysisId) {
  return {
    revisions: [
      {
        analysis_id: analysisId,
        analysis_revision: 3,
        branch: 'main',
        commit: 'a1b2c3d',
        source: 'push',
        generated_at: isoAgo(2 * HOUR),
        files: 842,
        bytes: 4_213_000,
        nodes: 6120,
        edges: 9834,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// /api/workspaces/:id/analysis (envelope: status/enrichment/last_attempt at
// top level, graph nested under `analysis`)
// ---------------------------------------------------------------------------
function workspaceAnalysis() {
  return {
    status: 'ready',
    workspace_id: WORKSPACE_ID,
    workspace_name: 'Meridian',
    generated_at: isoAgo(2 * HOUR),
    member_project_ids: [PROJECTS.ledger_api.id, PROJECTS.checkout_web.id, PROJECTS.risk_engine.id],
    member_project_names: ['ledger-api', 'checkout-web', 'risk-engine'],
    enrichment: { status: 'ai', started_at: isoAgo(2 * HOUR + 5 * MIN), completed_at: isoAgo(2 * HOUR) },
    last_attempt: { state: 'succeeded', trigger: 'push', started_at: isoAgo(2 * HOUR + 5 * MIN), finished_at: isoAgo(2 * HOUR), duration_ms: 41000 },
    analysis: {
      workspace_narrative: {
        title: 'Meridian',
        description: 'Fintech backend that manages auth, portfolios, trading, payments, and market data. Runs financial workflows across the Web App and Admin Panel within the monorepo.',
        product_value_summary: 'Settles trades and payments for retail brokerage customers with real-time risk checks.',
        value_drivers: ['Trade execution', 'Payment settlement', 'Risk signaling'],
        domains: ['fintech', 'trading', 'payments'],
        key_capabilities: ['Trade Execution', 'Portfolio Rebalancing', 'Payment Settlement'],
        relationship_summary: ['checkout-web calls ledger-api over REST', 'risk-engine consumes ledger-api events over Kafka'],
      },
      health: { status: 'healthy', score: 82, summary: 'No critical risk areas detected.', risk_area_count: 3, critical_risk_count: 0, high_risk_count: 1 },
      codebases: [
        { id: 'cb_ledger_api', name: 'ledger-api', path: `account-project:${PROJECTS.ledger_api.id}`, primary_domain: 'fintech', system_type: 'service', languages: ['TypeScript', 'Rust'], frameworks: ['NestJS', 'Fastify'] },
        { id: 'cb_checkout_web', name: 'checkout-web', path: `account-project:${PROJECTS.checkout_web.id}`, primary_domain: 'fintech', system_type: 'web-app', languages: ['TypeScript'], frameworks: ['React', 'Next.js'] },
        { id: 'cb_risk_engine', name: 'risk-engine', path: `account-project:${PROJECTS.risk_engine.id}`, primary_domain: 'fintech', system_type: 'service', languages: ['Python'], frameworks: ['FastAPI'] },
      ],
      applications: [
        { id: 'app_ledger_api', codebase_id: 'cb_ledger_api', name: 'ledger-api', kind: 'service', deployable: true, ports: ['8080'] },
        { id: 'app_checkout_web', codebase_id: 'cb_checkout_web', name: 'checkout-web', kind: 'web-app', deployable: true, ports: ['3000'] },
        { id: 'app_risk_engine', codebase_id: 'cb_risk_engine', name: 'risk-engine', kind: 'service', deployable: true, ports: ['8000'] },
      ],
      runtime_components: [
        { id: 'rc_web', codebase_id: 'cb_checkout_web', application_id: 'app_checkout_web', name: 'Web Application', kind: 'client' },
        { id: 'rc_mobile', codebase_id: 'cb_checkout_web', application_id: 'app_checkout_web', name: 'Mobile Application', kind: 'client' },
        { id: 'rc_api_gateway', codebase_id: 'cb_ledger_api', application_id: 'app_ledger_api', name: 'API Gateway', kind: 'gateway' },
        { id: 'rc_user', codebase_id: 'cb_ledger_api', application_id: 'app_ledger_api', name: 'User Service', kind: 'service' },
        { id: 'rc_billing', codebase_id: 'cb_ledger_api', application_id: 'app_ledger_api', name: 'Billing Service', kind: 'service' },
        { id: 'rc_payment', codebase_id: 'cb_ledger_api', application_id: 'app_ledger_api', name: 'Payment Service', kind: 'service' },
        { id: 'rc_notifications', codebase_id: 'cb_ledger_api', application_id: 'app_ledger_api', name: 'Notifications Service', kind: 'service' },
        { id: 'rc_analytics', codebase_id: 'cb_risk_engine', application_id: 'app_risk_engine', name: 'Analytics Service', kind: 'service' },
        { id: 'rc_data', codebase_id: 'cb_risk_engine', application_id: 'app_risk_engine', name: 'Data Warehouse', kind: 'datastore' },
      ],
      runtime_links: [
        { id: 'rl_1', codebase_id: 'cb_ledger_api', source_component_id: 'rc_web', target_component_id: 'rc_api_gateway', kind: 'http', evidence: ['fetch()'] },
        { id: 'rl_2', codebase_id: 'cb_ledger_api', source_component_id: 'rc_mobile', target_component_id: 'rc_api_gateway', kind: 'http', evidence: ['fetch()'] },
        { id: 'rl_3', codebase_id: 'cb_ledger_api', source_component_id: 'rc_api_gateway', target_component_id: 'rc_user', kind: 'rpc' },
        { id: 'rl_4', codebase_id: 'cb_ledger_api', source_component_id: 'rc_user', target_component_id: 'rc_billing', kind: 'rpc' },
        { id: 'rl_5', codebase_id: 'cb_ledger_api', source_component_id: 'rc_billing', target_component_id: 'rc_payment', kind: 'rpc' },
        { id: 'rl_6', codebase_id: 'cb_ledger_api', source_component_id: 'rc_api_gateway', target_component_id: 'rc_notifications', kind: 'event' },
        { id: 'rl_7', codebase_id: 'cb_ledger_api', source_component_id: 'rc_api_gateway', target_component_id: 'rc_analytics', kind: 'event' },
        { id: 'rl_8', codebase_id: 'cb_risk_engine', source_component_id: 'rc_analytics', target_component_id: 'rc_data', kind: 'sql' },
        { id: 'rl_9', codebase_id: 'cb_risk_engine', source_component_id: 'rc_payment', target_component_id: 'rc_analytics', kind: 'event' },
      ],
      application_links: [],
      summary: { codebases: 3, applications: 3, distribution_units: 3, composition_kind: 'monorepo', capabilities: 12, domains: 1, entities: 162, risk_areas: 3, workflows: 31 },
      // Forward-compat extras (workspaceHelpers.ts's getGraphExtras — real
      // server fields not yet promoted onto WorkspaceAnalysisResponse).
      inputs: [
        { project_id: PROJECTS.ledger_api.id, codebase_id: 'cb_ledger_api', cas_generated_at: isoAgo(27 * MIN), analysis_trust: { status: 'ready', freshness: 'fresh', confidence: 0.95 } },
        { project_id: PROJECTS.checkout_web.id, codebase_id: 'cb_checkout_web', cas_generated_at: isoAgo(2 * HOUR), analysis_trust: { status: 'ready', freshness: 'fresh', confidence: 0.9 } },
        { project_id: PROJECTS.risk_engine.id, codebase_id: 'cb_risk_engine', cas_generated_at: isoAgo(4 * DAY), analysis_trust: { status: 'ready', freshness: 'stale', confidence: 0.7 } },
      ],
      activity: {
        contributors: [
          { name: 'Claudia Reyes', projects: [PROJECTS.ledger_api.id, PROJECTS.checkout_web.id], commits_30d: 41, source: 'git' },
          { name: 'Michael Ortiz', projects: [PROJECTS.ledger_api.id], commits_30d: 28, source: 'git' },
          { name: 'James Whitfield', projects: [PROJECTS.checkout_web.id, PROJECTS.risk_engine.id], commits_30d: 19, source: 'git' },
          { name: 'Sarah Kim', projects: [PROJECTS.risk_engine.id], commits_30d: 12, source: 'git' },
          { name: 'Timothy Osei', projects: [PROJECTS.ledger_api.id], commits_30d: 9, source: 'git' },
        ],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// /api/projects/:id/analysis (ProjectAnalysisResponse — no envelope)
// ---------------------------------------------------------------------------
function projectAnalysis(projectId) {
  if (projectId !== PROJECTS.ledger_api.id) {
    return {
      status: 'ready',
      project_id: projectId,
      analysis_id: `an_${projectId}`,
      summary: {
        name: projectId === PROJECTS.checkout_web.id ? 'checkout-web' : 'risk-engine',
        type: 'service',
        languages: ['TypeScript'],
        frameworks: ['React'],
        primary_domain: 'fintech',
        description: 'Companion service in the Meridian workspace.',
        nodes: 900,
        edges: 1400,
        entry_points: 18,
        capabilities: 4,
        analysis_timestamp: isoAgo(4 * DAY),
        architecture_type: 'layered',
        database_entities: ['User', 'Session'],
      },
      product_map: { identity: { name: 'companion', domain: 'fintech', description: '', unanalyzed_languages: [] }, capabilities: [], data: { entities: 2, sensitive: [], exposure_highlights: [] }, health: {} },
      ai_enrichment: 'ready',
    };
  }
  return {
    status: 'ready',
    project_id: projectId,
    analysis_id: PROJECTS.ledger_api.analysis_id,
    summary: {
      name: 'ledger-api',
      type: 'service',
      languages: ['TypeScript', 'Rust'],
      frameworks: ['NestJS', 'Fastify'],
      primary_domain: 'fintech',
      description: 'Fintech backend that manages auth, portfolios, trading, payments, and market data. Runs financial workflows across the Web App and Admin Panel within the monorepo.',
      nodes: 6120,
      edges: 9834,
      entry_points: 42,
      capabilities: 6,
      top_capabilities: ['Trade Execution', 'Portfolio Rebalancing', 'Payment Settlement'],
      analysis_timestamp: isoAgo(2 * HOUR),
      ai_enrichment: 'ready',
      architecture_type: 'layered',
      architectural_patterns: [
        { name: 'Layered architecture', confidence: 0.92, category: 'structural' },
        { name: 'Event-driven messaging', confidence: 0.71, category: 'integration' },
      ],
      architecture_summary: {
        system_type: 'service',
        total_files: 842,
        layers: ['Controllers', 'Services', 'Repositories'],
        architectural_patterns: [{ name: 'Layered architecture', confidence: 0.92, category: 'structural' }],
        architectural_inventory: {},
        pattern_balance: null,
      },
      database_entities: ['User', 'Portfolio Analysis', 'Risk Signal', 'Trade', 'Ledger Entry'],
    },
    product_map: {
      identity: {
        name: 'ledger-api',
        domain: 'fintech',
        description: 'Fintech backend that manages auth, portfolios, trading, payments, and market data.',
        unanalyzed_languages: [],
      },
      capabilities: [
        { name: 'Trade Execution', description: 'Submit, validate, and settle buy/sell orders across all asset classes.', category: 'core', criticality: 'critical', entities: ['Order', 'Trade', 'Ledger Entry', 'Customer'], tests_present: true, risk_level: 'medium' },
        { name: 'Portfolio Rebalancing', description: 'Analyze drift vs. targets and auto-generate corrective orders.', category: 'core', criticality: 'high', entities: ['Portfolio', 'Order', 'Target Allocation', 'Trade', 'Customer'], tests_present: true, risk_level: 'medium' },
        { name: 'Payment Settlement', description: 'Orchestrate payment flows through Stripe with idempotency and retry.', category: 'core', criticality: 'critical', entities: ['Payment', 'Ledger Entry', 'Customer'], tests_present: true, risk_level: 'low' },
        { name: 'Risk Signaling', description: 'Compute exposure and volatility — flag risks for downstream clients.', category: 'supporting', criticality: 'high', entities: ['Risk Signal', 'Portfolio', 'Position', 'Trade', 'Customer'], tests_present: false, risk_level: 'high' },
        { name: 'Market Data Sync', description: 'Pull and normalize real-time pricing from external feeds via Kafka.', category: 'supporting', criticality: 'medium', entities: ['Price Tick', 'Instrument', 'Order', 'Trade'], tests_present: true, risk_level: 'low' },
        { name: 'Reporting & Audit', description: 'Generate compliance reports and a full state-change audit trail.', category: 'admin', criticality: 'medium', entities: ['Audit Entry', 'Report', 'Ledger Entry', 'Trade'], tests_present: false, risk_level: 'low' },
        { name: 'Access Control', description: 'Authenticate and authorize every request against roles and scopes.', category: 'internal', criticality: 'high', entities: ['User', 'Role'], tests_present: true, risk_level: 'low' },
      ],
      data: { entities: 162, sensitive: ['User.ssn', 'Payment.card_number'], exposure_highlights: [] },
      health: { domains: 1, entities: 162, risk_areas: 3 },
    },
    ai_enrichment: 'ready',
  };
}

// ---------------------------------------------------------------------------
// /api/projects/:id/conceptual (capabilities + flows + structural)
// ---------------------------------------------------------------------------
function flowSteps(names) {
  return names.map((n, i) => ({
    step_id: `step_${i + 1}`,
    order: i + 1,
    name: n,
    description: `${n} stage of the flow.`,
    contract: {
      input: ['Order'],
      logic: `${n} business logic`,
      side_effects: { state_changes: ['Order.status'], external_integrations: i === 1 ? ['Stripe'] : [] },
      output: ['Order'],
      constraints: ['Payment must be authorized before capture.'],
    },
    functions: [{ function_id: `fn_${i + 1}`, section: { start_line: 10 * (i + 1), end_line: 10 * (i + 1) + 8, label: `${n}()` } }],
  }));
}

// Flow-level ILSO contract (distinct from each step's own narrower
// contract) — FlowConcept.contract per api.ts, read by FlowDataSection +
// FlowSystemEffectsSection on the Flow Overview frame.
function flowContract(entities, integrations) {
  return {
    input: entities.slice(0, 2),
    logic: 'End-to-end flow logic across all steps.',
    side_effects: {
      state_changes: entities.map(e => `${e}.status`),
      external_integrations: integrations,
    },
    output: entities.slice(-2),
    constraints: ['Payment must be authorized before capture.', 'Fraud score must be below 0.8.'],
  };
}

const LEDGER_FLOWS = [
  { flow_id: 'flow_execute_transaction', name: 'Execute Transaction', intent: 'Validate and settle a customer trade end to end.', entry_point: 'POST /orders', capability_id: 'cap_trade_execution', capability_relationships: [{ capability_id: 'cap_trade_execution', role: 'primary', rationale: 'POST /orders is the trade-execution entry point.' }, { capability_id: 'cap_payment_settlement', role: 'supporting', rationale: 'Payment capture is a sub-stage of Execute Transaction.' }], role: 'core', entities: ['Order', 'Payment', 'Customer', 'Ledger Entry'], contract: flowContract(['Order', 'Payment', 'Customer', 'Ledger Entry'], ['Stripe']), steps: flowSteps(['Create Order', 'Validate Payment', 'Process Payment', 'Record Ledger', 'Send Receipt', 'Complete Transaction']) },
  { flow_id: 'flow_analysis_portfolio', name: 'Analysis Portfolio', intent: 'Recompute portfolio exposure and flag rebalancing risk.', entry_point: 'Scheduled: nightly-risk-scan', capability_id: 'cap_portfolio_rebalancing', capability_relationships: [{ capability_id: 'cap_portfolio_rebalancing', role: 'primary', rationale: 'nightly-risk-scan recomputes portfolio exposure.' }, { capability_id: 'cap_risk_signaling', role: 'supporting', rationale: 'Risk detection runs inside the portfolio scan.' }], role: 'core', entities: ['Portfolio', 'Position', 'Risk Signal'], contract: flowContract(['Portfolio', 'Position', 'Risk Signal'], []), steps: flowSteps(['Load Portfolio', 'Fetch Market Data', 'Calculate Exposure', 'Detect Risks', 'Generate Report']) },
  { flow_id: 'flow_connect_exchanges', name: 'Connect Exchanges', intent: 'Bridge order events to external exchange connectors.', entry_point: 'Kafka: order.created', capability_id: 'cap_market_data_sync', capability_relationships: [{ capability_id: 'cap_market_data_sync', role: 'primary', rationale: 'Exchange connectors feed order-created events.' }], role: 'infrastructure', entities: ['Order', 'Instrument'], contract: flowContract(['Order', 'Instrument'], []), steps: flowSteps(['Create Order', 'Validate Payment', 'Process Payment']) },
  { flow_id: 'flow_review_order', name: 'Review Order', intent: 'Manual compliance review for high-value orders.', entry_point: 'POST /orders/:id/review', capability_relationships: [{ capability_id: 'cap_trade_execution', role: 'supporting', rationale: 'Review gates trade execution for high-value orders.' }, { capability_id: 'cap_reporting_audit', role: 'observability', rationale: 'Review decisions feed the audit trail.' }], role: 'core', entities: ['Order', 'Customer', 'Audit Entry', 'Trade'], contract: flowContract(['Order', 'Customer', 'Audit Entry', 'Trade'], []), steps: flowSteps(['Load Order', 'Check Limits', 'Flag Anomalies', 'Approve', 'Record Decision']) },
  { flow_id: 'flow_update_inventory', name: 'Update Inventory', intent: 'Reconcile instrument inventory after settlement.', entry_point: 'Kafka: trade.settled', capability_relationships: [{ capability_id: 'cap_market_data_sync', role: 'supporting', rationale: 'Inventory reconciliation follows a settled trade event.' }], role: 'infrastructure', entities: ['Instrument', 'Trade', 'Ledger Entry'], contract: flowContract(['Instrument', 'Trade', 'Ledger Entry'], []), steps: flowSteps(['Load Trade', 'Update Position', 'Reconcile Inventory', 'Notify', 'Complete', 'Archive']) },
  { flow_id: 'flow_generate_invoice', name: 'Generate Invoice', intent: 'Produce a billing invoice for settled trades.', entry_point: 'Scheduled: monthly-billing', capability_relationships: [{ capability_id: 'cap_reporting_audit', role: 'primary', rationale: 'Invoice generation is a reporting deliverable.' }], role: 'supporting', entities: ['Invoice', 'Trade', 'Customer'], contract: flowContract(['Invoice', 'Trade', 'Customer'], []), steps: flowSteps(['Load Trades', 'Aggregate Fees', 'Generate Invoice', 'Send']) },
  { flow_id: 'flow_apply_discount', name: 'Apply Discount', intent: 'Apply loyalty-tier fee discounts to an order.', entry_point: 'POST /orders/:id/discount', capability_relationships: [], role: 'infrastructure', entities: ['Order', 'Customer'], contract: flowContract(['Order', 'Customer'], []), steps: flowSteps(['Load Customer', 'Check Tier', 'Apply Discount', 'Recalculate Total', 'Log', 'Persist', 'Complete']) },
];

function conceptual(projectId) {
  if (projectId !== PROJECTS.ledger_api.id) {
    return {
      status: 'ready', project_id: projectId, analysis_id: `an_${projectId}`,
      capabilities: [], flows: { flows: [], total: 0 },
      structural: { architectural: { conflicts: [] }, paradigms: { total: 0, total_deviations: 0, paradigms: [] }, perspectives: [] },
    };
  }
  return {
    status: 'ready',
    project_id: projectId,
    analysis_id: PROJECTS.ledger_api.analysis_id,
    capabilities: [
      { id: 'cap_trade_execution', name: 'Trade Execution', category: 'core', criticality: 'critical', related_flows: [{ flow_id: 'flow_execute_transaction', role: 'primary', rationale: 'POST /orders is the trade-execution entry point.' }] },
      { id: 'cap_portfolio_rebalancing', name: 'Portfolio Rebalancing', category: 'core', criticality: 'high', related_flows: [{ flow_id: 'flow_analysis_portfolio', role: 'primary', rationale: 'nightly-risk-scan recomputes portfolio exposure.' }] },
      { id: 'cap_payment_settlement', name: 'Payment Settlement', category: 'core', criticality: 'critical', related_flows: [{ flow_id: 'flow_execute_transaction', role: 'supporting', rationale: 'Payment capture is a sub-stage of Execute Transaction.' }] },
      { id: 'cap_risk_signaling', name: 'Risk Signaling', category: 'supporting', criticality: 'high', related_flows: [{ flow_id: 'flow_analysis_portfolio', role: 'supporting', rationale: 'Risk detection runs inside the portfolio scan.' }] },
      { id: 'cap_market_data_sync', name: 'Market Data Sync', category: 'supporting', criticality: 'medium', related_flows: [{ flow_id: 'flow_connect_exchanges', role: 'primary', rationale: 'Exchange connectors feed order-created events.' }] },
      { id: 'cap_reporting_audit', name: 'Reporting & Audit', category: 'admin', criticality: 'medium', related_flows: [] },
      { id: 'cap_access_control', name: 'Access Control', category: 'internal', criticality: 'high', related_flows: [] },
    ],
    flows: { flows: LEDGER_FLOWS, total: LEDGER_FLOWS.length },
    structural: {
      architectural: {
        total_conflicts: 1,
        total_principle_violations: 2,
        principle_violations_by_severity: { warning: 2 },
        principle_violations_by_principle: { 'single-responsibility': 2 },
        conflicts: [],
        principle_violations: [],
        is_cohesive: true,
      },
      paradigms: { total: 1, total_deviations: 2, paradigms: [] },
      perspectives: [],
    },
  };
}

// ---------------------------------------------------------------------------
// /api/projects/:id/cas (full CAS mirror — trimmed but shaped)
// ---------------------------------------------------------------------------
function cas(projectId) {
  if (projectId !== PROJECTS.ledger_api.id) {
    return { status: 'ready', project_id: projectId, analysis_id: `an_${projectId}`, analysis_timestamp: isoAgo(4 * DAY), cas: { nodes: [], external_services: [], libraries: [], dependency_manifest: { manifests: [], dependencies: [], total: 0 }, deployable_evidence: [], data_entities: [] } };
  }
  return {
    status: 'ready',
    project_id: projectId,
    analysis_id: PROJECTS.ledger_api.analysis_id,
    analysis_timestamp: isoAgo(2 * HOUR),
    cas: {
      nodes: [],
      external_services: [
        { id: 'svc_stripe', name: 'Stripe', type: 'payment', purpose: 'production', description: 'Payment capture and refunds.', provider: 'stripe' },
        { id: 'svc_postgres', name: 'Postgresql', type: 'database', purpose: 'bidirectional', description: 'Primary transactional store.', provider: 'postgresql' },
        { id: 'svc_auth0', name: 'Auth0', type: 'auth', purpose: 'consumption', description: 'Authentication and identity.', provider: 'auth0' },
        { id: 'svc_sendgrid', name: 'SendGrid', type: 'email', purpose: 'production', description: 'Transactional email.', provider: 'sendgrid' },
        { id: 'svc_sentry', name: 'Sentry', type: 'observability', purpose: 'production', description: 'Error tracking.', provider: 'aws' },
        { id: 'svc_segment', name: 'Segment', type: 'analytics', purpose: 'production', description: 'Product analytics pipeline.', provider: 'segment' },
      ],
      libraries: [
        { id: 'lib_nestjs', name: 'NestJS', type: 'production', category: 'framework' },
        { id: 'lib_fastify', name: 'Fastify', type: 'production', category: 'framework' },
        { id: 'lib_jest', name: 'Jest', type: 'development', category: 'testing' },
      ],
      dependency_manifest: { manifests: ['package.json', 'Cargo.toml'], dependencies: [], total: 58 },
      deployable_evidence: [],
      data_entities: [],
    },
  };
}

// ---------------------------------------------------------------------------
// /api/account/activity + /api/workspaces/:id/activity (ChangeActivityEvent[])
// ---------------------------------------------------------------------------
function changeActivity() {
  return {
    events: [
      { type: 'analysis_completed', at: isoAgo(2 * HOUR), workspace_id: WORKSPACE_ID, project_id: PROJECTS.ledger_api.id, title: 'Checkout flow updated', detail: 'Payment service — 3 impacted services', deltas: { nodes: 12, edges: 21 } },
      { type: 'project_created', at: isoAgo(5 * HOUR), workspace_id: WORKSPACE_ID, project_id: PROJECTS.risk_engine.id, title: 'New entity added', detail: 'User Service — used in 4 flows' },
      { type: 'analysis_completed', at: isoAgo(1 * DAY), workspace_id: WORKSPACE_ID, project_id: PROJECTS.checkout_web.id, title: 'API endpoint modified', detail: 'Api Gateway', deltas: { nodes: 3, edges: 5 } },
      { type: 'workspace_rebuilt', at: isoAgo(2 * DAY), workspace_id: WORKSPACE_ID, title: 'Database schema change', detail: 'Analytics Service' },
    ],
    next_cursor: null,
  };
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------
function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(json);
}

function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}

const routes = [
  { method: 'POST', pattern: /^\/api\/auth\/login$/, handler: async () => ({ token: TOKEN, user: { id: 'u_claudia', email: 'claudia@meridian.dev', name: 'Claudia Reyes' } }) },
  { method: 'POST', pattern: /^\/api\/auth\/register$/, handler: async () => ({ token: TOKEN, user: { id: 'u_claudia', email: 'claudia@meridian.dev', name: 'Claudia Reyes' } }) },
  { method: 'GET', pattern: /^\/api\/me$/, handler: async () => ({ user: { id: 'u_claudia', email: 'claudia@meridian.dev', name: 'Claudia Reyes' } }) },
  { method: 'GET', pattern: /^\/api\/workspaces$/, handler: async () => workspacesPayload() },
  { method: 'GET', pattern: /^\/api\/workspaces\/([^/]+)\/projects$/, handler: async () => projectsForWorkspace() },
  { method: 'GET', pattern: /^\/api\/workspaces\/([^/]+)\/users$/, handler: async () => usersForWorkspace() },
  { method: 'GET', pattern: /^\/api\/workspaces\/([^/]+)\/analysis$/, handler: async () => workspaceAnalysis() },
  { method: 'GET', pattern: /^\/v1\/projects\/([^/]+)\/revisions$/, handler: async (m) => revisionsForProject(m[1]) },
  { method: 'GET', pattern: /^\/api\/projects\/([^/]+)\/analysis$/, handler: async (m) => projectAnalysis(decodeURIComponent(m[1])) },
  { method: 'GET', pattern: /^\/api\/projects\/([^/]+)\/conceptual$/, handler: async (m) => conceptual(decodeURIComponent(m[1])) },
  { method: 'GET', pattern: /^\/api\/projects\/([^/]+)\/cas$/, handler: async (m) => cas(decodeURIComponent(m[1])) },
  { method: 'GET', pattern: /^\/api\/account\/activity$/, handler: async () => changeActivity() },
  { method: 'GET', pattern: /^\/api\/workspaces\/([^/]+)\/activity$/, handler: async () => changeActivity() },
];

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
    res.end();
    return;
  }
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const route = routes.find(r => r.method === req.method && r.pattern.test(url.pathname));
  if (!route) {
    send(res, 404, { error: `No fixture route for ${req.method} ${url.pathname}` });
    return;
  }
  await readBody(req);
  const match = route.pattern.exec(url.pathname);
  try {
    const body = await route.handler(match);
    send(res, 200, body);
  } catch (err) {
    send(res, 500, { error: String(err) });
  }
});

server.listen(PORT, () => {
  console.log(`[fixture-server] listening on http://localhost:${PORT}`);
});
