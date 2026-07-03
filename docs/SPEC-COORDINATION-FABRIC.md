# Klauro — Master Build Spec: The Multi-Agent Coordination Fabric

> **Status: IMPLEMENTED (v1)** (local tier + MCP tools + routes live as of e1780f62, 2026-07-02). SSE/retry/security shipped; cross-machine sync + fleet scale are follow-ons.
>
> **Superseded by [[SPEC-COORDINATION-FABRIC-V2]] for the coordination MODEL.**
> This v1 doc's advisory `checkEditLock`/collision-detection framing, and its
> "enforced arbitration" framing in later planning, are both superseded by v2
> §1.7: the core model is **concurrent work + awareness + semantic
> reconciliation**, with locking/enforcement demoted to an OPT-IN tool for the
> rare genuine-exclusive case, not the default coordination mechanism. Kept
> here as the historical build record for WS-C through WS-K (still an accurate
> description of what was actually built at the time); read v2 for the current
> architecture and rationale.

> **Audience:** builder agents. This is the authoritative spec. Each Workstream (WS) is
> independently buildable, has a stated current state, files to touch, a contract, and
> acceptance criteria. Model-tier hints tell you where to use a cheap model.
> **Cardinal rules (do not violate):** deterministic structural facts first, AI as flavoring
> (never a hardcoded keyword categorizer); the gauntlet/tests are BLACKBOX clients of the
> product (never import the engine, never set a model/AI env); commit in chunks, concise
> messages, no co-author trailers; verify every analyzer THROUGH `analyzeForBench`, not just
> its unit test (a fixture needs a build manifest declaring the framework dep to dispatch).

---

## 0. Thesis (why we are building this)

Codebase intelligence is table stakes. Semantic understanding + capabilities differentiate.
WAS (workspace-level, cross-repo understanding) separates us further. **Telemetry fused into
the analysis** and **in-flight (uncommitted, cross-machine) change awareness** are the phase
change: they turn Klauro from "better context for one agent" into **the shared world-model and
coordination fabric for fleets of agents (and humans) working the same codebase at once.**

The expensive problems of multi-agent development — duplicate work, merge conflicts, stale
contracts, work stranded on a machine — are unsolved by every incumbent because they assume
*committed code, one actor*. Klauro's three-tracks (working/committed/incoming) + WAS +
telemetry is the substrate to solve them. That is a new category: **multi-agent development
coordination.** The understanding layers are the credibility and the on-ramp; the coordination
layer is the company.

**The artifact that proves it (and raises the round):** a live demo of N agents on one
workspace where Klauro PREVENTS a collision they'd otherwise hit (duplicate capability, or an
edit to a contract another agent is mid-flight against), because it sees working + committed +
incoming + runtime as one model. Build toward that demo.

---

## 1. Architecture — the five layers (compounding)

```
┌─ L5  COORDINATION FABRIC  (NET-NEW)  — claims, presence, conflict prevention, arbitration
├─ L4  IN-FLIGHT / CROSS-MACHINE       — working-tree + incoming work as first-class state
├─ L3  TELEMETRY FUSION                — runtime reality injected into the static model
├─ L2  WAS (workspace)                 — the whole product as one graph, cross-repo seams
└─ L1  CODEBASE INTELLIGENCE + SEMANTIC — CAS: structure + capabilities + comprehension
```

- **L1–L2 are built** (CAS + WAS). L3 is **scaffolded**. L4 read-side is **built**, write/sync is **partial/missing**. L5 is **greenfield.**
- Everything is exposed over MCP (the neutral, cross-vendor interface — a fleet of *any* agents
  coordinates through it). Keep it vendor-neutral; that neutrality is a structural moat the
  IDE incumbents cannot copy.

### 1.1 Two-tier coordination store (SAME-MACHINE + cross-machine) — architect for both

Multiple agents can share a codebase in two distinct topologies, and **same-machine is the more
common near-term case** (a dev running Claude Code + Cursor + Codex, or several sessions, against
one working tree). The coordination store MUST work at two tiers, composed:

- **LOCAL tier (same-machine).** All agents on one host share a local coordination store at
  `~/.klauro/coordination/<workspace_id>/` — an append-only claim/presence/intent log + a
  file-watch (or Unix-domain-socket daemon) for **sub-second local notification, zero network.**
  This is where same-machine peers see each other's claims, intents, and "why". It is authoritative
  for same-machine peers and a **write-through cache** to the remote tier.
