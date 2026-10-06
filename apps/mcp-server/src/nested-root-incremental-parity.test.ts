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
  fs.writeFileSync(path.join(projectPath, 'backend', 'models.py'), 'class Profile:\n    name = ""\n');
  previousStoragePath = process.env.KLAURO_STORAGE_PATH;
  process.env.KLAURO_STORAGE_PATH = path.join(root, 'storage');
});

after(() => {
  if (previousStoragePath === undefined) delete process.env.KLAURO_STORAGE_PATH;
  else process.env.KLAURO_STORAGE_PATH = previousStoragePath;
  fs.rmSync(root, { recursive: true, force: true });
});

test('incremental analysis of a nested application root keeps its nodes and equals the cold graph', async () => {
  const initial = await analyzeProjectIncremental(projectPath);
  const initialIds = initial.output.nodes.map(node => node.id).sort();
  assert.ok(initialIds.includes('backend/views.py:function:dashboard'));

  fs.appendFileSync(path.join(projectPath, 'backend', 'views.py'), '\ndef health():\n    return "ok"\n');
  const incremental = await analyzeProjectIncremental(projectPath);
  assert.equal(incremental.wasFullRebuild, false);
  assert.ok(incremental.changeReport.summary.filesModified > 0);
  const incrementalIds = incremental.output.nodes.map(node => node.id).sort();
  for (const id of initialIds) assert.ok(incrementalIds.includes(id), `lost ${id}`);
  assert.ok(incrementalIds.includes('backend/views.py:function:health'));

  const cold = await analyzeProject(projectPath);
  assert.equal(compareCasGraphs(incremental.output, cold).graph_equivalent, true);
});
