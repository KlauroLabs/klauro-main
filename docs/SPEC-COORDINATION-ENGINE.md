# SPEC — Coordination Engine (Fabric v3 upgrade set) — v1.1

> **Status:** SPEC, ready to build. **v1.1** (2026-07-21) folds in the three cold-review
> outcomes against v1.0 (892506be): subscriptions replaced by claim-scoped event delivery,
> structured intent reduced + auto-derived, outcomes reduced, three protocol-shape blockers
> promoted to wave 1, sharding reduced to a short additive note (Appendix A), and new sections for
> security/tenancy, clock semantics, topology, and hub honesty. Companion to
> [SPEC-COORDINATION-FABRIC-V3.md](./SPEC-COORDINATION-FABRIC-V3.md) (the authoritative
> framing: the free flow of work) and [SPEC-COORDINATION-FABRIC.md](./SPEC-COORDINATION-FABRIC.md)
> (v1, the historical build record). Where this spec and v3 §0 disagree, v3 §0 wins.
> Written self-contained: §0.2 defines every term; no session context is assumed.
> Appendix B lists everything a cold reader must **not** build.

---

## 0. Goal — the free flow of micro- AND macro-parallel work

The coordination engine exists to let any number of participants (human engineers and AI
agents, mixed) work one codebase simultaneously with **zero worry and zero waiting**, at
**two scales at once**:

- **MICRO-parallelism** — fine-grained concurrency: two participants in the same file, the
  same function, interleaved hunks. Git owns the textual merge (it is cheap, visible,
  mechanical); the fabric owns **awareness** — who else is here, with what intent, changing
  which contract, so that overlap composes instead of surprising.
- **MACRO-parallelism** — independent lanes: features, refactors, and analysis workstreams
  proceeding across the codebase and across machines, coordinating only where their
  footprints, contracts, or concepts actually touch.

Every upgrade below is stated against BOTH scales. A mechanism that serves only macro (lane
bookkeeping too heavy for a two-minute same-file edit) or only micro (awareness too chatty
to survive a hundred lanes) is mis-designed.

**Doctrine (non-negotiable, from v3):** everything here is ADVISORY and AWARENESS. Nothing
blocks, nothing permission-gates, nothing queues a participant that wants to work.
Throughput — the free flow — is the north star; collisions are leaned into, not designed
away. Textual conflicts remain git's job. **Advisory-never-blocking is also what makes
scale-freedom possible at all:** a fabric that must be consulted before a write is a
serialization point and a single point of failure that grows with the fleet; a fabric that
only ever adds awareness can be ignored, sampled, or read lazily, so its cost is always
opt-in and its failure mode is "less awareness," never "no work." A participant that
ignores the fabric entirely is still safe — git remains the merge authority; the fabric
removes nothing and gates nothing (see §2.4).

### 0.1 Scale — built to just work, however many are working

**The engine is built to just work regardless of how many parallel agents or humans are
doing work.** That is the whole vision statement — and it is achieved through the ordinary
design choices already in this spec (an append-only log, scoped/neighborhood queries,
advisory-never-blocking, no O(fleet) per-participant primitives), not through any dedicated
scale program. Practical consequences:

- No hardcoded fleet-size caps anywhere, and nothing assumes an agent count; the magnitudes
  named in this spec (2, 10, 100, 1,000, 10,000) are illustrative checkpoints only.
- No data structure or protocol whose cost **for a single participant's operation** is
  linear in total fleet size: a participant's operation cost depends on its own
  **scope/relevance neighborhood** — the claims, events, and contracts that overlap what it
  is doing — never on how many other participants exist (per-surface notes in §2.3 as brief
  design rationale, with the sparsity caveat §2.5 makes honest).
- Wire shapes (keys, cursors, epochs) are picked once so they never have to change as
  fleets grow — protocol shapes are the one thing that cannot be fixed later without
  breaking clients.
- **The implementation ships single-shard.** If write volume ever demands sharding, the
  immutable-`claim_id` shard key and the epoch/cursor shape make it additive (Appendix A).

### 0.2 Glossary (cold-reader contract — terms as used in this spec)

- **CAS** — Codebase Analysis (single-repo): the precomputed structural + semantic model of
  one repository (nodes = functions/classes/files, edges = calls/imports, plus routes,
  entities, capabilities, flows). Produced by `packages/analyzer-core`.
- **WAS** — Workspace Analysis (cross-repo): the same, lifted to a multi-repo workspace —
  cross-repo links, shared-code rollup, workspace capabilities.
- **Fabric** — the multi-agent coordination layer built on CAS/WAS
  (`apps/mcp-server/src/coordination/`), exposed as MCP tools (`fab_*`, `check_*`,
  `plan_*`) and HTTP (`/v1/coordination/*`).
- **Participant / agent** — any actor working the codebase: a human, an AI coding agent, an
  orchestrator. Identified by a stable `agent_id`.
- **Lane** — one participant's coherent stream of work (a feature, a fix, a spec), typically
  one claim.
- **Claim** — an advisory announcement of intent: "agent X intends to touch these
  paths/symbols, because <intent>." Today's shape (`WorkClaim`, `coordination/types.ts`):
  `{claim_id, seq, workspace_id, agent_id, agent_kind, scope{repo, paths[], symbols[],
  capability?, concept?}, intent (free text), status, created_at, ttl_ms, heartbeat_at,
  base_commit?, branch?}`. Claims never grant exclusivity (an opt-in enforced-grant tool
  exists separately and is out of scope here).
- **Board** — the set of claims + events for a workspace: an append-only log
  (`claims.jsonl`) under `KLAURO_COORD_DIR || ~/.klauro/coordination/<workspace_id>/`,
  LWW-reduced per `claim_id`, with entry kinds beyond plain claims (`unclaimed-edit`,
  `surprise`) that are always `status:'released'` (pure events, never active claims). Two
  tiers: LOCAL (same machine, file-backed) and REMOTE (a server hosting the same store for
  cross-machine fleets).
- **Addressed event** — a board entry targeted at a specific `agent_id` (today: surprises).
- **Epoch** — a UUID identifying one lifetime of a board's log; cursors are only meaningful
  within one epoch (§7).
- **Writer version** — a per-claim monotonic counter owned by the WRITER of that claim,
  echoed through every publish; the LWW reduction key (§7.2b).
- **In-flight** — uncommitted working-tree work. Ambient capture
  (`in-flight-capture.ts`) diffs a participant's actual tree into per-symbol
  `SymbolChange[]` (signature/return/nullability/param/rename/…) with no self-reporting.
- **Contract** — an interface surface others depend on: an export, function signature, HTTP
  endpoint, type/DTO shape, event, schema.
