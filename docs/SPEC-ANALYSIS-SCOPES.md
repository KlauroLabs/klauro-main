# Analysis Scopes — one recursive structure replacing CAS / WAS / DAS

**Status:** extracted from a 2026-08-09 product meeting transcript. Model captured; NOT yet built.
**Supersedes (when built):** `docs/cas/SPECIFICATION.md`, `docs/was/SPECIFICATION.md`, `docs/das/SPECIFICATION.md` as three separate structures.
**Normative counterpart:** `docs/analysis-scope/SPECIFICATION.md` (v2.0.0) is the normative spec for the `AnalysisScope` structure this document motivates — §4 (the envelope, no-type-vocabulary), §10 (recursion and composition), and §11.10 (scope structure invariants) are this document's §1a, §7a, and §2/§8 respectively, formalized. Read that specification for the conformance-level contract; read this document for the model and rationale behind it. See also `docs/SPEC-ABSTRACTION-TIERS.md`, the companion document for the three-tier (soon four-tier) abstraction pyramid this document's §3 restates in the scope-recursion context.

---

## 1. The naming problem

The meeting called this "the never-ending structure" and explicitly asked for a better name. Proposed:

**Analysis Scope** — the unit. Scopes nest. Every scope carries a full analysis of the same shape.

Rejected alternatives and why: *fractal analysis* (evocative but says nothing about the unit), *analysis tree* (implies one tree per account rather than a shape), *layer* (collides with the existing L0/L1/L2 progressive-delivery layers and with the four-layer stack below — the meeting itself slipped between "layer" and "level", which is a warning sign).

Naming rule from the meeting, verbatim in intent: **do not call it "workspace analysis" or "codebase analysis" — just an analysis.** A user should not have to learn three words for one thing.

---

## 1a. NO SCOPE TYPE — the structure is derived, not declared

A first draft of this spec gave each scope a `scope_type` enum (`organization | domain | project | deployable`). **That is wrong and it is rejected.**

An enumeration of levels is a closed vocabulary: the moment someone has a subdomain, a squad, a bounded context, a region, a tenant, or a business unit, the enum needs a code change, a schema migration, and a decision about which existing name is "close enough". It is the same defect class as the ~30 hardcoded vocabulary tables removed from this codebase on 2026-08-07/08 — a fixed list standing in for evidence — and it contradicts the whole point of an unbounded structure.

### What a scope actually carries

```
id
parent_id            nullable; absent = a root
label                the USER'S word for this level — "Organization", "Domain",
                     "Squad", "Region", anything. Free text. The product never
                     switches on it, only displays it.
```

Everything the product needs to *behave* differently about is **derived from structure**:

| derived property | how it is established | what it drives |
|---|---|---|
| `has_children` | any scope names this one as parent | system map (§4) |
| is a leaf | `has_children == false` | architecture map (§4) |
| source-backed | the scope has its own file set | whether analysis runs on source or composes children |
| ship-backed | deployable evidence exists (Docker ENTRYPOINT, packaging plugin, installer, bin entry — providers already implemented) | "this ships as a unit" |

So a "deployable" is not a type. It is **a leaf scope with ship evidence** — and both halves of that are already computed today. An "organization" is **a scope with children and no source of its own**. Neither needs a name in the schema.

### Consequences

- **Adding a level costs nothing.** A user inserts a scope with a parent and a label. No enum, no migration, no release.
- **Depth is genuinely unbounded**, not "unbounded up to the five we listed".
- **Users may disagree about vocabulary and both be right.** One customer's "domain" is another's "product line". Since the product never branches on the label, it does not care.
- **The map rule (§4) survives intact**, because it was already keyed on *has sub-projects* rather than on a type name.
- The three legacy names become pure history: WAS was a scope with children, CAS a source-backed scope, DAS a ship-backed leaf. No `scope_type` column is needed to express any of them.

### The one real distinction to keep

There is exactly one behavioural fork worth encoding, and it is **also** derivable rather than declared: whether a scope's analysis is **computed from its own source** or **composed from its children** (see the open question in §9 about re-deriving vs composing). That follows from *source-backed*, not from a level name.

---

## 2. The recursion

A scope may contain child scopes. Depth is not fixed. Examples the meeting gave:

```
organization
└── domain            (e.g. DDD domains)
    └── project       (a repository)
        └── deployable (API, CLI, UI — a monorepo has several)
```

Any level may be absent. A one-repo company is `project → deployable`. A DDD shop may use all five. **The structure must not assume a fixed number of levels.**

