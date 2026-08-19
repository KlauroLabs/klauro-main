import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { NextJSAnalyzer } from './nextjs-analyzer';

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