- **REMOTE tier (cross-machine).** The VPS store (WS-C-transport SSE) syncs claims/presence/in-flight
  across machines. A claim writes to BOTH: local (instant, for same-host peers) and remote
  (propagate, for other machines). Reads merge the local active-set with the remote active-set.

**Why same-machine still needs coordination even though agents share the filesystem:** they see the
*code* on disk, but the filesystem carries **no intent, no reasoning, no "peer is mid-edit", and no
arbitration.** Three same-machine-specific hazards the local store must address:

1. **Silent clobber is WORSE same-machine.** One shared working tree → two agents save the same
   file → last-write-wins on disk, silently. (Cross-machine agents are isolated on branches/clones,
   so this is a same-machine-specific danger.) → **soft edit-locks:** an agent announces "editing
   `auth.ts`" to the local store *before* writing; peers `check_collision` and see the advisory lock;
   optional strict mode refuses the overlapping claim.
2. **No change attribution in a shared tree.** The working tree doesn't record *who* made an
   uncommitted change or *why*. The local store maps `agent_id ↔ touched_paths ↔ intent`, so a peer
   can ask "who changed this and what were they doing." In-flight for same-machine = **read the
   shared working tree directly (no diff sync needed) + attribute via the local store**; in-flight
   for cross-machine = sync the diff (WS-B remote).
3. **Speed.** Same-machine coordination must not pay a VPS round-trip — the local file-watch/socket
   gives ~1s peer awareness; the remote sync happens async in the background.

**Impact on the workstreams:** the PURE core (arbiter/collision, WS-C/WS-D) is **tier-agnostic** —
it operates on `WorkClaim[]`/`InFlightSnapshot[]` regardless of origin, so it is unchanged. The
two-tier split lives entirely in the **store/transport layer** (WS-B, WS-C-transport, WS-K) and in
a new `local-store.ts`. Build the local tier FIRST — it's simpler (no network, no WS-F cross-machine
privacy gate), it covers the most common case, and it de-risks the demo (N agents on one laptop).

---

## 2. Current-state matrix (grounded 2026-07-01)

