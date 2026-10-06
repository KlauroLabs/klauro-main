# The Three Camps — Klauro Competitive Doctrine

This is the durable statement of *who we compete with, on what axes, and what
"winning" means*. The mission: **Klauro wins 100% of the time** — on quality/accuracy
AND on speed-or-tokens — for **every** supported language, framework, and library,
at **repo** and **workspace** scope, for **existing** and **greenfield** code.

We tie only where a competitor is already at the compiler-accurate ceiling, and we
win everywhere else. The ultimate win is **quality of understanding + tokens saved /
speed**, and it compounds over multi-step / larger requests.

---

## Camp A — Semantic / Embedding RAG

**Recipe:** tree-sitter chunk → embeddings → vector DB → top-k cosine "semantic search".

**Members:** Cursor (tree-sitter + Turbopuffer, Merkle-tree resync), Augment (custom
models, real-time, hash file-possession proofs), Warp (5k-file floor, admits
branch-switch staleness), Kiro (AWS, admits index corruption), Trae (ByteDance,
cloud-only, degrades past ~50 files), Roo Code / Kilo (→ Qdrant/LanceDB), CocoIndex
(Rust ETL, tree-sitter chunk → pgvector, "70% token savings"), Bloop (on-device
embeddings).

**Their admitted weaknesses (consistent across all):** chunking fractures logic, index
staleness on every merge, degradation on large/cluttered repos, sensitivity to query
phrasing. They retrieve *code about X*, not *the callers of X*.

**Our posture: DOMINATE.** On any structural task (who-calls, routes, ORM relations,
blast radius) embeddings lose by construction. Measured: real `nomic-embed-text` scores
**F1 0.50** on who-calls vs Klauro **1.0**. It ranks the *definition* #1 (false
positive), misses the aliased/dissimilar caller, and pulls in the vocab decoy.

## Camp B — Deterministic Structural (the real fight)

**Recipe:** serve real structure (defs/refs/calls/types), usually via MCP — "query this
instead of grep".

**Members:** Sourcegraph SCIP/LSIF, GitHub stack-graphs, Glean (Meta, typed fact DB),
Aider repo-map (PageRank file ranking), ast-grep, **DeusData/codebase-memory-mcp** (the
serious contender — see below), Sourcebot.

**codebase-memory-mcp specifically** (arXiv:2603.27277): single static binary, 158
vendored tree-sitter grammars, Linux kernel in 3 min (RAM-first: LZ4 + in-memory SQLite),
120x fewer tokens on 5 structural queries, hybrid-LSP type resolution for 11 langs,
Louvain communities, MinHash near-clones, dead code, ADR, Cypher-lite, IaC nodes,
cross-service HTTP/gRPC/GraphQL/channel linking, DATA_FLOWS arg→param, team-shared
graph artifact. **Their headline 0.83 answer quality is a LOSS to grep's 0.92** on their
own 12-question (all-structural) benchmark, graded by the first author; they admit
"static structure only; runtime/reflection/dynamic-dispatch NOT represented."

**Our posture: LEAD or EQUALIZE.** We match every structural capability they have
(parity tracked below) and then beat them on the axes they *cannot* reach (Camp C). Where
a real compiler-accurate tool (scip-typescript) already ties us on easy who-calls, we
**tie on quality at the ceiling and win on tokens** — and win outright on the 6/7
languages it can't index, and on every framework fact.

## Camp C — Deterministic Comprehension (our category — sole tenant)

Nobody else lives here. This is **understanding the system the way a company understands
it**: not "where is symbol X" but *what the system is, what it does, how it's built, how
it's running, and why it exists*. Camp A returns "code about X"; Camp B returns symbols and
who-calls. **Camp C returns the things a company actually reasons about** — and Camp A/B
emit *nothing* for any of it, by construction (they have no such abstraction).

Camp C is NOT "frameworks." Frameworks are one of ~11 categories below. The authoritative
surface is the set of deterministic, provenance-tagged fields the engine emits in
`CASOutput` (`packages/analyzer-core/src/types/cas.types.ts`) plus the workspace-level
CAS layer (`apps/mcp-server/src/cross-codebase-analysis.ts`). Every item is deterministic-first;
AI is flavoring on top of real structure, never the categorizer.

### C1 — Product & domain understanding ("what is / why it exists")
- **Capabilities** — `system_capabilities` (SystemCapability): the product's capabilities
  extracted from code as a spec.
- **Product map** — `product_map` (CASProductMap): capabilities composed into a generated
  product specification.
- **System purpose** — `system_purpose` / `enhanced_system_purpose`: what the system is and
  is for.
- **Domain concepts / terminal entities** — `domain_concepts`, plus the terminal-entity
  principle (the last-in-chain entity that reveals the domain & the "why it was built").
- **Categories / tags** — `categories`, `tags`.

### C2 — User journeys & workflows ("how it flows")
- **User journeys** — `entry_point_flows` (+ `entry_point_flow_summary`): end-to-end journeys with
  the terminal-entity "why".
