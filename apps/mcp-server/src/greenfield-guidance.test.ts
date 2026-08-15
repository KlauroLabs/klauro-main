import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGreenfieldArchitectureGuidance } from './greenfield-guidance';

test('greenfield guidance exposes capability memory and reuse decisions before building duplicate behavior', () => {
  const guidance = buildGreenfieldArchitectureGuidance({
    planText: 'Build a portfolio reporting API with holdings, report generation, authenticated users, and billing webhooks.',
    references: [
      {
        path: '/repos/zerac-api',
        name: 'zerac-api',
        cas: {
          nodes: [{ id: 'report-service', name: 'ReportService', type: 'class' }],
          edges: [],
          entry_points: [],
          analyzer_contributions: [],
          system: {
            name: 'zerac-api',
            type: 'service',
            technologies: { languages: [{ name: 'TypeScript/JavaScript', percentage: 100 }], frameworks: [] },
          },
          capabilities: [
            {
              id: 'portfolio-reporting',
              name: 'Portfolio Reporting',
              description: 'Generates portfolio reports from holdings and account data.',
              category: 'core',
              criticality: 'high',
              related_domains: ['portfolio', 'reporting'],
              related_entities: ['Portfolio', 'Holding', 'Report'],
              operations: ['generate report'],
            },
            {
              id: 'billing-webhooks',
              name: 'Billing Webhooks',
              description: 'Processes Stripe billing events for account status updates.',
              category: 'supporting',
              criticality: 'medium',
              related_domains: ['billing', 'payment'],
              related_entities: ['Invoice', 'Subscription'],
              operations: ['process webhook'],
            },
          ],
          architecture_summary: {
            architectural_patterns: [
              {
                name: 'Service Layer',
                category: 'business-logic',
                confidence: 0.9,
                evidence: ['ReportService coordinates report generation.'],
                node_ids: ['report-service'],
              },
            ],
          },
          enhanced_system_purpose: { primary_domain: 'portfolio-management' },
          domain_concepts: [],
          entities: [],
          database_schema: { entities: [] },
        } as any,
      },
    ],
  });

  assert.equal(guidance.capability_memory.status, 'existing-capabilities-found');
  assert.ok(guidance.capability_memory.analyzed_capabilities.some(entry => entry.capability === 'Portfolio Reporting'));
  assert.ok(guidance.capability_memory.reuse_decisions_required.some(decision => decision.existing_capability === 'Portfolio Reporting'));
  assert.equal(guidance.existing_overlap.status, 'overlap-found');
  assert.ok(guidance.existing_overlap.matches[0].matched_terms.includes('portfolio'));
  assert.ok(guidance.capability_memory.do_not_rebuild[0].rule.includes('reuse'));
  assert.equal(guidance.large_scale_build_strategy.product, 'large_scale_greenfield_strategy');
  assert.ok(guidance.large_scale_build_strategy.core_concepts_to_name_once.some(concept => /portfolio/i.test(concept)));
  assert.ok(guidance.large_scale_build_strategy.anti_duplication_rules.some(rule => rule.includes('second entity/model')));
  assert.ok(guidance.large_scale_build_strategy.iteration_loop.some(step => step.includes('do_not_rebuild')));
});

test('greenfield guidance extracts domain concepts instead of sentence fragments for large scratch plans', () => {
  const guidance = buildGreenfieldArchitectureGuidance({
    planText: 'Build a large-scale claims operations control plane for regulated enterprise teams. It needs organizations, users, role-scoped access, claim intake, evidence contexts, review queues, policy checks, audit exports, SLA escalation digests, external webhook intake, PostgreSQL persistence, migrations, focused tests, and background workers. The system must be able to grow for many product slices without duplicating domain concepts or re-deciding architecture each time.',
    references: [],
  });

  const concepts = guidance.large_scale_build_strategy.core_concepts_to_name_once;
  assert.ok(concepts.some(concept => /organization/i.test(concept)));
  assert.ok(concepts.some(concept => /claim/i.test(concept)));
  assert.ok(concepts.some(concept => /evidence/i.test(concept)));
  assert.ok(concepts.some(concept => /review/i.test(concept)));
  assert.ok(concepts.some(concept => /audit/i.test(concept)));
  assert.ok(concepts.every(concept => !/^build\b/i.test(concept)));
  assert.ok(concepts.every(concept => !/^it needs\b/i.test(concept)));
  assert.ok(concepts.every(concept => !/\bmust be able\b/i.test(concept)));
});
