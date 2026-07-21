import { useMemo } from 'react';
import { useProjectCas } from './useProjectCas';
import {
  EXIT_FAMILY_ORDER,
  isKnownExitKind,
  EXIT_KIND_META,
  type ExitKind,
  type ExitPointFamily,
} from '@/app/Integrations/exitPointFamilies';

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
