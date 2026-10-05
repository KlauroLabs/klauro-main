# SEMANTIC MODEL — Capability / Flow / Step / ICELOT / Code

Status: **authoritative doctrine (2026-07-13).** Complements
[cas/DETERMINISM-BOUNDARY.md](cas/DETERMINISM-BOUNDARY.md) (facts deterministic,
comprehension AI-only-or-throw — that boundary governs everything here).
This doc defines WHAT the semantic layers mean; the boundary doc defines WHO
(deterministic code vs AI) may author each part.

## The model in one line

```
Capability = purpose · Flow = behavior · Step = action · ICELOT = contract · Code = evidence
```

These are NOT increasingly summarized views of the call graph. They are
different semantic concepts grounded in the same observed evidence. The
program model (nodes/edges/routes/entities/exits) stays authoritative for what
EXISTS; the semantic overlay explains what it MEANS. Navigation must work both
ways: capability → flows → steps → code, and function → steps → flows →
capabilities. Bidirectional traceability is what makes the layer trustworthy.

## Capability — why the system exists

A capability is something the system was BUILT to enable for a user, operator,
customer, partner, or external actor. **The purpose test: would this appear in
a product description, user objective, business offering, or operational
responsibility?** "Trade cryptocurrency" passes. "Connect a wallet",
"Authenticate users", "Record telemetry" do not — they are supporting concepts
unless the product IS an auth/telemetry/wallet product (evidence-based
exception, never keyword-based).

Capabilities require BOTH bottom-up evidence (entry points, entities, terminal
effects, behavior families/registration surfaces) AND top-down evidence
(README/docs, product terminology, routes and UI labels, domain modules,
manifest description). Pure bottom-up clustering yields "Wallet interaction"
when the capability is "Trade cryptocurrency."

### Top-down evidence bundle + the purpose-test exclusion (C2)

The AI capability catalog receives a `top_down_signals` block alongside the
bottom-up facts. It carries the product's OWN words — README title + opening
overview (verbatim), manifest self-description, and product terminology (route-
area + journey names). These are Camp-B facts (extracted deterministically, like
any evidence) fed to the AI for comprehension; they are **evidence-gated** —
omitted entirely when the repo has no such text, **never fabricated**, and carry
no hardcoded product vocabulary.

Two forces the catalog contract must compose:

- **RAISE (top-down corroboration):** a capability named by the product's own
  title/overview/terminology is core even when the bottom-up entities under-
  represent it. This is how "Play Commander matches" surfaces for a game whose
  routes look like generic CRUD, and how the built-for capability outranks a
  bottom-up plumbing cap.
- **DEMOTE (the purpose-test exclusion):** a supporting/infrastructural concern
  (auth, access control/permissions, session, logging/telemetry, caching,
  brokering, generic CRUD, health, config, database) may be named a capability
  ONLY when `top_down_signals` shows the product IS that kind of product. Absent
  that evidence it is at most "supporting", never "core", and is usually
  dropped — so a codebase-analysis product never ships "Manage access and
  permissions" as a core capability. This is a PROMPT-CONTRACT rule keyed on
  top-down evidence, **not a hardcoded capability-name blocklist**; the
  deterministic `reconcileCatalogedCapabilities` purpose gate (entity KIND +
  shape) remains as a second, evidence-gated demotion of pure runtime anchors.

Capabilities do NOT carry ICELOT (too high-level to bind directly).

## Flow — a complete behavior of the system

An end-to-end semantic behavior from an initiating input/trigger through its
meaningful outcomes and side effects. A flow crosses layers, modules,
processes, queues, and sync/async boundaries as needed.

- **Flow = semantic step GRAPH** (branches, error paths, compensations,
  parallel work, async handoffs). The ordered step list shown to humans is a
  PROJECTION of that graph, not its structure.
