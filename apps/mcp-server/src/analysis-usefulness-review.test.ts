import test from 'node:test';
import assert from 'node:assert/strict';
import { findArchitectureSystemTypeProblems, findDomainBreadthProblems, findWeakDescriptionReasons, reviewAnalysisUsefulnessStatic, scoreArchitectureAgentContext, scoreDescriptionQuality, scoreDuplicationAvoidance } from './analysis-usefulness-review';

test('usefulness review flags framework-only architecture identity for MCP analyzer monorepos', () => {
  const cas: any = {
    nodes: [
      {
        id: 'mcp-server',
        name: 'server.ts',
        type: 'file',
        source: { file: 'apps/mcp-server/src/server.ts' },
      },
      {
        id: 'orchestrator',
        name: 'AnalyzerOrchestrator',
        type: 'class',
        source: { file: 'packages/analyzer-core/src/analyzer/core/orchestrator.ts' },
      },
    ],
    architecture_summary: {
      system_type: 'Express.js',
    },
  };

  const problems = findArchitectureSystemTypeProblems(cas, {
    kind: 'cli-tool',
    confidence: 0.9,
    evidence: ['CLI/bin/command signals'],
    expectations: {
      entry_points: 'required',
      call_chains: 'required',
      behavioral_invariants: 'required',
      security: 'optional',
      runtime_correlation: 'optional',
      flow_coverage: 'required',
    },
  });

  assert.match(problems.join('\n'), /MCP analyzer monorepo/);
});

test('usefulness review accepts specific MCP analyzer architecture identity', () => {
  const cas: any = {
    nodes: [
      {
        id: 'mcp-server',
        name: 'server.ts',
        type: 'file',
        source: { file: 'apps/mcp-server/src/server.ts' },
      },
      {
        id: 'orchestrator',
        name: 'AnalyzerOrchestrator',
        type: 'class',
        source: { file: 'packages/analyzer-core/src/analyzer/core/orchestrator.ts' },
      },
    ],
    architecture_summary: {
      system_type: 'MCP analyzer monorepo',
    },
  };

  const problems = findArchitectureSystemTypeProblems(cas, {
    kind: 'cli-tool',
    confidence: 0.9,
    evidence: ['CLI/bin/command signals'],
    expectations: {
      entry_points: 'required',
      call_chains: 'required',
      behavioral_invariants: 'required',
      security: 'optional',
      runtime_correlation: 'optional',
      flow_coverage: 'required',
    },
  });

  assert.deepEqual(problems, []);
});

test('usefulness review flags infrastructure and desktop system type mismatches', () => {
  const infrastructureProblems = findArchitectureSystemTypeProblems({
    nodes: [{ id: 'tf', name: 'main.tf', type: 'infrastructure_file', source: { file: 'main.tf' } }],
    architecture_summary: { system_type: 'Application' },
  } as any, {
    kind: 'infrastructure',
    confidence: 0.95,
    evidence: ['infrastructure manifest/path'],
    expectations: {
      entry_points: 'not-applicable',
      call_chains: 'not-applicable',
      behavioral_invariants: 'optional',
      security: 'optional',
      runtime_correlation: 'optional',
      flow_coverage: 'not-applicable',
    },
  });

  const desktopProblems = findArchitectureSystemTypeProblems({
    nodes: [{ id: 'window', name: 'MainWindow', type: 'class', source: { file: 'Presentation/MainWindow.xaml.cs' } }],
    architecture_summary: { system_type: 'CLI application' },
  } as any, {
    kind: 'cli-tool',
    confidence: 0.84,
    evidence: ['CLI/bin/command signals'],
    expectations: {
      entry_points: 'required',
      call_chains: 'required',
      behavioral_invariants: 'required',
      security: 'optional',
      runtime_correlation: 'optional',
      flow_coverage: 'required',
    },
  });

  assert.match(infrastructureProblems.join('\n'), /infrastructure shape/);
  assert.match(desktopProblems.join('\n'), /desktop application as CLI/);
});

test('usefulness review flags desktop and backend monorepo architecture identity mismatches', () => {
  const desktopProblems = findArchitectureSystemTypeProblems({
    nodes: [
      { id: 'main', name: 'ElectronMain', type: 'class', source: { file: 'src/main/index.ts' } },
      { id: 'controller', name: 'LocalController', type: 'controller', source: { file: 'src/main/local-server.ts' } },
    ],
    architecture_summary: { system_type: 'Express.js' },
  } as any, {
    kind: 'desktop-app',
    confidence: 0.9,
    evidence: ['Electron/Tauri/desktop project signals'],
    expectations: {
      entry_points: 'required',
      call_chains: 'required',
      behavioral_invariants: 'required',
      security: 'optional',
      runtime_correlation: 'optional',
      flow_coverage: 'required',
    },
  });

  const backendProblems = findArchitectureSystemTypeProblems({
    nodes: [
      { id: 'admin', name: 'AdminController', type: 'controller', source: { file: 'apps/admin-api/src/app/admin.controller.ts' } },
      { id: 'mcp', name: 'McpController', type: 'controller', source: { file: 'apps/mcp-api/src/app/app.controller.ts' } },
      { id: 'auth', name: 'AuthModule', type: 'module', source: { file: 'packages/auth/src/auth.module.ts' } },
    ],
    architecture_summary: { system_type: 'MCP server' },
  } as any, {
    kind: 'backend-service',
    confidence: 0.92,
    evidence: ['HTTP/API framework or entry points'],
    expectations: {
      entry_points: 'required',
      call_chains: 'required',
      behavioral_invariants: 'required',
      security: 'required',
      runtime_correlation: 'optional',
      flow_coverage: 'required',
    },
  });

  assert.match(desktopProblems.join('\n'), /desktop-app profile/);
  assert.match(backendProblems.join('\n'), /one MCP-named app/);
});

