# SPEC — Coordination Fabric v2 (Fleet-Scale Enforcement)

> **Status: DESIGN** as of 2026-07-02. Motivated by a live 6-agent battle-test on one
> feature (deployable-detection build, workspace `deployable-detection-build`). v1 =
> [[SPEC-COORDINATION-FABRIC]] (advisory detection). This spec defines the leap to
> fleet-scale: **guaranteeing that a massive fleet of agents editing one codebase in
> parallel produces work that fits together immediately.**

## 0. The vision this serves

Massive fleets of agents (and humans) working the same codebase in parallel, where the
fabric + shared context **guarantee** the combined output integrates cleanly — no
clobbers, no duplicate work, no stranded branches, no stale-contract breakage. "Fits
together immediately" is the product promise. v1 does not yet deliver it; this spec says
exactly what must change, grounded in what the battle-test proved.

## 1. What the battle-test proved (the evidence base)

Six Sonnet agents built one feature concurrently through the **real** `local-store`
fabric, with two deliberate same-file stress pairs (B+D on `cross-codebase-analysis.ts`;
A+E on `cas.types.ts`). Findings, in severity order:

1. **Detection ≠ enforcement.** `checkEditLock` correctly reported every overlap, every
   time. But it is advisory — nothing *prevented* a write. Zero clobbers occurred, but
   only because the **orchestrator** (a human/arbiter) pre-assigned disjoint *symbols*.
   The fabric did not provide the safety; the arbiter did. At fleet scale there is no
   human pre-assigning every symbol — the fabric must be the arbiter.

2. **Claims are path-*predictions*, and real work drifts.** Agents A and E both edited
   `orchestrator.ts` — a file **neither had claimed** (E's real fix lived there, not the
   predicted `intent-detector.ts`; A wired evidence there). The overlap was **invisible**
   to the fabric and survived only because the line ranges happened to be disjoint. Luck,
   not coordination.

3. **File-level is the wrong granularity.** Two agents safely shared a 9,500-line file by
   holding disjoint **symbols**. A file-level lock would have serialized them and
   destroyed the parallelism. The unit of coordination must be the semantic region, not
   the file.

4. **Release semantics are partial.** `releaseEdit()` releases only the edit-lock
   claim_id, not the originating **work claim** — so the ledger showed all six agents
   "active" long after four had finished. Work-claim lifecycle needs explicit
   completion + TTL reconciliation.

## 2. Design principles

- **Coordinate on the graph, not the text.** Klauro already has the CAS/WAS symbol +
  dependency graph. That is the unfair advantage: grant at the *symbol*, reserve the
  *blast radius*, freeze the *contract*. Competitors coordinating on files/lines
  structurally cannot. **The shared context is the substrate that makes fleet-scale
  coordination possible — not a sibling feature.**
- **Claims emerge from behavior.** Stop trusting up-front path predictions. Observe the
  actual write; derive the claim from the symbol touched.
- **Enforce, then integrate.** A write is admitted only if it holds the grant for its
  region; on admission, its blast radius is re-analyzed immediately so breakage surfaces
  to the fleet now, not at a merge gate.

## 3. Architecture (v1 → v2)

| Dimension | v1 (today) | v2 (fleet-scale) |
|---|---|---|
| Conflict handling | Advisory `checkEditLock` | **Enforced arbitration**: `arbitrate()` gates the write — grant / queue / redirect, with leases + heartbeats |
| Claim origin | Predicted paths, declared up front | **Write-hooked**: the Edit/Write tool auto-announces the actual file+symbol; claim is emergent |
| Granularity | File paths (`pathsOverlap`) | **Symbol/region** — lock the function/declaration via CAS node id, not the file |
| Dependency awareness | Blast-radius *detected* in collision sweep | **Blast-radius *reserved***: editing X reserves X + its dependents' contract surface |
| Shared contracts | Unmanaged | **Contract-freeze guards**: shared interfaces/types are protected; no mid-flight mutation without a coordinated version bump |
| Integration | Merge-time | **Integrate-on-write**: per-edit incremental re-analysis of the changed blast radius (freshness engine already provides this) |
| Claim lifecycle | Partial release | Explicit `complete`/`supersede` + TTL reconciliation; work-claim vs edit-lock unified |

