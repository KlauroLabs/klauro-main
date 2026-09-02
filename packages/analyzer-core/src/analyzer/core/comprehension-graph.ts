import type {
  CASCallChain,
  CASChangeRisk,
  CASDataEntity,
  CASEdge,
  CASEntryPoint,
  CASExitPoint,
  CASNode,
  CASOutput,
  SystemCapability,
} from '../../types/cas.types';
import { buildDataLineage } from './data-lineage';
import { computeFlowConcepts } from './flow-concepts';
import { buildUserJourneys } from './journey-builder';

export interface ComprehensionGraphInput {
  nodes: CASNode[];
  edges: CASEdge[];
  entryPoints: CASEntryPoint[];
  exitPoints: CASExitPoint[];
  callChains: CASCallChain[];
  dataEntities: CASDataEntity[];
  capabilities: SystemCapability[];
  behaviorSurfaces: SystemCapability[];
  changeRisks: CASChangeRisk[];
  nodeLookup?: Map<string, CASNode>;
}

export function buildComprehensionGraph(input: ComprehensionGraphInput) {
  const structuralLineage = buildDataLineage({
    nodes: input.nodes,
    edges: input.edges,
    dataEntities: input.dataEntities,
    exitPoints: input.exitPoints,
    entryPoints: input.entryPoints,
    userJourneys: [],
  });
  const flows = computeFlowConcepts({
    nodes: input.nodes,
    edges: input.edges,
    entry_points: input.entryPoints,
    exit_points: input.exitPoints,
    call_chains: input.callChains,
    data_lineage: structuralLineage,
    entities: input.dataEntities,
    capabilities: input.capabilities,
    behavior_surfaces: input.behaviorSurfaces,
  } as CASOutput, {});
  const journeyResult = buildUserJourneys({
    nodes: input.nodes,
    nodeLookup: input.nodeLookup,
    edges: input.edges,
    entryPoints: input.entryPoints,
    exitPoints: input.exitPoints,
    callChains: input.callChains,
    dataEntities: input.dataEntities,
    changeRisks: input.changeRisks,
    flows,
  });
  const dataLineage = buildDataLineage({
    nodes: input.nodes,
    edges: input.edges,
    dataEntities: input.dataEntities,
    exitPoints: input.exitPoints,
    entryPoints: input.entryPoints,
    userJourneys: journeyResult.journeys,
  });
  return { flows, journeyResult, dataLineage };
}
