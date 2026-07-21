# SPEC — Coordination Engine (Fabric v3 upgrade set)

> **Status:** SPEC, ready to build. Companion to
> [SPEC-COORDINATION-FABRIC-V3.md](./SPEC-COORDINATION-FABRIC-V3.md) (the authoritative
> framing: the free flow of work) and [SPEC-COORDINATION-FABRIC.md](./SPEC-COORDINATION-FABRIC.md)
> (v1, the historical build record). Where this spec and v3 §0 disagree, v3 §0 wins.
> Written self-contained: §0.2 defines every term; no session context is assumed.

---

## 0. Goal — the free flow of micro- AND macro-parallel work, at unbounded scale

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
unbounded scale possible at all:** a fabric that must be consulted before a write is a
serialization point and a single point of failure that grows with the fleet; a fabric that
only ever adds awareness can be ignored, sampled, or read lazily, so its cost is always
opt-in and its failure mode is "less awareness," never "no work." A participant that
ignores the fabric entirely is still safe — git remains the merge authority; the fabric
removes nothing and gates nothing (see §2.4).

### 0.1 The scale mandate — scale-free, no ceiling

The engine must support 2, 5, 10, 100, 1,000, 10,000 parallel participants on one
workspace — and those magnitudes are **illustrative checkpoints, not a ceiling. The
requirement is unbounded.** Design consequences:

- No hardcoded fleet-size caps anywhere.
- No data structure or protocol whose cost **for a single participant's operation** is
  linear in total fleet size.
- No assumption that the fleet fits in one process's memory or that the board fits in one
  page/read.
- **The scaling law for every surface** (stated per-surface in §2.3): a participant's
  operation cost depends on its own **scope/relevance neighborhood** — the claims, events,
  and contracts that overlap what it is doing — never on how many other participants exist.

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
  LWW-reduced per `claim_id` by monotonic `seq`, with entry kinds beyond plain claims
  (`unclaimed-edit`, `surprise`) that are always `status:'released'` (pure events, never
  active claims). Two tiers: LOCAL (same machine, file-backed) and REMOTE (a server hosting
  the same store for cross-machine fleets).
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
blast-radius-aware partitioner. Six upgrades turn the board into a coordination ENGINE — a
shared narrative of what the fleet is building, has built, and is about to touch:

1. **Structured intent** (§3) — claims declare `goal`, `phase`, and above all **`produces`**
   / **`consumes`** contracts; in-flight contract reuse becomes first-class (peers build
   against declared-but-unfinished exports; divergence auto-fires a surprise to consumers).
   Serves micro (a peer in the same file builds against your in-flight signature) and macro
   (a lane consumes another lane's not-yet-shipped API).
2. **Outcome records on release** (§4) — release carries commits, contracts changed,
   successor notes; the board becomes an append-only narrative queryable by arriving agents.
3. **Subscriptions** (§5) — registered interest + event-driven delivery (inbox drained on
   any fabric call for polling agents; filtered SSE for push-capable ones), with lazy
   read-time matching and digests so cost never scales with fleet size.
4. **Predictive footprint** (§6) — claims carry co-change-predicted paths with
   probabilities, advisory-labeled (check-time layer largely SHIPPED in a concurrent lane;
   this puts the prediction ON the claim record).
5. **Durable board** (§7) — coordination state survives server restarts (open defect
   diagnosed: the remote tier's log lives on the container's ephemeral filesystem; fix is
   pathing + a board epoch), plus the sharding shape that keeps the board scale-free.
6. **Transitive conceptual awareness** (§8) — blast-radius expansion via the reachability
   index (bounded, hop-labeled, advisory), replacing one-hop edge scans, with
   neighborhood-scoped comparison instead of all-pairs.

Build order (§11): **5 → 1 → 2 → 3 → 6 → 4**. Durability and the scale-safe board shape
first — every other upgrade writes to the board.

Rejected along the way (§9): required structured fields, contract freezes or
arbitration-gating on produces/consumes, a standalone subscription broker, an
event-sourcing rewrite for durability, unbounded transitive expansion, and any
board-global scan on a per-participant operation.

---

## 2. Scale model (applies to every upgrade)

### 2.1 The board is partitioned by scope, and reads are scoped

Today `getActiveClaims(workspace)` parses the whole log — O(all claims) per read. Fine at
2–100 participants; wrong as a primitive at 1,000+ and forbidden by §0.1 as the ONLY read
path. The scale-free shape:

- **Sharded log.** `claims.jsonl` generalizes to `claims/<shard>.jsonl`, sharded by a
  stable hash of the claim's primary scope (path-prefix; concept id for path-less claims;
  agent_id as last resort). Single-shard = today's file, byte-compatible — small fleets
  never notice.
