/**
 * Terminal-capability-absorption gate.
 *
 * Acceptance criterion (owner-specified): capabilities are scope-relative.
 * The same code can legitimately produce a capability at a leaf/service CAS
 * node ("manage users" at a user-identity service is a real thing that
 * service was built to provide) while contributing NOTHING to a composed
 * parent CAS's capability list — not demoted, not renamed, ABSENT. Only
 * TERMINAL children (the ones nothing else depends on — the product-purpose
 * surfaces) contribute capabilities upward. A non-terminal/substrate child
 * (a support or infrastructure service — an identity/auth service, a sync
 * service) has its capabilities absorbed by whichever terminal child
 * consumes it, never independently inherited into the parent's list.
 *
 * THIS FILE IS A HARNESS-LEVEL GATE, NOT PRODUCT LOGIC. It runs over
 * already-produced, blackbox-obtained CAS facts (capability names/categories
 * and each repo's own declared entity/command/query/message type names —
 * exactly what `get_summary`'s `capabilities` and `database_entities` already
 * expose over MCP). It never imports the analyzer engine and never embeds a
 * corpus/client name — every name that reaches this file at runtime is a
 * caller-supplied, opaque `repoId`; see the SPEC-PURITY gate
 * (`spec-purity-gate.ts`), which blocks exactly that class of leak from
 * product source. Real repo names belong only in benchmark records/fixtures
 * that call this module, never in this module itself.
 *
 * SUBSTRATE DETECTION IS STRUCTURAL AND DIRECTIONAL, NOT A NAME BLOCKLIST.
 * A repo P is classified non-terminal (substrate) when: (a) at least one
 * type P's OWN capabilities anchor to (the types P actually manages, not
 * merely declares) also appears in another repo C's full declared-type
 * surface, and (b) that type is NOT itself one of the types any of C's own
 * capabilities anchor to — i.e. C references P's contract as a dependency
 * (a DTO to call out with, a message type to subscribe to) without managing
 * it as its own concern. Symmetric name overlap alone is not enough: two
 * repos can each declare a same-named type as part of independent domains,
 * and a repo whose OWN capabilities manage a shared type is not thereby
 * substrate. This directional "anchored-there but only-referenced-here"
 * check is a first-approximation proxy for the real signal
 * (docs/cas/SPECIFICATION.md §0.8's inter-sub-CAS-node seams / shared-entity
 * evidence) and is explicitly weaker than the seam mechanism that
 * specification says is NOT YET IMPLEMENTED for cross-repo composition
 * (§0.8.4: "Workspace-level (cross-repo) communication seams are not
 * implemented"). When the real seam mechanism ships, this heuristic should
 * be replaced by seam evidence, not layered on top of it.
 *
 * THE ABSENCE CHECK IS A SHAPE PATTERN, NOT A CORPUS BLOCKLIST. We test
 * whether a composed capability name reads as identity/auth/account-shaped
 * using a generic linguistic pattern (login, authenticate, password,
 * credential, session token, user identity/account, register user, sso,
 * oauth) — never a per-repo or per-corpus name list. A capability like
 * "Manage user intents" (a financial workflow trigger, not an account
 * concept) correctly does NOT match; this was verified against a real
 * finance-domain capability set during this gate's validation, specifically
 * to rule out a naive "contains the word 'user'" false positive.
 */

export interface RepoCapabilityFacts {
  /**
   * Opaque per-session identifier for one analyzed repo/service. Callers
   * MUST NOT pass a real corpus/client repo name here — use a benchmark
   * record id, a fixture label, or a synthetic placeholder. This module
   * never inspects `repoId` for meaning; it is carried through purely so
   * gate output can be attributed back to a caller-owned record.
   */
  repoId: string;
  /** This repo's own leaf/service-level capability list, as already
   * reported by its own CAS (get_summary's `capabilities`/`top_capabilities`,
   * or the richer product_map.capabilities — no reinterpretation here).
   * `entities` is the list of entity/type names THIS capability anchors to
   * (product_map.capabilities[].entities in the real shape) — the types this
   * repo's own capability *manages*, as opposed to merely references. */
  capabilities: Array<{ name: string; category?: string; entities?: string[] }>;
  /** This repo's own full declared entity / command / query / message / DTO
   * type-name surface, as already reported by its own CAS (get_summary's
   * `database_entities`). Superset of the anchoring entities above — includes
   * types this repo merely references (e.g. a DTO used to call out to
   * another service) without any of its own capabilities managing them. */
  declaredTypeNames: string[];
}

