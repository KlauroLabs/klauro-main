





import type {
  ArbitrationResult,
  CasEdgeRef,
  ConflictKind,
  WorkspaceCapabilityRef,
  WorkClaim,
} from './types';


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













export function arbitrate(
  newClaim: WorkClaim,
  activeClaims: WorkClaim[],
  casEdges: CasEdgeRef[],
  workspaceCapabilities: WorkspaceCapabilityRef[]
): ArbitrationResult {
  const others = activeClaims.filter(
    (c) => c.claim_id !== newClaim.claim_id && c.status === 'active'
  );


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
