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

## Audience and scope

A capability is an outcome the system's actual audience came to obtain. It must be recognizable at that audience's altitude and specific to this system. The audience is not always a non-technical end user. It can be an application developer using a library, an operator using an observability product, an agent using Klauro, or another service consuming an API.

Two quick tests reject most false capabilities:

1. **Audience test:** Would the intended audience recognize this as a reason to choose or use the system?
2. **Universality test:** Would the statement be equally true of most software? If so, it is probably infrastructure rather than product purpose.

The classification is scope-relative. Authentication is substrate in an online store and flagship behavior in an identity product. Logging is substrate in most applications and product behavior in an observability platform. Dependency registration is infrastructure in an application and can be the product of a dependency-injection library. No vocabulary list can decide this independently of audience, system boundary, graph position, and product evidence.

## Altitude model

Comprehension uses an altitude ladder so evidence is not promoted into a higher-order claim merely because it exists:

| Altitude | Question | Example |
| --- | --- | --- |
| Purpose | Why does the system exist as a whole? | Help people understand what a codebase actually built |
| Capability | What outcome can its audience obtain? | Know what will break before changing something |
| Flow | What complete behavior produces that outcome? | Assess a proposed change against affected behavior and tests |
| Step | What meaningful transition advances the flow? | Resolve the changed symbol to connected flows |
| Code and mechanism | How is the step implemented? | Traverse a reachability index |

An entity is not another altitude. It is a durable subject or object that participates across the ladder. A quality is a property such as privacy, speed, reliability, or self-hostability. A goal is a desired future or business result. Neither qualities nor goals are capabilities unless the product itself exists to deliver that outcome.

## Positive and negative examples

| Capability | Not a capability | Why the alternative fails |
| --- | --- | --- |
| Buy products | Checkout Controller, Cart Management, POST /orders | Component, CRUD noun, and endpoint |
| Get paid for a ride | Process Payment, Stripe Integration | Internal step and vendor mechanism |
| Find a place to stay | Listing Search Service | Component rather than audience outcome |
| Recover access to an account | Password Reset Flow, Token Validation | Flow and implementation detail |
| Understand what a codebase actually built | Run Analysis Layer, Get Idioms | Klauro tool names |
| Know what will break before changing something | assess_change_risk, Reachability Index | Tool and algorithm names |

The following shapes are presumptively not capabilities:

- tools, endpoints, functions, classes, files, and framework roles;
- artifact or data-structure names such as a CAS, claim, graph, or verdict;
- generic CRUD labels such as User Management;
- infrastructure such as caching, logging, repositories, service layers, and database access;
- universal abstractions such as Data Processing, Business Logic, or Integrate with external services;
- identifiers, paths, and generated stutters leaking into prose.

These are rejection defaults, not domain blacklists. A candidate can survive only when system purpose and evidence show that the supposedly technical behavior is itself what the audience came to obtain.

## Derivation pipeline

Comprehension is neither documentation-only nor graph-only. It is a reconciliation between product intent and implemented behavior:

1. **Establish membership.** Determine the shipped system boundary before interpreting it. Presence in the repository is insufficient. Production entry-point reachability, manifests, packaging, deployment configuration, imports, and runtime evidence distinguish product code from legacy code, examples, tests, vendored code, generated output, docs, and scaffolding.
2. **Propose top-down.** Extract audience, promised outcomes, product language, and system scope from README files, manifests, package metadata, product documents, user-facing copy, CLI help, agent instructions, and other authored signals. These sources propose capabilities; they do not prove implementation.
3. **Build bottom-up behavior.** Construct entities, entries, connected steps, constraints, effects, outputs, calls, and terminal states from the complete CAS. Routers, schedulers, render loops, and framework dispatchers identify boundaries but are not automatically flows.
4. **Ground proposals.** Require each proposed capability to resolve to one or more coherent implemented flows or equivalent behavior evidence. Routes and entities can support the proof but cannot independently name the outcome.
5. **Arbitrate altitude and purpose.** Use audience, boundary, dependency direction, terminality, repeated use across flows, and contradictory evidence to decide whether a grounded behavior is capability, supporting flow, shared step, entity operation, or mechanism.
6. **Report the reconciliation.** Preserve matches and mismatches instead of forcing a clean catalog.

The resulting states are first-class:

| Product proposal | CAS grounding | Interpretation |
| --- | --- | --- |
| Present | Present | Implemented capability |
| Present | Missing or insufficient | Intended, documented, or promised capability with an implementation gap |
| Missing | Present | Implemented but undocumented capability candidate |
| Missing | Missing | No claim |