- **Surprise** — a persisted, addressed event: a contract-divergence finding that would pass
  textual merge silently; delivered to the affected participant.
- **Blast radius** — the set of nodes structurally affected by changing a symbol, walked
  over CAS/WAS edges.
- **Relevance neighborhood** — the slice of the board that overlaps a participant's own
  footprint (paths ∪ symbols ∪ declared contracts ∪ their bounded blast radius). The unit
  all per-participant costs are bound to (§2).

---

## 1. Executive summary

The fabric today is an awareness board: advisory claims with free-text intent, ambient
in-flight capture, conceptual-conflict detection, surprise events, intent-merge, and a
blast-radius-aware partitioner. The upgrades below turn the board into a coordination
ENGINE — a shared narrative of what the fleet is building, has built, and is about to
touch:

1. **Structured intent, reduced + auto-derived** (§3) — claims declare **`produces`** /
   **`consumes`** contracts (no goal, no phase self-reporting, no status lifecycle); a
   deterministic drift detector fires surprises at consumers; and — the adoption fix —
   ambient observation **auto-lifts** contract changes onto the board, so lazy agents still
   power it.
2. **Outcome records on release, reduced** (§4) — release carries `outcome`, `commits`,
   `successor_notes`; the board becomes an append-only recent narrative queryable by
   arriving agents. Precondition: the documented `released_count: 0` defect is fixed first.
3. **Claim-scoped event delivery** (§5) — **the claim IS the subscription.** No
   registration step, no interest taxonomy, no digests, no filtered SSE in v1: every active
   claim auto-subscribes its owner to addressed events and to events overlapping its own
   footprint, drained via a strictly-capped `events` block on `fab_*` responses.
4. **Predictive footprint** (§6) — claims carry co-change-predicted paths with
   probabilities, advisory-labeled, **excluded from `near`-matching by default** (§2.5).
5. **Durable board + protocol-shape blockers** (§7) — the restart-wipe fix (pathing +
   epoch), plus three protocol shapes that must land in wave 1 because they never change
   after: the compaction delivery floor (§7.2a), writer-owned LWW versions (§7.2b), and a
   durable remote-sync cursor (§7.2c). Sharding itself shrinks to a short additive note
   (Appendix A).
6. **Transitive conceptual awareness** (§8) — blast-radius expansion via the reachability
   index (bounded, hop-labeled, advisory), replacing one-hop edge scans, with
   neighborhood-scoped comparison instead of all-pairs.

New in v1.1: **security/tenancy** (§11), **clock semantics** (§12), **topology &
attribution soundness** (§13), **hub honesty** (§2.5), **engineering hygiene + failure
injection** (§14), and the **deployment constraint** (§7.4).

Build order (§15): wave 1 = durable board (reduced fix) + the three blockers + the
`released_count` defect; wave 2 = reduced structured intent with auto-derivation +
claim-scoped event drain; wave 3 = outcomes; then transitive/predictive as their substrate
lanes merge.

Rejected along the way (§9): required structured fields, contract freezes, a standalone
subscription broker, an event-sourcing rewrite, unbounded transitive expansion, any
board-global scan as a per-participant primitive — and, new in v1.1: phase/goal
self-reporting, the interest taxonomy, v1 digests and filtered SSE, cold segments, the
`contracts_changed` enum, and mutable-scope shard keys.

---

## 2. Scale model (applies to every upgrade)

### 2.1 The board is read by scope; the implementation ships single-shard

Today `getActiveClaims(workspace)` parses the whole log — O(all claims) per read. Fine at
2–100 participants; wrong as a primitive at 1,000+ and forbidden by §0.1 as the ONLY read
path. What ships now:

- **One log per board** (`claims.jsonl`), exactly today's file. If write volume ever
  demands sharding, it lands additively — see the short note in Appendix A.
- **Derived scope index.** A compacted inverted index (path-prefix → claim_ids,
  contract-name → claim_ids, concept → claim_ids), rebuilt incrementally on append,
  persisted beside the log. All neighborhood queries go through it.
- **Scoped reads are the default API.** `fab_list_active_work` gains `near?: {paths?,
  symbols?, contracts?, concepts?}` returning only the relevance neighborhood, paginated
  (`cursor`, `limit`). The unscoped full-board listing remains available (it is genuinely
  useful at small scale and for dashboards) but is paginated and explicitly documented as
  the non-scaling convenience form.
- **Cursor shape is fixed now** so it never changes: `{epoch, seq}` (§7). Clients reset to
  0 when the epoch differs **or when their cursor exceeds the board's `max_seq`** — the
  latter catches a backup-restore rollback, where the epoch survives but the log is
  shorter than the client remembers.

### 2.2 Write path is O(own claim); matching is lazy

A claim/heartbeat/release append costs O(size of the entry) — never a board scan, never
write-time fan-out to subscribers. All matching (overlap, event delivery, drift) is
evaluated at READ time against the reader's neighborhood via the scope index. Lazy
read-time matching is the single most important scale decision in this spec: it makes
10,000 writers cost the same per-write as 2.

### 2.3 Scaling laws per surface — design constraints, NOT deliverables

These laws constrain the shape of what gets built (a build that violates one is wrong);
they are not performance targets to demonstrate, and no large-fleet benchmark is owed
before shipping.

Let **F** = fleet size, **N** = participant's own footprint size, **H** = participant's
relevance neighborhood (claims/events overlapping its footprint), **K** = a small constant
(top-K caps), **E** = new events relevant to the participant since its cursor.

| Surface | Cost law | Never |
|---|---|---|
| Claim / extend / heartbeat / release (write) | O(N) | O(F) |
| Board read, scoped (`near`) | O(H), paginated | O(F) |
| Overlap / collision check | O(N + H) | O(F²) all-pairs |
| Contract-board query (§3) | O(matching contracts) via index | full-log scan |
| Event drain (§5) | O(E), strictly capped | O(F) fan-out per event |
| Outcome query (§4) | O(limit) via index, retention-bounded | unbounded log growth |
| Predictive footprint (§6) | O(K) per claim at claim time | recompute per reader |
| Transitive blast radius (§8) | O(answer), bounded (maxNodes/maxDepth) | O(V+E) walk per query |

Collision detectors today (collision.ts) compare all active claims pairwise — O(F²). That
is acceptable inside `plan_parallel_work` over a TASK list (bounded input, one planner) but
must not be the shape of ambient per-participant checks: those compare MY footprint against
MY neighborhood (via the scope index), O(N + H).

The magnitudes as illustrative checkpoints: at 2–10 participants everything above collapses
to today's single-file board and nothing changes; at 100, scoped reads and pagination start
mattering; at 1,000+, sharding would land additively if ever demanded (Appendix A); beyond
that, nothing
new breaks because no per-participant cost referenced F in the first place.

