// Flows lane (page-flows). Deliberately does NOT re-fetch — the flow list
// (and the capability<->flow relationships) already come back on
// GET /api/projects/:id/conceptual, which page-codebase's useProjectConceptual
// already wraps. Per LANE-COMMON's fabric protocol ("in-flight reuse... do
// NOT create a duplicate — coordinate via the file"), this hook is a thin
// selector on top of that shared query so the flows pages share the same
// react-query cache entry (one network fetch) rather than issuing a second,
// identical request.
import { useMemo } from 'react';
import { useProjectConceptual } from './useProjectConceptual';
import type { FlowConcept } from '../api';

export interface FlowRoleBreakdown {
  core: number;
  supporting: number;
  infrastructure: number;
  unknown: number;
}

/**
 * All flows for a codebase, as returned by the conceptual endpoint's default
 * browse cap (see apps/app/docs/briefs/flows.md, "Data reality" — the server
 * caps this at 20 flows per fetch unless a narrower `target` is passed; the
 * live proof-of-concept analysis has 4,614 entry points, so this list is
 * always a first page, never "all flows").
 */
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
