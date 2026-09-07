import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { evaluateComprehensionReadiness } from './comprehension-readiness';
import { isStructuralAnalysisLayer } from './analysis-layer-contract';
export { isStructuralAnalysisLayer } from './analysis-layer-contract';

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

export interface LatestAnalysisAttempt {
  state?: string;
  trigger?: string;
  reason?: string;
  started_at?: string;
  queued_at?: string;
}

export interface LegacyQueryFailureResult {
  status: Exclude<AnalysisResponseReadiness['status'], 'ready'>;
  error?: string;
  failed_layers?: string[];
  pending_layers?: string[];
}

export interface ConceptualCatalogPage {
  limit: number;
  offset: number;
}

const DEFAULT_CONCEPTUAL_CATALOG_LIMIT = 5;
const MAX_CONCEPTUAL_CATALOG_LIMIT = 100;

export function comprehensionResponseReadiness(cas: CASOutput): AnalysisResponseReadiness {
  if (!cas.layers_ready?.layers?.length) {
    return {
      status: 'failed',
      ready: false,
      error: 'Analysis readiness manifest is missing.',
    };
  }
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
  if (hostedQueryRequiresComprehension(tool)) {
    return comprehensionResponseReadiness(cas);
  }
  return { status: 'ready', ready: true };
}

export function hostedQueryRequiresComprehension(tool: string): boolean {
  return tool === 'get_product_map' || tool === 'run_answer_pack';
}

interface AnalysisLayerFailure {
  layer: string;
  status: string;
  error?: string;
}

export function unavailableStructuralQueryResponse(
  layers: AnalysisLayerFailure[],
  identity: AnalysisResponseIdentity & { tool: string },
): Record<string, unknown> | undefined {
  const structuralError = layers.find(layer => isStructuralAnalysisLayer(layer.layer) && layer.status === 'error');
  if (!structuralError) return undefined;
  const relevantError = hostedQueryRequiresComprehension(identity.tool)
    ? layers.find(layer => (layer.layer === 'L4' || layer.layer === 'L5') && layer.status === 'error') || structuralError
    : structuralError;
  const error = relevantError.error || 'The analysis failed before the requested result could be produced.';
  return { ...identity, status: 'failed', error, result: { status: 'failed', error } };
}

export function unavailableStructuralAnalysisResponse(
  layers: AnalysisLayerFailure[],
  identity: AnalysisResponseIdentity,
  fallbackError: string,
  lastAttempt?: LatestAnalysisAttempt | null,
): Record<string, unknown> | undefined {
  const structuralErrors = layers.filter(layer => isStructuralAnalysisLayer(layer.layer) && layer.status === 'error');
  if (structuralErrors.length === 0) return undefined;
  return {
    ...identity,
    status: 'failed',
    analysis_error: structuralErrors.map(layer => layer.error).filter(Boolean).join('; ') || fallbackError,
    failed_layers: structuralErrors.map(layer => layer.layer),
    ...(lastAttempt ? { last_attempt: lastAttempt } : {}),
  };
}

export function completedAnalysisLandedAfterAttempt(
  entry: { analyzed_at?: string; layers_ready?: { complete?: boolean; layers?: Array<{ status: string }> } } | null,
  attempt: { started_at?: string; queued_at?: string },
): boolean {
  const layers = entry?.layers_ready?.layers || [];
  return Boolean(analysisLandedAfterAttempt(entry, attempt)
    && entry?.layers_ready?.complete
    && layers.length > 0
    && layers.every(layer => layer.status === 'ready'));
}

export function analysisLandedAfterAttempt(
  entry: { analyzed_at?: string } | null,
  attempt: { started_at?: string; queued_at?: string },
): boolean {
  const startedAt = Date.parse(attempt.started_at || attempt.queued_at || '');
  const analyzedAt = Date.parse(entry?.analyzed_at || '');
  return Boolean(entry && Number.isFinite(startedAt) && Number.isFinite(analyzedAt) && analyzedAt >= startedAt);
}

