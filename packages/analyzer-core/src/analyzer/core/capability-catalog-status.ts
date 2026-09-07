import type { CASOutput } from '../../types/cas.types';
import { applyComprehensionNarrativeStatus } from './comprehension-status';

const ERROR_CODE = 'CAPABILITY_CATALOG_REJECTED';

function catalogFailure(output: CASOutput): string | undefined {
  const settled = output.ai_enrichment === 'ready' || output.ai_enrichment === 'synchronous';
  if (!settled) return undefined;
  const coverage = output.enhanced_system_purpose?.capability_catalog_coverage;
  if (coverage?.status === 'accepted') return undefined;
  if (!coverage) return 'Capability catalog coverage was not reported after AI comprehension completed';
  return `Capability catalog was ${coverage.status}: ${coverage.reason || `${coverage.published_capabilities || 0} canonical capabilities were published`}`;
}

export function applyCapabilityCatalogStatus(output: CASOutput): void {
  applyComprehensionNarrativeStatus(output);
  const failure = catalogFailure(output);
  if (!failure) return;

  output.analysis_errors ||= [];
  if (!output.analysis_errors.some(error => error.code === ERROR_CODE)) {
    output.analysis_errors.push({
      severity: 'error',
      code: ERROR_CODE,
      message: failure,
      analyzer: 'capability-catalog',
      recoverable: true,
      suggestion: 'Retry AI capability comprehension; structural graph evidence remains available.',
    });
  }

  const agentContext = output.analysis_phases?.find(phase => phase.id === 'agent-context');
  if (agentContext) {
    agentContext.status = 'failed';
    agentContext.notes = [failure];
  }
}

export function capabilityCatalogErrorCode(): string {
  return ERROR_CODE;
}