**Termination rule:** the deployable is the *lowest* analysable scope. A deployable has no sub-projects, which is what makes it the leaf.

---

## 3. The abstraction pyramid (within every scope)

```
        /      Action / Collaboration / Fabric      \
      /        Comprehension / Understanding          \
    /      Index / ICELOT / Visibility / Graph          \
```

Three tiers, and **the ordering is a dependency, not a taxonomy.** Each tier is only possible because of the one beneath it:

| tier | what it holds | what it needs from below |
|---|---|---|
| **Index / ICELOT / Visibility / Graph** | nodes, edges, entry/exit points, the ICELOT facets per unit | nothing — this is the substrate |
| **Comprehension / Understanding** | capabilities, flows, steps, entities | needs the graph: a capability is only real if it anchors to operations and entities that exist |
| **Action / Collaboration / Fabric** | proposals, edits, real-time multi-agent and multi-human coordination | needs comprehension: you cannot say "these two agents are working on the same thing" without knowing what the things ARE |

### This is the differentiator, and it is falsifiable

**Fabric works the way it does *because* the two tiers under it exist.** Strip comprehension away and coordination collapses to file diffing — which is what version control already does, for free. The claim is specific and checkable:

- **Blast radius** is a graph question (reachability), so it is answerable at tier 1. The reachability index already serves both product blast-radius AND fabric transitive collision detection from the same structure.
- **"Are we conflicting?"** is a comprehension question. Two agents editing the same file may be doing unrelated work; two agents editing different files may both be changing one capability's behaviour. Only tier 2 can tell those apart, and that is the distinction competitors cannot make.
- **`plan_parallel_work` is already CAS-blast-radius-powered**, which is the pyramid working in shipped code rather than on a slide.

### The uncomfortable corollary

**Garbage in tier 2 poisons tier 3.** If capabilities read as "analyze / manage projects / track" — generic scaffolding rather than what a system does — then fabric conflict detection keyed on those capabilities is detecting conflicts between meaningless labels. The coordination story is only as good as the comprehension underneath it.

That reframes the open capability-substance defect: it is not polish ahead of a beta, it is **the foundation of the moat**. A feed reader whose capability list omits reading feeds cannot support a credible claim that we understand systems well enough to coordinate work on them.

### Pyramid × scopes

The pyramid is **vertical** (three tiers of abstraction). Scopes are **recursive** (unbounded nesting). They compose: *every scope carries the whole pyramid.*

That is the actual architecture in one sentence — and it is why the seam matters. If the abstraction boundary is drawn under ICELOT + comprehension, then any number of scopes can be supported (multiple companies, one company with many teams, a solo repo) **and** each of them gets action and fabric for free, because those tiers consume a stable shape rather than a scope-specific one.

### ICELOT (authoritative — owner-confirmed 2026-08-09)
**I**nput · **C**onstraints · **E**ffects · **L**ogic · **O**utput · **T**elemetry

The transcript's "capabilities" for `C` was a transcription error, and an earlier draft of this spec guessed "contract" — both wrong. It is **Constraints**. Capabilities are not in ICELOT at all; they are one level up.

### Comprehension layer (authoritative — owner-confirmed 2026-08-09)
Four members, not three:

- **Capabilities** — what the codebase is *capable of*; what it was *built for*.
- **Flows** — all the different ways to move through the system. **Most roll up to capabilities, but some flows are isolated** and belong to none. A model requiring every flow to have a parent capability is wrong.
- **Steps** — the individual steps of a flow. A step may span **multiple functions, one function, or part of a function**, so **one function can host several steps**. Many-to-many, both directions.
- **Entities** — the domain things the system holds.

**Journeys and workflows are not a fifth member — resolved (owner, post-2026-08-09).** `docs/SPEC-ABSTRACTION-TIERS.md` §D posed this as an open question and has since resolved it: `user_journeys` and `workflows` collapse into flows. `CASWorkflow`'s fields (`entry_points`/`call_chains`/`exit_points`/`entities_touched`/`services_used`/`classification`/`criticality`) are a flow one granularity coarser, and an earlier audit found "414 workflows with 0 steps"; `CASUserJourney` adds only `kind` (derivable from entry-point kind) and per-step `layer`/`depth` (a tier-2 node-role fact), plus `boundaries`/`tests`. So there is one comprehension member for paths — flows — with journey- and workflow-shaped views derived from it, not stored as separate builders. Rationale: three parallel path representations are three builders that can disagree, and that failure already shipped (one API response with two disagreeing capability lists). Before removing the separate builders, check consumers of `user_journeys`/`workflows` (the journey builder, the product map, any UI surface) so journey-specific fields survive as derived facets rather than being silently dropped. This changes `docs/analysis-scope/SPECIFICATION.md` §7.1's `ScopeComprehension.workflows?`/`user_journeys?` fields, which are the shipped-schema surface this decision targets.

