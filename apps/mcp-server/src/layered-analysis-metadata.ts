import type { AnalysisFocus } from './analysis-focus';
import type { RepoFacts } from './remote-source';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

export interface LayeredAnalysisMetadata {
  analysisFocus?: AnalysisFocus;
  repoFacts?: RepoFacts;
  repoFactsUnavailable?: boolean;
}

export function applyLayeredAnalysisMetadata(output: CASOutput, metadata: LayeredAnalysisMetadata): void {
  output.system.analysis_focus = metadata.analysisFocus || 'full';
  if (metadata.repoFacts) {
    output.system.repo_facts = metadata.repoFacts;
    delete output.system.repo_facts_status;
  } else if (metadata.repoFactsUnavailable && !output.system.repo_facts) {
    output.system.repo_facts_status = {
      available: false,
      reason: 'This server-side analysis did not receive repository history facts from a client checkout.',
    };
  }
}

export function resolveLayeredEnrichmentPhase(
  output: Pick<CASOutput, 'ai_enrichment' | 'ai_enrichment_error' | 'layers_ready'>,
): { status: 'succeeded' | 'failed'; error?: string } {
  const failures = (output.layers_ready?.layers || [])
    .filter(layer => (layer.layer === 'L4' || layer.layer === 'L5') && layer.status !== 'ready')
    .map(layer => `${layer.layer}: ${layer.error || (layer.status === 'pending' ? 'Layer remains pending after enrichment finished.' : 'Layer was rejected.')}`);
  if (output.ai_enrichment === 'error') {
    failures.push(output.ai_enrichment_error || 'AI enrichment failed.');
  } else if (output.ai_enrichment === 'pending') {
    failures.push('AI enrichment remains pending after the worker finished.');
  } else if (!output.ai_enrichment && !output.layers_ready?.layers.some(layer => layer.layer === 'L5' && layer.status === 'ready')) {
    failures.push('AI enrichment has no terminal status.');
  }
  return failures.length > 0
    ? { status: 'failed', error: [...new Set(failures)].join(' ') }
    : { status: 'succeeded' };
}