### 2.4 Graceful degradation is a scale feature

Every surface degrades toward "less awareness," never "less work": no reachability index →
one-hop; no co-change index → no predictions; no claim → no event drain, poll explicitly;
fabric unreachable → work proceeds, git merges. A participant that never calls the fabric
is exactly as safe as git makes everyone today. The engine therefore can never become the
bottleneck that blocks work — which is precisely why it may be allowed near a large fleet.

### 2.5 Hub honesty — O(H) is conditional on scope sparsity

The O(neighborhood) laws in §2.3 assume footprints are sparse: most claims touch few paths
and most paths appear in few claims. **Hub scopes break the assumption**: a shared types
file, a barrel export, a hot config — a path that appears in MANY claims makes H approach F
for anyone touching it. The engine does not pretend otherwise; it makes hubs visible and
bounded:

- **Per-query caps on every index lookup.** A `near` query, overlap check, or event drain
  against a hub path returns at most a cap (default 25 entries per queried path), with
  `truncated: true` and a **count summary** (`{path, total_matches}`) past the threshold —
  the reader learns "this is a hub with 400 claims on it" without paying for 400 entries.
- **Predicted paths are EXCLUDED from `near`-matching by default.** Co-change prediction
  (§6) naturally concentrates on hub files, which would inflate everyone's neighborhood
  with probabilistic edges. Readers opt in (`near: {include_predicted: true}`) when they
  want probable convergence included; overlap findings against predicted paths always
  carry the `'predicted-co-change'` label + probability.
- Truncation is honest degradation per §2.4: less awareness on hubs, never silence — the
  count summary IS the awareness.

---

Every upgrade below was verified against the current implementation
(`apps/mcp-server/src/coordination/*`, `context-fabric.ts`, `server.ts` fab_* tools,
`remote-analyzer-service.ts` `/v1/coordination/*`) on 2026-07-21. Per-upgrade: verified
current state, micro/macro framing, schema sketch, MCP surface, scale note, effort class
(S/M/L), dependencies.

## 3. Upgrade 1 — Structured intent, reduced: `produces` / `consumes`, auto-derived

### Verified current state
`WorkClaim` carries free-text `intent`, `scope.paths/symbols`, optional `scope.capability`
and `scope.concept`. No way to DECLARE a contract the lane will create. Contracts appear
only as OBSERVATIONS: `InFlightSnapshot.touched.contracts` feeds collision.ts detector 3
(drift). Surprise events exist (`ClaimLogEntry.kind:'surprise'`, local-store.ts) but fire
only from `plan_intent_merge` at reconciliation time — after the fact, not while a consumer
is still building.

### What v1.1 cut, and why
v1.0 also specified `goal`, self-reported `phase` (+ `set_phase`), a
`declared → draft → stable` status lifecycle, and `consumes.{from_agent, declared}` flags.
All CUT: self-reported state is exactly the check-in tax that v1 WS-E showed agents skip,
and stale self-reports are worse than none. What remains is only what the machine can
verify (drift detection) plus the minimum humans/agents actually consult (name, shape,
where). **Phase is derived, never declared:** no ambient edits observed = `exploring`;
edits observed = `building`; test telemetry observed = `verifying`. Readers get a phase
signal with zero writer burden and zero staleness.

### Micro + macro
- **Macro (the proof point):** the 2026-07-20 UI rebuild ran in-flight contract reuse
  MANUALLY — lanes stubbed against exports a scaffold lane had merely declared (names +
  signatures, not yet written); the scaffold honored every declared signature; integration
  required zero rework. The declarations lived in prompts and handoff prose; the fabric
  carried none of it. This upgrade makes that pattern a fabric primitive.
- **Micro:** two participants in one file — A declares `produces: getUser(): User` while
  still writing it; B, editing a caller three functions down, records `consumes:
  ["getUser"]` and builds against the declared signature immediately. If A's ambient diff
  then diverges from the declaration, B gets a surprise while both changes are still soft.

### Schema (additive, all optional)

```ts
/** A contract this lane will create/change (declared), or has been observed changing. */
interface DeclaredContract {
  kind: 'export' | 'signature' | 'endpoint' | 'type' | 'event' | 'schema';
  name: string;               // "buildOutcomeRecord", "GET /v1/coordination/outcomes"
  path?: string;              // where it lives / will live
  signature?: string;         // legible: "(ws: string, opts?: {limit}) => OutcomeRecord[]"
  notes?: string;             // semantics a signature can't carry ("throws on empty ws")
  status?: 'declared' | 'observed';   // 'observed' = auto-lifted from ambient capture (below)
}

interface WorkClaim {
  // ...existing fields unchanged...
  produces?: DeclaredContract[];
  consumes?: string[];        // plain contract names
}
```

- **Contract identity is `(kind, name, path?)`.** Path-qualified matching is preferred;
  a name-only match (consumer names a contract without a path, or two same-named contracts
  exist) is reported at **lower confidence** and labeled as such in findings. No new
  contract syntax: `produces` reuses the interface-signature vocabulary the analysis
  already speaks (`get_interface_signature`, ICELOT contracts). `signature` is a string on
  purpose: agents write and read it; the deterministic comparator works on the
  ambient-captured `SymbolChange[]`, not on parsing this string.

### Auto-derivation — the adoption fix (observation is the floor)
Explicit declaration is the high-signal path, but the board must not depend on diligence:

1. **Observed `produces`.** When ambient capture sees a participant's diff change a
   contract surface (a `SymbolChange` on an export/signature/type/endpoint), the change is
   auto-lifted onto that participant's claim as a `produces` entry with
   `status: 'observed'` — same shape, machine-derived, no writer action. A lane that never
   declares anything still shows the fleet what contracts it is moving.
2. **Observed `consumes`.** When a participant's ambient diff references a contract that a
   PEER claim has declared or been observed producing (a new call site / import / type use
   matching identity above), a `consumes` edge is auto-recorded on the participant's claim.
   The dependency graph between in-flight lanes assembles itself.
3. Explicit entries always win over observed ones for the same identity (a declaration is
   intent; an observation is evidence of activity); both appear on the board, labeled.

### Behavior: in-flight contract reuse, first-class
1. **Query declared/observed contracts.** `fab_list_active_work({contracts: true, near?})`
   returns the contract board (who is producing what), served from the contract-name index
   (§2.1) — no new tool.
2. **Build against them.** A peer stubs against a declared contract and records (or is
   observed into) the `consumes` edge on its own claim.