#### Why "Entities in the comprehension layer" is a real change, not a relabel

Today entities are treated as a data-surface concern: `data_entities`, `database_schema`, the ERD. Placing them in the comprehension layer alongside capabilities/flows/steps has three consequences:

1. **Entities compose across scopes.** A parent scope's entity set is the union of its children's, deduped by identity — and that union is where cross-project entity duplication becomes visible (the same `Customer` modelled twice in two services is a finding, not a merge conflict). No such rollup exists today.
2. **The persistence-evidence gate is comprehension work, not storage work.** The gate landed on 2026-08-07 (`kind_evidence` required for `persisted-entity`; uncited shapes become `domain-shape` and are excluded from the ERD) is what keeps this member honest — a comprehension layer full of UI geometry types would be worthless. That gate is now load-bearing for the layer, not just for the diagram.
3. **The ERD is a comprehension view, not a database view.** Which fits the §4 map rule: an ERD at a parent scope is a composed view over children, whereas a leaf's ERD is derived from its own schema evidence.

Open: whether entity→capability and entity→flow links are first-class in the comprehension layer or derived on read. Capability↔flow is already M:N with relational roles; entity↔capability exists today only as `related_entities` on a capability, which is weaker than the other three members' linkage.

---

## 4. System map vs architecture map

A product rule, and a sharper one than what is built today:

- **System map** exists whenever a scope has **sub-projects** — it shows how the parts fit together.
- **Architecture map** exists **only at the leaf (deployable) scope**.

Rationale from the meeting: a monorepo containing an API and a CLI has **no single architecture** — each deployable has its own, even where they overlap. So there is nothing coherent to draw at the parent level. A non-programmer reading the parent scope wants structure, not architecture.

---

## 5. Every scope renders the same

Whatever the scope type, the view is the same: **capabilities, critical flows**, and the same widgets. That sameness is the point — it is what makes the recursion comprehensible rather than merely elegant.

Per-scope surfaces named in the meeting:
- system health / monitoring — at workspace level **and** project level
- system complexity — at workspace level **and** project level
- change activity — valuable at project/workspace; **possibly too noisy at organization level** (open question)
- **dependencies — ordered by usage across sub-scopes, most-used first.** Explicitly for project managers, not engineers.

---

## 6. Information architecture

- Sidebar: **left is broad, narrowing to the right.**
- The top of the sidebar spans **everything the user can see across all workspaces** — the GitHub model (`all repositories`, `all issues`, `discussions`), i.e. an aggregated *list*, not a merged analysis.
- Below that: a **workspace switcher**, then scopes.
- Repositories are called **projects** in the UI. On connecting a repository, analyse it and, if it is a monorepo, **list its projects**.
- Organization needs its own treatment — org-specific views, likely tabs rather than more sidebar depth.

---

## 7. What this changes in the current build

Ordered by cost:

1. **Storage and identity.** Analyses are keyed per project today. Scopes need parent/child links, a `scope_type`, and a path. `das_index` already proves per-deployable slices work — that is the recursion's first rung and it exists.
2. **Rollup semantics.** WAS today *aggregates* member analyses with bespoke logic (`runtime_links`, `shared_code_rollup`, `application_links`). Under scopes, a parent is not a different kind of object — it is an analysis whose evidence includes its children. That is a genuine rewrite of the aggregation path, not a rename.
3. **The three spec sheets** collapse into one, with a scope-type table. They were just brought current at v1.11.0, so this is rework of hours-old documents — cheap now, expensive after they are published to customers.
4. **Query surface.** Tools take an analysis id; they need a scope id plus optional depth. Backward compatibility matters — a project-scope id must keep working.
5. **UI.** One scope view instead of workspace/codebase views, with the map rule (§4) applied by scope type.

---

## 7a. DERIVATION GRADIENT — resolved (owner, 2026-08-09)

**The further a scope sits from the lowest-level deployable (or the repository itself), the more its analysis is DERIVED from the lower-level analyses that already exist.**

This resolves the composition question, and it resolves it as a gradient rather than a binary. An earlier draft framed it as re-derive-versus-compose; that framing was too coarse.

### The rule

| scope position | where its facts come from |
|---|---|
| **leaf** (a deployable, or a repository with no sub-scopes) | source. This is the only place source is read. |
| **repository / project with sub-deployables** | mostly its children, plus the repo-level residue only it can see |
| **domain, organization, and above** | entirely its children. No source reading at all. |

