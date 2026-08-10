# SPEC — The Parallel Development Fleet (100-200 agents, ~100x wall-clock)

> **Status: VISION**, grounded in a SHIPPED foundation. The coordination primitives this
> spec depends on are real and proven at N=8-64 same-machine processes
> (`docs/FABRIC-FLEET-PROVEN.md`); the conceptual vocabulary agents would coordinate on is
> real and shipped (`docs/SPEC-CONCEPTUAL-LAYER.md`, v1.0.12). What is NOT yet built: the
> work-DAG decomposer/scheduler, cross-machine fan-out, and any run at fleet scale (100-200
> agents). Read every claim in this doc as "the proven pieces make this plausible," not "this
> has been demonstrated end to end." Cross-references: `docs/SPEC-COORDINATION-FABRIC-V2.md`
> (the mechanism), `docs/SPEC-CONCEPTUAL-LAYER.md` (the alignment vocabulary), `docs/
> SPEC-GIANT-FLEET.md` (peer spec, scale-specific hardening), `docs/SPEC-ANALYZER-PACKS.md` and
> `docs/CUSTOM-CONVENTIONS.md` and `docs/COVERAGE-INTELLIGENCE.md` (peer specs — coverage
> breadth that feeds the same graph this vision coordinates on).

## 1. The vision, stated plainly

Today, building a large feature or migration is single-piece flow: one engineer (or one
agent), one branch, serialized steps, merged at the end. Klauro's bet is that a codebase
Klauro has deeply analyzed — CAS graph, workspace-level composition, conceptual layer (capability → flow
→ step → function) — can support the opposite: **decompose an entire project's scope into a
work-DAG, hand disjoint pieces to a fleet of 100-200 agents running concurrently, and have
the combined output integrate cleanly** — not because a human pre-assigned every symbol (that
does not scale past ~10 agents), but because the fabric + the conceptual layer do the
coordination work a human orchestrator would otherwise have to do by hand.

**The target: ~100x less wall-clock than single-piece flow** for a project-sized scope (not
a single function — a whole feature, migration, or subsystem). This is a projection, not a
measurement — see §7 for what is and isn't proven yet.

## 2. Why this is only possible with the layers below it

A fleet of 100-200 agents editing one codebase concurrently fails in three ways without deep
structural understanding:

1. **Duplicate work** — two agents independently solve the same sub-problem because neither
   could see the other was already on it.
2. **Merge conflicts (textual) and, worse, conceptual conflicts** — two locally-valid changes
   that are jointly incoherent (A changes a contract, B's concurrent change assumes the old
   one) and that git/linters cannot see at all.
3. **Stranded work** — an agent is assigned a piece of the DAG that turns out to depend on
   work another agent hasn't finished, and it either blocks (killing the parallelism) or
   proceeds on a stale foundation (producing garbage).

Klauro's answer to all three is the same: **coordinate on the graph, not on the text.** The
CAS graph plus the conceptual layer is what lets the fabric know, structurally, whether
two agents' scopes actually overlap — a capability incumbents (git, editors, generic
multi-agent harnesses) structurally cannot offer, because they do not have the graph.

## 3. Decomposing a project into a claimable work-DAG

**VISION — not yet built.** The pieces that would compose into this:

- **Source of the DAG's nodes: the conceptual layer.** A large scope (e.g. "add
  multi-currency support") decomposes not into files but into **flows and steps** —
  `get_flow_concepts` already computes Capability → Flow → Step → Function for the *existing*
  system; the same machinery, pointed at a *proposed* change, should be able to project which
  existing flows/steps are touched and which new ones need to be created. This projection
  step does not exist yet.
- **Source of the DAG's edges: the CAS graph's dependency edges.** Step B depends on Step
  A if A's output (per the I/L/S/O contract) is B's input, or if B calls a function A is
  changing the signature of. This is mechanically derivable from existing `calls`/`imports`/
  `references` edges plus the flow-step I/L/S/O contracts — the derivation logic for
  "therefore Step B can't start until Step A's contract is frozen" does not exist yet.