export interface ComposedCapability {
  name: string;
  category?: string;
  fromRepoId: string;
}

export interface TerminalCapabilityGateResult {
  pass: boolean;
  /** repoIds classified non-terminal (substrate) — excluded from composition. */
  substrateRepoIds: string[];
  /** repoIds classified terminal — the only contributors to the composed list. */
  terminalRepoIds: string[];
  composedCapabilities: ComposedCapability[];
  violations: string[];
}

const IDENTITY_AUTH_SHAPE =
  /\b(log[- ]?in|sign[- ]?up|authenticat\w*|password|credential|session[- ]?token|user\s+ident(?:ity|ities)|register\s+user|user\s+account|\bsso\b|\boauth\b)\b/i;

function anchoringTypes(repo: RepoCapabilityFacts): Set<string> {
  const out = new Set<string>();
  for (const cap of repo.capabilities) {
    for (const e of cap.entities ?? []) out.add(e);
  }
  return out;
}

/**
 * A repo P is non-terminal (substrate) when one of the types P's OWN
 * capabilities manage (anchor to) is merely referenced — declared but not
 * capability-anchored — by another repo C. That is the structural evidence
 * that C depends on P's contract without owning the concern itself.
 */
export function findSubstrateRepoIds(repos: RepoCapabilityFacts[]): Set<string> {
  const substrate = new Set<string>();
  const anchors = new Map<string, Set<string>>();
  for (const r of repos) anchors.set(r.repoId, anchoringTypes(r));

  for (const producer of repos) {
    const ownAnchors = anchors.get(producer.repoId)!;
    if (ownAnchors.size === 0) continue;
    const dependedOnElsewhere = repos.some(consumer => {
      if (consumer.repoId === producer.repoId) return false;
      const consumerAnchors = anchors.get(consumer.repoId)!;
      return consumer.declaredTypeNames.some(
        t => ownAnchors.has(t) && !consumerAnchors.has(t),
      );
    });
    if (dependedOnElsewhere) substrate.add(producer.repoId);
  }
  return substrate;
}

/**
 * The composed parent's capability list under the terminal-absorption rule:
 * union of TERMINAL children's own capabilities only. Non-terminal
 * (substrate) children contribute nothing — their capabilities are absorbed
 * by whichever terminal child consumes their contract, not independently
 * inherited.
 */
export function composeParentCapabilities(repos: RepoCapabilityFacts[]): ComposedCapability[] {
  const substrate = findSubstrateRepoIds(repos);
  const composed: ComposedCapability[] = [];
  for (const repo of repos) {
    if (substrate.has(repo.repoId)) continue;
    for (const cap of repo.capabilities) {
      composed.push({ name: cap.name, category: cap.category, fromRepoId: repo.repoId });
    }
  }
  return composed;
}

/**
 * The gate itself: composes the parent capability list per the
 * terminal-absorption rule, then asserts no identity/auth-shaped capability
 * survived. A hard fail (any violation) means a support/substrate service's
 * account-management surface leaked into the outer, product-purpose list —
 * exactly the defect the owner named as unacceptable, not a ranking nit.
 */
export function runTerminalCapabilityGate(repos: RepoCapabilityFacts[]): TerminalCapabilityGateResult {
  const substrate = findSubstrateRepoIds(repos);
  const composed = composeParentCapabilities(repos);
  const violations = composed
    .filter(c => IDENTITY_AUTH_SHAPE.test(c.name))
    .map(
      c =>
        `"${c.name}" (from ${c.fromRepoId}) reads as identity/auth-shaped but survived composition into the parent capability list`,
    );
  return {
    pass: violations.length === 0,
    substrateRepoIds: Array.from(substrate),
    terminalRepoIds: repos.map(r => r.repoId).filter(id => !substrate.has(id)),
    composedCapabilities: composed,
    violations,
  };
}
