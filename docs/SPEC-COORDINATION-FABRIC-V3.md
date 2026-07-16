# SPEC — Coordination Fabric v3 (The Free Flow of Work)

> **Status:** DRAFT for review. Supersedes SPEC-COORDINATION-FABRIC-V2.md.
> v2 is not wrong in its mechanics — it is wrong in its **axis**. Read §1 first;
> it is the whole point of this revision.

---

## 0. The vision this serves (verbatim, authoritative)

> "The goal of fabric is not to prevent collisions. In fact thinking of that as table
> stakes is wrong. Fabric enables parallel work on the same file/capability/flow/step/
> function/etc. It MUST use the analysis itself to empower its work (which is why fabric
> is, or should be, built on top of the analysis, in flight reanalysis, etc). Collision is
> not avoided, **we lean into it**, to allow the work to flow freely. **The free flow of
> work is the north star.** We also help avoiding duplicate work, recreating of the same
> work, misunderstanding of concepts, shared knowledge that can be used by multiple
> participants, **mergeless work**. I want to be able to run dozens, or even hundreds, of
> human engineers, or AI agents on a codebase and **NEVER worry about problems**."

Everything below is downstream of that paragraph. Where this spec and that paragraph
disagree, the paragraph wins.

---

## 1. What v3 changes (the inversions)

v2 got the mechanics substantially right and the framing substantially wrong. Six
inversions:

| # | v2 said | v3 says |
|---|---|---|
| 1 | "North-star metric: throughput… **NOT** 'collisions prevented.' Defensive framing is **table stakes**." (§1.5) | Collision-prevention is **not a lower rung — it is the wrong axis.** Do not rank it. Delete it from the hierarchy. The north star is the **free flow of work**. |
| 2 | "a fleet that **never steps on itself**" (§7, the closing promise) | "a fleet that **flows**." The promise is not absence-of-harm, it is presence-of-throughput-with-understanding. |
| 3 | In-flight/per-edit re-analysis is **P4 of 6** ("Integrate-on-write. Not yet built.") | **In-flight reanalysis is P0 — the substrate.** The fabric is a *consumer of a live analysis*. Nothing else in this spec works without it. This is an inversion, not a reprioritization. |
| 4 | Ceiling = "intent-aware merge (**merge-as-art**)" (§1.7 primitive 5) | Ceiling = **mergeless work** (§5). Merge-as-art is reconciliation *deferred and made clever*. Mergeless is divergence *never accumulated*. |
| 5 | Coordination unit = file / symbol / blast radius | Coordination unit = the **semantic unit**: capability · flow · step · function · symbol. Two participants on the same *function* is a supported, ordinary case. |
| 6 | (unstated) | **Explicit scale target:** dozens → hundreds of participants — human engineers *and* AI agents, mixed — on one codebase, with **zero worry**. That is the acceptance bar. |

**Also correcting the record:** v2 §6 lists P6 (work-partitioner) as "Not yet built."
It is built and is the best tool in the set (`plan_parallel_work`). v2's status table is
stale; §8 below replaces it.

---

## 2. The north star: the free flow of work

A fabric that serializes is a tax. A fabric that *prevents* is a lock with better
marketing. The product is **flow**: at any moment, every participant is doing useful,
non-duplicated, coherent work, and no participant is blocked, waiting, guessing, or
redoing.

**Lean into collision.** Overlap is not a failure mode to be designed away — it is the
normal condition of many participants working on one system, and it is often *desirable*
(two people improving one function from different angles is good). The fabric's job is not
to keep them apart. It is to make sure that while they overlap they **see each other, share
what they know, and stay coherent.**

Corollary: **textual merge conflicts are not the fabric's problem.** Git catches them; they
are cheap, visible, and mechanical. A fabric that measures itself on clobbers prevented is
measuring the wrong thing and will build the wrong product (see §6 — this is not
hypothetical; it happened).

---

