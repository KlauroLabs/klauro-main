jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { DagsterAnalyzer } from '../../analyzer/frameworks/dataml/dagster-analyzer';

const ASSETS_FIXTURE = [
  'from dagster import asset, job, op',
  '',
  '@asset',
  'def raw_orders():',
  '    return fetch_orders()',
  '',
  '@asset(deps=[raw_orders])',
  'def cleaned_orders():',
  '    return clean(raw_orders)',
  '',
  '@job',
  'def orders_job():',
  '    cleaned_orders()',
  ''
].join('\n');

async function withTempDir(files: Record<string, string>, run: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dagster-test-'));
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

describe('DagsterAnalyzer', () => {
  it('detects a Dagster asset pipeline', async () => {
    await withTempDir({ 'assets.py': ASSETS_FIXTURE }, async (dir) => {
      const analyzer = new DagsterAnalyzer();
      expect(await analyzer.canAnalyze(dir)).toBe(true);
    });
  });

  it('extracts assets, the job, and the deps=[] dependency edge', async () => {
    await withTempDir({ 'assets.py': ASSETS_FIXTURE }, async (dir) => {
      const analyzer = new DagsterAnalyzer();
      const contribution = await analyzer.analyze({ projectPath: dir } as any);

      const assetNames = contribution.nodes!.filter(n => n.type === 'task').map(n => n.name);
      expect(assetNames.sort()).toEqual(['cleaned_orders', 'raw_orders']);

      const jobNodes = contribution.nodes!.filter(n => n.type === 'pipeline');
      expect(jobNodes.map(n => n.name)).toEqual(['orders_job']);

      const feedsEdge = contribution.edges!.find(e => e.type === 'feeds');
      expect(feedsEdge).toBeDefined();

      expect(contribution.analyzer_metadata.contributed_entry_points).toBe(3);
    });
  });
});