test('usefulness review flags incidental short and auth capability labels in descriptions', () => {
  const reasons = findWeakDescriptionReasons({
    enhanced_system_purpose: {
      primary_domain: 'standup',
      core_concepts: ['standup', 'project', 'blog'],
    },
    domain_concepts: [{ name: 'standup' }, { name: 'project' }],
  } as any, {
    kind: 'backend-service',
    confidence: 0.9,
    evidence: ['HTTP/API framework or entry points'],
    expectations: {
      entry_points: 'required',
      call_chains: 'required',
      behavioral_invariants: 'required',
      security: 'required',
      runtime_correlation: 'optional',
      flow_coverage: 'required',
    },
  }, 'A standup system built with Django. Key capabilities: standup management, str management, autenticacion management, select project management, links management, events handlers.');

  assert.match(reasons.join('\n'), /artifact capability labels/);
  assert.match(reasons.join('\n'), /handler labels/);
});

test('usefulness review flags auth/login domain when broader product entities dominate', () => {
  const cas: any = {
    system_capabilities: [
      { name: 'Login Management' },
      { name: 'Product Management' },
      { name: 'Post Management' },
      { name: 'Company Source Management' },
    ],
    data_entities: [
      { name: 'ProductConnection' },
      { name: 'CompanySourceLog' },
    ],
    domain_concepts: [
      { name: 'product' },
      { name: 'company source' },
    ],
  };

  const problems = findDomainBreadthProblems(cas, {
    kind: 'backend-service',
    confidence: 0.9,
    evidence: ['HTTP/API framework or entry points'],
    expectations: {
      entry_points: 'required',
      call_chains: 'required',
      behavioral_invariants: 'required',
      security: 'required',
      runtime_correlation: 'optional',
      flow_coverage: 'required',
    },
  }, 'login');

  assert.match(problems.join('\n'), /too narrow/);
  assert.match(problems.join('\n'), /product/);
});

test('usefulness review flags parser and HTTP artifact capability labels in descriptions', () => {
  const reasons = findWeakDescriptionReasons({
    enhanced_system_purpose: {
      primary_domain: 'product-data-management',
      core_concepts: ['product', 'company-source', 'record'],
    },
    domain_concepts: [{ name: 'product' }, { name: 'company-source' }],
    system_capabilities: [{ name: 'Product Management' }, { name: 'Company Source Management' }],
  } as any, {
    kind: 'backend-service',
    confidence: 0.9,
    evidence: ['HTTP/API framework or entry points'],
    expectations: {
      entry_points: 'required',
      call_chains: 'required',
      behavioral_invariants: 'required',
      security: 'required',
      runtime_correlation: 'optional',
      flow_coverage: 'required',
    },
  }, 'A product data management system built with Django. Key capabilities: product management, method management, put management, checkconnectivity management, authenticated capability. Data model: ProductConnection and CompanySourceLog. Entry points: 90 http.');

  assert.match(reasons.join('\n'), /artifact capability labels/);
});

test('usefulness review does not treat legitimate account management as parser artifact wording', () => {
  const reasons = findWeakDescriptionReasons({
    enhanced_system_purpose: {
      primary_domain: 'commerce-operations-portal',
      core_concepts: ['account', 'cart', 'checkout', 'order'],
    },
    domain_concepts: [{ name: 'account' }, { name: 'checkout' }],
    system_capabilities: [{ name: 'Account Management' }, { name: 'Order Management' }],
  } as any, {
    kind: 'frontend-app',
    confidence: 0.9,
    evidence: ['frontend framework, page, or route signals'],
    expectations: {
      entry_points: 'required',
      call_chains: 'required',
      behavioral_invariants: 'required',
      security: 'optional',
      runtime_correlation: 'optional',
      flow_coverage: 'required',
    },
  }, 'A commerce operations portal for account management, company management, cart handling, checkout, orders, invoice review, billing, search, and location workflows.');

  assert.doesNotMatch(reasons.join('\n'), /artifact capability labels/);
});

