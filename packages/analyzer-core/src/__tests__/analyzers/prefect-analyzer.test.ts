jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { PrefectAnalyzer } from '../../analyzer/frameworks/dataml/prefect-analyzer';

const FLOW_FIXTURE = [
  'from prefect import flow, task',
  '',
  '@task',
  'def extract():',
  '    return get_data()',
  '',
  '@task',
  'def transform(data):',
  '    return clean(data)',
  '',
  '@flow',
  'def etl_flow():',
  '    data = extract()',
  '    transform(data)',
  ''
].join('\n');

async function withTempDir(files: Record<string, string>, run: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prefect-test-'));
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

describe('PrefectAnalyzer', () => {
  it('detects a Prefect flow/task project', async () => {
    await withTempDir({ 'flow.py': FLOW_FIXTURE }, async (dir) => {
      const analyzer = new PrefectAnalyzer();
      expect(await analyzer.canAnalyze(dir)).toBe(true);
    });
  });

  it('extracts the flow, its tasks, and the invokes edges', async () => {
    await withTempDir({ 'flow.py': FLOW_FIXTURE }, async (dir) => {
      const analyzer = new PrefectAnalyzer();
      const contribution = await analyzer.analyze({ projectPath: dir } as any);

      const flowNodes = contribution.nodes!.filter(n => n.type === 'pipeline');
      expect(flowNodes.map(n => n.name)).toEqual(['etl_flow']);

      const taskNodes = contribution.nodes!.filter(n => n.type === 'task');
      expect(taskNodes.map(n => n.name).sort()).toEqual(['extract', 'transform']);

      const invokeEdges = contribution.edges!.filter(e => e.type === 'invokes');
      expect(invokeEdges).toHaveLength(2);
    });
  });
});
