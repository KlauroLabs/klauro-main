import assert from 'node:assert/strict';
import test from 'node:test';
import { semanticProbeForExtension } from './analysis-scale-benchmark';
import { processTreeRssBytesFromPs } from './process-tree-rss';
import { appendSemanticSourceProbe, semanticProbeForSource, supportsSemanticSourceProbe } from './semantic-source-probe';
import { compareCasGraphs } from './incremental-graph-equivalence';

test('process-tree RSS includes descendants and excludes unrelated processes', () => {
  const output = [
    '100 1 1024',
    '101 100 2048',
    '102 101 4096',
    '200 1 8192',
  ].join('\n');
  assert.equal(processTreeRssBytesFromPs(output, 100), 7 * 1024 * 1024);
});

test('process-tree RSS handles missing and malformed process rows', () => {
  assert.equal(processTreeRssBytesFromPs('bad row\n200 1 1024', 100), 0);
});

test('incremental probes change executable syntax across supported language families', () => {
  const extensions = [
    '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.rb', '.php', '.java', '.cs', '.go', '.rs', '.dart',
    '.sh', '.bash', '.zsh', '.ksh', '.sol', '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx',
    '.swift', '.kt', '.kts', '.ex', '.exs', '.proto', '.tf', '.tfvars', '.sql', '.ddl',
  ];
  for (const extension of extensions) {
    const probe = semanticProbeForExtension(extension, 3);
    assert.ok(probe);
    assert.doesNotMatch(probe, /^\s*(?:\/\/|#)/);
    assert.equal(supportsSemanticSourceProbe(`source${extension}`), true);
  }
  assert.match(semanticProbeForExtension('.dart', 3) || '', /int _analysisBenchmarkProbe3/);
  assert.equal(semanticProbeForExtension('.md', 3), null);
  assert.equal(supportsSemanticSourceProbe('README.md'), false);
});

test('semantic source probes preserve PHP execution after a closing tag', () => {
  const content = '<?php\nfunction existing(): int { return 1; }\n?>\n';
  const probe = semanticProbeForSource('source.php', content, 7);
  assert.match(probe || '', /^<\?php\nfunction analysis_benchmark_probe_7/);
  const edited = appendSemanticSourceProbe('source.php', content, 7);
  assert.match(edited || '', /\?>\n\n<\?php\nfunction analysis_benchmark_probe_7/);
});

test('unsupported source types cannot silently degrade to whitespace edits', () => {
  assert.equal(appendSemanticSourceProbe('README.md', '# title\n', 1), null);
});

test('graph equivalence rejects equal counts with different graph content', () => {
  const output = {
    nodes: [{ id: 'node-1', type: 'function', name: 'before' }],
    edges: [],
    entry_points: [],
    exit_points: [],
  } as never;
  const changed = {
    nodes: [{ id: 'node-1', type: 'function', name: 'after' }],
    edges: [],
    entry_points: [],
    exit_points: [],
  } as never;
  const comparison = compareCasGraphs(output, changed);
  assert.equal(comparison.count_similarity, 1);
  assert.equal(comparison.graph_equivalent, false);
  assert.deepEqual(comparison.graph_difference_sample, ['node:node-1[name]']);
});
