import { useMemo } from 'react';
import { useProjectCas } from './useProjectCas';
import { FAMILY_ORDER, isKnownKind, KIND_META, type EntryKind, type EntryPointFamily } from '@/shared/components/entryPointKinds';
import { resolveSlug } from '@/shared/lib/slugs';

export interface EntryPoint {
  id: string;
  source_node: string;
  type: EntryKind | 'test';
  name: string;
  description?: string;
  trigger?: {
    method?: string;
    path?: string;
    pattern?: string;
    event?: string;
    schedule?: string;
    parameters?: Array<{ name: string; type: string; required: boolean; location?: string }>;
  };
  handler?: { node_id: string; method_name: string; file?: string; line?: number };
  input?: { type?: string; schema?: string; fields?: Array<{ name?: string; type: string }>; is_positional_only?: boolean };
  output?: { type?: string; schema?: string; status_codes?: number[]; is_named_type?: boolean; is_void?: boolean };
  security?: {
    authenticated?: boolean;
    authorized_roles?: string[];
    roles?: string[];
    permissions?: string[];
    rate_limit?: string;
    enforcement?: 'enforced' | 'assumed';
  };
  capabilities?: Array<{ capability_id: string; capability_name: string; role: string }>;
  interaction_reach?: 'external' | 'internal' | 'unknown';
  deployable_id?: string;
  deployable_name?: string;

  metadata?: {
    telemetry?: {
      request_count?: number;
      error_rate?: number;
      p50_ms?: number;
      p95_ms?: number;
      p99_ms?: number;
    };
    [key: string]: unknown;
  };
}

export interface DeployableOption {
  id: string;
  name: string;
}

export interface FamilyCount {
  family: EntryPointFamily;
  count: number;
  kinds: Array<{ kind: EntryKind; count: number }>;
}

export function useEntryPoints(projectId: string | undefined) {
  const casQuery = useProjectCas(projectId);

  const allEntryPoints = useMemo<EntryPoint[]>(() => {
    const cas = casQuery.data?.status === 'ready' ? casQuery.data.cas : undefined;
    const raw: EntryPoint[] = (cas as { entry_points?: EntryPoint[] } | undefined)?.entry_points ?? [];

    return raw.filter(ep => ep.type !== 'test');
  }, [casQuery.data]);

  const deployables = useMemo<DeployableOption[]>(() => {
    const seen = new Map<string, string>();
    for (const ep of allEntryPoints) {
      const id = ep.deployable_id ?? '__unassigned__';
      const name = ep.deployable_name ?? 'Unassigned';
      if (!seen.has(id)) seen.set(id, name);
    }
    return Array.from(seen, ([id, name]) => ({ id, name }));
  }, [allEntryPoints]);

  return { ...casQuery, allEntryPoints, deployables };
}

export function useEntryPointsForDeployable(projectId: string | undefined, deployableId: string | undefined) {
  const base = useEntryPoints(projectId);

  const scoped = useMemo(() => {
    if (!deployableId) return base.allEntryPoints;
    return base.allEntryPoints.filter(ep => (ep.deployable_id ?? '__unassigned__') === deployableId);
  }, [base.allEntryPoints, deployableId]);

  const familyCounts = useMemo<FamilyCount[]>(() => {
    const kindTally = new Map<EntryKind, number>();
    for (const ep of scoped) {
      if (isKnownKind(ep.type)) kindTally.set(ep.type, (kindTally.get(ep.type) ?? 0) + 1);
    }
    return FAMILY_ORDER.map(family => {
      const kinds = (Object.keys(KIND_META) as EntryKind[])
        .filter(k => KIND_META[k].family === family && kindTally.has(k))
        .map(kind => ({ kind, count: kindTally.get(kind)! }));
      return { family, count: kinds.reduce((sum, k) => sum + k.count, 0), kinds };
    }).filter(f => f.count > 0);
  }, [scoped]);

  return { ...base, entryPoints: scoped, familyCounts };
}

export function useEntryPoint(projectId: string | undefined, entryPointId: string | undefined) {
  const base = useEntryPoints(projectId);
  const entryPoint = useMemo(
    () => resolveSlug(entryPointId, base.allEntryPoints),
    [base.allEntryPoints, entryPointId],
  );
  return { ...base, entryPoint };
}
