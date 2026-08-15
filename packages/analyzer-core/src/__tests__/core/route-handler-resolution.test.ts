import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { permitsGlobalHandlerFallback, rankHandlerCandidateFiles } from '../../analyzer/core/route-handler-resolution';
import type { CASEdge, CASEntryPoint, CASNode } from '../../types/cas.types';

describe('route handler resolution', () => {
  it('ranks exact and suffix-equivalent files deterministically', () => {
    expect(rankHandlerCandidateFiles([
      'scripts/pr.ts',
      '/repo/skills/image/scripts/generate.py',
      'skills/image/scripts/generate.py',
    ], ['skills/image/scripts/generate.py'])).toEqual([
      'skills/image/scripts/generate.py',
      '/repo/skills/image/scripts/generate.py',
    ]);
  });

  it('does not globally resolve generic CLI handlers', () => {
    expect(permitsGlobalHandlerFallback('cli', 'main')).toBe(false);
    expect(permitsGlobalHandlerFallback('cli', 'execute')).toBe(true);
  });

  it('uses a CLI source file to resolve main instead of a called decoy', () => {
    const sourceFile = '/repo/skills/image/scripts/generate.py';
    const fileNode = { id: 'file_generate', name: 'generate.py', type: 'file', source: { file: sourceFile } } as CASNode;
    const localMain = { id: 'function_generate_main', name: 'main', type: 'function', source: { file: sourceFile } } as CASNode;
    const decoyMain = { id: 'function_scripts_pr_main', name: 'main', type: 'function', source: { file: 'scripts/pr.ts' } } as CASNode;
    const target = { id: 'function_target', name: 'target', type: 'function', source: { file: 'scripts/target.ts' } } as CASNode;
    const edges: CASEdge[] = [{ id: 'decoy-call', source: decoyMain.id, target: target.id, type: 'calls' }];
    const entry = {
      id: 'entry_generate_main',
      name: 'main',
      type: 'cli',
      source_node: fileNode.id,
      handler: { method_name: 'main' },
    } as CASEntryPoint;
    const orchestrator = new AnalyzerOrchestrator() as unknown as {
      linkRouteHandlers(nodes: CASNode[], edges: CASEdge[], entryPoints: CASEntryPoint[]): void;
    };
    orchestrator.linkRouteHandlers([fileNode, localMain, decoyMain, target], edges, [entry]);
    expect(entry.handler?.node_id).toBe(localMain.id);
    expect(edges.some(edge => edge.source === fileNode.id && edge.target === localMain.id)).toBe(true);
    expect(edges.some(edge => edge.source === fileNode.id && edge.target === decoyMain.id)).toBe(false);
  });

  it('anchors an unresolved inline CLI callback to its registration node', () => {
    const fileNode = {
      id: 'file_browser_cli',
      name: 'browser-cli.ts',
      type: 'file',
      source: { file: 'src/browser-cli.ts', line: 1 },
    } as CASNode;
    const entry = {
      id: 'entry_browser_click',
      name: 'click',
      type: 'cli',
      source_node: fileNode.id,
      handler: { node_id: 'function_browser_cli_opts', method_name: 'opts', file: 'src/browser-cli.ts', line: 20 },
      metadata: {},
    } as CASEntryPoint;
    const orchestrator = new AnalyzerOrchestrator() as unknown as {
      linkRouteHandlers(nodes: CASNode[], edges: CASEdge[], entryPoints: CASEntryPoint[]): void;
    };
    orchestrator.linkRouteHandlers([fileNode], [], [entry]);
    expect(entry.handler?.node_id).toBe(fileNode.id);
    expect(entry.metadata?.handler_resolution).toBe('registration-node');
    expect(entry.metadata?.unresolved_handler_candidate).toBe('opts');
  });
});
