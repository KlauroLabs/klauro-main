# Klauro Architecture

## Product boundary

Klauro is the understanding and visibility layer for any software system. It turns source, conventions, runtime observations, and concurrent work into one trustworthy Code Analysis Specification graph. Software built heavily with AI may need that visibility more urgently, but it is not a separate category and does not define the product boundary.

The same CAS truth serves two sibling surfaces:

- MCP and CLI give agents bounded, evidence-backed context before they inspect source broadly.
- The designed human UI will visualize the relationships CAS already provides and will not infer missing graph structure in the browser.

## The recursive CAS chain

A CAS is both an analysis result and a composable node. A source-backed leaf derives facts from code. A parent contains complete child CAS objects, derives relations between its direct children, and reframes comprehension for its own purpose. That parent can itself become a child of another CAS. The chain has no prescribed depth or closed vocabulary of repository, deployable, domain, workspace, or organization levels.

`CAS.children` is the recursive truth. A leaf omits it. Every non-leaf declares `composition_mode`. The conformance validator rejects cycles, duplicate identities, invalid parent links, empty child arrays, missing graphs, and invalid leaf or parent composition state without imposing a depth maximum.

Parent composition preserves child evidence rather than flattening it away. Parent graphs contain direct-child CAS nodes and evidence-backed inter-child relations. Parent comprehension is derived again from child facts and relations; capability and flow labels are never concatenated into a new supposed truth.

## Analysis tiers

Each tier may depend only on tiers below it.

| Tier | Responsibility | Evidence character |
| --- | --- | --- |
| 1 | Source index, syntax, nodes, edges, entry and exit points, static ICELOT evidence | Deterministic source evidence |
| 2 | Language, framework, library, architectural, and repository-local conventions | Deterministic interpretation of Tier 1 |
| 3 | Capabilities, flows, steps, entities, purpose, terminality, and comprehension | Evidence-grounded interpretation of Tiers 1–2 |
| 4 | Observed runtime behavior and correlation back to static and comprehension facts | Persisted runtime evidence |
| 5 | Fabric awareness, in-flight semantic state, collaboration, and reconciliation | Participant-attributed live evidence |

Analyzer-core has an exhaustive production-module registry and import-boundary gate. MCP analysis, telemetry, and Fabric have corresponding boundary checks. An unregistered module or an upward dependency fails verification.

## Comprehension

Comprehension has exactly four canonical members:

- Capabilities describe why the product exists in language a product manager could use.
- Flows describe complete behavior through the system.
- Steps describe human-meaningful actions inside flows and map many-to-many to code.
- Entities describe the things the system exists to manage, produce, transform, or communicate.

Journeys, workflows, scenarios, and process views are projections of flows rather than additional persisted truth models. Navigation is bidirectional from capability to code and code to capability. Names and descriptions require structural grounding and cannot be generated from a repository-specific vocabulary, a template, or a hardcoded domain list.

## ICELOT

ICELOT is the shared behavioral contract below capability:

- Input
- Constraints
- Effects
- Logic
- Output
- Telemetry

It applies to code units, steps, and flows, changing abstraction as facts aggregate upward. Every facet retains provenance. The telemetry facet records statically declared observability such as logs, metrics, and spans. Tier 4 separately records what was actually observed at runtime; static declarations are never presented as observations.

## Terminality

Terminality is a relational signal for discovering purpose. A terminal entity is at the end of a dependency or transformation chain; proximal-terminal entities are close to that end. Those entities are often what the system was built to produce or manage. The same reasoning applies to flows, capabilities, and recursive CAS nodes.

A flow that few or no other flows depend on is a stronger purpose candidate than a prerequisite used by many later flows. Authentication is therefore normally supporting behavior. In a product that exists to provide authentication, authentication becomes terminal and correctly ranks as purpose. Terminality informs candidate generation and ranking but cannot override contradictory evidence or fabricate meaning.

## Fabric

Fabric enables realtime collaboration on any semantic unit, including overlapping concepts, files, functions, entities, flows, contracts, and capabilities. Overlap is normal input, not a condition to prevent.

Fabric maintains continuously updated participant-attributed in-flight CAS streams. It shares relevant knowledge while work is happening, detects duplicated or recreated concepts even when they occur in different files, surfaces contract and behavioral divergence, and preserves both sides of overlapping changes. Claims are awareness metadata and never locks. The design target is continuous reconciliation that drives surprise, lost work, and discretionary merge decisions toward zero.

Local and remote stores expose the same state model. Subscriptions deliver updates across processes and machines. Cumulative metrics report attribution loss, merge decisions, surprise, and reconciliation behavior rather than treating collision avoidance as success.

## Runtime truth

The JavaScript/TypeScript and Python SDKs emit the canonical runtime-event contract through framework middleware or manual instrumentation. Hosted ingestion persists events even when analysis is absent. Correlation later backfills events to static ids, nodes, entry and exit points, steps, flows, and capabilities.

Runtime evidence annotates static analysis; it never overwrites it. Unmatched observations and static/runtime disagreement remain queryable because disagreement is useful evidence about analysis gaps, dead paths, configuration drift, or unobserved behavior.

## Active code layout

- `packages/analyzer-core/` owns parsing, CAS construction, framework and library semantics, recursive composition, comprehension, ICELOT, terminality, incremental reuse, and semantic validation.
- `apps/mcp-server/` owns the installed CLI/MCP product, hosted analyzer service, account and project binding, source submission, workspace analysis, Fabric, runtime ingestion, proposal previews, and release artifacts.
- `packages/klauro-sdk-js/` and `packages/klauro-sdk-py/` own supported runtime telemetry clients and middleware.
- `legacy/` is reference material and is not an active customer API, schema, or UI.

## Installed and hosted boundary

The installed product is a thin CLI and MCP client. It resolves account and project identity, filters and submits source, caches bounded CAS responses, configures coding agents, supplies task context, and participates in Fabric. Analyzer implementation stays on hosted or self-hosted analyzer infrastructure.

The platform executables are checksum-verified and carry source revision, version, build time, and analyzer fingerprints. The npm artifact is a dependency-free fallback. Hosted and installed MCP contracts are tested for parity, pagination, actionable errors, and stale-client behavior.

## Performance model

Parsing uses tree-sitter or equivalent native parsers where available. Graph derivation uses indexed traversals, strongly connected component condensation, stable fingerprints, and cached unaffected layers. Incremental analysis invalidates the smallest evidence-connected scope possible instead of repeating the entire repository pipeline.

Performance is verified with deterministic small and medium budgets, edit-locality benchmarks, scale and survivability gates, and Linux/VPS runs. A fast answer that silently loses relationships is a failure; response bounds always disclose totals, pagination, and truncation.

## Acceptance evidence

`docs/PRODUCT-READINESS.md` is the non-UI beta contract. It requires direct proof for recursive CAS, tier boundaries, comprehension, ICELOT, terminality, runtime telemetry, Fabric, installed agent workflows, distribution, generality, code quality, and performance. Historical audits remain evidence of what was true when written, but they do not override current source, current tests, or that readiness matrix.