| Capability | State | Anchor (extend, don't rebuild) |
|---|---|---|
| CAS structural + semantic + product map | ✅ built | `packages/analyzer-core` orchestrator; `apps/mcp-server/src/query.ts`; ~160 MCP tools |
| WAS cross-repo graph | ✅ built | `apps/mcp-server/src/cross-codebase-analysis.ts` (`buildCrossCodebaseSystemGraph`, application/integration links, `data_flow_paths`, `unmatched_interfaces`) |
| Three-tracks (main/other-branch/in-flight) — READ | ✅ built | `apps/mcp-server/src/track.ts`; track-keyed `storage.ts`; `POST /v1/analyze-diff` in `remote-analyzer-service.ts` |
| In-flight WORKING-TREE capture + cross-machine SYNC | ⚠️ partial | `remote-sync-client.ts`, `remote-source.ts` (`buildBranchDiffContext`); no multi-machine presence/merge |
| Telemetry ingest/correlate/SDK | ⚠️ scaffolded | `runtime-contract.ts`, `runtime-sdk.ts`, `telemetry-ingestion.ts`, `runtime-simulation.ts`; MCP `ingest_telemetry`, `record_runtime_event`, `correlate_runtime_event`, `get_runtime_*` |
| Telemetry FUSED into live CAS + always-on stream | ❌ missing | needs L3 build |
| Coordination: claims / presence / conflict prevention | ❌ greenfield | net-new (WS-C/D/E) |
| Distribution: install/update/release | ✅ built | `/install(.ps1)`, `/dist/*`, `klauro update`, `scripts/release.sh` (v1.0.2 live) |
| Moat: framework/lib/pattern analyzers | 🔄 in progress | `#91`; recipe proven; Compose slice landed |
| Proof on untuned real OSS + real competitors | ❌ missing | `#80` + Moderne/SCIP arms |
| Real-agent large-repo head-to-head | ❌ missing | `#96` autonomous trial exists on tiny repo only |

---

## 3. Workstreams

Each WS: **Goal · Why · Current · Build (files + contract) · Acceptance · Deps · Tier.**
Tier = suggested model: `haiku` (mechanical), `sonnet` (logic), `opus/careful` (protocol/consistency design).

---

### WS-C — Coordination Protocol: the WRITE side (THE NEW CORE)

**Goal.** A protocol + service by which agents *announce intent before acting* and Klauro
*arbitrates*, so duplicate work and conflicts are prevented, not just detected after the fact.

**Why.** Detection is easy; prevention needs the fleet to check in first. This is the crux of
the moat. Without it, Klauro is a nicer conflict reporter. With it, it's the coordination fabric.

**Current.** Greenfield (audit confirmed no claim/presence/lock code). Substrate = three-tracks.

**Build.**
- New module `apps/mcp-server/src/coordination/` with:
  - `claims.ts` — the claim store + arbitration. A **WorkClaim** = `{ claim_id, workspace_id,
    agent_id, agent_kind (claude|cursor|codex|human|...), scope: {repo, paths[], symbols[],
    capability?}, intent: string, status: active|released|superseded|expired, created_at,
    ttl_ms, heartbeat_at, base_commit, branch }`.
  - `arbiter.ts` — on a new claim, compute **overlap** vs all active claims (path-prefix ∩,
    symbol-set ∩, capability-name match against WAS `workspace_capabilities`, and blast-radius
    intersection via CAS edges). Return `granted | conflict{with_claim, kind, evidence} |
    duplicate{existing_claim, their_in_flight_diff}`.
  - `presence.ts` — active agents in a workspace, heartbeats, TTL expiry, last-seen scope.
- Storage: extend `storage.ts` with a workspace-scoped claim log (append-only + compacted
  active view). Must be **shared** across machines → see WS-C-transport.
- **Consistency:** claims are last-writer-wins per `claim_id` with a monotonic `seq`; the
  active-set is derived. Arbitration is advisory-by-default (returns a verdict; the agent
  decides) with an optional strict mode (server refuses to grant an overlapping claim). Design
  the arbitration as a pure function `arbitrate(newClaim, activeClaims, casEdges, wasGraph)` so
  it's unit-testable without transport.

**WS-C-transport (real-time).** Agents must see each other in near-real-time.
- Add `GET /v1/coordination/stream` (SSE) + `POST /v1/coordination/claim` /
  `/release` / `/heartbeat` to `remote-analyzer-service.ts` (behind auth). SSE pushes
  claim/presence deltas. Poll fallback: `GET /v1/coordination/state?since=<seq>`.
- Backing store: Redis if configured (pub/sub + the claim set), else the existing disk store
  with a short-poll — mirror the `ai-cache.ts` Redis→memory→disk tiering pattern.

**Acceptance.**
- Unit: `arbitrate()` returns `duplicate` when two claims target the same capability; `conflict`
  when path/symbol/blast-radius overlaps; `granted` when disjoint. Decoy (adjacent but
  non-overlapping paths) → `granted`.
- Integration: two clients POST overlapping claims to a running server; second gets `conflict`
  with the first's in-flight diff attached; SSE delivered the presence delta to a third client.
- No collision-prevention false-negative on the demo scenario (WS-DEMO).

**Deps.** WS-B (in-flight diff to attach), WAS graph, CAS edges. **Tier.** `opus/careful` (protocol + consistency); `sonnet` for the HTTP glue.

---

### WS-D — Conflict-Prevention / Collision Engine

**Goal.** The analysis that powers arbitration and the "will this collide" answer.

**Why.** The intelligence behind L5. Reuses existing structural facts; this is where the
understanding layers pay off as coordination value.

**Current.** Ingredients exist and are unused for this: `validate_agent_change`
(`assess_change_risk`), cross-repo contract drift (`buildCrossRepoContractDrift` in `product.ts`),
blast-radius via CAS edges, WAS capabilities. No engine composes them for multi-agent.

**Build.** `apps/mcp-server/src/coordination/collision.ts`:
1. **Duplicate-work detector** — new claim's `intent`/`capability` vs WAS `workspace_capabilities`
   + other active claims. If an active claim (or a very-recent released one) already covers the
   same capability/entity-writes, flag `duplicate`.
2. **Edit-overlap detector** — path ∩ and symbol ∩ across in-flight diffs of active agents
   (from WS-B). Same file/region → `overlap`.
3. **In-flight contract-drift detector** — agent A's in-flight diff changes a DTO/route/entity
   shape that agent B's active scope consumes (extend `buildCrossRepoContractDrift` to run over
   *in-flight* tracks, not just committed). This is the "stale contract" killer.
