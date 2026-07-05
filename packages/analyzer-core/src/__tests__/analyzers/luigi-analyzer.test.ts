jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { LuigiAnalyzer } from '../../analyzer/frameworks/dataml/luigi-analyzer';

const LUIGI_FIXTURE = [
  'import luigi',
  '',
  'class ExtractTask(luigi.Task):',
  '    def run(self):',
  '        pass',
  '',
  'class TransformTask(luigi.Task):',
  '    def requires(self):',
  '        return ExtractTask()',
  '',
  '    def run(self):',
  '        pass',
  ''
].join('\n');

async function withTempDir(files: Record<string, string>, run: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'luigi-test-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      await fs.ensureDir(path.dirname(full));
      await fs.writeFile(full, content);
    }
    await run(dir);
  } finally {
    await fs.remove(dir);
  }
}

describe('LuigiAnalyzer', () => {
  it('detects a Luigi task pipeline', async () => {
    await withTempDir({ 'tasks.py': LUIGI_FIXTURE }, async (dir) => {
      const analyzer = new LuigiAnalyzer();
      expect(await analyzer.canAnalyze(dir)).toBe(true);
    });
  });

  it('extracts both tasks and the requires() dependency edge', async () => {
    await withTempDir({ 'tasks.py': LUIGI_FIXTURE }, async (dir) => {
      const analyzer = new LuigiAnalyzer();
      const contribution = await analyzer.analyze({ projectPath: dir } as any);

      const taskNodes = contribution.nodes!.filter(n => n.type === 'task');
      expect(taskNodes.map(n => n.name).sort()).toEqual(['ExtractTask', 'TransformTask']);

      const precedesEdges = contribution.edges!.filter(e => e.type === 'precedes');
      expect(precedesEdges).toHaveLength(1);
    });
  });
});
