import type { CASNode, CASEdge, CASEntryPoint } from '../../types/cas.types';
import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';

describe('imported handler resolution', () => {
  it('links a generic entry point to the function imported by its registration file', () => {
    const nodes: CASNode[] = [
      { id: 'entry-file', name: '__main__.py', type: 'file', source: { file: 'src/product/__main__.py' } },
      {
        id: 'main-import',
        name: 'main',
        type: 'import',
        source: { file: 'src/product/__main__.py' },
        metadata: { module: 'product.cli.main', fromImport: 'main' },
      } as CASNode,
      { id: 'decoy-main', name: 'main', type: 'function', source: { file: 'scripts/migrate.py' } },
      { id: 'real-main', name: 'main', type: 'function', source: { file: 'src/product/cli/main.py' } },
    ];
    const edges: CASEdge[] = [{ id: 'decoy-call', source: 'decoy-main', target: 'real-main', type: 'calls' }];
    const entryPoint: CASEntryPoint = {
      id: 'entry-main',
      name: 'main',
      type: 'cli',
      source_node: 'entry-file',
      handler: { node_id: 'unresolved', method_name: 'main', file: 'src/product/__main__.py' },
    };

    const orchestrator = new AnalyzerOrchestrator() as unknown as {
      linkRouteHandlers(nodes: CASNode[], edges: CASEdge[], entryPoints: CASEntryPoint[]): void;
    };
    orchestrator.linkRouteHandlers(nodes, edges, [entryPoint]);

    expect(entryPoint.handler?.node_id).toBe('real-main');
    expect(edges.some(edge => edge.source === 'entry-file' && edge.target === 'real-main')).toBe(true);
    expect(edges.some(edge => edge.source === 'entry-file' && edge.target === 'decoy-main')).toBe(false);
  });
});
