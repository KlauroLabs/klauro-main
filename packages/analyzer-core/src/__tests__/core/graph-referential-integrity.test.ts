import {
  checkEdgeReferentialIntegrity,
  formatReferentialIntegrityReport,
} from '../../analyzer/core/graph-referential-integrity';

/**
 * THE INVARIANT UNDER TEST: every edge endpoint resolves in nodes ∪
 * exit_points ∪ entry_points. The check must be attributable — a failure has to
 * name the producing relationship and id scheme, because "16.9% of edges are
 * dangling" is a number nobody can act on and "17,131 of them target
 * `exit_sdk_*`" points straight at the pass to fix.
 */
describe('edge referential integrity', () => {
  const collections = {
    nodes: [{ id: 'fn_a' }, { id: 'fn_b' }],
    entry_points: [{ id: 'entry_http_get_things' }],
    exit_points: [{ id: 'exit_api_fn_b_post_3' }],
  };

  it('accepts a graph whose endpoints all resolve, across all three collections', () => {
    const report = checkEdgeReferentialIntegrity(
      [
        { id: 'e1', type: 'calls', source: 'fn_a', target: 'fn_b' },
        { id: 'e2', type: 'calls', source: 'fn_b', target: 'exit_api_fn_b_post_3' },
        { id: 'e3', type: 'handles', source: 'entry_http_get_things', target: 'fn_a' },
      ],
      collections
    );
    expect(report.ok).toBe(true);
    expect(report.dangling_edges).toBe(0);
    expect(formatReferentialIntegrityReport(report)).toContain('clean');
  });

  it('fails a graph with an unresolvable target and attributes it', () => {
    const report = checkEdgeReferentialIntegrity(
      [
        { id: 'e1', type: 'calls', source: 'fn_a', target: 'fn_b' },
        { id: 'e2', type: 'calls', source: 'fn_a', target: 'exit_sdk_fn_a_useThing_4' },
        { id: 'e3', type: 'calls', source: 'fn_b', target: 'exit_sdk_fn_b_useOther_9' },
      ],
      collections
    );
    expect(report.ok).toBe(false);
    expect(report.dangling_edges).toBe(2);
    expect(report.by_endpoint).toEqual({ source: 0, target: 2, both: 0 });
    expect(report.by_edge_type).toEqual({ calls: 2 });
    expect(report.by_unresolved_id_prefix).toEqual({ exit_sdk: 2 });
    expect(report.samples[0]).toMatchObject({ endpoint: 'target', unresolved_id: 'exit_sdk_fn_a_useThing_4' });
    const formatted = formatReferentialIntegrityReport(report);
    expect(formatted).toContain('2 of 3');
    expect(formatted).toContain('exit_sdk=2');
  });

  it('separates a missing source from a missing target, and reports both', () => {
    const report = checkEdgeReferentialIntegrity(
      [
        { id: 'e1', type: 'mocks', source: 'mock_x', target: 'fn_a' },
        { id: 'e2', type: 'DEPLOYS', source: 'nowhere_a', target: 'nowhere_b' },
      ],
      collections
    );
    expect(report.dangling_edges).toBe(2);
    expect(report.by_endpoint).toEqual({ source: 1, target: 0, both: 1 });
    expect(Object.keys(report.by_edge_type).sort()).toEqual(['DEPLOYS', 'mocks']);
  });

  it('treats an absent edge list as clean rather than throwing', () => {
    expect(checkEdgeReferentialIntegrity(undefined, collections).ok).toBe(true);
  });

  it('caps the samples it carries so a mass failure stays printable', () => {
    const edges = Array.from({ length: 50 }, (_, i) => ({
      id: `e${i}`, type: 'calls', source: 'fn_a', target: `exit_sdk_missing_${i}`,
    }));
    const report = checkEdgeReferentialIntegrity(edges, collections, { maxSamples: 3 });
    expect(report.dangling_edges).toBe(50);
    expect(report.samples).toHaveLength(3);
  });
});
