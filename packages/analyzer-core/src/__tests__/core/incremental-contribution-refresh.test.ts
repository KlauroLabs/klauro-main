import { createIncrementalAnalysisSnapshot, overlayIncrementalSnapshot } from '../../analyzer/core/incremental-contribution-refresh';
import type { AnalysisContext, FileAnalysisResult } from '../../analyzer/core/base-analyzer';

function emptyFileResult(): FileAnalysisResult {
  return {
    filePath: 'src/unchanged.ts',
    contentHash: 'unchanged',
    mtimeMs: 0,
    nodes: [],
    edges: [],
    entryPoints: [],
    exitPoints: [],
    imports: [],
    exports: [],
  };
}

describe('incremental contribution refresh', () => {
  it('reuses the immutable previous snapshot when no file contribution exists yet', () => {
    const previous = {
      nodes: [{ id: 'existing', name: 'Existing', type: 'function' as const }],
      edges: [],
      entry_points: [],
      exit_points: [],
      analyzer_metadata: {
        analyzer_id: 'fixture',
        analyzer_name: 'Fixture',
        version: '1.0.0',
        contribution_type: 'pattern' as const,
        nodes_contributed: 1,
        edges_contributed: 0,
      },
    } satisfies NonNullable<AnalysisContext['existingAnalysis']>[number];
    expect(overlayIncrementalSnapshot(previous, emptyFileResult())).toBe(previous);
  });

  it('creates an overlay after a file analyzer contributes graph items', () => {
    const previous = {
      nodes: [{ id: 'existing', name: 'Existing', type: 'function' as const }],
      edges: [],
      entry_points: [],
      exit_points: [],
      analyzer_metadata: {
        analyzer_id: 'fixture',
        analyzer_name: 'Fixture',
        version: '1.0.0',
        contribution_type: 'pattern' as const,
        nodes_contributed: 1,
        edges_contributed: 0,
      },
    } satisfies NonNullable<AnalysisContext['existingAnalysis']>[number];
    const current = emptyFileResult();
    current.nodes.push({ id: 'current', name: 'Current', type: 'function' });
    const result = overlayIncrementalSnapshot(previous, current);
    expect(result).not.toBe(previous);
    expect(result.nodes!.map(node => node.id)).toEqual(['current', 'existing']);
  });

  it('builds one copy-on-write snapshot and appends later contributions', () => {
    const previous = {
      nodes: [{ id: 'existing', name: 'Existing', type: 'function' as const }],
      edges: [],
      entry_points: [],
      exit_points: [],
      analyzer_metadata: {
        analyzer_id: 'fixture',
        analyzer_name: 'Fixture',
        version: '1.0.0',
        contribution_type: 'pattern' as const,
        nodes_contributed: 1,
        edges_contributed: 0,
      },
    } satisfies NonNullable<AnalysisContext['existingAnalysis']>[number];
    const snapshot = createIncrementalAnalysisSnapshot(previous);
    snapshot.append(emptyFileResult());
    expect(snapshot.current()).toBe(previous);
    const first = emptyFileResult();
    first.nodes.push({ id: 'first', name: 'First', type: 'function' });
    snapshot.append(first);
    const copied = snapshot.current();
    const second = emptyFileResult();
    second.nodes.push({ id: 'second', name: 'Second', type: 'function' });
    snapshot.append(second);
    expect(snapshot.current()).toBe(copied);
    expect(snapshot.current().nodes!.map(node => node.id)).toEqual(['first', 'existing', 'second']);
  });
});
