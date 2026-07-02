/**
 * Tier-1 deploy-manifests bench — asserts the deploy-manifests EvidenceProvider
 * (packages/analyzer-core/src/analyzer/core/deployable-evidence/providers/
 * deploy-manifests.ts) correctly recognizes universal PaaS/orchestration
 * Tier-1 ship declarations beyond Docker/compose/k8s/installer/CI: Helm
 * charts, serverless services, and Procfile-based PaaS apps.
 *
 * Modeled on deployable-detection-bench.ts's fixture-matrix shape, but goes
 * straight through the product's own deployable-evidence collector
 * (collectDeployableEvidence, the same entry point
 * apps/mcp-server/fixtures/deployable-detection-bench's unit-level sibling
 * packages/analyzer-core/src/__tests__/core/deployable-evidence.test.ts
 * exercises) rather than the full cross-codebase system graph — this bench
 * is scoped to "does the Tier-1 evidence get produced correctly for each
 * PaaS manifest shape", not the downstream bundling/shipped-gate resolver
 * (which deployable-detection-bench.ts already covers for Docker-based
 * fixtures). Blackbox: no engine internals beyond the provider's own public
 * entry point, no AI/model env.
 *
 * FIXTURE MATRIX (apps/mcp-server/fixtures/deployable-detection/):
 *   1. helm-service — Chart.yaml + templates/ + values.yaml image ref + one
 *      app. EXPECT 1 Tier-1 'k8s' deployable (the chart), ships_paths names
 *      the image from values.yaml.
 *   2. serverless-fns — serverless.yml with 2 functions (sendEmail, sendSms).
 *      EXPECT 1 Tier-1 'serverless' deployable for the SERVICE (not 2 for
 *      the functions) — see deploy-manifests.ts header for the "service is
 *      the deploy unit, functions are its members" rationale. ships_paths
 *      names both functions; entrypoint_member is unset (ambiguous with 2
 *      functions, by design).
 *   3. procfile-app — Procfile with web (gunicorn) + worker (python worker.py)
 *      process types, backing a Flask app. EXPECT 1 Tier-1 'installer'
 *      deployable for the app; ships_paths names both process types; web is
 *      entrypoint_member (primary/shipped process a PaaS routes traffic to).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { collectDeployableEvidence } from '../../../../packages/analyzer-core/src/analyzer/core/deployable-evidence';

const FIXTURES_ROOT = path.resolve(__dirname, '..', '..', 'fixtures', 'deployable-detection');

test('helm-service: Chart.yaml + templates/ yields 1 Tier-1 k8s deployable with values.yaml image ships_paths', () => {
  const projectPath = path.join(FIXTURES_ROOT, 'helm-service');
  const result = collectDeployableEvidence({ projectPath, nodes: [], entryPoints: [], exitPoints: [] });

  const helmDeployables = result.filter(item => item.tier === 1 && item.kind === 'k8s' && item.name === 'orders-service');
  assert.equal(helmDeployables.length, 1, `expected exactly 1 Helm chart deployable, got ${helmDeployables.length}: ${JSON.stringify(result.map(r => ({ kind: r.kind, name: r.name })))}`);

  const chart = helmDeployables[0];
  assert.equal(chart.tier, 1);
  assert.ok(chart.evidence.some(e => e.includes('Chart.yaml')), 'evidence should cite Chart.yaml');
  assert.ok(chart.evidence.some(e => e.includes('templates')), 'evidence should cite templates/');
  assert.ok(chart.ships_paths?.some(p => p.includes('ghcr.io/example/orders-service')), `ships_paths should name the values.yaml image, got ${JSON.stringify(chart.ships_paths)}`);
});

test('serverless-fns: serverless.yml with 2 functions yields 1 Tier-1 serverless deployable for the SERVICE', () => {
  const projectPath = path.join(FIXTURES_ROOT, 'serverless-fns');
  const result = collectDeployableEvidence({ projectPath, nodes: [], entryPoints: [], exitPoints: [] });

  const serverlessDeployables = result.filter(item => item.tier === 1 && item.kind === 'serverless');
  assert.equal(
    serverlessDeployables.length,
    1,
    `expected exactly 1 serverless deployable (the service, not per-function), got ${serverlessDeployables.length}: ${JSON.stringify(serverlessDeployables.map(r => r.name))}`,
  );

  const svc = serverlessDeployables[0];
  assert.equal(svc.name, 'notifications-svc', 'deployable name should be the service name, not a function name');
  assert.ok(svc.evidence.some(e => e.includes('serverless.yml')), 'evidence should cite serverless.yml');
  assert.ok(svc.ships_paths?.includes('sendEmail'), `ships_paths should include sendEmail, got ${JSON.stringify(svc.ships_paths)}`);
  assert.ok(svc.ships_paths?.includes('sendSms'), `ships_paths should include sendSms, got ${JSON.stringify(svc.ships_paths)}`);
  assert.equal(svc.entrypoint_member, undefined, 'entrypoint_member should be unset — ambiguous primary with 2 functions');
});

test('procfile-app: Procfile with web+worker yields 1 Tier-1 installer deployable, web is entrypoint_member', () => {
  const projectPath = path.join(FIXTURES_ROOT, 'procfile-app');
  const result = collectDeployableEvidence({ projectPath, nodes: [], entryPoints: [], exitPoints: [] });

  const procfileDeployables = result.filter(item => item.tier === 1 && item.kind === 'installer' && item.evidence.some(e => e.includes('Procfile')));
  assert.equal(
    procfileDeployables.length,
    1,
    `expected exactly 1 deployable for the Procfile app, got ${procfileDeployables.length}: ${JSON.stringify(procfileDeployables.map(r => r.name))}`,
  );

  const app = procfileDeployables[0];
  assert.ok(app.evidence.some(e => e.includes('Procfile')), 'evidence should cite the Procfile');
  assert.ok(app.ships_paths?.includes('web'), `ships_paths should include the web process type, got ${JSON.stringify(app.ships_paths)}`);
  assert.ok(app.ships_paths?.includes('worker'), `ships_paths should include the worker process type, got ${JSON.stringify(app.ships_paths)}`);
  assert.equal(app.entrypoint_member, 'web', 'web should be entrypoint_member — the primary/shipped process a PaaS routes traffic to');
});

test('returns no Tier-1 deploy-manifests evidence for a project with none of these manifests', () => {
  // rust-installer-bundle has no Chart.yaml/serverless.yml/Procfile/etc.
  const projectPath = path.resolve(FIXTURES_ROOT, 'rust-installer-bundle');
  const result = collectDeployableEvidence({ projectPath, nodes: [], entryPoints: [], exitPoints: [] });

  const helmOrServerlessOrPaas = result.filter(
    item => (item.kind === 'k8s' && item.evidence.some(e => e.includes('Helm'))) ||
      (item.kind === 'serverless') ||
      (item.kind === 'installer' && item.evidence.some(e => e.includes('Procfile') || e.includes('PaaS'))),
  );
  assert.equal(helmOrServerlessOrPaas.length, 0, `expected no deploy-manifests evidence in a repo with none of these manifests, got: ${JSON.stringify(helmOrServerlessOrPaas)}`);
});