A proposed capability with weak proof does not disappear. Its existence as product intent remains, while implementation confidence degrades. Likewise, a real implemented effect with an unresolved destination remains an effect with an unknown endpoint. Klauro degrades confidence or field precision, never the existence of observed evidence.

There is no minimum capability count. A small focused tool may have one. A broad platform may have many. Count targets incentivize CRUD inflation and mechanism promotion.

## Flow construction

A flow is a coherent end-to-end behavior with a trigger, meaningful transitions, and at least one terminal result. Its identity comes from what happens, not merely from the controller, job, route, or UI page that dispatches it.

A terminal result can be:

- a user-visible response or navigation result;
- an outbound effect;
- durable state change;
- meaningful in-memory domain-state change;
- a produced artifact, message, or command result.

Rendering a form is not evidence that the form's eventual mutation occurred. A GET page and the POST that creates a record are separate behaviors unless the graph proves a combined transaction.

Shared helpers belong in a flow only when they materially constrain, transform, decide, or effect that behavior. Translation lookup, sidebar counters, formatting, tracing wrappers, and generic framework dispatch should not make otherwise different flows appear identical. They remain linked as supporting code and can still matter for change risk.

Flow paths are canonical evidence projections, not an expansion of every combinatorial route through the graph. Every reachable terminal must remain represented, while alternate routes remain losslessly queryable as CAS edges. Structural relationships such as dependency, use, and implementation links remain in CAS but do not masquerade as execution steps.

Flows may support several capabilities, and one capability may require several flows. Flow identity must therefore remain independent of capability naming.

## Step construction

A step is a behavior-relevant transition inside a flow. It can consume input, enforce a constraint, make a decision, transform domain state, cause an effect, or produce an output. It is not synonymous with a function call.

Step boundaries should preserve:

- the actor-visible or domain-relevant action;
- the input and preconditions;
- the affected entities;
- the effect or state transition;
- the resulting output or handoff;
- exact source provenance.

Several functions can implement one step, and one shared function can participate in several steps. Plumbing remains reachable beneath the step without being promoted into the behavioral narrative.

## Entity role

Entities are durable subjects, objects, concepts, messages, artifacts, or stateful records that flows create, transform, inspect, communicate, or retire. They help connect product language to implementation, but an entity plus CRUD verbs is not automatically a capability.

Entity evidence is strongest when multiple signals agree: persistence, contracts, validation, state transitions, relationships, messages, user-visible language, and flow participation. Generated schemas, vendor models, documentation markup, and unreachable legacy types must not inflate the product entity inventory.

## Special system shapes

- **Libraries and developer tools:** the audience is a developer; technical-looking outcomes may be legitimate product capabilities.
- **Samples and demos:** report the behavior the sample depicts and separately identify its sample quality. Do not describe the example as a full production product.
- **Content and build repositories:** producing, validating, or publishing an artifact can be the audience outcome.
- **Infrastructure products:** provisioning, observing, routing, or securing systems can be product behavior when that is what the audience acquires.
- **Recursive workspaces:** derive parent capabilities from child facts and seams; never union child labels.

## Computational contract

Optimization cannot change semantic coverage. Cold analysis discovers the complete in-scope ship unit. Indexing and caching may avoid repeated parsing, and later stages may operate on dependency-closed worksets, but no stage may silently omit a file, language, flow, entity, or effect because of a memory or time budget.

Large evidence collections may be chunked, streamed, indexed, compressed, deduplicated, or spilled from memory. Their identifiers, counts, provenance, uncertainty, and recoverability must survive. Summaries accelerate candidate ranking and warm queries; they are not substitutes for the underlying CAS evidence.

Failing to complete a required tier is an explicit incomplete analysis, not a smaller successful analysis.

## Acceptance and scoring

Comprehension quality is measured against authored outcome targets and source-grounded behavior, not catalog size. A representative scoreboard should cover applications, libraries, tools, infrastructure, samples, content systems, and multi-repo workspaces.

For each system, measure:

- capability precision: published outcomes that pass audience and evidence review;
- capability recall: expected product outcomes that are grounded or honestly reported as gaps;
- intent reconciliation: proposed-and-grounded, proposed-and-ungrounded, and grounded-and-unproposed results;
- flow fidelity: distinct behaviors remain distinct and terminate at their real results;
- step signal: behavior-relevant transitions dominate shared plumbing;
- entity precision and coverage;
- membership precision: legacy, generated, vendored, test, and documentation material do not become product truth;
- citation validity and reference resolution;
- repeatability across cold runs;
- latency and peak memory without scope reduction.

The acceptance set must include adversarial scope-relative pairs, such as authentication as substrate versus authentication as product. Repository-specific allowlists and expected names cannot appear in production inference.

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
