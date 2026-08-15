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
