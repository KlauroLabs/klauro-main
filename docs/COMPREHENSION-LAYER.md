# The Comprehension Layer

This is Klauro's differentiator: not "where is symbol X" (that's structural search, table
stakes — see Camp B in [`CAMPS.md`](CAMPS.md)) but **understanding the system the way a
company understands it** — what it is, what it does, how it's built, how it's running, and
why it exists. `CAMPS.md` calls this Camp C and states the doctrine ("we compete with, on
what axes"); this document is the practical map of *which deterministic CAS fields and MCP
tools produce each piece of that understanding*, so both humans and agents can find the right
tool without re-deriving the taxonomy from source.

Every fact below is **deterministic-first**: extracted from real code structure, not
inferred from vibes. AI is flavoring on top of real structure (turning facts into readable
prose) — never the categorizer. See `CAMPS.md` for the full competitive framing and
`docs/cas/SPECIFICATION.md` for the formal CAS field definitions.

## Why / what it is (product & domain understanding)

- **Capabilities** — the product's capabilities extracted from code as a spec, ranked by
  criticality and linked to the entities/journeys they serve.
  Tool: `get_workflows` (capabilities + workflows), and capabilities appear inline in
  `get_summary` (`top_capabilities`) and `get_product_map`.
- **Product map** — capabilities composed into a generated product specification: identity,
  capabilities, journeys, data, conventions, health, all with coverage caveats so you know
  what the analysis is sure about.
  Tool: `get_product_map` (supports `section` to fetch one part token-efficiently, and
  `format: markdown` for a compact onboarding brief).
- **System purpose / domain concepts** — what the system is and is for, plus the
  terminal-entity principle (the last-in-chain entity that reveals the domain and the "why it
  was built").
  Tools: `get_summary` (`system_purpose`, `enhanced_system_purpose`), `get_domain_concepts`.

## How it flows (journeys & workflows)

- **User journeys** — end-to-end journeys composed from entry points, call chains, and
  terminal effects, each showing *why* a path exists via its terminal entity (e.g. "Create
  work order -> WorkOrder created").
  Tool: `get_user_journeys` (list form includes the compact step chain by default so no
  second call is needed; `journey_id` for full detail with security boundaries and covering
  tests).
- **Workflows & flow graph** — capabilities and workflows composed into a navigable flow,
  with coverage and multiple perspectives (e.g. security, data).
  Tools: `get_workflows`, `get_flow_graph`, `get_flow_coverage`, `get_perspectives`.

## Behavior, intent & semantics

- **Behaviors / intent** — what a unit of code does and why it's meant to exist.
  Tools: `get_behaviors`, `get_intent`.
- **Behavioral invariants** — properties that should hold across changes (used by
  `validate_behavioral_invariants` and `diff_behavior` to catch regressions).
  Tool: `get_behavioral_invariants`.
- **Communities** — graph-clustered cohesive subsystems (structural, not manually drawn
  module boundaries).
  Tool: `get_communities`.

## Patterns & paradigms (conformance + deviations)

- **Design patterns** — GoF and named architectural patterns actually detected in the code,
  with confidence and instance counts.
  Tools: `get_patterns` (summaries + variations), `get_pattern_instances` (drill into node
  IDs for one pattern), `get_pattern_examples`.
- **Paradigm conformance** — conformance to a paradigm (e.g. layered architecture,
  repository pattern) *with* the deviations and evidence, not just a yes/no.
  Tool: `get_paradigm_conformance`.
- **Codebase idioms** — repo-local conventions (naming, structure, error handling) mined
  from the actual code, with concrete examples and violations, so an agent's edits stay
  idiomatic to *this* codebase instead of a generic style.
  Tools: `get_codebase_idioms`, `get_idiom_examples`, `validate_codebase_idioms`,
  `get_idiom_aware_agent_context`.

## Framework & architecture facts

- **Routes + auth** — method/path/controller/handler/auth/guards, deterministically
  extracted per framework.
  Tool: `get_route_table`.
- **ORM / database schema** — entity relations with directional cardinality
  (OneToMany/ManyToMany/etc.), migrations.
  Tool: `get_database_schema`.
- **Architecture patterns & guidance** — detected MVC/repository/layered/mediator/
  singleton/etc. patterns with confidence, a decision matrix for where new code should go,
  and rules for preserving local architecture.
  Tool: `get_architecture_context` (the tool to call before planning or editing when
  placement/boundaries/pattern choice matters).
- **Framework/library depth** — how deeply each detected framework and architecture-defining
  library is understood (analyzer presence, tagged nodes, entry points, evidence).
  Tools: `get_framework_depth_report`, `get_integration_depth_report`.
- **External services / configuration** — third-party services the system talks to, and its
  configuration surface.
  Tools: `get_external_services`, `get_configuration`.

## Data lineage & security boundaries

- **Data lineage** — sensitive-data flow maps: what touches payment/PII data, which
  boundaries it crosses, which external services receive it.
  Tool: `get_data_lineage`.
- **Data entities** — the entities the system actually persists/moves, with sensitive-field
  hints.
  Tool: `get_data_entities`.
- **Security overview** — security boundaries and contexts (auth requirements, tenant
  isolation, rate limiting).
  Tool: `get_security_overview`.

## Deep call & data flow

- **Method calls / call chains** — typed, resolved call graph, not text-match guesses.
  Tools: `get_method_calls`, `get_call_chain`, `get_callers`, `get_callees`.
- **Clones / dead code** — near-duplicate code (MinHash-based) and unreferenced code.
  Tools: `get_clones`, `get_dead_code`.

## How it's running (runtime fused with static)

- **Runtime observations** — real (ingested) or simulated runtime events correlated onto
  CAS nodes, entry points, exit points, and call chains.
  Tools: `get_runtime_observations`, `get_runtime_trace`, `correlate_runtime_event`,
  `record_runtime_event`, `ingest_telemetry` (batch OTEL-compatible ingestion — see
  `docs/mcp/TELEMETRY-INGESTION.md`).
- **Operational priorities / hot spots** — bugs, bottlenecks, and problem areas ranked by
  combining runtime observations with static system health, change risk, test gaps, and
  idioms.
  Tools: `get_operational_priorities`, `get_hot_spots`.

## Quality, health, stability & change-risk

- **Health** — implementation completeness (complete/partial/stub/deprecated) and overall
  system health.
  Tools: `get_implementation_health`, `get_system_health`.
- **Stability / change risk** — temporal stability signals and risk scoring for a proposed
  or actual change.
  Tools: `get_stability`, `assess_change_risk`, `get_change_summary`.
- **Tests / docs / TODOs** — test coverage and gaps, documentation coverage, outstanding
  TODOs as tracked work signal.
  Tools: `get_test_summary`, `find_tests`, `get_documentation_coverage`, `get_todos`.

## Workspace-level (WAS) — cross-repo, first-class

This is the layer most competitors have no concept of at all: understanding a whole
**workspace** (ui -> api -> worker -> infra) as one product, not one repo. See `CAMPS.md`
§C10 for the full W1-W8 field taxonomy. Practically:

- `run_workspace_analysis` / `get_workspace_analysis` — build/load the cross-repo graph:
  composition, interfaces, application links, runtime topology, unmatched interfaces (broken
  seams).
- `get_workspace_capability_map` — whole-workspace domains, capabilities, workflows.
- `get_workspace_entity_map` — one entity traced across every repo that touches it.
- `get_cross_codebase_analysis` / `run_cross_codebase_analysis` — the underlying cross-repo
  system graph builder.
- `get_workspace_agent_context` — the preferred agent entrypoint for any task spanning
  multiple repos.

## How comprehension composes into one agent call

An agent doesn't need to call every tool above individually for a normal task. The
composed entrypoints pull the relevant slice automatically:

- `get_agent_context` — task-scoped: pulls coding context, capability memory (avoid
  rebuilding existing behavior), change risk, idiom context, and (for debug/runtime tasks)
  operational priorities, into one response.
- `open_agent_workbench` — the fuller product-level workspace for a task: orientation, file
  read plan, validation plan, and `signal_quality` (tells the agent when the underlying
  comprehension data — tests, patterns, idioms, invariants, purpose confidence — is thin, so
  it's treated as guidance rather than complete truth).
- `get_codebase_agent_rules` — turns the comprehension layer into a living, CAS-backed guide
  for how agents should work in *this* repository specifically.

## Honest limits

Every comprehension tool that reads AI-enriched prose carries `ai_enrichment` status
(`ready`/`pending`/`disabled`) — the deterministic structural facts are always complete and
immediate; the human-readable narrative may lag or, with no AI provider configured, stay
deterministic. Structural facts are the product; prose is flavor. See
`docs/AI-PROVIDER.md`. Coverage caveats (unanalyzed languages, analysis errors) are surfaced
directly in `get_product_map`'s `coverage_caveats` section rather than silently omitted.