3. **Divergence auto-fires a surprise.** New pure detector
   `detectDeclaredContractDrift(myClaim, neighborhoodClaims, snapshots)` in collision.ts:
   when a producer's observed `SymbolChange[]` disagrees with its declaration
   (signature/return/nullability/param via the existing `SymbolChangeKind` machinery), or
   the producer releases without producing, append `kind:'surprise'` entries addressed to
   each consumer — `SurpriseDetail` gains `contract?: string` and
   `reason: 'declared_contract_drift' | 'declared_contract_missing'`. Delivery rides §5's
   claim-scoped drain. Advisory: the consumer decides.

### MCP surface
- `fab_claim_work` / `fab_extend` / `/v1/coordination/claim` (advisory mode) gain
  `produces`, `consumes`. (No `set_phase` — phase is derived.)
- Tool descriptions teach: "declare what you will export before you write it; peers build
  against it immediately. If you don't, ambient observation fills the board anyway —
  declaring is just higher-signal and earlier."

### Scale note
Declaration cost O(own contracts); auto-lift cost O(own diff); consumer lookup O(matching
contracts) via the contract-name index; drift detection compares one producer's diff
against ITS consumers (edges recorded on claims), never all claims. Hub contracts (a type
everyone consumes) hit §2.5's caps + count summaries.

**Effort: M** (types + passthrough S; drift detector M; auto-lift M — it rides the
existing ambient capture pipeline).
**Deps:** none hard; delivery of surprises with §5; attribution soundness per §13.

## 4. Upgrade 2 — Outcome records on release, reduced

### Verified current state
Release is amnesiac: `fab_release_work` / `releaseAgentWithReason` flip `status:'released'`
and nothing else — no commit hashes, no successor notes. Compaction keeps a bounded tail of
released entries (`COMPACT_KEEP_RELEASED = 50`), so even those vanish. An arriving agent
cannot ask "what just landed here and what should I know?" — that lives in handoff prose,
off-board.

**PRECONDITION (build order §15): fix the documented `fab_release_work` `released_count: 0`
defect first** (local-store.ts `releaseAgentWithReason` — a caller-facing zero must say
why; see v3 §6.3 finding). Outcome records attached to a release path that silently
releases nothing would inherit the silence.

### What v1.1 cut, and why
- **Cold segments** (roll-off files beyond the hot retention budget): deferred to
  Appendix B. The board is a RECENT narrative; git is the deep history. Until a real fleet
  exhausts `COMPACT_KEEP_OUTCOMES`, cold storage is speculative machinery.
- **The `contracts_changed` enum**: cut. Final contract disposition is already on the
  board via §3 (`produces` entries, declared or observed, at release time); a parallel
  structured enum is double bookkeeping. Anything else goes in `successor_notes` free text.

### Micro + macro
- **Macro:** an arriving lane reads the recent narrative — what landed, which commits, what
  the releasing lane left for successors — instead of re-deriving it from git log + prose.
- **Micro:** a participant finishing a same-file stint records "renamed X→Y, callers in
  this file updated, the one in `other.ts` is NOT" — the next participant in that file sees
  it on arrival.

### Schema

```ts
/** New ClaimLogEntry kind, following the 'unclaimed-edit'/'surprise' pattern:
 *  always status:'released', never picked up as an active claim. */
interface OutcomeDetail {
  claim_id: string;           // the claim this outcome closes
  outcome: 'done' | 'partial' | 'abandoned' | 'handoff';
  commits?: string[];         // hashes landed (may be empty for docs/abandoned)
  successor_notes?: string;   // free text: "the X path is stubbed; Y still needs a bench"
}
// ClaimLogEntry.kind gains 'outcome'; ClaimLogEntry.outcome?: OutcomeDetail
```

### Retention
Outcomes get their own retention budget (`COMPACT_KEEP_OUTCOMES`, default 200 per board)
separate from plain released-claim churn — the narrative is the point; bookkeeping must not
evict it. Beyond the budget, oldest outcomes compact away (subject to the §7.2a delivery
floor); git remains the deep history via `commits`.

### MCP surface
- `fab_release_work` gains optional `outcome`, `commits`, `successor_notes`; omitting them
  all = today's behavior exactly.
- New read: `fab_recent_outcomes({ workspace, limit?, paths? })` — most-recent-first,
  path-scoped via the index. Folded into arriving-agent onboarding
  (`get_agent_start_context` / `get_workspace_agent_context` gain a `recent_outcomes`
  block) so new lanes see the narrative without knowing to ask.
- `/v1/coordination/release` mirrors the fields; `/v1/coordination/state` includes outcomes
  past the cursor.
- Outcome and surprise payloads pass through `security.ts` redaction before storage and
  delivery (§11) — successor notes and drift details can quote code.

### Scale note
Write O(1); scoped query O(limit) via the path index; growth bounded by retention. At any
fleet size the hot narrative per scope stays constant-size.

**Effort: S.** **Deps:** §7 (a narrative on an ephemeral board is pointless); the
`released_count` precondition above.

## 5. Upgrade 3 — Claim-scoped event delivery: the claim IS the subscription

### Verified current state
Three delivery mechanisms exist, none general: `subscribe_workspace` is an honest stub
(arms an fs-watch for 250ms, tells the caller to poll — MCP stdio has no server push);
surprises are ADDRESSED events but delivered only when the agent happens to call
`fab_list_active_work(agent_id)`; remote SSE (`/v1/coordination/stream`) pushes ALL
workspace deltas, unfiltered. The pieces of an event system exist — an append-only log with
a monotonic cursor, addressed entries — but no systematic drain.

### What v1.1 replaced, and why
v1.0 specified a registration step (`kind:'subscription'` entries), a five-variant interest
taxonomy, digest overflow, and per-subscriber filtered SSE. All replaced (taxonomy, digests,
filtered SSE → Appendix B): a registration step is a second check-in tax on top of the
claim the agent already made, and the interest taxonomy re-describes information the claim
already carries — its footprint. **The claim IS the subscription.** No new entry kind, no
new lifecycle, nothing to renew (claim TTL is the subscription TTL), nothing for a lazy
agent to forget. `subscribe_workspace` is NOT repurposed; it keeps its current honest-stub
behavior and its name stays unburned.

### Design
**Implicit subscription.** Every active claim auto-subscribes its owner to exactly two
event classes:
1. **Addressed events** — entries targeting this `agent_id` (surprises, incl. §3 drift).
2. **Footprint-overlap events** — new entries (claims, unclaimed-edits, outcomes) whose
   scope overlaps this claim's own footprint (paths ∪ symbols ∪ declared contracts),
   matched lazily at read time via the scope index.

**Drain on any fabric call.** Every `fab_*` response MAY carry an `events` block:

```ts
interface EventsBlock {
  entries: ClaimLogEntry[];   // strictly capped (default 10), nearest/most-relevant first
  resume_seq: number;         // read the rest from here via fab_list_active_work / state
  truncated: boolean;         // backlog exceeded the cap
  epoch: string;              // §7 — cursor validity domain
}
```