export function unavailableFailedAttemptWithStaleAnalysis(
  entry: { analyzed_at?: string; layers_ready?: { layers?: Array<{ layer: string; status: string }> } } | null,
  attempt: LatestAnalysisAttempt | null | undefined,
  identity: AnalysisResponseIdentity,
): ReturnType<typeof unavailableLatestAnalyzeAttempt> {
  if (attempt?.state !== 'failed' || !entry || failedAttemptHasQueryableAnalysis(entry, attempt)) return undefined;
  return unavailableLatestAnalyzeAttempt(attempt, identity);
}

export function failedAttemptHasQueryableAnalysis(
  entry: { analyzed_at?: string; layers_ready?: { layers?: Array<{ layer: string; status: string }> } } | null,
  attempt: LatestAnalysisAttempt | null | undefined,
): boolean {
  const structural = (entry?.layers_ready?.layers || []).filter(layer => isStructuralAnalysisLayer(layer.layer));
  return Boolean(attempt?.state === 'failed'
    && analysisLandedAfterAttempt(entry, attempt)
    && ['L0', 'L1', 'L2', 'L3'].every(required => structural.some(layer => layer.layer === required && layer.status === 'ready')));
}

export function unavailableComprehensionResponse(
  cas: CASOutput,
  identity: AnalysisResponseIdentity,
  tool?: string,
): (AnalysisResponseIdentity & Omit<AnalysisResponseReadiness, 'ready'> & { result?: LegacyQueryFailureResult }) | undefined {
  const readiness = tool ? hostedQueryResponseReadiness(cas, tool) : comprehensionResponseReadiness(cas);
  if (readiness.ready) return undefined;
  const { ready: _ready, ...responseReadiness } = readiness;
  const response = { ...identity, ...responseReadiness };
  const legacyResult = { ...responseReadiness, status: responseReadiness.status as LegacyQueryFailureResult['status'] };
  return tool ? { ...response, result: legacyResult } : response;
}

export function unavailableLatestAnalyzeAttempt(
  attempt: LatestAnalysisAttempt | null | undefined,
  identity: AnalysisResponseIdentity,
): (AnalysisResponseIdentity & { status: 'failed'; error: string; last_attempt: LatestAnalysisAttempt; result?: LegacyQueryFailureResult }) | undefined {
  if (attempt?.state !== 'failed') return undefined;
  const error = attempt.reason || 'The latest committed-source analysis failed.';
  const response = { ...identity, status: 'failed' as const, error, last_attempt: attempt };
  return identity.tool ? { ...response, result: { status: 'failed' as const, error } } : response;
}

export function parseConceptualCatalogPage(searchParams: URLSearchParams): ConceptualCatalogPage {
  const requestedLimit = Number(searchParams.get('catalog_limit') ?? searchParams.get('capability_limit'));
  const requestedOffset = Number(searchParams.get('catalog_offset') ?? searchParams.get('capability_offset'));
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

export function paginateCapabilityReconciliation(
  reconciliation: NonNullable<NonNullable<CASOutput['enhanced_system_purpose']>['capability_reconciliation']> | undefined,
  page: ConceptualCatalogPage,
) {
  if (!reconciliation) return undefined;
  const boundedPage = { ...page, limit: Math.min(page.limit, 20) };
  return {
    summary: {
      proposals: reconciliation.proposals.length,
      grounded: reconciliation.proposals.filter(proposal => proposal.disposition === 'grounded').length,
      intent_gaps: reconciliation.proposals.filter(proposal => proposal.disposition === 'intent-gap').length,
      undocumented_capabilities: reconciliation.undocumented_capabilities.length,
      structural_gaps: reconciliation.structural_gaps?.length || 0,
      ...(reconciliation.unverified_declarations ? { unverified_declarations: reconciliation.unverified_declarations.length } : {}),
    },
    proposals: pageItems(reconciliation.proposals, boundedPage),
    undocumented_capabilities: pageItems(reconciliation.undocumented_capabilities, boundedPage),
    structural_gaps: pageItems(reconciliation.structural_gaps || [], boundedPage),
    ...(reconciliation.unverified_declarations ? { unverified_declarations: pageItems(reconciliation.unverified_declarations, boundedPage) } : {}),
  };
}
