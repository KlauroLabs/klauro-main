import { useMemo } from 'react';
import { useProjectCas } from './useProjectCas';
import {
  EXIT_FAMILY_ORDER,
  isKnownExitKind,
  EXIT_KIND_META,
  type ExitKind,
  type ExitPointFamily,
} from '../pages/integrations/exitPointFamilies';

/**
 * Local mirror of the analyzer's CASExitPoint shape
 * (packages/analyzer-core/src/types/cas.types.ts), narrowed to the fields
 * this lane renders — same convention as useEntryPoints.ts's EntryPoint
 * mirror. `source_node` is the node id this exit call lives inside; it is
 * how every exit point drills to its touching function (the page-functions
 * lane's node-detail route, /codebases/:projectId/functions/:nodeId).
 */
export interface ExitPoint {
  id: string;
  source_node: string;
  type: ExitKind;
  name: string;
  description?: string;
  target?: { service_id?: string; endpoint?: string; resource?: string; sdk?: string };
  operation?: { action?: string; method?: string; async?: boolean };
  metadata?: { file?: string; line?: number; [key: string]: unknown };
}

export interface ExitFamilyGroup {
  family: ExitPointFamily;
  count: number;
  kinds: Array<{ kind: ExitKind; count: number }>;
  exitPoints: ExitPoint[];
}

/**
 * Reads exit points out of the full CAS payload (`useProjectCas`, the
 * ui-scaffold-lane hook — in-flight reuse per LANE-COMMON.md's fabric
 * protocol). Assumed shape: `{ status, cas: { exit_points?: ExitPoint[] } }`,
 * confirmed against remote-analyzer-service.ts's `handleSync`/analyze
 * handlers, which return the full analyzer output verbatim as `cas` — the
 * CAS type's `exit_points` field lands at `cas.exit_points` unmodified.
 */
export function useExitPoints(projectId: string | undefined) {
  const casQuery = useProjectCas(projectId);

  const allExitPoints = useMemo<ExitPoint[]>(() => {
    const cas = casQuery.data?.status === 'ready' ? casQuery.data.cas : undefined;
    return (cas as { exit_points?: ExitPoint[] } | undefined)?.exit_points ?? [];
  }, [casQuery.data]);

  const familyGroups = useMemo<ExitFamilyGroup[]>(() => {
    const known = allExitPoints.filter(ep => isKnownExitKind(ep.type));
    return EXIT_FAMILY_ORDER.map(family => {
      const members = known.filter(ep => EXIT_KIND_META[ep.type].family === family);
      const kindTally = new Map<ExitKind, number>();
      for (const ep of members) kindTally.set(ep.type, (kindTally.get(ep.type) ?? 0) + 1);
      const kinds = Array.from(kindTally, ([kind, count]) => ({ kind, count }));
      return { family, count: members.length, kinds, exitPoints: members };
    }).filter(group => group.count > 0);
  }, [allExitPoints]);

  return { ...casQuery, allExitPoints, familyGroups };
}