test('usefulness review accepts command-line interface claims when CAS has CLI entry points', () => {
  const reasons = findWeakDescriptionReasons({
    enhanced_system_purpose: {
      primary_domain: 'standup',
      core_concepts: ['standup', 'project', 'role'],
    },
    domain_concepts: [{ name: 'standup' }, { name: 'project' }],
    entry_points: [{ id: 'cli', type: 'cli', name: 'manage.py command' }],
    system_capabilities: [{ name: 'Standup Management' }],
  } as any, {
    kind: 'backend-service',
    confidence: 0.9,
    evidence: ['HTTP/API framework or entry points'],
    expectations: {
      entry_points: 'required',
      call_chains: 'required',
      behavioral_invariants: 'required',
      security: 'required',
      runtime_correlation: 'optional',
      flow_coverage: 'required',
    },
  }, 'The standup service manages standup workflows, project membership, user roles, and project details through HTTP endpoints and a command-line interface used for operational tasks.');

  assert.doesNotMatch(reasons.join('\n'), /unsupported command-line interface/);
});

test('usefulness review grounds short package names through integration evidence', () => {
  const reasons = findWeakDescriptionReasons({
    enhanced_system_purpose: {
      primary_domain: 'commerce-operations-portal',
      core_concepts: ['account', 'cart', 'checkout', 'order'],
    },
    domain_concepts: [{ name: 'account' }, { name: 'checkout' }],
    system_capabilities: [{ name: 'Account Management' }, { name: 'Checkout Management' }],
    external_services: [{ name: 'Jose', type: 'library' }, { name: 'Apollo Angular', type: 'library' }],
  } as any, {
    kind: 'frontend-app',
    confidence: 0.9,
    evidence: ['frontend framework, page, or route signals'],
    expectations: {
      entry_points: 'required',
      call_chains: 'required',
      behavioral_invariants: 'required',
      security: 'optional',
      runtime_correlation: 'optional',
      flow_coverage: 'required',
    },
  }, 'This frontend system is a commerce operations portal built with Angular for account management, cart handling, checkout, order processing, invoice generation, and location settings. It integrates with Apollo Angular and Jose for data retrieval and authentication support.');

  assert.doesNotMatch(reasons.join('\n'), /unexplained short proper-noun/);
});

test('usefulness review grounds short proper nouns in repo languages, frameworks, and package names', () => {
  const reasons = findWeakDescriptionReasons({
    system: {
      name: 'washup',
      technologies: {
        languages: [{ name: 'Ruby' }, { name: 'TypeScript' }],
        frameworks: [{ name: 'Rails' }, { name: 'React' }],
      },
    },
    enhanced_system_purpose: {
      primary_domain: 'order-management',
      core_concepts: ['order', 'shift', 'incident', 'location'],
    },
    domain_concepts: [{ name: 'order' }, { name: 'shift' }],
    system_capabilities: [{ name: 'Order Management' }, { name: 'Shift Management' }],
    libraries: [{ name: 'activerecord' }],
  } as any, {
    kind: 'backend-service',
    confidence: 0.9,
    evidence: ['HTTP/API framework or entry points'],
    expectations: {
      entry_points: 'required',
      call_chains: 'required',
      behavioral_invariants: 'required',
      security: 'required',
      runtime_correlation: 'optional',
      flow_coverage: 'required',
    },
  }, 'A system for managing orders and related workflows, focusing on user, location, shift, and incident coordination. It uses Rails, Ruby, and React for HTTP endpoints and message handling, connecting to ActiveRecord for data storage.');

  assert.doesNotMatch(reasons.join('\n'), /unexplained short proper-noun/);
});

test('usefulness review grounds short proper nouns in the repo name and entity vocabulary', () => {
  const reasons = findWeakDescriptionReasons({
    system: { name: 'soon-infra' },
    enhanced_system_purpose: {
      primary_domain: 'cloud-infrastructure',
      core_concepts: ['module', 'provider', 'variable', 'output'],
    },
    domain_concepts: [{ name: 'module' }, { name: 'provider' }],
    database_schema: { entities: [{ name: 'Deck' }] },
    system_capabilities: [{ name: 'Resource Provisioning' }],
  } as any, {
    kind: 'infrastructure',
    confidence: 0.9,
    evidence: ['terraform modules'],
    expectations: {
      entry_points: 'optional',
      call_chains: 'optional',
      behavioral_invariants: 'optional',
      security: 'optional',
      runtime_correlation: 'optional',
      flow_coverage: 'optional',
    },
  }, 'The Soon platform infrastructure defines deployment resources and operational boundaries with modules, providers, variables, and outputs, including Deck record provisioning for server configurations and resource groups.');

  assert.doesNotMatch(reasons.join('\n'), /unexplained short proper-noun/);
});

