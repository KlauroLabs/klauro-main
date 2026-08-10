# SPEC — The Conceptual Understanding Layer

> **Status: DESIGN** as of 2026-07-03 (product-owner articulation). The unifying architecture:
> a **conceptual understanding layer laid over the raw index/call-graph**, so Klauro understands a
> codebase at **every level, angle, and perspective** — and that understanding powers the UI, agent
> work-alignment via MCP, and the coordination fabric. This is the moat: symbol indexes see the
> graph; Klauro sees the *concepts* the graph realizes.

## 0. The core idea

The index (files, functions, call graph, types) is the SUBSTRATE. On top of it we compute a
**conceptual layer** — the human/architect's mental model of the system — and we KEEP IT LINKED to
the substrate (every concept ties back to concrete nodes). Two kinds of breakdown, both over the
same index:

- **Behavioral hierarchy** (what the system DOES, as it runs): Capability → Flow → Step → Function.
- **Structural perspectives** (how the system is BUILT): architectural/principle concepts + paradigms.

Every level answers the same shape of question — **I/L/S/O + Constraints** — so understanding is
uniform from a single function up to a whole capability.

## 1. The behavioral hierarchy

```
Capability                       (high-level "what it does"; already computed — CAS, repo- or workspace-level)
  ├─ has: Flow[]                 (how a request/job moves through the system)
  └─ has: Entity[]               (the data entities involved)
Flow
  ├─ has: Step[]                 (ordered semantic stages — NOT raw function chains)
  └─ has: I/L/S/O + Constraints  (flow-level contract)
Step
  ├─ maps to Function(s):        1:1  |  1:many  |  a SUB-SECTION of a single function
  └─ has: I/L/S/O + Constraints  (step-level contract)
Function / sub-section           (the actual index / call graph node — the substrate)
```

- A **Capability** has multiple **Flows** and multiple involved **Entities**.
- A **Flow** = an ordered set of **Steps** (Validate → Charge → Persist → Notify), not a function chain.
- A **Step** ↔ functions is **1:1, 1:many, or even a sub-section of a single function** (a step can be
  just part of one function's body — segmented by side-effect/entity boundaries within the function).
- The bottom ties to the real index (function_id + optional `{start_line,end_line}` for sub-sections).

## 2. The uniform contract at every level: I/L/S/O + Constraints

For a **Flow** AND each **Step** (and, from get_interface_signature, each function):

- **Input** — data/params consumed (requires).
- **Logic** — the transformation / decision (the blackbox summary of what it does).
- **Side-effects** — split into TWO distinct kinds:
  - **state_changes** — DB writes, mutations, persisted-entity changes (internal state).
  - **external_integrations** — 3rd-party/API/queue/webhook/SDK calls (crossing the boundary).
- **Output** — data/entities produced.
- **Constraints** — **business rules / invariants / guards** enforced here (e.g. "amount > 0", "user
  must be authenticated", "order must be PENDING"). Derived from guard clauses, validation,
  assertions, gating conditionals.

This is the same I/L/S/O the whole product is built on (get_interface_signature → conceptual-conflict
→ intent-merge → and now flows), extended with **Constraints** and the **state-vs-external** split,
and lifted from the function level to the flow/step level by aggregation.

## 3. The structural perspectives (also over the index)

Orthogonal to the behavioral hierarchy — the same code, seen structurally:

- **Architectural / principle concepts** — layers, boundaries, SOLID adherence/violations, coupling,
  pattern conflicts. (Partly built: `get_architectural_conflicts`, pattern detectors.)
- **Paradigms** — OO / functional / procedural / reactive / actor, and conformance to them.
  (Partly built: `get_paradigm_conformance`.)

Together with the behavioral hierarchy: **every level (function→capability), every angle (behavioral
vs structural), every perspective (I/L/S/O/Constraints, architecture, paradigm).**

## 4. What it powers (why this is "true power")

The conceptual layer is not just comprehension — it's the substrate for coordination:

1. **UI** — navigate capability → flow → step → function; see each concept's I/L/S/O + Constraints;
   see the architectural/paradigm view. The mental model, made visible.
2. **Agent work-alignment via MCP** — agents coordinate at the CONCEPTUAL level: "I own the *Charge*
   step of the *Checkout* flow" / "I'm changing the *Order* entity's constraints" — not "I'm editing
   function X, lines 40-60". Higher-signal, human-legible, and far less collision-prone.
3. **The coordination fabric** — claims, conceptual-conflict detection, and the partitioner operate on
   flows/steps/capabilities, not just symbols. Two agents on the same *flow* but different *steps* is
   safe and legible; two agents on the same *step* is a real overlap. The fabric's grants and the
   conceptual-conflict detector gain a semantic vocabulary the fleet actually thinks in.

## 5. The moat

Every layer here is computed OVER the CAS semantic graph (repo- and workspace-level) + intent. A symbol index (git, editors,
codebase-memory) has the substrate but not the concepts — it cannot tell you a *flow's* constraints,
a *step's* side-effects, or which *capability* a change touches. This is comprehension at every level,
and it's what lets a fleet of agents align on *meaning*, not just files.

## 6. Status / roadmap

- **Behavioral: Capability** — computed (CAS, repo- or workspace-level). **Flow → Step (I/L/S/O + Constraints, sub-function
  sections, capability/entity linkage)** — BUILDING (`flow-concepts.ts` + `get_flow_concepts`).
- **Structural: architectural + paradigm** — partly built (`get_architectural_conflicts`,
  `get_paradigm_conformance`); to be unified under this layer's vocabulary.
- **UI** — surface the hierarchy + perspectives.
- **Fabric** — extend claims/conceptual-conflict/partitioner to the conceptual vocabulary (flow/step/
  capability granularity), so agents align on concepts.

Related: [[klauro-deployable-detection]], [[klauro-coordination-fabric]] (§ the fabric consumes this),
docs/SPEC-INTELLIGENCE-CAPITALIZATION.md (I/L/S/O origin), SPEC-COORDINATION-FABRIC-V2.md.