- **The scheduler.** Given the DAG, compute the maximally-parallel disjoint partition and
  assign it up front. `docs/SPEC-COORDINATION-FABRIC-V2.md` §1.5 names this explicitly as
  workstream **P6 — work-partitioner/scheduler**, not yet built, and is unusually candid about
  what the reference implementation actually is today: *"the MANUAL orchestrator loop
  (decompose → disjoint claims → fan out → reconcile) — which ran this whole session with
  zero clobbers across many waves — AUTOMATED."* In other words: this document's vision is,
  right now, a human (or a single orchestrating agent) doing this by hand, successfully, at
  small scale (5-8 agents per wave, observed repeatedly this session per the CHANGELOG's
  "parallel session of N agents" entries). The automation of that same loop is the gap.

## 4. How agents claim, coordinate, and merge via the fabric

This part rests on real, shipped mechanism (`docs/SPEC-COORDINATION-FABRIC-V2.md` §1.7,
proven at N=64 same-machine processes in `docs/FABRIC-FLEET-PROVEN.md`):

- **Awareness, not locking, is the default.** Every agent in the fleet sees who else is
  active, on what, with what intent, and the CAS blast radius of their in-flight change —
  without requesting anything. This is what makes 100-200-way concurrency conceivable at all:
  the fabric does not serialize the common case, it makes the common (disjoint) case free and
  the rare (overlapping) case visible.
- **Conceptual-conflict detection is the crown jewel at this scale.** At 100-200 agents,
  textual/merge conflicts are the easy case (git catches them). The failure mode that actually
  kills a fleet this large is two agents whose changes each pass review individually but
  compose into something broken — a contract divergence, an invariant violated by one and
  assumed by the other, structural divergence. `docs/SPEC-COORDINATION-FABRIC-V2.md` §1.7's
  conflict hierarchy is written exactly for this: git/linters catch textual conflicts;
  Klauro's semantic graph is the only thing that can catch the conceptual ones, because it is
  the only thing with the contract/type/caller graph plus declared intent.
- **Opt-in exclusive grants for the genuinely non-fungible case.** When work is *not*
  fungible — an agent must edit symbol X and another holds it — the fabric never dead-ends the
  agent (`docs/SPEC-COORDINATION-FABRIC-V2.md` §1.6: "no agent is ever unable to complete work
  it needs"). It offers wait, request-handoff, proceed-with-awareness, or stale-lease takeover.
  This is proven correct (FIFO queue, lease/heartbeat, stale-lease takeover) at N=64 in
  `docs/FABRIC-FLEET-PROVEN.md`, but that proof is same-machine, same-disk. Whether this
  degrades gracefully at 100-200 real distributed agents (likely across machines — see §6) is
  unproven.
- **Merge-as-art (VISION).** `docs/SPEC-COORDINATION-FABRIC-V2.md` §1.7 primitive #5 —
  producing a merge PLAN reconciled at the intent level, not the text level, when agents
  finish — is named in the spec but has no shipped implementation as of this writing.

## 5. How the conceptual layer aligns agents on MEANING, not files

The single biggest lever this vision has over a generic multi-agent coding harness: **an
agent's unit of work is a step of a flow, not a file or a line range.**

- "Own the *Charge* step of the *Checkout* flow" is legible to a human reviewer, composes
  naturally with the I/L/S/O contract Klauro already computes for that step
  (`get_flow_concepts`), and gives the fabric a real semantic handle to detect overlap on —
  two agents both claiming "Charge step of Checkout flow" are an obvious duplicate; two
  agents on "Charge step" and "Refund step" of the same flow sharing an invariant
  ("Order.total must be positive") are a real conceptual-conflict candidate that file-level
  coordination cannot see at all. This exact cross-flow, cross-file conceptual conflict was
  demonstrated (not merely designed) in `docs/CHANGELOG.md`'s v1.0.12 entry
  ("conceptual-vocab-fabric" — Checkout/Refund sharing an invariant, correctly flagged
  between two agents who never touched the same file).
- This is why the conceptual layer (Layer 3, `docs/SPEC-CONCEPTUAL-LAYER.md`) is a
  *prerequisite* for this vision, not a nice-to-have alongside it: without it, the fabric's
  claims are file/symbol coordinates, and a 100-200-agent fleet coordinating at that
  granularity degenerates into either lock contention (files claimed too coarsely) or
  invisible conceptual breakage (symbols disjoint but jointly incoherent — the exact failure
  mode the battle-test in `docs/SPEC-COORDINATION-FABRIC-V2.md` §1 found empirically before
  this reframe).
- **Ambient capture** — the fleet's shared context (intent broadcasts, in-flight diffs,
  conceptual coordinates) accumulates as agents work, so a newly-spawned agent joining wave 3
  of 10 inherits the accumulated awareness of waves 1-2 for free, rather than starting cold.
  This is implied by the awareness substrate's design (§1.6/§1.7 of the fabric spec) but has
  not been measured at a "wave N inherits wave N-1's context" scale — that measurement is
  part of what a giant-fleet run (§7, and the peer `docs/SPEC-GIANT-FLEET.md`) would need to
  produce.

