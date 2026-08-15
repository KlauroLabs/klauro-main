




































export interface AnalyzerIdentity {
  analyzer_build?: string;
  parser_fingerprint?: string;
  derived_fingerprint?: string;
}

export type AnalyzerIdentityTier = 'parser' | 'derived' | 'build' | 'legacy-build' | 'match' | 'unknown';

export interface AnalyzerIdentityDecision {

  reusable: boolean;
  tier: AnalyzerIdentityTier;

  reason: string;
  stored: AnalyzerIdentity;
  current: AnalyzerIdentity;
}





export function decideAnalyzerIdentityReuse(
  stored: AnalyzerIdentity | null | undefined,
  current: AnalyzerIdentity,
): AnalyzerIdentityDecision {
  const storedIdentity: AnalyzerIdentity = stored || {};
  const base = { stored: storedIdentity, current };



  if (!storedIdentity.analyzer_build && !storedIdentity.parser_fingerprint && !storedIdentity.derived_fingerprint) {
    return {
      ...base,
      reusable: false,
      tier: 'unknown',
      reason: 'Stored analysis carries no analyzer identity; it cannot be proven current.',
    };
  }

  const haveBothFingerprints = Boolean(storedIdentity.parser_fingerprint && storedIdentity.derived_fingerprint)
    && Boolean(current.parser_fingerprint && current.derived_fingerprint);

  if (!haveBothFingerprints) {
    if (storedIdentity.analyzer_build && current.analyzer_build && storedIdentity.analyzer_build === current.analyzer_build) {
      return { ...base, reusable: true, tier: 'match', reason: 'Analyzer build identical to the stored analysis.' };
    }
    return {
      ...base,
      reusable: false,
      tier: 'legacy-build',
      reason: `Stored analysis predates stage fingerprints and its analyzer build differs (${storedIdentity.analyzer_build || 'unknown'} -> ${current.analyzer_build || 'unknown'}); layer-level equivalence cannot be proven.`,
    };
  }

  if (storedIdentity.parser_fingerprint !== current.parser_fingerprint) {
    return {
      ...base,
      reusable: false,
      tier: 'parser',
      reason: `Parser-layer fingerprint changed (${storedIdentity.parser_fingerprint} -> ${current.parser_fingerprint}); parsed structure can differ, so a full re-parse is required.`,
    };
  }

  if (storedIdentity.derived_fingerprint !== current.derived_fingerprint) {
    return {
      ...base,
      reusable: false,
      tier: 'derived',
      reason: `Derived-layer fingerprint changed (${storedIdentity.derived_fingerprint} -> ${current.derived_fingerprint}); derived facts are recomputed, parse-layer caches still apply.`,
    };
  }

  if (storedIdentity.analyzer_build && current.analyzer_build && storedIdentity.analyzer_build !== current.analyzer_build) {
    return {
      ...base,
      reusable: true,
      tier: 'build',
      reason: `Analyzer build changed (${storedIdentity.analyzer_build} -> ${current.analyzer_build}) but both stage fingerprints match; analysis output cannot differ.`,
    };
  }

  return { ...base, reusable: true, tier: 'match', reason: 'Analyzer identity identical to the stored analysis.' };
}