Source-evidence share decreases monotonically with height. Derived share increases. A parent is never a second opinion about the same code.

### Why this is the right answer, not just a cheaper one

- **Cost concentrates at the leaves, where the work actually is.** Parent scopes require no re-parse and no additional AI pass. Given that AI enrichment has been measured at ~57% of analysis wall time against a hard 3-minute budget, re-deriving comprehension at every level would multiply the single most expensive stage by the depth of the hierarchy. Under this rule, **adding scope levels costs almost nothing.**
- **A parent cannot contradict its children.** It has no independent source of truth to contradict them with. That converts consistency from a thing to test into a thing that holds structurally — the same reasoning that made deriving `system.type` from evidence better than reading node labels.
- **Invalidation is cheap and correct.** A parent is stale if and only if some child is stale. Freshness propagates upward without re-analysis.
- **Incremental work becomes proportionate.** Change one deployable and you re-derive that leaf and recompose its ancestors. Today a workspace rebuild is expensive precisely because the parent is computed independently.
- **It explains the architecture-map rule** rather than merely coexisting with it. Architecture appears only at the leaf because only a leaf has one coherent architecture; a parent has no architecture of its own to describe, which is the same reason it has no source of its own to read.

### The honest exception: a parent is a union PLUS inter-child facts

A parent is not a pure union of its children, and pretending otherwise would lose real information. Two classes of fact exist only above the leaf:

1. **Relations between children.** Service A calls service B; two children share a library; the same entity is modelled in three children. These are not present in any single child's analysis, because no child can see its siblings. Cross-child entity duplication is the most valuable of these — the same `Customer` modelled twice is a finding, and it is only visible from above.
2. **Orphan source.** A monorepo may hold shared code, root configuration, or tooling that belongs to no deployable. A repository scope must read that residue, which is why the gradient says *mostly* derived rather than *purely* derived at the repository level.

Both classes must be **explicitly marked as parent-originated** with their own evidence, so a reader can tell a composed fact from an inter-child one. Anything not in one of those two classes and not traceable to a child is a defect.

### Invariant this creates

**Every claim at a non-leaf scope is either (a) traceable to a child claim, or (b) an explicitly-marked inter-child relation or orphan-source fact.** There is no third category. That is checkable, and it should be checked.

---

## 8. Recommended sequencing

**Capture now, build after beta.** Reasons:

- The current push is measurable product quality — capabilities that describe the product rather than plumbing, predictable latency, breadth across stacks. Scopes do not move any of those.
- Beta feedback is exactly what should shape the recursion's ergonomics. Building it first means guessing.
- The expensive half (rollup semantics) touches the aggregation path we have been actively repairing this week.
- The cheap half can start immediately and de-risks the rest: **stop leaking three names into the product surface.** Naming an analysis "an analysis" costs almost nothing and is right under either architecture.

**Do first, cheaply:** the naming decision; the system-map-vs-architecture-map rule (§4), which is a real correctness improvement today; dependencies-ordered-by-usage (§5).
**Do after beta, before scope identity/recursive rollup:** god-file decomposition along tier boundaries — resolved (owner, post-2026-08-09), see `docs/SPEC-ABSTRACTION-TIERS.md` "Implementation sequencing." 6 files hold 70,542 of 548,471 source lines (`orchestrator.ts` alone is 31,353), and both tier-skip defects `docs/SPEC-ABSTRACTION-TIERS.md` opens with were possible because tiers 1, 2, and 3 share one file with no import boundary. Splitting by tier makes the cleanup and the tier-ordering-rule enforcement the same work, with a lint/import-boundary gate so it cannot regress — and it is sequenced *before* the items below, so recursive composition is not layered onto a monolith the tier-ordering rule cannot yet be mechanically checked against.
**Do after beta:** scope identity, recursive rollup, spec consolidation, UI unification.

---

## 9. Open questions for the owner

1. **ICELOT's `C`** — contract, or something else? (§3)
2. **Change activity at organization level** — include, or drop as noise? The meeting left this unresolved.
3. **Does a parent scope re-derive comprehension, or compose children's?** The meeting implies each scope has "its own analysis and comprehension layer", but re-deriving capabilities at every level is expensive and may disagree with children. Composition-with-provenance is the cheaper and more defensible reading, and it matters for the latency budget.
4. **Is `domain` a scope type or a tag?** If domains never carry their own repositories, they may be an organizing label rather than an analysable scope.
