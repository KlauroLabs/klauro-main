/**
 * ANALYZER-IDENTITY REUSE GATE.
 *
 * The defect this exists for (live, deployed build): `/v1/analyze` deduped on
 * the SOURCE SNAPSHOT alone. A customer who upgraded the CLI and re-ran
 * `analyze` on an unchanged repo got `{ reused: true, analysis_type:
 * "unchanged" }` and their OLD analysis back — no analyzer fix ever reached
 * them, silently, because a new analyzer build did not invalidate anything.
 * Every re-run during the audit needed an explicit `/reanalyze`.
 *
 * Identity is now BOTH halves: the source AND the analyzer that read it. The
 * pieces already existed — stage fingerprints (analyzer-core's
 * stage-fingerprint.ts, split parser/derived) and the whole-build stamp — this
 * puts them on the reuse path and names the tier so the cost is predictable:
 *
 *  - PARSER tier (`parser_fingerprint` differs): the parse/language-analyzer
 *    layer changed, so parsed node/edge shape can change for any file.
 *    Cost: a full re-parse of the snapshot.
 *  - DERIVED tier (`derived_fingerprint` differs, parser matches): only the
 *    graph/derived-facts layer changed. The analysis re-runs, but every
 *    parse-layer cache is keyed on `parser_fingerprint` (see
 *    tree-sitter-ts-extraction-cache.ts), which still matches — so extraction
 *    is served from cache and the cost is the derived layers, not the parse.
 *  - BUILD tier (both fingerprints match, `analyzer_build` differs): an
 *    MCP-tool-only / WAS-only / marketing release that cannot change analysis
 *    output. REUSE — this is exactly the case stage fingerprints exist for,
 *    and re-analyzing here would make every deploy a cold rebuild for every
 *    project.
 *  - LEGACY tier (stored analysis predates stage fingerprints): equivalence
 *    cannot be proven at the layer level, so fall back to the whole-build
 *    stamp — differ = re-analyze. Same stance orchestrator.ts's
 *    `fullRebuildReasonForPreviousOutput` already takes for legacy outputs.
 *
 * Every decision is REPORTED, not just applied: `reused: true` with no reason
 * is what kept this invisible for so long.
 */

export interface AnalyzerIdentity {
  analyzer_build?: string;
  parser_fingerprint?: string;
  derived_fingerprint?: string;
}

export type AnalyzerIdentityTier = 'parser' | 'derived' | 'build' | 'legacy-build' | 'match' | 'unknown';

export interface AnalyzerIdentityDecision {
  /** False = the stored analysis must be re-analyzed before it may be served. */
  reusable: boolean;
  tier: AnalyzerIdentityTier;
  /** Human-readable, safe to return to a client. Never contains a file path. */
  reason: string;
  stored: AnalyzerIdentity;
  current: AnalyzerIdentity;
}

/**
 * Decide whether a stored analysis with `stored` identity may be reused by a
 * server running `current`. Pure — no I/O — so it is directly testable.
 */
export function decideAnalyzerIdentityReuse(
  stored: AnalyzerIdentity | null | undefined,
  current: AnalyzerIdentity,
): AnalyzerIdentityDecision {
  const storedIdentity: AnalyzerIdentity = stored || {};
  const base = { stored: storedIdentity, current };

  // No identity at all on the stored analysis: it predates every stamp. We
  // cannot prove it was produced by this analyzer, so it is not reusable.
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
