





import type { SymbolChange } from './conceptual-conflict';
import type { ContractMatchConfidence } from './contract-intent';
import type {
  BlastIntersectionFinding,
  CasEdgeRef,
  CollisionReport,
  ContractKind,
  DriftFinding,
  DuplicateFinding,
  InFlightSnapshot,
  OverlapFinding,
  WorkspaceCapabilityRef,
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


function detectDuplicates(
  activeClaims: WorkClaim[],
  workspaceCapabilities: WorkspaceCapabilityRef[]
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
      const workspaceCapability = workspaceCapabilities.find((c) => c.name === a.scope.capability);
      findings.push({
        claim_id: a.claim_id,
        with_claim_id: b.claim_id,
        capability: a.scope.capability,
        evidence: [
          `capability:${a.scope.capability}`,
          ...(workspaceCapability ? [`workspace_capability:${workspaceCapability.id}`] : []),
        ],
      });
    }
  }
  return findings;
}


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









export interface DeclaredContractDriftFinding {
  producer_agent_id: string;
  producer_claim_id: string;
  consumer_agent_id: string;
  consumer_claim_id: string;

  contract: string;
  contract_kind: ContractKind;
  reason: 'declared_contract_drift' | 'declared_contract_missing';

  confidence: ContractMatchConfidence;
  explanation: string;
  evidence: string[];
}

function normalizeSignature(sig: string | undefined): string | undefined {
  if (sig === undefined) return undefined;
  return sig.replace(/\s+/g, ' ').replace(/\s*([(),:;<>|&=])\s*/g, '$1').trim();
}

function samePathish(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return normalizePath(a.replace(/\\/g, '/')) === normalizePath(b.replace(/\\/g, '/'));
}



























export function detectDeclaredContractDrift(
  producerClaim: WorkClaim,
  neighborhoodClaims: WorkClaim[],
  producerChanges: SymbolChange[]
): DeclaredContractDriftFinding[] {
  const declared = (producerClaim.produces ?? []).filter((c) => (c.status ?? 'declared') === 'declared');
  if (declared.length === 0) return [];

  const findings: DeclaredContractDriftFinding[] = [];
  const producerReleased = producerClaim.status === 'released';

  for (const contract of declared) {
    const consumers = neighborhoodClaims.filter(
      (c) => c.claim_id !== producerClaim.claim_id && (c.consumes ?? []).includes(contract.name)
    );
    if (consumers.length === 0) continue;

    const byName = producerChanges.filter((ch) => ch.name === contract.name);
    const pathQualified = byName.filter((ch) => samePathish(ch.file, contract.path));
    const matched = pathQualified.length > 0 ? pathQualified : byName;
    const confidence: ContractMatchConfidence =
      pathQualified.length > 0 ? 'path_qualified' : 'name_only';

    let reason: DeclaredContractDriftFinding['reason'] | undefined;
    let explanation = '';
    const evidence: string[] = [];

    if (matched.length === 0) {



      if (producerReleased) {
        reason = 'declared_contract_missing';
        explanation =
          `${producerClaim.agent_id} released its claim without producing declared ` +
          `${contract.kind} "${contract.name}"${contract.path ? ` in ${contract.path}` : ''}.`;
        evidence.push(`declared:${contract.kind}:${contract.name}`, 'producer_released_without_change');
      }
    } else {
      const deleted = matched.find((ch) => ch.change_kind === 'delete');
      const renamed = matched.find((ch) => ch.change_kind === 'rename');
      const declaredSig = normalizeSignature(contract.signature);
      const divergent = declaredSig
        ? matched.find((ch) => {
            const actual = normalizeSignature(ch.after?.signature);
            return !!actual && actual !== declaredSig;
          })
        : undefined;
      if (deleted) {
        reason = 'declared_contract_missing';
        explanation = `${producerClaim.agent_id} DELETED declared ${contract.kind} "${contract.name}" (${deleted.file}).`;
        evidence.push(`declared:${contract.name}`, `observed:delete:${deleted.symbol_id}`);
      } else if (renamed) {
        reason = 'declared_contract_drift';
        explanation =
          `${producerClaim.agent_id} RENAMED declared ${contract.kind} "${contract.name}" ` +
          `to "${renamed.after?.name ?? '?'}" (${renamed.file}).`;
        evidence.push(`declared:${contract.name}`, `observed:rename:${renamed.symbol_id}`);
      } else if (divergent) {
        reason = 'declared_contract_drift';
        explanation =
          `${producerClaim.agent_id}'s in-flight ${contract.kind} "${contract.name}" no longer matches its ` +
          `declaration — declared "${contract.signature}", observed "${divergent.after?.signature}" ` +
          `(${divergent.change_kind}, ${divergent.file}). Signature-shaped drift only; behavior is not compared.`;
        evidence.push(
          `declared_signature:${contract.signature}`,
          `observed_signature:${divergent.after?.signature}`,
          `change_kind:${divergent.change_kind}`
        );
      }
    }

    if (!reason) continue;
    for (const consumer of consumers) {
      findings.push({
        producer_agent_id: producerClaim.agent_id,
        producer_claim_id: producerClaim.claim_id,
        consumer_agent_id: consumer.agent_id,
        consumer_claim_id: consumer.claim_id,
        contract: contract.name,
        contract_kind: contract.kind,
        reason,
        confidence,
        explanation:
          confidence === 'name_only'
            ? `${explanation} [LOWER CONFIDENCE: matched by name only — no path-qualified match]`
            : explanation,
        evidence: [...evidence, `consumer:${consumer.agent_id}`, `match:${confidence}`],
      });
    }
  }
  return findings;
}






export function detectCollisions(
  activeClaims: WorkClaim[],
  inFlightSnapshots: InFlightSnapshot[],
  casEdges: CasEdgeRef[],
  workspaceCapabilities: WorkspaceCapabilityRef[]
): CollisionReport {
  const active = activeClaims.filter((c) => c.status === 'active');
  return {
    duplicates: detectDuplicates(active, workspaceCapabilities),
    overlaps: detectOverlaps(active),
    drifts: detectDrifts(active, inFlightSnapshots),
    blast_intersections: detectBlastIntersections(active, casEdges),
  };
}
