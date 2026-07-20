import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useEntryPointsForDeployable, useEntryPoint } from './useEntryPoints';
import type { EntryPoint } from './useEntryPoints';

const sample: EntryPoint[] = [
  { id: 'a', source_node: 'na', type: 'http', name: 'createWidget', deployable_id: 'api', deployable_name: 'API server' },
  { id: 'b', source_node: 'nb', type: 'message', name: 'onOrderPlaced', deployable_id: 'api', deployable_name: 'API server' },
  { id: 'c', source_node: 'nc', type: 'lifecycle', name: 'onStartup', deployable_id: 'worker', deployable_name: 'Worker' },
  { id: 'd', source_node: 'nd', type: 'test', name: 'shouldExcludeThis', deployable_id: 'api', deployable_name: 'API server' },
];

vi.mock('./useProjectCas', () => ({
  useProjectCas: () => ({ status: 'success', data: { status: 'ready', cas: { entry_points: sample } }, isLoading: false, isError: false }),
}));

describe('useEntryPointsForDeployable', () => {
  it('excludes test entry points from every derived view', () => {
    const { result } = renderHook(() => useEntryPointsForDeployable('proj1', undefined));
    expect(result.current.allEntryPoints.find(e => e.id === 'd')).toBeUndefined();
  });

  it('derives the deployable list from entry points', () => {
    const { result } = renderHook(() => useEntryPointsForDeployable('proj1', undefined));
    expect(result.current.deployables).toEqual([
      { id: 'api', name: 'API server' },
      { id: 'worker', name: 'Worker' },
    ]);
  });

  it('scopes entry points to one deployable at a time (per-deployable binding rule)', () => {
    const { result } = renderHook(() => useEntryPointsForDeployable('proj1', 'worker'));
    expect(result.current.entryPoints.map(e => e.id)).toEqual(['c']);
  });

  it('aggregates family counts only for families actually present', () => {
    const { result } = renderHook(() => useEntryPointsForDeployable('proj1', 'api'));
    const families = result.current.familyCounts.map(f => f.family);
    expect(families).toEqual(['request-wait', 'send-forget']);
    expect(families).not.toContain('reacts-alone');
  });
});

describe('useEntryPoint', () => {
  it('finds a single entry point by id', () => {
    const { result } = renderHook(() => useEntryPoint('proj1', 'b'));
    expect(result.current.entryPoint?.name).toBe('onOrderPlaced');
  });

  it('returns undefined for an id that does not exist (honest not-found case)', () => {
    const { result } = renderHook(() => useEntryPoint('proj1', 'zzz'));
    expect(result.current.entryPoint).toBeUndefined();
  });
});