## 4. Mechanics

### 4.1 Write-hooked, symbol-level claims
- A pre-write hook (MCP tool wrapper or editor/agent-harness hook) resolves the target
  file+byte-range to a **CAS node id** (function/class/decl) via the existing symbol
  index. That node id — plus its declared blast radius — is the claim unit.
- `arbitrate(newClaim, activeClaims, casEdges, wasCapabilities)` (already implemented,
  returns `granted | conflict | duplicate`) becomes the gate. On `granted`: lease the
  region (TTL + heartbeat). On `conflict`: queue behind the holder, or redirect the agent
  to non-conflicting work. On `duplicate`: collapse (dup-work elimination).

### 4.2 Blast-radius reservations
- Editing symbol X reserves X **and the contract surface of X's transitive dependents**
  (from CAS call/import edges + WAS cross-deployable links — the shared-code rollup gives
  the cross-deployable dependents). This prevents a fleet from concurrently editing a
  shared lib and its consumers into an inconsistent contract.

### 4.3 Contract-freeze
- Shared interfaces/types (the pattern that made *this* build cohere: the
  `DeployableEvidence` interface was frozen up front, so A produced and B consumed the
  same shape with zero coordination cost) are marked **frozen**. A write that mutates a
  frozen contract requires an explicit coordinated bump (a claim on the contract itself,
  granted to one agent, with dependents notified). Stale-contract is the #1 fleet killer;
  this closes it.

### 4.4 Integrate-on-write
- On each admitted write, re-run incremental analysis over the changed blast radius
  (freshness engine, changed-file + content-hash, already cheap) and run the affected
  tests (`get_coding_context` already returns the exact tests). Breakage is broadcast to
  the fleet via the presence channel immediately.

## 5. Enforcement proof (the demo upgrade)

Upgrade `coordination-fleet-demo` to prove **prevention**, not just detection:
- Inject a **true same-symbol collision** (two agents both edit function `X`).
- v1 behavior: both proceed (advisory) → clobber.
- v2 behavior: first gets the grant; second is **queued or redirected** — assert the
  clobber is *prevented*, and that the redirected agent is handed non-conflicting work.
- Add a **drift** case: an agent edits an unclaimed file → the write-hook auto-claims it →
  a second agent editing the same symbol is arbitrated. Assert the drift is caught (the
  A+E `orchestrator.ts` scenario, now visible).

## 6. Phased rollout

1. **P1 — Symbol-level claims + enforced arbitration.** Wire `arbitrate()` as a real gate
   at CAS-node granularity; add lease/heartbeat. Upgrade the demo to prove prevention.
2. **P2 — Write-hook.** Auto-announce actual edits (kills the drift class). Unify work
   claim vs edit-lock lifecycle; fix release/complete semantics (finding #4).
3. **P3 — Blast-radius reservations + contract-freeze.** Reserve dependents' contract
   surface; protect frozen interfaces.
4. **P4 — Integrate-on-write.** Per-edit incremental re-analysis + test broadcast.
5. **P5 — Cross-machine.** Lift all of the above onto the remote tier (Redis/WS fanout,
   durability) so fleets span machines, not just same-machine agents.

## 7. Why this is defensible

Every mechanic rides on the CAS/WAS graph. A coordination layer that grants at the symbol
level, reserves the blast radius, and freezes contracts requires *understanding the code* —
which requires the deep analysis nobody else has. File/line coordinators (git, editors,
existing multi-agent harnesses) cannot offer the guarantee. The fabric's promise —
**"a fleet that never steps on itself"** — is only credible on top of Klauro's shared
context. Related: [[klauro-coordination-fabric]], [[klauro-product-model]].
