import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useExitPoints } from './useExitPoints';
import type { ExitPoint } from './useExitPoints';

const sample: ExitPoint[] = [
  { id: 'x1', source_node: 'n1', type: 'database', name: 'Postgres — analyses', target: { resource: 'analyses' } },
  { id: 'x2', source_node: 'n2', type: 'cache', name: 'Redis invalidate', target: { sdk: 'Redis' } },
  { id: 'x3', source_node: 'n3', type: 'sdk', name: 'AWS SDK client', target: { sdk: 'AWS SDK' } },
  { id: 'x4', source_node: 'n4', type: 'api', name: 'FETCH /v1/analyze', target: { endpoint: '/v1/analyze' } },
];

vi.mock('./useProjectCas', () => ({
  useProjectCas: () => ({ status: 'success', data: { status: 'ready', cas: { exit_points: sample } }, isLoading: false, isError: false }),
}));

describe('useExitPoints', () => {
  it('reads all exit points out of the CAS envelope', () => {
    const { result } = renderHook(() => useExitPoints('proj1'));
    expect(result.current.allExitPoints).toHaveLength(4);
  });

  it('groups exit points into families, omitting empty families', () => {
    const { result } = renderHook(() => useExitPoints('proj1'));
    const families = result.current.familyGroups.map(g => g.family);
    expect(families).toEqual(['db', 'sdk', 'api']);
    expect(families).not.toContain('messaging');
    expect(families).not.toContain('device');
  });

  it('folds database and cache kinds into the db family', () => {
    const { result } = renderHook(() => useExitPoints('proj1'));
    const dbGroup = result.current.familyGroups.find(g => g.family === 'db');
    expect(dbGroup?.count).toBe(2);
    expect(dbGroup?.kinds.map(k => k.kind).sort()).toEqual(['cache', 'database']);
  });
});
