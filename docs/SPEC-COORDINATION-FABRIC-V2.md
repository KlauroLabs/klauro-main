# SPEC — Coordination Fabric v2 (Concurrent Work + Awareness + Semantic Reconciliation)

> ## ⚠️ SUPERSEDED BY [SPEC-COORDINATION-FABRIC-V3.md](./SPEC-COORDINATION-FABRIC-V3.md) — READ V3 FIRST
>
> The **mechanics** below remain valid. The **framing is wrong on six counts**, and the
> framing is what readers act on. Specifically, do NOT act on:
> - **§1.5's metric hierarchy** ("collisions prevented is *table stakes*") — collision-prevention
>   is not a lower rung, it is the **wrong axis**. The north star is the **free flow of work**.
>   Lean INTO collision.
> - **§7's closing promise** ("a fleet that never steps on itself") — defensive framing. The
>   promise is a fleet that **flows**.
> - **§6's phase ordering** — "Integrate-on-write / per-edit re-analysis" is listed as P4 of 6.
>   It is the **substrate (P0)**: the fabric must be built ON the analysis, with in-flight
>   reanalysis. Nothing else is sound without it (v3 §3).
> - **§1.7 primitive 5** ("intent-aware merge / merge-as-art") — the ceiling is **mergeless
>   work** (v3 §5), not cleverer reconciliation.
> - **§6's status table** — STALE. It says P6 (work-partitioner) is "not yet built";
>   `plan_parallel_work` is shipped and is the strongest tool in the set. See v3 §8.
>
> Evidence that this framing actively misleads: an agent read this doc and built a
> *defensive, serialized* fleet — banning its own agents from the hot file and deferring real
> work to avoid collisions that a single awareness call showed did not exist (v3 §6.4).
>
> **Status: PARTIALLY IMPLEMENTED** as of 2026-07-02. Motivated by a live 6-agent
> battle-test on one feature (deployable-detection build, workspace
> `deployable-detection-build`). v1 = [[SPEC-COORDINATION-FABRIC]] (advisory
> detection). **§1.7 is the current, authoritative model** — concurrent work +
> awareness + semantic reconciliation, NOT locking/enforcement — superseding
> this doc's own earlier framing in §0/§2/§5/§6 (kept below for build-order and
> rollout detail, but read every "enforced arbitration"/"gate the write"
> passage through the §1.7 and §3-note reframe: the opt-in exclusive tool
> (`grant-manager.ts`, proven 7/7 unit + 8/8 enforcement-demo) is a convenience
> layered on the awareness substrate, not the fabric's default mechanism).
> Conceptual-conflict detection (§1.7 primitive #4, the crown jewel) is the
> piece completing §1.7 — in progress this session
> (`coordination/conceptual-conflict.ts` + its demo/bench, uncommitted as of
> this doc's audit); the awareness/opt-in-grant substrate is already built.

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

## 1.5 North star: accelerant, not bottleneck

The fabric's purpose is to make a fleet do MORE work in parallel, FASTER — not to gate it.
A fabric that serializes is a tax; a fabric that partitions and routes is a driving force.
Three commitments make it an accelerant:

- **Finest-grain locking.** Lock the symbol/region, never the file. Coarse locks serialize a
  fleet; symbol-level locks let N agents safely share one file (proven: P1 "disjoint symbols
  run free"). This is load-bearing — coarsen it and the fabric itself becomes the bottleneck.
- **Redirect, don't block.** A conflicting agent must be handed DIFFERENT non-conflicting work
  off the CAS/WAS graph, not parked in a queue. Block-time is the enemy; drive it toward zero.
  (`redirect_hint` in P1 is the seed → must become real work-routing.)
- **Proactive partitioning (the collision that never happens).** Given a task set + the graph,
  compute the maximally-parallel non-conflicting partition and assign it up front. This is the
  MANUAL orchestrator loop (decompose → disjoint claims → fan out → reconcile) — which ran this
  whole session with zero clobbers across many waves — AUTOMATED. **The reference implementation
  for the fabric's scheduler is a human/agent orchestrator doing exactly this by hand.**

**North-star metric: throughput / parallelism factor, block-time → 0** — NOT "collisions
prevented." Defensive framing (prevent clobbers) is table stakes; the product is *safe
concurrency at scale*. Every fabric change is judged by whether it lets more agents work
productively at once, not merely whether it blocks the unsafe ones. New workstream **P6 —
Work-partitioner/scheduler**: consumes pending tasks + CAS/WAS, emits disjoint parallel batches
+ live redirect routing; and a **throughput bench** (agents-in-parallel, block-time, wall-clock
vs serial) as the acceptance metric for the whole fabric.

## 1.6 Awareness is the primitive — partitions/locks must never block NEEDED work

Partitioning (§1.5) reduces contention, but a partition that prevents an agent from doing work
it genuinely NEEDS is just a lock in disguise — the bottleneck reappears one layer up. The
resolution: **awareness is the core primitive; partitioning and enforcement are optimizations
layered on it that ALWAYS degrade back to "coordinate with full context," never "denied."**

- **Every agent can always SEE the full picture**: who is working where, on what symbol/region,
  with what INTENT, what is in-flight/uncommitted, and — via the CAS/WAS graph — the BLAST RADIUS
  of a change (which other symbols/scopes it touches, and who is mid-change there). Awareness is
  never gated; only *edits* are coordinated.
- **Fungible vs non-fungible work.** Redirect (§1.5) applies ONLY to fungible work ("pick a
  different, interchangeable task"). When the work is NON-fungible — agent A must edit symbol X to
  complete its assigned change and B holds X — A is NEVER dead-ended. The grant response must be
  awareness-rich (holder id + intent + in-flight diff + lease staleness) and offer real options:
  wait, request handoff, proceed-with-awareness if the changes are compatible, or take over a
  stale/expired lease. A hard "denied, do something else" for needed work is a DEFECT.
- **Blast-radius awareness is the enabler**, not a fence: it tells an agent WHEN it must cross a
  boundary and gives the context to do it safely, rather than pretending boundaries are walls.
- **Enforcement is soft-by-design**: the grant/lock is a coordination convenience that reduces
  friction in the common (disjoint) case; it must always be overridable by necessity + awareness.
  The invariant "one active grant per symbol" governs *simultaneous blind writes*, not an agent's
  RIGHT to reach work it needs — that's mediated by awareness + negotiation, not denial.

Test of a healthy fabric: no agent is ever unable to complete work it needs; contention is
resolved by informed coordination, not by lockout.

## 1.7 THE CORE MODEL: concurrent work + awareness + semantic reconciliation (NOT locking)

The prior sections still under-reached: they treated overlap as something to *serialize away*.
Wrong. **Two agents editing the same file — even the same function — concurrently is FINE and
often desirable, as long as they have awareness of what the other is doing.** Awareness (a) helps
MERGE later, (b) avoids DUPLICATE work, and (c) surfaces CONCEPTUAL conflicts. Locking is demoted
to an OPT-IN tool for the rare genuine-exclusive case; it is NOT the coordination model.

**The conflict hierarchy (this is the reframe):**
- **Textual / merge conflicts** — same lines edited. Git already catches these. Cheap, visible,
  mechanical. NOT the fabric's job.
- **Conceptual conflicts** — two locally-valid changes that are jointly INCOHERENT. Invisible to
  git/linters/editors; they pass textual merge and break the system. **This is the fabric's
  crown-jewel value, and it is only detectable with code semantics + intent** — which only the
  CAS/WAS + the coordination store provide. Examples:
  - Contract divergence: A changes a signature/type/nullability/return; B's concurrent change
    assumes the OLD contract. (CAS knows callers + types.)
  - Invariant conflict: A's intent establishes an invariant ("now idempotent / immutable / always
    non-null"); B's change violates or duplicates it. (Needs intent + semantic diff.)
  - Structural divergence: A splits/renames/moves a structure that B is concurrently building on.
  - Behavior drift: two edits to one function that compose to unintended behavior (A adds an
    early return; B's added code below is now dead).

**Primitives (in ascending value), all always-on, none gating:**
1. **Intent broadcast** — each agent declares what it's doing; all see it live.
2. **In-flight diff sharing** — each sees the others' uncommitted changes to overlapping code.
3. **Duplicate-work detection** — overlapping intent+diff → "you're both doing X."
4. **Conceptual-conflict detection (crown jewel)** — for agents whose scope/blast-radius
   intersect, compare intents + in-flight diffs against the CAS/WAS graph to flag contract breaks,
   invariant violations, structural divergence, behavior drift. Deterministic where possible
   (type/contract/caller changes), AI-interpreted for intent-level invariants.
5. **Intent-aware merge (merge-as-art)** — when agents finish, produce a merge PLAN reconciled at
   the INTENT level, not the text level: compatible intents compose coherently; conceptual
   conflicts are surfaced for human/agent resolution rather than silently textually-merged.

**Enforcement/grants (former §3) are demoted**: an OPT-IN exclusive-access request for the rare
case, layered on the same store. The DEFAULT is concurrent-with-awareness. The invariant work
(grant-manager) is kept as that opt-in tool + as the awareness substrate (who's touching what),
NOT as the coordination model. Redeploy/WS2 wiring should surface awareness + conceptual-conflict
signals, not gate.

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

> **Consistency note (per §1.7): the core model is concurrent work + awareness
> + semantic reconciliation, NOT locking.** The table below lists what got
> BUILT across v1→v2, but "enforced arbitration" (the `grant-manager.ts` /
> `claim_work` machinery) is the **opt-in exclusive-access tool** sitting on
> top of the awareness substrate — it is not what governs the default,
> concurrent case. Read every "v2 (fleet-scale)" cell below as "available as
> an opt-in mechanism," not as "the thing that gates every write." The
> genuinely core v2 addition is the awareness substrate itself (live grant
> holder context + intent + lease status on every response) plus conceptual-
> conflict detection (§1.7, §4.5) — not arbitration.

| Dimension | v1 (today) | v2 (fleet-scale) |
|---|---|---|
| Conflict handling | Advisory `checkEditLock` (detection only) | **Awareness-first**: every agent always sees who holds what, with what intent, and full CAS/WAS blast-radius context (§1.6). **Enforced arbitration** (`arbitrate()`/`grant-manager.ts`: grant / queue / redirect, leases + heartbeats) exists as an **opt-in tool** (`claim_work`) for the rare genuine-exclusive case — it is a convenience layered on the awareness substrate, not the default gate on writes. |
| Claim origin | Predicted paths, declared up front | Claims (via the opt-in `claim_work` tool) are still declared up front today; write-hooked/emergent claim derivation (auto-announcing the actual file+symbol touched) remains a **P2 rollout item**, not yet built |
| Granularity | File paths (`pathsOverlap`) | **Symbol/region**, when the opt-in grant tool is used — `claim_work` accepts `symbols`/`paths` and `grant-manager.ts` arbitrates at that granularity. Concurrent, non-exclusive work at file or symbol granularity needs no claim at all under the awareness-first model. |
| Dependency awareness | Blast-radius *detected* in collision sweep | Blast-radius awareness is surfaced to every agent via `check_collision`/`claim_work` responses (holder + intent + lease status); a hard **reservation** of dependents' contract surface (P3) is a follow-on, not yet built |
| Shared contracts | Unmanaged | **Contract-freeze guards** (P3): still a rollout item, not yet built. Today, contract drift across concurrent edits is caught by conceptual-conflict detection (§1.7, §4.5) after the fact via CAS/type comparison, not prevented up front by a freeze lock |
| Integration | Merge-time | **Integrate-on-write** (P4): still a rollout item, not yet built |
| Claim lifecycle | Partial release | Explicit `complete`/`supersede` + TTL reconciliation is built for the opt-in grant path (`grant-manager.ts`: lease + heartbeat + FIFO queue advancement on release/expiry) |

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

### 4.5 Conceptual-conflict detection (the crown jewel, §1.7)

This is the mechanic that actually embodies the core model: comparing concurrent
agents' intents + in-flight diffs against the CAS/WAS graph to flag JOINTLY
INCOHERENT changes (contract divergence, invariant conflicts, structural
divergence, behavior drift) — the thing textual merge and linters structurally
cannot see. As of this session, `apps/mcp-server/src/coordination/conceptual-conflict.ts`
exists (with a companion `conceptual-conflict.test.ts`) and is under active
development — it defines the input model (`SymbolChangeKind`: signature,
return_type, nullability, param, rename, split, move, delete, body, add) and a
`detectConceptualConflicts` entry point, deterministic-first per the module's
own header comment (detectors 1-4 are pure/deterministic; an optional
AI-flavored invariant-conflict detector must degrade to a no-op, never gate the
others). This file is uncommitted as of this doc's last edit — treat it as
in-progress, not yet a shipped guarantee. Verify its current state directly
(`ls apps/mcp-server/src/coordination/`, run its test file) before citing it as
complete in any other doc.

## 5. Opt-in enforcement demo (NOT the core coordination guarantee)

`grant-manager.ts` and its companion enforcement demo (commit `6becbaeb`,
8/8 assertions) prove that the OPT-IN exclusive-grant tool works correctly when
an agent chooses to use it: same-symbol collision is prevented (queued, not
granted), the FIFO queue advances correctly, stale leases can be taken over,
heartbeats hold a lock alive, disjoint-symbol work runs free of any gate, and
redirect hints are returned. This is real and tested, but it proves the
opt-in tool's own invariant ("at most one active grant per symbol") — it is
**not** evidence that the fabric's default behavior is to gate writes. Most
concurrent work in the fabric's core model (§1.7) never calls `claim_work` at
all; it relies on awareness (who's active, what they intend, what's in-flight)
and, increasingly, conceptual-conflict detection (§4.5) rather than grants.
- Drift case (still relevant under the awareness-first model): an agent edits
  a file it never predicted claiming — the A+E `orchestrator.ts` scenario from
  the battle-test (§1, finding 2). Under the core model this is a case for
  awareness (surfacing that both touched it) and conceptual-conflict detection
  (did their changes actually compose badly?), not for a write-hook auto-claim
  gate — write-hooked claim derivation (P2) remains a rollout item, not a
  built mechanism, and even once built it would feed the awareness substrate
  first, the opt-in grant tool only if an agent chooses to request one.

## 6. Phased rollout

> Per §1.7, P1 below is the **opt-in exclusive-access tool**, not the fleet's
> default coordination model — it is DONE (see §5). The core-model items
> (awareness substrate, conceptual-conflict detection) are tracked separately
> below as P1.5/P4.5 since they were not in the original phase numbering.

1. **P1 — Symbol-level claims + enforced arbitration (DONE, opt-in tool).**
   `arbitrate()`/`grant-manager.ts` gate a write only when an agent opts in via
   `claim_work`, at CAS-node/symbol granularity, with lease/heartbeat. The
   enforcement demo (commit `6becbaeb`, 8/8) proves prevention for agents that
   choose to use the tool.
1.5. **Awareness substrate (core model, largely live).** `get_active_agents` /
   `check_collision` / `get_in_flight_changes` already return holder identity,
   intent, and lease status without requiring any grant — this is the actual
   default coordination surface per §1.6/§1.7, distinct from P1's opt-in gate.
2. **P2 — Write-hook.** Auto-announce actual edits (kills the drift class). Unify work
   claim vs edit-lock lifecycle; fix release/complete semantics (finding #4). Not yet built.
3. **P3 — Blast-radius reservations + contract-freeze.** Reserve dependents' contract
   surface; protect frozen interfaces. Not yet built.
4. **P4 — Integrate-on-write.** Per-edit incremental re-analysis + test broadcast. Not yet built.
4.5. **Conceptual-conflict detection (crown jewel, §1.7/§4.5).** In active
   development this session (`coordination/conceptual-conflict.ts`, uncommitted
   as of this doc's last edit) — verify current state before citing as shipped.
5. **P5 — Cross-machine.** Lift all of the above onto the remote tier (Redis/WS fanout,
   durability) so fleets span machines, not just same-machine agents. Not yet built.
6. **P6 — Work-partitioner/scheduler (§1.5).** Consumes pending tasks + CAS/WAS, emits
   disjoint parallel batches + live redirect routing; throughput bench (agents-in-parallel,
   block-time, wall-clock vs serial) as acceptance metric. Not yet built.

## 7. Why this is defensible

Every mechanic rides on the CAS/WAS graph. A coordination layer that grants at the symbol
level, reserves the blast radius, and freezes contracts requires *understanding the code* —
which requires the deep analysis nobody else has. File/line coordinators (git, editors,
existing multi-agent harnesses) cannot offer the guarantee. The fabric's promise —
**"a fleet that never steps on itself"** — is only credible on top of Klauro's shared
context. Related: [[klauro-coordination-fabric]], [[klauro-product-model]].
