import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../api';
import { useAuth } from '../auth/AuthProvider';
import { useProjectCas } from './useProjectCas';
import type { EntryPoint } from './useEntryPoints';
import { buildDasIndex } from '../pages/deployable/dasIndex';
import { scopeCapabilities, type UnitCapability } from '../pages/deployable/dasScope';
import type { CasNode, DataEntity, DeployableEvidence } from '../pages/deployable/dasTypes';

/** The Architecture diagram's data source: `deployable_evidence` off the
 *  full CAS payload, run through the client-side promotion-rule mirror in
 *  dasIndex.ts. This stays CAS-based (rather than the real /das endpoint
 *  below) because ArchitectureSection/ArchitectureDiagram need the RAW
 *  evidence rows (bundled_into edges across every row, not just qualified
 *  units) to draw the diagram — the /das index below only rolls up the
 *  qualified units themselves. */
export function useDasIndex(projectId: string | undefined) {
  const casQuery = useProjectCas(projectId);

  const { evidence, nodes, dataEntities } = useMemo(() => {
    const cas = casQuery.data?.status === 'ready' ? casQuery.data.cas : undefined;
    const typed = cas as { deployable_evidence?: DeployableEvidence[]; nodes?: CasNode[]; data_entities?: DataEntity[] } | undefined;
    return {
      evidence: typed?.deployable_evidence ?? [],
      nodes: typed?.nodes ?? [],
      dataEntities: typed?.data_entities ?? [],
    };
  }, [casQuery.data]);

  const dasIndex = useMemo(() => buildDasIndex(evidence), [evidence]);

  return { ...casQuery, ...dasIndex, evidence, nodes, dataEntities };
}

/** One DAS unit as GET /api/projects/:id/das reports it (deployable-
 *  analysis.ts's DasUnitIndexEntry) — the real reachability-closure counts,
 *  not the client-side directory-prefix approximation the picker used
 *  before e9490b69 shipped this route. */
export interface RemoteDasUnit {
  id: string;
  name: string;
  root_path: string;
  member_root_paths: string[];
  tier: 1 | 2 | 3;
  kind: DeployableEvidence['kind'];
  node_count: number;
  entry_point_count: number;
  exit_point_count: number;
  boundary_evidence: string[];
}

interface RemoteDasIndexResponse {
  status: 'ready' | 'no_analysis';
  project_id: string;
  analysis_id?: string;
  das_index?: {
    promoted: boolean;
    units: RemoteDasUnit[];
    orphan_node_count: number;
    orphan_node_ids: string[];
  };
  error?: string;
}

/**
 * The DAS unit picker's real data source — GET /api/projects/:id/das
 * (deployable-analysis.ts's buildDeployableAnalyses().das_index, shipped
 * e9490b69). Replaces the old client-side directory-prefix mirror: this is
 * the actual reachability-closure slice (node/entry/exit counts + orphan
 * accounting), the same numbers the MCP get_summary tool's das_index reports.
 */
export function useDasUnitIndex(projectId: string | undefined) {
  const { token } = useAuth();
  const query = useQuery({
    queryKey: ['project-das-index', projectId],
    queryFn: () => apiRequest<RemoteDasIndexResponse>(`/api/projects/${encodeURIComponent(projectId!)}/das`, token!),
    enabled: Boolean(token && projectId),
  });

  return {
    ...query,
    promoted: query.data?.das_index?.promoted ?? false,
    units: query.data?.das_index?.units ?? [],
    orphanNodeCount: query.data?.das_index?.orphan_node_count,
    orphanNodeIds: query.data?.das_index?.orphan_node_ids ?? [],
  };
}

interface RemoteDasUnitCas {
  entry_points?: EntryPoint[];
  data_entities?: DataEntity[];
  nodes?: CasNode[];
  deployable_evidence?: DeployableEvidence[];
}

interface RemoteDasCasResponse {
  status: 'ready' | 'no_analysis';
  project_id: string;
  analysis_id?: string;
  das_unit_id?: string;
  cas?: RemoteDasUnitCas;
  error?: string;
}

export interface DasShipEvidenceFields {
  ships_paths?: string[];
  ports?: number[];
  entrypoint_member?: string;
  base_images?: string[];
}

/**
 * One DAS unit's real scoped slice — GET /api/projects/:id/cas?das_unit_id=
 * (deployable-analysis.ts's scopeCasToDasUnit, shipped e9490b69). Replaces
 * the old client-side root-path/id attribution (dasScope.ts's
 * scopeEntryPoints/scopeFiles/scopeEntities): the server already returns
 * `entry_points`/`data_entities`/`nodes` PRE-SCOPED to this unit's true
 * reachability closure, so no client-side re-scoping happens here — only
 * light shaping (test-type exclusion, capability aggregation, ship-evidence
 * unpacking off the returned `deployable_evidence` — [this unit's own
 * evidence row, ...its bundled members], per scopeCasToDasUnit's doc
 * comment).
 */
export function useDasUnitSlice(projectId: string | undefined, dasUnitId: string | undefined) {
  const { token } = useAuth();
  const query = useQuery({
    queryKey: ['project-das-unit-cas', projectId, dasUnitId],
    queryFn: () =>
      apiRequest<RemoteDasCasResponse>(
        `/api/projects/${encodeURIComponent(projectId!)}/cas?das_unit_id=${encodeURIComponent(dasUnitId!)}`,
        token!,
      ),
    enabled: Boolean(token && projectId && dasUnitId),
  });

  const cas = query.data?.status === 'ready' ? query.data.cas : undefined;

  const entryPoints = useMemo<EntryPoint[]>(
    () => (cas?.entry_points ?? []).filter(ep => ep.type !== 'test'),
    [cas],
  );
  const capabilities = useMemo<UnitCapability[]>(() => scopeCapabilities(entryPoints), [entryPoints]);
  const entities = useMemo<DataEntity[]>(() => cas?.data_entities ?? [], [cas]);
  const files = useMemo<string[]>(() => {
    const seen = new Set<string>();
    for (const node of cas?.nodes ?? []) {
      if (node.source?.file) seen.add(node.source.file);
    }
    return Array.from(seen).sort();
  }, [cas]);
  const shipEvidence = useMemo<DasShipEvidenceFields | undefined>(() => {
    const own = cas?.deployable_evidence?.[0];
    if (!own) return undefined;
    return { ships_paths: own.ships_paths, ports: own.ports, entrypoint_member: own.entrypoint_member, base_images: own.base_images };
  }, [cas]);

  return { ...query, entryPoints, capabilities, entities, files, shipEvidence };
}
