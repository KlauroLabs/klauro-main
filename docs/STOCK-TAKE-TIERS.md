# Stock-take: distance from the five-tier vision

**Status:** assessment, not a spec. Measures the code at master `5c59e755` against
`SPEC-ABSTRACTION-TIERS.md` (the five tiers and the dependency rule) and
`SPEC-ANALYSIS-SCOPES.md` (the recursive scope model). Both are model documents
authored the same day this stock-take was produced; a peer lane is writing the
unified v2.0.0 spec from the same inputs. This document does not propose
structure — it measures what exists.

**Scope note:** UI work is out of scope throughout, per explicit direction.

**Method:** direct reading of `packages/analyzer-core/src` (the orchestrator,
language/framework/library analyzers) and `apps/mcp-server/src` (the tool
surface, telemetry, coordination/fabric seam). Grounded in file paths, symbol
names, and line ranges. Where a claim could not be established from source
reading alone in the time available, it is marked UNSURE rather than guessed.

---

## Tier 1 — Index / ICELOT / Visibility / Graph

### What exists and works

- **Graph substrate.** `packages/analyzer-core/src/analyzer/core/orchestrator.ts`
  (31.3k lines — see "Architecture risk" below) builds nodes, edges, entry
  points, and exit points from per-language/per-framework analyzer
  contributions. `CASEntryPoint`/`CASExitPoint`/`CASNode`/`CASEdge` types live in
  `packages/analyzer-core/src/types/cas.types.ts`.
- **Entry-point taxonomy is broad and framework-agnostic at the type level.**
  `ENTRY_POINT_TYPES` (cas.types.ts:639) covers `http, websocket, cli, event,
  schedule, page, route, message, file, test, lifecycle, api, task, pipeline,
  notebook-cell, train, interrupt, driver, ipc, command, rpc, graphql` — i.e.
  web, data/ML pipeline, embedded/systems, desktop-IPC, and RPC/GraphQL are all
  first-class kinds, not bolted on.
- **Referential integrity is a gate, not a hope.** `graph-referential-integrity.ts`
  documents a real production incident (17,298 of 102,354 edges — 16.9% —
  dangling after an unreconciled filter pass) and is wired into deploy smoke.
  This is real tier-1 hardening, done recently and load-bearing.