test('usefulness review still flags short proper nouns with no grounding in the analysis', () => {
  const reasons = findWeakDescriptionReasons({
    system: { name: 'washup' },
    enhanced_system_purpose: {
      primary_domain: 'order-management',
      core_concepts: ['order', 'shift', 'incident', 'location'],
    },
    domain_concepts: [{ name: 'order' }, { name: 'shift' }],
    system_capabilities: [{ name: 'Order Management' }],
  } as any, {
    kind: 'backend-service',
    confidence: 0.9,
    evidence: ['HTTP/API framework or entry points'],
    expectations: {
      entry_points: 'required',
      call_chains: 'required',
      behavioral_invariants: 'required',
      security: 'required',
      runtime_correlation: 'optional',
      flow_coverage: 'required',
    },
  }, 'A system for managing orders and related workflows, focusing on user, location, shift, and incident coordination. It relies on Zorp to schedule order processing and incident escalation across locations.');

  assert.match(reasons.join('\n'), /unexplained short proper-noun/);
});

test('description quality gate accepts AI-backed descriptions that orient agents to behavior', () => {
  const profile: any = {
    kind: 'backend-service',
    confidence: 0.9,
    evidence: ['HTTP/API framework or entry points'],
    expectations: {
      entry_points: 'required',
      call_chains: 'required',
      behavioral_invariants: 'required',
      security: 'required',
      runtime_correlation: 'optional',
      flow_coverage: 'required',
    },
  };
  const gate = scoreDescriptionQuality({
    enhanced_system_purpose: {
      primary_domain: 'agent-analysis',
      core_concepts: ['work packet', 'idiom guidance', 'change risk'],
      inferred_description: 'Klauro analyzes source repositories into a CAS relationship graph that gives coding agents compact work packets, local idiom guidance, change-risk context, and targeted validation steps before they edit files.',
      description_source: 'ai',
      description_generation: { status: 'ai_applied', attempted: true },
    },
    domain_concepts: [{ name: 'work packet' }, { name: 'idiom guidance' }],
    system_capabilities: [
      {
        id: 'work-packets',
        name: 'Agent Work Packets',
        category: 'core',
        criticality: 'critical',
        description: 'Turns graph matches, risk signals, idioms, and nearby tests into a compact coding brief so agents can start with the right files and validation plan.',
        description_source: 'ai',
        description_generation: { status: 'ai_applied', attempted: true },
        operations: [{ action: 'query' }],
        related_entities: ['CASAnalysis'],
        related_domains: ['agent-analysis'],
      },
      {
        id: 'idioms',
        name: 'Codebase Idiom Guidance',
        category: 'core',
        criticality: 'high',
        description: 'Extracts repo-local naming, placement, dependency, validation, and testing conventions so generated changes follow the style already proven in the codebase.',
        description_source: 'ai',
        description_generation: { status: 'ai_applied', attempted: true },
        operations: [{ action: 'validate' }],
        related_entities: ['CodebaseIdiom'],
        related_domains: ['agent-analysis'],
      },
      {
        id: 'storage',
        name: 'Analysis Storage',
        category: 'supporting',
        criticality: 'medium',
        description: 'Maintains CAS outputs, snapshots, and compressed artifacts so agents can compare historical states without rediscovering the repository from scratch.',
        description_source: 'ai',
        description_generation: { status: 'ai_applied', attempted: true },
        operations: [{ action: 'read' }],
        related_entities: ['AnalysisSnapshot'],
        related_domains: ['agent-analysis'],
      },
    ],
  } as any, profile);

  assert.equal(gate.status, 'pass');
});

test('description quality gate fails rejected AI fallbacks that leak structural capability text', () => {
  const profile: any = {
    kind: 'backend-service',
    confidence: 0.9,
    evidence: ['HTTP/API framework or entry points'],
    expectations: {
      entry_points: 'required',
      call_chains: 'required',
      behavioral_invariants: 'required',
      security: 'required',
      runtime_correlation: 'optional',
      flow_coverage: 'required',
    },
  };
  const gate = scoreDescriptionQuality({
    enhanced_system_purpose: {
      primary_domain: 'agent-analysis',
      core_concepts: ['work packet', 'idiom guidance', 'change risk'],
      inferred_description: 'Klauro analyzes source repositories into a CAS relationship graph that gives coding agents compact work packets, local idiom guidance, change-risk context, and targeted validation steps before they edit files.',
      description_source: 'ai',
      description_generation: { status: 'ai_applied', attempted: true },
    },
    domain_concepts: [{ name: 'work packet' }, { name: 'idiom guidance' }],
    system_capabilities: [
      {
        id: 'greenfield',
        name: 'Greenfield Planning',
        category: 'core',
        criticality: 'critical',
        description: 'supports read, process behavior; spans greenfield handlers and internal files.',
        description_source: 'deterministic',
        description_generation: { status: 'ai_rejected', attempted: true, reason: 'generic structural phrase' },
        operations: [{ action: 'read' }],
        related_entities: ['Plan'],
        related_domains: ['agent-analysis'],
      },
      {
        id: 'machine-gauntlet',
        name: 'Machine Repo Gauntlet',
        category: 'core',
        criticality: 'high',
        description: 'coordinates internal files and supports tasks for machine repo gauntlet operations.',
        description_source: 'deterministic',
        description_generation: { status: 'ai_rejected', attempted: true, reason: 'generic structural phrase' },
        operations: [{ action: 'process' }],
        related_entities: ['Repo'],
        related_domains: ['agent-analysis'],
      },
      {
        id: 'answer-packs',
        name: 'Answer Packs',
        category: 'core',
        criticality: 'high',
        description: 'handles operations for answer packs functionality.',
        description_source: 'deterministic',
        description_generation: { status: 'ai_failed', attempted: true, reason: 'provider error' },
        operations: [{ action: 'read' }],
        related_entities: ['Answer'],
        related_domains: ['agent-analysis'],
      },
    ],
  } as any, profile);

  assert.equal(gate.status, 'fail');
  assert.match(gate.detail, /capability descriptions weak/);
  assert.match(gate.detail, /AI generation failed or was rejected/);
});

