# The abstraction tiers

**Status:** model definition. Owner-defined 2026-08-09; elaborated here.
**Purpose:** define what each tier contains, what it may depend on, and what it must never do. This is a structural contract, not a pitch.
**Normative counterpart:** `docs/cas/SPECIFICATION.md` (v2.0.0) is the normative spec for the recursive CAS structure. Its §0 covers the naming decision, the no-closed-type-vocabulary argument, the derivation gradient, and inter-sub-CAS-node seams; its §0.5 restates the Tier 1-4 model this document is the rationale behind. Read this document first for *why* the tiers are shaped the way they are, then `docs/cas/SPECIFICATION.md` §0 for the conformance-level contract.

```
      /        Action / Collaboration / Fabric          \     tier 5
    /            Realtime Telemetry                       \   tier 4
  /          Comprehension / Understanding                  \ tier 3
 /        Framework / Architecture / Library                  \ tier 2
/        Index / ICELOT / Visibility / Graph                    \ tier 1
```

## The one rule that makes this a contract

**A tier may consume any tier below it. A tier may never consume a tier above it, and may never be synthesised from one.**

Violations of that rule are the defect class this model exists to prevent. Two proven examples from the last 48 hours, both real:

- `determineSystemType` decided `service` / `library` / `application` from **tier-1 node-type labels** (`controller`, `component`, `package`). That is a tier-3 claim reading tier-1 data and skipping tier 2 entirely. Consequence: every framework-less HTTP server — Go `net/http`, and any Java or Go repo — classified as a **library**, because a `@Controller` annotation is a tier-2 fact and Go has none. A real Go feed reader with **175 HTTP entry points** was reported as a library. Fixed by deriving from entry-point and ship evidence.
- Capability candidates were generated from entry points and persisted entities only, with **no consumption of outbound dependency roles**. A Go feed reader's ~20 third-party integrations — a tier-2 fact — never became capability candidates. Consequence: a feed reader whose capability list omits reading feeds and every integration.

Both are the same shape: **tier 3 reached past tier 2**, and the answers were wrong in a way no amount of AI quality could repair, because the evidence never arrived.

---

## Tier 1 — Index / ICELOT / Visibility / Graph

**Contains.** Nodes (units of code), edges (`contains`, `calls`, `imports`, `references`, `invokes`, `tests`), entry points, exit points, and the ICELOT facets per unit: **I**nput, **C**onstraints, **E**ffects, **L**ogic, **O**utput, **T**elemetry.

**Character.** Language-level, framework-agnostic, deterministic. Two runs over identical input produce byte-identical output.

**Invariants.** Every edge endpoint resolves to a known id. Ids are content-derived, not positional. File ordering is stable, so emission order is stable.

**What it must not do.** No interpretation. This tier records that a function calls another function; it does not know that one is an HTTP handler.

**What it cannot answer, by construction.** "Is this a controller?" "Is this an ORM entity?" "What architecture is this?" Those require conventions, which is tier 2.

**A necessary disambiguation.** ICELOT's `T` is **declared** telemetry — what the code emits: log sites, metric registrations, span creation. That is a static fact about source. It is *not* tier 4, which is observed runtime behaviour. Conflating them is a category error: one is "this code can report X", the other is "X happened 400 times yesterday".

---

## Tier 2 — Framework / Architecture / Library

The **convention** tier. It maps raw structure onto ecosystem meaning. This is the tier most often skipped, and skipping it is what produced both defects above.

**Contains, in four groups:**

1. **Framework identification and role** — which frameworks are present, at what version, serving what purpose (web, ORM, DI, test, build, queue).
2. **Framework-conferred node roles** — the meaning a convention assigns to a unit: route handler, controller, persisted entity, migration, scheduled job, event listener, gateway, middleware, guard, resolver. *This is where `@Controller` and Go's `http.HandleFunc` must resolve to the same role.* A role must be reachable without a framework, from structural evidence alone, or every framework-less codebase falls through.
3. **Library and dependency roles** — what each third-party dependency *does*: HTTP client, database driver, cache, message broker, payment SDK, observability agent. This is the tier that makes **integrations** visible as behaviour rather than as import statements, and it is the missing input behind the capability-substance defect.
4. **Architecture and principles** — the paradigm in use (layered, hexagonal, MVC, microservices, event-driven, modular monolith), the component kinds that paradigm implies (services, repositories, handlers, adapters), the idioms and conventions actually followed, and the health of that adherence: violations, overlap, drift.

