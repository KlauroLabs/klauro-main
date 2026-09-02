import { computeModuleHealth } from '../../analyzer/core/module-health';
import type { CASNode } from '../../types/cas.types';

describe('computeModuleHealth completeness', () => {
  it('retains statistics for every analyzed file beyond the former summary ceiling', () => {
    const nodes = Array.from({ length: 75 }, (_, index) => ({
      id: `node_${index}`,
      name: `node_${index}`,
      type: 'function',
      source: { file: `src/file-${index}.ts`, line: 1, end_line: index + 1 },
    })) as CASNode[];
    const result = computeModuleHealth({
      nodes,
      edges: [],
      entryPoints: [],
      systemCapabilities: [],
      temporalStability: [],
      principleViolations: [],
    });
    expect(result).toBeDefined();
    expect(result!.files_analyzed).toBe(75);
    expect(result!.file_stats).toHaveLength(75);
    expect(new Set(result!.file_stats.map(file => file.file)).size).toBe(75);
  });
});
