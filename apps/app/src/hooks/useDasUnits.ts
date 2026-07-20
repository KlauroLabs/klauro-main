import { useMemo } from 'react';
import { useProjectCas } from './useProjectCas';
import { useEntryPoints } from './useEntryPoints';
import { buildDasIndex, type DasUnitSummary } from '../pages/deployable/dasIndex';
import { scopeEntryPoints, scopeCapabilities, scopeFiles, scopeEntities, buildNodesById } from '../pages/deployable/dasScope';
import type { CasNode, DataEntity, DeployableEvidence } from '../pages/deployable/dasTypes';

/** The DAS picker's data source: `deployable_evidence` off the full CAS
 *  payload, run through the client-side promotion-rule mirror in
 *  dasIndex.ts. See DasUnitOverview.tsx / DasOrphanNotice.tsx for what this
 *  deliberately does NOT compute (node/entry/exit counts, orphan nodes) —
 *  that's the true DAS reachability slice, MCP-only today. */
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

/** One unit's slice: scoped entry points, capabilities, files, entities —
 *  each derived client-side from repo-wide CAS data (see dasScope.ts). */
export function useDasUnitSlice(projectId: string | undefined, unit: DasUnitSummary | undefined) {
  const index = useDasIndex(projectId);
  const entryPointsQuery = useEntryPoints(projectId);

  const scopedEntryPoints = useMemo(
    () => (unit ? scopeEntryPoints(entryPointsQuery.allEntryPoints, unit) : []),
    [entryPointsQuery.allEntryPoints, unit],
  );
  const capabilities = useMemo(() => scopeCapabilities(scopedEntryPoints), [scopedEntryPoints]);
  const files = useMemo(() => (unit ? scopeFiles(index.nodes, unit) : []), [index.nodes, unit]);
  const entities = useMemo(() => {
    if (!unit) return [];
    const nodesById = buildNodesById(index.nodes);
    return scopeEntities(index.dataEntities, nodesById, unit);
  }, [index.nodes, index.dataEntities, unit]);

  return {
    ...index,
    entryPoints: scopedEntryPoints,
    capabilities,
    files,
    entities,
    isLoading: index.isLoading || entryPointsQuery.isLoading,
    isError: index.isError || entryPointsQuery.isError,
  };
}