test('description quality gate accepts hedged descriptions that acknowledge a dominant unanalyzed language', () => {
  const profile: any = {
    kind: 'backend-service',
    confidence: 0.9,
    evidence: ['HTTP/API framework or entry points'],
    expectations: {
      entry_points: 'required',
      call_chains: 'required',
      behavioral_invariants: 'required',
      security: 'required',
      runtime_correlation: 'optional',
      flow_coverage: 'required',
    },
  };
  const gate = scoreDescriptionQuality({
    system: {
      technologies: {
        unanalyzed_languages: [{ name: 'Ruby', files: 289, share_of_source: 79 }],
      },
    },
    enhanced_system_purpose: {
      primary_domain: 'asset-pipeline',
      core_concepts: ['asset', 'pipeline'],
      inferred_description: 'This analysis covers only the analyzed TypeScript tooling; Ruby is 79% of source and was not analyzed by CAS.',
      description_source: 'ai',
      description_generation: { status: 'ai_applied', attempted: true },
    },
    domain_concepts: [{ name: 'asset' }, { name: 'pipeline' }],
    system_capabilities: [],
  } as any, profile);

  assert.doesNotMatch(gate.detail, /system description weak/);
  assert.doesNotMatch(gate.detail, /does not acknowledge/);
});

test('description quality gate warns when the description ignores a dominant unanalyzed language', () => {
  const profile: any = {
    kind: 'backend-service',
    confidence: 0.9,
    evidence: ['HTTP/API framework or entry points'],
    expectations: {
      entry_points: 'required',
      call_chains: 'required',
      behavioral_invariants: 'required',
      security: 'required',
      runtime_correlation: 'optional',
      flow_coverage: 'required',
    },
  };
  const gate = scoreDescriptionQuality({
    system: {
      technologies: {
        unanalyzed_languages: [{ name: 'Ruby', files: 289, share_of_source: 79 }],
      },
    },
    enhanced_system_purpose: {
      primary_domain: 'asset-pipeline',
      core_concepts: ['asset', 'pipeline'],
      inferred_description: 'Washup tracks asset pipeline jobs and exposes a CLI that prepares asset metadata for downstream rendering services across the whole platform.',
      description_source: 'ai',
      description_generation: { status: 'ai_applied', attempted: true },
    },
    domain_concepts: [{ name: 'asset' }, { name: 'pipeline' }],
    system_capabilities: [],
  } as any, profile);

  assert.match(gate.detail, /description does not acknowledge that Ruby \(79% of source\) is not analyzed/);
});

test('agent-fast usefulness review treats AI descriptions as intentionally deferred', () => {
  const review = reviewAnalysisUsefulnessStatic({
    system: { name: 'fast-api', type: 'service' },
    nodes: [
      { id: 'controller', name: 'OrdersController', type: 'controller', source: { file: 'src/orders/orders.controller.ts' } },
      { id: 'service', name: 'OrdersService', type: 'service', source: { file: 'src/orders/orders.service.ts' } },
    ],
    edges: [{ id: 'edge', source: 'controller', target: 'service', type: 'calls' }],
    entry_points: [{ id: 'entry', type: 'http', name: 'GET /orders', source_node: 'controller', handler: { file: 'src/orders/orders.controller.ts' } }],
    index: { nodes_by_type: { controller: ['controller'], service: ['service'] } },
    analysis_facts: [{ id: 'fact', type: 'route', description: 'Orders route calls service', evidence: ['src/orders/orders.controller.ts'] }],
    analysis_phases: [
      {
        id: 'ai-enrichment',
        name: 'AI Enrichment',
        priority: 4,
        status: 'deferred',
        purpose: 'ai-enrichment',
        default_phase: false,
        description: 'Deferred in agent-fast focus',
        outputs: ['enhanced_system_purpose.inferred_description', 'system_capabilities.description'],
        agent_value: 'Optional narrative polish',
        visualization_value: 'UI descriptions',
        can_run_later: true,
      },
    ],
    enhanced_system_purpose: {
      primary_domain: 'order-management',
      inferred_description: 'An order management API that exposes order routes, service behavior, and validation context for focused agent edits.',
      core_concepts: ['order', 'route'],
      description_source: 'deterministic',
      description_generation: { status: 'deterministic_initial', attempted: false },
    },
    system_capabilities: [
      {
        id: 'orders',
        name: 'Order Management',
        description: 'Order Management covers order behavior.',
        description_source: 'deterministic',
        description_generation: { status: 'deterministic_initial', attempted: false },
        category: 'core',
        criticality: 'high',
        criticality_factors: [],
        operations: [{ entry_point_id: 'entry', entry_point_type: 'http', action: 'read' }],
        related_entities: ['Order'],
        related_domains: ['order'],
      },
    ],
    domain_concepts: [{ name: 'order', appears_in: { nodes: ['controller'], entry_points: ['entry'], entities: [] } }],
    architecture_summary: {
      system_type: 'API service',
      architectural_patterns: [{ name: 'Service Layer', evidence: ['OrdersService'], node_ids: ['service'] }],
      architectural_inventory: { controllers: ['controller'], services: ['service'] },
      pattern_balance: { status: 'balanced' },
    },
    analyzer_contributions: [],
    progressive_levels: {} as any,
  } as any, '/tmp/fast-api', 'fast-api', 'agent-fast');

  const descriptionGate = review.gates.find(gate => gate.id === 'description-layering');
  assert.equal(descriptionGate?.status, 'pass');
  assert.equal(review.gates.some(gate => gate.id === 'description-quality'), false);
});

