import { after, before, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { analyzeProject, analyzeProjectIncremental } from './analyzer';
import { compareCasGraphs } from './incremental-graph-equivalence';

let root: string;
let projectPath: string;
let previousStoragePath: string | undefined;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-nested-root-incremental-'));
  projectPath = path.join(root, 'repo');
  fs.mkdirSync(path.join(projectPath, 'backend'), { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'backend', 'requirements.txt'), 'Django==5.0.0\n');
  fs.writeFileSync(path.join(projectPath, 'backend', 'views.py'), [
    'from django.contrib.auth.decorators import login_required',
    '',
    '@login_required',
    'def dashboard(request):',
    '    return request.user.username',
    '',
  ].join('\n'));
  previousStoragePath = process.env.KLAURO_STORAGE_PATH;
  process.env.KLAURO_STORAGE_PATH = path.join(root, 'storage');
});

after(() => {
  if (previousStoragePath === undefined) delete process.env.KLAURO_STORAGE_PATH;
  else process.env.KLAURO_STORAGE_PATH = previousStoragePath;
  fs.rmSync(root, { recursive: true, force: true });
});

test('incremental analyzers use their detected nested application root', async () => {
  const initial = await analyzeProjectIncremental(projectPath);
  const initialAuthIds = initial.output.nodes
    .filter(node => node.primaryAnalyzer === 'auth')
    .map(node => node.id)
    .sort();
  assert.ok(initialAuthIds.length > 0);

  fs.appendFileSync(path.join(projectPath, 'backend', 'views.py'), '\ndef health():\n    return "ok"\n');
  const incremental = await analyzeProjectIncremental(projectPath);
  const incrementalAuthIds = incremental.output.nodes
    .filter(node => node.primaryAnalyzer === 'auth')
    .map(node => node.id)
    .sort();
  assert.deepEqual(incrementalAuthIds, initialAuthIds);

  const cold = await analyzeProject(projectPath);
  assert.equal(compareCasGraphs(incremental.output, cold).graph_equivalent, true);
});