4. **Cross-agent blast-radius** — union each active agent's edit set → CAS `get_callers`/edges →
   if agent A's blast radius includes agent B's claimed symbols, `warn`.
- Output a `CollisionReport { duplicates[], overlaps[], drifts[], blast_intersections[] }` with
  evidence (file:line, claim ids, the specific field/route/symbol).

**Acceptance.** Blackbox bench `apps/mcp-server/src/gauntlet/coordination-bench.ts`: fixtures of
2–3 simultaneous in-flight diffs; assert the engine flags the planted duplicate/overlap/drift and
stays silent on the disjoint decoy (F1 on collisions). `losses===0` win-validator style.

**Deps.** WS-B, WS-C. **Tier.** `sonnet` (composition of existing facts).

---

### WS-E — Coordination MCP Surface

**Goal.** Expose L4/L5 to any agent as first-class tools.

**Current.** None of these exist. Add to `apps/mcp-server/src/server.ts` (registerTool) + the
gateway groups + `SERVER_INSTRUCTIONS` teaching.

**New tools (contract sketch):**
- `claim_work({ workspace, intent, paths?, symbols?, capability?, ttl_ms? })` → verdict
  (`granted|conflict|duplicate`) + on conflict/duplicate the other agent's identity + in-flight diff.
- `release_work({ claim_id })`, `heartbeat_work({ claim_id })`.
- `get_active_agents({ workspace })` → presence + each agent's scope + staleness.
- `check_collision({ workspace, proposed: {paths?, symbols?, capability?} })` → `CollisionReport`
  (read-only preflight; no claim taken).
- `get_in_flight_changes({ workspace, exclude_self? })` → every active agent's uncommitted diff
  summary + which entities/routes/contracts they touch (compact; cap bytes like `summarizeCas`).
- `subscribe_workspace({ workspace })` → SSE handle (or instructions to poll) for live deltas.

