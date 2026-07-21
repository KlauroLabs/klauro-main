import { useMemo } from 'react';
import { useProjectCas } from './useProjectCas';
import { FAMILY_ORDER, isKnownKind, KIND_META, type EntryKind, type EntryPointFamily } from '../components/entryPointKinds';
import { resolveSlug } from '../lib/slugs';

/**
 * Local mirror of the analyzer's CASEntryPoint/CASExitPoint shape
 * (packages/analyzer-core/src/types/cas.types.ts) — apps/app does not depend
 * on the analyzer-core package (see api.ts's own mirrored interfaces for the
 * same convention), so the fields consumed here are redeclared narrowly.
 * 'test' is a valid CASEntryPointType but is excluded everywhere per the
 * design brief ("counts... tests excluded").
 */
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
  /** Runtime/health numbers, present only for a deployment that is running
   *  and instrumented (brief, "The live layer" — absent is the common
   *  case, not an error). Not a CASEntryPoint field today; read
   *  defensively out of `metadata` since no dedicated telemetry route is
   *  wired into GET /api/projects/:id/cas yet — see DESIGN-NOTES.md. */
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

/**
 * Reads entry points out of the full CAS payload (`useProjectCas`, an
 * ui-scaffold-lane hook — in-flight reuse per LANE-COMMON.md's fabric
 * protocol: consumed here against its declared name/shape even before it
 * lands. Assumed shape: `{ status, cas: { entry_points?: EntryPoint[] } }`,
 * mirroring the GET /api/projects/:id/cas envelope documented in
 * remote-analyzer-service.ts.
 */
export function useEntryPoints(projectId: string | undefined) {
  const casQuery = useProjectCas(projectId);

  const allEntryPoints = useMemo<EntryPoint[]>(() => {
    const cas = casQuery.data?.status === 'ready' ? casQuery.data.cas : undefined;
    const raw: EntryPoint[] = (cas as { entry_points?: EntryPoint[] } | undefined)?.entry_points ?? [];
    // Tests are excluded from every view per the brief.
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

/** Scope + summarize entry points for one deployable — the per-deployable
 *  view is binding per the brief ("the viewer is always looking at ONE
 *  deployable, with the ability to switch to another"). */
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

/** `entryPointId` is a `name~suffix` slug (src/lib/slugs.ts) or a legacy raw
 *  id — resolved against this codebase's own entry point list, same pattern
 *  as useFlow.ts. EntryPointDetailPage redirects to the canonical slug once
 *  this resolves. */
export function useEntryPoint(projectId: string | undefined, entryPointId: string | undefined) {
  const base = useEntryPoints(projectId);
  const entryPoint = useMemo(
    () => resolveSlug(entryPointId, base.allEntryPoints),
    [base.allEntryPoints, entryPointId],
  );
  return { ...base, entryPoint };
}