## 6. Honest current state vs. the vision

| Dimension | Proven today | Vision (this doc) |
|---|---|---|
| Concurrency scale | N=8-64 real OS processes, same machine (`docs/FABRIC-FLEET-PROVEN.md`) | 100-200 agents, likely spanning multiple machines |
| Coordination granularity | Symbol/path-level opt-in grants; conceptual-coordinate awareness (flow/step/capability) — both shipped | Same primitives, at 2-3 orders of magnitude more concurrent participants |
| Work decomposition | Manual: a human/orchestrating agent decomposes and assigns by hand (proven repeatedly this session at 5-8 agents/wave — see `docs/CHANGELOG.md`'s many "N-agent parallel wave" entries) | Automated work-DAG decomposition + scheduler (fabric spec's P6, not built) |
| Cross-machine | `remote-store.ts` exists as a write-through-cache design, unit-tested with a mocked HTTP client only | Real multi-machine fan-out, durable, tested under real network conditions |
| Merge reconciliation | Conceptual-conflict *detection* (shipped, precision 1.0 at scale); merge-as-art *plan generation* (not built) | Automated intent-level merge plans, conflicts routed for resolution rather than silently text-merged |
| Wall-clock claim | Not measured — no giant-fleet run has occurred | ~100x vs. single-piece flow for project-sized scope (projection) |

**The honest gap in one sentence:** every primitive this vision needs has been proven at
small-to-medium scale on one machine; nothing has been proven at the scale (100-200 agents,
likely cross-machine) or shape (automated DAG decomposition, not manual) the vision actually
describes. `docs/SPEC-GIANT-FLEET.md` (peer, in progress) is where that scale-up work and its
proof should land; this doc should be updated to point at its results once they exist.

## 7. What "proven at N processes → scale" needs to show next

In order of what would most change confidence in the ~100x claim:

1. **A real automated work-DAG decomposition** of one nontrivial, real project scope (not a
   toy), producing a disjoint-partition claim set a fleet could actually execute against —
   even a manual audit of "would this partition have been safe" against the actual commits
   from one of this session's N-agent waves would be informative and is cheap to do
   retroactively.
2. **A giant-fleet run at 100+ simulated agents**, same-machine first (extending
   `fabric-fleet-stress.ts`'s existing N=8-64 harness — it is designed to scale, per its own
   driver code, and is the natural next data point before attempting cross-machine).
3. **A real cross-machine double-grant test.** `docs/FABRIC-FLEET-PROVEN.md` is explicit that
   this is untested; it is also the single largest unproven claim standing between "proven
   same-machine" and "the vision as stated" (which implies spanning enough agents that one
   machine is unlikely to be the deployment shape).
4. **An actual wall-clock comparison**: the same project-sized scope, once via single-piece
   flow (one agent, serialized) and once via a coordinated fleet, both measured, not
   projected. Nothing like this exists yet in any doc in this repo.

Until (1)-(4) land, "~100x less wall-clock" is the product's aspiration, stated honestly as
such, not a measured result.
