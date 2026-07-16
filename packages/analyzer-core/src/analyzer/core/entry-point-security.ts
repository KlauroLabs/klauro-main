import type {
  CASEntryPoint,
  CASSecurityBoundary,
  CASSecurityContext,
} from '../../types/cas.types';

/**
 * Entry-point security attachment — closes the "system security is computed
 * but never joined onto entry points" gap.
 *
 * Klauro already produces system-level security evidence (security_boundaries
 * from the boundary/enforcement-point analyzer, security_contexts from the
 * per-node security-context analyzer) but neither is joined back onto
 * `CASEntryPoint.security`, so a caller asking "is THIS route protected?"
 * gets nothing even when the system clearly has an auth boundary wrapping it.
 *
 * This module is the join: for each entry point, gather every node id that
 * plausibly represents it (its handler, its own source node, and any
 * connected nodes), then check whether any of those ids show up as an
 * enforcement point on a security boundary, or inside a security context's
 * scope (either via `scope.node_ids` intersecting the candidate set, or via
 * the more direct `scope.entry_points` list carrying the entry point's own
 * id).
 *
 * Evidence-gated by construction: an entry point with no matching boundary
 * or context keeps `security` exactly as it came in (usually `undefined`).
 * We never infer "public" from absence of evidence — only positive evidence
 * of an enforcement point or security-context scope produces an opinion, and
 * even then the opinion is annotated with its `enforcement` confidence
 * ('enforced' | 'assumed') so callers can tell a verified guard from a
 * suspected one. Enforcement points whose confidence is 'missing' are a
 * signal that protection was EXPECTED but not found — that's evidence of a
 * gap, not evidence of protection, so they never flip `authenticated` true.
 *
 * Pure: no fs, no AI, no orchestrator-internal imports. Every input is a
 * plain array already sitting on the CAS.
 */

/** Mirrors the (not-yet-added) `CASEntryPoint.security.enforcement` field —
 *  see the PROPOSED type change in the accompanying report. Kept as a local
 *  alias so this module type-checks against the current (unmodified)
 *  cas.types.ts while still expressing the richer shape it produces. */
export type EntryPointSecurityEnforcement = 'enforced' | 'assumed';

export type EntryPointSecurityResult = NonNullable<CASEntryPoint['security']> & {
  enforcement?: EntryPointSecurityEnforcement;
};

/** `CASEntryPoint`, but with the richer `security` shape this module
 *  produces (the `enforcement` field doesn't exist on the current
 *  `CASEntryPoint.security` type — see the PROPOSED type change in the
 *  report). Used only as this module's return type; cas.types.ts itself is
 *  untouched. */
export type EntryPointWithSecurity = Omit<CASEntryPoint, 'security'> & {
  security?: EntryPointSecurityResult;
};

/** Known auth-mechanism substrings, checked case-insensitively, in priority
 *  order (first match wins) so e.g. "OAuth2/JWT Bridge" resolves to the more
 *  specific 'oauth' before falling through to 'jwt'. */
const MECHANISM_METHOD_PATTERNS: Array<{ pattern: RegExp; method: string }> = [
  { pattern: /passport/i, method: 'passport' },
  { pattern: /o?auth\s*2?/i, method: 'oauth' },
  { pattern: /jwt|json\s*web\s*token/i, method: 'jwt' },
  { pattern: /api[\s-]?key/i, method: 'api-key' },
  { pattern: /mtls|mutual\s*tls|client[\s-]?cert/i, method: 'mtls' },
  { pattern: /session/i, method: 'session' },
];

/** Coarsen a free-form mechanism string (e.g. "Passport/Auth Middleware")
 *  down to one of a small set of known auth methods. Falls back to
 *  'middleware' when nothing recognizable is present — still meaningfully
 *  "there is a guard here", just not one we can name precisely. */
export function deriveAuthMethod(mechanism: string | undefined | null): string {
  if (!mechanism) return 'middleware';
  for (const { pattern, method } of MECHANISM_METHOD_PATTERNS) {
    if (pattern.test(mechanism)) return method;
  }
  return 'middleware';
}

/** Every node id that could plausibly stand in for this entry point when
 *  matching against boundary enforcement points / security-context scopes. */
function candidateNodeIds(entryPoint: CASEntryPoint): string[] {
  const ids: string[] = [];
  if (entryPoint.handler?.node_id) ids.push(entryPoint.handler.node_id);
  if (entryPoint.source_node) ids.push(entryPoint.source_node);
  if (Array.isArray(entryPoint.connected_nodes)) {
    for (const id of entryPoint.connected_nodes) {
      if (id) ids.push(id);
    }
  }
  return ids;
}