**Depends on.** Tier 1 only.

**What it must not do.** No product meaning. This tier knows a class is a persisted entity; it does not know the system's capabilities. It also must not encode brand or domain vocabulary — a framework identifier is a structural fact (a package name in a manifest, a decorator import), whereas a business-domain word list is not.

**Why it is a tier and not a detail.** The same tier-1 shape means different things in different ecosystems, and product meaning is not derivable from syntax. Without this tier, tier 3 either guesses or reads tier-1 labels that happen to exist in some ecosystems and not others — which is precisely how one language family got misclassified wholesale.

---

## Tier 3 — Comprehension / Understanding

**Contains.** **Capabilities** (what the system is for), **Flows** (the ways through it; most roll up to capabilities, some are legitimately isolated), **Steps** (a step may span many functions, one function, or part of one — many-to-many with code in both directions), **Entities** (the domain things the system holds).

**Depends on.** Tiers 1–2. A capability anchors to operations whose *role* is known; an entity is persisted because a tier-2 persistence fact says so, not because it sits in a directory called `entities`.

**What it must not do.** No coordination, no proposals, no runtime claims. And it must never manufacture members to look complete — a system whose honest answer is four capabilities gets four.

**Its failure mode.** Generic output. "Analyze / manage projects / track" describes any code-analysis tool and therefore describes nothing. This tier is the one a user actually reads, so its failures are the visible ones.

---

## Tier 4 — Realtime Telemetry

**Contains.** Observed runtime behaviour, attached to the comprehension model: which flows actually execute and how often, real latency and error rates per step, which capabilities are exercised versus dormant, which paths are dead in production despite existing in source.

**Depends on.** Tiers 1–3, and *necessarily* on 3: a span or log line is only meaningful once it can be attached to a step, flow, or capability. Without tier 3, telemetry is a metrics dashboard — a commodity. **The attachment is the value, not the collection.**

**What it adds that static analysis cannot.** Confirmation or refutation of the static model. Static reachability says a path *can* execute; telemetry says whether it *does*. That converts blast radius from a set into a **weighted** set, which is what makes risk assessment credible.

**What it must not do.** It must not silently overwrite static facts. A path unobserved in production is not proof of dead code — it may be seasonal, or behind a flag, or simply not yet exercised. Telemetry annotates; it does not delete.

**Distinct from ICELOT's `T`.** Tier 1 records the *capacity* to report. Tier 4 records *reports*. Both are needed and they are not the same field.

---

## Tier 5 — Action / Collaboration / Fabric

**Contains.** Proposals and edits, work claims, conflict and collision detection, blast-radius-aware parallel planning, multi-agent and multi-human coordination.

**Depends on.** Tiers 1–3, and is materially better with 4.

**Explicitly an overlay, not part of the analysis structure.** The analysis is the substrate; fabric is informed by it and stored separately. This keeps the substrate reusable and keeps coordination state — which is volatile, multi-writer and short-lived — out of a structure that must be deterministic and reproducible.

**Why it cannot exist without tier 3.** "Are we conflicting?" is unanswerable at tier 1. Two agents editing the same file may be doing unrelated work; two agents editing different files may both be changing one capability's behaviour. Only comprehension distinguishes those. Without it, coordination degrades to file diffing, which version control already provides for free.

**The corollary.** Fabric inherits the quality of tier 3 exactly. Conflict detection keyed on generic capabilities detects conflicts between meaningless labels. Comprehension quality is therefore not polish beneath the coordination story — it is its precondition.

---

## Cross-cutting concerns (not tiers)

These apply at every tier and must not be modelled as one:

- **Provenance and evidence.** Every derived claim cites what produced it. This is what allows a wrong claim to be traced rather than argued about.
- **Determinism.** Tiers 1–2 must be reproducible byte-for-byte. Tiers 3–4 involve interpretation and observation and cannot be, so their variance must be *measured* rather than assumed away.
- **Freshness.** Every tier records what input version it reflects. A stale tier-3 claim over a moved tier-1 graph is worse than no claim.
- **Refusal over fabrication.** At every tier, absent evidence yields an honest gap, never a synthesised answer. This has to be a tier-crossing rule because the failure recurs at each one independently.

---

## What the CAS already carries that these five tiers do not place

Checked against the real field set in `cas.types.ts`, not from memory. Five surfaces exist in the structure and have **no home** in the five-tier model as written. Each needs a decision; none of them is a defect in the CAS, they are gaps in the model.

### A. The temporal axis — history, churn, age, co-change

Fields: `churn_metrics`, `age_analysis`, `age_context`, `author`, `base_commit`, contributor facts, and the change-activity surface the product meeting explicitly asked for.

**This is not a tier — it is a second evidence axis, orthogonal to the five.** History informs every tier: it weights tier-2 conventions (which idiom is current versus legacy), tier-3 capability importance (what is actively developed), and most concretely **tier 5** — co-change probability is what turns fabric collision detection from "these overlap structurally" into "these historically change together". The math spec already treats co-change as a predictive input for exactly that.

Proposal: model it as a **cross-cutting axis** (like provenance and freshness), not a tier, and require that any tier consuming it cite it. Modelling it as a tier would wrongly imply the tiers above cannot see it.

### B. Derived graph metrics — importance, reachability, communities, call chains

Fields: `structural_importance_meta`, `reachability_index`, community/cluster output, `call_chains`, `call_chain_depth`.

These are computed **purely from tier 1**, with no conventions involved — so they are not tier 2, but they are not raw graph either. They are derived structure.

Proposal: a **tier 1 sub-layer** (call it 1b, derived graph), explicitly downstream of the graph and upstream of everything else. This matters practically: `reachability_index` already serves both product blast radius and fabric collision detection, which means a tier-1b artifact is being consumed directly by tier 5 — legal under the dependency rule, but only if 1b is named.

### C. Risk, security, health, and quality judgments

Fields: `change_risks`, `change_risk_summary`, `bypass_risks`, `architectural_conflicts`, security boundaries and summary, `assumed_vs_enforced`, `actual_protections`, coverage gaps.

These are **assessments across tiers**, not contents of one. A security boundary is partly tier 2 (auth middleware is a framework-conferred role) and partly tier 3 (which capabilities sit behind it). A change risk needs tier 1b (reachability), tier 3 (what breaks), and ideally tier 4 (is it hot in production).

Proposal: treat as **derived views over tiers, computed at read time and never stored as ground truth** — with the tiers they consumed cited. The failure mode to avoid is a risk score that outlives the facts that produced it.

### D. Journeys and workflows — resolved (owner, post-2026-08-09)

Fields: `entry_point_flows`, `workflows`, both populated today, both distinct from `flows`.

The comprehension layer was defined as four members: capabilities, flows, steps, entities. So either journeys and workflows are **a fifth member**, or they are **projections of flows** at a different granularity (a journey being a user-visible flow sequence, a workflow being an operational one). Today they are separate builders producing separate output, which suggested members — until the evidence was checked.

**Decision: journeys and workflows collapse into flows.** There is no fifth comprehension member. `CASWorkflow` carries `entry_points`/`call_chains`/`exit_points`/`entities_touched`/`services_used`/`classification`/`criticality` — that is a flow one granularity coarser (`call_chains` where a flow has steps), and an earlier audit found "414 workflows with 0 steps". `CASEntryPointFlow` adds only `kind` (`user-facing`/`system`/`scheduled`), per-step `layer` and `depth`, `boundaries`, and `tests` — and `kind` is derivable from entry-point kind, while `layer` is a tier-2 node-role fact. So: **one comprehension member for paths (flows)**, with journey/workflow-shaped fields as derived facets over that one member, and "journeys" / "workflows" become **named views**, not separate builders or separate stored members.

