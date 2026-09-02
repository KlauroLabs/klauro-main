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

type RelationshipNode = {
  id: string;
  name: string;
  type: string;
  source?: { file: string };
  metadata?: { attributes?: { receiver?: { type: string }; embedded?: string[] } };
};

type RelationshipEdge = { id: string; source: string; target: string; type: string };

function referenceTypeRelationships(nodes: RelationshipNode[], edges: RelationshipEdge[]): RelationshipEdge[] {
  const result = [...edges];
  const structNodes = nodes.filter(node => node.type === 'struct');
  const interfaceNodes = nodes.filter(node => node.type === 'interface');
  for (const structNode of structNodes) {
    const structMethods = nodes.filter(node =>
      node.type === 'method' && node.metadata?.attributes?.receiver?.type === structNode.name
    );
    for (const interfaceNode of interfaceNodes) {
      const interfaceMethods = nodes.filter(node =>
        node.type === 'interface_method' && result.some(edge => edge.source === interfaceNode.id && edge.target === node.id)
      );
      if (interfaceMethods.length > 0 && interfaceMethods.every(method =>
        structMethods.some(structMethod => structMethod.name === method.name)
      )) {
        result.push({
          id: `${structNode.id}_implements_${interfaceNode.id}`,
          source: structNode.id,
          target: interfaceNode.id,
          type: 'implements',
        });
      }
    }
  }
  return result;
}

function relationshipProjection(edges: RelationshipEdge[]): RelationshipEdge[] {
  return edges
    .filter(edge => edge.type === 'implements')
    .map(({ id, source, target, type }) => ({ id, source, target, type }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

test('indexed Go type relationships preserve reference semantics across files and duplicate names', () => {
  const nodes: RelationshipNode[] = [
    { id: 'struct_a_widget', name: 'Widget', type: 'struct', source: { file: 'a/widget.go' } },
    { id: 'struct_b_widget', name: 'Widget', type: 'struct', source: { file: 'b/widget.go' } },
    { id: 'struct_embedded', name: 'EmbeddedWidget', type: 'struct', source: { file: 'c/widget.go' }, metadata: { attributes: { embedded: ['Widget'] } } },
    { id: 'method_widget_run_a', name: 'Run', type: 'method', source: { file: 'a/widget.go' }, metadata: { attributes: { receiver: { type: 'Widget' } } } },
    { id: 'method_widget_run_b', name: 'Run', type: 'method', source: { file: 'b/widget.go' }, metadata: { attributes: { receiver: { type: 'Widget' } } } },
    { id: 'method_widget_stop', name: 'Stop', type: 'method', source: { file: 'b/widget.go' }, metadata: { attributes: { receiver: { type: 'Widget' } } } },
    { id: 'method_embedded_run', name: 'Run', type: 'method', source: { file: 'c/widget.go' }, metadata: { attributes: { receiver: { type: 'EmbeddedWidget' } } } },
    { id: 'interface_runner', name: 'Runner', type: 'interface', source: { file: 'contracts/runner.go' } },
    { id: 'interface_lifecycle', name: 'Lifecycle', type: 'interface', source: { file: 'contracts/lifecycle.go' } },
    { id: 'interface_method_run', name: 'Run', type: 'interface_method', source: { file: 'contracts/runner.go' } },
    { id: 'interface_method_stop', name: 'Stop', type: 'interface_method', source: { file: 'contracts/lifecycle.go' } },
  ];
  const edges: RelationshipEdge[] = [
    { id: 'runner_run', source: 'interface_runner', target: 'interface_method_run', type: 'has_method' },
    { id: 'lifecycle_run', source: 'interface_lifecycle', target: 'interface_method_run', type: 'has_method' },
    { id: 'lifecycle_stop', source: 'interface_lifecycle', target: 'interface_method_stop', type: 'has_method' },
  ];
  const expected = referenceTypeRelationships(nodes, edges);
  const actual = [...edges];

  (new GoAnalyzer() as any).buildTypeRelationships(nodes, actual);

  assert.deepEqual(relationshipProjection(actual), relationshipProjection(expected));
});

test('indexed Go type relationships perform a bounded number of global node scans', () => {
  const rawNodes: RelationshipNode[] = [];
  const edges: RelationshipEdge[] = [];
  for (let index = 0; index < 500; index++) {
    rawNodes.push({ id: `struct_${index}`, name: `Struct${index}`, type: 'struct' });
    rawNodes.push({ id: `method_${index}`, name: 'Run', type: 'method', metadata: { attributes: { receiver: { type: `Struct${index}` } } } });
  }
  rawNodes.push({ id: 'interface_runner', name: 'Runner', type: 'interface' });
  rawNodes.push({ id: 'interface_method_run', name: 'Run', type: 'interface_method' });
  edges.push({ id: 'has_method_run', source: 'interface_runner', target: 'interface_method_run', type: 'has_method' });
  let globalFilterCalls = 0;
  const nodes = new Proxy(rawNodes, {
    get(target, property, receiver) {
      if (property === 'filter') globalFilterCalls++;
      return Reflect.get(target, property, receiver);
    },
  });

  (new GoAnalyzer() as any).buildTypeRelationships(nodes, edges);

  assert.equal(globalFilterCalls, 2);
  assert.equal(edges.filter(edge => edge.type === 'implements').length, 500);

  (new GoAnalyzer() as any).buildTypeRelationships(nodes, edges);
  assert.equal(edges.filter(edge => edge.type === 'implements').length, 500);
});
