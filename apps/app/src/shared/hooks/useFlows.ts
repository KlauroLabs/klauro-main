import { useMemo } from 'react';
import { useProjectConceptual } from './useProjectConceptual';
import type { FlowConcept } from '@/shared/api/index';

export interface FlowRoleBreakdown {
  core: number;
  supporting: number;
  infrastructure: number;
  unknown: number;
}

export function useFlows(projectId: string | undefined) {
  const query = useProjectConceptual(projectId);

  const flows = useMemo<FlowConcept[]>(() => query.data?.flows?.flows ?? [], [query.data]);

  const roleBreakdown = useMemo<FlowRoleBreakdown>(() => {
    const counts: FlowRoleBreakdown = { core: 0, supporting: 0, infrastructure: 0, unknown: 0 };
    for (const flow of flows) {
      const role = flow.role ?? 'unknown';
      if (role === 'core' || role === 'supporting' || role === 'infrastructure') counts[role] += 1;
      else counts.unknown += 1;
    }
    return counts;
  }, [flows]);

  return {
    ...query,
    flows,
    roleBreakdown,
    totalAvailable: query.data?.flows?.total,
    gaps: query.data?.flows?.gaps ?? [],
  };
}
