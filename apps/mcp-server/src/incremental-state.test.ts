import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AnalyzerOrchestrator } from '../../../packages/analyzer-core/src/analyzer/core/orchestrator';
import { ChangeDetector } from '../../../packages/analyzer-core/src/analyzer/core/change-detector';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

test('incremental state tracks node-less env.py source files without including env directories', () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-incremental-state-'));
  try {
    fs.mkdirSync(path.join(projectPath, 'app', 'settings'), { recursive: true });
    fs.mkdirSync(path.join(projectPath, 'env', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, 'app', 'settings', 'env.py'), 'DEBUG = False\n');
    fs.writeFileSync(path.join(projectPath, 'env', 'lib', 'ignored.py'), 'SHOULD_NOT_TRACK = True\n');

    const orchestrator = new AnalyzerOrchestrator() as any;
    const sourceFiles = orchestrator.getIncrementalSourceFiles(projectPath) as string[];
    assert.ok(sourceFiles.includes('app/settings/env.py'));
    assert.ok(!sourceFiles.includes('env/lib/ignored.py'));

    const output: CASOutput = {
      cas_version: '1.9.0',
      analysis_timestamp: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      analysis_id: 'incremental-state-test',
      system: {
        id: 'incremental-state-test',
        name: 'incremental-state-test',
        type: 'application',
        root_path: projectPath,
      },
      nodes: [],
      edges: [],
      analyzer_contributions: [],
      progressive_levels: { total_levels: 1 },
    };

    const state = orchestrator.buildIncrementalState(projectPath, output, new ChangeDetector(projectPath));
    assert.ok(state.files['app/settings/env.py']);
    assert.equal(state.files['app/settings/env.py'].nodeIds.length, 0);
    assert.equal(state.files['app/settings/env.py'].analyzerId, 'python');
    assert.equal(state.files['env/lib/ignored.py'], undefined);
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});