function dedupe(values: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

interface MatchEvidence {
  mechanisms: string[];
  confidence: 'enforced' | 'assumed' | 'missing';
  roles: string[];
  permissions: string[];
}

/** Attach per-entry-point security evidence by joining system-level security
 *  boundaries and security contexts onto each entry point's candidate node
 *  ids (and, for contexts, the entry point's own id via `scope.entry_points`).
 *
 *  Returns a NEW array of entry points (inputs are not mutated); entry
 *  points with no security evidence come back with `security` unchanged
 *  (merged with whatever the entry point already had, nothing invented). */
export function attachEntryPointSecurity(
  entryPoints: CASEntryPoint[],
  securityBoundaries: CASSecurityBoundary[] | undefined | null,
  securityContexts: CASSecurityContext[] | undefined | null,
): EntryPointWithSecurity[] {
  const boundaries = securityBoundaries ?? [];
  const contexts = securityContexts ?? [];

  return entryPoints.map((entryPoint) => {
    const candidates = new Set(candidateNodeIds(entryPoint));
    const evidence: MatchEvidence = {
      mechanisms: [],
      confidence: 'missing',
      roles: [],
      permissions: [],
    };
    let matched = false;
    let sawEnforced = false;
    let sawAssumed = false;

    // Security boundaries: match via enforcement_points[].node_id.
    for (const boundary of boundaries) {
      for (const point of boundary.enforcement_points ?? []) {
        if (!point.node_id || !candidates.has(point.node_id)) continue;
        if (point.confidence === 'missing') {
          // Evidence of an EXPECTED-but-absent guard — a gap, not protection.
          // Recorded as "matched" so we don't fall through to leaving
          // `security` unset, but never flips `authenticated` true.
          matched = true;
          continue;
        }
        matched = true;
        if (point.confidence === 'enforced') sawEnforced = true;
        else sawAssumed = true;
        evidence.mechanisms.push(point.mechanism);
      }
    }

    // Security contexts: match via scope.node_ids intersecting candidates,
    // or the more direct scope.entry_points carrying this entry point's id.
    for (const context of contexts) {
      const scope = context.scope;
      const byNodeId = (scope?.node_ids ?? []).some((id) => candidates.has(id));
      const byEntryPointId = (scope?.entry_points ?? []).includes(entryPoint.id);
      if (!byNodeId && !byEntryPointId) continue;

      matched = true;
      // Contexts don't carry a per-point confidence like boundaries do; a
      // context match is treated as 'assumed' unless it's reinforced by an
      // 'enforced' boundary match above (assumed_vs_enforced stays accurate
      // to the strongest evidence actually seen for this entry point).
      sawAssumed = true;

      const authMethods = context.requirements?.authentication?.methods ?? [];
      for (const m of authMethods) evidence.mechanisms.push(m);
      if (authMethods.length === 0 && context.name) {
        evidence.mechanisms.push(context.name);
      }

      const roles = context.requirements?.authorization?.roles ?? [];
      const permissions = context.requirements?.authorization?.permissions ?? [];
      evidence.roles.push(...roles);
      evidence.permissions.push(...permissions);
    }

    if (!matched) {
      // No evidence at all — leave security exactly as it was. Absence of
      // evidence is not evidence of "public".
      return entryPoint;
    }

    evidence.confidence = sawEnforced ? 'enforced' : sawAssumed ? 'assumed' : 'missing';

    // Coarse auth method(s) derived from the raw mechanism strings, appended
    // alongside the raw mechanisms in `guards` (e.g. "Passport/Auth
    // Middleware" AND "passport") so both the precise evidence and the
    // normalized category are available to callers.
    const derivedMethods = dedupe(evidence.mechanisms.map((m) => deriveAuthMethod(m)));

    const existing = entryPoint.security;
    const mergedGuards = dedupe([
      ...(existing?.guards ?? []),
      ...evidence.mechanisms,
      ...derivedMethods,
    ]);
    const mergedRoles = dedupe([...(existing?.roles ?? []), ...evidence.roles]);
    const mergedPermissions = dedupe([
      ...(existing?.permissions ?? []),
      ...evidence.permissions,
    ]);
    const mergedAuthorizedRoles = dedupe([
      ...(existing?.authorized_roles ?? []),
      ...evidence.roles,
    ]);

    // Only positive evidence (enforced/assumed) sets authenticated: true.
    // A 'missing'-only match (an expected-but-unenforced boundary) leaves
    // `authenticated` as it was rather than fabricating a value.
    const hasPositiveEvidence = sawEnforced || sawAssumed;
    const authenticated = existing?.authenticated === true
      ? true
      : hasPositiveEvidence
        ? true
        : existing?.authenticated;

    const newEnforcement: EntryPointSecurityEnforcement | undefined = hasPositiveEvidence
      ? (sawEnforced ? 'enforced' : 'assumed')
      : undefined;
    const existingEnforcement = (existing as EntryPointSecurityResult | undefined)?.enforcement;
    const enforcement = existingEnforcement ?? newEnforcement;

    const security: EntryPointSecurityResult = {
      ...existing,
      ...(authenticated !== undefined ? { authenticated } : {}),
      ...(mergedGuards.length > 0 ? { guards: mergedGuards } : {}),
      ...(mergedRoles.length > 0 ? { roles: mergedRoles } : {}),
      ...(mergedPermissions.length > 0 ? { permissions: mergedPermissions } : {}),
      ...(mergedAuthorizedRoles.length > 0 ? { authorized_roles: mergedAuthorizedRoles } : {}),
      ...(enforcement !== undefined ? { enforcement } : {}),
    };

    return { ...entryPoint, security };
  });
}