test('usefulness review fails disorganized CAS graphs with fixture pollution and weak evidence', () => {
  const review = reviewAnalysisUsefulnessStatic({
    system: { name: 'polluted', type: 'application' },
    nodes: [
      { id: 'n1', name: 'UserService', type: 'service', source: { file: 'src/users/user.service.ts' } },
      { id: 'n2', name: 'FixtureController', type: 'controller', source: { file: 'fixtures/demo/controller.ts' } },
      { id: 'n3', name: 'BuildArtifact', type: 'function', source: { file: '.next/server/chunks/app.js' } },
    ],
    edges: [],
    index: undefined,
    analysis_facts: [],
    enhanced_system_purpose: {
      primary_domain: 'user-management',
      inferred_description: 'A user management backend service with clear source-level evidence for account workflows and operational user behavior.',
      core_concepts: ['user', 'account'],
    },
    system_capabilities: [
      { name: 'User Management', related_entities: [], related_domains: [], operations: [] },
    ],
    domain_concepts: [
      { name: 'user', appears_in: { nodes: [], entry_points: [], entities: [] } },
    ],
    architecture_summary: {
      system_type: 'API service',
      architectural_patterns: [],
      architectural_inventory: {},
    },
    analyzer_contributions: [],
    progressive_levels: {} as any,
  } as any, '/tmp/polluted-api', 'polluted-api');

  const organization = review.gates.find(gate => gate.id === 'cas-organization');
  assert.equal(organization?.status, 'fail');
  assert.match(organization?.detail || '', /generated\/fixture pollution/);
  assert.match(organization?.detail || '', /missing CAS index/);
  assert.match(organization?.detail || '', /missing analysis facts/);
});

test('usefulness review accepts organized evidence-backed CAS graphs', () => {
  const review = reviewAnalysisUsefulnessStatic({
    system: { name: 'orders-api', type: 'application' },
    nodes: [
      { id: 'controller', name: 'OrdersController', type: 'controller', source: { file: 'src/orders/orders.controller.ts' } },
      { id: 'service', name: 'OrdersService', type: 'service', source: { file: 'src/orders/orders.service.ts' } },
      { id: 'entity', name: 'OrderEntity', type: 'entity', source: { file: 'src/orders/order.entity.ts' } },
    ],
    edges: [
      { id: 'e1', source: 'controller', target: 'service', type: 'calls' },
      { id: 'e2', source: 'service', target: 'entity', type: 'uses' },
    ],
    index: { nodes_by_type: { controller: ['controller'], service: ['service'], entity: ['entity'] } },
    analysis_facts: [{ id: 'fact1', type: 'route', description: 'Orders route calls OrdersService', evidence: ['src/orders/orders.controller.ts'] }],
    enhanced_system_purpose: {
      primary_domain: 'order-management',
      inferred_description: 'An order management API service that exposes order workflows through controllers, service-layer behavior, and entity-backed persistence.',
      core_concepts: ['order', 'workflow'],
    },
    system_capabilities: [
      { name: 'Order Management', related_entities: ['entity'], related_domains: ['order'], operations: [{ action: 'read' }] },
    ],
    domain_concepts: [
      { name: 'order', appears_in: { nodes: ['controller', 'service'], entry_points: ['ep1'], entities: ['entity'] } },
    ],
    architecture_summary: {
      system_type: 'API service',
      architectural_patterns: [{ name: 'Service Layer', evidence: ['OrdersService'], node_ids: ['service'] }],
      architectural_inventory: { controllers: ['controller'], services: ['service'], models: ['entity'] },
      pattern_balance: { status: 'balanced' },
    },
    analyzer_contributions: [],
    progressive_levels: {} as any,
  } as any, '/tmp/orders-api', 'orders-api');

  const organization = review.gates.find(gate => gate.id === 'cas-organization');
  assert.equal(organization?.status, 'pass');
});

