import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import type { CasSectionName } from './cas-sections';

export interface CasProjectionMetadata {
  loaded_sections: readonly CasSectionName[];
  node_count?: number;
  edge_count?: number;
}

const CAS_PROJECTION = Symbol.for('klauro.cas.projection');

type ProjectedCas = CASOutput & { [CAS_PROJECTION]?: CasProjectionMetadata };

export function attachCasProjection(cas: CASOutput, metadata: CasProjectionMetadata): CASOutput {
  Object.defineProperty(cas, CAS_PROJECTION, {
    configurable: true,
    enumerable: false,
    value: Object.freeze({
      ...metadata,
      loaded_sections: Object.freeze([...new Set(metadata.loaded_sections)]),
    }),
  });
  return cas;
}

export function casProjection(cas: CASOutput): CasProjectionMetadata | undefined {
  return (cas as ProjectedCas)[CAS_PROJECTION];
}

export function casSectionLoaded(cas: CASOutput, section: CasSectionName): boolean {
  const projection = casProjection(cas);
  return !projection || projection.loaded_sections.includes(section);
}

export function casNodeCount(cas: CASOutput): number {
  return casProjection(cas)?.node_count ?? cas.nodes.length;
}

export function casEdgeCount(cas: CASOutput): number {
  return casProjection(cas)?.edge_count ?? cas.edges.length;
}

export function casProjectionSummary(cas: CASOutput): Record<string, unknown> | undefined {
  const projection = casProjection(cas);
  if (!projection) return undefined;
  return {
    kind: 'bounded-section-projection',
    loaded_sections: projection.loaded_sections,
    graph_detail_loaded: projection.loaded_sections.includes('graph'),
    counts_source: projection.node_count !== undefined && projection.edge_count !== undefined
      ? 'canonical-compact-graph-manifest'
      : 'loaded-sections',
  };
}

export function projectedLayerEvidence(
  cas: CASOutput,
  layer: 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5',
  detail: string,
): { status: 'pass' | 'warn' | 'fail'; score: number; detail: string } {
  const persisted = cas.layers_ready?.layers?.find(item => item.layer === layer);
  if (persisted?.status === 'ready') return { status: 'pass', score: 100, detail: `${detail}; persisted ${layer} status is ready` };
  if (persisted?.status === 'error') return { status: 'fail', score: 0, detail: `${detail}; persisted ${layer} status is error${persisted.error ? `: ${persisted.error}` : ''}` };
  return { status: 'warn', score: 80, detail: `${detail}; persisted ${layer} readiness is unavailable` };
}
