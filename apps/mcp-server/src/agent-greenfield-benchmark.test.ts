import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreGreenfieldBundle } from './agent-greenfield-benchmark';

test('greenfield scoring penalizes dependency-install artifacts in live output', () => {
  const scenario = {
    id: 'portfolio-reporting-api',
    title: 'Portfolio reporting API',
    plan: 'Build a portfolio reporting API.',
    required: { api: true, data: true, external: true },
    baselineFiles: [],
    guidedFiles: [],
  };
  const cas = {
    nodes: [{ id: 'route', name: 'Route' }],
    entry_points: [{ id: 'entry', name: 'POST /reports' }],
  };
  const clean = scoreGreenfieldBundle(scenario, [
    { path: 'src/api/routes.ts', content: 'export const routes = [];' },
    { path: 'src/service/report.service.ts', content: 'export class ReportService {}' },
    { path: 'src/domain/portfolio.ts', content: 'export interface Portfolio { id: string }' },
    { path: 'src/repositories/portfolio.repository.ts', content: 'export class PortfolioRepository {}' },
    { path: 'src/integrations/stripe.client.ts', content: 'export const stripe = true;' },
    { path: 'migrations/001_reports.sql', content: 'create table reports (id text);' },
    { path: 'tests/report.service.test.ts', content: 'test("report", () => true);' },
  ], cas, null);
  const installed = scoreGreenfieldBundle(scenario, [
    { path: 'package-lock.json', content: '{}' },
    { path: 'src/api/routes.ts', content: 'export const routes = [];' },
    { path: 'src/service/report.service.ts', content: 'export class ReportService {}' },
    { path: 'src/domain/portfolio.ts', content: 'export interface Portfolio { id: string }' },
    { path: 'src/repositories/portfolio.repository.ts', content: 'export class PortfolioRepository {}' },
    { path: 'src/integrations/stripe.client.ts', content: 'export const stripe = true;' },
    { path: 'migrations/001_reports.sql', content: 'create table reports (id text);' },
    { path: 'tests/report.service.test.ts', content: 'test("report", () => true);' },
  ], cas, null);

  assert.ok(installed.score < clean.score);
  assert.ok(installed.findings.some(finding => finding.includes('dependency-install artifacts')));
});
