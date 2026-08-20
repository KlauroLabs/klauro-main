import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { evaluateComprehensionReadiness } from './comprehension-readiness';

export interface AnalysisResponseReadiness {
  status: 'ready' | 'populating' | 'partial' | 'failed';
  ready: boolean;
  failed_layers?: string[];
  pending_layers?: string[];
  error?: string;
}

export interface AnalysisResponseIdentity {
  project_id: string;
  analysis_id: string;
  analysis_timestamp?: string;
  tool?: string;
}

export interface ConceptualCatalogPage {
  limit: number;
  offset: number;
}

const DEFAULT_CONCEPTUAL_CATALOG_LIMIT = 25;
const MAX_CONCEPTUAL_CATALOG_LIMIT = 100;

export function comprehensionResponseReadiness(cas: CASOutput): AnalysisResponseReadiness {
  const layers = cas.layers_ready?.layers || [];
  const comprehensionLayers = layers.filter(layer => layer.layer === 'L4' || layer.layer === 'L5');
  const failed = comprehensionLayers.filter(layer => layer.status === 'error');
  if (failed.length > 0) {
    return {
      status: 'failed',
      ready: false,
      failed_layers: failed.map(layer => layer.layer),
      error: failed.find(layer => layer.error)?.error || 'Analysis comprehension failed.',
    };
  }
  const pending = comprehensionLayers.filter(layer => layer.status === 'pending');
  if (pending.length > 0) {
    return {
      status: 'populating',
      ready: false,
      pending_layers: pending.map(layer => layer.layer),
      error: 'Analysis comprehension is still populating.',
    };
  }

  const hasExplicitComprehensionState = comprehensionLayers.length > 0
    || cas.ai_enrichment !== undefined
    || cas.enhanced_system_purpose?.capability_catalog_coverage !== undefined;
  if (!hasExplicitComprehensionState) return { status: 'ready', ready: true };

  const readiness = evaluateComprehensionReadiness(cas);
  if (readiness.ready) return { status: 'ready', ready: true };
  return {
    status: readiness.status === 'error' ? 'failed' : readiness.status === 'pending' ? 'populating' : 'partial',
    ready: false,
    error: readiness.reason,
  };
}

export function hostedQueryResponseReadiness(cas: CASOutput, tool: string): AnalysisResponseReadiness {
  if (tool === 'get_product_map' || tool === 'run_answer_pack') {
    return comprehensionResponseReadiness(cas);
  }
  return { status: 'ready', ready: true };
}

export function unavailableComprehensionResponse(
  cas: CASOutput,
  identity: AnalysisResponseIdentity,
  tool?: string,
): (AnalysisResponseIdentity & Omit<AnalysisResponseReadiness, 'ready'>) | undefined {
  const readiness = tool ? hostedQueryResponseReadiness(cas, tool) : comprehensionResponseReadiness(cas);
  if (readiness.ready) return undefined;
  const { ready: _ready, ...responseReadiness } = readiness;
  return { ...identity, ...responseReadiness };
}

export function parseConceptualCatalogPage(searchParams: URLSearchParams): ConceptualCatalogPage {
  const requestedLimit = Number(searchParams.get('capability_limit'));
  const requestedOffset = Number(searchParams.get('capability_offset'));
  return {
    limit: Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(Math.floor(requestedLimit), MAX_CONCEPTUAL_CATALOG_LIMIT)
      : DEFAULT_CONCEPTUAL_CATALOG_LIMIT,
    offset: Number.isFinite(requestedOffset) && requestedOffset > 0 ? Math.floor(requestedOffset) : 0,
  };
}

function pageItems<T>(items: T[], page: ConceptualCatalogPage) {
  const values = items.slice(page.offset, page.offset + page.limit);
  const hasMore = page.offset + values.length < items.length;
  return {
    values,
    page: {
      total: items.length,
      offset: page.offset,
      limit: page.limit,
      returned: values.length,
      has_more: hasMore,
      next_offset: hasMore ? page.offset + values.length : null,
    },
  };
}

export function paginateConceptualCatalog<TCapability, TSurface>(
  capabilities: TCapability[],
  behaviorSurfaces: TSurface[],
  page: ConceptualCatalogPage,
) {
  return {
    capabilities: pageItems(capabilities, page),
    behavior_surfaces: pageItems(behaviorSurfaces, page),
  };
}
