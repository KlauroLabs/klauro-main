jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { JupyterNotebookAnalyzer } from '../../analyzer/frameworks/dataml/jupyter-notebook-analyzer';

/** Minimal but structurally real nbformat v4 notebook: 3 code cells + 1 markdown cell. */
const NOTEBOOK_FIXTURE = {
  cells: [
    {
      cell_type: 'markdown',
      metadata: {},
      source: ['# Trade analysis\n']
    },
    {
      cell_type: 'code',
      execution_count: 1,
      metadata: {},
      outputs: [],
      source: [
        'import pandas as pd\n',
        '\n',
        'df = pd.read_csv("trades.csv")\n',
        'row_count = df.shape[0]\n'
      ]
    },
    {
      cell_type: 'code',
      execution_count: 2,
      metadata: {},
      outputs: [],
      source: [
        'def summarize(frame):\n',
        '    return frame.describe()\n',
        '\n',
        'print(summarize(df))\n'
      ]
    },
    {
      cell_type: 'code',
      execution_count: 3,
      metadata: {},
      outputs: [],
      source: ['df.to_csv("summary.csv")\n']
    }
  ],
  metadata: {
    kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' },
    language_info: { name: 'python' }
  },
  nbformat: 4,
  nbformat_minor: 5
};

async function withTempDir(files: Record<string, string>, run: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jupyter-test-'));
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

describe('JupyterNotebookAnalyzer', () => {
  it('detects a project containing a .ipynb file', async () => {
    await withTempDir({ 'analysis.ipynb': JSON.stringify(NOTEBOOK_FIXTURE) }, async (dir) => {
      const analyzer = new JupyterNotebookAnalyzer();
      expect(await analyzer.canAnalyze(dir)).toBe(true);
    });
  });

  it('does not detect a project with no notebooks', async () => {
    await withTempDir({ 'app.py': 'print(1)\n' }, async (dir) => {
      const analyzer = new JupyterNotebookAnalyzer();
      expect(await analyzer.canAnalyze(dir)).toBe(false);
    });
  });

  it('extracts the notebook node and its 3 ordered code cells (skipping the markdown cell)', async () => {
    await withTempDir({ 'analysis.ipynb': JSON.stringify(NOTEBOOK_FIXTURE) }, async (dir) => {
      const analyzer = new JupyterNotebookAnalyzer();
      const contribution = await analyzer.analyze({ projectPath: dir } as any);

      const notebookNodes = contribution.nodes!.filter(n => n.type === 'notebook');
      expect(notebookNodes).toHaveLength(1);
      expect(notebookNodes[0].name).toBe('analysis');

      const cellNodes = contribution.nodes!.filter(n => n.type === 'notebook-cell');
      expect(cellNodes).toHaveLength(3);

      const cellEntryPoints = contribution.entry_points!.filter(ep => ep.type === 'notebook-cell');
      expect(cellEntryPoints).toHaveLength(3);

      // Linear execution flow: 2 `precedes` edges chain cell0->cell1->cell2.
      const precedesEdges = contribution.edges!.filter(e => e.type === 'precedes');
      expect(precedesEdges).toHaveLength(2);

      // 3 `contains` edges: notebook -> each cell.
      const containsEdges = contribution.edges!.filter(e => e.type === 'contains');
      expect(containsEdges).toHaveLength(3);

      const secondCell = cellNodes.find(n => n.metadata?.attributes?.cellIndex === 1);
      expect(secondCell?.metadata?.attributes?.defs).toContain('summarize');

      const firstCell = cellNodes.find(n => n.metadata?.attributes?.cellIndex === 0);
      expect(firstCell?.metadata?.attributes?.imports).toContain('pandas');
    });
  });

  it('skips a malformed .ipynb file instead of fabricating cell structure', async () => {
    await withTempDir({ 'broken.ipynb': '{not valid json' }, async (dir) => {
      const analyzer = new JupyterNotebookAnalyzer();
      const contribution = await analyzer.analyze({ projectPath: dir } as any);

      expect(contribution.nodes).toHaveLength(0);
      expect((contribution.analyzer_metadata as any).malformedSkipped).toBe(1);
    });
  });
});