- **Derived scope index.** A compacted inverted index (path-prefix → claim_ids,
  contract-name → claim_ids, concept → claim_ids), rebuilt incrementally on append,
  persisted beside the shards. All neighborhood queries go through it.
- **Scoped reads are the default API.** `fab_list_active_work` gains `near?: {paths?,
  symbols?, contracts?, concepts?}` returning only the relevance neighborhood, paginated
  (`cursor`, `limit`). The unscoped full-board listing remains available (it is genuinely
  useful at small scale and for dashboards) but is paginated and explicitly documented as
  the non-scaling convenience form.
- **Per-shard seq + vector cursors.** `seq` today is board-global and assigned under one
  lockfile — a serialization point under high write contention. Ordering only ever needs to
  be monotonic **per shard**: seq becomes per-shard, and a sync cursor becomes a vector
  `{shard_id: seq}` (single-shard boards degenerate to today's single integer). This
  removes the global write lock and lets shards append concurrently.

### 2.2 Write path is O(own claim); matching is lazy

A claim/heartbeat/release append costs O(size of the entry) — never a board scan, never
write-time fan-out to subscribers. All matching (overlap, subscriptions, drift) is evaluated
at READ time against the reader's neighborhood via the scope index. Lazy read-time matching
is the single most important scale decision in this spec: it makes 10,000 writers cost the
same per-write as 2.

### 2.3 Scaling laws per surface (the contract each build must meet)

Let **F** = fleet size, **N** = participant's own footprint size, **H** = participant's
relevance neighborhood (claims/events overlapping its footprint), **K** = a small constant
(top-K caps), **E** = new events in the participant's subscribed scopes since its cursor.

| Surface | Cost law | Never |
|---|---|---|
| Claim / extend / heartbeat / release (write) | O(N) | O(F) |
| Board read, scoped (`near`) | O(H), paginated | O(F) |
| Overlap / collision check | O(N + H) | O(F²) all-pairs |
| Contract-board query (§3) | O(matching contracts) via index | full-log scan |
| Event drain (§5) | O(E), capped + digest | O(F) fan-out per event |
| Outcome query (§4) | O(limit) via index, retention-bounded | unbounded log growth |
| Predictive footprint (§6) | O(K) per claim at claim time | recompute per reader |
| Transitive blast radius (§8) | O(answer), bounded (maxNodes/maxDepth) | O(V+E) walk per query |

Collision detectors today (collision.ts) compare all active claims pairwise — O(F²). That
is acceptable inside `plan_parallel_work` over a TASK list (bounded input, one planner) but
must not be the shape of ambient per-participant checks: those compare MY footprint against
MY neighborhood (via the scope index), O(N + H).

The magnitudes as illustrative checkpoints: at 2–10 participants everything above collapses
to today's single-file board and nothing changes; at 100, scoped reads and pagination start
mattering; at 1,000, per-shard seq and lazy matching are load-bearing; at 10,000, digests
(§5) and retention (§4) are; beyond that, nothing new breaks because no per-participant
cost referenced F in the first place.

### 2.4 Graceful degradation is a scale feature

Every surface degrades toward "less awareness," never "less work": no reachability index →
one-hop; no co-change index → no predictions; no subscription → no events block; fabric
unreachable → work proceeds, git merges. A participant that never calls the fabric is
exactly as safe as git makes everyone today. The engine therefore can never become the
bottleneck that blocks work — which is precisely why it may be allowed near an unbounded
fleet.

---

Every upgrade below was verified against the current implementation
(`apps/mcp-server/src/coordination/*`, `context-fabric.ts`, `server.ts` fab_* tools,
`remote-analyzer-service.ts` `/v1/coordination/*`) on 2026-07-21. Per-upgrade: verified
current state, micro/macro framing, schema sketch, MCP surface, scale note, effort class
(S/M/L), dependencies.

## 3. Upgrade 1 — Structured intent: `goal`, `phase`, `produces`, `consumes`

### Verified current state
`WorkClaim` carries free-text `intent`, `scope.paths/symbols`, optional `scope.capability`
and `scope.concept` (capability/flow/step/entities, declared or derived). No goal/phase, and
no way to DECLARE a contract the lane will create. Contracts appear only as OBSERVATIONS:
`InFlightSnapshot.touched.contracts` feeds collision.ts detector 3 (drift). Surprise events
exist (`ClaimLogEntry.kind:'surprise'`, local-store.ts) but fire only from
`plan_intent_merge` at reconciliation time — after the fact, not while a consumer is still
building.

### Micro + macro
- **Macro (the proof point):** the 2026-07-20 UI rebuild ran in-flight contract reuse
  MANUALLY — lanes stubbed against exports a scaffold lane had merely declared (names +
  signatures, not yet written); the scaffold honored every declared signature; integration
  required zero rework. The declarations lived in prompts and handoff prose; the fabric
  carried none of it. This upgrade makes that pattern a fabric primitive: a lane consumes
  another lane's not-yet-shipped API, visibly.
- **Micro:** two participants in one file — A declares `produces: getUser(): User` while
  still writing it; B, editing a caller three functions down in the same file, records
  `consumes: getUser` and builds against the declared signature immediately instead of
  guessing or waiting. If A's ambient diff then diverges from the declaration, B gets a
  surprise while both changes are still soft.

### Schema (additive, all optional)

```ts
/** A contract this lane WILL create or change — declared before it exists. */
interface DeclaredContract {
  kind: 'export' | 'signature' | 'endpoint' | 'type' | 'event' | 'schema';
  name: string;               // "buildOutcomeRecord", "GET /v1/coordination/outcomes"
  signature?: string;         // legible: "(ws: string, opts?: {limit}) => OutcomeRecord[]"
  path?: string;              // where it will live
  status: 'declared' | 'draft' | 'stable';   // lane updates as it firms up
  notes?: string;             // semantics a signature can't carry ("throws on empty ws")
}

interface WorkClaim {
  // ...existing fields unchanged...
  goal?: string;              // the outcome, distinct from intent's activity narration
  phase?: 'exploring' | 'building' | 'verifying' | 'landing';
  produces?: DeclaredContract[];
  consumes?: Array<{ name: string; from_agent?: string; declared?: boolean }>;
}
```

- `produces` reuses the interface-signature vocabulary the analysis already speaks
  (`get_interface_signature`, ICELOT contracts) — no new contract syntax. `signature` is a
  string on purpose: agents write and read it; the deterministic comparator works on the
  ambient-captured `SymbolChange[]`, not on parsing this string.
- `consumes.declared = true` marks "I am building against a contract that does not exist in
  committed code yet" — the in-flight reuse case, now a visible dependency edge between two
  in-flight lanes.

### Behavior: in-flight contract reuse, first-class
1. **Query declared-but-unfinished contracts.** `fab_list_active_work({contracts: true,
   near?})` returns the declared-contract board (who is producing what, in which status),
   served from the contract-name index (§2.1) — no new tool.
2. **Build against them.** A peer stubs against a `declared` contract and records the
   `consumes` edge on its own claim.
3. **Divergence auto-fires a surprise.** New pure detector
   `detectDeclaredContractDrift(myClaim, neighborhoodClaims, snapshots)` in collision.ts:
   when a producer's observed `SymbolChange[]` disagrees with its declaration
   (signature/return/nullability/param via the existing `SymbolChangeKind` machinery), or
   the producer releases without producing, append `kind:'surprise'` entries addressed to
   each consumer — `SurpriseDetail` gains `contract?: string` and
   `reason: 'declared_contract_drift' | 'declared_contract_missing'`. Delivery rides §5's
   inbox (works today via `fab_list_active_work(agent_id)`). Advisory: the consumer decides.

### MCP surface
- `fab_claim_work` / `fab_extend` / `/v1/coordination/claim` (advisory mode) gain `goal`,
  `phase`, `produces`, `consumes`. `fab_extend` also accepts `set_phase` and `add_produces`
  (promoting a contract declared→draft→stable is an extend, preserving claim identity).
- Tool descriptions teach: "declare what you will export before you write it; peers build
  against it immediately."

### Scale note
Declaration cost O(own contracts); consumer lookup O(matching contracts) via the
contract-name index; drift detection compares one producer's diff against ITS consumers
(edges recorded on claims), never all claims. Cheap enough for micro (declaring one
signature is one field on a claim you were making anyway); the index keeps macro lookup
flat as lanes multiply.

**Effort: M** (types + passthrough S; drift detector + tests M).
**Deps:** none hard; richer delivery with §5.

## 4. Upgrade 2 — Outcome records on release

### Verified current state
Release is amnesiac: `fab_release_work` / `releaseAgentWithReason` flip `status:'released'`
and nothing else — no commit hashes, no successor notes. Compaction keeps a bounded tail of
released entries (`COMPACT_KEEP_RELEASED = 50`), so even those vanish. An arriving agent
cannot ask "what just landed here and what should I know?" — that lives in handoff prose,
off-board.

### Micro + macro
- **Macro:** an arriving lane reads the recent narrative — what landed, which contracts
  moved, what the releasing lane left for successors — instead of re-deriving it from git
  log + prose.
- **Micro:** a participant finishing a same-file stint records "renamed X→Y, callers in
  this file updated, the one in `other.ts` is NOT" — the next participant in that file sees
  it on arrival (via §5 `outcome_recorded` interest or the scoped outcome query).

### Schema

```ts
/** New ClaimLogEntry kind, following the 'unclaimed-edit'/'surprise' pattern:
 *  always status:'released', never picked up as an active claim. */
interface OutcomeDetail {
  claim_id: string;           // the claim this outcome closes
  outcome: 'done' | 'partial' | 'abandoned' | 'handoff';
  commits?: string[];         // hashes landed (may be empty for docs/abandoned)
  contracts_changed?: Array<{ name: string; change: 'added' | 'changed' | 'removed' }>;
  successor_notes?: string;   // "the X path is stubbed; Y still needs a bench"
}
// ClaimLogEntry.kind gains 'outcome'; ClaimLogEntry.outcome?: OutcomeDetail
```

`contracts_changed` closes §3's loop: a released claim's `produces` entries get their final
disposition on the record.

### Retention (the scale answer to an append-only narrative)
- Outcomes get their own retention budget (`COMPACT_KEEP_OUTCOMES`, default 200 per shard)
  separate from plain released-claim churn — the narrative is the point; bookkeeping must
  not evict it.
- Beyond the hot budget, compaction rolls outcomes into cold segments
  (`outcomes-<epoch-range>.jsonl`), queryable but never loaded on the hot path. The board
  stays a RECENT narrative; git is the deep history (outcomes link to it via `commits`).
  Growth is therefore bounded per shard regardless of fleet size or age.

### MCP surface
- `fab_release_work` gains optional `outcome`, `commits`, `contracts_changed`,
  `successor_notes`; omitting them all = today's behavior exactly.
- New read: `fab_recent_outcomes({ workspace, limit?, paths? })` — most-recent-first,
  path-scoped via the index. Folded into arriving-agent onboarding
  (`get_agent_start_context` / `get_workspace_agent_context` gain a `recent_outcomes`
  block) so new lanes see the narrative without knowing to ask.
- `/v1/coordination/release` mirrors the fields; `/v1/coordination/state` includes outcomes
  past the cursor.

### Scale note
Write O(1); scoped query O(limit) via the path index; growth bounded by per-shard retention
+ cold roll-off. At 10,000 participants the hot narrative per scope stays constant-size;
only cold segments grow, off the hot path.

**Effort: S–M.** **Deps:** §7 (a narrative on an ephemeral board is pointless).

## 5. Upgrade 3 — Subscriptions: registered interest, event-driven delivery

### Verified current state
Three delivery mechanisms exist, none general: `subscribe_workspace` is an honest stub
(arms an fs-watch for 250ms, tells the caller to poll — MCP stdio has no server push);
surprises are ADDRESSED events but delivered only when the agent happens to call
`fab_list_active_work(agent_id)`; remote SSE (`/v1/coordination/stream`) pushes ALL
workspace deltas, unfiltered. The pieces of an event system exist — an append-only log with
a monotonic cursor, addressed entries, an SSE channel — but no registered interest and no
systematic drain.

### Micro + macro
- **Macro:** a lane consuming another lane's declared API registers interest in that
  contract and that lane's release — and hears about drift or landing without polling.
- **Micro:** many small claims must not mean many small notifications. A same-file
  participant's interests are narrow (this file, these symbols) and delivery piggybacks on
  calls it was already making — zero additional round-trips, and digests coalesce bursts.

### Design

**Registration is a log entry** (no new store): `ClaimLogEntry.kind:'subscription'`,
`status:'released'`, fields:

```ts
interface SubscriptionDetail {
  subscriber: string;                 // agent_id
  interests: Array<
    | { on: 'claim_released'; agent_id?: string; paths?: string[] }
    | { on: 'path_changed'; paths: string[] }          // claims/unclaimed-edits touching these
    | { on: 'contract_changed'; names?: string[] }     // declared-contract drift/status (§3)
    | { on: 'phase_transition'; agent_id?: string }    // e.g. producer hits 'verifying'
    | { on: 'outcome_recorded'; paths?: string[] }     // §4
  >;
  expires_at: string;                 // subscriptions TTL like claims; renew to keep
}
```

**Matching is lazy and read-time:** a pure `matchEvents(entriesSinceCursor, subscription)`
evaluated against the subscriber's shards when the subscriber reads — NOT a broker
maintaining queues, NOT write-time fan-out. The log is the queue; the subscriber's vector
cursor (§2.1) is the offset. At-least-once, idempotent by (shard, seq).

**Delivery, two modes, one substrate:**
- **Polling agents (the common case): inbox drained on any fabric call.** Every fab_* and
  coordination tool response gains an optional `events` block: entries since the caller's
  cursor matching its interests, capped (default 10) with **digest overflow** — when the
  backlog exceeds the cap, the block carries the top entries plus a digest line per interest
  (`{on, count, latest_seq}`) instead of the full list. An agent that heartbeats/claims/
  checks anyway gets its events for free.
- **Push-capable agents:** `/v1/coordination/stream?subscriber=<agent_id>` — the SSE
  handler runs the same matcher per delta, **batched** (deltas coalesced per subscriber per
  flush interval, default 1s) so an event burst reaches each subscriber as one frame.

`subscribe_workspace` is upgraded in place: it becomes the registration call (`interests`,
`ttl_ms`), returns the current cursor + board epoch, and documents the drain-on-any-call
contract. No new tool name burned.

### Scale note
Zero write-time fan-out cost is the whole design: an event append costs the same whether 0
or 100,000 subscriptions exist, because matching happens at each subscriber's read, scoped
to that subscriber's shards — O(E) per drain. SSE fan-out is bounded by connected push
clients only, batched. Digests keep worst-case response size constant. This is the
mechanism §2.3's event-drain law demands.

### MCP surface
- `subscribe_workspace({ workspace, agent_id, interests, ttl_ms? })` → `{ cursor, epoch }`.
- `events` block piggybacked on `fab_claim_work` / `fab_extend` / `fab_check_collision` /
  `fab_list_active_work` / `fab_release_work` / `check_collision` /
  `check_conceptual_conflicts` responses when the caller has a live subscription.
- `/v1/coordination/stream?subscriber=` filtered, batched SSE.

**Effort: M** (matcher + cursor S; drain wiring across tool responses M; SSE filter S).
**Deps:** §7 (cursors over a log that resets are broken — board epoch); §3/§4 define the
richest event kinds, but `claim_released`/`path_changed` work day one.

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
+ probability so a peer can weigh and ignore freely.

### Scale note
O(K) per claim at claim time; readers pay nothing extra. Prediction becomes indexable
scope (the predicted paths join the claim's entry in the path-prefix index, labeled), so
neighborhood queries see probable convergence without any reader-side recompute.

### MCP surface
No new tools. `fab_claim_work`/`fab_extend` responses and `fab_list_active_work` entries
carry `predicted_paths`; `fab_check_collision` reports predicted overlap via
`computeAdvisoryOverlap` once that lane lands.

**Effort: S** (a claim-time call + one field). **Deps:** the co-change lane landing.
Coordinate through the fabric; do not duplicate its thresholds.

## 7. Upgrade 5 — Durable board (fix the restart wipe; the scale-safe board shape)

### Verified current state + defect diagnosis (2026-07-21 incident)
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

### Fix specification
1. **Pathing:** set `KLAURO_COORD_DIR=/data/coordination` in the api service environment
   (compose). One line; zero store-code changes. (docker-compose.yml is currently modified
   by a concurrent lane — coordinate the edit through the fabric or land it with that
   lane's change.)
2. **Board epoch:** the store writes `board.json` `{ epoch: <uuid>, created_at }` beside the
   log on first creation. Every `/v1/coordination/state`/`active`/SSE payload and every
   fab_* response carries `epoch`. A client whose stored cursor belongs to a different
   epoch resets to 0 instead of silently missing everything. Also protects the LOCAL tier
   against manual store deletion. (§5's cursors require this.)
3. **Boot sweep:** the normal TTL/heartbeat expiry already marks stale claims expired on
   first read after restart — verify with a test; no new mechanism.
4. **Sharding shape (the §2.1 board):** the durable layout generalizes to
   `claims/<shard>.jsonl` + the derived scope index + per-shard seq, with the single-shard
   case byte-compatible with today. Cursors are `{epoch, {shard: seq}}` from day one in the
   new surfaces so growing shard count never changes the protocol.
5. **Ops guard:** `klauro doctor` checks that a containerized server's coordination dir is
   on a mount; deploy smoke asserts a claim made pre-deploy is listable post-deploy.

### Scale note
Durability itself is O(append). Sharding removes the last global lock (seq) and bounds
every read to the shards a query touches. Nothing in the layout references fleet size.

**Effort: S** for 1–3 + 5 (the defect fix); **M** for 4 (sharding, which may ship with or
after §3–§5 as write volume warrants — the protocol shape lands first so it never changes).
**Deps:** none. **Do 1–3 first, before everything else in this spec.**

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
  claim_ids), O(N + H) per §2.3. The all-pairs sweep remains only inside the planner over a
  bounded task list.
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

- **REJECTED: making `goal`/`phase`/`produces`/`consumes` required, ever.** Free-text
  intent claims are the adoption path (v1 WS-E's lesson: if checking in isn't cheap, agents
  don't). Structured fields are optional-then-encouraged (§12), never validated-against.
- **REJECTED: contract freeze / arbitration on `produces`.** A declared contract is a
  promise, not a lock. Firing a surprise at consumers on divergence is the ceiling;
  refusing the producer's divergent write is a lock in disguise (v3 §2, W8 reframe). The
  2026-07-20 proof point needed zero enforcement — declarations + honoring them sufficed.
- **REJECTED: a standalone subscription broker/queue service.** The append-only log with
  monotonic per-shard seq already is an event log; lazy matching + per-subscriber cursors
  give at-least-once delivery with zero new infrastructure, zero write-time fan-out, and
  no state store whose size tracks fleet size.
- **REJECTED: event-sourcing/DB rewrite for durability.** The 2026-07-21 wipe was a
  container pathing defect. The jsonl log is already the right persistence shape for both
  tiers; the fix is one env var + a board epoch. Rewriting storage to fix pathing would be
  safety theater at throughput's expense.
- **REJECTED: unbounded transitive expansion.** Noise AND a scale violation (§8). Bounds +
  hop labels keep the signal weighable.
- **REJECTED: any board-global scan as a per-participant primitive.** Full-board reads
  survive only as an explicitly-labeled, paginated convenience; every ambient surface goes
  through scoped/indexed queries (§2).
- **REFINED: "peers query declared-but-unfinished contracts"** needs no new registry — the
  claims board already is the registry once claims carry `produces`; an indexed filter on
  `fab_list_active_work` suffices.
- **REFINED: predictive footprint** is not greenfield — the co-change lane already shipped
  the check-time layer (in-flight). §6 is only "put the prediction on the claim record";
  more would duplicate a concurrent lane's work.

## 10. Anti-goals (standing, restating v3 doctrine for this engine)

- **Never locks.** No upgrade introduces, strengthens, or defaults to exclusivity. The
  enforced grant surface stays what it is: opt-in, rare, never the model.
- **Never permission-gates.** No fabric call may return "denied" for awareness or for work
  a participant needs. Subscriptions filter what you're TOLD, never what you may SEE.
- **Never throughput sacrificed for safety theater.** Every field optional, every detector
  advisory, every bound tunable, every degradation graceful. A change that adds a required
  round-trip to the hot claim path is wrong by definition.
- **Never a scaling bottleneck.** No per-participant operation may cost O(fleet); the
  fabric must be ignorable (§2.4) so it can never block work at any scale.
- **Textual conflicts remain git's job.** Outcome commits link TO git; the board never
  replays diffs. Mergeless (v3 §5) is reached by awareness density, not by the fabric
  arbitrating text.

## 11. Ranked build order

| # | Upgrade | Effort | Hard deps | Why this rank |
|---|---|---|---|---|
| 1 | **§7 — Durable board** (defect fix + epoch; sharding shape) | S (+M) | none | Everything else writes to the board; a board that wipes makes them all worthless. Unblocks cursors (§5) and narrative (§4). Fix is one env var + epoch; the sharded protocol shape lands with it so it never changes later. |
| 2 | **§3 — Structured intent (produces/consumes)** | M | none | The highest-value new primitive; proven manually 2026-07-20 at macro scale, same mechanism serves micro. Defines the contract vocabulary §4/§5 reference. |
| 3 | **§4 — Outcome records** | S–M | §7 | Cheap once the board is durable; closes §3's loop (`contracts_changed`); immediately useful to every arriving lane. |
| 4 | **§5 — Subscriptions** | M | §7 (epoch) | Delivery layer for §3's surprises and §4's outcomes; drain-on-any-call needs stable cursors. |
| 5 | **§8 — Transitive awareness** | M | reachability-index lane | Pure substitution at three call sites; merges safely behind the dep (degrades to one-hop). |
| 6 | **§6 — Predictive on-claim** | S | co-change lane | Smallest delta; most of it ships with the concurrent lane — rank last to avoid stepping on it. |

§7+§3+§4 are one coherent first wave (the board becomes durable, structured, and
narrative); §5 is the second; §8 and §6 land opportunistically as their substrate lanes
merge.

## 12. Migration

- **Free-text claims keep working forever.** Every new field is optional; every reader
  treats absence exactly as today (the `ClaimLogEntry.kind` pattern — unknown kind = plain
  claim — is the precedent and the rule for all new entry kinds: `outcome`,
  `subscription`). Old logs parse unchanged; old clients ignore new response fields.
- **Optional → encouraged, via teaching not validation.** Tool descriptions and server
  instructions present `goal`/`produces`/`consumes` as the high-signal path ("declare your
  exports; peers build against them immediately"); responses to bare free-text claims
  include a one-line nudge when the workspace has other active participants. Never an
  error, never a required field, no deprecation of `intent`.
- **Wire compatibility:** `/v1/coordination/*` accepts and returns new fields additively;
  `seq` semantics unchanged on single-shard boards; `epoch` and vector cursors are new
  response fields old pollers ignore (keeping today's behavior — including today's reset
  blindness — until they adopt them).
- **Scale is opt-in by growth, not by flag day:** single-shard boards are byte-compatible
  with today's files; sharding engages per workspace as write volume warrants, and because
  cursors are `{epoch, {shard: seq}}` from day one in new surfaces, shard count changes
  never change the protocol.
- **Compaction compatibility:** new entry kinds carry `status:'released'` so pre-upgrade
  compaction code that only preserves active claims + a released tail cannot resurrect
  them as active work; post-upgrade compaction adds the outcome retention budget + cold
  segments.