**Rationale.** Three parallel representations of paths mean three builders that can disagree, and that exact failure already shipped: one API response contained two capability lists disagreeing on count and quality. Collapsing to one member with derived views removes the class of defect, not just this instance of it.

**Pre-work required before removal.** Check consumers of `entry_point_flows`/`workflows` — the journey builder, the product map, and any UI surface — before removing the separate builders, since a consumer may depend on journey-specific fields (`kind`, `layer`, `depth`, `boundaries`, `tests`) that must be preserved as derived facets on flows rather than silently dropped.

This resolves the open question this section originally posed. `docs/cas/SPECIFICATION.md` §0.5.1 restates the same decision in the recursive-CAS context: journeys and workflows are derived views over `flows`, not a fifth comprehension member.

### E. Agent-facing knowledge

Fields: `codebase_idioms`, `behavioral_invariants`, `agent_guidance`, `agent_value`, test knowledge (`bdd_steps`, `assertions`, test discovery).

This is knowledge that exists **to make tier 5 act correctly** — how this codebase writes things, what must remain true, where the tests are — but it is not coordination state, so it is not tier 5, and it is not product meaning, so it is not tier 3.

Proposal: idioms and conventions belong in **tier 2** (they are conventions, which is that tier's definition). Behavioral invariants and test knowledge are better modelled as **tier-3 assertions about the comprehension model** — an invariant is a claim about a capability's behaviour. `agent_guidance` is a **read-time projection**, not stored ground truth.

### And one cross-cutting addition

**Semantic retrieval** (embeddings, search indices) is infrastructure over every tier, like provenance and freshness — not a tier. Listing it prevents someone modelling "search" as a layer.

---

## Implementation sequencing: god-file decomposition follows tier boundaries — resolved (owner, post-2026-08-09)

**Decision.** File decomposition is sequenced by tier boundary, and it is sequenced *before* the recursive CAS structure (`docs/cas/SPECIFICATION.md` §0) is built, not after.

**Evidence.** 6 files hold 70,542 of 548,471 source lines; `orchestrator.ts` alone is 31,353. Both tier-skip defects cited at the top of this document (`determineSystemType` reading tier-1 labels; capability generation never consuming tier-2 dependency roles) were possible *because* tiers 1, 2, and 3 share one file with no import boundary between them — nothing at the file level stopped a tier-3 code path from reaching into tier-1 data.

**Why this is sequenced where it is.** Splitting by tier makes the cleanup and the dependency-rule enforcement (the one rule at the top of this document) the same piece of work: decomposing `orchestrator.ts` and its five siblings along tier lines, with a lint/import-boundary gate so a tier-3 module cannot import a tier-1 module's internals directly, turns "a rule stated in prose" into "a rule a build fails on." That gate is cheap once the files are split and meaningless before they are.

It is sequenced **after** beta-blockers (this is not itself a beta blocker) but **before** the CAS recursion in `docs/cas/SPECIFICATION.md` §0 is built, so that recursive composition (§0.6 of that document — the derivation gradient) is not layered on top of a monolith that the tier-ordering rule cannot yet be mechanically enforced against. Building recursion first would mean composing CAS nodes over code that still lets tier 3 read past tier 2 undetected — the same defect class this document exists to prevent, now with more nodes to hide in.

## Where each tier's defects show up

Useful for triage, because a symptom's tier is usually not where it was caused:

| symptom the user sees | tier that caused it |
|---|---|
| dangling edges, unstable output, missing files | 1 |
| a framework-less service called a library; integrations invisible; wrong architecture paradigm | 2 |
| capabilities that describe plumbing; flows with no steps; UI types in the ERD | 3 |
| "unused" code that is actually hot; risk scores that ignore real traffic | 4 |
| duplicate work between agents; missed conflicts; stale claims | 5 |

The rule of thumb: **a wrong answer at tier N is usually a missing input from tier N−1.**
