# The Comprehension Framework

Klauro does not stop at files, symbols, and call graphs. It builds an evidence-backed model of why a software system exists, what complete behavior it provides, how people experience that behavior, and which code implements it.

## Canonical model

Comprehension contains exactly four members:

| Member | Question it answers | Required grounding |
| --- | --- | --- |
| Capability | Why does this product exist? | Product behavior supported by entities, flows, entry points, effects, and structural evidence |
| Flow | What complete behavior runs through the system? | A connected behavioral path with entry, steps, effects, outputs, and code evidence |
| Step | What meaningful action occurs within a flow? | One or more code slices, with many-to-many mappings allowed |
| Entity | What does the system exist to manage, produce, transform, or communicate? | Type, persistence, contract, state, message, or other structural evidence |

Capabilities are not technical mechanisms, routes, CRUD labels, framework names, repositories, or templates dressed up as product language. Their names and descriptions should read as if a product manager wrote them, while every claim remains traceable to real evidence.

Journeys, workflows, scenarios, use cases, and processes are read-time projections over flows. They are not separate persisted builders and cannot become competing sources of truth.

## Bidirectional understanding

The model supports both directions:

- capability → flows → steps → code;
- code → steps → flows → capabilities;
- entities ↔ flows and capabilities;
- tests, risks, runtime observations, and in-flight Fabric work back to every affected level.

Every reference must resolve inside the CAS slice that carries it. Missing or uncertain mappings remain explicit rather than being patched by a frontend or guessed at query time.

## ICELOT below capability

ICELOT gives code units, steps, and flows one behavioral vocabulary:

- Input
- Constraints
- Effects
- Logic
- Output
- Telemetry

The abstraction changes at each level. A function may accept a request object; a step accepts a user's submitted details; a flow accepts the conditions required to complete the product behavior. Aggregation preserves evidence and provenance rather than concatenating prose.

Capabilities state purpose and do not carry ICELOT. Static telemetry declarations belong to Tier 1 ICELOT. Observed runtime telemetry belongs to Tier 4 and can roll up through flows to capability-level operational status without becoming ICELOT on the capability itself.

## Terminality and purpose

Terminality is a general graph signal, not an entity-only heuristic.

- A terminal entity is at the end of a dependency or transformation chain.
- A proximal-terminal entity is close to that end.
- A terminal flow depends on few or no later flows for its reason to exist.
- A terminal capability or CAS node occupies the corresponding position in its dependency graph.

Terminal and proximal-terminal elements are often what the codebase was built for. Prerequisites tend to sit earlier in the graph. Authentication therefore ranks as supporting behavior in most products because many later flows depend on it. In an authentication product, authentication itself becomes terminal and correctly ranks as purpose.

Terminality proposes and ranks candidates. It cannot override contrary evidence or fabricate a capability.

## Recursive reframing

Every CAS level derives comprehension for its own purpose. A repository child may expose payment authorization and ledger posting as separate capabilities. A parent workspace may frame those facts as merchant settlement because that is the behavior created by the children together.

Parent comprehension is never a union of child labels. It derives from complete child CAS facts, direct-child seams, entities, flows, contracts, terminality, and orphan evidence. Provenance links the parent claim back to the child facts that support it.

## Deterministic and AI responsibilities

Deterministic analysis establishes the admissible evidence: source graph, entry and exit points, framework roles, entities, flows, effects, dependencies, seams, terminality, and grounding candidates. AI may synthesize and refine product-language comprehension from that evidence.

AI does not get to invent substrate. Quality gates reject ungrounded targets, mechanism-shaped capabilities, collapsed catalogs, cross-domain leakage, dangling references, and descriptions that fail to bridge product language back to cited evidence. If enrichment cannot meet the bar, Klauro reports degraded or unavailable narrative honestly.

## Runtime and Fabric overlays

Runtime observations annotate flows, steps, code, and capability operational status. They do not overwrite static comprehension. Unmatched runtime evidence remains visible and can backfill when a later analysis provides the missing static target.

Fabric represents each participant's in-flight semantic deltas against the same comprehension model. That lets Klauro surface two people recreating the same capability in different files, changing the same flow in compatible ways, or diverging on a shared contract before either change is complete.

## Agent use

Agents should begin with analysis resolution and start context, request a task-specific tool plan, and then retrieve agent context. For edits, coding context narrows relevant files, tests, invariants, risks, idioms, connected flows, and capabilities before source inspection.

Useful surfaces include:

- `resolve_agent_analysis` and `get_agent_start_context` for orientation;
- `get_agent_tool_plan` and `get_agent_context` for task-specific comprehension;
- `run_answer_pack` for evidence-backed explanations;
- `get_coding_context`, `assess_change_risk`, `find_tests`, `get_behavioral_invariants`, and `get_codebase_idioms` before edits;
- `validate_behavioral_invariants` and `validate_codebase_idioms` after edits;
- workspace analysis and context tools for behavior spanning multiple repositories.

If CAS lacks evidence or readiness fails, the agent reports the gap and falls back to targeted source reading. It does not silently treat an incomplete graph as complete.