- **Async continuation ≠ new flow.** An event publish consumed by a worker is
  a continuation segment of the same end-to-end flow (and may also be a
  reusable subflow). Relationships: a flow CONTAINS steps; a flow may INVOKE
  or CONTINUE THROUGH another flow (subflows / continuation flows / shared
  flows).
- **Flow roles are RELATIONAL, not intrinsic.** Role lives on the
  capability↔flow relationship edge, not the flow:
  `CapabilityFlowRelationship { capability_id, flow_id, role, rationale }`,
  role ∈ `primary | supporting | prerequisite | operational | administrative |
  recovery | observability | compliance | maintenance`. "Connect wallet" is
  supporting for Trade-crypto and primary for Manage-wallets, simultaneously.

## Step — the human-understandable action

A meaningful change in what the system knows, decides, validates, performs, or
produces. A step is NOT a function and NOT a summarized code block:

- **Step ↔ code is many-to-many. THIS IS ESSENTIAL.** One step may span
  several functions plus a branch inside another; one large function may
  contain several steps; a generic `authorizeRequest()` may serve hundreds of
  steps. A segmentation that emits one step per traced function (named
  "Process (fnName)") is a placeholder, not the model — a 30-line controller
  method that validates, mutates, and persists is THREE steps inside ONE
  function.
- **Framework semantics locate steps.** The framework layer already knows
  where the meaningful actions are: a validator/form boundary IS a Validate
  step; an ORM flush/save IS a Persist step (with a state-change effect); a
  serializer/response boundary IS a Respond step; a queue/messenger dispatch
  IS an async handoff. Framework-analyzer facts are first-class step-
  segmentation AND ICELOT-facet evidence, not just inventory.
- Mappings are typed: `StepCodeMapping { step_id, code_region, relationship,
  contribution, confidence }`, relationship ∈ `implements |
  partially_implements | initiates | completes | validates | branches |
  transforms | causes_effect | observes | handles_failure | provides_input |
  consumes_output`.

## ICELOT — the shared behavioral vocabulary below capability

`Input · Constraints · Effects (state + integrations) · Logic · Output ·
Telemetry`. Applies to flows, steps, and code units — everything BELOW
capability. Facets describe OBSERVED semantic traits; artificial completeness
is forbidden (a decision step may have no effects; telemetry-only steps exist).

ICELOT is **recursive and aggregatable, but each layer changes abstraction —
never a simple union**: a function's ICELOT is its local contract from code
evidence; a step's ICELOT combines and REFRAMES its mapped regions' facets in
human terms; a flow's ICELOT aggregates its steps and adds flow-level
semantics (initiating input, cross-step constraints, terminal effects,
end-to-end telemetry). Inheritance is evidence-backed, never automatic.

Per the determinism boundary: deterministic facets (Input=signatures,
Effects=writes/integrations from the graph, Output=return/produced entities,
Telemetry=observed calls) are Camp-B facts; Logic and interpretive reframing
are AI-only, evidence-gated, with provenance (`description_source`).

## Communication types — async / sync / passive (seam classification)

Every seam (integration/interface edge between components or systems) carries
one of three COMMUNICATION TYPES. These are semantic categories with different
consistency/staleness postures (the CAP trade-off lives here), not transport
labels:

- **Sync** — a direct call that triggers a synchronous process and waits on
  its result (HTTP/API call, RPC, SOAP, in-process request/response). The
  caller observes the effect immediately; failure is surfaced to the caller.
- **Async** — a message/event handed off fire-and-forget (queue publish,
  event dispatch, webhook emission, messenger/job dispatch). The effect
  happens LATER in a continuation flow (see Flow: async continuation ≠ new
  flow); failure handling is the consumer's contract, not the caller's.
- **Passive** — a data drop the downstream system simply expects to be there
  (Kafka/stream consumption, DB replication/WAL, shared tables/files, poll-a-
  bucket). No call happens at all; the interface IS the data. Staleness is
  intrinsic — reads are eventually consistent by construction.