- **Workflows** — `workflows` + `workflow_graph`.
- **Flow** — `flow_summary` + `flow_graph` + `flow_coverage` + `perspectives`.

### C3 — Behavior, intent & semantics
- **Behaviors** — `behaviors` (CASBehavior).
- **Intent** — `intents` (CASIntent): why a unit exists / what it's meant to do.
- **Behavioral invariants** — `behavioral_invariants` (+ summary).
- **Communities** — `communities`: graph-clustered cohesive subsystems.

### C4 — Patterns & paradigms (conformance + deviations)
- **Design patterns** — `patterns` (CASPattern): GoF + named architectural patterns.
- **Paradigm conformance** — `paradigm_conformance`: conformance to a paradigm WITH the
  deviations + evidence.
- **Codebase idioms** — `codebase_idioms` + `idiom_examples` + `idiom_violations` +
  `idiom_summary`.
- **Decorators** — `decorators`.

### C5 — Framework & architecture facts (the one I keep mistaking for all of Camp C)
- **Routes + auth/guards** — `route_table` (method/path/controller/auth/guards).
- **ORM** — `database_schema`: entity relations + **directional cardinality**
  (OneToMany/ManyToMany…), migrations.
- **DI graph**, **GraphQL schema↔resolver**, **pub/sub topic produces/consumes**,
  **component/widget trees + props** — via `libraries` + the architecture detectors.
- **External services** — `external_services`. **Architecture summary** —
  `architecture_summary`. **Configuration** — `configuration`.

### C6 — Data lineage & security boundaries
- **Data lineage** — `data_lineage` (CASEntityLineage): sensitive-data flow maps — what
  touches payment/PII data, which boundaries it crosses, which external services receive it.
- **Data entities** — `data_entities` (+ `data_summary`).
- **Security boundaries** — `security_boundaries` (+ summary), `security_contexts`.

### C7 — Deep call & data flow (beyond Camp-B who-calls)
- **Method calls / call chains** — `method_calls`, `call_chains` (typed, resolved).
- **Typed edges** — `edges` (calls/renders/injects/produces/consumes/relates…).

### C8 — Telemetry / "how it's running" (runtime fused with static)
- **Runtime** — `runtime` + `runtime_static_links`: runtime observation correlated to static
  structure. The historically un-won axis — simple indexers have no runtime concept.
- **Analysis facts** — `analysis_facts`.

### C9 — Quality, health, stability & change-risk
- **Health** — `implementation_health` + `system_health`.
- **Stability** — `temporal_stability` + `stability_summary`.
- **Change risk** — `change_risks` + `change_risk_summary`.
- **Tests** — `test_coverage` + `test_suites` + `test_gaps` + `test_summary` + `mocks` +
  `fixtures`.
- **Docs / TODOs** — `documentation_summary`, `todos_summary`.

### C10 — Workspace-Level CAS — cross-repo, FIRST-CLASS
**This is the single biggest moat.** Camp A/B and every serious competitor (scip,
stack-graphs, codebase-memory) analyze **one repository**. The workspace-level CAS understands a whole
**workspace** — ui → api → worker → infra as *one product* — and is out-of-category by
construction: there is no single-repo tool to even compare against. It is NOT a bullet; it
is its own taxonomy. Source of truth: the `CrossCodebaseSystemGraph` / `WorkspaceAnalysisGraph`
(`apps/mcp-server/src/cross-codebase-analysis.ts`), ~35 top-level fields grouped below.

- **W1 — Composition & topology.** What the workspace *is*, physically + logically:
  `applications` (logical apps that span repos), `codebases`, `distribution_units`,
  `composition` (monorepo / polyrepo / hybrid kind), `runtime_topology`,
  `infrastructure_overlay`, `environments`.
- **W2 — Cross-repo integration seams.** How the repos connect: `interfaces` (API contracts
  at each boundary — HTTP/gRPC/queue/event), `application_links`, `integration_links`
  (deployable→deployable), `runtime_links`, `links`, and `unmatched_interfaces` (a producer
  with no consumer / a consumer with no producer — **broken seams** nobody else can see).
- **W3 — Cross-repo data flow & lineage.** `data_flow_paths` (SystemDataFlowPath): data
  crossing repo boundaries — PII/payment data flowing ui→api→worker→external — i.e. data
  lineage at *workspace* scale, the thing a security team actually needs.
- **W4 — Workspace product understanding ("what / does / why", cross-repo).**
  `workspace_capabilities`, `workspace_domains`, `workspace_workflows`,
  `workspace_entities` + `workspace_entity_paths` (one entity traced across every repo that
  touches it), and `workspace_narrative` / `deterministic_narrative` — what-is / what-does /
  how-built / how-running for the **whole product** and each repo's role in it.
- **W5 — Ownership & activity.** `ownership` (CODEOWNERS / package-metadata per app — who
  owns each seam), `activity` (temporal/contribution signal across repos).
