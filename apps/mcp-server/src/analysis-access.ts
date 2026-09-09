import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { CAS_SECTION_NAMES, type CasSectionName } from './cas-sections';
import { assertAnalysisVersionSupported, loadAnalysis, loadAnalysisSections, loadCompleteAnalysisFromSections } from './storage';
import { applyStoredElementDescriptions } from './description-enrichment';

export async function getAnalysis(
  projectPath: string,
  options?: { track?: import('./track').AnalysisTrack; sections?: readonly CasSectionName[]; cas_id?: string }
): Promise<CASOutput> {
  if (options?.cas_id && !options.sections) {
    const subtree = await loadCompleteAnalysisFromSections(projectPath, { track: options.track, cas_id: options.cas_id });
    if (!subtree) throw new Error(`No analysis found for: ${projectPath}. Run analyze_codebase first.`);
    assertAnalysisVersionSupported(subtree, projectPath);
    return applyStoredElementDescriptions(projectPath, subtree);
  }
  if (options?.cas_id || options?.sections?.length && options.sections.length < CAS_SECTION_NAMES.length) {



    const partial = await loadAnalysisSections(
      projectPath,
      options.sections || CAS_SECTION_NAMES,
      {
        ...(options.track ? { track: options.track } : {}),
        ...(options.cas_id ? { cas_id: options.cas_id } : {}),
      },
    );
    if (!partial) throw new Error(`No analysis found for: ${projectPath}. Run analyze_codebase first.`);
    assertAnalysisVersionSupported(partial as CASOutput, projectPath);
    return partial as CASOutput;
  }

  const cached = await loadAnalysis(projectPath, { preferCache: true, ...(options?.track ? { track: options.track } : {}) });
  if (cached) {
    assertAnalysisVersionSupported(cached, projectPath);
    return applyStoredElementDescriptions(projectPath, cached);
  }
  throw new Error(`No analysis found for: ${projectPath}. Run analyze_codebase first.`);
}