Rules: **absent when empty** (zero noise for the common case); strictly capped (a burst
never bloats a response — `truncated: true` + `resume_seq` instead); hub-capped per §2.5;
gap-honest per §7.2a (a caller whose cursor precedes `min_retained_seq` gets an explicit
gap notice, never silence). An agent that heartbeats/claims/checks anyway gets its events
for free — zero additional round-trips.

**No claim, no drain.** Agents without an active claim poll explicitly:
`fab_list_active_work({near})` — which is the correct cost model, since an agent with no
footprint has no relevance neighborhood to scope a drain to.

### Micro + macro
- **Micro:** a same-file participant's "interests" are exactly its claim footprint —
  narrow by construction — and delivery piggybacks on calls it was already making.
- **Macro:** a lane consuming another lane's declared API hears about drift (addressed
  surprise) or release/outcome (footprint overlap) without polling, for as long as its own
  claim lives.

### Scale note
Zero write-time fan-out: an event append costs the same whether 0 or 100,000 claims exist,
because matching happens at each reader's drain, scoped to that reader's footprint —
O(E) per drain, hard-capped. No subscription store whose size tracks fleet size, because
there are no subscription records at all. This satisfies §2.3's event-drain law by
construction.

### MCP surface
- `events` block piggybacked on `fab_claim_work` / `fab_extend` / `fab_check_collision` /
  `fab_list_active_work` / `fab_release_work` / `check_collision` /
  `check_conceptual_conflicts` responses when the caller has an active claim.
- No new tools. No changes to `subscribe_workspace`.

**Effort: S–M** (matcher + cursor S; drain wiring across tool responses M).
**Deps:** §7 (epoch + delivery floor — cursors over a log that resets or compacts
underneath are broken without them). §13's W5 note bounds delivery latency for agents that
rarely call the fabric.

## 6. Upgrade 4 — Predictive footprint (co-change) on the claim

### Verified current state — mostly built, at CHECK time, by a concurrent lane
The git-history co-change index exists (`packages/analyzer-core/.../co-change-index.ts`,
top-K Laplace-smoothed conditional probabilities per file — in-flight on the
math-intelligence lane, SPEC-MATHEMATICAL-INTELLIGENCE §F), and two consumers already use it
(also in-flight): `computeAdvisoryOverlap` (context-fabric.ts) expands a proposed claim's
paths into a predicted footprint, reporting hits as `'predicted-co-change'` with a
probability, clearly labeled, advisory-only; and the partitioner's `softConflictWeights`
uses co-change as a soft, bounded batching signal.

Genuinely missing: the prediction is recomputed at every CHECK and never lives on the
BOARD. A peer listing active work sees only declared paths — "this lane will probably also
touch the schema file" is invisible unless the peer runs its own check.

### Micro + macro
- **Micro:** a participant editing a file sees on the board that a peer's claim probably
  reaches the same file next (schema ↔ migration, config ↔ reader) before any overlap is
  literal.
- **Macro:** the partitioner and arriving lanes read predicted footprints off the board to
  route around probable convergence — one claim-time computation serving every reader.

### Schema

```ts
interface PredictedPath {
  path: string;
  probability: number;        // from the co-change index, max of both directions
  source: 'co-change';        // future: 'reachability', 'declared-contract'
}
// WorkClaim.predicted_paths?: PredictedPath[]   (additive)
```

Computed ONCE at claim/extend time (server-side where the index is loadable; silently
skipped when absent — same graceful degradation as computeAdvisoryOverlap), top-K capped
(default 5, min probability 0.3 — reuse §F's thresholds, import them, don't duplicate).
Every rendering labels them predictions: shown under `predicted_paths`, never merged into
`paths`; overlap findings against a predicted path keep the `'predicted-co-change'` reason
+ probability so a peer can weigh and ignore freely. **Predicted paths are excluded from
`near`-matching and event-drain overlap by default** (§2.5) — co-change concentrates on hub
files and would inflate every neighborhood; readers opt in via
`near: {include_predicted: true}`.

### Scale note
O(K) per claim at claim time; readers pay nothing extra. Opt-in indexing keeps hubs honest.

### MCP surface
No new tools. `fab_claim_work`/`fab_extend` responses and `fab_list_active_work` entries
carry `predicted_paths`; `fab_check_collision` reports predicted overlap via
`computeAdvisoryOverlap` once that lane lands.

**Effort: S** (a claim-time call + one field). **Deps:** the co-change lane landing.
Coordinate through the fabric; do not duplicate its thresholds.

## 7. Upgrade 5 — Durable board + the protocol-shape blockers

### 7.1 Verified current state + defect diagnosis (2026-07-21 incident)
The LOCAL tier is already durable: `claims.jsonl` under
`KLAURO_COORD_DIR || ~/.klauro/coordination/<workspace_id>/`, append-only, atomic appends,
LWW-compacted — host restarts lose nothing. Grants are markers in the same log, sharing its
durability.

The REMOTE tier reuses the same local-store primitives on the server
(remote-analyzer-service.ts advisory claim path → `appendClaim`) — architecturally durable —
**but the container never sets `KLAURO_COORD_DIR`** (verified: absent from
`infrastructure/vps/docker-compose.yml` and the service code), so the server's board lives
at `~/.klauro/coordination` on the container's **ephemeral overlay filesystem** while the
mounted volume (`/opt/klauro/data:/data`) sits unused for coordination. Container restart ⇒
every claim gone, and — because `seq` is derived from the log file — **seq resets to 1**,
silently breaking every `GET /v1/coordination/state?since=<cursor>` poller (their cursor is
now "in the future"; they see nothing forever).

**This is a pathing defect, not an architecture gap.** The persistence shape consistent
with the two-tier store is: the claim log IS the board; no separate database.