- **W6 — Telemetry ("how it's running", cross-repo).** `telemetry` summary + the runtime
  fusion — runtime behavior correlated to the cross-repo static structure.
- **W7 — Health, risk & priority.** `health`, `risk_areas`, `priority_work_items`,
  `quality_flags`, `validation` — workspace-level risk (e.g. an unauthenticated seam between
  two services) that is invisible from inside any single repo.
- **W8 — Insights & detail views.** `system_insights`, `inferred_insights`, `detail_views`,
  plus the `summary` roll-up (codebases / applications / interfaces / links / capabilities /
  domains / entities counts).

The workspace-level CAS benches in **emission-coverage** mode over a real multi-repo workspace (the win is that
Klauro emits these cross-repo facts with provenance and **no single-repo tool produces any of
them** — `campABCannot` = "operates on one repo; has no workspace/application/cross-repo-seam
concept"), plus head-to-head where a workspace task can be posed (e.g. "which service calls
this endpoint" spanning repos).

### C11 — Distribution & greenfield
- **Distribution units** — `distribution_units` (packaging/deploy artifacts).
- **Greenfield** — building NEW projects must win the gauntlet too (not just analyzing
  existing ones).

**How Camp C is benched.** Two honest modes:
1. **Head-to-head dimensions** (a real competitor is installed and *tries*): routes, ORM,
   DI, GraphQL, messaging, component tree, patterns, auth, telemetry, who-calls — Klauro F1
   vs the competitor's F1 + tokens. Competitors score 0 (no such abstraction) → out-category
   win; where a compiler-accurate tool ties on who-calls, we tie at the ceiling + win tokens.
2. **Differentiated-data dimensions** (no competitor produces them AT ALL — capabilities,
   product map, journeys, paradigm conformance, lineage, behaviors, intent, idioms, the
   workspace-level CAS, health/stability): the win is *emission coverage* — Klauro emits the structured fact with
   provenance on a real repo; Camp A/B emit nothing. Measured by presence + count + evidence,
   not F1 (there is no competitor curve to score against).

This is the moat. The deterministic facts are the differentiator; AI is *flavoring*,
never the categorizer.

---

## The win criteria (encoded in `win-validator.ts`)

`QUALITY_CEILING = 99.5`. Klauro wins when `(quality_won || tied_at_ceiling) &&
efficiency_won`. An arm that **cannot perform the task** (`can_answer=false`) is marked
`attempted: false` and does NOT compete on efficiency — a tool returning nothing is not a
token "winner". The out-category win is: Klauro answers, nobody else can.

## How we measure (no faked wins)

All wins are proven in the **gauntlet** against **real, installed** competitors at full
strength — never proxies. Real arms wired: ripgrep, ast-grep, ctags, scip-typescript,
GitHub stack-graphs, `nomic-embed-text` embeddings (Ollama), and codebase-memory-mcp.
Harnesses live in `apps/mcp-server/src/gauntlet/`:

- `primitive-bench.ts` — who-calls completeness (F1 + tokens), per-language via `truth.json`.
- `orm-bench.ts` — ORM entity relations (out-category).
- `framework-bench.ts` — route facts (out-category).
- `component-bench.ts`, `graphql-bench.ts`, `pattern-bench.ts` — more out-category facts.

Every `fixtures/**/truth.json` is auto-enforced by a `*.test.ts`; the full suite is the
gate after every change. Revert on regression. If Klauro loses, **deepen the analyzer** —
never weaken a competitor.

## Current matrix status (living; see memory `klauro-competitive-landscape.md`)

- **Breadth engine:** generic tree-sitter walker + per-language spec + native Rust parse
  stage (`klauro-parse`) → 27 generic languages on the road to 158.
- **Who-calls (Camp B turf, type-resolved):** 14 languages winning F1 1.0 (ts, py, go,
  java, kotlin, swift, cpp, rust, csharp, php, ruby, dart, solidity, elixir).
- **ORM relations (Camp C):** 5 ORMs / 4 languages (TypeORM, Prisma, SQLAlchemy,
  ActiveRecord, Hibernate).
- **Route facts (Camp C):** 3 web frameworks (Express, NestJS, Spring Boot).

## The road to total domination (execution order)

1. **158 languages** — breadth engine: keep batch-adding tree-sitter grammars (generic
   spec for most; native resolvers for niche name shapes).
2. **Frameworks per language** — the primary web/app frameworks, as deep analyzers
   emitting Camp-C facts.
3. **Architectural libraries per language** — the libraries that drive architecture
   (ORMs, DI, state, queues), emitting relations.
4. **Patterns / paradigms** — design-pattern + paradigm-conformance facts.
5. **Telemetry** — build + vet runtime observation.
6. **Per-camp, per-language, per-competitor** — a measured win (quality + tokens/speed)
   in the gauntlet for every cell of the grid.