test('architecture agent context gate requires actionable pattern placement guidance', () => {
  const profile: any = {
    kind: 'backend-service',
    confidence: 0.9,
    evidence: ['HTTP/API framework or entry points'],
    expectations: {
      entry_points: 'required',
      call_chains: 'required',
      behavioral_invariants: 'required',
      security: 'required',
      runtime_correlation: 'optional',
      flow_coverage: 'required',
    },
  };
  const weak = scoreArchitectureAgentContext({
    work_context: {
      architecture_context: {
        system_type: 'API service',
        architecture_budget: ['Repository'],
        patterns: [{ name: 'Repository' }],
        inventory_counts: { services: 1, repositories: 1 },
        agent_rules: ['Preserve architecture boundaries.'],
      },
    },
  }, profile);
  assert.equal(weak.status, 'fail');
  assert.match(weak.detail, /pattern decision matrix/);

  const strong = scoreArchitectureAgentContext({
    selected_node: { file: 'src/orders/orders.service.ts' },
    file_read_plan: [{ file: 'src/orders/orders.service.ts', reason: 'selected target' }],
    work_context: {
      architecture_context: {
        system_type: 'API service',
        architecture_budget: ['Repository', 'Service Layer'],
        patterns: [{ name: 'Repository' }, { name: 'Service Layer' }],
        inventory_counts: { services: 1, repositories: 1 },
        inventory_examples: {
          services: [{ id: 'service', name: 'OrdersService', file: 'src/orders/orders.service.ts' }],
          repositories: [{ id: 'repo', name: 'OrdersRepository', file: 'src/orders/orders.repository.ts' }],
        },
        pattern_decision_matrix: [
          {
            pattern: 'Repository',
            use_when: 'Use for persistence boundaries.',
            owner_categories: ['repositories'],
            examples: [{ id: 'repo', name: 'OrdersRepository', file: 'src/orders/orders.repository.ts' }],
          },
          {
            pattern: 'Service Layer',
            use_when: 'Use for business rules.',
            owner_categories: ['services'],
            examples: [{ id: 'service', name: 'OrdersService', file: 'src/orders/orders.service.ts' }],
          },
        ],
        agent_rules: ['Use existing architecture pattern owners before adding another style.'],
      },
    },
  }, profile);
  assert.equal(strong.status, 'pass');

  const equivalentPrefixPaths = scoreArchitectureAgentContext({
    selected_node: { file: 'standup/auth_backends.py' },
    file_read_plan: [{ file: 'standup/auth_backends.py', reason: 'selected target' }],
    work_context: {
      architecture_context: {
        system_type: 'Django service',
        architecture_budget: ['Client SDK / API Wrapper'],
        patterns: [{ name: 'Client SDK / API Wrapper' }],
        inventory_counts: { clients: 1 },
        relevant_inventory: {
          clients: [{ name: 'auth_backends.py', file: 'standupApp/standup/auth_backends.py' }],
        },
        pattern_decision_matrix: [
          {
            pattern: 'Client SDK / API Wrapper',
            use_when: 'Use for adapter boundaries.',
            owner_categories: ['clients'],
            examples: [{ name: 'auth_backends.py', file: 'standupApp/standup/auth_backends.py' }],
          },
        ],
        agent_rules: ['Use existing architecture pattern owners before adding another style.'],
      },
    },
  }, profile);
  assert.equal(equivalentPrefixPaths.status, 'pass');

  const assetPipelinePaths = scoreArchitectureAgentContext({
    selected_node: { file: 'app/assets/javascript/task_assignment.js' },
    file_read_plan: [{ file: 'app/assets/javascript/task_assignment.js', reason: 'selected target' }],
    work_context: {
      architecture_context: {
        system_type: 'Rails frontend',
        architecture_budget: ['Static Site / Asset Pipeline'],
        patterns: [{ name: 'Static Site / Asset Pipeline' }],
        inventory_counts: { clients: 1 },
        relevant_inventory: {
          clients: [{ name: 'task_assignment.js', file: 'assets/javascript/task_assignment.js' }],
        },
        pattern_decision_matrix: [
          {
            pattern: 'Static Site / Asset Pipeline',
            use_when: 'Use for colocated browser behavior.',
            owner_categories: ['clients'],
            examples: [{ name: 'task_assignment.js', file: 'javascript/task_assignment.js' }],
          },
        ],
        agent_rules: ['Use existing architecture pattern owners before adding another style.'],
      },
    },
  }, profile);
  assert.equal(assetPipelinePaths.status, 'pass');

  const singleFileWithRepoPrefix = scoreArchitectureAgentContext({
    selected_node: { file: 'main.js' },
    file_read_plan: [{ file: 'main.js', reason: 'selected target' }],
    work_context: {
      architecture_context: {
        system_type: 'CLI application',
        architecture_budget: ['Command Script / Automation'],
        patterns: [{ name: 'Command Script / Automation' }],
        inventory_counts: { scripts: 1 },
        relevant_inventory: {
          scripts: [{ name: 'main', file: 'reference-bots/solana-sniper-copy-trading-bot/main.js' }],
        },
        pattern_decision_matrix: [
          {
            pattern: 'Command Script / Automation',
            use_when: 'Use for command-line behavior.',
            owner_categories: ['scripts'],
            examples: [{ name: 'main', file: 'reference-bots/solana-sniper-copy-trading-bot/main.js' }],
          },
        ],
        agent_rules: ['Use existing architecture pattern owners before adding another style.'],
      },
    },
  }, profile);
  assert.equal(singleFileWithRepoPrefix.status, 'pass');

  const misleading = scoreArchitectureAgentContext({
    selected_node: { file: 'packages/analyzer-core/src/analyzer/core/orchestrator.ts' },
    file_read_plan: [
      { file: 'packages/analyzer-core/src/analyzer/core/orchestrator.ts', reason: 'selected target' },
      { file: 'packages/analyzer-core/src/auth/auth.service.ts', reason: 'task hint related file' },
    ],
    work_context: {
      architecture_context: {
        system_type: 'MCP analyzer monorepo',
        architecture_budget: ['MVC', 'Layered Architecture'],
        patterns: [{ name: 'MVC' }, { name: 'Layered Architecture' }],
        inventory_counts: { controllers: 2, services: 2 },
        inventory_examples: {
          controllers: [
            { name: 'WorkspacesController', file: 'packages/analyzer-core/src/workspaces/workspaces.controller.ts' },
            { name: 'UsersController', file: 'packages/analyzer-core/src/users/users.controller.ts' },
          ],
        },
        pattern_decision_matrix: [
          {
            pattern: 'MVC',
            use_when: 'Use for request/page flows.',
            owner_categories: ['controllers', 'models', 'views'],
            examples: [
              { name: 'WorkspacesController', file: 'packages/analyzer-core/src/workspaces/workspaces.controller.ts' },
              { name: 'Workspace', file: 'packages/analyzer-core/src/database/entities/workspace.entity.ts' },
            ],
          },
          {
            pattern: 'Layered Architecture',
            use_when: 'Use existing layers.',
            owner_categories: ['controllers', 'services'],
            examples: [
              { name: 'UsersController', file: 'packages/analyzer-core/src/users/users.controller.ts' },
            ],
          },
        ],
        agent_rules: ['Use existing architecture pattern owners before adding another style.'],
      },
    },
  }, profile);
  assert.equal(misleading.status, 'warn');
  assert.match(misleading.detail, /outside selected file scope/);
});

