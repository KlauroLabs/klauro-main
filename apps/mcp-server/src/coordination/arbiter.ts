/**
 * Pure arbitration for a new WorkClaim against the active-claim set (§WS-C).
 * No IO: every input (active claims, CAS edges, workspace-level-CAS capabilities) is passed
 * in by the caller.
 */

import type {
  ArbitrationResult,
  CasEdgeRef,
  ConflictKind,
  WorkspaceCapabilityRef,
  WorkClaim,
} from './types';

/** True when `a` is `b` or an ancestor path-prefix of `b` (or vice versa). */
function pathsOverlap(a: string, b: string): boolean {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  return na === nb || na.startsWith(nb + '/') || nb.startsWith(na + '/');
}

function normalizePath(p: string): string {
  return p.replace(/\/+$/, '');
}

function intersect<T>(a: T[], b: T[]): T[] {
  const setB = new Set(b);
  return a.filter((x) => setB.has(x));
}

/** Union of one-hop CAS neighbors (source<->target) reachable from a symbol set. */
function blastRadius(symbols: string[], casEdges: CasEdgeRef[]): Set<string> {
  const radius = new Set(symbols);
  for (const sym of symbols) {
    for (const edge of casEdges) {
      if (edge.source === sym) radius.add(edge.target);
      if (edge.target === sym) radius.add(edge.source);
    }
  }
  return radius;
}

/**
 * Arbitrate a new claim against the currently-active claim set.
 *
 * Overlap checks, in priority order:
 * 1. capability-name match against another active claim, or against a
 *    workspace-level-CAS capability already covered by an active claim → `duplicate`.
 * 2. path-prefix intersection → `conflict` (kind: 'path').
 * 3. symbol-set intersection → `conflict` (kind: 'symbol').
 * 4. blast-radius intersection (via CAS edges) → `conflict` (kind: 'blast_radius').
 *
 * A claim disjoint on all four axes from every active claim → `granted`.
 */
export function arbitrate(
  newClaim: WorkClaim,
  activeClaims: WorkClaim[],
  casEdges: CasEdgeRef[],
  workspaceCapabilities: WorkspaceCapabilityRef[]
): ArbitrationResult {
  const others = activeClaims.filter(
    (c) => c.claim_id !== newClaim.claim_id && c.status === 'active'
  );

  // 1. Duplicate-work: same capability already actively claimed.
  if (newClaim.scope.capability) {
    for (const other of others) {
      if (other.scope.capability && other.scope.capability === newClaim.scope.capability) {
        return {
          verdict: 'duplicate',
          with_claim: other,
          kind: 'capability',
          evidence: [`capability:${newClaim.scope.capability}`],
        };
      }
    }
    // Also treat matching a known workspace-level-CAS capability name as duplicate evidence
    // when some other active claim's intent/capability resolves to it.
    const matchedWorkspaceCapability = workspaceCapabilities.find((c) => c.name === newClaim.scope.capability);
    if (matchedWorkspaceCapability) {
      const other = others.find(
        (o) =>
          o.scope.capability === matchedWorkspaceCapability.name ||
          workspaceCapabilities.some((c) => c.name === o.scope.capability && c.id === matchedWorkspaceCapability.id)
      );
      if (other) {
        return {
          verdict: 'duplicate',
          with_claim: other,
          kind: 'capability',
          evidence: [`workspace_capability:${matchedWorkspaceCapability.id}:${matchedWorkspaceCapability.name}`],
        };
      }
    }
  }

  // 2. Path-prefix overlap.
  for (const other of others) {
    const evidence: string[] = [];
    for (const p of newClaim.scope.paths) {
      for (const op of other.scope.paths) {
        if (pathsOverlap(p, op)) evidence.push(`path:${p}~${op}`);
      }
    }
    if (evidence.length > 0) {
      return { verdict: 'conflict', with_claim: other, kind: 'path' as ConflictKind, evidence };
    }
  }

  // 3. Symbol-set overlap.
  for (const other of others) {
    const shared = intersect(newClaim.scope.symbols, other.scope.symbols);
    if (shared.length > 0) {
      return {
        verdict: 'conflict',
        with_claim: other,
        kind: 'symbol',
        evidence: shared.map((s) => `symbol:${s}`),
      };
    }
  }

  // 4. Blast-radius overlap via CAS edges.
  if (newClaim.scope.symbols.length > 0) {
    const myRadius = blastRadius(newClaim.scope.symbols, casEdges);
    for (const other of others) {
      if (other.scope.symbols.length === 0) continue;
      const theirRadius = blastRadius(other.scope.symbols, casEdges);
      const shared = [...myRadius].filter((s) => theirRadius.has(s));
      if (shared.length > 0) {
        return {
          verdict: 'conflict',
          with_claim: other,
          kind: 'blast_radius',
          evidence: shared.map((s) => `blast_radius:${s}`),
        };
      }
    }
  }

  return { verdict: 'granted' };
}