ICELOT binds to this: a step/flow crossing an async seam carries the handoff
as an Effect (integration) and the continuation as flow structure; a passive
seam implies a `consistency` constraint on the READING side ("reads here may
be stale — data arrives by stream/replication"). A library-internal operator
call (rxjs `map`, ORM helper) is NOT a seam of any type — seams are
component/system boundaries, never in-library plumbing.

## Coverage invariants — "everything rolls up" must be measurable

Every non-orphaned executable unit should contribute to at least one flow
(many-to-many; participation in hundreds of flows is fine). Klauro exposes:

```
semantic_coverage: {
  reachable_code_to_steps,   // % reachable executable code mapped to ≥1 step
  steps_to_flows,            // % steps assigned to ≥1 flow
  flows_to_capabilities      // % meaningful flows related to ≥1 capability
}
unmapped: { code_units, steps, flows }   // honest lists, not just counts
```

Unmapped code indicates: missing semantics, generic infrastructure, dead code,
framework-generated behavior, incomplete extraction, or an undiscovered
capability/flow — each worth surfacing, none worth hiding. These metrics are a
release gate (like latency budgets): regressions fail the gauntlet.

## Evidence and confidence — everywhere

Every semantic object carries provenance: evidence refs into the code graph,
confidence, and (for AI-authored text) source stamps. A capability's evidence
is indirect — through its flows' steps' code evidence — but the chain must be
walkable. Models/passes may ABSTAIN; low-confidence results route to a
stronger model or honest absence, never a fabricated answer (boundary doc
rules apply).

### Confidence

Every capability and every flow carries `confidence`, a number in 0..1 at two decimals, computed from
signals the engine already holds. It reads how well the engine can stand behind the item; it never
removes one. The code is `confidence.rs`.

A flow is the mean of five signals, each in 0..1, so a flow scores 1.0 only when all five are full:

- resolution = 1 - 0.65 x (hops resolved only by name / hops); a hop is one call followed from the entry
  point and its edge `via` says whether it was proven by structure or matched on a name.
- completeness = max(0, 1 - 2 x open / (units + open)); `open` counts own calls the engine could not
  resolve, so they weigh against what was actually reached.
- standing = 1.0 terminal, 0.8 proximal, 0.55 reading, 0.3 open.
- mass = units / (units + 6), scaled so 30 reached units read 1.0; a flow that reached two units has
  seen very little.
- story = logical steps read / 4, capped at 1.0.

The mean is multiplied by 0.8 when the trail was cut.

A capability is 0.45 x grounding confidence + 0.35 x the mean confidence of the flows it delivers + 0.2 x
member count / (member count + 2), so a capability that is invented rather than supported, rests on weak
flows, or on a single flow reads low. When the grounding was not graded the grounding term is 0.5 and the
score is capped at 0.75. A capability marked parent-originated with no child capability behind it is
multiplied by 0.85. Any item whose AI ask stayed unanswered is multiplied by 0.5 and carries
`unsettled: "ai-unanswered"`. A well-evidenced capability reads about 0.8 to 0.95, a thin one 0.3 to 0.6.

## Implementation map (packets)

- B1 CapabilityFlowRelationship M:N + relational roles — replaces single
  `capability_id`; both directions serialized (flow.capability_relationships,
  capability.related_flows).
- B2 semantic_coverage + unmapped as product surface + gauntlet gate.
- C1 flow step-graph + async continuations + subflow relationships.
- C2 top-down capability evidence + purpose test in the AI catalog contract.
- D1 StepCodeMapping many-to-many + intra-function step segmentation
  (AI-proposed, evidence-gated).
- D2 ICELOT aggregation/reframe rules with facet provenance.
- E1 AI-decision instrumentation → versioned dataset (the future training
  corpus for a distilled semantic encoder; encoder training itself is
  DEFERRED until the dataset exists at scale).