**Teaching (SERVER_INSTRUCTIONS + tool descs + docs/mcp/*).** Add a "Coordinate before you act"
section: *before starting non-trivial work, call `check_collision`/`claim_work`; if `duplicate`,
adopt or defer; if `conflict`, coordinate or rebase; heartbeat while working; `release_work`
when done or on handoff.* This is the behavioral protocol — it must be taught or the write-side
goes unused.

**Acceptance.** MCP integration test: an agent that calls `claim_work` then `check_collision`
gets consistent answers; a second agent sees the first via `get_active_agents`. Tool payloads
stay compact (token budget). **Deps.** WS-C/D. **Tier.** `sonnet`.

---

### WS-B — In-Flight Capture + Cross-Machine Sync

**Goal.** Every agent's uncommitted working-tree state is captured and made available (safely)
to the workspace, so others can see incoming work.

**Why.** "Work stuck on someone's machine" is only solvable if the machine publishes it.

**Current.** `track.ts` classifies in-flight; `/v1/analyze-diff` analyzes a diff payload;
`remote-sync-client.ts` + `remote-source.buildBranchDiffContext` build diffs. Missing: a
continuous publisher of the local working-tree diff to the shared workspace, keyed by agent, and
the merge/precedence rules across machines.

**Build.**
- `apps/mcp-server/src/coordination/in-flight-sync.ts` — a debounced watcher (reuse the existing
  watch tools `start_watch`/`poll_watch_changes`) that on working-tree change computes the diff
  context and PUTs it to `POST /v1/coordination/in-flight` `{ agent_id, workspace, base_commit,
  branch, diff_context }`. Server stores per (workspace, agent_id) latest in-flight snapshot +
  its derived facts (touched entities/routes/contracts via a lightweight diff analysis).
- Precedence: `committed(main) < other-branch < in-flight(self) < in-flight(peer, if strict)`.
  Reads default to self-in-flight over peer; peers are surfaced via WS-E, not silently merged.

**Acceptance.** Two machines editing the same workspace: machine A's in-flight diff appears in
machine B's `get_in_flight_changes`; classification + touched-contract extraction correct.
**Deps.** WS-F (security) is a hard gate — do NOT ship cross-machine code sync without it.
**Tier.** `sonnet`.

---

### WS-F — Security / Privacy for Uncommitted-Code Sync (HARD GATE)

**Goal.** Make publishing unpushed work across machines trustworthy for enterprise from day one.

**Why.** You are moving people's unpushed code off their machine. This is a trust/compliance/
data-residency surface, and it's a day-one buyer conversation. Retrofitting it is fatal.

**Build (must exist before WS-B ships peer sync).**
- **Scope control:** per-workspace opt-in; `.klauroignore` (paths never synced — secrets, .env,
  generated); default-deny for anything matching secret patterns (reuse/extend existing ignore
  in `klauro-config.ts`).
- **Tenancy + authz:** in-flight and claims are workspace+org scoped; a claim/diff is only
  visible to members of that workspace (extend the existing account/entitlement flow — accounts
  in `remote-analyzer-service.ts` `AccountStore`). No cross-org leakage; add an authz test.
- **At-rest + in-transit:** TLS (have it via Caddy); encrypt in-flight blobs at rest; short TTL +
  purge on `release`/disconnect. Option for **diff-only, never full-file** mode.
- **Self-host / residency posture:** document a "your VPS" deploy so regulated buyers keep code
  in their tenancy (the product already runs on a single VPS — make that a supported install).
- **Audit log:** who published/read which in-flight scope.

**Acceptance.** Authz test: agent in org X cannot read org Y's claims/in-flight. Secret-path
never leaves the machine (unit test on the ignore filter). Purge-on-release verified.
**Deps.** none (do early). **Tier.** `opus/careful` (security design) + `sonnet` (impl).

---

### WS-A — Telemetry Fusion (make L3 real)

**Goal.** Ingest real runtime telemetry (OTEL spans, errors, request counts) and FUSE it into the
live CAS so every structural node carries runtime reality, exposed via MCP.

**Why.** "What's about to change is on a hot path that errored 40× last hour" is decision-grade
context no static tool has. Fused with in-flight + claims it's unique.

**Current.** Scaffolded: `runtime-contract.ts` (event shape), `runtime-sdk.ts` (client),
`telemetry-ingestion.ts`, `correlate_runtime_event` (span→node correlation, proven in
`telemetry-overlay-bench`), `record_runtime_event`, `get_runtime_*` tools, `runtime-simulation.ts`.
Missing: a real always-on ingestion endpoint + persistence + injection into stored CAS + freshness.

**Build.**
- `POST /v1/telemetry/ingest` (batch OTEL/JSON spans) on the analyzer server → persist per
  workspace/repo (Redis/disk tier) → run existing `correlateRuntimeEvent` to bind span→node →
  write `CASRuntime`/`CASRuntimeEvent` facts onto the stored analysis (hot/slow/error per node,
  real edges observed). Reuse the overlay logic already vetted in the bench.
- Expose fused facts: extend `get_runtime_observations`, `get_operational_priorities`,
  `get_hot_spots` to read persisted telemetry; add runtime flags into `get_coding_context`
  (so "understand before editing" includes "this is hot/error-prone in prod").
- Provide the drop-in SDK/collector (extend `runtime-sdk.ts`, `get_runtime_sdk_package`) +
  an OTEL-collector exporter path so teams wire it in minutes.

**Acceptance.** Blackbox: POST a batch of spans (incl. a decoy unmatched span) → the stored CAS
gains correct hot/slow/error facts on the right nodes; decoy rejected as `unmatched`;
`get_coding_context` surfaces the runtime flag. (Model on `telemetry-overlay-bench` but through
the live ingest path, not simulation.) **Deps.** none. **Tier.** `sonnet`.

---

### WS-G — WAS Deepening

**Goal.** Harden the least-contested ground (cross-repo) since that's the durable wedge.

**Current.** Strong: `cross-codebase-analysis.ts` (W1–W8). Known gaps (from memory + agent-feedback):
- Bare TS `interface`/`type` DTOs not classified as entities contribute no shape → cross-repo
  contract-drift silently skips them. Fix: capture interface/type shapes for drift.
- `get_user_journeys` LIST form strips `steps` → agents need a 2nd call. Add steps to list or a
  detail flag.
- Multi-repo "treat these N repos as one product" ergonomics (zerac feedback) — one command to
  fuse a workspace.
**Build.** Extend `buildCrossCodebaseSystemGraph` + `product.ts` drift; the entity-shape capture
in the TS analyzer. **Acceptance.** Contract-drift catches an interface-typed field change across
repos (new fixture). **Deps.** none. **Tier.** `sonnet`.

---

### WS-H — Moat: Outclass-Matrix Analyzers (#91)

**Goal.** Continue framework/library/pattern analyzers so "understanding" stays ahead while it
commoditizes at the single-repo tier. Follow the proven recipe; one gated slice each.

**Recipe (proven).** Framework analyzer extends `BaseAnalyzer`, emits the fact (route =
`CASEntryPoint{type:'http'}` via `createEntryPoint`; component = `renders` edges; ORM = relations;
DI = injections). Register in `apps/mcp-server/src/analyzer.ts frameworkRegistrations` (the
bench-path site; Kotlin analyzers are analyzer.ts-only, others also in `cas-analyzer.service.ts`
+ `frameworks/index.ts`). **Fixture MUST include a build manifest declaring the dep** or the
analyzer won't dispatch. Ground node types on a real WASM AST dump. Bench auto-enumerates
`fixtures/<bench>/<name>/truth.json`. Verify THROUGH `analyzeForBench`.

**Queue (Tier-1 non-route, highest value first):**
1. **Solidity security facts** — ERC conformance (20/721/1155), access-control (Ownable/
   AccessControl), reentrancy-guard, checks-effects-interactions. New bench `security-facts`.
2. **Elixir** — Ecto schema relations + OTP supervision tree (new `supervision-tree` bench).
3. **C# EF Core** — entity relations + DbContext mapping (ORM bench).
4. **Kotlin Compose navigation graph** (extends the landed component axis).
5. Then Tier-2/3 per `klauro-outclass-matrix-roadmap` (memory) — mechanical.
**Add a competitor arm:** Moderne/OpenRewrite (LST, multi-repo) + SCIP for the cross-repo/who-calls
ceiling — the *serious* competitors, replacing endless codebase-memory comparisons.
**Acceptance.** Each slice: F1=1.0 out-of-category through the orchestrator; adjacent benches
undisturbed; committed clean. **Deps.** none. **Tier.** `sonnet` for the analyzer, `haiku` for
fixtures/registration wiring (mechanical), orchestrator applies shared registrations centrally.

---

### WS-I — Proof (#80 + coordination bench) — converts "confident" → "proven"

**Goal.** External-credible evidence. Self-authored fixtures + a win-validator that asserts we
win is marking our own homework; outsiders need untuned proof.

**Build.**
- **#80 real-OSS gauntlet:** clone real OSS repos nobody tuned for; run Klauro vs SCIP/Moderne/
  embeddings arms on structural + who-calls + routes; report honestly (ties at LSP ceiling are
  fine). Reuse `corpus:expand` + the camps harness. NO fixture tuning.
- **Coordination bench** (WS-D) on realistic multi-agent scenarios.
- **Real-agent large-repo head-to-head (#96 completion):** same task, a real agent WITH vs
  WITHOUT Klauro, on a 100k+ LOC monorepo; measure correctness + tokens + tool calls. The tiny-repo
  tie is not proof; a large repo is where the thesis lives.
**Acceptance.** A report an outsider would believe: untuned repos, named competitors, honest ties.
**Deps.** WS-H arms, WS-C/D for coordination. **Tier.** `sonnet`.

---

### WS-DEMO — The Multi-Agent No-Collision Demo (the fundable artifact)

**Goal.** Show, don't tell. The screenshot no competitor can produce.

**Build.** A scripted scenario: a workspace + 2–3 agents given overlapping tasks. Without Klauro
they duplicate/collide; WITH Klauro, agent 2 calls `check_collision`/`claim_work`, is told
"agent 1 is already building this — here's their in-flight diff," and adapts. Capture the moment.
Also demo the contract-drift case (agent A changes a DTO in-flight; agent B is warned before
consuming the stale shape) and the telemetry case (agent warned it's editing a prod hot/error path).
**Acceptance.** A repeatable, recorded end-to-end run against the LIVE deployed product.
**Deps.** WS-A/B/C/D/E. **Tier.** `sonnet`.

---

### WS-J — Adoption Safeguards & Distribution polish

**Current.** Install/update/release ✅ (v1.0.2). Progressive-availability teaching ✅.
**Build (small, high-leverage):**
- **"Is my MCP actually loaded" doctor check** — dogfood finding: agents install but the MCP may
  not attach in a given client. Add to `klauro doctor` a check that the MCP server is registered +
  boots (grammar health) in the detected client config.
- **Turnkey multi-agent install** — codebase-memory installs into 11 agents with one command;
  Klauro is Claude-centric. Add an MCP-config writer for Cursor/Codex/Zed/etc. (the coordination
  fabric only works if *every* agent joins). 
- **Windows native-dep friction** — evaluate prebuilt binaries / WASM-only fallback so
  `npm install -g` doesn't compile native tree-sitter on Windows.
**Tier.** `haiku`/`sonnet`.

---

### WS-K — Consistency, Transport, Scale (cross-cutting)

- **Consistency model:** claims = per-`claim_id` LWW with monotonic `seq`; presence = TTL
  heartbeat; in-flight = latest-wins per (workspace, agent). Document it; make arbitration a pure
  function for testability.
- **Transport:** SSE for live deltas + poll fallback; Redis pub/sub when configured, disk/memory
  otherwise (mirror `ai-cache.ts` tiering).
- **Scale target (initial):** a workspace of ~20 agents × ~20 repos, sub-second claim arbitration,
  in-flight sync debounced to ≤2s. Not web-scale yet; YC-team-scale.
**Tier.** `opus/careful`.

---

## 4. Data model additions

New persisted entities (extend `cas.types.ts` / a new `coordination.types.ts`):
- `WorkClaim` (§WS-C).
- `AgentPresence { agent_id, agent_kind, workspace, last_seen, scope, base_commit }`.
- `InFlightSnapshot { workspace, agent_id, base_commit, branch, diff_context, touched:
  {entities[], routes[], contracts[], symbols[]}, updated_at }`.
- `CollisionReport` (§WS-D).
- Telemetry: reuse/extend `CASRuntime`, `CASRuntimeEvent`; add persisted `RuntimeFact
  { node_id, kind: hot|slow|error, metric, window, count }`.
All workspace+org scoped (WS-F).

## 5. Sequencing (dependency-ordered milestones)

- **M0 (unblock):** WS-F security scaffold (ignore/tenancy/authz) — gate for anything cross-machine.
- **M1 (substrate):** WS-B in-flight capture+sync (self only) → WS-A telemetry fusion (parallel).
- **M2 (the core):** WS-C coordination protocol + WS-D collision engine + WS-E MCP surface.
- **M3 (prove):** WS-DEMO + WS-I (#80 + real-agent large-repo) + coordination bench.
- **Continuous:** WS-H moat slices, WS-G WAS deepening, WS-J adoption polish — parallel, cheap models.

## 6. Risks to build against (from the evaluation)

1. **The write-protocol adoption problem** — agents must announce intent, not just read. WS-E
   teaching + making `claim_work` cheap/low-friction is existential. If agents don't check in,
   prevention degrades to detection.
2. **Cross-machine code privacy** — WS-F is non-negotiable and first.
3. **Timing** — multi-agent-on-one-codebase is emerging, not yet median. YC design partners
   de-risk this; instrument real usage to prove the pain is felt.
4. **Distributed-state is harder than static analyzers** — new engineering muscle; WS-K owns it.
5. **Commoditization of "understanding"** — don't market "deterministic vs embeddings" (the
   industry is converging there anyway); market coordination + workspace + blast-radius.

## 7. Out of scope here

UI (being designed in parallel). But note the data the UI will need: live presence, the claim
board, the in-flight diff feed, the collision report, and the telemetry overlay — all already
exposed by the MCP tools above, so the UI is a client of the same surface.

---

### Appendix — invariants for every builder agent
- Deterministic facts first; AI flavoring only; never a hardcoded categorizer.
- Tests/benches are BLACKBOX (call the product via CLI/MCP; never import the engine; never set a
  model/AI env — AI is the product's hidden concern).
- Verify analyzers THROUGH `analyzeForBench`; fixtures need a build manifest to dispatch.
- Commit in chunks, concise messages, no co-author trailers. Keep the tree clean (gitignore
  build/pack output). Node 22 at `~/.nvm/versions/node/v22.22.0/bin`.
- Use the cheapest model that fits the task; escalate only for protocol/consistency/security design.