- **Declared telemetry (ICELOT's `T`).** Recorded as a static fact about source
  (log sites, metric registrations) — distinct from tier 4. `self-telemetry.ts`
  and source-bound, locally installable private-beta SDK release candidates (`packages/klauro-sdk-js`, `packages/klauro-sdk-py`) give
  codebases something to declare.
- **Determinism is tested, not assumed.** `run-stability.test.ts` and
  `run-stability-cross-process.test.ts` (`packages/analyzer-core/src/__tests__/ai/`)
  exist specifically to catch non-reproducibility; `stage-fingerprint.ts` +
  `stage-fingerprint-golden-equivalence.test.ts` pin per-stage output shape.
- **Reachability index** (`reachability-index.ts`) is real and dual-purposed —
  the spec's own example of the pyramid working ("serves both product
  blast-radius AND fabric transitive collision detection from the same
  structure") checks out in code: `context-fabric.ts` and
  `coordination/partitioner.ts` both consume it as a pure read.

### What is weak

- **The graph-builder itself is one 31,300-line class-in-a-file**
  (`orchestrator.ts`). Every tier's logic — tier-1 graph assembly, tier-2
  paradigm/idiom detection, tier-3 capability/entity derivation — lives in the
  same file with the same `this.` surface. There is no filesystem or module
  boundary enforcing "tier 3 may not read past tier 2 without going through
  tier 2's output" — the dependency rule is currently a discipline, not a
  compile-time constraint. This is exactly the shape that let
  `determineSystemType` (a tier-3 claim) read raw tier-1 node-type labels
  directly (see Tier 2 below) — the defect was possible *because* nothing
  stopped one method calling into another tier's raw inputs.
- **ICELOT is not one struct.** Input/Constraints/Effects/Logic/Output/Telemetry
  are populated by different passes at different points in `orchestrator.ts`
  and related files (`entrenchment.ts`, `flow-concepts.ts` also reference
  ICELOT vocabulary) rather than one explicit per-node `{I,C,E,L,O,T}` record
  that a caller can request wholesale. UNSURE whether a single query surface
  returns all six facets for one node today, or whether a caller has to know
  which tool surfaces which facet — a spike against the live MCP tool list
  would settle this in under an hour.

### What was absent in that historical path

- No compile-time or lint-time enforcement of the tier boundary (nothing stops
  a new tier-3 pass from reading `node.type` directly instead of going through
  a tier-2 role lookup — the exact defect class the spec names).

### Historical estimate to close

- Splitting the boundary enforcement out of one file is a **weeks**-scale
  refactor by itself (31k lines, high blast radius, currently the single point
  every analyzer contributes into) — not a rewrite of logic, a structural
  extraction. Given "Run in production only" and no local heavy work, this
  would need to be done in slices, gated on tests each time, likely over
  several sessions.
- A single unified per-node ICELOT accessor, if it doesn't already exist: **1-2
  days** once confirmed absent (a spike, not a build, if the six facets already
  exist as separate fields — this would just be a join).

### Historical tier impact

Not currently — tier 1's own invariants (referential integrity, determinism)
are solid and gated. The risk this tier poses to tier 2/3 is architectural
(no enforced boundary), which is *why* the defects below were possible, not
because tier 1's own data is missing or wrong.

---

## Tier 2 — Framework / Architecture / Library

**This is the thinnest tier, and the code confirms it — with more nuance than
"missing."**

### What exists and works

- **Framework identification is broad.** `packages/analyzer-core/src/analyzer/frameworks/`
  has 29 ecosystem directories (web, java, dotnet, go, rust, php, kotlin,
  swift, scala, elixir, dart, solidity, apex, embedded, game, mobile, dataml,
  cpp, ci, clojure, crystal, julia, ocaml, perl, desktop, testing, javascript,
  and more), and `frameworks/web/` alone has 24 web-framework analyzers
  (Express, NestJS, Django, Flask, FastAPI, Rails, Laravel, Symfony,
  Spring-Boot, Next.js, Nuxt, Remix, SvelteKit's `svelte-analyzer.ts`, Qwik,
  SolidStart, Sinatra, Slim, Tornado, Sanic, aiohttp, Starlette, and more).
- **Library/dependency roles exist as a dedicated layer**, separate from
  framework analyzers: `packages/analyzer-core/src/analyzer/libraries/` has
  `orm/`, `http/`, `messaging/`, `auth/`, `database/`, `observability/`,
  `state/`, `realtime/`, `routing/`, `data-fetching/`, plus named analyzers for
  GraphQL, tRPC, OpenAPI, Mongoose, TypeORM, Drizzle, EF Core, SQLAlchemy,
  Mediator/CQRS, cron, workflow engines, MCP tool registration. This is the
  group 3 ("library and dependency roles: HTTP client, DB driver, cache,
  broker, payment SDK, observability") the spec calls out as the missing input
  behind the capability-substance defect — the *code to produce it* is not
  missing wholesale; what's unverified is whether its output actually reaches
  capability candidate generation end-to-end (see below).
- **Framework-conferred node roles are real for framework'd ecosystems.**
  Confirmed by direct read: `spring-boot-analyzer.ts`, `express-analyzer.ts`,
  `flask-analyzer.ts`, `django-analyzer.ts`, `rails-analyzer.ts`,
  `laravel-analyzer.ts` all emit typed entry points with `trigger.method` /
  `trigger.path` and framework-specific handler binding — this is the "route
  handler" role, just expressed as `CASEntryPoint.type: 'http'|'route'` plus
  `trigger`/`handler` rather than an explicit `role` enum field.
- **The persisted-entity gate is real and framework-agnostic in its evidence
  model** (`orchestrator.ts:19490-19573`, `tagDataEntityKind` /
  `buildPersistenceEvidenceContext`): it accepts `class | struct | interface |
  type | repository | migration | model` as DECLARATION_TYPES (so Go structs
  and Rust structs qualify, not only `@Entity`-annotated classes), plus
  suffix-based repository/DAO detection (`Repository|Repo|Dao|Store|Mapper`)
  and migration-name decomposition. `entity.kind_source` is honestly recorded
  as `'framework-evidence'` vs `'shape-inference'` — this is a real,
  ecosystem-spanning evidence model, not an ORM-decorator-only check. It
  replaced a version that minted 13 phantom entities from imports/constants on
  one real repo (comment at orchestrator.ts:19515-19519) — i.e. it has already
  been through one correctness iteration.
- **Deployable evidence providers work and are evidence-gated**, per ground
  truth: Docker, JVM packaging, installer, desktop packaging, bin targets, with
  a `bundled_into` relationship (multiple runnable entries rolling up into one
  ship unit) rather than folder-name guessing.
- **`determineSystemType` is fixed** (`orchestrator.ts:7031-7068`, landed this
  session at commits 4676925e/5c59e755): now derives `service` from any
  network-facing entry-point type (`http, websocket, rpc, graphql, api`),
  `application` from any runtime entry point or tier-1/2 ship evidence, and
  falls back to `library` only on tier-3 (package-identity) evidence with
  nothing else — i.e. framework-less Go/Java services with real entry points
  no longer misclassify. Read and confirmed directly.

### What is weak — concrete, ecosystem-specific

- **Architecture-paradigm detection is naming-convention-based and biased
  toward layered-OOP idiom.** `paradigm-conformance.ts` (404 lines) detects
  layers via regexes like `ENTRY_LAYER_NAME = /(Controller|Resolver|Gateway)$/`,
  `SERVICE_LAYER_NAME = /(Service|UseCase|Interactor)$/`,
  `REPOSITORY_LAYER_NAME = /(Repository|Repo|DAO|Dao)$/`. This vocabulary is
  native to Java/C#/TS/PHP MVC-style codebases. It is much weaker for
  idiomatic Go (which rarely names anything `FooController` or
  `FooRepository`), idiomatic Rust, or Elixir/Phoenix contexts — the exact
  asymmetry the spec's own miniature example describes for framework-conferred
  roles, reappearing one layer up in *architecture paradigm* rather than node
  role. This was not verified against a live Go/Rust repo in this pass —
  **flagged, not measured** — a same-day spike running `get_architecture` (or
  equivalent) against a stored Go analysis vs a stored Spring analysis would
  settle it.
- **The integrations-as-capability-candidates fix is landed but genuinely
  unverified end-to-end**, confirmed by direct read: `buildIntegrationCapabilities`
  (`orchestrator.ts:23881`, called at `orchestrator.ts:21976`) consumes
  `productExitPoints` and merges into existing capabilities OR lands in
  `behaviorSurfaces` (browsable, but explicitly **not** promoted into the
  ranked `capabilities` list unless it overlaps an entity-anchored capability
  — see `orchestrator.ts:21942-21959`). The only test reference found is
  `packages/analyzer-core/src/__tests__/ai/orchestrator-internals.test.ts`; no
  gauntlet/benchmark fixture reproducing the ~20-integration feed-reader case
  from the ground truth was found. So: the code path exists, is wired, and is
  unit-tested at the function level — but "does a real 20-integration repo's
  capability list actually include those integrations post-merge" is
  unverified by anything beyond unit coverage. Matches the brief's framing
  exactly.
- **Idiom/convention detection** (`idiom-detector.ts`, 1,253 lines) was not
  read in full this pass; UNSURE how many ecosystems it covers versus
  JS/TS-centric conventions. Flagging rather than guessing.

### What is absent

- No single `role` enum field on nodes/entry-points that ecosystems map into
  uniformly (route-handler / persisted-entity / migration / job / listener /
  gateway / middleware / resolver, as the spec names them as a set). What
  exists is a family of typed fields (`CASEntryPointType`, `CASDataEntityKind`,
  paradigm layer regexes) that *jointly* cover the same ground but not through
  one addressable vocabulary. Whether this matters in practice (callers query
  by entry-point type today, and that mostly works) versus being purely a
  modeling-cleanliness gap is UNSURE without seeing what breaks when a role is
  needed but no entry-point type or paradigm regex fires for it (e.g. a
  message-queue listener in a framework-less Go service using a raw Kafka
  client — does `libraries/messaging/` catch it, or does it fall through?).
  **Needs a spike**, not a guess.

### Effort to close

- Verifying the integration-capability fix's live effect: **hours** — run the
  existing gauntlet/benchmark harness (or construct one fixture) against a
  multi-integration repo and read the resulting `capabilities` list. This is
  the cheapest, highest-value verification in the whole stock-take.
- Broadening paradigm-conformance beyond OOP-layered naming (adding
  idiomatic-Go/Rust/Elixir signal — e.g. package/directory conventions,
  interface-satisfaction patterns instead of name suffixes): **days to low
  weeks** per ecosystem family, and it is the kind of work that needs a
  fixture-driven precision/recall harness (the stock-take references
  `analyzer-quality.ts` / `analyzer-audit.ts` already existing for this
  purpose per memory) rather than one-off patches.
- A unified role vocabulary, if judged worth building after the spike above
  confirms a real gap: **1-2 weeks**, because it touches every framework and
  language analyzer's contribution shape.

### Blocks the tier above?

**Yes, directly, and this is the proven mechanism.** Both ground-truth defects
are tier-3-reads-past-tier-2 (or tier-3-reads-tier-1-instead-of-tier-2)
failures. The `determineSystemType` instance is fixed. The
integrations-as-candidates instance is landed but unverified. Tier 2's
remaining weakness (paradigm detection's OOP-naming bias) is a live channel
for a *third* instance of the same defect class: an idiomatic Go/Rust/Elixir
repo could still get architecture-paradigm claims that don't fit, because the
tier-2 evidence for "what layer is this" is naming-shaped rather than
structural in the same way the persisted-entity gate now is.

---

## Tier 3 — Comprehension / Understanding

### What exists and works

- **Capabilities, entities, flows, and journeys all have dedicated builders.**
  `capability-detector.ts` (712 lines), `entity-relations.ts` (631 lines),
  `flow-graph-builder.ts` (413 lines), `flow-concepts.ts` (4,387 lines —
  the largest single comprehension file), `journey-builder.ts` (1,631 lines).
- **Capability generation is now multi-source and explicitly de-hardcoded.**
  Direct read of `orchestrator.ts:21900-22030` shows four independent
  candidate sources merged with dedup/redundancy filtering: entity-anchored
  (`buildTerminalCapabilities`), behavior-cluster (`buildBehaviorCapabilities`,
  for entity-free systems like MCP tool surfaces, game engines, CLI suites —
  explicitly there to avoid the "CRUD-over-tables-only" failure mode), and
  integration-anchored (`buildIntegrationCapabilities`, the fix above). A
  comment at `orchestrator.ts:21904-21908` confirms
  `buildPurposeCapabilitiesFromSignals` — a hardcoded 14-brand keyword-voting
  table — was **removed**, consistent with the "~30 hardcoded vocabulary
  tables removed 2026-08-07/08" note in the scope spec.
- **The persisted-entity gate (kind_evidence) is genuinely comprehension-layer
  work**, not storage work, exactly as the scope spec argues it should be
  (§3): it decides what counts as a real entity before anything downstream
  (ERD, capability anchoring) trusts it.
- **`SemanticRole` (core/supporting/infrastructure)** exists as a shared
  classifier (`apps/mcp-server/src/semantic-roles.ts`, 720 lines) reused across
  capabilities, entities, and flows — a real example of *not* forking
  classification logic three times.
- **Flow's M:N step model is architecturally present**, matching the spec's
  "a step may span many functions, one function, or part of one" — flow
  concepts and journey steps (`CASUserJourneyStep`, cas.types.ts:3459) are
  built as their own structures rather than 1:1 with functions. Whether this
  is fully M:N in *both directions* end-to-end, versus mostly 1-flow-step-to-
  1-function in practice, was **not verified against real output** in this
  pass — flagging as UNSURE, needs a spike reading one stored analysis's
  `journey_steps`/flow output and counting the fan-in/fan-out actually
  produced.

### What is weak

- **Output quality is the acknowledged open question, and this pass found
  supporting evidence rather than resolving it.** The ground truth states
  capabilities read as generic plumbing even where evidence is present. The
  code has real machinery to avoid this — `isGenericCapabilityDisplayName`
  filtering (`orchestrator.ts:21996-22001`), `trimLowValueFallbackCapabilities`,
  dedup by name — but a filter that removes generic *names* does not by itself
  guarantee the surviving names are *substantive*. Whether the underlying
  `usefulCapabilities` set (post-filter) reads as domain-specific in practice
  on a diverse corpus is a live-output question this stock-take could not
  settle without querying real stored analyses — **needs a spike**: pull
  `top_capabilities` from 5-10 stored analyses across different ecosystems via
  the read-only hosted product and eyeball them.
- **Entity cross-scope composition (dedup by identity across children) does
  not exist yet** — see Scope Recursion section. The spec calls this out as a
  "real change, not a relabel" for entities specifically (§3 of the scope
  spec), and nothing in `cross-codebase-analysis.ts`'s current WAS rollup
  (`runtime_links`, `application_links`, `shared_code_rollup` —
  hand-rolled fields, confirmed by direct grep) does entity-identity dedup
  across member analyses; it aggregates links, not entities.

### What is absent

- Entity↔capability and entity↔flow first-class linkage — the scope spec
  names this open (§3): today `related_entities` exists on a capability
  (weaker than the M:N capability↔flow model). Confirmed absent as a
  dedicated first-class edge type in `cas.types.ts` beyond that field; not
  independently re-derived here beyond trusting the spec's own open-question
  framing, since it matches what `capability-detector.ts`'s shape suggests.

### Effort to close

- The capability-substance spike (read real output across a corpus): **hours**,
  and should happen before any further tier-3 build work, because it is the
  cheapest way to find out whether the "generic plumbing" symptom is fixed,
  partially fixed, or unaffected by the recent de-hardcoding wave.
- Entity↔capability/flow first-class linkage, if the spike above shows it's
  needed: **days to 1 week** — it's an additive edge type plus a few builder
  call sites, not a rearchitecture.
- Verifying flow-step M:N fan-out in real output: **hours** (a read, not a
  build).

### Blocks the tier above?

**Yes — this is the tier the spec calls the moat's foundation** ("Garbage in
tier 2 poisons tier 3... comprehension quality is therefore not polish beneath
the coordination story — it is its precondition"). Tier 4's value proposition
(attaching telemetry to comprehension) and tier 5's entire premise (fabric
conflict detection keyed on capabilities/flows) both inherit tier 3's quality
directly and multiplicatively. If capability substance is still weak on a
representative corpus, that is the highest-leverage place to spend effort
before either tier 4 or tier 5 gets more investment — confirmed by code
reading, not just repeating the ground truth.

---

## Tier 4 — Realtime Telemetry

### What exists and works

- **Self-telemetry and route metrics are real and live**, confirmed by direct
  read: `apps/mcp-server/src/self-telemetry.ts` (301 lines) and
  `route_metrics` wired into `remote-analyzer-service.ts:1699` and
  `server.ts:5173-5177` (`GET /v1/telemetry/observations` and MCP-tool parity).
- **A telemetry fusion path exists and is architecturally sound for what it
  does**: `apps/mcp-server/src/telemetry-fusion.ts` (300 lines) turns OTEL-ish
  spans into `RuntimeFact`s via `correlateRuntimeEvent` (reused from
  `product.ts`, "already-vetted... proven in gauntlet/telemetry-overlay-bench.ts"
  per its own header comment).
- **Installable SDKs exist** (`packages/klauro-sdk-js`, `packages/klauro-sdk-py`)
  giving codebases a path to emit spans in the first place.

### Historical pre-fix finding — superseded by the addendum below

The following diagnosis describes the older node-only fusion path. It is retained as investigation history, not current product status. The customer SDK path now joins ingested observations through node runtime metrics into observed runtime links and flow-derived capability telemetry.

- **Observed telemetry is attached to CAS nodes, not to comprehension.**
  Direct read of `RuntimeFact` (`telemetry-fusion.ts:39-51`): the interface is
  `{ node_id, kind, metric, window, count, service, endpoint, matched_id,
  matched_label, confidence }`. There is no `flow_id`, `step_id`, or
  `capability_id` field anywhere in `telemetry-fusion.ts`, and a targeted grep
  for those three field names across the file returned zero matches. `route_metrics`
  is similarly route/endpoint-keyed (per-HTTP-route p50/p95/p99), not
  flow/capability-keyed. **This directly contradicts the spec's core claim for
  this tier** — "the attachment is the value, not the collection" — the
  collection exists; the attachment to tier-3 concepts does not, as measured
  in code today. This is the single most concrete, falsifiable finding in this
  stock-take: I did not have to infer it from absence of a feature name, I
  read the actual field list of the runtime-fact type.
- Confirming this once more from a different angle: `telemetry-fusion.ts`'s own
  header comment says its output is "persisted `RuntimeFact`s keyed to CAS node
  ids" (line 7) — the file's author already knew and stated the keying
  explicitly; it was simply never advanced to flow/step/capability level.

### What is absent

- Any join between `RuntimeFact`/`route_metrics` and `CASFlow` /
  `CASUserJourneyStep` / `SystemCapability` records. Since flows/steps are
  themselves graphs over nodes (per Tier 3), the join is theoretically
  cheap — a `RuntimeFact.node_id` could be resolved against
  `flow.steps[].node_ids` (or equivalent) to roll counts up — but nothing in
  `telemetry-fusion.ts`, `self-telemetry.ts`, or `telemetry-ingestion.ts` does
  this today, confirmed by grep across all three files for
  `flow_id|step_id|capability_id` (zero matches in the two telemetry files
  checked; `telemetry-ingestion.ts` was not separately greped for these terms
  but its purpose per filename is ingestion, not attachment, so it is unlikely
  to hold the join either — **UNSURE, worth a 10-minute confirm**, not
  re-verified line by line in this pass).

### Effort to close

- The join itself (RuntimeFact.node_id → flow/step/capability via the existing
  node-level flow graph) is likely **days, not weeks**, IF the flow/step graph
  already stores node membership in a form that supports reverse lookup
  (node → flow/step) — which is UNSURE and is the first thing to check before
  scoping this. If node→flow reverse lookup does not exist and has to be
  built, add **another few days** for that index.
- This is a good candidate for a fast, cheap fix relative to its narrative
  value: the collection mechanism, correlation logic, and SDK are all already
  built and proven; only the last join is missing.

### Blocks the tier above?

**Partially.** Tier 5 (fabric) is specced as "materially better with 4" but
does not strictly depend on it — fabric today runs on tier 1 (reachability)
and tier 3 (capability/flow ids) per the code read below, with no telemetry
dependency found. So tier 4's gap does not block tier 5 from functioning, but
it does block tier 4 from delivering the one thing the spec says justifies its
existence over a commodity metrics dashboard ("confirmation or refutation of
the static model... converts blast radius from a set into a weighted set").
Today, tier 4 is a commodity metrics dashboard, by the spec's own definition
of what would make it *not* one.

### Addendum — two ingest pipelines adjudicated (post-fix)

Once the `flow_id|step_id|capability_id` gap above was closed for the
`telemetry-ingestion.ts` → `product.buildNodeRuntimeMetrics` →
`attachTelemetryToFlows` path (the real Tier 4 join, now tested by
`telemetry-conceptual-join.test.ts`), a second question surfaced: this
codebase has *two* telemetry-ingest pipelines, and the fix only touched one.
`telemetry-fusion.ts` (`RuntimeFact`, `POST /v1/telemetry/ingest`) is still
node-only exactly as described above — re-confirmed, unchanged.

Investigation into whether `telemetry-fusion.ts` should be retired, merged,
or kept as a deliberate lighter-weight signal found:

- **No real producer posts to it.** The actual customer SDK source and verified release-candidate artifacts
  (`@klauro/telemetry`, `packages/klauro-sdk-js`) POSTs to
  `/api/telemetry/runtime-events/:projectId`, which `remote-analyzer-service.ts`
  explicitly routes through the *other* pipeline (`ingestTelemetryBatch` via
  `mapSdkEvent` — see the comment at `remote-analyzer-service.ts:359-373`,
  which states this in its own words: "NOT to `/v1/telemetry/ingest`").
  `/v1/telemetry/ingest` itself is live, wired, and documented
  (`COORDINATION-FABRIC.md`, `SPEC-COORDINATION-FABRIC.md`,
  `docs/mcp/TOOLS.md`), but nothing in this repository — no SDK, no
  middleware, no gauntlet/bench outside its own unit tests — POSTs to it.
  Its output (`fused_runtime_facts`) is merged additively into
  `get_coding_context` and `get_runtime_observations`, but no test asserts
  that merge and neither tool's doc entry mentions the field.
- **The wire-shape argument for keeping a separate intake does not hold.**
  The hypothesis going in was that the fusion pipeline's span shape might be
  what a real observability stack already emits, and the ingestion pipeline's
  shape bespoke. It's the reverse: the SDK's real wire shape
  (`CasRuntimeEvent` — trace/span ids, `static_id`/`node_id`/`entry_point_id`/
  `exit_point_id` for direct correlation, environment, attributes) is richer
  than `telemetry-fusion.ts`'s own invented `TelemetrySpan` shape
  (`service`/`endpoint`/`duration_ms`/`error`/`count`/`stack`), and it is the
  ingestion pipeline, not the fusion pipeline, that receives it.
- **Node-only is not a structural ceiling.** `RuntimeFact` already carries
  `node_id` and a `matched_id` (which can be an entry-point id) plus a
  route-like `service`/`endpoint` pair — the same key family
  (`static_id`/`node_id`/`entry_point_id`/`route`/`method`) that
  `RuntimeMetricLike` (what `attachTelemetryToFlows` actually consumes) and
  `NodeRuntimeMetrics` (the ingestion pipeline's own aggregate) both use.
  `attachTelemetryToFlows` resolves flow/step membership by matching node ids
  already present in the flow's step→function graph — the telemetry event
  itself never has to carry a `flow_id`. So a `RuntimeFact` is one adapter
  function away from the same join, not blocked from it by its wire shape.
- **A separate, unrelated dead path was found in passing, then fixed rather
  than removed.** A *third* SDK file, `packages/analyzer-core/src/sdk/
  javascript/klauro-sdk.ts`, POSTed to `/api/telemetry/ingest` — a route no
  server file implements. Reachability check confirmed it dead by every
  measure: excluded from `packages/analyzer-core/tsconfig.json`'s `include`
  (`src/sdk/**/*` is explicitly excluded), not referenced by
  `apps/mcp-server/scripts/build-bundle.mjs`, absent from all three shipped
  bundles (`dist/{cli,index,server}.cjs` — zero string hits for both the
  class name and the route), not imported by any source, test, or fixture in
  the repo (its sibling `klauro-express-middleware.ts` in the same directory
  is self-contained and does not import it either), and never published —
  `analyzer-core`'s `package.json` is `"private": true` and does not list it
  in any `files`/`exports`. Git history: 3 commits total, all pre-dating the
  monorepo reorg (`191d5bc9`); it was never wired to a real endpoint even at
  authorship. Per product-owner direction this pass, it was corrected in
  place instead of deleted: endpoint `api.klauro.io` → `mcp.klauro.com`,
  route `/api/telemetry/ingest` → `/api/telemetry/runtime-events/:projectId`,
  and its per-item `{version, payload: {type, data}, metadata}` envelope →
  the real `{ events: CasRuntimeEvent[] }` batch body, with Trace/Metric/
  ErrorReport items downgraded onto `CasRuntimeEvent` and `CASRuntimeEvent`
  items (already that shape) passed through with their correlation ids
  intact. `docs/SECURITY-PRIVACY.md` §5 is updated to match and now leads
  with the real, published `@klauro/telemetry` egress path, describing this
  file as an internal reference implementation rather than a shipped
  integration. A second, adjacent defect surfaced while tracing this:
  `runtime-contract.ts`'s `getRuntimeEventContract().sdk_contract.method`
  advertised `recordCasEvent` — this dead file's method name, not
  `@klauro/telemetry`'s actual `recordEvent` — to any caller of the
  `get_runtime_event_contract` MCP tool/resource; corrected to `recordEvent`
  in the same pass. It remains true that neither of these files is part of
  either live pipeline described above.

**Adjudication: (b) is the technically correct target** — keep
`/v1/telemetry/ingest`'s intake (spans are still a reasonable lightweight
format for a caller without the full SDK installed) but route
`fuseTelemetry`'s output through the same `RuntimeMetricLike` join
`attachTelemetryToFlows` already exposes, then retire the separate
`runtime-facts.json` store and the additive `fused_runtime_facts` field once
both tools read from one join. This removes the exact failure mode this
product has already paid for once: two surfaces (here, `contract.telemetry`
vs. `fused_runtime_facts`) able to disagree about the same node, because they
run different aggregation (`runtimeImpactStats` vs. `telemetry-fusion.ts`'s
own `SLOW_DURATION_MS`/`HOT_COUNT` thresholds) over the same underlying
signal. No live disagreement was found in this repo — there is no producer
feeding real traffic to `/v1/telemetry/ingest` today — but the two paths are
architecturally primed for it the moment anything does POST there, and nothing
today would surface a contradiction if it happened.

**Not implemented in this pass**, deliberately: `fix/tier4-telemetry-join`
(the branch that made the ingestion-pipeline join real) is not yet merged to
master, so building a merge on top of it here would sit on an unstable base;
and `/v1/telemetry/ingest` is a live, documented, externally-reachable HTTP
route this investigation cannot confirm is traffic-free in production (no
producer was found *in this repository*, which is not proof no external
caller exists). Retiring or rewiring a live ingest surface under that
uncertainty is exactly the case that calls for reporting rather than acting.
Recommended follow-up, once the join branch lands: add a `RuntimeFact` →
`RuntimeMetricLike` adapter, feed it through the existing
`attachTelemetryToFlows` call, confirm zero external callers of
`/v1/telemetry/ingest` in production logs, then delete `runtime-facts.json`
persistence and the `fused_runtime_facts`/`fused_updated_at` fields as a
separate, surgical follow-up commit.

---

## Tier 5 — Action / Collaboration / Fabric (seam only)

Per instructions, this section assesses only the seam fabric reads — not
fabric's internal correctness.

### What exists and works

- **The seam is a real, disciplined read-only layer.** `context-fabric.ts`'s
  own header (lines 1-17) states the contract explicitly: "Everything here is
  a PURE READ of already-computed CAS fields... NOTHING is recomputed." This
  is the cross-cutting "overlay, not part of the analysis structure" principle
  from the spec, implemented as written, confirmed by direct read.
- **Fabric consumes tier-3 concepts, not just tier-1 graph facts** — the
  spec's central falsifiable claim. Confirmed by direct read of
  `apps/mcp-server/src/coordination/partitioner.ts`: `PartitionTask.capability_id`
  (line 72) and grouping "by `flow_id` (falling back to `capability_id`)"
  (line 106-112) with an explicit comment: "different flows/capabilities...
  routed to different batches... conceptually co-located" (line 146-150,
  716-742). This is real evidence the coordination layer is keyed on
  comprehension, not file paths — the spec's differentiator claim holds up
  under direct inspection, not just as an aspiration.
- **`plan_parallel_work` is confirmed CAS-blast-radius-powered** per memory and
  consistent with `reachability-index.ts` being consumed by both product
  blast-radius and `context-fabric.ts`/`partitioner.ts`.

### What is weak

- **Fabric's quality is a direct function of tier-3's, and tier 3's substance
  is the open question above** — so whatever weakness exists in fabric's
  practical conflict-detection quality is very likely inherited, not fabric's
  own defect. This was not independently re-verified against live fabric
  output in this pass (out of scope per the brief — assess the seam, not
  fabric itself).

### What is absent

- Nothing absent at the seam level that this pass could identify — the seam is
  narrow and does what it says.

### Effort to close

- N/A for the seam itself. Any investment here is really tier-3 investment
  (see above), which is where the leverage is.

### Blocks the tier above?

N/A — tier 5 is the top of the pyramid.

---

## Scope recursion readiness

**Bottom line: `das_index` is a real, working proof of the leaf-scope shape,
but the recursive structure above it does not exist — confirmed by direct
read, matching the scope spec's own "NOT yet built" status.**

- **`das_index` is real.** `DasIndex` (`apps/mcp-server/src/deployable-analysis.ts:963`)
  and `buildDeployableAnalyses` build a per-deployable slice with ship
  evidence and shared-code attribution. This is genuinely "a leaf scope with
  ship evidence," matching the spec's derived-property model (§1a) even though
  the code doesn't use that vocabulary.
- **What blocks unbounded nesting today, confirmed by direct read:**
  1. **Storage keying is per-project-path, not per-scope-id.**
     `getProjectStorageDir` (`apps/mcp-server/src/storage.ts:1679`) and its ~15
     call sites all key off a filesystem `projectPath` / `project_id` string.
     There is no `parent_id`/`label` scope row anywhere in `storage.ts` —
     confirmed by grep, zero matches for `parent_id` or `scope_type` in that
     file. Adding a scope requires either a new project (current model) or a
     structural change to the storage key, exactly as the scope spec predicts
     in its "what this changes" list item 1.
  2. **WAS rollup logic is hand-rolled and field-specific, not generic
     composition.** `cross-codebase-analysis.ts` builds `runtime_links`,
     `application_links`, `shared_code_rollup` as named, purpose-built arrays
     (confirmed: 20+ direct references across the file) rather than a generic
     "parent's evidence includes its children's" composition. This is the
     "genuine rewrite of the aggregation path, not a rename" the scope spec
     names as item 2 — confirmed as accurately scoped by this read.
  3. **No `scope_type`/`parent_id`/`label` schema exists anywhere in the
     codebase** — confirmed by grep across `cross-codebase-analysis.ts` and
     `deployable-analysis.ts`, zero matches. WAS, CAS, and DAS are three
     separately-coded structures today, exactly as the spec states.
- **Query surface** — MCP tools take an analysis id (project path-derived)
  today; a scope id + depth parameter does not exist. Not independently
  verified against every tool in this pass (160+ tools per memory) — would
  need a full surface audit to quantify, which is out of proportion to this
  stock-take's time budget. **Flagged as UNSURE at the "how many tools"
  granularity; confirmed absent at the concept level.**

### Effort to close

Matches the scope spec's own sequencing almost exactly, which this pass found
no reason to dispute:
- Cheap, do-now items (naming, system-map-vs-architecture-map rule,
  dependencies-ordered-by-usage): **days**, and don't require this stock-take
  to re-derive since the spec authors already sequenced them.
- Storage/identity rework (parent/child scope rows, path): **1-2 weeks**,
  because ~15+ call sites key off `projectPath` today and would need a
  compatibility shim if scope ids are introduced without breaking existing
  project-path-keyed analyses (the scope spec's own backward-compatibility
  requirement in §7 item 4).
- Rollup rewrite (generic composition replacing `runtime_links`/
  `application_links`/`shared_code_rollup`): **weeks**, explicitly flagged by
  the scope spec itself as "the expensive half" and confirmed here as
  plausible given the amount of bespoke logic found in `cross-codebase-analysis.ts`.

---

## The composition question (re-derive vs compose)

The scope spec leaves this open (§9.3) and asks for an assessment of what the
code could support today and what each option would cost. Based on this
pass's reading:

- **Re-deriving comprehension at every scope level is what the code currently
  does, implicitly, by construction** — `cross-codebase-analysis.ts`'s WAS
  build does not compose child capabilities/entities; it re-derives
  workspace-level capabilities/domains/entities from the union of member
  inputs via its own classifier calls (confirmed: `graph.workspace_capabilities`,
  `graph.workspace_domains`, `graph.workspace_entities` are built by
  dedicated functions in that file, not by merging each member's already-computed
  `capabilities`/`entities` arrays). This matches the "expensive and may
  disagree with children" risk the scope spec names.
- **Composition-with-provenance is not built**, and doing it well is
  non-trivial for the entity-dedup case specifically: two services'
  `Customer` entities are only mergeable if identity can be established across
  differently-shaped schemas (field overlap, naming, ORM-vs-ORM), which is a
  new deduplication problem, not a free union. The scope spec's own framing
  ("the same Customer modelled twice... is a finding, not a merge conflict")
  suggests the product wants *both* — dedup-with-distinctiveness, not silent
  merge — which is more work than either pure option.
- **What the code could support today, cheaply, as a first step:** composing
  *capability/entity id lists* (not full re-derivation, not full identity
  dedup) at the parent level — i.e., "this scope's capabilities are the union
  of these child ids" without yet solving cross-child dedup — would be a
  **days**-scale addition on top of the existing per-child `capabilities`
  arrays, and would immediately stop the latency cost of re-deriving, at the
  cost of surfacing duplicates un-deduped (a known, visible gap, not a hidden
  one). This reads as the pragmatic middle path the scope spec doesn't quite
  land on either side of.
- **UNSURE, needs a spike:** actual re-derivation latency at parent scope for
  a realistic multi-repo workspace was not measured in this pass (would
  require running against a stored large workspace, which is available
  read-only) — the "expensive" framing is trusted from the spec and from the
  Speed program's known "126s save > 113s AI > 35s parse" profile in memory,
  but not independently re-measured here.

---

## Determinism boundary — is it where the code puts it?

**Yes, largely, with one caveat.**

- Tier 1 has explicit reproducibility tests (`run-stability.test.ts`,
  `run-stability-cross-process.test.ts`) and a fingerprint mechanism
  (`stage-fingerprint.ts` + golden-equivalence test) — this is real evidence
  the team already treats tier 1 as byte-reproducible and tests for it, not
  just asserts it.
- Tier 3's non-determinism is tracked at the field level via
  `description_source: 'deterministic' | 'ai' | 'manual' | 'reused'`
  (confirmed across many call sites in `orchestrator.ts`, e.g. lines 2329,
  3652, 11761, 12697) — so a caller *can* distinguish AI-derived text from
  structural fact within a single capability record. This is a reasonable
  implementation of "variance must be measured rather than assumed away."
- **The caveat:** tier 2 is where the boundary gets blurry in practice, not
  tier 3. Tier 2's paradigm-conformance and idiom detection are
  regex/name-pattern based (deterministic in the sense of "same input, same
  output," but not validated against ground truth the way tier-1's
  reproducibility tests validate stability) — so tier 2 is technically
  deterministic-by-mechanism but its *correctness*, not its reproducibility,
  is the open question (matches the ecosystem-bias finding above). The spec's
  boundary claim ("tiers 1-2 must be byte-reproducible") is met literally;
  whether tier 2's deterministic output is also *right* across ecosystems is
  the separate, harder question this stock-take flags as unresolved.

---

## Ranked shortest path to the vision

Ordered by the dependency rule: fix inputs before fixing the tier that
consumes them. Excludes UI per scope.

| # | Action | Tier | Effort | Blocks |
|---|---|---|---|---|
| 1 | Spike: verify integration-capability fix's live effect on a real multi-integration repo | 2→3 seam | hours | Tier 3 substance credibility |
| 2 | Spike: pull `top_capabilities` from 5-10 stored analyses across ecosystems, eyeball substance | 3 | hours | Everything above tier 3 |
| 3 | Spike: confirm/deny flow-step M:N fan-out in real stored output | 3 | hours | Same |
| 4 | Join `RuntimeFact`/`route_metrics` to flow/step/capability ids (the tier-4 gap) | 3→4 | days (pending node→flow reverse-lookup check) | Tier 4's entire value proposition |
| 5 | Broaden paradigm-conformance beyond OOP-layer naming (Go/Rust/Elixir idiom) | 2 | days–weeks per ecosystem | Tier 3 correctness on non-OOP ecosystems |
| 6 | Entity↔capability/flow first-class linkage | 3 | days–1 week | Tier 3 completeness, tier 5 conflict precision |
| 7 | Cheap scope-recursion items: naming, map rule, dependency ordering | scope model | days | Nothing blocking; low-risk, do anytime |
| 8 | Scope storage/identity (parent/child rows, path) | scope model | 1-2 weeks | Everything else in the scope model |
| 9 | Scope rollup rewrite (generic composition replacing bespoke WAS fields) | scope model | weeks | Full recursion depth |
| 10 | Structural tier-boundary enforcement inside `orchestrator.ts` (module split or lint rule preventing tier-3 code from reading raw tier-1 fields) | 1→2→3 architecture | weeks, done in slices | Prevents the *next* instance of the proven defect class, doesn't fix a current one |

**Rationale for the ordering:** items 1-3 are read-only spikes that cost hours
and directly answer the open questions the brief asked me to establish rather
than guess at — they should happen before any of items 4-9 are prioritized,
because they determine whether tier 3 (which everything above it depends on)
is actually in good shape post-de-hardcoding or still weak. Item 4 is flagged
high because it's unusually cheap relative to its narrative value (the
collection and correlation machinery already exists; only the join is
missing). Items 8-9 are last not because they're unimportant but because the
scope spec itself recommends "capture now, build after beta" (§8) and this
pass found no evidence to override that sequencing — the expensive half
(rollup rewrite) touches the same aggregation path already under active
repair this week, which raises collision risk if started now.

---

## Where this stock-take is least certain

Stated plainly, per the brief's instruction to flag uncertainty rather than
fabricate precision:

- Tier 2 idiom-detector's ecosystem breadth (1,253 lines, not read in full).
- Whether tier-3's flow/step model is M:N in practice or mostly 1:1 despite
  supporting M:N structurally.
- Whether `telemetry-ingestion.ts` (824 lines, not fully read) holds any
  flow/step/capability join that `telemetry-fusion.ts` and `self-telemetry.ts`
  don't.
- MCP tool-surface scope-id readiness — not audited across all 160+ tools;
  confirmed absent only at the concept/schema level.
- Real re-derivation latency cost at parent scope for a large multi-repo
  workspace — trusted from memory/spec framing, not independently measured
  this pass.

Each of the above is a **spike, not a guess** — hours of read-only work each,
using the existing read-only access to stored analyses and the hosted product,
before committing build effort against any of them.
