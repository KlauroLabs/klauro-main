import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GoAnalyzer } from './go-analyzer';

test('single-file Go analysis remains graph-equivalent to the cold analyzer contribution', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'go-incremental-parity-'));
  try {
    fs.writeFileSync(path.join(projectPath, 'go.mod'), 'module example.com/parity\n\ngo 1.22\n');
    fs.writeFileSync(path.join(projectPath, 'service.go'), [
      'package parity',
      'type Service struct{}',
      'func (s *Service) Resolve() int { return 1 }',
      '',
    ].join('\n'));
    const relativePath = 'handler.go';
    const filePath = path.join(projectPath, relativePath);
    fs.writeFileSync(filePath, [
      'package parity',
      'func Handle(service *Service) int {',
      '  return service.Resolve()',
      '}',
      '',
    ].join('\n'));
    const analyzer = new GoAnalyzer();
    const baseline = await analyzer.analyze({ projectPath });
    for (const node of baseline.nodes) {
      node.primaryAnalyzer = 'go';
      node.analyzers = [...new Set([...(node.analyzers || []), 'go'])];
    }
    for (const edge of baseline.edges) {
      edge.metadata = {
        ...edge.metadata,
        attributes: { ...edge.metadata?.attributes, source_analyzer: 'go' },
      };
    }
    fs.appendFileSync(filePath, '\nfunc analysisBenchmarkProbe42() int { return 42 }\n');
    const incremental = await analyzer.analyzeFileSingle({
      projectPath,
      filePath,
      relativePath,
      existingAnalysis: [baseline],
    });
    const cold = await analyzer.analyze({ projectPath });
    const coldNodes = new Map(cold.nodes.map(node => [node.id, node]));
    const expected = cold.edges
      .filter(edge => edge.type === 'calls' && coldNodes.get(edge.source)?.source?.file === relativePath)
      .map(edge => ({ id: edge.id, source: edge.source, target: edge.target, metadata: edge.metadata }))
      .sort((left, right) => left.id.localeCompare(right.id));
    const actual = incremental.edges
      .filter(edge => edge.type === 'calls')
      .map(edge => ({ id: edge.id, source: edge.source, target: edge.target, metadata: edge.metadata }))
      .sort((left, right) => left.id.localeCompare(right.id));
    assert.equal(analyzer.incrementalContributionScope(), 'file');
    assert.deepEqual(actual, expected);
    assert.ok(incremental.edges.some(edge => edge.id === 'package_parity_contains_file_handler_go'));
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});