test('duplication review treats infrastructure inventory as the duplicate-work surface', () => {
  const gate = scoreDuplicationAvoidance({
    system_capabilities: [{ id: 'capability-infra', name: 'Manage infrastructure', description: 'Manage cloud infrastructure.' }],
    workflows: [],
    architecture_summary: {
      architectural_inventory: {
        packages: ['module-vpc', 'module-ecs'],
      },
    },
    codebase_idioms: [{ id: 'terraform-modules' }],
  } as any, {
    selected_node: { id: 'module-vpc' },
    work_context: {},
  }, {
    kind: 'infrastructure',
    confidence: 0.95,
    evidence: ['infrastructure manifest/path'],
    expectations: {
      entry_points: 'not-applicable',
      call_chains: 'not-applicable',
      behavioral_invariants: 'not-applicable',
      security: 'not-applicable',
      runtime_correlation: 'not-applicable',
      flow_coverage: 'not-applicable',
    },
  });

  assert.equal(gate.status, 'pass');
});

test('description quality gate warns, never fails, when AI was never attempted (deterministic by configuration)', () => {
  const profile: any = {
    kind: 'backend-service',
    confidence: 0.9,
    evidence: ['HTTP/API framework or entry points'],
    expectations: {
      entry_points: 'required',
      call_chains: 'required',
      behavioral_invariants: 'required',
      security: 'required',
      runtime_correlation: 'optional',
      flow_coverage: 'required',
    },
  };
  const gate = scoreDescriptionQuality({
    enhanced_system_purpose: {
      primary_domain: 'cloud-infrastructure',
      core_concepts: ['module'],
      inferred_description: 'short deterministic line',
      description_source: 'deterministic',
      description_generation: { status: 'ai_skipped', attempted: false },
    },
    system_capabilities: [
      {
        id: 'file-workflow',
        name: 'File Workflow',
        category: 'supporting',
        criticality: 'medium',
        description: 'supports read operations.',
        description_source: 'deterministic',
        operations: [{ action: 'read' }],
        related_entities: [],
        related_domains: [],
      },
    ],
  } as any, profile);

  assert.notEqual(gate.status, 'fail');
  assert.ok(gate.detail.includes('deterministic by configuration'));
});
