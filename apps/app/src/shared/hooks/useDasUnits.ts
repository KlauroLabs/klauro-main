import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/shared/api/index';
import { useAuth } from '@/shared/auth/AuthProvider';
import { useProjectCas } from './useProjectCas';
import type { EntryPoint } from './useEntryPoints';
import { buildDasIndex } from '@/app/Deployable/dasIndex';
import { scopeCapabilities, type UnitCapability } from '@/app/Deployable/dasScope';
import type { CasNode, DataEntity, DeployableEvidence } from '@/app/Deployable/dasTypes';

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
  sub_cas_nodes?: {
    promoted: boolean;
    units: RemoteDasUnit[];
    /** How many units qualified vs how many promotion needs — reported even
     *  when `promoted` is false, so "1 found, below the threshold" is
     *  distinguishable from "no ship evidence found at all". */
    qualified_unit_count?: number;
    promotion_threshold?: number;
    reason?: string;
    graph_node_count?: number;
    covered_node_count?: number;
    coverage_ratio?: number;
    orphan_node_count: number;
    orphan_node_ids: string[];
  };
  error?: string;
}

export function useDasUnitIndex(projectId: string | undefined) {
  const { token } = useAuth();
  const query = useQuery({
    queryKey: ['project-das-index', projectId],
    queryFn: () => apiRequest<RemoteDasIndexResponse>(`/api/projects/${encodeURIComponent(projectId!)}/das`, token!),
    enabled: Boolean(token && projectId),
  });

  return {
    ...query,
    promoted: query.data?.sub_cas_nodes?.promoted ?? false,
    units: query.data?.sub_cas_nodes?.units ?? [],
    qualifiedUnitCount: query.data?.sub_cas_nodes?.qualified_unit_count,
    promotionThreshold: query.data?.sub_cas_nodes?.promotion_threshold,
    promotionReason: query.data?.sub_cas_nodes?.reason,
    coverageRatio: query.data?.sub_cas_nodes?.coverage_ratio,
    coveredNodeCount: query.data?.sub_cas_nodes?.covered_node_count,
    graphNodeCount: query.data?.sub_cas_nodes?.graph_node_count,
    orphanNodeCount: query.data?.sub_cas_nodes?.orphan_node_count,
    orphanNodeIds: query.data?.sub_cas_nodes?.orphan_node_ids ?? [],
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
