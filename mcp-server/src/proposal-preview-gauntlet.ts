#!/usr/bin/env tsx
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { analyzeProjectIncremental } from './analyzer';
import { previewCodebaseIteration, previewGreenfieldCodebase } from './proposal-preview';
import { saveAgenticBenchmarkReport } from './storage';

interface Gate {
  name: string;
  status: 'pass' | 'fail';
  detail: string;
}

export async function runProposalPreviewGauntlet() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unravl-proposal-gauntlet-'));
  const repo = path.join(root, 'existing-repo');
  const gates: Gate[] = [];

  try {
    await fs.ensureDir(path.join(repo, 'src'));
    await fs.writeJson(path.join(repo, 'package.json'), { dependencies: { express: '^4.18.0' } });
    await fs.writeFile(path.join(repo, 'src', 'app.ts'), [
      "import express from 'express';",
      'const app = express();',
      "app.get('/ready', (_req, res) => res.json({ ok: true }));",
      'export default app;',
      '',
    ].join('\n'));
    const originalFiles = await snapshotFiles(repo);
    await analyzeProjectIncremental(repo);

    const iteration = await previewCodebaseIteration({
      path: repo,
      planText: 'Add a health endpoint in a new router file.',
      proposedFiles: [{
        path: 'src/health.ts',
        status: 'added',
        content: [
          "import express from 'express';",
          'export const healthRouter = express.Router();',
          "healthRouter.get('/health', (_req, res) => res.json({ ok: true }));",
          '',
        ].join('\n'),
      }],
      previewBaseUrl: 'https://app.unravl.test',
    }) as any;
    const afterFiles = await snapshotFiles(repo);
    gates.push({
      name: 'existing-preview-no-working-tree-mutation',
      status: JSON.stringify(originalFiles) === JSON.stringify(afterFiles) ? 'pass' : 'fail',
      detail: 'Proposal preview must not write proposed files into the real repo.',
    });
    gates.push({
      name: 'existing-preview-has-private-url',
      status: iteration.preview?.preview_url?.includes('/previews/') ? 'pass' : 'fail',
      detail: iteration.preview?.preview_url || 'missing preview url',
    });
    gates.push({
      name: 'existing-preview-has-comparison',
      status: iteration.comparison?.proposed_analysis_id ? 'pass' : 'fail',
      detail: JSON.stringify(iteration.comparison?.graph_delta || {}),
    });
    gates.push({
      name: 'existing-preview-has-advisory-verdict',
      status: iteration.preview?.verdict?.advisory === true ? 'pass' : 'fail',
      detail: iteration.preview?.verdict?.status || 'missing verdict',
    });

    const greenfield = await previewGreenfieldCodebase({
      planText: 'Create a small FastAPI service.',
      proposedFiles: [
        { path: 'requirements.txt', content: 'fastapi\nuvicorn\n' },
        {
          path: 'app/main.py',
          content: [
            'from fastapi import FastAPI',
            'app = FastAPI()',
            "@app.get('/health')",
            'def health():',
            "    return {'ok': True}",
            '',
          ].join('\n'),
        },
      ],
      previewBaseUrl: 'https://app.unravl.test',
    }) as any;
    gates.push({
      name: 'greenfield-preview-has-normal-cas',
      status: greenfield.preview?.proposed_analysis_id && greenfield.visualization_summary?.proposed_nodes > 0 ? 'pass' : 'fail',
      detail: `${greenfield.visualization_summary?.proposed_nodes || 0} proposed nodes`,
    });
    gates.push({
      name: 'greenfield-preview-has-private-url',
      status: greenfield.preview?.preview_url?.includes('/previews/') ? 'pass' : 'fail',
      detail: greenfield.preview?.preview_url || 'missing preview url',
    });
  } finally {
    await fs.remove(root);
  }

  const failed = gates.filter(gate => gate.status === 'fail');
  const report = {
    id: `proposal-preview-gauntlet-${Date.now()}`,
    benchmark_type: 'proposal-preview-gauntlet',
    generated_at: new Date().toISOString(),
    status: failed.length === 0 ? 'pass' : 'fail',
    score: gates.length === 0 ? 0 : Math.round(((gates.length - failed.length) / gates.length) * 100),
    gates,
  };
  await saveAgenticBenchmarkReport(report);
  return report;
}

async function snapshotFiles(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  await walk(root, async file => {
    const relative = path.relative(root, file).replace(/\\/g, '/');
    files[relative] = await fs.readFile(file, 'utf8');
  });
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

async function walk(root: string, visit: (file: string) => Promise<void>): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) await walk(absolute, visit);
    if (entry.isFile()) await visit(absolute);
  }
}

if (require.main === module) {
  runProposalPreviewGauntlet()
    .then(report => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.exit(report.status === 'pass' ? 0 : 1);
    })
    .catch(error => {
      console.error(error);
      process.exit(1);
    });
}
