import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { NextJSAnalyzer } from './nextjs-analyzer';
import { CASContribution } from '../../../types/cas.types';
import { isRefreshableContribution, refreshProjectScopedContributions, retainedContributionFieldsMatch } from '../../core/incremental-contribution-refresh';

test('Next.js source changes retain static perspectives while refreshing route evidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-nextjs-contributions-'));
  try {
    const route = path.join(root, 'app/api/invoices/route.ts');
    await fs.outputJson(path.join(root, 'package.json'), { dependencies: { next: '15.0.0' } });
    await fs.outputFile(route, 'export async function GET() { return Response.json([]); }');
    const analyzer = new NextJSAnalyzer();
    const before = await analyzer.analyze({ projectPath: root, existingAnalysis: [] });
    await fs.outputFile(route, 'export async function POST() { return Response.json({ created: true }); }');
    const after = await analyzer.analyze({ projectPath: root, existingAnalysis: [] });
    assert(before.entry_points.some(entry => entry.name === 'GET /api/invoices'));
    assert(after.entry_points.some(entry => entry.name === 'POST /api/invoices'));
    assert(!after.entry_points.some(entry => entry.name === 'GET /api/invoices'));
    const fields = new Set(analyzer.incrementalSourceInvariantContributionFields());
    assert.equal(isRefreshableContribution(after, fields), true);
    assert.deepEqual(after.perspectives, before.perspectives);
    assert.deepEqual(after.provided_perspectives, before.provided_perspectives);
    assert.equal(retainedContributionFieldsMatch(after, before, fields), true);
    const changed = structuredClone(before);
    changed.perspectives![0].connection_rules.relevant_edge_types.push('new-edge-type');
    assert.equal(retainedContributionFieldsMatch(after, changed, fields), false);
    assert.equal(retainedContributionFieldsMatch(after, {}, fields), false);
    assert.deepEqual(before.entry_points.map(entry => entry.name), ['GET /api/invoices']);
  } finally {
    await fs.remove(root);
  }
});

test('project refresh accepts unchanged Next.js declarations and rejects changed or absent ones', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-nextjs-project-refresh-'));
  try {
    const route = path.join(root, 'app/api/invoices/route.ts');
    await fs.outputJson(path.join(root, 'package.json'), { dependencies: { next: '15.0.0' } });
    await fs.outputFile(route, 'export async function GET() { return Response.json([]); }');
    const analyzer = new NextJSAnalyzer();
    const before = await analyzer.analyze({ projectPath: root, existingAnalysis: [] });
    await fs.outputFile(route, 'export async function POST() { return Response.json({ created: true }); }');
    const graph = { nodes: before.nodes, edges: before.edges, entryPoints: before.entry_points, exitPoints: before.exit_points };
    const failures: string[] = [];
    const refresh = (retainedContribution: Partial<CASContribution>) => refreshProjectScopedContributions({
      projectPath: root, registrations: [{ id: 'nextjs', type: 'framework', analyzer }],
      analyzerIds: new Set(['nextjs']), graph, ownershipGraph: graph, retainedContribution,
      analyzerRoot: () => root, analysisFilters: [], scopeFilters: () => [],
      normalizeContribution: () => undefined,
      mergeContribution: async (current, contribution) => ({
        nodes: [...current.nodes, ...contribution.nodes], edges: [...current.edges, ...contribution.edges],
        entryPoints: [...current.entryPoints, ...contribution.entry_points], exitPoints: [...current.exitPoints, ...contribution.exit_points],
      }),
      onFailure: failure => failures.push(failure.reason),
    });
    const refreshed = await refresh(before);
    assert.notEqual(refreshed, null);
    assert.deepEqual(refreshed!.entryPoints.map(entry => entry.name), ['POST /api/invoices']);
    assert.deepEqual(graph.entryPoints.map(entry => entry.name), ['GET /api/invoices']);
    assert.deepEqual(failures, []);
    const changed = structuredClone(before);
    changed.perspectives![0].connection_rules.relevant_edge_types.push('new-edge-type');
    assert.equal(await refresh(changed), null);
    assert.equal(await refresh({}), null);
    assert.deepEqual(failures, ['retained-field-mismatch', 'retained-field-mismatch']);
  } finally {
    await fs.remove(root);
  }
});

test('Next.js route entry points resolve to callable handlers instead of file nodes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-nextjs-handlers-'));
  try {
    await fs.outputJson(path.join(root, 'package.json'), { dependencies: { next: '15.0.0', react: '19.0.0' } });
    await fs.outputFile(path.join(root, 'app/dashboard/page.tsx'), 'export default async function DashboardPage() { return null; }');
    await fs.outputFile(path.join(root, 'app/api/invoices/route.ts'), 'export async function POST() { return Response.json({}); }');
    await fs.outputFile(path.join(root, 'app/lib/actions.ts'), `'use server';\nexport async function createInvoice() { return null; }`);
    await fs.outputFile(path.join(root, 'proxy.ts'), `import NextAuth from 'next-auth';\nexport default NextAuth({}).auth;`);
    const existingAnalysis = [{
      nodes: [
        { id: 'file-page', name: 'page.tsx', type: 'file', source: { file: 'app/dashboard/page.tsx', line: 1 } },
        { id: 'dashboard-page', name: 'DashboardPage', type: 'function', source: { file: 'app/dashboard/page.tsx', line: 1 }, metadata: { is_exported: true } },
        { id: 'file-route', name: 'route.ts', type: 'file', source: { file: 'app/api/invoices/route.ts', line: 1 } },
        { id: 'post-invoice', name: 'POST', type: 'function', source: { file: 'app/api/invoices/route.ts', line: 1 }, metadata: { is_exported: true } },
        { id: 'create-invoice', name: 'createInvoice', type: 'function', source: { file: 'app/lib/actions.ts', line: 2 }, metadata: { is_exported: true } },
      ],
      edges: [], entry_points: [], exit_points: [],
      analyzer_metadata: { analyzer_id: 'typescript-javascript', analyzer_name: 'TypeScript', version: '1', contribution_type: 'language' },
    } as any];

    const result = await new NextJSAnalyzer().analyze({ projectPath: root, existingAnalysis });
    const page = result.entry_points.find(entry => entry.name === 'PAGE /dashboard');
    const post = result.entry_points.find(entry => entry.name === 'POST /api/invoices');
    const action = result.entry_points.find(entry => entry.name === 'ACTION createInvoice');

    assert.equal(page?.source_node, 'dashboard-page');
    assert.equal(post?.source_node, 'post-invoice');
    assert.equal(action?.source_node, 'create-invoice');
    assert.equal(action?.trigger?.event, 'server-action');
    assert.deepEqual(page?.security?.guards, ['NextAuth route proxy']);
    assert.equal(page?.security?.enforcement, 'enforced');
  } finally {
    await fs.remove(root);
  }
});