## 3. The substrate: the fabric is built ON the analysis — P0

**This is the load-bearing claim of v3.** The fabric is not a coordination service that
happens to sit next to an analyzer. It is a **consumer of a live, continuously-updated CAS/WAS
that includes uncommitted work, attributed per participant.**

### 3.1 In-flight reanalysis (the substrate)

- The analysis must include **work in progress**, not only committed code.
- It must be **attributed**: participant P's semantic delta is *P's*, distinguishable from Q's.
- It must be **continuous**: updated as work happens, not on demand at a merge moment.
- The unit of the delta is **semantic** (this symbol's contract changed; this flow gained a
  step; this capability's behavior moved), not textual (these lines differ).

The seed exists: analyses already carry a **`track: 'in-flight'` (dirty working tree)**
alongside `main` / `other-branch`. **The fabric does not consume it.** Wiring that is W0.

### 3.2 Why git cannot be the substrate (proven, not asserted)

Git is **tree-global**; participants are **not**. Two independent failures observed in one
session (§6.2):

- **Attribution collapses.** Ambient capture = "this process's own `git diff`". On a shared
  working tree, *every* participant's "own diff" is the **union of everyone's** work.
  `plan_intent_merge` credited four agents with an edit only one made. Its "0 conflicts"
  verdict was correct *by luck, not by reasoning* — it cannot tell whose change is whose,
  so it would equally report 0 conflicts if two participants had genuinely clashed.
- **Tree-global operations destroy work.** One agent's `git stash` swept up another agent's
  uncommitted edits. The `pop` aborting on conflict is the only thing that saved them. The
  fabric had zero visibility: `check_conceptual_conflicts` correctly reported no *semantic*
  conflict, because there wasn't one — the harm was mechanical and beneath its notice.

Git knows lines. The fabric needs concepts and authorship. **Only the analysis has both.**
This is also why the fabric is defensible (§10): a competitor coordinating on text
structurally cannot do this.

---

## 4. What the fabric delivers

Not "prevention." These five, all continuous, none gating:

1. **No duplicate work.** Two participants building the same thing — same concept, not
   merely same file — is detected and surfaced *while it is happening*, not at merge.
2. **No re-creation.** Work already done (by anyone, committed or in-flight) is discoverable,
   so nobody rebuilds it from scratch.
3. **No concept misunderstanding.** Participants share the same vocabulary — capability ·
   flow · step · ICELOT contract — grounded in the same graph. Divergent *understanding* is
   the root of most divergent code.
4. **Shared knowledge.** What any participant learns about the system is available to all,
   live. The analysis is the shared brain, not each participant's private notes.
5. **Mergeless work** (§5).

**Awareness is never gated.** Any participant can always see: who is working where, on what
concept, with what intent, what is in-flight, and the blast radius of any change. Only
*edits* are ever coordinated — and per §2, coordination means informed concurrency, never
denial. **A participant that cannot reach work it needs is a defect.**

---

## 5. Mergeless work

**Definition.** Merge exists because two participants change a shared artifact *blind to each
other*, accumulate divergence, and reconcile *after the fact*, at the *text* level. Mergeless
work removes each of those preconditions:

- not blind — every participant works against an analysis that already contains the others'
  in-flight semantic deltas;
- no accumulation — coherence is maintained continuously, so divergence never compounds;
- no after-the-fact — there is no "merge moment" to be surprised at.

**Mergeless does not mean "git never merges."** Text merges may still occur mechanically.
Mergeless means **there are no merge *decisions***: by the time code lands, every question a
merge would have asked was already answered while the work was live. The merge is a
formality, not a negotiation.

**The metric:** merge-decision count → 0, and **surprise rate → 0** (a participant should
*never* first learn of a relevant change at merge time).

This is the step beyond v2's "merge-as-art." Art is what you need when you deferred the
problem. Mergeless is not deferring it.

---

## 6. Evidence base

### 6.1 The thesis, in one line, from real data

A three-agent fleet ran concurrently on one shared working tree (2026-07-16), plus a fourth
agent unrelated to them, on a 47k-node repo:

> **Everything grounded in the ANALYSIS worked. Everything grounded in GIT broke.**

That is not a slogan; it is the session's actual outcome, both halves.

### 6.2 What worked (analysis-grounded)

- **`plan_parallel_work` (the partitioner)** partitioned 4 tasks into 2 batches
  (parallelism factor 2.00) in one call — and did it **better than a careful human
  orchestrator could**: it separated two tasks whose *literal paths were disjoint* but whose
  **CAS call-graph blast radii intersected**. A file/path partitioner structurally cannot see
  that edge. It later proved *materially* right: the agent in the separated batch
  independently discovered that the true defect it was chasing lived in the *other* batch's
  files. **The graph knew where the bug was before any agent started.**
- **Awareness surface** (`get_in_flight_changes`, `fab_list_active_work`, `check_collision`)
  answered "is anyone in this file?" in one call, correctly (nobody was).
- **Free flow itself worked.** Three agents edited a shared tree concurrently — including
  the repo's hottest file — and composed cleanly: 0 conceptual conflicts, tsc clean across
  both packages, 445 tests green, zero clobbers *between the concurrent editors*.

### 6.3 What broke (git-grounded)

- **Attribution collapse** — `plan_intent_merge` over-attributed (§3.2). Unsound at N>1 on a
  shared tree.
- **The stash clobber** — one agent's tree-global `git stash` swept another's in-flight work;
  two agents independently reported opposite halves of the same incident (one: "my edits
  silently disappeared"; the other: "my stash nearly clobbered a peer"). Neither could see
  the other's half. **The fabric was blind to both.**
- **`fab_release_work` returned `released_count: 0`** for a claim that was definitely made —
  the release/complete semantics defect v2 §6 already knew about ("finding #4"), still open.
- **No mid-task claim extension.** An agent doing the *correct* fix had to touch three files
  outside its declared claim, with no affordance to say "I also need X — is that safe?"
  Treating a claim as fixed scope pushes participants to either under-fix or go dark.

### 6.4 The meta-finding

The orchestrator (an AI agent) read v2 and still built a **defensive, serialized** fleet:
banned its own agents from the hot file, forced new-files-only, made them propose edits as
text for hand-application, and *deferred real work* to avoid a file — which a single
awareness call would have shown was free. **If the spec's own reader optimizes for
collision-avoidance, the spec is mis-framed.** v3 exists substantially because of that
failure. A doc whose closing promise is "never steps on itself" will keep producing exactly
that behavior.

---

## 7. Architecture

```
                    ┌───────────────────────────────────────┐
                    │  LIVE ANALYSIS  (CAS/WAS)             │
   W0 substrate ──► │  committed  +  in-flight (per         │
                    │  participant, semantic, continuous)   │
                    └───────────────────┬───────────────────┘
                                        │  (everything reads from here)
          ┌─────────────┬───────────────┼───────────────┬──────────────┐
          ▼             ▼               ▼               ▼              ▼
    Awareness      Partitioner     Dup-work &      Conceptual      Mergeless
    (who/what/     (route work     re-creation     coherence       (continuous
     where/why)     up front)      detection       (contract/      reconciliation;
                                                    invariant/      0 merge
                                                    structure/      decisions)
                                                    drift)
```

**Rule:** every box reads the analysis. No box reads `git diff` for authorship or meaning.
Git remains the *storage/transport* of text; it is never the source of truth for *who
changed what concept*.

**Enforcement/grants** remain available as an **opt-in** tool for the rare genuinely-exclusive
case. They are not the model, not the default, and must always degrade to
"coordinate-with-full-context," never "denied."

---

## 8. Workstreams (status, replacing v2 §6)

| ID | Workstream | Status | Note |
|---|---|---|---|
| **W0** | **In-flight reanalysis substrate** — live CAS incl. uncommitted work, attributed per participant, continuous | **NOT BUILT — P0** | `track:'in-flight'` exists; **the fabric does not consume it.** Everything below depends on this. Was v2's P4. |
| W1 | Awareness surface | **LIVE** | `get_in_flight_changes`, `fab_list_active_work`, `check_collision`. Works. Keep ungated. |
| W2 | Partitioner / scheduler | **SHIPPED** (v2 said "not built" — stale) | `plan_parallel_work`, blast-radius-aware. Remaining: live **redirect routing** (hand fungible work sideways, never park) + **throughput bench**. |
| W3 | Conceptual-conflict detection | **SHIPPED but UNSOUND at scale** | Built on git ambient capture → attribution collapses (§3.2). **Must be re-based on W0.** The detectors themselves are good. |
| W4 | **Mergeless** | **NOT BUILT** | `plan_intent_merge` is v2-era merge-as-art. Re-base on W0, then push from "reconcile at the end" to "never diverge." Metric: merge-decisions → 0. |
| W5 | Write-hook (auto-announce real edits) | **NOT BUILT** | v2 P2. Kills the self-reporting drift class. Includes fixing release/complete semantics (`released_count:0`). |
| W6 | Scoped primitives | **NOT BUILT** | "diff/isolate **only my claimed paths**" so participants never reach for `git stash`; warn on tree-global git ops while peers hold claims. Direct answer to §6.3. |
| W7 | Claim extension mid-task | **NOT BUILT** | "I also need to touch X — safe?" Small; removes a real friction (§6.3). |
| W8 | Blast-radius reservations + contract-freeze | **NOT BUILT** | v2 P3. **Reframed:** these are *awareness amplifiers*, not fences. A reservation that blocks needed work is a lock in disguise. |
| W9 | Cross-machine | **NOT BUILT** | v2 P5. Required for the scale target (§1 #6): hundreds of participants are not one machine. |

**Ordering:** W0 first and alone if necessary. W3/W4 are *blocked* on it — re-basing them is
what converts the crown jewel from "right by luck" to "right by construction."

---

## 9. Acceptance metrics

Retire: "collisions prevented," "clobbers avoided." They measure the wrong axis (§1 #1).

Adopt:

- **Parallelism factor** — participants doing useful work simultaneously.
- **Block-time → 0** — time any participant spends waiting/queued/denied.
- **Rework rate → 0** — work discarded because of divergence discovered late.
- **Duplicate-work rate → 0** — the same concept built twice.
- **Merge-decision count → 0** — the mergeless metric (§5).
- **Surprise rate → 0** — a participant first learning of a relevant change at merge time.
- **Wall-clock vs serial** — the honest throughput number.

**The acceptance test:** N participants (mixed human + agent), N scaling dozens → hundreds,
on one real codebase, sustained, with **zero lost work and zero worry**. Nothing less
validates §0.

---

## 10. Why this is defensible

Every mechanic here rides on a **live, attributed, semantic** view of the codebase — including
work that is not committed yet. Git, editors, and existing multi-agent harnesses coordinate on
**files and lines**. They can tell you two people touched the same region. They cannot tell you
two people are building the same *capability*, that one changed a *contract* the other's
in-flight code assumes, or that a *concept* has drifted between them — because they have no
model of capability, contract, or concept, and no attributed view of uncommitted work.

**Mergeless work is not reachable from text.** It requires knowing what changed *in meaning*,
by *whom*, *while it is happening*. That is exactly and only what Klauro's analysis provides.

The fabric is not a coordination feature bolted onto an analyzer. **The analyzer is what makes
the fabric possible, and the fabric is what makes the analyzer indispensable at scale.**

Related: [[SPEC-COORDINATION-FABRIC-V2]] (superseded framing; mechanics still valid),
[[SPEC-CONCEPTUAL-LAYER]], [[SEMANTIC-MODEL]].
