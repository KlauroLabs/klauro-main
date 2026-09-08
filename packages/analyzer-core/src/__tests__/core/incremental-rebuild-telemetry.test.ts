jest.unmock('fs');

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import * as refresh from '../../analyzer/core/incremental-contribution-refresh';
import type { CASOutput } from '../../types/cas.types';

describe('incremental rebuild telemetry', () => {
  it('routes every full-analysis escalation through the reason-logging helper', () => {
    const source = ts.createSourceFile('orchestrator.ts', fs.readFileSync(path.join(__dirname, '../../analyzer/core/orchestrator.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
    const unlogged: number[] = [];
    let calls = 0;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.kind === ts.SyntaxKind.ThisKeyword && node.expression.name.text === 'orchestrateAnalysis') {
        calls++;
        let parent: ts.Node | undefined = node.parent;
        while (parent && !(ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === 'rebuildIncrementalAnalysis')) parent = parent.parent;
        if (!parent) unlogged.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(calls).toBeGreaterThan(0);
    expect(unlogged).toEqual([]);
  });

  it('records the reason before work starts and preserves the full result contract', async () => {
    const lines: string[] = [];
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(chunk => { lines.push(String(chunk)); return true; });
    try {
      const output = { analysis_id: 'rebuilt', nodes: [], edges: [] } as unknown as CASOutput;
      const rebuild = refresh.rebuildIncrementalAnalysis;
      expect(typeof rebuild).toBe('function');
      const result = await rebuild('/workspace', 'analyzer-registry', 'Analyzer registry changed', async () => {
        expect(lines.map(line => JSON.parse(line))).toEqual([{
          event: 'incremental_full_rebuild', project_path: '/workspace',
          trigger: 'analyzer-registry', reason: 'Analyzer registry changed',
        }]);
        return output;
      });
      expect(result.output).toBe(output);
      expect(result.fileResults).toEqual(new Map());
      expect(result.wasFullRebuild).toBe(true);
      expect(result.fullRebuildReason).toBe('Analyzer registry changed');
    } finally {
      write.mockRestore();
    }
  });

  it('keeps the reason observable when the full rebuild fails', async () => {
    const lines: string[] = [];
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(chunk => { lines.push(String(chunk)); return true; });
    try {
      const failure = new Error('full rebuild failed');
      const rebuild = refresh.rebuildIncrementalAnalysis;
      expect(typeof rebuild).toBe('function');
      await expect(rebuild('/workspace', 'file-analysis-incomplete', 'One changed file failed', async () => { throw failure; })).rejects.toBe(failure);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]).reason).toBe('One changed file failed');
    } finally {
      write.mockRestore();
    }
  });
});