Fix specification:
1. **Pathing:** set `KLAURO_COORD_DIR=/data/coordination` in the api service environment
   (compose). One line; zero store-code changes. (docker-compose.yml is currently modified
   by a concurrent lane — coordinate the edit through the fabric or land it with that
   lane's change.)
2. **Board epoch:** the store writes `board.json` `{ epoch: <uuid>, created_at }` beside the
   log on first creation. Every `/v1/coordination/state`/`active`/SSE payload and every
   fab_* response carries `epoch`. **Cursor = `{epoch, seq}`. A client resets to 0 when its
   stored epoch differs — or when its cursor exceeds the board's current `max_seq`**, which
   catches the backup-restore rollback case (same epoch restored, shorter log). Also
   protects the LOCAL tier against manual store deletion. (§5's drains require this.)
3. **Boot sweep:** the normal TTL/heartbeat expiry already marks stale claims expired on
   first read after restart — verify with a test; no new mechanism.
4. **Ops guard:** `klauro doctor` checks that a containerized server's coordination dir is
   on a mount; deploy smoke asserts a claim made pre-deploy is listable post-deploy. The
   ops guard also reports per-board write rate, the number that would tell us if sharding
   (Appendix A) were ever actually demanded.

### 7.2 Protocol-shape blockers (wave 1 — these shapes never change after)

Three findings from the cold reviews are not features but WIRE SHAPES: once clients exist,
they cannot be revised. They land in wave 1 regardless of which upgrades follow.

**(a) Compaction delivery floor.** Compaction must never silently destroy undelivered
events. Either compaction respects `min(cursor)` across unexpired claims' owners, OR —
the chosen default, because it needs no cursor registry — every response carries the
board's **`min_retained_seq`**, and a caller whose cursor precedes it receives an explicit
**gap notice** ("you missed events since seq X — re-list your neighborhood"), never
silence. Additionally: **unexpired addressed entries** (surprises targeted at agents whose
claims are still active) are compaction-protected; claim TTL bounds that pinning, so an
abandoned claim cannot pin the log forever.

**(b) Writer-owned LWW versions.** The LWW reduction key for a claim is a **per-claim
monotonic version owned by the WRITER and echoed through every publish** — never a
receiver-assigned arrival seq. Remote flush drops an entry when the store already holds a
HIGHER version for the same `claim_id`. This fixes two LIVE defects: (1)
`remote-store.ts mergeRemotePeers` merges local and remote views by arrival order, so a
stale remote copy of my own claim can shadow my newer local state; (2) the retry queue can
resurrect a stale entry over a newer one after an outage (retry-queue stale-resurrection).
Receiver arrival seq remains what cursors iterate — it orders the LOG; the writer version
orders each CLAIM's truth.

**(c) Durable remote-sync cursor.** Remote sync becomes "publish everything after my last
ACKED local-log seq": a durable cursor over the local log, persisted beside it, resumable
across restarts and outages — replacing the in-memory capped retry queue for coordination
entries. An outage longer than any queue cap now loses nothing; combined with (b),
replays are idempotent (same writer versions ⇒ drops).

### 7.3 Scale note
Durability itself is O(append). The cursor/epoch/version shapes are fixed here precisely
so that sharding, if ever demanded (Appendix A), changes storage layout only — never
the protocol.

### 7.4 Deployment constraint (stated, not implied)
The board's writer model is **single-writer-per-board**: exactly one process appends to a
given board's log. Read scale-out is permitted via **log-tailing SSE replicas** (readers
tail the same log; they never append). Enforcement: the writer holds the board lockfile
with **heartbeat-while-held**, and the stale-takeover time is much greater than the
heartbeat interval (no near-miss takeovers); **epoch minting is atomic under the workspace
lock** (two racing first-writers cannot mint two epochs for one board).

**Effort: S** for 7.1 (the defect fix); **S–M** for 7.2 (a/b/c are small in code, large in
care — see §14's failure-injection list). **Deps:** none. **Wave 1, before everything
else in this spec.**

## 8. Upgrade 6 — Transitive conceptual awareness (bounded, advisory)

### Verified current state
Blast-radius awareness is ONE HOP everywhere: collision.ts `detectBlastIntersections`
(neighbors via a full edge scan per symbol), arbiter.ts (one-hop neighbor union),
partitioner.ts (one hop over `calls` edges; its own header names the per-call edge scans as
the exhaustive-scan defect class). One hop misses real contract propagation: A edits a util
three calls beneath B's handler; no current detector connects them.

The replacement substrate is in-flight on a concurrent lane:
`packages/analyzer-core/.../reachability-index.ts` (SPEC-MATHEMATICAL-INTELLIGENCE
Workstream C): Tarjan SCC → condensation DAG → pruned 2-hop landmark labels; persisted on
the CAS as `CASReachabilityIndex`; `affectedSet(seeds, {direction, maxNodes, maxDepth})` in
O(answer). Its options were designed for this consumer (`direction:'both'` is documented as
"the partitioner's footprint semantics").

### Micro + macro
- **Micro:** two participants in one file whose symbols connect through a call chain the
  file doesn't show get a labeled heads-up with hop distance — information, not a warning
  tone.
- **Macro:** lanes in different repos/directories whose blast radii meet through shared
  code learn it at claim time, which is exactly the class of edge `plan_parallel_work`
  already proved matters (it separated two path-disjoint tasks whose radii intersected —
  v3 §6.2).

### Design
Pure substitution + labeling, no new detector semantics:
- collision.ts detector 4, arbiter.ts blast overlap, and partitioner footprint expansion
  accept an optional rehydrated `ReachabilityIndex`; when present, footprint =
  `affectedSet(claim.symbols, {direction:'both', maxNodes: 200, maxDepth: 4})` (defaults;
  env-tunable) instead of the one-hop union. When absent, the one-hop path remains —
  graceful degradation, never a hard dep.
- **Neighborhood-scoped comparison, not all-pairs:** ambient checks compare MY expanded
  footprint against claims found via the scope index (symbols/paths in my footprint →
  claim_ids), O(N + H) per §2.3, hub-capped per §2.5. The all-pairs sweep remains only
  inside the planner over a bounded task list.
- Findings gain distance + bound metadata:

```ts
interface BlastIntersectionFinding {
  // ...existing fields...
  hops?: number;              // condensation-hop distance seed→intersection (1 = today)
  truncated?: boolean;        // the maxNodes/maxDepth bound cut the expansion
  via?: 'one-hop' | 'reachability-index';
}
```

- **Bounded and advisory by construction:** caps are advisory bounds (results flagged
  `truncated`, per the index's own API), findings rank nearest-first, and a transitive
  finding NEVER changes verdict semantics — one more labeled awareness row. Hop distance
  lets consumers (agents, the partitioner's soft layer, UI) weight it.

### Scale note
`affectedSet` is O(answer) with hard caps — independent of graph and fleet size. The
neighborhood-scoped comparison keeps per-participant checks off the O(F²) path. Unbounded
expansion is rejected (§9) not just as noise but as a scale violation: at 47k+ nodes an
unbounded 'both' closure approaches the whole graph and every pair of claims "intersects."

### MCP surface
No new tools. `check_collision` / `fab_check_collision` / `claim_work` awareness blocks and
`plan_parallel_work.conflict_edges` gain `hops`/`truncated`/`via` on blast-radius findings;
tool descriptions add one line (transitive, bounded, hop-labeled).

**Effort: M** (three call sites + scoped lookup + tests; the hard math ships with the index
lane). **Deps:** reachability-index lane landing (persisted index + a loader in the
mcp-server). Degrades to one-hop until then, so it can merge behind the dep safely.

---

## 9. Rejected / refined (and why)

Carried from v1.0:
- **REJECTED: making structured fields required, ever.** Free-text intent claims are the
  adoption path (v1 WS-E's lesson: if checking in isn't cheap, agents don't). Structured
  fields are optional-then-encouraged (§16), never validated-against — and v1.1 goes
  further: observation fills them in when agents don't (§3).
- **REJECTED: contract freeze / arbitration on `produces`.** A declared contract is a
  promise, not a lock. Firing a surprise at consumers on divergence is the ceiling;
  refusing the producer's divergent write is a lock in disguise (v3 §2, W8 reframe). The
  2026-07-20 proof point needed zero enforcement — declarations + honoring them sufficed.
- **REJECTED: a standalone subscription broker/queue service.** The append-only log with a
  monotonic seq already is an event log; lazy matching + per-reader cursors give
  at-least-once delivery with zero new infrastructure and zero write-time fan-out.
- **REJECTED: event-sourcing/DB rewrite for durability.** The 2026-07-21 wipe was a
  container pathing defect. The jsonl log is already the right persistence shape for both
  tiers; the fix is one env var + a board epoch. Rewriting storage to fix pathing would be
  safety theater at throughput's expense.
- **REJECTED: unbounded transitive expansion.** Noise AND a scale violation (§8).
- **REJECTED: any board-global scan as a per-participant primitive.** Full-board reads
  survive only as an explicitly-labeled, paginated convenience.
- **REFINED: "peers query declared contracts"** needs no new registry — the claims board
  already is the registry once claims carry `produces`.
- **REFINED: predictive footprint** is only "put the prediction on the claim record"; the
  check-time layer ships with the co-change lane.

New in v1.1 (cold-review outcomes):
- **CUT: `goal` + self-reported `phase` + status lifecycle + `set_phase`.** Self-reported
  state is a check-in tax and goes stale; phase is now derived from observation (§3).
- **CUT: the subscription registration step + interest taxonomy + digests + filtered SSE
  (v1).** The claim already encodes interest — a taxonomy re-describes it, a registration
  step doubles the tax, and digests/filtered-SSE are delivery optimizations without a
  demonstrated backlog problem. Deferred (Appendix B), not repurposed:
  `subscribe_workspace` keeps its current behavior.
- **CUT: cold outcome segments.** Speculative until a fleet exhausts the hot budget
  (Appendix B).
- **CUT: the `contracts_changed` enum on outcomes.** Double bookkeeping with §3; free text
  in `successor_notes` covers the remainder.
- **REJECTED: mutable-scope shard keys.** v1.0 sharded by path-prefix/concept — mutable
  claim attributes. An extend that changes scope would re-shard the claim and break the
  per-claim LWW total order (two shards each holding "the latest" entry). The shard key is
  the immutable `hash(claim_id)` (Appendix A).
- **REJECTED: receiver-assigned arrival order as the LWW key.** It makes merge outcomes
  dependent on network timing and is the root of two live defects (§7.2b).
- **REJECTED: "sharding when needed" as an unspecified promise.** The ops guard reports
  the per-board write rate that would evidence the need, and Appendix A fixes the two
  choices (shard key, cursor shape) that make it additive — no vapor, no program.

## 10. Anti-goals (standing, restating v3 doctrine for this engine)

- **Never locks.** No upgrade introduces, strengthens, or defaults to exclusivity. The
  enforced grant surface stays what it is: opt-in, rare, never the model.
- **Never permission-gates.** No fabric call may return "denied" for awareness or for work
  a participant needs. Event delivery filters what you're TOLD, never what you may SEE —
  subject only to §11's tenancy boundary, which is about WHO you are, not what you may do.
- **Never throughput sacrificed for safety theater.** Every field optional, every detector
  advisory, every bound tunable, every degradation graceful. A change that adds a required
  round-trip to the hot claim path is wrong by definition.
- **Never a scaling bottleneck.** No per-participant operation may cost O(fleet); the
  fabric must be ignorable (§2.4) so it can never block work at any scale.
- **Textual conflicts remain git's job.** Outcome commits link TO git; the board never
  replays diffs. Mergeless (v3 §5) is reached by awareness density, not by the fabric
  arbitrating text.

## 11. Security & tenancy

The board carries code-shaped payloads (signatures, diffs quoted in surprises, successor
notes) and addressed events. The boundary rules:

- **Addressed delivery requires identity.** An addressed event (surprise, drift notice) is
  deliverable only to an **authenticated principal matching the subscriber `agent_id`** —
  on the remote tier that means the request's auth principal must own the agent identity
  it drains for; on the local tier, OS user ownership of the store directory is the
  boundary (today's model, unchanged).
- **Tenancy on every entry.** All NEW entry kinds (`outcome`, and any future kind) carry
  `org_id`, and every read/drain/query path filters by it — a board hosted for multiple
  orgs must be incapable of cross-tenant awareness leakage even if workspace ids collide.
- **Redaction.** `security.ts` redaction applies to outcome and surprise payloads before
  storage and before delivery — the same policy the analysis pipeline already applies to
  code-derived text.

## 12. Clock semantics

TTL and retention arithmetic must not trust N distributed clocks:

- **All TTL/retention/expiry arithmetic runs on the store host's clock** (the machine that
  owns the board file). Local tier: the machine itself. Remote tier: the server.
- **The server overwrites `heartbeat_at` with its own receive time** on every remote
  publish — a client with a skewed clock cannot publish a heartbeat from the future (never
  expires) or the past (instantly stale).
- **Bounded-skew assumption, stated:** client-supplied timestamps (`created_at` on
  entries) are display metadata only, assumed within ordinary NTP skew; nothing
  correctness-bearing compares a client timestamp against a server deadline.

## 13. Topology & attribution soundness

Ambient capture diffs A WORKING TREE. Attribution ("agent X changed contract Y") is only
sound when each participant has its own tree:

- **Micro-parallel attribution requires per-participant working trees** (worktrees,
  clones, or machines) **until the v3 W0 substrate lands** (the virtual per-agent overlay).
  This spec's auto-derivation (§3) and drift detection attribute observed changes to the
  claim whose tree produced the snapshot — with a shared tree, two agents' edits are one
  diff and attribution is fiction.
- **Shared-tree fleets get awareness minus attribution:** the board still shows claims,
  footprint overlap, unclaimed-edit events, and outcomes; observed `produces`/`consumes`
  auto-lifting and per-agent drift blame are disabled (the capture layer detects a shared
  tree by claim/agent multiplicity per tree root and degrades per §2.4 — less awareness,
  never wrong awareness).
- **W5 (write-hook) is the event-drain carrier for low-chatter agents:** an agent that
  edits but rarely calls fabric tools would drain events only at claim/heartbeat. The v3
  W5 write-hook, when it lands, piggybacks the §5 drain on the hook's ambient capture
  ping — bounding surprise-delivery latency by edit cadence instead of tool-call cadence.
  Referenced in the build order (§15), not a dependency.

## 14. Engineering hygiene (board robustness — build-order line items)

- **Per-entry size caps:** every appended entry is capped (default 64KB; signatures/notes
  truncated with a marker) — one pathological claim must not dominate the log or any
  response.
- **Per-agent write-rate note:** the store tracks writes/agent/minute; a runaway agent
  (claim-spam loop) is surfaced in `fab_list_active_work` and doctor output as a warning —
  advisory like everything else, but visible.
- **Self-observability counters:** the engine counts and exposes (doctor + `/v1/health`
  detail): drain latency (append→delivered), eviction/gap-notice counts (§7.2a floor
  hits), compaction stats (entries in/out, duration), per-line **checksums with a
  `corrupt_lines` counter** — a torn or bit-rotted line is skipped and COUNTED, never
  silently absorbed.
- **Failure-injection test list (wave 1 exit criteria):**
  1. kill -9 during compaction's atomic rename — board intact, either old or new state,
     never mixed;
  2. crash between log append and scope-index update — index rebuild converges, no
     phantom/missing claims;
  3. epoch race — two first-writers on an empty board mint exactly one epoch (§7.4);
  4. remote outage + resume — durable cursor (§7.2c) replays; writer versions (§7.2b)
     drop every stale entry; no resurrection;
  5. backup-restore rollback — cursor > max_seq detected, client resets, gap notice
     delivered (§2.1/§7.1.2).

## 15. Ranked build order

| Wave | Contents | Effort | Hard deps | Why this rank |
|---|---|---|---|---|
| **1** | §7.1 durable-board fix (pathing, epoch, `{epoch,seq}` cursor + max_seq reset, boot sweep, ops guard) + §7.2a/b/c protocol blockers + §7.4 deployment constraint + the `fab_release_work` `released_count:0` defect + §14 hygiene counters & failure-injection suite | S–M | none | Everything else writes to the board; the blockers are WIRE SHAPES that can never change once clients exist. The release defect is §4's precondition. |
| **2** | §3 reduced structured intent (`produces`/`consumes`) + auto-derivation + drift detector + §5 claim-scoped event drain (`events` block) | M | wave 1 (epoch, delivery floor) | The highest-value primitive (proven manually 2026-07-20) plus its delivery path, landing together so surprises are heard, not just filed. §13's tree check gates auto-attribution. |
| **3** | §4 outcome records (reduced) + `fab_recent_outcomes` + onboarding block + `COMPACT_KEEP_OUTCOMES` | S | waves 1–2 | Cheap once the board is durable and the release path is truthful; closes §3's loop via released claims' `produces`. |
| **4** | §8 transitive awareness | M | reachability-index lane | Pure substitution at three call sites; merges safely behind the dep (degrades to one-hop). |
| **5** | §6 predictive on-claim | S | co-change lane | Smallest delta; most of it ships with the concurrent lane — last to avoid stepping on it. |

W5 (write-hook drain carrier, §13) attaches to wave 2's drain when the v3 W5 lane lands —
tracked there, built here only as the piggyback point. Sharding (Appendix A) is not on any
wave.

## 16. Migration

- **Free-text claims keep working forever.** Every new field is optional; every reader
  treats absence exactly as today (the `ClaimLogEntry.kind` pattern — unknown kind = plain
  claim — is the precedent and the rule for all new entry kinds: `outcome`). Old logs parse
  unchanged; old clients ignore new response fields.
- **Optional → encouraged → observed.** Tool descriptions present `produces`/`consumes` as
  the high-signal path ("declare your exports; peers build against them immediately");
  responses to bare free-text claims include a one-line nudge when the workspace has other
  active participants. Never an error, never a required field, no deprecation of `intent` —
  and §3's auto-derivation means an agent that ignores all of it still populates the board.
- **Wire compatibility:** `/v1/coordination/*` accepts and returns new fields additively.
  `epoch`, `min_retained_seq`, writer versions, and the `events` block are new response
  fields old pollers ignore (keeping today's behavior — including today's reset
  blindness — until they adopt them). Cursors are `{epoch, seq}` from day one in new
  surfaces; Appendix A's vector form is a widening of the same shape.
- **Compaction compatibility:** new entry kinds carry `status:'released'` so pre-upgrade
  compaction code that only preserves active claims + a released tail cannot resurrect
  them as active work; post-upgrade compaction adds the outcome retention budget and the
  §7.2a delivery floor.

---

## Appendix A — Sharding (a short note, not a program)

The implementation ships single-shard (§2.1). If write volume ever demands sharding —
sustained per-board write rate, as measured by the §7.1.4 ops guard, actually making the
single lockfile-serialized log the bottleneck — it lands additively: the shard key is the
**immutable `hash(claim_id)`** (never mutable scope — a mutable key would re-shard a live
claim and break the per-claim LWW total order), so every entry for one claim lives in one
shard forever, and the `{epoch, seq}` cursor widens to `{epoch, {shard: seq}}`, with
single-shard boards degenerating to the scalar form wave-1 clients already speak. Nothing
else changes: writer-owned LWW versions (§7.2b), the delivery floor (§7.2a), epochs,
tenancy (§11), and clock semantics (§12) are per-entry/per-claim properties untouched by
layout. Scope-based routing of reads stays in the scope index
(paths/contracts/concepts → claim_ids → shards).

## Appendix B — DEFERRED (explicitly not in scope; do NOT build these)

Cold readers: the following appeared in v1.0 or in review discussion and are consciously
deferred, not forgotten. Building them now is scope creep.

- **Interest taxonomy + subscription registration** (v1.0 §5's `kind:'subscription'`
  entries and five interest variants) — superseded by claim-scoped delivery (§5). Revisit
  only if a real fleet demonstrates interest shapes a claim footprint cannot express.
- **Digest overflow** — the strict cap + `resume_seq` + truncated flag covers bursts;
  digests are an optimization for a backlog problem not yet observed.
- **Filtered per-subscriber SSE** — remote SSE remains the unfiltered firehose plus
  log-tailing replicas (§7.4). Per-subscriber filtering rides the same lazy matcher when
  push-capable clients materialize.
- **Cold outcome segments** (`outcomes-<epoch-range>.jsonl`) — until a fleet exhausts
  `COMPACT_KEEP_OUTCOMES`, git is the deep history.
- **Sharded layout** — Appendix A: a short additive note, built only if write volume ever
  demands it.
