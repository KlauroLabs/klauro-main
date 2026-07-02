/**
 * The four collision detectors (§WS-D), composed into a single CollisionReport.
 * Pure: every input (active claims, in-flight snapshots, CAS edges, WAS
 * capabilities) is passed in by the caller. No transport, no storage.
 */

import type {
  BlastIntersectionFinding,
  CasEdgeRef,
  CollisionReport,
  DriftFinding,
  DuplicateFinding,
  InFlightSnapshot,
  OverlapFinding,
  WasCapabilityRef,
  WorkClaim,
} from './types';

function normalizePath(p: string): string {
  return p.replace(/\/+$/, '');
}

function pathsOverlap(a: string, b: string): boolean {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  return na === nb || na.startsWith(nb + '/') || nb.startsWith(na + '/');
}

function intersect<T>(a: T[], b: T[]): T[] {
  const setB = new Set(b);
  return a.filter((x) => setB.has(x));
}

/** Detector 1: duplicate-work — two active claims target the same capability. */
function detectDuplicates(
  activeClaims: WorkClaim[],
  wasCapabilities: WasCapabilityRef[]
): DuplicateFinding[] {
  const findings: DuplicateFinding[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < activeClaims.length; i++) {
    for (let j = i + 1; j < activeClaims.length; j++) {
      const a = activeClaims[i];
      const b = activeClaims[j];
      if (!a.scope.capability || !b.scope.capability) continue;
      if (a.scope.capability !== b.scope.capability) continue;
      const pairKey = [a.claim_id, b.claim_id].sort().join('|');
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      const was = wasCapabilities.find((c) => c.name === a.scope.capability);
      findings.push({
        claim_id: a.claim_id,
        with_claim_id: b.claim_id,
        capability: a.scope.capability,
        evidence: [
          `capability:${a.scope.capability}`,
          ...(was ? [`workspace_capability:${was.id}`] : []),
        ],
      });
    }
  }
  return findings;
}

/** Detector 2: edit-overlap — path/symbol intersection across active claims. */
function detectOverlaps(activeClaims: WorkClaim[]): OverlapFinding[] {
  const findings: OverlapFinding[] = [];
  for (let i = 0; i < activeClaims.length; i++) {
    for (let j = i + 1; j < activeClaims.length; j++) {
      const a = activeClaims[i];
      const b = activeClaims[j];
      const overlappingPaths: string[] = [];
      for (const p of a.scope.paths) {
        for (const op of b.scope.paths) {
          if (pathsOverlap(p, op)) overlappingPaths.push(p === op ? p : `${p}~${op}`);
        }
      }
      const overlappingSymbols = intersect(a.scope.symbols, b.scope.symbols);
      if (overlappingPaths.length === 0 && overlappingSymbols.length === 0) continue;
      findings.push({
        claim_id: a.claim_id,
        with_claim_id: b.claim_id,
        paths: overlappingPaths,
        symbols: overlappingSymbols,
        evidence: [
          ...overlappingPaths.map((p) => `path:${p}`),
          ...overlappingSymbols.map((s) => `symbol:${s}`),
        ],
      });
    }
  }
  return findings;
}

/**
 * Detector 3: in-flight contract-drift — agent A's touched contracts overlap
 * agent B's claimed scope (paths/symbols/capability), meaning A's uncommitted
 * change may be shifting a shape B is actively depending on/editing.
 */
function detectDrifts(
  activeClaims: WorkClaim[],
  inFlightSnapshots: InFlightSnapshot[]
): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const seen = new Set<string>();
  for (const snapshot of inFlightSnapshots) {
    if (snapshot.touched.contracts.length === 0) continue;
    for (const claim of activeClaims) {
      if (claim.agent_id === snapshot.agent_id) continue;
      const touchedSet = new Set([
        ...snapshot.touched.contracts,
        ...snapshot.touched.routes,
        ...snapshot.touched.entities,
      ]);
      const claimTargets = [
        ...(claim.scope.capability ? [claim.scope.capability] : []),
        ...claim.scope.symbols,
        ...claim.scope.paths,
      ];
      const sharedContracts = snapshot.touched.contracts.filter(
        (c) => touchedSet.has(c) && claimTargets.some((t) => c === t || c.includes(t) || t.includes(c))
      );
      if (sharedContracts.length === 0) continue;
      const pairKey = [snapshot.agent_id, claim.agent_id].sort().join('|') + '|' + sharedContracts.join(',');
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      findings.push({
        agent_id: snapshot.agent_id,
        with_agent_id: claim.agent_id,
        contracts: sharedContracts,
        evidence: sharedContracts.map((c) => `contract:${c}`),
      });
    }
  }
  return findings;
}

/**
 * Detector 4: cross-agent blast-radius — union each active claim's edit set,
 * expand one hop via CAS edges, and flag when agent A's blast radius reaches
 * into agent B's claimed symbols.
 */
function detectBlastIntersections(
  activeClaims: WorkClaim[],
  casEdges: CasEdgeRef[]
): BlastIntersectionFinding[] {
  const findings: BlastIntersectionFinding[] = [];
  const radii = new Map<string, Set<string>>();
  for (const claim of activeClaims) {
    const radius = new Set(claim.scope.symbols);
    for (const sym of claim.scope.symbols) {
      for (const edge of casEdges) {
        if (edge.source === sym) radius.add(edge.target);
        if (edge.target === sym) radius.add(edge.source);
      }
    }
    radii.set(claim.claim_id, radius);
  }

  for (let i = 0; i < activeClaims.length; i++) {
    for (let j = 0; j < activeClaims.length; j++) {
      if (i === j) continue;
      const a = activeClaims[i];
      const b = activeClaims[j];
      if (b.scope.symbols.length === 0) continue;
      const aRadius = radii.get(a.claim_id) ?? new Set<string>();
      const shared = b.scope.symbols.filter((s) => aRadius.has(s) && !a.scope.symbols.includes(s));
      if (shared.length === 0) continue;
      findings.push({
        claim_id: a.claim_id,
        with_claim_id: b.claim_id,
        symbols: shared,
        evidence: shared.map((s) => `blast_radius:${s}`),
      });
    }
  }
  return findings;
}

/**
 * Compose the four WS-D detectors into a single CollisionReport. Pure and
 * side-effect free — the caller supplies the active claims, in-flight
 * snapshots, CAS edges, and WAS capabilities.
 */
export function detectCollisions(
  activeClaims: WorkClaim[],
  inFlightSnapshots: InFlightSnapshot[],
  casEdges: CasEdgeRef[],
  wasCapabilities: WasCapabilityRef[]
): CollisionReport {
  const active = activeClaims.filter((c) => c.status === 'active');
  return {
    duplicates: detectDuplicates(active, wasCapabilities),
    overlaps: detectOverlaps(active),
    drifts: detectDrifts(active, inFlightSnapshots),
    blast_intersections: detectBlastIntersections(active, casEdges),
  };
}
