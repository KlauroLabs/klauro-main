# Code Analysis Specification (CAS)

**Version:** 2.0.0
**Status:** Active — the single, current specification. There is no separate Workspace Analysis Specification, Deployable Analysis Specification, or "Analysis Scope" document; those names are retired (§0.1). This is the only spec.

## Abstract

There is one structure — the CAS — and it nests. A CAS is a unit of code analysis: a structural graph, the framework/architecture/library conventions that graph follows, a comprehension layer of capabilities/flows/steps/entities built on top of it, and — when runtime data exists — telemetry attached to that comprehension. A CAS MAY have child CAS nodes ("sub-CAS nodes"), to any depth: a single repository with no children, a repository decomposed into per-deployable sub-CAS nodes, an organization of many repositories, or an organization of domains of repositories of deployables. Every node in that tree, at any depth, carries the same shape. §0 defines the recursive structure, composition, and inter-node interaction (seams). §1 onward defines the field-level content of one CAS node's Tier 1-3 output in full detail — the CAS Field Catalog.

## Table of Contents

**Part 0 — The Recursive CAS**
0.1. [Naming — one word, not three](#01-naming--one-word-not-three)
0.2. [The CAS envelope and recursion](#02-the-cas-envelope-and-recursion)
0.3. [No closed type vocabulary — derived properties only](#03-no-closed-type-vocabulary--derived-properties-only)
0.4. [Promotion — when a CAS gains sub-CAS nodes](#04-promotion--when-a-cas-gains-sub-cas-nodes)
0.5. [Tiers 1-5 overview](#05-tiers-1-5-overview)
0.6. [The derivation gradient](#06-the-derivation-gradient)
0.7. [Composition — what unions, what's inter-child, what's leaf-only](#07-composition--what-unions-whats-inter-child-whats-leaf-only)
&nbsp;&nbsp;&nbsp;&nbsp;0.7.1. [Comprehension is re-derived, never unioned](#071-comprehension-is-re-derived-never-unioned)
0.8. [Inter-sub-CAS-node interaction — communication seams](#08-inter-sub-cas-node-interaction--communication-seams)
0.9. [Both extremes are first-class](#09-both-extremes-are-first-class)
0.10. [Semantic rules and invariants (recursion-level)](#010-semantic-rules-and-invariants-recursion-level)
0.11. [No legacy compatibility](#011-no-legacy-compatibility)
0.12. [Gap register](#012-gap-register)

**Part 1 — CAS Field Catalog** (the field-level content of one CAS node)
1. [Introduction](#1-introduction)
2. [Conformance](#2-conformance)
3. [References](#3-references)
4. [Data Structures](#4-data-structures)
5. [Semantic Rules](#5-semantic-rules)
6. [Query Interface](#6-query-interface)
7. [Extensions](#7-extensions)
8. [Security Considerations](#8-security-considerations)
9. [IANA Considerations](#9-iana-considerations)
10. [Examples](#10-examples)

## Version History

This document specifies version 2.0.0 of the Code Analysis Specification. The evolution of CAS includes:

- **[Version 1.0.0](./v1.0.0.md)** - Initial release with core nodes, edges, and basic metadata
- **[Version 1.1.0](./v1.1.0.md)** - Added progressive levels, entry/exit points, and extended metadata
- **[Version 1.2.0](./v1.2.0.md)** - Added multi-perspective support and enhanced patterns
- **[Version 1.3.0](./v1.3.0-rfp.md)** - Added comprehensive call graph tracking and method invocation analysis
- **[Version 1.4.0](./v1.4.0-rfp.md)** - Added documentation and comment extraction
- **[Version 1.5.0](./v1.5.0-rfp.md)** - Added class-level relationships, pattern variations, and enhanced entry points
- **[Version 1.6.0](./v1.6.0-rfp.md)** - Added test architecture, test categorization, BDD support, and test-to-code relationships
- **[Version 1.7.0](./v1.7.0-rfp.md)** - Added inference-based intelligence: intent, critical flows, change risk, data lifecycle, security boundaries, flow coverage, temporal stability, system capabilities, domain concepts
- **[Version 1.8.0](./v1.8.0-rfp.md)** - Added incremental analysis: change detection, change reporting, change history, impact analysis; runtime/static correlation; distribution units
- **[Version 1.9.0](./v1.9.0-rfp.md)** - Added Codebase Idiom Intelligence for repo-local conventions, examples, violations, and agent validation
- **Version 1.10.0** - Added system health/coherence analysis and graph-anchored semantic retrieval (embedding index)
- **Version 1.11.0** - See §11.11 for the full field-level diff. Summary: evidence-gated `persisted-entity` classification on data entities (`kind_evidence`, replacing the uncited persistence fallback); distinctiveness-gated domain concepts (`distinctiveness_evidence`, replacing raw-frequency ranking); structural anchoring required for every shipped capability; `ENTRY_POINT_TYPES`/`EXIT_POINT_TYPES` promoted to the single source of truth for their type unions (adds `graphql` as a first-class entry-point kind); full declared-dependency manifest (`dependency_manifest`); self-discovered coverage gaps (`coverage_gaps`); unified communication-seam classification (`communication_seams`) and CAP/consistency characterization (`consistency_model`); custom-architecture convention audit trail (`conventions_applied`); progressive layer-readiness ladder (`layers_ready`, `l0_index`); edge referential-integrity invariant (zero dangling endpoints) enforced as a release gate.
- **Version 2.0.0** - Current version. MAJOR, breaking, no compatibility path (§0.11). Collapses three previously separate specifications — this document (CAS, single-project analysis), the Workspace Analysis Specification (WAS, cross-repo composition), and the Deployable Analysis Specification (DAS, per-deployable decomposition) — into one recursive structure: a CAS MAY have child CAS nodes, to any depth, and every node carries the same shape (§0). There is no `scope_type`/`analysis_kind` discriminant; "workspace", "deployable", and "project" are derived properties, never a declared type (§0.3). The `das_index` field is renamed `sub_cas_nodes` (§0.4) — no alias, no dual-read; a stored analysis with the old field name is not read, it is re-analyzed. New §0.8 specifies inter-sub-CAS-node communication seams (sync/async/passive), generalizing the single-repo `communication_seams`/`deployable_inventory` mechanism explicitly across the recursion. `docs/was/SPECIFICATION.md`, `docs/das/SPECIFICATION.md`, `docs/analysis-scope/SPECIFICATION.md`, and `docs/SPEC-ANALYSIS-SCOPES.md` are deleted, not superseded-with-a-pointer; their model content that survives is in §0 below.

---

# Part 0 — The Recursive CAS

## 0.1 Naming — one word, not three

There is one structure — the CAS — and it nests. A workspace is a CAS with sub-CAS nodes. A monorepo is a CAS with sub-CAS nodes, typically one per independently shippable deployable. An organization of many repositories is a CAS with sub-CAS nodes, each of which may itself have sub-CAS nodes. One layer, three layers, a hundred layers — same structure, same fields, same rules, at every depth.

This replaces three previously separate documents that described overlapping content through three different, partially-incompatible schemas:

- **CAS** (this document, pre-2.0.0) — a single project/repo/folder/codebase analysis.
- **WAS** (Workspace Analysis Specification, `docs/was/SPECIFICATION.md`) — cross-repo composition, generated after member CAS outputs complete.
- **DAS** (Deployable Analysis Specification, `docs/das/SPECIFICATION.md`) — per-deployable decomposition of one repo into its shippable units.

**Both retired names, and the document that briefly replaced them with a fourth ("Analysis Scope"), are gone.** `docs/was/SPECIFICATION.md`, `docs/das/SPECIFICATION.md`, `docs/analysis-scope/SPECIFICATION.md`, and `docs/SPEC-ANALYSIS-SCOPES.md` are deleted outright, not retained with a supersession pointer — a pointer to a dead concept is the documentation equivalent of legacy code. "Analysis Scope" was this project's own coinage for the recursive unit before the owner settled the vocabulary; it is superseded by **CAS** exactly like WAS and DAS are, and does not survive as a second name for anything. A user should not have to learn three words — or four — for one thing. **Do not introduce a fourth.**

A "workspace" is not a type. It is a CAS with children and no source of its own. A "deployable" is not a type. It is a leaf CAS that is also ship-backed. A "project" is not a type. It is whatever a source-backed CAS happens to be called. None of these needs a name in the schema — §0.3 states why.

## 0.2 The CAS envelope and recursion

### The recursion

A CAS MAY have child CAS nodes ("sub-CAS nodes"). Depth is not fixed and is not validated against any maximum. A single-repository, single-deployable case is a CAS with no children. A multi-level organization is a chain of CAS nodes of arbitrary length. Any level in a chain MAY be absent; a conforming consumer MUST NOT assume a fixed number of levels between a root and a leaf.

**Termination rule.** A CAS with no children is a leaf. A leaf is the lowest analysable CAS: analysis at a leaf is always computed from that CAS's own source, never composed from further children, because there are none.

### What a CAS carries — no closed type vocabulary

```typescript
interface CAS {
  id: string;
  parent_id: string | null;    // null (or absent) marks a root CAS
  label: string;                // the user's word for this node: "Organization",
                                 // "Domain", "Project", "Deployable", or any other
                                 // free text. Never read by producer or consumer
                                 // logic — display only.

  // Tier content — see §0.5.
  tier1: CASTier1Index;
  tier2: CASTier2Conventions;
  tier3: CASTier3Comprehension;
  tier4?: CASTier4Telemetry;    // present only when runtime observations exist

  // Composition (only meaningful when has_children — §0.3)
  children?: CAS[];             // this CAS's full sub-CAS-node objects. Absent, not
                                 // empty-array, at a leaf. NOT YET BUILT beyond the
                                 // single-repo (deployable) level — see the note below.
  seams?: CASSeamInventory;     // inter-sub-CAS-node communication seams — §0.8. Absent
                                 // when this CAS has fewer than two sub-CAS nodes.
  composition_mode?: 'derived' | 'composed';  // §0.6 — required on every non-leaf CAS

  // Envelope metadata
  cas_version: '2.0.0';
  analysis_id: string;
  analysis_timestamp: string;   // ISO 8601
  root_path: string;            // repo-relative for a source-backed CAS;
                                 // a synthesized organizational path otherwise
}
```

`CAS` MUST NOT carry a `scope_type`, `analysis_kind`, or any similarly-named field holding a closed enumeration of node levels (`organization | domain | project | deployable` or any similar list). A producer or consumer MUST NOT branch behavior on `label`. §0.3 states every property that formerly depended on such a type as a derived property instead, and every one of those derivations is already computed by the codebase this specification describes.

**`children` above is the full recursive envelope — not yet built beyond one level of the recursion.** Today, only the single-repo, deployable-level case is implemented: a promoted CAS exposes `sub_cas_nodes` (§0.4), a lightweight rollup/index (`SubCasNodeIndex` — `promoted`, `units: SubCasNodeIndexEntry[]`, coverage/orphan counts, `reason`) rather than full nested `CAS` objects for each child. `sub_cas_nodes` is the field this specification renames from `das_index`; `children` is the aspirational full-object shape a future cross-repo/organization-level implementation would populate. A reader MUST NOT assume `children` is populated today — check `sub_cas_nodes` for the shipped deployable-level case, and treat multi-repo/organization-level recursion as specified but not yet implemented (§0.12).

Rationale: a closed vocabulary requires a schema change, a migration, and a naming decision every time a user's organization introduces a level the enumeration did not anticipate (a subdomain, a squad, a bounded context, a tenant, a region). Two users may use different words for structurally identical levels, and both are correct; since no field switches on the word, neither the producer nor the consumer needs to reconcile the vocabulary.

## 0.3 No closed type vocabulary — derived properties only

None of the following properties are stored. Each is computed at read time from CAS tree structure or from Tier 1/2 evidence already present in the tree.

| property | derivation | what it drives |
|---|---|---|
| `has_children` | true iff `sub_cas_nodes` is non-empty | whether a system map is renderable for this CAS |
| is a leaf | `has_children === false` | whether an architecture map is renderable for this CAS |
| source-backed | this CAS has its own file set (`tier1.nodes` etc. computed from source, not composed) | whether Tier 1-3 are computed from source (§0.6) or composed from children |
| ship-backed | `tier2.deployable_evidence` (Field Catalog §4.16) contains at least one tier-qualified row for this CAS, per the promotion predicate in `docs/SPEC-DEPLOYABLE-DETECTION.md` | whether this leaf is presented as "ships as a unit" |

A "deployable" under this specification is not a type: it is a leaf CAS that is also ship-backed. An "organization" is not a type: it is a CAS with children and no source of its own. Both distinctions were previously expressed as a discriminant (CAS's implicit "this is a single-project analysis", WAS's `analysis_kind: 'workspace'`, DAS's promotion boolean); under this specification they are read-time facts over the same envelope.

### System map vs. architecture map

A **system map** exists for a CAS whenever `has_children` is true — it shows how the sub-CAS nodes relate. An **architecture map** exists only at a leaf CAS, because a CAS with multiple children has no single coherent architecture to draw: each child has its own, even where they overlap. This rule is itself a structural derivation, not a declared field, and the same derivation `has_children` already computes for every other purpose.

## 0.4 Promotion — when a CAS gains sub-CAS nodes

A single connected repo can itself contain more than one independently deployable unit. `docs/SPEC-DEPLOYABLE-DETECTION.md` produces evidence-gated `DeployableEvidence` rows for exactly this reason: a repo is not always one product surface.

A CAS promotes to a parent with deployable-level sub-CAS nodes only when its own evidence says so, never when its folder layout merely looks segmented. A CAS promotes when it resolves **two or more tier-qualified ship units** after the evidence-gated bundling/dedup pass in `docs/SPEC-DEPLOYABLE-DETECTION.md` §3-§4 completes. A "tier-qualified ship unit" is a surviving `DeployableEvidence` row that is not `bundled_into` another unit, and whose own evidence declares a ship-or-build artifact: a Tier-1 ship declaration (`container`, `compose-service`, `k8s`, `serverless`, `installer`, `ci-deploy`), or a Tier-2 build-target declaration (a `bin`-kind row — cargo `[[bin]]`, a package manifest `bin` field, a go `package main`, a `src/bin/*` entry). Cardinality is not part of the predicate: a `server-entry` row (a route-handler entry point INTO a deployable, not a build target of its own) and a bare `package` identity never qualify, regardless of how many other runnable rows exist alongside them.

```
PROMOTION_THRESHOLD = 2
shouldPromote(cas) := tierQualifiedShipUnits(cas.tier2.deployable_evidence).length >= 2
```

A build-target row that declares the SAME binary through two conventions at once MUST be deduplicated to one surviving row before the threshold check, so a single shipped artifact is never counted twice. A repo that resolves to exactly one ship unit — the overwhelming common case — MUST NOT promote, regardless of its size, folder count, or internal module boundaries. Promotion is a gate driven by ship evidence, not a preference driven by repo size, and it applies identically at every level of the recursion: an organization "promotes" child repos into sub-CAS nodes the same way a repo promotes deployables, driven by the same kind of evidence (a connected git repo, a declared workspace member) rather than folder layout.

### `sub_cas_nodes` — the schema name, and why

The rollup a promoted CAS exposes is `sub_cas_nodes`: the array of this CAS's child `CAS` nodes, at whatever granularity promotion resolved (deployables within a repo; member repos within a workspace; anything else the recursion admits). This is a rename of the field formerly called `das_index` — **no alias, no dual-read, no `das_index` fallback.** A stored analysis carrying the old field name is not read through a compatibility shim; it is re-analyzed under 2.0.0, exactly as any other `cas_version` major-line change already forces (Field Catalog `docs/cas/VERSIONING.md`).

`sub_cas_nodes` was chosen over `child_cas_nodes` for one reason: "sub-CAS node" is the exact term this specification uses in prose throughout §0 for a child, so the field name reads as the same word a reader already has, not a synonym for it. `child_cas_nodes` is not wrong, but it introduces a second term for the same concept the moment a reader has to hold both "sub-CAS node" (prose) and "child" (field) in mind at once.

**`sub_cas_nodes` itself is always attached, promoted or not — this is a deliberate exception to the absent-not-zero-filled rule (§0.9), stated explicitly so the two are not confused.** A CAS with fewer than 2 qualified units MUST return `sub_cas_nodes: { promoted: false, units: [] }` with every count field zeroed — never omitted, and never a synthesized one-entry unit list — with `reason` distinguishing "0 qualified" from "1 qualified, below threshold". The reason this differs from §0.9's rule for `seams` (absent, not zero-filled, when there are fewer than two sub-CAS nodes) is that `sub_cas_nodes.reason` answers a question a caller actually asked ("did this promote, and why or why not") with real evidence behind the answer, whereas a zero-filled seam count asserts a coupling fact (no interaction exists) that is only meaningful once there is more than one node to interact. Non-promotion is itself a fact worth reporting; the absence of inter-node interaction between fewer than two nodes is not a fact, it is a category error.

## 0.5 Tiers 1-5 overview

Every CAS, at every depth, carries the same four tiers of analytical content (a fifth, Fabric, is an overlay and out of scope for this document):

| tier | contains | depends on | character |
|---|---|---|---|
| **1 — Index / ICELOT / Graph** | nodes, edges, entry/exit points, the six ICELOT facets (Input, Constraints, Effects, Logic, Output, Telemetry) | nothing — the substrate | deterministic: same source produces byte-identical facts |
| **2 — Framework / Architecture / Library** | which frameworks are present and what role they confer, dependency roles, architectural paradigm, idioms and conventions | Tier 1 only | deterministic |
| **3 — Comprehension** | **Capabilities** (what the system is for), **Flows** (the ways through it — journeys and workflows are derived views over flows, not separate members, §0.5.1), **Steps** (a flow's steps; many-to-many with code), **Entities** (the domain things the system holds) | Tiers 1-2 | AI-authored comprehension, structurally anchored to Tier 1-2 facts |
| **4 — Realtime Telemetry** | observed runtime behavior attached to Tier 3 (which flows execute, real latency/error rates, dormant vs. hot capabilities) | Tiers 1-3 | optional; absent, never zero-filled, when no telemetry exists |
| **5 — Action / Fabric** *(out of scope)* | proposals, work claims, conflict/collision detection, multi-agent coordination | Tiers 1-3 (materially better with 4) | overlay, stored separately, not part of the CAS structure |

A tier may consume any tier below it and MUST NOT consume, or be synthesized from, a tier above it. This is enforced only at the derivation layer today (documented-only at the mechanical-check level; see the Field Catalog's semantic-rules section for the proven-defect citation this rule exists to prevent — a Tier 3 code path once read a raw Tier 1 label directly and misclassified every framework-less HTTP server as a library).

### 0.5.1 Journeys and workflows collapse into flows

There is no fifth comprehension member. `workflows` and `user_journeys` are named, derived views over `flows` at a different granularity, not separately stored builders: a workflow is a flow one granularity coarser, and journey-specific fields (`kind`, `layer`, `depth`, `boundaries`, `tests`) are derived facets on top of the one flow member rather than a competing representation. This was a deliberate collapse, not an oversight — three parallel path representations are three builders that can disagree, and that exact failure shipped once (one API response containing two capability lists that disagreed on count and quality). A consumer of `workflows`/`user_journeys` MUST see the same facts `flows` already carries, projected, not a second source of truth.

### 0.5.2 ICELOT and comprehension, restated

**ICELOT** = **I**nput, **C**onstraints, **E**ffects, **L**ogic, **O**utput, **T**elemetry — the six-facet contract every unit in a CAS carries, at node/step/flow/capability granularity. It is a derivable projection over Tier 1 facts, not a stored per-node field. ICELOT's `T` is *declared* telemetry capacity (log sites, metric registrations, span creation) read off static facts — it is not Tier 4. Tier 4 is *observed* runtime behavior, joined at query time. A conforming implementation MUST NOT populate ICELOT's `T` from static capacity alone and MUST NOT describe declared capacity as an observation.

**Comprehension** = **Capabilities, Flows, Steps, Entities** — four members, not three, not five. Full field-level definitions (structural anchoring rules, the M:N capability-flow relationship, step/code mapping, persisted-entity evidence gating) live in the Field Catalog, Part 1 §4.15 onward, unchanged in shape from pre-2.0.0.

## 0.6 The derivation gradient

**The further a CAS sits from the lowest-level deployable (or the repository itself), the more its analysis is DERIVED from the lower-level analyses that already exist.**

| CAS position | where its facts come from |
|---|---|
| **leaf** (a deployable, or a repository with no sub-CAS nodes) | source. This is the only place source is read. |
| **repository/project with sub-CAS nodes** | mostly its children, plus the repo-level residue only it can see |
| **domain, organization, and above** | entirely its children. No source reading at all. |

Source-evidence share decreases monotonically with height. Derived share increases. A parent is never a second opinion about the same code.

**Why this is the right answer, not just a cheaper one.** Cost concentrates at the leaves, where the work actually is — parent CAS nodes require no re-parse and no additional AI pass, which matters because AI enrichment is measured at roughly 57% of analysis wall time against a hard latency budget; re-deriving comprehension at every level would multiply the single most expensive stage by the depth of the hierarchy. **A parent cannot contradict its children** — it has no independent source of truth to contradict them with, which converts consistency from a thing to test into a thing that holds structurally. Invalidation is cheap and correct: a parent is stale if and only if some child is stale, so freshness propagates upward without re-analysis. It also explains the architecture-map rule (§0.3) rather than merely coexisting with it: architecture appears only at the leaf because only a leaf has one coherent architecture, the same reason it has one source of its own to read.

**This non-contradiction rule holds for Tier 1-2 facts, and Tier 1-2 facts only.** A parent has no independent evidence about a node, an edge, a framework, or a dependency — a union of children can only add or dedupe such a fact, never invent one absent from every child, so "cannot contradict" is a structural property of union itself. **Tier 3 comprehension does not inherit this guarantee, and must not be read as if it did.** A capability is not a fact about code the way a node or an edge is; it is a judgment about what a CAS is *for*, made against that CAS's own purpose. Two CAS nodes evaluating the identical code can correctly reach opposite verdicts about whether that code is a capability, because they are answering the question at different scope — that is not a contradiction in the Tier 1-2 sense, it is two different, both-correct answers to two different questions. §0.7 states the weaker, deliberately different composition rule this implies for capabilities and flows.

A CAS with fewer than the threshold's worth of qualified sub-units — the common single-deployable case — is source-backed to its own boundary and reads no children at all; it is a leaf under this gradient like any other.

## 0.7 Composition — what unions, what's inter-child, what's leaf-only

### The honest exception: a parent is a union PLUS inter-child facts

A parent is not a pure union of its children, and pretending otherwise would lose real information. Two classes of fact exist only above the leaf:

1. **Relations between children.** Service A calls service B; two children share a library; the same entity is modelled in three children. These are not present in any single child's analysis, because no child can see its siblings. Cross-child entity duplication is the most valuable of these — the same `Customer` modelled twice is a finding, and it is only visible from above. **Inter-sub-CAS-node communication seams (§0.8) are the primary instance of this class** — see that section for why a parent that only concatenates its children is not doing the job a parent exists to do.
2. **Orphan source.** A monorepo may hold shared code, root configuration, or tooling that belongs to no deployable. A repository CAS must read that residue, which is why the gradient (§0.6) says *mostly* derived rather than *purely* derived at the repository level.

Both classes MUST be explicitly marked as parent-originated with their own evidence, so a reader can tell a composed fact from an inter-child one. **Every claim at a non-leaf CAS is either (a) traceable to a child claim, or (b) an explicitly-marked inter-child relation or orphan-source fact.** There is no third category. That is checkable, and it should be checked.

### `composition_mode`

A CAS with children MUST declare `composition_mode: 'derived' | 'composed'` and MUST state which one it chose rather than leaving a reader to guess:

- **`derived`** — Tier 2-3 construction is re-run over the union of children's Tier 1 graphs, producing a fully independent comprehension layer at the parent. Correct but expensive: Tier 3 construction is not cheap, and a re-derived parent capability set can legitimately disagree with the union of children's capability sets, which then needs its own reconciliation story.
- **`composed`** — the children's already-computed Tier 3 objects are unioned, deduped by identity, each carrying which child contributed it. Cheaper, and guarantees the parent's comprehension never contradicts a child's, but a "parent capability" is then always traceable to a child's capability rather than a fact about the parent as its own unit.

This is not a fresh open question: the pre-2.0.0 DAS mechanism already chose `composed` at the deployable level (a deployable's capabilities/flows are filtered down from the parent repo's already-computed set, not re-derived), with a known limitation stated explicitly there (a capability whose entry points and entities span sub-CAS-node boundaries does not cleanly decompose under filter-down) — that limitation carries forward unchanged as `composed`'s cost at every level, not just the deployable one.

**This precedent is corrected by §0.7.1 below for capabilities and flows specifically.** `composition_mode` governs how Tier 1-2 *substrate* composes — nodes/edges union, reachability recomputes, frameworks and the dependency manifest union. It does not, and must not, govern Tier 3 comprehension: reading `composed` as "union the children's capability/flow lists" is exactly the defect §0.7.1 corrects, because a union guarantees a parent inherits every child's substrate as its own product purpose. A CAS declares `composition_mode` for its Tier 1-2 behavior; its Tier 3 capabilities and flows are always re-derived, regardless of which mode it declares.

### 0.7.1 Comprehension is re-derived, never unioned

Capabilities and flows are **re-derived at each CAS level against that level's own purpose**. They are never inherited from a child by union, and a parent's comprehension omitting something a child correctly reports is not a bug to reconcile — it is the expected, correct outcome of asking the same evidence a different question.

**Worked example (the owner's own).** A company operates many repositories, some of them monorepos, several CAS layers deep. A `sync-api` deployable that adds users may legitimately carry "User Management" as a capability **at its own CAS node** — a real, user-reachable outcome of that deployable's own code. The company-level CAS sitting above it, looking at the same code through many other sub-CAS nodes, **would not have "User Management" in any form** — it surfaces actual product purposes (what the company sells, not what any one service does internally to support that). Same code, opposite verdict, both correct, because "capability" is always relative to the CAS asking the question, never an absolute property of the code itself. **Absent, not demoted.** A parent does not carry a weakened, generalized, or renamed version of a child's substrate capability forward — it either re-derives that outcome as genuinely its own (a different, higher-level capability, possibly sharing no name with any child's) or it does not carry it at all.

**Why this does not violate §0.6's non-contradiction rule.** §0.6 states a parent cannot contradict its children because it has no independent evidence — true for Tier 1-2, where the parent's only operation is union/recompute over the same facts the children already established. Tier 3 comprehension is not that operation. A parent re-deriving capabilities is not making a second, disagreeing claim about the same fact; it is answering "what is this CAS for" fresh, at its own scope, which is a different question from the one each child answered at its scope. Promotion (a child's mechanism becomes visible as a real, named parent outcome) and demotion (a child's real capability is absent at the parent because it is substrate from the parent's vantage) are both expected outputs of this process, not exceptions to be reconciled away.

**The mechanism this implements today: terminality GENERATES candidates, it does not filter them.** Candidate generation starts from the CAS's user-reachable outer surface (a genuinely caller-initiated entry point — HTTP, websocket, CLI, page, route; never a lifecycle hook, cron trigger, or test harness entry) and follows it to a domain-entity write. A candidate is a capability *by construction* of having been generated this way — outcome-shaped from the start — rather than generated broadly from "a coherent cluster of code" and then filtered down to the outcome-shaped subset after the fact. This inversion matters because a post-hoc filter can only reject what generation already produced; if a mechanism shape was never excluded from being generated as a candidate in the first place, a filter is one more gate away from admitting it by accident. Generating only from the outward face closes that gap structurally.

**Terminal and proximal-terminal are co-equal**, not primary/fallback. A terminal write is the candidate's own direct evidence; a proximal-terminal write is one call-hop away, reached through the same entity-matching evidence used elsewhere to populate relationship data. Treating proximal-terminal as a lesser or optional signal under-generates: a controller that delegates persistence to a manager one hop away is exactly as much a real outcome as one that writes directly, and refusing to follow that hop drops real capabilities from the candidate pool. Under-generation (a real outcome never becomes a candidate) is a first-class failure, **equal in severity** to over-generation (a mechanism candidate reaches the surface) — this specification does not treat recall and precision asymmetrically for comprehension, and an implementation that trades away proximal-terminal candidates to simplify the terminal case is not conforming.

**How a parent's capabilities come from its children.** A parent's re-derivation draws its evidence from the **terminal** children — the sub-CAS nodes whose own outward-facing surface produces the outcomes the parent's users actually reach. A sub-CAS node that exists to support other sub-CAS nodes (an internal auth service, a shared logging pipeline, a config-distribution sidecar) contributes evidence that is **absorbed into the terminal children's own re-derivation as substrate — never inherited upward as a capability in its own right.** A support service's own CAS node may correctly carry its own capabilities at its own level (§0.6's leaf/child scope still applies to it); what does not happen is those capabilities surviving, renamed or not, into the parent's Tier 3 list merely because the parent unioned its children.

**The audience test (normative).** A capability name MUST be readable and meaningful to a non-technical reader — a product manager, a designer, a marketer — with no engineering vocabulary required to understand what it means. This is a falsifiable bar applied identically at every CAS level, not a heuristic: a capability naming a protocol, vendor, or library ("Authenticate with WebAuthn", "Sync via Kafka") is wrong by construction, at any node, regardless of how real or well-evidenced the underlying mechanism is. This bar is enforced with **no hardcoded keyword or vocabulary list** — roughly 30 such tables were deliberately removed from this product because a closed list of banned words is exactly the kind of brand/protocol coupling this specification exists to prevent elsewhere (§0.3). The structural discriminator instead compares a candidate name's tokens against the CAS's own identifier vocabulary (import/dependency/package/type names) versus its own domain-entity vocabulary (persisted-entity and API-response names): a token that appears only as an identifier and never as domain vocabulary is mechanism, not purpose. **Mechanism itself is not discarded — it belongs in Tier 1, as an ICELOT Effect or Constraint on the node/step/flow it actually describes, never promoted to a Tier 3 capability name at any level.**

### What composes, what's computed per CAS, what's leaf-only

| field | at a composed (non-leaf) CAS |
|---|---|
| `tier1.nodes` / `tier1.edges` | union of children's, deduped by content-derived id |
| `tier1.reachability_index` | recomputed over the unioned graph — cannot be composed piecewise, since SCC condensation is not additive |
| `tier2.frameworks_detected` / `dependency_manifest` | union of children's, deduped by name |
| `tier3.entities` | union of children's, **deduped by identity** — the same entity modelled independently in two children is a *finding* (surfaced, not silently merged into one row), not a merge conflict to resolve away |
| `tier3.capabilities` / `tier3.flows` | **always re-derived** against this CAS's own purpose (§0.7.1) — never a union of children's, regardless of `composition_mode` |
| identity/architecture summary (a single description and domain) | **leaf-only** — a composed CAS has no single architecture-map identity to claim (§0.3) |
| `tier4` | union of children's `observations`, when telemetry ingestion is scoped per child; not re-aggregated into new percentiles without restating the aggregation method |
| `seams` (§0.8) | this CAS's own inter-child seams; NOT re-aggregated by default into the grandparent's seams — see §0.8's composition rule |

Two surfaces are explicitly position-sensitive and MUST be labeled as such rather than presented uniformly: **change activity** is valuable at a leaf and at a modest-depth parent, but MAY be too noisy at a very broad root — this specification does not mandate a threshold, only that a consumer be told the activity view is an aggregate over N children. **Architecture map** is leaf-only (§0.3).

## 0.8 Inter-sub-CAS-node interaction — communication seams

**A parent CAS exists primarily to report how its sub-CAS nodes talk to each other.** A parent that only concatenates its children (§0.7's union case) tells a reader nothing they could not get by reading the children separately. What only the parent can see is the interaction between them — this is not one of the "inter-child facts" exception classes in §0.7, it is the central reason the exception classes exist at all.

This mechanism already exists, at the single-repo (deployable) granularity, as `communication_seams` / `classifyCommunicationSeams` (`packages/analyzer-core/src/analyzer/core/communication-seams.ts`). This section specifies what it actually computes today, generalizes it explicitly across the recursion, and states where the current implementation falls short of that generalization.

### 0.8.1 Seam kinds and their evidence

Every seam carries a `modality` — exactly one of three:

- **`sync`** — request/response; the caller awaits a reply. Evidence: an `exit_point` of type `api` (REST/GraphQL/gRPC call), a direct `database` read/write, an `sdk` call honoring a declared non-async operation flag, or a `device_io` call to physical hardware (serial/USB/HID) that blocks on a reply. Each carries a `confidence` in `[0,1]` set per exit-point type (`api`: 0.9, `database`: 0.75, `sdk`: 0.6-0.7, `device_io`: 0.65) — never asserted at confidence 1.0 from a single fact.
- **`async`** — fire-and-forget; no blocking reply. Evidence: a `message`/`event`-type exit point (publish/enqueue/emit, confidence 0.9), an outbound `webhook` (confidence 0.85), or the consume side — an entry point of type `message`/`event` (confidence 0.9), explicitly excluding UI event handlers (Click/SelectionChanged/etc.) which are inbound user interaction, not the consume side of an external channel.
- **`passive`** — communication via shared state, no direct call. Evidence: a data entity (from `tier3.data_lineage`) with a writer in one component and a reader in a different component — confidence 0.7, undirected (canonicalized so writer/reader order does not double-count the same coupling), and gated so a single component that both writes and reads its own entity is never a seam.

A seam that cannot cite one of these evidence classes MUST NOT be emitted — an asserted seam with no evidence is the fabrication class this product has spent real effort purging elsewhere, and communication seams are not exempt.

Two additional `kind` values exist in the type (`cross_repo_contract`, `device_io`) alongside `exit_point`/`messaging`/`passive_state`; `device_io` is implemented (hardware boundaries, classified `sync`/`async` per above). **`cross_repo_contract` is declared but not implemented** — see §0.8.4.

### 0.8.2 Seams between sub-CAS nodes specifically

**What the code actually does, not what would be the obvious mechanism.** Each seam's `source`/`target` is a *component identifier* — for a promoted (deployable-backed) CAS, the owning deployable's name when a deployable root claims the file, else a module-root fallback (`apps/foo`, `libs/bar/baz`). A `sync` seam's `target` is the exit point's own declared external identifier (`target.service_id` / `.resource` / `.sdk` / `.endpoint` / `.name` — a string the exit point already carries), **not a graph-resolved match against another sub-CAS node's registered entry points.** An `async` producer seam and its consumer seam are similarly *not* joined into one producer→consumer edge; they are two independent seams that happen to share a channel-name string as one seam's target and the other's source, and only read as connected because the inventory aggregation (§0.8.3) groups edges by that shared string. **There is no exit-point-resolves-to-entry-point matching mechanism today.** A seam between two named sub-CAS nodes is real when the two components' identifiers both appear as `source`/`target` of seams sharing the same external target string or the same shared-state entity — an evidence-based correlation on names/resources, not a call-graph edge into the sibling's code.

This matters for what a reader should expect: two sub-CAS nodes that genuinely call each other but name the target inconsistently (one calls it `payment-service`, its manifest is `payments-api`) will not automatically show as connected without evidence tying the two strings together. This is a known precision gap (§0.8.4), not a design choice to defend.

### 0.8.3 Shared-dependency and shared-entity seams

Passive seams (§0.8.1) already cover the shared-entity case: the same entity written by one component and read by another is reported as a `passive` seam with `shared_resource` naming the entity, and this is explicitly called out in the implementation's own comments as "the subtle one nobody models." **The same entity modelled independently in three sub-CAS nodes is reported separately** — as `tier3.entities` deduplication-by-identity surfacing the duplication (§0.7), not as a communication seam — the two mechanisms are complementary: entity duplication says "these three components think they own the same concept"; a passive seam says "these two components actually read/write the same live data."

**Shared-dependency seams — using the same third-party library — are not currently modelled as a seam at all.** Two sub-CAS nodes both depending on the same library appear in each one's own `tier2.dependency_manifest`; nothing in `communication-seams.ts` correlates that overlap into a seam or a finding. This is a gap (§0.8.4), not an implemented surface.

### 0.8.4 Direction, cardinality, and honest gaps

A seam is not symmetric. `sync` and `async` seams are directed (`source` initiates/writes, `target` serves/reads/receives); `passive` seams are stored undirected by construction (the writer/reader pair is canonicalized, since "A writes, B reads" and "B writes, A reads" of the *same* entity is the same coupling read from either side) but each carries which component was the writer and which the reader in its own record, so direction is recoverable per-seam even though the aggregate pairing is order-independent.

**What the current implementation computes, precisely, versus what this section requires:**

| capability | status today |
|---|---|
| Seams within one repo, at deployable (sub-CAS-node) granularity | **Implemented.** `deployable_inventory` (`level: 'deployable'`) re-keys node-level seams by owning deployable and re-aggregates — this is real cross-sub-CAS-node seam reporting, at the single-repo level of the recursion. |
| Seams across repos (workspace-level sub-CAS nodes) | **Implemented.** `buildWorkspaceCommunicationSeams` (`apps/mcp-server/src/cross-codebase-analysis.ts`) sets `SeamLevel: 'workspace'` and `kind: 'cross_repo_contract'` on `CrossCodebaseSystemGraph.communication_seams`, gated on >= 2 codebases (§0.9). It does not re-derive the exit-point/entry-point match itself — that mechanism already existed, differently named, as `application_links` (`SystemApplicationLink`, built by `extractInterfaces`/`buildLinks` over resolved routes, topic names, and package imports) — it re-expresses each cross-codebase link as a `CommunicationSeam`, inheriting that link's own confidence and `evidence_quality`. The fourth mode this section previously flagged, `stream` (a cross-repo `stream-flow` link, e.g. SSE/websocket), is unified into `async` (a continuous push has no single blocking reply) with the original mode preserved on `metadata.original_mode`. `buildCrossRepositoryLinks`/`buildCrossRepoContractDrift` in `apps/mcp-server/src/product.ts` remain a separate, still-unintegrated mechanism (contract-signature drift, not seam classification) — see the remaining gap in §0.12. |
| Shared-dependency seams | **Implemented** (§0.8.3). `buildSharedDependencySeams` correlates each repo's own `dependency_manifest.dependencies` by exact `(ecosystem, name)` match, filtered to `runtime`-scoped declarations (a structural field on the dependency record, never a name list). Always `passive` and undirected — co-declaration carries no producer/consumer evidence — `kind: 'shared_dependency'`, confidence 0.55 (the weakest evidence band this mechanism emits: a real structural coupling, not an observed interaction). |
| A cap on seam count / truncation behavior | **Not observed in the classifier.** `classifyCommunicationSeams` and `buildSeamInventory` do not truncate; if a response-size budget elsewhere in the MCP layer truncates the served list, that is a serialization-layer concern, not a property of the seam data itself, and MUST be stated explicitly to the caller when it happens (§0.9) rather than silently shortening the list. |

**Both extremes, restated for seams specifically.** A CAS with one sub-CAS node, or none, has no inter-node seams and MUST report **no seam surface at all** (`seams` absent) rather than a zero-filled `{ sync: 0, async: 0, passive: 0 }` inventory — absent structure is not a gap (§0.9). The current implementation already gets the leaf case right (no `deployable_inventory` when `deployable_evidence` is empty) but has one known deviation: `deployable_inventory` presence today is gated on the raw count of `deployable_evidence` rows, not on the count of rows that actually qualify as ship boundaries (`isShipBoundary`) — so a CAS with only non-qualifying `server-entry` rows can still emit a `deployable_inventory` whose components are module-root fallbacks, not real deployable names, mislabeled `level: 'deployable'`. This is a precision bug against the both-extremes rule, not a design choice, and is tracked in §0.12.

### 0.8.5 How seams compose upward

Per the derivation gradient (§0.6) and the composition rule (§0.7): a repo-level CAS's own inter-deployable seams are that CAS's `seams`, computed once, at its own level. Its parent (a workspace CAS) does **not** re-derive those same seams — it sees them as one child's already-computed fact, exactly like any other Tier 3 content under `composition_mode: 'composed'`. What the parent computes fresh is its **own** inter-child seams: the connections between its direct children (which may themselves be repos with their own internal deployable-level seams already resolved). A grandparent does not flatten every seam at every depth into one list; each CAS reports the seams between *its own direct sub-CAS nodes*, and a consumer wanting the full seam graph across the tree walks it level by level, the same way it would walk `tier3.capabilities` under composition. This mirrors §0.7's rule that a parent's Tier 1 graph unions but Tier 1 derived structure (`reachability_index`) is recomputed fresh at each composing level rather than inherited — seams are the Tier 3-adjacent analogue: computed at the level whose children they connect, not flattened across levels.

## 0.9 Both extremes are first-class

A CAS with no children is **complete**, not deficient. It MUST NOT carry an empty parent-level surface (a zero-filled `sub_cas_nodes`, a manufactured single-entry rollup, a `seams` object reporting `0/0/0`) to look like a smaller version of a workspace — those fields are simply absent. A CAS with hundreds of children MUST NOT silently truncate what it reports; if a response-size budget requires bounding a list (seams, sub-CAS nodes, entities), the bound and the true total MUST both be stated, never a quietly shortened list presented as complete. No metric anywhere in this specification is permitted to read as failure at either end of the size spectrum: a single-repository company and a thousand-repository enterprise are both fully served by the same structure, and neither is a degraded case of the other.

## 0.10 Semantic rules and invariants (recursion-level)

- `has_children`, leaf status, source-backed, and ship-backed MUST be computed at read time, never stored as a cached boolean that can go stale relative to the CAS tree.
- A CAS tree MUST NOT contain a cycle (`parent_id` chains MUST terminate at a root).
- A composed (non-leaf) CAS MUST declare its `composition_mode` (§0.7).
- Every claim at a non-leaf CAS is traceable to a child claim, or is an explicitly-marked inter-child relation (§0.7, §0.8) or orphan-source fact (§0.7) — never a third, unmarked category.
- A parent CAS MUST NOT contradict its children on Tier 1-2 facts (§0.6) — this is a structural consequence of the derivation gradient, not a separately-enforced check. This rule does not extend to Tier 3 comprehension: a parent's re-derived capabilities/flows correctly omitting or reshaping what a child reports is expected (§0.7.1), not a contradiction.
- Slice-local / sub-tree-local referential integrity: a CAS's own capabilities/flows MUST reference only entry points, flows, and nodes present within that same CAS's own Tier 1-3 content — never a dangling reference into a sibling CAS.
- Tier 1-2 determinism, entry/exit point closed type sets, edge referential integrity, domain-concept distinctiveness evidence, and persisted-entity evidence gating all carry forward unchanged in shape from the pre-2.0.0 CAS — see the Field Catalog's semantic-rules section for the full, unchanged text of each.

## 0.11 No legacy compatibility

This is a greenfield change, stated as policy rather than left implicit:

- **No alias, no dual-read.** `sub_cas_nodes` is the only name for the field formerly called `das_index`. Code MUST NOT accept both names, MUST NOT emit both, and MUST NOT carry a `@deprecated` marker pointing from one to the other.
- **No migration code.** A stored pre-2.0.0 analysis is not read through a compatibility mapping. `cas_version` moving from `1.11.0` to `2.0.0` is a MAJOR bump under the existing, unrelated CAS versioning policy (`docs/cas/VERSIONING.md`) — which already treats a different-major stored analysis as `unsupported`/`newer-major` and returns a re-analysis instruction. That existing mechanism is sufficient; nothing new was built to "handle" old analyses, because the correct handling is re-analysis, not a read path.
- **Stored analyses do not constrain this specification.** Existing on-disk analyses are development artifacts, not customer commitments to preserve. If a 2.0.0 server cannot read a 1.x analysis, that is correct behavior, not a gap to patch.
- **Delete rather than deprecate.** A function, type, field, or file that existed only to support the three-separate-structure model is removed, not marked legacy and left in place. §0.12 and the accompanying report state exactly what this pass removed versus what remains as follow-on work, so nothing is silently left half-migrated.
- **Dated version-history files are the one exception.** `docs/cas/v1.0.0.md` through `v1.10.0-rfp.md` (and any similarly dated file) are historical records of what was true at a point in time. They are left exactly as they are — not rewritten to use 2.0.0 vocabulary, not deleted — because rewriting or removing them would falsify the audit trail, not clean it up.

## 0.12 Gap register

Recursion-level gaps, stated here so a consumer does not assume more coverage than exists. Field Catalog-level gaps (framework version/purpose, node-role taxonomy beyond route-handler/persisted-entity, dependency role classification, entity↔capability linkage asymmetry) are unchanged in shape from before 2.0.0 — see the Field Catalog's own gap material for those.

1. ~~Workspace-level (cross-repo) communication seams are not implemented~~ **Resolved.** `SeamLevel: 'workspace'` and `kind: 'cross_repo_contract'` are set by `buildWorkspaceCommunicationSeams` (§0.8.4). Two related mechanisms remain genuinely separate, not yet unified: `buildCrossRepoContractDrift` (`apps/mcp-server/src/product.ts`) is field-level contract-shape drift detection, a different question from seam presence/modality, and there is still no reachable customer entry point that *builds* the parent CAS in the first place (see item 7).
2. ~~Shared-dependency seams are not implemented~~ **Resolved.** `buildSharedDependencySeams` correlates `dependency_manifest.dependencies` by exact `(ecosystem, name)` match across sub-CAS nodes, `runtime`-scoped only (§0.8.3).
3. **Cross-sub-CAS-node name correlation is evidence-thin** (§0.8.2). A seam is only recognized when both sides name the same target string or the same shared entity; inconsistent naming between a caller's declared target and a callee's own identity produces no seam, with no resolution mechanism today. This is unchanged by item 1's resolution: `buildWorkspaceCommunicationSeams` re-expresses whatever the underlying `application_links` matching already found (route/topic/import evidence for direction; name-correlated `shared-data` links, themselves sourced from `detectSharedEntityLinks`, for the undirected case) — it does not add a new resolution step for inconsistent naming. Entity-anchoring direction is a further, distinct gap: task #128 found that anchoring records a type's CONSUMED occurrences but never its PRODUCED/emitted ones, so a service that only emits a shared contract type (e.g. `UserLoggedInMessage`) never anchors it at all — until that lands, this specification's seam mechanisms deliberately do not assert a producer/consumer direction for shared-type evidence, reporting it `passive`/undirected rather than guessing which side emits.
4. **`deployable_inventory` presence is gated on the wrong count** (§0.8.4). It should require at least one ship-boundary-qualified (`isShipBoundary`) deployable, not merely a non-empty `deployable_evidence` array, to honor the both-extremes rule (§0.9) precisely.
5. **`composition_mode` and cycle detection are documented-only.** No enforcement exists because the recursive structure beyond the single-repo (deployable) level is not yet built.
6. **Composition Option A vs. B is chosen per pre-2.0.0 precedent (`composed`), not freshly re-litigated at every level.** A future implementation MAY choose `derived` at some level for a specific reason; this specification does not forbid it, only requires the choice be declared (§0.7).
7. **No reachable customer path builds a parent CAS.** `buildCrossCodebaseSystemGraph`/`buildWorkspaceCommunicationSeams` exist and are exercised by `workspace-analysis`/`cross-codebase-analysis` in `apps/mcp-server/src/cli.ts`, and the shipped client (1.0.134) includes those subcommands, but there is no guided onboarding path (analogous to the single-repo `analyze_codebase` MCP flow) that walks a customer from "I have several repos" to a stored, queryable parent analysis. This is a distribution/onboarding gap, not a computation gap — the mechanism this section describes runs correctly once invoked.

---

## 1. Introduction

### 1.1 Purpose

Modern software systems require analysis from multiple perspectives - language constructs, framework patterns, architectural layers, business domains, and quality metrics. The CAS provides a unified format for capturing and sharing these diverse analytical views.

### 1.2 Scope

This specification defines:
- Data structures for representing code analysis results
- Semantic rules for multi-perspective analysis
- Query interfaces for information retrieval
- Extension mechanisms for future capabilities

This section (§1-§10, the "Field Catalog") describes the content of one CAS in full field-level detail — the same content a leaf/source-backed CAS carries directly and a composed parent CAS assembles from its children. §0 above defines the recursive structure this content lives inside: a CAS MAY have child CAS nodes (a repo with independently shippable units, an organization with member repos), to any depth, and every CAS in that tree — leaf or parent — carries this same shape. §0.6-§0.7 define composition; §0.8 defines how sub-CAS nodes interact. A single repo that itself resolves two or more independently shippable units becomes a parent CAS whose sub-CAS nodes are those units, decided by the promotion rule in §0.4 — derived from this repo's own completed facts, never a second source-level parse.

This specification does NOT define:
- Visualization or presentation formats
- Analysis algorithms or techniques
- Language-specific parsing rules
- Performance requirements

### 1.3 Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

## 2. Conformance

A conforming implementation:
- MUST produce output matching the specified data structures
- MUST implement the tag accumulation system correctly
- MUST maintain perspective independence
- MUST preserve analyzer attribution
- SHOULD support all defined metadata fields
- MAY extend the specification with additional fields

## 3. References

### 3.1 Normative References

- RFC 2119: Key words for use in RFCs to Indicate Requirement Levels
- RFC 8259: The JavaScript Object Notation (JSON) Data Interchange Format
- ISO 8601: Date and time format

### 3.2 Informative References

- Language Server Protocol Specification
- SARIF (Static Analysis Results Interchange Format)
- CodeQL Database Schema

## 4. Data Structures

### 4.1 CASOutput

The root structure containing complete analysis results:

```typescript
interface CASOutput {
  cas_version: "1.11.0";
  analysis_timestamp: string;  // ISO 8601
  analysis_id: string;          // Unique identifier

  system: {
    id: string;
    name: string;
    root_path: string;
    type?: string;
    description?: string;
    metadata?: Record<string, any>;
  };

  nodes: CASNode[];
  edges: CASEdge[];
  entry_points: EntryPoint[];      // Added in v1.1.0
  exit_points: ExitPoint[];        // Added in v1.1.0
  external_services: ExternalService[]; // Added in v1.1.0, filtered in v1.5.0

  repository_links?: CrossRepositoryLink[]; // Legacy/repo-local declared integration hints; cross-CAS composition belongs at a parent CAS (§0.6)
  cross_repository_links?: CrossRepositoryLink[]; // Backward-compatible alias
  dependencies?: Dependencies;
  disclosure?: DisclosureHints;     // Added in v1.1.0
  analyzer_contributions: AnalyzerContribution[];
  analysis_phases?: CASAnalysisPhase[]; // Added in v1.10.0
  progressive_levels?: ProgressiveLevels;

  perspectives?: CASPerspective[];  // Added in v1.2.0

  method_calls?: CASMethodCall[];   // Added in v1.3.0
  call_chains?: CASCallChain[];     // Added in v1.3.0, enhanced in v1.7.0
  decorators?: CASDecorator[];      // Added in v1.3.0

  documentation_summary?: CASDocumentationSummary;  // Added in v1.4.0
  todos_summary?: CASTodoSummary;                   // Added in v1.4.0
  implementation_health?: CASImplementationHealth;  // Added in v1.4.0
  system_health?: CASSystemHealth;                  // Coherence, risk, duplication, pattern drift, and remediation guidance

  patterns?: CASPattern[];          // Enhanced in v1.5.0 with variations

  test_suites?: CASTestSuite[];     // Added in v1.6.0
  mocks?: CASMock[];                // Added in v1.6.0
  fixtures?: CASFixture[];          // Added in v1.6.0
  test_summary?: CASTestSummary;    // Added in v1.6.0

  // v1.7.0 Inference-Based Intelligence
  intents?: CASIntent[];                        // Added in v1.7.0
  flow_summary?: CASFlowSummary;                // Added in v1.7.0
  change_risks?: CASChangeRisk[];               // Added in v1.7.0
  change_risk_summary?: CASChangeRiskSummary;   // Added in v1.7.0
  data_entities?: CASDataEntity[];              // Added in v1.7.0
  data_summary?: CASDataSummary;                // Added in v1.7.0
  behavioral_invariants?: CASBehavioralInvariant[];           // Added in v1.8.0
  behavioral_invariant_summary?: CASBehavioralInvariantSummary; // Added in v1.8.0
  security_boundaries?: CASSecurityBoundary[];  // Added in v1.7.0
  security_contexts?: CASSecurityContext[];     // Added in v1.7.0
  security_summary?: CASSecuritySummary;        // Added in v1.7.0
  flow_coverage?: CASFlowCoverage[];            // Added in v1.7.0
  test_gaps?: CASTestGap[];                     // Added in v1.7.0
  temporal_stability?: CASTemporalStability[];  // Added in v1.7.0
  stability_summary?: CASStabilitySummary;      // Added in v1.7.0

  // v1.8.0 Analysis Truth and Runtime Readiness
  configuration?: CASConfiguration;              // Runtime/configuration signals inferred from code
  runtime?: CASRuntime;                          // Deployment, monitoring, and instrumentation readiness
  runtime_static_links?: CASRuntimeStaticLink[]; // Static objects mapped to runtime signals
  analysis_facts?: CASAnalysisFact[];            // Evidence-backed claims behind CAS objects
  distribution_units?: CASDistributionUnit[];     // Install/release/deployment units that ship components together

  // v1.9.0 Codebase Idiom Intelligence
  codebase_idioms?: CASCodebaseIdiom[];           // Repo-local conventions with evidence and guidance
  idiom_summary?: CASIdiomSummary;                // Aggregate idiom counts and guidance digest
  idiom_examples?: CASIdiomExample[];             // Positive examples agents can copy
  idiom_violations?: CASIdiomViolation[];         // Known deviations and validation findings
  paradigm_conformance?: CASParadigmConformance[]; // Adoption rate of each detected paradigm, with deviations
  architectural_conflicts?: CASArchitecturalConflict[]; // A concern handled by two competing structural patterns
  principle_violations?: CASPrincipleViolation[]; // Layering / single-responsibility / coupling breaks

  // v1.7.0+ System capabilities and domain model (see §4.15)
  system_capabilities?: SystemCapability[];
  behavior_surfaces?: SystemCapability[];         // Registration/engine surfaces with no product-entity anchor; never ranked as capabilities
  system_purpose?: SystemPurpose;
  enhanced_system_purpose?: EnhancedSystemPurpose;
  domain_concepts?: CASDomainConcept[];           // Distinctiveness-gated domain vocabulary (see §5.28)
  workflows?: CASWorkflow[];
  workflow_graph?: CASWorkflowGraph;
  user_journeys?: CASUserJourney[];
  user_journey_summary?: CASUserJourneySummary;
  data_lineage?: CASEntityLineage[];
  flow_graph?: CASFlowGraph;
  product_map?: CASProductMap;                    // Whole-system rollup: identity, capabilities, journeys, data, conventions, health

  // v1.10.0 Graph-Anchored Semantic Retrieval
  embedding_index?: CASEmbeddingIndex;

  // v1.11.0 Structural intelligence, dependency facts, and cross-cutting classification (see §4.16)
  reachability_index?: CASReachabilityIndex;      // SCC condensation + landmark labeling over the call graph
  structural_importance_meta?: CASStructuralImportanceMeta; // Provenance for CASNode.structural_importance
  communities?: CASCommunity[];                   // Louvain functional modules (call-graph clustering)
  dependency_manifest?: CASDependencyManifest;    // Full declared-dependency FACT bundle (every manifest, every name)
  coverage_gaps?: CASCoverageGap[];                // Self-discovered analysis gaps (unknown deps, low extraction ratio, ...)
  conventions_applied?: ConventionMatchReport[];  // Audit trail for declared .klaurorc custom-architecture conventions
  communication_seams?: CommunicationSeamsResult; // Unified sync/async/passive seam classification
  consistency_model?: ConsistencyModelResult;     // CAP/consistency posture over data-store egress and passive seams
  runtime_static_links?: CASRuntimeStaticLink[];  // (moved up from v1.8.0 grouping below for adjacency)
  deployable_evidence?: DeployableEvidence[];      // Evidence-gated ship/build-artifact rows (see §4.14)
  distribution_units?: CASDistributionUnit[];      // (see §4.7 note — retained here for schema-order reference)
  codebase_type?: CodebaseType;                    // What KIND of thing this root is (web-backend, library, cli, ...)
  codebase_type_confidence?: number;
  codebase_types?: Array<{ type: CodebaseType; confidence: number }>; // Every codebase type with non-trivial evidence

  // Progressive layering (layered-entrypoint CAS only)
  layers_ready?: CASLayersReady;                   // L0..L5 layer-readiness ladder
  l0_index?: {                                     // Fast filesystem-walk index, present before L1+ facts land
    total_files: number;
    languages: Array<{ name: string; files: number }>;
    top_level_dirs: string[];
    duration_ms: number;
  };

  metadata?: SystemMetadata;
}
```

Fields listed above with no explicit "Added in vX.Y.0" annotation were introduced in v1.11.0. §4.15 and §4.16 define their shapes; §5.28-§5.33 state the invariants that govern them.

### 4.2 CASNode

Represents a code element with multi-perspective analysis:

```typescript
interface CASNode {
  id: string;                   // Unique identifier
  name: string;                  // Human-readable name
  type: string;                  // Node type (e.g., 'class', 'function', 'module')
  tags: string[];                // Classification tags (v1.1.0: accumulative from all analyzers)
  description?: string;           // Extracted or explicitly generated element description
  description_source?: 'deterministic' | 'ai' | 'manual' | 'reused';
  description_generation?: CASDescriptionGeneration;

  parent?: string;               // v1.5.0: REQUIRED for class members (methods, properties)

  perspectives: {                // Added in v1.2.0
    [perspectiveId: string]: {
      hierarchy: string[];       // Hierarchical path
      level: number;            // Depth (0 = top-level)
      priority: number;         // Importance (0-100)
      metadata?: Record<string, any>;
    }
  };

  analyzers: string[];          // Contributing analyzers (v1.1.0)
  primaryAnalyzer: string;      // Primary ownership (v1.1.0)

  source: SourceLocation;
  relationships?: Relationships;

  documentation?: CASDocumentation;    // Enhanced in v1.4.0
  comments?: CASComment[];             // Added in v1.4.0
  implementation_status?: CASImplementationStatus; // Added in v1.4.0
  todos?: CASTodo[];                    // Added in v1.4.0

  metrics?: Metrics;
  security?: SecurityContext;
  telemetry?: TelemetryHooks;
  dataFlow?: DataFlow;

  test_coverage?: CASTestCoverage;  // Added in v1.6.0

  metadata?: Record<string, any>;
}
```

### 4.3 CASEdge

Represents relationships between nodes:

```typescript
interface CASEdge {
  id: string;
  source: string;               // Source node ID
  target: string;               // Target node ID
  type: string;                 // Relationship type (v1.3.0+: extended types)

  analyzer?: string;            // Creating analyzer (v1.1.0)
  perspectives?: string[];      // Array of perspective IDs (v1.2.0)
  dataFlow?: EdgeDataFlow;

  aggregated_from?: string[];   // v1.5.0: For class-level edges, list of method-level call IDs
  relationship_metadata?: {     // v1.5.0: Additional context for class relationships
    injection_type?: 'constructor' | 'property' | 'method';
    instantiation_count?: number;
    usage_locations?: Array<{ file: string; line: number }>;
  };

  metadata?: Record<string, any>;
}

// Standard edge types (v1.0.0 - v1.2.0)
type StandardEdgeTypes = 'imports' | 'exports' | 'extends' | 'implements' |
                        'contains' | 'uses' | 'depends-on' | 'references';

// Call graph edge types (v1.3.0)
type CallGraphEdgeTypes = 'calls' | 'invokes' | 'delegates-to' | 'instantiates' |
                          'decorates' | 'guards' | 'intercepts' | 'validates' |
                          'transforms' | 'overrides';

// Class relationship edge types (v1.5.0)
type ClassRelationshipEdgeTypes = 'uses' | 'depends_on' | 'injects';
// - 'uses': ClassA has method that calls method in ClassB
// - 'depends_on': ClassA receives ClassB via constructor injection
// - 'injects': Module/container provides ClassB to ClassA
// - 'instantiates': ClassA creates instance of ClassB (from v1.3.0)

// Test edge types (v1.6.0)
type TestEdgeTypes = 'tests' | 'mocks' | 'stubs' | 'covers' | 'validates';
// - 'tests': Test -> Code being tested
// - 'mocks': Test -> Mock node
// - 'stubs': Test -> Stub node
// - 'covers': Test -> Covered node (from coverage data)
// - 'validates': Assertion -> Validated behavior
```

### 4.4 Call Graph Structures (v1.3.0)

#### CASMethodCall
Tracks function-to-function calls with execution context:

```typescript
interface CASMethodCall {
  id: string;
  caller_node: string;              // Source node ID
  target_node?: string;             // Target node ID (null for external)

  call_details: {
    method_name: string;
    signature?: string;
    location: {
      file: string;
      line: number;
      column: number;
    };
    call_type: 'direct' | 'method' | 'constructor' | 'abstract' |
               'interface' | 'callback' | 'hook' | 'dynamic';
    resolution_type: 'static' | 'dynamic' | 'polymorphic' |
                    'external' | 'unresolved';
  };

  execution_context: {
    is_async: boolean;
    is_conditional: boolean;
    is_in_loop: boolean;
    is_recursive: boolean;
    call_depth: number;
    conditional_depth: number;
    loop_depth: number;
    enclosing_function?: string;
    enclosing_class?: string;
  };

  arguments?: Array<{
    position: number;
    type?: string;
    value?: string;
    is_literal: boolean;
    is_variable: boolean;
  }>;

  external_details?: {
    library: string;
    module?: string;
    is_builtin: boolean;
    is_sdk: boolean;
    exit_point_id?: string;
  };

  framework_semantics?: {
    framework: string;
    decorator_type?: string;
    semantic_meaning?: string;
    route_info?: {
      method: string;
      path: string;
      parameters?: string[];
    };
  };

  performance_hints: {
    is_hot_path: boolean;
    is_potential_bottleneck: boolean;
    estimated_frequency?: number;
    is_critical_path?: boolean;
  };

  metadata?: Record<string, any>;
}
```

#### CASCallChain
Represents complete call paths from entry to exit:

```typescript
interface CASCallChain {
  id: string;
  chain_type: 'entry-to-exit' | 'circular' | 'recursive' |
              'dead-end' | 'hot-path' | 'critical-path';

  entry_point: {
    node_id: string;
    method_name: string;
    entry_point_id?: string;
  };

  exit_point?: {
    node_id?: string;
    method_name: string;
    exit_point_id?: string;
  };

  call_path: Array<{
    call_id: string;
    node_id: string;
    method_name: string;
    depth: number;
    execution_branch?: string;
  }>;

  characteristics: {
    total_calls: number;
    max_depth: number;
    has_external_calls: boolean;
    has_database_calls: boolean;
    has_async_calls: boolean;
    is_circular: boolean;
    is_recursive: boolean;
    complexity_score: number;
  };

  business_context?: {
    user_action?: string;
    business_process?: string;
    feature_area?: string;
  };

  risk_analysis: {
    risk_level: 'low' | 'medium' | 'high' | 'critical';
    risk_factors: string[];
    bottlenecks?: Array<{
      node_id: string;
      method_name: string;
      reason: string;
      impact: 'low' | 'medium' | 'high';
    }>;
  };

  // v1.7.0 Enhancements
  criticality?: 'critical' | 'high' | 'medium' | 'low';  // Added in v1.7.0
  criticality_factors?: string[];                         // Added in v1.7.0

  runtime_stats?: {                                       // Added in v1.7.0
    traffic_volume: 'very-high' | 'high' | 'medium' | 'low';
    avg_latency_ms?: number;
    error_rate_percent?: number;
    last_observed?: string;  // ISO 8601
  };

  test_coverage?: {                                       // Added in v1.7.0
    covered: boolean;
    coverage_percentage?: number;
    test_ids?: string[];      // Test entry point IDs
    gaps?: string[];          // Uncovered node IDs
  };

  metadata?: Record<string, any>;
}
```

#### CASDecorator
Framework-specific decorator/annotation semantics:

```typescript
interface CASDecorator {
  id: string;
  target_node: string;

  decorator_info: {
    name: string;
    type: 'method' | 'class' | 'property' | 'parameter';
    framework: string;
    source_location: {
      file: string;
      line: number;
      column: number;
    };
  };

  semantic_meaning: {
    category: 'routing' | 'validation' | 'security' | 'lifecycle' |
              'injection' | 'configuration' | 'other';
    behavior: string;
    affects_runtime: boolean;
  };

  parameters?: Array<{
    name: string;
    value: any;
    type: string;
  }>;

  routing_info?: {
    method: string;
    path: string;
    parameters: string[];
    guards?: string[];
    middleware?: string[];
  };

  security_info?: {
    authentication_required: boolean;
    roles?: string[];
    permissions?: string[];
  };

  metadata?: Record<string, any>;
}
```

### 4.5 Documentation Structures (v1.4.0)

#### CASDocumentation
Structured documentation extracted from code:

```typescript
interface CASDocumentation {
  type: 'jsdoc' | 'javadoc' | 'xmldoc' | 'docstring' | 'rustdoc' |
        'godoc' | 'phpdoc' | 'typedoc' | 'other';
  raw: string;
  summary?: string;
  description?: string;

  parameters?: Array<{
    name: string;
    type?: string;
    description?: string;
    optional?: boolean;
    default_value?: string;
  }>;

  returns?: {
    type?: string;
    description?: string;
  };

  throws?: Array<{
    type?: string;
    description?: string;
  }>;

  examples?: Array<{
    title?: string;
    code: string;
    language?: string;
  }>;

  tags?: Array<{
    tag: string;  // @deprecated, @since, @author, @see, @link
    value: string;
    metadata?: Record<string, any>;
  }>;

  framework_docs?: {
    swagger?: {
      summary?: string;
      description?: string;
      tags?: string[];
      operation_id?: string;
    };
    graphql?: {
      description?: string;
      deprecated?: boolean;
      deprecation_reason?: string;
    };
  };

  location: {
    start_line: number;
    end_line: number;
  };
}
```

#### CASComment
Inline and block comments with classification:

```typescript
interface CASComment {
  id: string;
  type: 'single-line' | 'multi-line' | 'inline' | 'block';
  style: '//' | '#' | '--' | '/* */' | '<!-- -->' | 'other';
  text: string;
  purpose?: 'explanation' | 'todo' | 'warning' | 'note' | 'hack' |
            'clarification' | 'disabled-code' | 'other';

  location: {
    file: string;
    line: number;
    column?: number;
    relative_to?: 'above' | 'inline' | 'below';
  };

  context?: {
    preceding_code?: string;
    following_code?: string;
    scope?: string;  // function, class, module, etc.
    scope_id?: string;  // Reference to CASNode
  };

  markers?: {
    is_todo?: boolean;
    is_fixme?: boolean;
    is_hack?: boolean;
    is_warning?: boolean;
    is_note?: boolean;
    is_question?: boolean;
    is_important?: boolean;
    custom_markers?: string[];
  };
}
```

#### CASTodo
Technical debt and work item tracking:

```typescript
interface CASTodo {
  id: string;
  type: 'TODO' | 'FIXME' | 'HACK' | 'NOTE' | 'WARNING' |
        'XXX' | 'OPTIMIZE' | 'REFACTOR';
  text: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';

  assignee?: string;  // Extracted from TODO(username)
  created_date?: string;  // If specified in comment
  due_date?: string;  // If specified

  location: {
    file: string;
    line: number;
    node_id?: string;  // Associated CASNode
  };

  context?: {
    function_name?: string;
    class_name?: string;
    estimated_effort?: string;
    related_issue?: string;  // GitHub/JIRA issue reference
  };

  classification?: {
    category?: 'bug' | 'feature' | 'refactor' | 'performance' |
               'security' | 'documentation' | 'test';
    technical_debt?: boolean;
    blocking?: boolean;
  };
}
```

#### CASImplementationStatus
Tracks completion and maturity status:

```typescript
interface CASImplementationStatus {
  status: 'complete' | 'partial' | 'stub' | 'not-implemented' |
          'deprecated' | 'experimental';

  indicators: {
    has_todo_markers: boolean;
    has_not_implemented_exceptions: boolean;
    has_stub_returns: boolean;
    has_placeholder_code: boolean;
    has_hardcoded_values: boolean;
    has_commented_out_code: boolean;
  };

  completeness?: {
    estimated_percentage?: number;
    missing_features?: string[];
    implemented_features?: string[];
  };

  deprecation?: {
    is_deprecated: boolean;
    deprecated_since?: string;
    removal_version?: string;
    alternative?: string;
    migration_guide?: string;
  };

  experimental?: {
    is_experimental: boolean;
    stability_level?: 'unstable' | 'experimental' | 'beta' | 'stable';
    api_may_change?: boolean;
  };
}
```

### 4.6 Perspective Support (v1.2.0)

#### CASPerspective
Enables multiple architectural views:

```typescript
interface CASPerspective {
  id: string;                    // Unique identifier
  name: string;                  // Display name
  description: string;           // What this perspective shows
  analyzer_id: string;           // Providing analyzer
  type: 'flow' | 'structure' | 'deployment' | 'data' | 'security' | 'custom';

  connection_rules?: {
    node_connections?: Array<{
      from_type: string;
      to_types: string[];
      edge_type: string;
      conditions?: Record<string, any>;
    }>;
    visible_node_types?: string[];
    relevant_edge_types?: string[];
  };

  layout_hints?: {
    style: 'hierarchical' | 'force' | 'circular' | 'grid';
    direction?: 'TB' | 'LR' | 'BT' | 'RL';
    group_by?: string;
  };

  metadata?: Record<string, any>;
}
```

### 4.7 Entry and Exit Points (v1.1.0)

#### EntryPoint
System entry points (API endpoints, CLI commands, etc.):

**Important Note on Entry Point Semantics by System Type:**
- **Web APIs/Services**: Entry points (HTTP, gRPC, GraphQL) typically map 1:1 with business capabilities. Each endpoint represents a distinct operation that can be grouped into capability domains.
- **CLI Tools**: Entry points are subcommands/invocation modes (e.g., `scan quick`, `scan deep`), NOT business capabilities. The actual capabilities (e.g., "port scanning", "web enumeration") are internal function clusters that get invoked by multiple subcommands. Capability detection for CLI tools must analyze call graphs and function clusters rather than entry points.
- **Frontend SPAs**: Entry points are routes/pages which represent user-facing views. Capabilities emerge from the services and state management the routes consume.

```typescript
// ENTRY_POINT_TYPES (analyzer-core/types/cas.types.ts) is the single source of
// truth for this union: CASEntryPoint['type'] is DERIVED from it
// (`type: typeof ENTRY_POINT_TYPES[number]`), and the orchestrator's
// isValidEntryPoint validator MUST check membership in the SAME array — see
// §5.29. A conforming producer MUST NOT emit a type outside this closed set.
const ENTRY_POINT_TYPES = [
  'http', 'websocket', 'cli', 'event', 'schedule', 'page', 'route',
  'message', 'file', 'test', 'lifecycle', 'api',
  // data/ML pipeline: orchestration task/asset node, the DAG/flow/job entry
  // itself, an ordered notebook code cell, an ML training-loop entry point.
  'task', 'pipeline', 'notebook-cell', 'train',
  // embedded/systems: a hardware/timer interrupt service routine, and a
  // kernel/driver hook (module_init/module_exit, fops, ioctl handler).
  'interrupt', 'driver',
  // desktop-app: an Electron IPC main-process handler, a Tauri Rust command.
  'ipc', 'command',
  // non-REST API: a gRPC/RPC server-side method handler — a method dispatch,
  // not an HTTP path.
  'rpc',
  // non-REST API: a GraphQL root operation (Query/Mutation/Subscription
  // field, or a field resolver). Addressed by OPERATION NAME over a single
  // transport endpoint, not by path+verb — not a route. Added in v1.11.0.
  'graphql',
] as const;
type CASEntryPointType = typeof ENTRY_POINT_TYPES[number];

interface EntryPoint {
  id: string;
  type: CASEntryPointType;
  name: string;
  description?: string;

  trigger: {                    // v1.5.0: Enhanced trigger information
    method: string;             // GET, POST, etc.
    path: string;               // v1.5.0: MUST be full path (e.g., /workspaces/:id)
    base_path?: string;         // v1.5.0: Controller/router base path
    parameters?: Array<{
      name: string;
      type: string;
      required?: boolean;
      location?: 'query' | 'path' | 'body' | 'header';
    }>;
  };

  handler: {
    node_id: string;      // Reference to CASNode
    method_name?: string;
    file: string;
    line: number;
  };

  security: {                   // v1.5.0: Enhanced security information
    authenticated: boolean;     // v1.5.0: MUST merge class-level and method-level guards
    guards: string[];           // v1.5.0: ALL guards (class + method level)
    roles?: string[];
    permissions?: string[];
  };

  metadata?: Record<string, any>;
}
```

#### ExitPoint
External system interactions:

```typescript
// EXIT_POINT_TYPES is the mirror single source of truth for this union (§5.29).
type CASExitPointType =
  'database' | 'api' | 'file' | 'message' | 'event' |
  'cache' | 'sdk' | 'webhook' | 'navigation' |
  'client_storage' | 'analytics';

interface ExitPoint {
  id: string;
  source_node: string;
  source_analyzer?: string;
  type: CASExitPointType;
  name: string;
  description?: string;

  target?: {
    service_id?: string;
    endpoint?: string;
    resource?: string;
    sdk?: string;
  };

  operation?: {
    action?: string;
    method?: string;
    async?: boolean;
  };

  data?: {
    input_type?: string;
    output_type?: string;
    transformation_node?: string;
  };

  reliability?: {
    retry_attempts?: number;
    timeout_ms?: number;
    circuit_breaker?: boolean;
  };

  connected_nodes?: string[];
  metadata?: Record<string, any>;
}
```

#### ExternalService
Third-party service dependencies:

```typescript
interface ExternalService {
  id: string;
  name: string;
  type: string;
  purpose?: 'consumption' | 'production' | 'bidirectional';
  description?: string;
  endpoint?: string;
  provider?: string;
  usage_pattern?: {
    frequency?: string;
    criticality?: string;
    operations?: string[];
  };
  connected_nodes?: string[];
  entry_points?: string[];
  exit_points?: string[];
  configuration?: Record<string, any>;
  monitoring?: {
    health_check?: string;
    metrics?: string[];
  };
  cost?: {
    model?: string;
    estimated_monthly?: string;
  };
}
```

#### CrossRepositoryLink
Legacy deterministic hints between this analysis and another repository or system boundary. New analyzers SHOULD prefer repo-local interfaces (`entry_points`, `exit_points`, `external_services`, `dependencies`, `runtime`, `configuration`, `analysis_facts`) and allow a parent CAS (§0.6, §0.7) to compose actual cross-project links after all its children's CAS outputs are available.

```typescript
interface CrossRepositoryLink {
  id: string;
  type: 'api' | 'library' | 'shared-schema' | 'message-contract' | 'shared-database';
  source_repository?: {
    url?: string;
    node_ids?: string[];
    path?: string;
  };
  target_repository?: {
    url?: string;
    node_ids?: string[];
    path?: string;
  };
  connection?: {
    protocol?: string;
    endpoint?: string;
    method?: string;
    contract?: string;
    package_name?: string;
    version?: string;
    broker?: string;
    exchange?: string;
    routing_key?: string;
    message_schema?: string;
  };
  metadata?: {
    verified?: boolean;
    last_sync?: string;
    breaking_changes?: boolean;
    confidence?: number;
    evidence?: CASFactEvidence[];
  };
}
```

#### CASRuntime
Runtime and instrumentation readiness inferred from code and configuration:

```typescript
interface CASRuntime {
  deployment?: {
    type?: string;
    orchestration?: string;
  };
  performance?: {
    request_duration_p50?: string;
    request_duration_p95?: string;
    request_duration_p99?: string;
  };
  dependencies?: {
    runtime?: string;
    system_libraries?: string[];
    external_services?: string[];
  };
  monitoring?: {
    health_check?: string;
    readiness_check?: string;
    metrics_endpoint?: string;
    logging?: {
      level?: string;
      format?: string;
      destinations?: string[];
    };
  };
  instrumentation?: {
    instrumentable_entry_points: string[];
    instrumentable_exit_points: string[];
    observed_call_chains: string[];
    missing_runtime_coverage: string[];
  };
}
```

#### Runtime Topology Metadata

A source-backed CAS is responsible for emitting the runtime and infrastructure facts that a composed parent CAS later reuses (§0.6, §0.7). Nodes discovered from Docker, Docker Compose, Kubernetes, Terraform, CI/CD, deployment manifests, or similar runtime surfaces SHOULD include:

```typescript
metadata: {
  topology_surface: 'docker' | 'docker-compose' | 'kubernetes' | 'terraform' | 'ci-cd' | string;
  environment?: 'local' | 'development' | 'staging' | 'production' | string;
  service_aliases?: string[];
  deployment_service_name?: string;
  attributes?: {
    provider?: string;
    terraform_type?: string;
    terraform_address?: string;
    ports?: string[];
    depends_on?: string[];
    environment?: string;
  };
}
```

CAS MUST distinguish provisioned/wired infrastructure from source-level usage. Docker/Compose/Terraform/CI facts may create runtime topology nodes and configuration evidence, but they MUST NOT be treated as source-backed usage unless source code, SDK calls, data access, messaging, or explicit runtime observations prove usage. External SDK services such as Auth0, Stripe, Datadog, Sentry, cloud SDKs, and messaging clients SHOULD be emitted through `external_services`, `dependencies`, or exit points even when they do not expose an HTTP endpoint.

#### CASRuntimeStaticLink
Bridge between a static CAS object and the runtime signal that would validate it:

```typescript
interface CASRuntimeStaticLink {
  id: string;
  kind: 'entry-point' | 'exit-point' | 'call-chain' | 'external-service' | 'telemetry-hook';
  static_id: string;
  runtime_signal: string;
  telemetry_status: 'observed' | 'instrumentable' | 'not-instrumented';
  confidence: number;
  instrumentation_points: string[];
  evidence: CASFactEvidence[];
}
```

#### CASAnalysisFact
Evidence-backed claims explaining why CAS contains a relationship, flow, or object:

```typescript
interface CASFactEvidence {
  kind: 'source-location' | 'analyzer' | 'configuration' | 'dependency' |
        'route' | 'runtime-signal' | 'naming' | 'graph';
  source: string;
  file?: string;
  line?: number;
  excerpt?: string;
  confidence: number;
}

interface CASAnalysisFact {
  id: string;
  subject_type: 'node' | 'edge' | 'entry_point' | 'exit_point' |
                'external_service' | 'workflow' | 'capability' |
                'runtime_link' | 'repository_link';
  subject_id: string;
  fact_type: 'definition' | 'relationship' | 'entry' | 'exit' |
             'workflow' | 'capability' | 'runtime-correlation' |
             'cross-repository';
  claim: string;
  confidence: number;
  produced_by: string;
  evidence: CASFactEvidence[];
}
```

#### CASDistributionUnit
Evidence-backed grouping for artifacts that are installed, released, or deployed as one unit while still preserving their separate runtime/process surfaces:

```typescript
interface CASDistributionUnit {
  id: string;
  name: string;
  kind: 'desktop-app' | 'mobile-app' | 'server-bundle' | 'installer' |
        'container-stack' | 'package' | 'deployment-unit';
  platforms: string[];
  component_names: string[];
  component_node_ids: string[];
  artifact_node_ids: string[];
  artifact_paths: string[];
  install_paths?: string[];
  evidence: Array<{
    source: 'installer' | 'install-script' | 'release-script' | 'service-unit' |
            'desktop-entry' | 'package-manifest' | 'container-topology' | 'ci' | 'inferred';
    file?: string;
    line?: number;
    claim: string;
    confidence: number;
  }>;
  confidence: number;
  agent_guidance?: string;
}
```

CASDistributionUnit MUST NOT collapse component nodes, entry points, or runtime surfaces. For example, a tray UI and a daemon may ship in one desktop installer, but they remain separate CAS nodes/deployable surfaces. The distribution unit records the install/release relationship so a parent CAS, MCP, and agents know that changes to one component may require installer, service, desktop-entry, release-manifest, or signing updates.

### 4.8 Pattern Detection with Variations (v1.5.0)

#### CASPattern
Architectural and design patterns with variation tracking:

```typescript
interface CASPattern {
  id: string;
  type?: 'design-pattern' | 'architectural-pattern' | 'anti-pattern';
  name: string;
  description?: string;
  confidence: number;           // 0-1 confidence score
  instances: string[];          // Node IDs implementing this pattern

  variations?: CASPatternVariation[];  // v1.5.0: Different implementations
  deviations?: CASPatternDeviation[];  // v1.5.0: Pattern issues/inconsistencies
}

interface CASPatternVariation {
  id: string;
  implementation: string;       // e.g., 'nestjs-di', 'manual-instantiation'
  description: string;
  instances: string[];          // Node IDs using this variation
  percentage: number;           // Percentage of total pattern instances
  characteristics?: Record<string, any>;
}

interface CASPatternDeviation {
  type: 'inconsistent-adoption' | 'partial-implementation' |
        'anti-pattern' | 'obsolete-usage' | 'mixed-styles';
  severity: 'info' | 'warning' | 'error';
  description: string;
  affected_instances: string[];
  recommendation?: string;
}
```

**Semantic Rules:**

1. When same pattern has multiple implementation approaches, create variations
2. Calculate percentage as `(variation.instances.length / pattern.instances.length) * 100`
3. Flag deviations when variations suggest inconsistency (e.g., <90% adoption of preferred approach)

#### Standard Pattern Catalog

CAS defines these standard pattern IDs so analyzer output is comparable across repositories:

| Pattern ID | Type | Detection Criteria | Required Variations |
|------------|------|--------------------|---------------------|
| `repository-pattern` | design-pattern | Nodes typed/tagged as repositories, names ending in `Repository` or `Repo`, or files under repository/data-access directories | `dependency-injection`, `manual-instantiation` when both appear |
| `service-layer-pattern` | design-pattern | Nodes typed/tagged as services or names ending in `Service` that encapsulate business operations | `dependency-injection`, `standalone` when both appear |
| `controller-pattern` | design-pattern | Controller, resolver, route handler, page, or view nodes that receive external input | `rest-api`, `graphql-resolver`, `page-route`, or framework-specific route style |
| `dependency-injection-pattern` | design-pattern | Constructor/property injection, provider registration, injectable decorators, or DI container bindings | `constructor-injection`, `provider-module`, `property-injection` when detectable |
| `module-pattern` | architectural-pattern | Module/package/bounded-context nodes grouping related providers, routes, components, or exports | `feature-module`, `core-module`, `shared-module` when detectable |
| `guard-pattern` | design-pattern | Guard, middleware, policy, interceptor, permission, or auth enforcement nodes | `authentication-guard`, `role-based-guard`, `custom-guard` |
| `layered-architecture` | architectural-pattern | Consistent entry/business/data/infrastructure layering visible through node tags and edges | Layer names present in `flow_graph.layers` |
| `mvc` | architectural-pattern | Model, view/page/template, and controller/handler roles connected through routes or framework conventions | `server-rendered`, `api-plus-client`, or framework-specific style |
| `circular-dependency-anti-pattern` | anti-pattern | Cycle detected in imports, `depends_on`, or `uses` edges | Each cycle represented as a deviation |
| `god-object-anti-pattern` | anti-pattern | Node exceeds configured size, complexity, or member-count thresholds | Each oversized node represented as a deviation |

Deviation severity SHOULD be assigned consistently:

- `error` when the pattern can break correctness or block analysis, such as circular dependencies.
- `warning` when the pattern creates maintainability risk, such as oversized objects or mixed repository styles.
- `info` when the analyzer finds a weaker consistency issue that does not imply immediate risk.

Analyzers MAY emit additional framework- or language-specific pattern IDs, but SHOULD map common concepts back to the catalog above when possible.

### 4.9 Codebase Idiom Intelligence (v1.9.0)

Codebase idioms describe repository-local practices that agents and humans should preserve when changing code. Idioms are not generic best practices; they are evidence-backed conventions derived from the analyzed codebase.

```typescript
type CASIdiomCategory =
  | 'naming'
  | 'file-organization'
  | 'module-boundary'
  | 'dependency-injection'
  | 'data-access'
  | 'error-handling'
  | 'validation'
  | 'auth-tenant-scope'
  | 'logging'
  | 'testing'
  | 'migrations'
  | 'async-style'
  | 'configuration';

interface CASCodebaseIdiom {
  id: string;
  category: CASIdiomCategory;
  name: string;
  description: string;
  confidence: number;   // 0-1 confidence score
  prevalence: number;   // 0-1 observed adoption within the relevant scope
  evidence: CASIdiomEvidence[];
  positive_examples: CASIdiomExample[];
  affected_scopes: CASIdiomScope;
  agent_guidance: {
    do: string[];
    avoid: string[];
    validation: string[];
  };
  deviations?: CASIdiomViolation[];
}

interface CASIdiomScope {
  languages?: string[];
  frameworks?: string[];
  node_types?: string[];
  file_globs?: string[];
  node_ids?: string[];
  files?: string[];
}

interface CASIdiomEvidence {
  kind: 'node' | 'edge' | 'file' | 'import' | 'decorator' |
        'test' | 'migration' | 'invariant' | 'pattern' |
        'analysis-fact';
  file?: string;
  line?: number;
  node_id?: string;
  edge_id?: string;
  fact_id?: string;
  claim: string;
  confidence: number;
}

interface CASIdiomExample {
  id: string;
  idiom_id: string;
  file: string;
  line?: number;
  node_id?: string;
  name?: string;
  excerpt?: string;
  explanation: string;
}

interface CASIdiomViolation {
  id: string;
  idiom_id: string;
  category: CASIdiomCategory;
  severity: 'info' | 'warning' | 'error';
  file?: string;
  line?: number;
  node_id?: string;
  description: string;
  recommendation: string;
  evidence?: CASIdiomEvidence[];
}

interface CASIdiomSummary {
  total: number;
  high_confidence: number;
  violations: number;
  by_category: Record<CASIdiomCategory, number>;
  top_idioms: string[];
  guidance_digest: string[];
}
```

### 4.10 System Health And Coherence

`system_health` summarizes whether the codebase is coherent enough for humans and agents to extend safely. It combines static health signals that otherwise live separately: architectural pattern balance, paradigm drift, complexity hotspots, duplicate concepts, implementation gaps, test gaps, runtime instrumentation gaps, and idiom violations such as naming, dependency-injection, and module-boundary drift.

```typescript
interface CASSystemHealth {
  score: number; // 0-100
  status: 'healthy' | 'watch' | 'at-risk' | 'critical';
  summary: string;
  risk_areas: CASSystemHealthRiskArea[];
  coherence: {
    status: 'coherent' | 'mixed' | 'drifting' | 'fragmented';
    paradigm_count: number;
    primary_paradigms: string[];
    conflicting_paradigms: string[];
    naming_convention_violations: number;
    dependency_injection_violations: number;
    module_boundary_violations: number;
    duplication_signals: number;
  };
  remediation: {
    immediate: string[];
    agent_rules: string[];
    validation_tools: string[];
  };
}

interface CASSystemHealthRiskArea {
  id: string;
  type:
    | 'complexity'
    | 'duplication'
    | 'paradigm-drift'
    | 'naming-drift'
    | 'dependency-injection-drift'
    | 'module-boundary-drift'
    | 'implementation-gap'
    | 'test-gap'
    | 'runtime-coverage-gap'
    | 'pattern-balance';
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  description: string;
  affected_files?: string[];
  affected_nodes?: string[];
  evidence: string[];
  recommendation: string;
  agent_guidance: string;
}
```

Semantic rules:

- Agents SHOULD use `system_health.remediation.agent_rules` before broad feature work, refactors, auth changes, data changes, and multi-file edits.
- `system_health.risk_areas` SHOULD point to concrete files, nodes, or evidence strings whenever the analyzer can identify them.
- Coherence findings SHOULD not replace `codebase_idioms`; they summarize where those idioms, architectural patterns, and risk fields show drift that should be fixed or consciously preserved.
- Duplication findings SHOULD be role-aware. A normal layered concept family such as `UserController`, `UserService`, `UserRepository`, and `UserEntity` is not duplication by itself; duplication risk is present when the same concept has multiple owners in the same architectural role, such as two business-service implementations.
- Runtime coverage gaps SHOULD be treated as missing observability, not proof that a flow is unused.

Idiom categories are intentionally agent-facing:

| Category | Meaning |
|----------|---------|
| `naming` | Local symbol, suffix, casing, and test-name conventions |
| `file-organization` | Source roots, feature folders, collocation, package boundaries |
| `module-boundary` | Module/package/export/import ownership rules |
| `dependency-injection` | Provider, constructor injection, container, and decorator styles |
| `data-access` | Repository, ORM, schema, entity, and database boundary conventions |
| `error-handling` | Framework exceptions, typed results, domain errors, and retry conventions |
| `validation` | DTO, schema, validator, form, and input validation placement |
| `auth-tenant-scope` | Auth, authorization, tenant/org scope, and guard conventions |
| `logging` | Logger abstraction and diagnostic output conventions |
| `testing` | Test placement, naming, fixture, mock, and focused validation conventions |
| `migrations` | Migration location and schema-change contract conventions |
| `async-style` | async/await, task/future/result, callback, or stream style |
| `configuration` | Config files, environment variables, settings, defaults, and secrets handling |

**Semantic Rules:**

1. An idiom MUST include evidence and at least one positive example unless it represents an inferred absence with explicit evidence.
2. Idioms MUST be repository-local. Generic language rules SHOULD only be emitted when the repository demonstrates them.
3. `confidence` SHOULD combine evidence strength, analyzer reliability, and sample count.
4. `prevalence` SHOULD measure observed adoption inside `affected_scopes`, not across the whole repository.
5. `agent_guidance` MUST be actionable enough for an agent to apply before editing and validate after editing.
6. `deviations` SHOULD identify nonconforming examples without treating every deviation as a defect; local exceptions can be valid.
7. Idioms that intersect behavioral invariants, security boundaries, data entities, migrations, or tests SHOULD reference those CAS facts through evidence.
8. Agents SHOULD validate both behavioral invariants and codebase idioms before finalizing edits.

### 4.10 Test Structures (v1.6.0)

#### TestMetadata
Test-specific metadata for categorization and analysis:

```typescript
interface TestMetadata {
  test_type: 'unit' | 'integration' | 'e2e' | 'acceptance' |
             'performance' | 'visual' | 'smoke' | 'bdd';
  test_style: 'procedural' | 'bdd' | 'property-based' |
              'snapshot' | 'parameterized';
  priority: 'critical' | 'high' | 'medium' | 'low';
  tags: string[];
  uses_mocks: boolean;
  is_async: boolean;
  timeout_ms?: number;
  framework: string;  // 'jest', 'pytest', 'rust-test', 'mocha', 'cypress', etc.

  bdd_context?: {
    feature?: string;
    scenario?: string;
    given?: string[];
    when?: string[];
    then?: string[];
  };

  parameterization?: {
    data_source: 'inline' | 'fixture' | 'external';
    parameter_count: number;
    cases: number;
  };
}
```

#### CASTestSuite
Groups of related tests:

```typescript
interface CASTestSuite {
  id: string;
  name: string;
  file_path: string;
  test_type: 'unit' | 'integration' | 'e2e' | 'acceptance';
  framework: string;

  tests: CASTestCase[];
  hooks: CASTestHook[];
  fixtures: string[];  // Node IDs of fixture/factory nodes
  mocks: string[];     // Node IDs of mock nodes

  coverage?: {
    nodes_tested: string[];  // Node IDs this suite tests
    coverage_percentage?: number;
  };

  metadata?: {
    parallel: boolean;
    timeout_ms?: number;
    retries?: number;
    skip_reason?: string;
  };
}

interface CASTestCase {
  id: string;
  name: string;
  description?: string;
  test_type: 'unit' | 'integration' | 'e2e' | 'acceptance' | 'bdd';

  assertions: CASAssertion[];
  mocks_used: string[];  // Node IDs
  targets: string[];     // Node IDs of code being tested

  bdd_steps?: Array<{
    type: 'given' | 'when' | 'then' | 'and' | 'but';
    text: string;
    implementation_id?: string;
  }>;

  parameterized?: {
    parameters: Array<{ name: string; values: any[] }>;
    case_count: number;
  };

  status: {
    skipped: boolean;
    focused: boolean;
    flaky: boolean;
  };
}

interface CASTestHook {
  id: string;
  type: 'before_all' | 'before_each' | 'after_each' | 'after_all';
  name?: string;
  node_id: string;
}

interface CASAssertion {
  id: string;
  type: 'equality' | 'truthiness' | 'exception' | 'mock_call' |
        'snapshot' | 'property' | 'custom';
  expression: string;
  target_node?: string;
  location: {
    line: number;
    column?: number;
  };
}
```

#### CASMock
Mock/stub/spy tracking:

```typescript
interface CASMock {
  id: string;
  name: string;
  type: 'mock' | 'stub' | 'spy' | 'fake';
  target_node?: string;  // Node ID of what this replaces
  framework: string;     // 'jest.fn', 'sinon', 'mockall', etc.

  implementation?: {
    return_value?: string;
    implementation_fn?: string;
    call_tracking: boolean;
  };

  used_by: string[];  // Test node IDs
}
```

#### CASFixture
Test fixtures and factories:

```typescript
interface CASFixture {
  id: string;
  name: string;
  type: 'factory' | 'fixture' | 'builder' | 'seed-data';
  file_path: string;

  generates?: string;  // Type/entity it creates
  dependencies: string[];
  used_by: string[];  // Test node IDs
}
```

#### CASTestCoverage
Per-node coverage information:

```typescript
interface CASTestCoverage {
  covered: boolean;
  coverage_percentage: number;
  tested_by: string[];  // Test node IDs
  untested_branches?: Array<{
    line: number;
    condition: string;
  }>;
}
```

#### CASTestSummary
Aggregated test statistics:

```typescript
interface CASTestSummary {
  total_tests: number;
  by_type: {
    unit: number;
    integration: number;
    e2e: number;
    acceptance: number;
    bdd: number;
    other: number;
  };
  by_status: {
    passing: number;
    failing: number;
    skipped: number;
    flaky: number;
  };
  coverage: {
    overall_percentage: number;
    by_layer: Record<string, number>;
  };
  mocks: {
    total: number;
    by_target_type: Record<string, number>;
  };
  fixtures: {
    total: number;
    factories: number;
    seed_data: number;
  };
}
```

**Semantic Rules:**

1. Tests MUST use `type: 'test'` for entry points, NOT `type: 'event'`
2. Test type SHOULD be inferred from file path when not explicit:
   - `/tests/` or `/integration/` -> `'integration'`
   - `/e2e/` or `/cypress/` -> `'e2e'`
   - Same directory as source with `.spec.` or `.test.` -> `'unit'`
3. BDD steps MUST be extracted from tests using Given/When/Then patterns
4. Mock nodes MUST have `target_node` pointing to what they replace
5. Test-to-code edges (`tests`, `covers`) MUST link tests to tested code

### 4.11 Inference-Based Intelligence Structures (v1.7.0)

#### CASDescriptionGeneration
Provenance for generated descriptions:

```typescript
interface CASDescriptionGeneration {
  status:
    | 'deterministic_initial'
    | 'deterministic_kept'
    | 'ai_applied'
    | 'ai_rejected'
    | 'ai_skipped'
    | 'ai_failed'
    | 'reused_previous';
  attempted: boolean;
  reason?: string;
  budget_ms?: number;
  generated_at?: string;
}
```

#### CASAnalysisPhase
Layered analysis phases:

```typescript
interface CASAnalysisPhase {
  id: string;
  name: string;
  priority: number;
  status: 'complete' | 'partial' | 'skipped' | 'deferred';
  purpose: 'visualization' | 'agent-development' | 'deep-context' | 'ai-enrichment' | 'runtime';
  default_phase: boolean;
  description: string;
  outputs: string[];
  agent_value: string;
  visualization_value: string;
  can_run_later: boolean;
  requires_ai?: boolean;
  generated_at?: string;
  notes?: string[];
}
```

Default analysis MUST prioritize `core-graph` and `agent-context` before heavier enrichment. AI enrichment is required for the system narrative and primary capability descriptions in every default CAS analysis. If no AI provider is available, CAS MUST mark those descriptions as degraded or failed with explicit `description_source` / `description_generation` provenance; deterministic text MUST NOT be presented as equivalent to AI-written narrative. Per-node, service, entity, entry point, and exit point descriptions SHOULD be deferred and generated only by explicit enrichment requests so default analysis stays fast and token-efficient.

#### CASIntent
Inferred purpose and architectural intent:

```typescript
interface CASIntent {
  node_id: string;
  inferred_purpose?: string;
  inferred_constraints?: string[];
  architectural_decision?: {
    decision: string;
    rationale?: string;
    evidence: IntentEvidence[];
  };
  workaround_indicator?: {
    is_workaround: boolean;
    workaround_for?: string;
    expected_resolution?: string;
  };
  confidence: 'high' | 'medium' | 'low';
}

interface IntentEvidence {
  type: 'commit_message' | 'pr_description' | 'code_comment' |
        'pattern_deviation' | 'naming_convention';
  source: string;
  excerpt: string;
  confidence_contribution: number;
}
```

#### CASFlowSummary
Summary of critical flows:

```typescript
interface CASFlowSummary {
  total_critical_flows: number;
  by_criticality: Record<string, number>;
  untested_critical_flows: string[];
  high_error_rate_flows: string[];
}
```

#### CASChangeRisk
Per-node change impact assessment:

```typescript
interface CASChangeRisk {
  node_id: string;
  risk_level: 'critical' | 'high' | 'medium' | 'low';
  risk_factors: ChangeRiskFactor[];

  downstream_impact: {
    direct_callers: string[];
    transitive_callers: string[];
    affected_call_chains: string[];
    affected_entry_points: string[];
  };

  test_protection: {
    has_direct_tests: boolean;
    has_integration_tests: boolean;
    test_ids?: string[];
    untested_callers?: string[];
  };

  stability_context: {
    recent_churn: boolean;
    commit_count_30d: number;
    bug_fix_density: number;
    last_refactor?: string;
  };

  recommendations?: string[];
}

interface ChangeRiskFactor {
  factor: 'many-callers' | 'critical-path' | 'high-traffic' |
          'no-tests' | 'recent-bugs' | 'complex-logic' |
          'external-dependency' | 'security-sensitive';
  severity: 'high' | 'medium' | 'low';
  details: string;
}

interface CASChangeRiskSummary {
  high_risk_nodes: string[];
  untested_critical_paths: string[];
  recent_hotspots: string[];
}
```

#### CASDataEntity
Entity-centric data lifecycle:

```typescript
// Structural kind, derived deterministically from framework evidence on the
// entity's anchor node(s) — NEVER from the entity's name or directory. See
// §5.28 for the evidence requirement this classification MUST satisfy.
type CASDataEntityKind =
  | 'persisted-entity'  // durable state, backed by CITED persistence evidence
  | 'api-response'      // the system's outward-facing produced/consumed contract
  | 'request-dto'       // inbound contract (@Body / validation DTO / request schema)
  | 'domain-shape'       // a real domain type with NO discriminating framework fact
  | 'value-object';      // field-only shape, no persistence, no route/api binding

interface CASDataEntity {
  id: string;
  name: string;
  schema_source?: string;
  description?: string;
  description_source?: 'deterministic' | 'ai' | 'manual' | 'reused';
  description_generation?: CASDescriptionGeneration;

  kind?: CASDataEntityKind;
  // 'framework-evidence' MAY only be claimed when kind_evidence cites the
  // decorator/attribute/mapping that proves it. 'shape-inference' means the
  // kind came from the selection path's shape alone — an honest label, not a
  // downgrade.
  kind_source?: 'framework-evidence' | 'shape-inference';
  // Citation for `kind` when kind_source === 'framework-evidence'. MANDATORY
  // for `persisted-entity` — see §5.28.
  kind_evidence?: string;

  fields?: Array<{
    name: string;
    type: string;
    is_sensitive: boolean;
    validation?: string[];
    // True when this field IS a relation (see `relations`) rather than a
    // plain scalar column. The field stays listed; it just must not read as
    // scalar state when a relation declaration proves otherwise.
    is_relation?: boolean;
  }>;

  lifecycle: {
    created_by: string[];
    read_by: string[];
    updated_by: string[];
    deleted_by: string[];
  };

  // Relations to OTHER entities, evidence-gated. `kind` separates a DATA
  // relation (an ORM association / typed composition — ERD content) from a
  // STRUCTURAL one (interface/trait/superclass composition) so a structural
  // edge can never masquerade as the entity's data model. A field whose NAME
  // merely looks like a foreign key produces no entry.
  relations?: Array<{
    target_name: string;
    relation_type: string;
    kind: 'data' | 'structural';
    cardinality?: '1:1' | '1:N' | 'N:1' | 'N:M';
    field?: string;
    inverse_field?: string;
    owning?: boolean;
    join_table?: string;
    evidence_source: 'orm-edge' | 'orm-declaration' | 'typed-composition' | 'structural-edge';
    evidence: string;
  }>;

  transformations?: Array<{
    from_node: string;
    to_node: string;
    transformation_type: 'map' | 'filter' | 'aggregate' |
                         'enrich' | 'validate' | 'sanitize';
  }>;

  invariants?: Array<{
    description: string;
    enforced_by: string[];
    source: 'validation' | 'constraint' | 'test' | 'assertion';
  }>;
}

interface CASDataSummary {
  entities: CASDataEntity[];
  sensitive_data_nodes: string[];
  validation_gaps: Array<{
    entity_id: string;
    missing_validation: string;
  }>;
}
```

**`kind` classification MUST NOT read the entity name, its casing, or its
directory.** `persisted-entity` in particular MUST carry `kind_evidence`
citing one of the admissible persistence carriers in §5.28; an entity whose
only qualification is living under an `entities/`-shaped directory MUST
classify as `domain-shape`, not `persisted-entity`.

#### CASBehavioralInvariant
Behavior-level rules that must stay true across code, schema, tests, and security boundaries:

```typescript
interface CASBehavioralInvariant {
  id: string;
  name: string;
  invariant_type: 'tenant-scope' | 'auth-boundary' | 'authorization' |
                  'db-constraint' | 'migration-contract' | 'test-coverage' |
                  'data-lifecycle' | 'business-rule';
  description: string;
  scope: {
    node_ids?: string[];
    entry_point_ids?: string[];
    entity_names?: string[];
    field_names?: string[];
    file_paths?: string[];
  };
  enforcement: Array<{
    source: 'code' | 'decorator' | 'database-schema' | 'migration' |
            'test' | 'configuration' | 'security-boundary' | 'naming';
    mechanism: string;
    confidence: 'enforced' | 'inferred' | 'missing';
    node_id?: string;
    file?: string;
    line?: number;
  }>;
  evidence: Array<{
    source: 'node' | 'entry_point' | 'database_schema' | 'security_boundary' |
            'test_suite' | 'migration_file' | 'source_file';
    id?: string;
    file?: string;
    line?: number;
    excerpt?: string;
  }>;
  related_tests?: string[];
  related_boundaries?: string[];
  related_entities?: string[];
  gaps?: string[];
  confidence: 'high' | 'medium' | 'low';
}
```

#### CASSecurityBoundary
Trust boundaries and security enforcement:

```typescript
interface CASSecurityBoundary {
  id: string;
  name: string;
  boundary_type: 'authentication' | 'authorization' | 'input-validation' |
                 'output-encoding' | 'rate-limiting' | 'encryption';

  enforcement_points: Array<{
    node_id: string;
    mechanism: string;
    confidence: 'enforced' | 'assumed' | 'missing';
  }>;

  trust_transition: {
    from_trust_level: 'untrusted' | 'partially-trusted' | 'trusted';
    to_trust_level: 'untrusted' | 'partially-trusted' | 'trusted';
  };

  sensitive_operations: string[];
  bypass_risks?: string[];
}

interface CASSecurityContext {
  node_id: string;
  trust_level: 'untrusted' | 'partially-trusted' | 'trusted';
  security_relevant: boolean;
  security_relevance_reason?: string;
  required_protections: string[];
  actual_protections: string[];
  protection_gaps?: string[];
}

interface CASSecuritySummary {
  boundaries: CASSecurityBoundary[];
  unprotected_sensitive_ops: string[];
  assumed_vs_enforced: {
    enforced: number;
    assumed: number;
    missing: number;
  };
}
```

#### CASFlowCoverage
Flow-level test coverage:

```typescript
interface CASFlowCoverage {
  call_chain_id: string;
  call_chain_name?: string;

  coverage_status: 'fully-covered' | 'partially-covered' | 'not-covered';
  coverage_percentage?: number;

  tested_segments: Array<{
    node_id: string;
    test_ids: string[];
    assertion_count: number;
  }>;

  untested_segments: Array<{
    node_id: string;
    importance: 'critical' | 'high' | 'medium' | 'low';
    reason: string;
  }>;

  test_quality: {
    has_unit_tests: boolean;
    has_integration_tests: boolean;
    has_e2e_tests: boolean;
    uses_mocks: boolean;
    mock_targets?: string[];
  };
}

interface CASTestGap {
  gap_type: 'untested-flow' | 'untested-branch' | 'mock-only' | 'no-assertions';
  location: {
    node_id?: string;
    call_chain_id?: string;
    line?: number;
  };
  severity: 'critical' | 'high' | 'medium' | 'low';
  recommendation: string;
}
```

#### CASTemporalStability
Git-based code stability metrics:

```typescript
interface CASTemporalStability {
  node_id: string;

  stability_score: number;
  stability_class: 'stable' | 'evolving' | 'volatile' | 'fragile';

  churn_metrics: {
    commits_30d: number;
    commits_90d: number;
    unique_authors_30d: number;
    lines_changed_30d: number;
  };

  quality_signals: {
    bug_fix_rate: number;
    refactor_frequency: 'frequent' | 'occasional' | 'rare';
    has_recent_regression: boolean;
  };

  age_context: {
    file_age_days: number;
    last_major_change?: string;
    is_legacy: boolean;
  };

  risk_correlation?: {
    high_churn_high_bugs: boolean;
    recent_refactor_unstable: boolean;
  };
}

interface CASStabilitySummary {
  by_stability_class: Record<string, number>;
  hotspots: Array<{
    node_id: string;
    reason: string;
  }>;
  legacy_areas: string[];
}
```

### 4.12 Summary and Health Structures (v1.4.0)

#### CASDocumentationSummary
System-wide documentation metrics:

```typescript
interface CASDocumentationSummary {
  total_documented_nodes: number;
  documentation_coverage: number;  // percentage

  by_type: {
    functions: { documented: number; total: number; coverage: number };
    classes: { documented: number; total: number; coverage: number };
    interfaces: { documented: number; total: number; coverage: number };
    modules: { documented: number; total: number; coverage: number };
  };

  by_documentation_type: Record<string, number>;

  quality_metrics: {
    average_description_length: number;
    parameters_documented: number;
    returns_documented: number;
    examples_provided: number;
    deprecated_items: number;
  };

  missing_documentation: Array<{
    node_id: string;
    node_name: string;
    node_type: string;
    importance: 'low' | 'medium' | 'high';
    reason: string;
  }>;
}
```

#### CASTodoSummary
Technical debt overview:

```typescript
interface CASTodoSummary {
  total_todos: number;
  total_fixmes: number;
  total_hacks: number;
  total_warnings: number;

  by_priority: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };

  by_category: Record<string, number>;

  technical_debt_items: number;
  blocking_items: number;

  hotspots: Array<{
    file: string;
    todo_count: number;
    types: string[];
  }>;

  age_analysis?: {
    old_todos: Array<{
      id: string;
      age_days?: number;
      text: string;
    }>;
  };
}
```

#### CASImplementationHealth
Overall system maturity assessment:

```typescript
interface CASImplementationHealth {
  complete_implementations: number;
  partial_implementations: number;
  stubs: number;
  not_implemented: number;
  deprecated: number;
  experimental: number;

  health_score: number;  // 0-100

  risk_areas: Array<{
    node_id: string;
    node_name: string;
    risk_type: 'incomplete' | 'deprecated' | 'unstable' | 'high-todo-density';
    risk_level: 'low' | 'medium' | 'high';
    recommendation: string;
  }>;

  deprecation_timeline?: Array<{
    node_id: string;
    node_name: string;
    deprecated_since: string;
    removal_version?: string;
  }>;
}
```

### 4.13 Incremental Analysis Structures (v1.8.0)

#### ChangeReport
Semantic and structural summary of an incremental analysis run:

```typescript
interface ChangeReport {
  timestamp: string;
  previousAnalysis: string;
  currentAnalysis: string;
  summary: {
    filesAdded: number;
    filesModified: number;
    filesDeleted: number;
    nodesAdded: number;
    nodesModified: number;
    nodesDeleted: number;
    edgesAdded: number;
    edgesModified: number;
    edgesDeleted: number;
  };
  impact: ImpactAnalysis;
  semantic_impact?: ChangeSemanticImpact;
  details: {
    files?: FileChange[];
    addedNodes: Array<{ id: string; name: string; type: string; file: string }>;
    modifiedNodes: Array<{ id: string; name: string; type?: string; file?: string; changes: string[] }>;
    deletedNodes: Array<{ id: string; name: string; type: string; file?: string }>;
    addedEdges: Array<{ id?: string; source: string; target: string; type: string }>;
    deletedEdges: Array<{ id?: string; source: string; target: string; type: string }>;
    addedEntryPoints?: Array<{ id: string; name: string }>;
    modifiedEntryPoints?: Array<{ id: string; name: string; details?: string }>;
    deletedEntryPoints?: Array<{ id: string; name: string }>;
    addedExitPoints?: Array<{ id: string; name: string }>;
    deletedExitPoints?: Array<{ id: string; name: string }>;
  };
  changeHistory?: ChangeHistoryEntry[];
}

interface ChangeSemanticImpact {
  affected_workflows: Array<{ id: string; name: string; reason: string }>;
  affected_capabilities: Array<{ id: string; name: string; reason: string }>;
  affected_data_entities: Array<{ id: string; name: string; reason: string }>;
  affected_runtime_links: Array<{ id: string; runtime_signal: string; reason: string }>;
  changed_contracts: Array<{ id: string; type: 'entry-point' | 'exit-point' | 'repository-link'; name: string }>;
  risk_reasons: string[];
}
```

### 4.14 Core Supporting Types

#### SourceLocation
File location information:

```typescript
interface SourceLocation {
  file: string;           // Relative path from root
  line: number;           // Starting line number
  column?: number;        // Starting column
  end_line?: number;      // Ending line number
  end_column?: number;    // Ending column
}
```

#### AnalyzerContribution
Tracks which analyzers contributed to the analysis:

```typescript
interface AnalyzerContribution {
  analyzer_id: string;
  analyzer_name: string;
  version: string;
  timestamp: string;      // ISO 8601
  nodes_contributed: number;
  edges_contributed: number;
  perspectives_provided?: string[];
  metadata?: Record<string, any>;
}
```

#### SystemMetadata
Additional system-level information:

```typescript
interface SystemMetadata {
  total_files: number;
  total_lines: number;
  primary_language?: string;
  languages?: Record<string, number>;  // Language: line count
  frameworks?: string[];
  build_tools?: string[];
  test_coverage?: number;
  last_modified?: string;  // ISO 8601
  [key: string]: any;
}
```

#### CASValidation
Completeness and graph integrity signals for consumers deciding how much to trust an analysis:

```typescript
interface CASValidation {
  schema_version?: string;
  validation_errors?: string[];
  validation_warnings?: Array<{
    path?: string;
    message?: string;
  }>;
  completeness?: {
    nodes_with_location?: number;
    edges_with_metadata?: number;
    documented_nodes?: number;
  };
  graph_integrity?: {
    total_edges: number;
    dangling_edges: number;
    connected_nodes: number;
    orphaned_nodes: number;
    entry_points_with_handlers: number;
    exit_points_with_sources: number;
    runtime_links_with_instrumentation: number;
    facts_with_evidence: number;
    relationship_coverage_score: number;
  };
}
```

### 4.15 System Capabilities and Domain Model (v1.7.0+, current shape v1.11.0)

#### SystemCapability
A structurally-anchored unit of what the system DOES for its consumers. See §5.31 for the anchoring requirement every emitted capability MUST satisfy.

```typescript
interface SystemCapability {
  id: string;
  name: string;
  // Provenance of `name`. A capability NAME asserts what the capability DOES —
  // comprehension, produced only by AI (or a curated 'manual' map, or 'reused'
  // incremental carry-forward), NEVER a deterministic keyword->label template.
  // Left unset (name holds `structural_label`) until the AI naming pass runs.
  name_source?: 'ai' | 'manual' | 'reused';
  name_generation?: CASDescriptionGeneration;
  // Deterministic FACT label: the humanized domain key anchored on the
  // terminal (api-response / persisted) entities the capability produces.
  // Pure structural fact, stable run-to-run, makes no claim about behavior.
  structural_label?: string;
  description: string;
  description_source?: 'deterministic' | 'ai' | 'manual' | 'reused';
  description_generation?: CASDescriptionGeneration;
  category: 'core' | 'supporting' | 'admin' | 'internal';

  operations: Array<{
    entry_point_id: string;
    entry_point_type: string;
    action: string;
    path_or_command?: string;
    trigger?: { method?: string; path?: string };
  }>;

  related_entities: string[];
  related_domains: string[];
  criticality: 'critical' | 'high' | 'medium' | 'low';
  criticality_factors: string[];
  // Provenance of the evidence that produced this capability:
  // 'behavior-surface' = derived from a named registration surface (an MCP
  // tool server, a socket-event namespace) with no persisted-entity anchor —
  // the AI catalog pass systematically misses these, so they are re-injected
  // if dropped (the flagship-capability guarantee). 'infrastructure' = the
  // capability's only anchors are runtime/lifecycle-shaped entities with no
  // product evidence; it fails the purpose test and is excluded from the
  // shipped catalog.
  evidence_kind?: 'behavior-surface' | 'infrastructure';
  // Inverted M:N capability<->flow edges, {flow_id, role, rationale} per tie.
  // Computed once, un-capped, persisted; omitted (never []) when uncomputed.
  related_flows?: Array<{ flow_id: string; role: string; rationale: string }>;
}
```

`behavior_surfaces` carries the SAME `SystemCapability` shape for navigation-tier
registration surfaces (mcp_tool / rpc / command / event / message-handler
engines with no product-entity anchor). A behavior surface is structurally
EXCLUDED from `system_capabilities`/ranking, is always `category: 'internal'`,
and its `criticality` is capped at `'medium'` so it can never outrank a domain
capability's urgency, while remaining fully navigable with its own
operations/entry-point evidence.

#### CASDomainConcept
Distinctiveness-gated domain vocabulary. See §5.30 for the evidence gate every entry MUST satisfy.

```typescript
interface CASDomainConcept {
  id: string;
  name: string;
  // DISTINCT USAGE SITES: separate code units, entry points, and entities
  // that use the term. NOT a raw token count.
  frequency: number;
  appears_in: {
    entry_points: string[];
    entities: string[];
    nodes: string[];
  };
  classification: 'core' | 'supporting' | 'infrastructure';
  // Factual account of where the term occurs. Structure, not comprehension.
  description?: string;
  // Rank key: how strongly the repo's own structure/authored text singles
  // this term out, as opposed to how often it occurs. Channel breadth
  // dominates; site spread only breaks ties, logarithmically.
  distinctiveness?: number;
  // WHY this term is a concept — the cited channels (see §5.30). A term with
  // no citation is not domain vocabulary, however frequent.
  distinctiveness_evidence?: string[];
}
```

#### SystemPurpose / EnhancedSystemPurpose

```typescript
interface SystemPurpose {
  primary_type: string;
  confidence: number;
  evidence: string[];
  secondary_types?: string[];
}

interface EnhancedSystemPurpose extends SystemPurpose {
  primary_domain: string;
  // Comprehension provenance is AI-only (see docs/cas/DETERMINISM-BOUNDARY.md);
  // left unset until AI runs, never coerced to 'deterministic' on empty output.
  domain_source?: 'deterministic' | 'ai' | 'ai-refined' | 'reused';
  // True when the deterministic domain won via an anchor gate or grounded
  // structural evidence. An anchored domain may only be NARROWED by AI
  // (refined to a more specific child label), never replaced sideways.
  domain_anchored?: boolean;
  domain_rejected_candidates?: Array<{ label: string; reason: string }>;
  // Capabilities whose AI description failed the grounding gate even after a
  // targeted repair pass, and fell back to deterministic structural text.
  // Present only when at least one capability degraded.
  capability_description_degradations?: Array<{ id: string; reason: string }>;
}
```

#### CASProductMap
Whole-system rollup consumed by `get_product_map`: identity, capabilities, journeys, data exposure, conventions, and health, in one bounded payload. See the type definitions in `analyzer-core/src/types/cas.types.ts` (`CASProductMap`, `CASProductMapCapability`, `CASProductMapJourney`, `CASProductMapRuntimeTopology`) for the full field-level shape; this specification defers to that file rather than reproducing every nested field, since `CASProductMap` is itself a projection over the structures already defined above (capabilities, journeys, data entities, paradigm conformance, health) plus the infra-topology join (`runtime_topology`) — it introduces no new evidence of its own.

### 4.16 Cross-Cutting Structural Facts (v1.9.0-v1.11.0)

#### CASDependencyManifest
Full declared-dependency FACT bundle — every manifest, every declared name, no interpretation:

```typescript
interface CASDependencyManifest {
  manifests: string[];               // Manifest files scanned, project-relative, sorted
  dependencies: CASDeclaredDependency[]; // Deduped names across all manifests, sorted
  total: number;                      // == dependencies.length
}

interface CASDeclaredDependency {
  name: string;                       // Raw package name exactly as declared
  ecosystem: 'npm' | 'pypi' | 'cargo' | 'go' | 'maven' | 'gradle' | 'nuget' | 'composer' | 'pub' | 'unknown';
  version?: string;
  scopes: Array<'runtime' | 'dev' | 'peer' | 'optional' | 'build'>;
  declared_in: string[];              // Manifest file(s) that declared it, sorted
}
```

This is a Camp-B structural fact bundle (see docs/cas/DETERMINISM-BOUNDARY.md):
raw names only. What a dependency MEANS is the AI comprehension pass's job,
reading this bundle as grounding — `dependency_manifest` itself MUST NOT carry
any interpretive label.

#### CASCoverageGap
Self-discovered gaps this analysis pass encountered but does not yet understand:

```typescript
type CASCoverageGapKind =
  | 'unknown-dependency' | 'low-extraction-ratio'
  | 'zero-entry-points' | 'unhandled-node-type';

interface CASCoverageGap {
  kind: CASCoverageGapKind;
  evidence: string;                   // Short human-readable statement
  file?: string;
  severity: 'low' | 'medium' | 'high';
  key?: string;                       // Machine-stable key for cross-repo aggregation
  detail?: Record<string, unknown>;
}
```

#### CASReachabilityIndex / CASStructuralImportanceMeta
Persisted structural-intelligence layer over the call graph (Tarjan SCC condensation + pruned 2-hop landmark labeling), enabling near-O(1) reachability/affected-set queries without a per-query traversal:

```typescript
interface CASReachabilityIndex {
  version: 1;
  node_ids: string[];                 // Sorted; array position = compact node index
  comp_of: number[];
  comp_count: number;
  comp_adj_offsets: number[];         // CSR condensation DAG
  comp_adj_targets: number[];
  label_out_offsets: number[];        // CSR 2-hop labels
  label_out: number[];
  label_in_offsets: number[];
  label_in: number[];
  stats: { nodes: number; edges: number; comps: number; largest_scc: number; label_entries: number };
}

interface CASStructuralImportanceMeta {
  algorithm: 'seeded-random-walk-power-iteration';
  damping: number;
  epsilon: number;
  max_iterations: number;
  iterations: number;
  converged: boolean;
  seed_count: number;                 // Non-test entry-point nodes
  seed_source: 'entry-points' | 'uniform';
  node_count: number;
  edge_count: number;
}
```

`CASReachabilityIndex` and `CASStructuralImportanceMeta` contain ONLY graph-shape
facts (no timestamps) — byte-stable across identical runs. `CASNode.structural_importance`
(a [0,1] centrality score) is computed from structure only, NEVER AI-derived.

#### CommunicationSeamsResult / ConsistencyModelResult
Unified sync/async/passive seam classification and CAP/consistency characterization, derived additively from exit points, messaging edges, entry points, config env vars, and data lineage — never a re-detection pass:

```typescript
interface CommunicationSeamsResult {
  seams: Array<{
    id?: string;
    source: string;
    target: string;
    modality: 'sync' | 'async' | 'passive';
    confidence: number;
    metadata?: { exit_point?: string; entry_point?: string; entity_id?: string; [key: string]: unknown };
  }>;
  inventory: {
    level: string;
    counts: { sync: number; async: number; passive: number; total: number };
    component_seams: Array<{
      source: string; target: string;
      modalities: Array<'sync' | 'async' | 'passive'>;
      sync: number; async: number; passive: number; total: number;
    }>;
  };
}

interface ConsistencyModelResult {
  // Per data-store egress / broadened passive seam: consistency posture
  // (strong | eventual | tunable), staleness risk, CP/AP lean, cited evidence.
  // Evidence-gated — never a guessed consistency. See analyzer/core/consistency-model.ts.
  [key: string]: unknown;
}
```

#### ConventionMatchReport
Audit trail for declared custom-architecture conventions (`.klaurorc` `conventions:`): what each declared convention matched or failed to match in the real extracted nodes. Evidence-gated — a convention with `matched: false` emits nothing rather than fabricating a route/entity/flow. Absent when no conventions are declared. See `analyzer/core/conventions-applier.ts` for the full per-convention shape.

#### DeployableEvidence
Evidence-gated ship/build-artifact rows — the deterministic signal that a subtree of the repo is its own independently shippable unit. Consumed by a parent CAS (§0.6, §0.7) to build its composed deployable list, and by this CAS itself (§0.4) to decide whether it promotes and gains sub-CAS nodes of its own — see §0.4's promotion rule.

```typescript
interface DeployableEvidence {
  root_path: string;
  name: string;
  tier: 1 | 2 | 3;                    // 1 = ship artifact, 2 = runnable-but-unpackaged, 3 = package identity
  kind: 'container' | 'compose-service' | 'k8s' | 'serverless' | 'installer' |
        'ci-deploy' | 'bin' | 'server-entry' | 'package';
  evidence: string[];
  ships_paths?: string[];
  ports?: number[];
  entrypoint_member?: string;         // Which of ships_paths is the primary/ENTRYPOINT of a multi-member bundle
  bundled_into?: string;              // Name of the unit this one ships inside of, when merged
}
```

See docs/SPEC-DEPLOYABLE-DETECTION.md for the tier-qualification rules and evidence-gated bundling/dedup pass that produces this array.

## 5. Semantic Rules

### 5.1 Node Identity

- Node IDs MUST be unique within an analysis result
- Node IDs SHOULD be deterministic across analyses
- Node IDs MUST NOT contain personal or sensitive information
- Node type MUST be specified (v1.0.0)

### 5.2 Tag System (v1.1.0+)

- Tags are additive and non-hierarchical
- Tags MUST be lowercase with hyphens for word separation
- Tags accumulate from all analyzers
- No single analyzer owns a tag
- Tags enable cross-cutting concerns identification

### 5.3 Perspective System (v1.2.0+)

- Each analyzer MAY provide one or more perspectives
- Perspectives are independent views of the same system
- A node MAY appear in multiple perspectives
- Perspective IDs MUST be unique
- Perspectives enable visualization switching

### 5.4 Call Graph Rules (v1.3.0+)

- Method calls MUST reference valid node IDs
- Call chains MUST have valid entry points
- External calls SHOULD link to exit points
- Recursive calls MUST be flagged
- Call depth tracking enables performance analysis

### 5.5 Documentation Rules (v1.4.0+)

- Documentation type MUST match language conventions
- Comments MUST preserve original formatting
- TODOs MUST be classified by type
- Implementation status MUST reflect actual code state
- Documentation coverage SHOULD be calculated

### 5.6 Analyzer Collaboration

1. **Language analyzers** create base nodes and extract documentation
2. **Framework analyzers** enhance with perspectives and decorators
3. **Library analyzers** add specialized metadata and exit points
4. **Pattern analyzers** identify cross-cutting concerns and call chains

### 5.7 External Services (v1.1.0+)

- Services MUST be classified by type
- Direction MUST be specified (consumption/production/bidirectional)
- Connection node MUST exist in the node list
- Critical services SHOULD be marked

### 5.8 Data Integrity

- All node references MUST be valid
- Circular references in edges are allowed but MUST be detectable
- Timestamps MUST use ISO 8601 format
- File paths MUST be relative to system root
- Version fields MUST use semantic versioning

### 5.9 Class Relationships (v1.5.0+)

- Class members (methods, properties, constructors) MUST have `parent` set to containing class ID
- When method in ClassA calls method in ClassB, a `uses` edge MUST exist from ClassA to ClassB
- When ClassA receives ClassB via constructor injection, a `depends_on` edge MUST be created
- When `new ClassName()` is encountered, an `instantiates` edge MUST be created
- Class-level edges SHOULD include `aggregated_from` referencing method-level call IDs

### 5.10 Entry Point Paths (v1.5.0+)

- HTTP entry points MUST have full paths including controller/router base paths
- `trigger.path` MUST be complete (e.g., `/workspaces/:id` NOT just `:id`)
- `security.guards` MUST include ALL guards (class-level AND method-level)
- `security.authenticated` MUST be true if ANY guard is an auth guard

### 5.11 Pattern Variations (v1.5.0+)

- When multiple implementations of same pattern exist, variations MUST be tracked
- Variation percentages MUST sum to 100%
- Deviations SHOULD be flagged when variation usage is inconsistent

### 5.12 External Services Filtering (v1.5.0+)

- JS built-ins (Object, Array, Promise, etc.) MUST be excluded from `external_services`
- Standard library modules (fs, path, crypto) MUST be excluded from `external_services`
- Services MAY include `is_builtin` and `is_standard_library` flags for filtering

### 5.13 Test Entry Points (v1.6.0+)

- Tests MUST use `type: 'test'` entry points, NOT `type: 'event'`
- Test type categorization SHOULD be inferred from file paths:
  - `/tests/` or `/integration/` directory -> `test_type: 'integration'`
  - `/e2e/` or `/cypress/` directory -> `test_type: 'e2e'`
  - Same directory as source code -> `test_type: 'unit'`
  - Rust `#[cfg(test)]` module -> `test_type: 'unit'`
  - Rust `/tests/` directory -> `test_type: 'integration'`
- BDD tests SHOULD have `bdd_context` with Given/When/Then steps extracted
- Mock usage MUST be tracked via `uses_mocks: true` in test metadata

### 5.14 Test-to-Code Relationships (v1.6.0+)

- When a test calls production code, a `tests` edge MUST be created from test to called node
- When a test uses a mock, a `mocks` edge MUST be created from test to mock node
- Mock nodes MUST have `target_node` pointing to the node they replace
- Coverage data SHOULD be integrated into nodes via `test_coverage` field
- Test suites SHOULD track which nodes they test via `coverage.nodes_tested`

### 5.15 Intent Inference (v1.7.0+)

- Intent SHOULD be inferred from commit history, comments, and pattern deviations
- Workaround indicators MUST include `confidence` level
- Evidence MUST include `source` references (file path, commit SHA, or PR number)
- When multiple evidence sources agree, confidence SHOULD be `'high'`
- When evidence is from comments only, confidence SHOULD be `'medium'`
- When inferred from naming alone, confidence SHOULD be `'low'`

### 5.16 Flow Criticality (v1.7.0+)

- Call chains SHOULD have `criticality` set based on traffic, error rate, and business impact
- `criticality: 'critical'` MUST be assigned when ANY of:
  - `runtime_stats.traffic_volume` is `'very-high'`
  - `runtime_stats.error_rate_percent` > 5 AND traffic is high
  - `business_context.business_process` contains "payment", "auth", or "checkout"
- `runtime_stats` SHOULD be populated when SDK telemetry is available
- `test_coverage.test_ids` MUST reference existing test entry point IDs
- `test_coverage.gaps` SHOULD list node IDs of untested segments

### 5.17 Change Risk (v1.7.0+)

- Risk level MUST consider: caller count, critical path membership, test coverage, stability
- `risk_level: 'critical'` MUST be assigned when 2+ high-severity factors present
- `downstream_impact.affected_call_chains` MUST reference existing `CASCallChain` IDs
- `stability_context.bug_fix_density` SHOULD be calculated as: (bug fix commits / total commits)
- Bug fix commits SHOULD be identified by commit message patterns: "fix", "bug", "issue", "patch"

### 5.18 Data Entity (v1.7.0+)

- Entities SHOULD be inferred from schema files, ORM models, and type definitions
- Sensitive fields MUST be flagged based on naming conventions (password, token, email, etc.)
- `lifecycle` operations MUST map to node IDs that perform CRUD
- `validation_gaps` SHOULD flag entities with `created_by` but no `validation` rules
- `description` MAY be present for drilldown views, but AI-generated entity descriptions SHOULD be produced by explicit enrichment requests rather than every default analysis run.
- Description consumers MUST inspect `description_source` and `description_generation`; stale or skipped AI descriptions MUST NOT be presented as if they were fresh AI output.

### 5.19 Security Boundary (v1.7.0+)

- Boundaries SHOULD be inferred from guards, middleware, and decorators
- Trust levels MUST propagate through the call graph based on boundary crossings
- `confidence: 'enforced'` SHOULD be set when guard/middleware explicitly present
- `confidence: 'assumed'` SHOULD be set when trust is implied but not enforced
- `confidence: 'missing'` MUST be set when sensitive operation lacks protection
- `protection_gaps` MUST be flagged when `required_protections` differs from `actual_protections`

### 5.20 Flow Coverage (v1.7.0+)

- Flow coverage MUST extend existing per-node coverage to `CASCallChain` level
- `coverage_percentage` SHOULD be calculated as: (tested_nodes / total_nodes_in_chain) * 100
- Test gaps MUST be categorized by severity based on `CASCallChain.criticality`
- `gap_type: 'mock-only'` SHOULD be flagged when all tests use mocks for critical dependencies
- `untested_segments[].importance` SHOULD align with the flow's criticality

### 5.21 Temporal Stability (v1.7.0+)

- Stability MUST be calculated from git history (commits, blame)
- `stability_score` SHOULD be 0-100, where 100 is most stable
- Bug fix rate SHOULD be inferred from commit messages containing: "fix", "bug", "patch", "issue"
- `is_legacy` SHOULD be detected from comments containing "legacy", "deprecated", "old"
- `hotspots` MUST be flagged when `stability_class` is `'volatile'` or `'fragile'`
- `risk_correlation.high_churn_high_bugs` MUST be true when commits_30d > 5 AND bug_fix_rate > 0.3

### 5.22 Capability Detection by System Type (v1.7.0+)

Capability detection strategies MUST vary based on the detected system type:

**Web APIs/Backend Services:**
- Entry points (HTTP endpoints) map directly to capabilities
- Group entry points by resource domain (e.g., `/users/*` -> "User Management")
- Each endpoint's HTTP method indicates the operation type (GET=read, POST=create, etc.)
- Capabilities are discoverable from entry point paths and methods

**CLI Tools:**
- Entry points are subcommands (e.g., `scan`, `analyze`, `export`)
- Subcommands represent **invocation modes**, NOT business capabilities
- The same capability may be invoked by multiple subcommands with different parameters
- Capabilities MUST be detected by analyzing:
  - Function clusters that perform related operations
  - Call graph patterns from entry points
  - Semantic analysis of function names and purposes
  - Shared dependencies between functions
- Example: A security scanner with `quick`, `standard`, `deep` subcommands has capabilities like "port scanning", "web enumeration", "vulnerability detection" that are internal function clusters called by all modes

**Frontend Applications:**
- Entry points are routes/pages
- Capabilities emerge from services, hooks, and state management consumed by routes
- Multiple routes may share the same underlying capabilities
- Analyze component dependencies and service calls to determine capabilities

**Libraries:**
- Entry points are exported functions/classes
- Capabilities are the functionality domains the exports provide
- Group related exports into capability domains

Capability descriptions MUST be AI-generated or AI-reviewed in the default summary pass. If AI is unavailable or rejected by the quality gate, CAS MUST retain provenance in `description_source` and `description_generation` so UI and MCP consumers can expose the gap instead of pretending deterministic text is equivalent.

### 5.23 Runtime-to-Static Correlation (v1.8.0+)

- Runtime topology facts SHOULD be produced at CAS time for Docker, Docker Compose, Kubernetes, Terraform, CI/CD, and deployment configuration so Workspace analysis can be generated from CAS only.
- `runtime_static_links` MUST reference existing entry points, exit points, call chains, external services, or telemetry hooks.
- `runtime_signal` MUST name the runtime metric, route, operation, service, or event stream that validates the static object.
- `telemetry_status` MUST be `observed` only when runtime evidence is present.
- Static-only candidates MUST use `instrumentable` or `not-instrumented` and SHOULD list concrete `instrumentation_points`.
- Runtime correlation MUST be emitted by CAS, not reconstructed by UI consumers.

### 5.24 Evidence and Confidence (v1.8.0+)

- `analysis_facts` SHOULD explain important CAS objects and relationships with evidence.
- Each fact MUST include at least one evidence item.
- Evidence SHOULD point to source locations, analyzer output, configuration, dependencies, routes, runtime signals, naming conventions, or graph structure.
- Confidence MUST be expressed as a number from 0 to 1.
- Cross-repository links SHOULD include `metadata.confidence` and evidence when the link is inferred rather than explicitly configured.

### 5.25 Graph Integrity (v1.8.0+)

- `validation.graph_integrity` SHOULD report dangling edges, orphaned nodes, entry point handler coverage, exit point source coverage, runtime instrumentation coverage, fact evidence coverage, and an aggregate relationship coverage score.
- `dangling_edges` MUST count every source or target reference that does not resolve to a graph endpoint. Edge endpoints MAY be node ids, entry point ids, or exit point ids (e.g. `calls` edges targeting `exit_db_*`/`exit_api_*`); auditors validating edges against `nodes` alone will misreport resolved exit-point references as dangling.
- `relationship_coverage_score` SHOULD be 0-100 and SHOULD combine source location, edge validity, entry/exit coverage, runtime link instrumentation, and analysis fact evidence.
- UI and MCP consumers SHOULD expose low integrity scores as trust warnings rather than silently rendering incomplete analysis.

### 5.26 Semantic Change Impact (v1.8.0+)

- Incremental `ChangeReport` objects SHOULD include `semantic_impact`.
- A changed node SHOULD be mapped to affected workflows, capabilities, data entities, and runtime links when those CAS objects reference the node directly or through a call chain.
- Added, modified, or deleted entry points, exit points, and repository links SHOULD be listed as changed contracts.
- `risk_reasons` SHOULD explain why the change matters beyond raw node or file counts.

### 5.27 Codebase Idiom Derivation and Validation (v1.9.0+)

- Idioms SHOULD be derived after core graph, framework, test, invariant, migration, and analysis-fact passes have completed.
- Idiom extraction SHOULD use nodes, edges, file paths, imports, decorators, tests, migrations, behavioral invariants, patterns, configuration, runtime facts, and analysis facts as evidence.
- An analyzer SHOULD emit an idiom only when the relevant scope has enough examples to distinguish a local convention from a single occurrence.
- Each idiom SHOULD include positive examples that are safe for agents to inspect before editing.
- Each idiom SHOULD include agent guidance with explicit do, avoid, and validation instructions.
- Validation SHOULD score changed files and diffs against idioms for correctness-adjacent drift: non-local naming, misplaced files, boundary bypasses, missing tests, schema changes without migrations, generic errors, transient logging, and auth/tenant-scope mistakes.
- Agent-facing MCP agent contexts SHOULD include compact idiom context for modify, debug, and review tasks.
- Agents SHOULD call both `validate_behavioral_invariants` and `validate_codebase_idioms` before finalizing edits.
- Live agent proof SHOULD include copied-repo A/B tasks where both arms can pass correctness and the with-CAS arm receives idiom context; acceptance SHOULD require positive idiom-conformance delta without correctness regression.

### 5.28 Persisted-Entity Evidence (v1.11.0)

- `CASDataEntity.kind === 'persisted-entity'` MUST NOT be assigned without a citable persistence fact. An entity classification with no discriminating framework evidence MUST degrade to `domain-shape`, never fall back to `persisted-entity`.
- The name or casing of an entity, or its residence under an `entities/`-shaped directory, MUST NOT be treated as persistence evidence.
- Admissible persistence evidence carriers (any one is sufficient, and `kind_evidence` MUST cite which one applied):
  1. an ORM mapping attribute on the node (`table` / `tableName` / `collection` / `orm` / `persisted`);
  2. a persistence decorator/annotation (`@Entity`, `@Table`, `@Document`, `@Model`, `@PrimaryKey`, `@Column`, ...) or an ORM base class the node extends (`BaseEntity`, `ActiveRecord`, `Model`, ...);
  3. an ORM-family analyzer subcategory (`orm-entity`, `typeorm`, `gorm`, ...);
  4. an analyzer that explicitly typed the node as an ORM entity/model;
  5. a table mapping / schema definition for the name in `database_schema` (a declared table, or a primary-key field);
  6. a migration that references the name;
  7. a repository/DAO that references the name.
- The bare `entity` subcategory alone is NOT an admissible carrier.
- A shape with `kind === 'domain-shape'` MUST still be surfaced (never dropped) and MUST be honestly labeled; it MUST be EXCLUDED from any ERD/entity-relationship rendering that implies durable storage.

### 5.29 Entry/Exit Point Closed Type Sets (v1.11.0)

- `CASEntryPoint.type` MUST be a member of `ENTRY_POINT_TYPES`, and `CASExitPoint.type` MUST be a member of `EXIT_POINT_TYPES` — both defined once in `analyzer-core/src/types/cas.types.ts` and consumed by BOTH the TypeScript union and the orchestrator's runtime validator (`isValidEntryPoint` / `isValidExitPoint`), so the two can never drift apart.
- Adding a new entry-point or exit-point kind MUST add it to the corresponding array only; a validator that hardcodes a second, separately-maintained allowlist is a defect.
- `graphql` is a first-class `CASEntryPoint` kind (v1.11.0): a GraphQL root operation is addressed by operation name over a single transport endpoint, not by path+verb, and MUST NOT be classified as a `route`.

### 5.30 Domain Concept Distinctiveness (v1.11.0)

- A `CASDomainConcept` MUST carry at least one cited channel in `distinctiveness_evidence`. A term with zero citations MUST NOT be emitted, however many times it occurs in source text.
- Admissible distinctiveness channels: the term names a data entity; the term is a capability SUBJECT; the term is an entry-point noun; the term recurs across three (3) or more distinct declared type names; the term appears in authored prose (README/manifest/comments).
- `frequency` MUST report distinct usage sites (code units + entry points + entities touched), never a raw token-occurrence count.
- The emitted domain-concept list MUST be capped (40 entries in the current implementation) and MUST NOT be padded to reach the cap when fewer terms qualify.
- Plural/singular twins of the same term (e.g. `workspace`/`workspaces`) MUST be merged into one entry when both forms are independently present.

### 5.31 Capability Structural Anchoring (v1.11.0)

- Every `SystemCapability` in `system_capabilities` MUST be structurally anchored: it MUST NOT ship purely from a name/keyword classification with no supporting graph evidence. Anchoring evidence includes (in order of strength): a terminal `api-response` entity the capability's operations produce; a `persisted-entity` the capability's implementing cluster operates on (with a minimum implementing-node-count floor); an unclassified (not proven-plumbing) entity with lifecycle breadth; or a substantial business-implementation cluster (service/usecase/workflow/entity/model-shaped nodes above a minimum count).
- A capability whose only anchors are runtime/lifecycle-shaped entities with no product (persisted/api-response) evidence MUST carry `evidence_kind: 'infrastructure'` and MUST be excluded from the shipped catalog — it fails the purpose test (see docs/SEMANTIC-MODEL.md).
- A capability derived from a named registration surface with no persisted-entity anchor (an MCP tool server, a socket-event namespace) MUST carry `evidence_kind: 'behavior-surface'` and is re-injected if a post-hoc catalog pass dropped it (the flagship-capability guarantee) — this is the one case where a capability may ship without a data-entity anchor, because the registration surface itself is the anchor.

### 5.32 Edge Referential Integrity (v1.11.0)

- Every `CASEdge.source` and `CASEdge.target` MUST resolve to the `id` of a row in `nodes`, `entry_points`, or `exit_points`. An edge with an endpoint that resolves to none of these three collections is DANGLING and is a defect, not an acceptable degradation.
- `CASValidation.graph_integrity.dangling_edges` MUST report the true count (0 for a conforming analysis); a nonzero count MUST NOT be silently tolerated by downstream consumers.
- This invariant is asserted as a release gate: `infrastructure/vps/analysis-smoke.mjs` runs `checkEdgeReferentialIntegrity` against a live deterministic (AI-off) analysis before every deploy and fails loud on any dangling endpoint.

### 5.33 Determinism (v1.11.0)

- Same unchanged source input MUST produce byte-identical Camp-B facts (nodes, edges, entry/exit points, entities, routes) across separate runs and separate processes, modulo the run-metadata allowlist (`analysis_id`, `analysis_timestamp`, `generated_at`, `execution_time_ms`).
- File/directory enumeration MUST be sorted before emission; raw filesystem/glob iteration order MUST NOT be treated as stable. This is enforced in `analyzer/core/glob-cache.ts`; a caller that walks the filesystem directly (bypassing the shared glob cache) MUST sort its own results.
- Generated ids MUST derive from stable facts (file path + content position), never from a per-run-instance counter — a counter-based id (`comment_${++counter}`-shaped) drifts across warm re-analysis in a long-lived server even when a fresh-process run looks stable.
- Regression coverage: `run-stability.test.ts` asserts byte-identity across repeated runs (including warm re-analysis) and rejects counter-shaped ids.
- **Cross-file `references`-edge resolution, status as of 2026-07-30 (updated from a 2026-07-07 "known open defect" note):** ambiguous name resolution (the same identifier declared in more than one file) now resolves import-source-aware first, falling back to a stable file/line/id tiebreak (`selectDeclarationCandidate` / `compareNodesStable` in `typescript-javascript-analyzer.ts`, commit `a3b6e0c2`) over content-hashed, order-independent declaration ids — this is the fix the 2026-07-07 note called for, landed the same day but never previously reconciled against the doc. Reproduced across 5 separate cold `node` processes on a fixture with genuine 3-way cross-file name ambiguity: byte-identical `references`-edge sets, 100% correct import-source attribution (`run-stability-cross-process.test.ts`). `6f15b06b` separately closed a no-token `glob-cache.ts` sorting gap that was an adjacent source of file-discovery-order variance. **Not yet re-verified at realistic corpus scale** (the ~24k-node class of repo the original 8128↔8134 edge-count variance was measured on) — see docs/cas/DETERMINISM-BOUNDARY.md for the full history and current status before treating full Camp-B byte-stability as unconditionally true at that scale. The module-level ordering, id-stability, and glob-sorting guarantees above ARE enforced today independent of that outstanding scale check.

## 6. Query Interface

### 6.1 Tag-Based Queries

Implementations SHOULD support:
- Union: Nodes with any specified tags
- Intersection: Nodes with all specified tags
- Exclusion: Nodes without specified tags

### 6.2 Perspective Queries

Implementations SHOULD support:
- Filtering by perspective presence
- Level-based queries within perspectives
- Hierarchy path matching

### 6.3 Progressive Disclosure

Implementations SHOULD support:
- Level-based retrieval
- Incremental detail loading
- Context preservation

### 6.4 Evidence, Runtime, and Change Queries

Implementations SHOULD support:
- Retrieving runtime-static links by kind, telemetry status, and static object ID
- Retrieving analysis facts by subject type, subject ID, and fact type
- Retrieving change history by time range, file, node, entry point, grouping, and hot spots
- Retrieving historical analysis snapshots by timestamp or snapshot ID
- Returning semantic impact for incremental changes when workflow, capability, data, or runtime context is available

### 6.5 Idiom Queries

Implementations SHOULD support:
- Retrieving codebase idioms by category, target node, file path, confidence, limit, and offset.
- Retrieving idiom examples for a specific idiom, category, target node, or file path.
- Validating explicit file lists, provided diff text, staged changes, and working-tree changes against idioms.
- Returning idiom-aware agent contexts that combine target resolution, risk, tests, behavioral invariants, and local idiom guidance.

## 7. Extensions

### 7.1 Extension Mechanism

Implementations MAY extend the specification by:
- Adding fields prefixed with underscore (_)
- Creating new analyzer perspectives
- Defining additional tag vocabularies
- Adding metadata to existing structures

### 7.2 Reserved Names

The following are reserved for future versions:
- Field names: version, schema, constraints, policies, workflows
- Tag prefixes: cas-, spec-, system-
- Perspective IDs: cas-*, spec-*

## 8. Security Considerations

### 8.1 Sensitive Information

- Source file paths MAY contain sensitive information
- Implementations SHOULD provide path sanitization options
- API keys and secrets MUST NOT appear in analysis results

### 8.2 Access Control

- The security context provides access level information
- Implementations SHOULD respect security classifications
- Query interfaces SHOULD enforce access controls

## 9. IANA Considerations

This document has no IANA actions.

## 10. Examples

### 10.1 Minimal Valid Output

```json
{
  "cas_version": "1.11.0",
  "analysis_timestamp": "2000-01-01T00:00:00Z",
  "analysis_id": "analysis_123",
  "system": {
    "id": "system_example",
    "name": "Example System",
    "root_path": "/path/to/system"
  },
  "nodes": [],
  "edges": [],
  "entry_points": [],
  "exit_points": [],
  "external_services": [],
  "analyzer_contributions": []
}
```

### 10.2 Complete Node with All v1.4.0 Features

```json
{
  "id": "function_user_service_create_user",
  "name": "createUser",
  "type": "function",
  "tags": ["async", "service", "user-management", "database-access"],

  "perspectives": {
    "nestjs-flow": {
      "hierarchy": ["UserModule", "UserService", "createUser"],
      "level": 2,
      "priority": 85,
      "metadata": {
        "injectable": true,
        "scope": "singleton"
      }
    }
  },

  "analyzers": ["typescript-analyzer", "nestjs-analyzer"],
  "primaryAnalyzer": "typescript-analyzer",

  "source": {
    "file": "src/user/user.service.ts",
    "line": 42,
    "column": 3,
    "end_line": 78,
    "end_column": 4
  },

  "documentation": {
    "type": "jsdoc",
    "raw": "/**\n * Creates a new user in the system\n * @param {CreateUserDto} userData - User creation data\n * @returns {Promise<User>} Created user entity\n * @throws {ConflictException} If email already exists\n * @since 1.2.0\n * @deprecated Use createUserV2 instead\n */",
    "summary": "Creates a new user in the system",
    "parameters": [
      {
        "name": "userData",
        "type": "CreateUserDto",
        "description": "User creation data"
      }
    ],
    "returns": {
      "type": "Promise<User>",
      "description": "Created user entity"
    },
    "throws": [
      {
        "type": "ConflictException",
        "description": "If email already exists"
      }
    ],
    "tags": [
      { "tag": "@since", "value": "1.2.0" },
      { "tag": "@deprecated", "value": "Use createUserV2 instead" }
    ]
  },

  "comments": [
    {
      "id": "comment_1",
      "type": "single-line",
      "style": "//",
      "text": "TODO: Add rate limiting to prevent spam",
      "purpose": "todo",
      "location": { "file": "src/user/user.service.ts", "line": 45 },
      "markers": { "is_todo": true }
    }
  ],

  "todos": [
    {
      "id": "todo_1",
      "type": "TODO",
      "text": "Add rate limiting to prevent spam",
      "priority": "medium",
      "location": {
        "file": "src/user/user.service.ts",
        "line": 45,
        "node_id": "function_user_service_create_user"
      },
      "classification": {
        "category": "security",
        "technical_debt": true
      }
    }
  ],

  "implementation_status": {
    "status": "partial",
    "indicators": {
      "has_todo_markers": true,
      "has_not_implemented_exceptions": false,
      "has_stub_returns": false,
      "has_placeholder_code": false,
      "has_hardcoded_values": false,
      "has_commented_out_code": false
    },
    "deprecation": {
      "is_deprecated": true,
      "deprecated_since": "1.2.0",
      "alternative": "createUserV2"
    }
  }
}
```

### 10.3 Method Call with Call Chain

```json
{
  "method_calls": [
    {
      "id": "call_1",
      "caller_node": "function_user_controller_register",
      "target_node": "function_user_service_create_user",

      "call_details": {
        "method_name": "createUser",
        "signature": "createUser(userData: CreateUserDto): Promise<User>",
        "location": {
          "file": "src/user/user.controller.ts",
          "line": 25,
          "column": 12
        },
        "call_type": "method",
        "resolution_type": "static"
      },

      "execution_context": {
        "is_async": true,
        "is_conditional": false,
        "is_in_loop": false,
        "is_recursive": false,
        "call_depth": 1,
        "conditional_depth": 0,
        "loop_depth": 0,
        "enclosing_function": "register",
        "enclosing_class": "UserController"
      },

      "framework_semantics": {
        "framework": "nestjs",
        "decorator_type": "@Post",
        "semantic_meaning": "HTTP POST handler",
        "route_info": {
          "method": "POST",
          "path": "/users/register",
          "parameters": ["userData"]
        }
      },

      "performance_hints": {
        "is_hot_path": true,
        "is_potential_bottleneck": false,
        "estimated_frequency": 1000,
        "is_critical_path": true
      }
    }
  ],

  "call_chains": [
    {
      "id": "chain_1",
      "chain_type": "entry-to-exit",

      "entry_point": {
        "node_id": "function_user_controller_register",
        "method_name": "register",
        "entry_point_id": "entry_post_users_register"
      },

      "exit_point": {
        "node_id": "function_user_repository_save",
        "method_name": "save",
        "exit_point_id": "exit_database_users"
      },

      "call_path": [
        {
          "call_id": "call_1",
          "node_id": "function_user_controller_register",
          "method_name": "register",
          "depth": 0
        },
        {
          "call_id": "call_2",
          "node_id": "function_user_service_create_user",
          "method_name": "createUser",
          "depth": 1
        },
        {
          "call_id": "call_3",
          "node_id": "function_user_repository_save",
          "method_name": "save",
          "depth": 2
        }
      ],

      "characteristics": {
        "total_calls": 3,
        "max_depth": 2,
        "has_external_calls": true,
        "has_database_calls": true,
        "has_async_calls": true,
        "is_circular": false,
        "is_recursive": false,
        "complexity_score": 12
      },

      "business_context": {
        "user_action": "User Registration",
        "business_process": "Onboarding",
        "feature_area": "Authentication"
      },

      "risk_analysis": {
        "risk_level": "medium",
        "risk_factors": ["database-dependency", "no-rate-limiting"],
        "bottlenecks": [
          {
            "node_id": "function_user_repository_save",
            "method_name": "save",
            "reason": "Database write operation",
            "impact": "medium"
          }
        ]
      }
    }
  ]
}
```

### 10.4 Framework Decorator Example

```json
{
  "decorators": [
    {
      "id": "decorator_1",
      "target_node": "function_user_controller_register",

      "decorator_info": {
        "name": "@Post",
        "type": "method",
        "framework": "nestjs",
        "source_location": {
          "file": "src/user/user.controller.ts",
          "line": 23,
          "column": 3
        }
      },

      "semantic_meaning": {
        "category": "routing",
        "behavior": "Registers HTTP POST endpoint",
        "affects_runtime": true
      },

      "parameters": [
        {
          "name": "path",
          "value": "register",
          "type": "string"
        }
      ],

      "routing_info": {
        "method": "POST",
        "path": "/users/register",
        "parameters": ["userData"],
        "guards": ["AuthGuard"],
        "middleware": ["ValidationPipe"]
      },

      "security_info": {
        "authentication_required": false,
        "roles": [],
        "permissions": []
      }
    }
  ]
}
```

## 11. Migration Guide

### 11.1 Upgrading from v1.0.0 to v1.1.0

**Required changes:**
- Add `entry_points`, `exit_points`, and `external_services` arrays (can be empty)
- Add `analyzer_contributions` array

**Optional enhancements:**
- Populate entry/exit points for system boundaries
- Add `analyzers` and `primaryAnalyzer` to nodes
- Include `disclosure` hints for progressive rendering

### 11.2 Upgrading from v1.1.0 to v1.2.0

**Required changes:**
- Update `cas_version` to "1.2.0"

**Optional enhancements:**
- Add `perspectives` array for multi-view support
- Add `perspectives` object to nodes for hierarchical organization
- Include perspective-specific metadata

### 11.3 Upgrading from v1.2.0 to v1.3.0

**Required changes:**
- Update `cas_version` to "1.3.0"

**Optional enhancements:**
- Add `method_calls` array for call graph tracking
- Add `call_chains` array for execution flow analysis
- Add `decorators` array for framework semantics
- Use new call graph edge types (`calls`, `invokes`, etc.)

### 11.4 Upgrading from v1.3.0 to v1.4.0

**Required changes:**
- Update `cas_version` to "1.4.0"

**Optional enhancements:**
- Add `documentation` to nodes for extracted docs
- Add `comments` array to nodes
- Add `todos` array for technical debt tracking
- Add `implementation_status` for maturity assessment
- Include summary structures (`documentation_summary`, `todos_summary`, `implementation_health`)

### 11.5 Upgrading from v1.4.0 to v1.5.0

**Required changes:**
- Update `cas_version` to "1.5.0"
- Set `parent` field for all class members (methods, properties, constructors)
- Use full paths in entry points (e.g., `/workspaces/:id` not just `:id`)
- Merge class-level and method-level guards in entry point security

**Optional enhancements:**
- Add `uses`, `depends_on`, `injects` edges for class-to-class relationships
- Add `variations` and `deviations` to patterns
- Include `aggregated_from` in class-level edges
- Filter out JS builtins from external services

### 11.6 Upgrading from v1.5.0 to v1.6.0

**Required changes:**
- Update `cas_version` to "1.6.0"
- Migrate test entry points from `type: 'event'` to `type: 'test'`
- Tests previously marked as `type: 'event'` with `metadata.event === 'test'` MUST use `type: 'test'`

**Optional enhancements:**
- Add `test_suites` array with `CASTestSuite` objects
- Add `mocks` array with `CASMock` objects tracking mock/stub/spy usage
- Add `fixtures` array with `CASFixture` objects
- Add `test_summary` with aggregated test statistics
- Add `test_coverage` to nodes to show which tests cover each function/class
- Add `tests`, `mocks`, `covers` edges for test-to-code relationships
- Extract BDD steps (Given/When/Then) into `bdd_steps` arrays
- Categorize tests by type (unit, integration, e2e, acceptance)

**Breaking changes:**
- Tests previously discoverable via `entry_points.filter(e => e.type === 'event' && e.metadata.event === 'test')` must now use `entry_points.filter(e => e.type === 'test')`

### 11.7 Upgrading from v1.6.0 to v1.7.0

**Required changes:**
- Update `cas_version` to "1.7.0"

**Optional enhancements:**
- Add `criticality`, `criticality_factors` to `CASCallChain` for flow importance
- Add `runtime_stats` to `CASCallChain` for SDK telemetry data
- Add `test_coverage` to `CASCallChain` for flow-level coverage
- Add `intents` array with `CASIntent` objects for inferred purpose
- Add `flow_summary` with critical flow statistics
- Add `change_risks` array with `CASChangeRisk` per-node risk assessment
- Add `change_risk_summary` with high-risk node aggregation
- Add `data_entities` array with `CASDataEntity` for entity lifecycle tracking
- Add `data_summary` with sensitive data and validation gap analysis
- Add `security_boundaries` array with `CASSecurityBoundary` trust model
- Add `security_contexts` array with per-node trust levels
- Add `security_summary` with protection gap analysis
- Add `flow_coverage` array with `CASFlowCoverage` flow-level test coverage
- Add `test_gaps` array with `CASTestGap` coverage gaps
- Add `temporal_stability` array with `CASTemporalStability` churn metrics
- Add `stability_summary` with hotspot and legacy area analysis

**Implementation requirements:**
- Git integration required for intent inference and temporal stability
- SDK telemetry integration required for runtime_stats
- Call graph traversal required for downstream impact analysis

**Breaking changes:**
- None. All new fields are optional.

### 11.8 Upgrading from v1.7.0 to v1.8.0

**Required changes:**
- Update `cas_version` to "1.8.0"

**Optional enhancements:**
- Implement `analyzeFileSingle()` in language analyzers for incremental analysis
- Track `IncrementalState` between analysis runs
- Generate `ChangeReport` for each incremental analysis
- Store `ChangeHistoryEntry` records for change queries
- Implement change detection using mtime, git, or content hash
- Emit `runtime`, `runtime_static_links`, and instrumentation readiness so static analysis can be validated by telemetry
- Emit `analysis_facts` with confidence and evidence for nodes, edges, flows, capabilities, runtime links, and repository links
- Include `semantic_impact` in change reports for affected workflows, capabilities, data entities, contracts, and runtime links
- Include confidence and evidence on cross-repository links inferred from APIs, shared packages, message contracts, schemas, or database usage

**New analyzer interface:**
```typescript
interface BaseAnalyzer {
  // Existing methods...

  // New in v1.8.0
  supportsIncrementalAnalysis(): boolean;
  analyzeFileSingle?(context: FileAnalysisContext): Promise<FileAnalysisResult>;
  getRelevantFiles?(projectPath: string): Promise<string[]>;
}
```

**Breaking changes:**
- None. All new fields and features are optional.

### 11.9 Upgrading from v1.8.0 to v1.9.0

**Required changes:**
- Update `cas_version` to "1.9.0"

**Optional enhancements:**
- Emit `codebase_idioms` with confidence, prevalence, evidence, positive examples, affected scopes, agent guidance, and deviations.
- Emit `idiom_summary`, `idiom_examples`, and `idiom_violations` for compact UI and MCP consumption.
- Add a post-analysis idiom detector that derives local conventions from nodes, edges, file paths, imports, decorators, tests, migrations, behavioral invariants, patterns, configuration, and analysis facts.
- Add MCP queries for codebase idioms, idiom examples, idiom validation, and idiom-aware agent contexts.
- Extend agent contexts so modify/debug/review workflows validate both behavioral invariants and codebase idioms after edits.
- Add live A/B idiom quality proof that measures correctness, idiom conformance, minimality, test relevance, boundary preservation, and file targeting.
- Account for every real repository in machine-wide proof runs, including unsupported and skipped repositories with explicit reasons.

**Breaking changes:**
- None. All new fields and features are optional.

### 11.10 Upgrading from v1.9.0 to v1.10.0

**Required changes:**
- Update `cas_version` to "1.10.0"

**Optional enhancements:**
- Emit `system_health` with coherence, risk areas, remediation guidance, and agent validation tools.
- Fold complexity, duplication, paradigm drift, naming/DI/module convention drift, implementation gaps, test gaps, and runtime coverage gaps into system health.
- Expose system health through MCP so agents preserve local paradigms and can also fix duplication, risks, and drift intentionally.
- Use runtime observations with static CAS links to rank operational priorities such as bugs, bottlenecks, and problematic flows.

**Breaking changes:**
- None. All new fields and features are optional.

### 11.11 Upgrading from v1.10.0 to v1.11.0

**Required changes:**
- Update `cas_version` to "1.11.0".
- A consumer that reads `CASDataEntity.kind` MUST stop treating `persisted-entity` as a name-derived classification and instead read `kind_evidence`/`kind_source`; entities previously read as persisted purely by directory/name convention now classify as `domain-shape` and are excluded from ERD rendering.
- A consumer that renders `domain_concepts` MUST stop ranking by `frequency` alone (now distinct-usage-sites, not a token count) and MUST expect the list capped at 40 non-padded entries.
- A consumer that reads `CASEntryPoint.type`/`CASExitPoint.type` MUST accept `graphql` as a valid entry-point kind and MUST NOT hardcode a separate allowlist — read `ENTRY_POINT_TYPES`/`EXIT_POINT_TYPES` from `analyzer-core/src/types/cas.types.ts` (or treat any value outside the documented closed set as a schema violation to report, not silently drop).

**Optional enhancements:**
- Consume `dependency_manifest` for the full declared-dependency fact bundle (not just the recognized-framework subset in `libraries`).
- Consume `coverage_gaps` to drive systematic gap-closing instead of ad hoc discovery.
- Consume `communication_seams` / `consistency_model` for unified sync/async/passive seam classification and CAP posture.
- Consume `conventions_applied` for an audit trail of declared `.klaurorc` custom-architecture conventions.
- Consume `reachability_index` / `structural_importance_meta` for near-O(1) reachability queries instead of per-query graph traversal.
- Consume `layers_ready` / `l0_index` on layered-entrypoint analyses to distinguish "still computing" from "absent from the codebase."

**Breaking changes:**
- None at the schema level (every new/changed field is additive or a narrowing of an existing optional field's semantics). The `persisted-entity`/`domain_concepts` reclassifications above are a SEMANTIC narrowing of existing fields, not a shape change — a consumer that already treats absence/uncited claims conservatively is unaffected.

### 11.12 Backward Compatibility

All versions maintain backward compatibility:
- New fields are optional
- Existing fields retain their semantics
- Older outputs remain valid in newer versions
- Analyzers can progressively adopt new features

## Appendices

### Appendix A: Version History

- **v1.11.0**: Structural Intelligence, Dependency Facts, and Invariant Hardening
  - Evidence-gated `persisted-entity` classification (`kind_evidence`), replacing the uncited persistence fallback
  - Distinctiveness-gated domain concepts (`distinctiveness_evidence`), replacing raw-frequency ranking
  - Structural anchoring required for every shipped `system_capabilities` entry; `behavior_surfaces` navigation tier for unanchored registration surfaces
  - `ENTRY_POINT_TYPES` / `EXIT_POINT_TYPES` promoted to single-source-of-truth closed sets; `graphql` added as a first-class entry-point kind
  - Full declared-dependency manifest (`dependency_manifest`)
  - Self-discovered coverage gaps (`coverage_gaps`)
  - Unified communication-seam classification (`communication_seams`) and CAP/consistency characterization (`consistency_model`)
  - Custom-architecture convention audit trail (`conventions_applied`)
  - Reachability index and structural-importance provenance (`reachability_index`, `structural_importance_meta`)
  - Progressive layer-readiness ladder (`layers_ready`, `l0_index`) for layered-entrypoint analyses
  - Edge referential-integrity invariant (zero dangling endpoints) enforced as a pre-deploy release gate
  - Deterministic file-ordering enforcement in the shared glob cache

- **v1.10.0**: System Health And Semantic Retrieval
  - System health/coherence analysis
  - Complexity, duplication, paradigm drift, and idiom drift risk areas
  - Runtime-informed operational priorities through MCP
  - Graph-anchored semantic retrieval

- **v1.9.0**: Codebase Idiom Intelligence
  - Repo-local convention extraction
  - Idiom examples, violations, and validation
  - Idiom-aware agent contexts

- **v1.0.0**: Initial release
  - Core node and edge structures
  - Basic metadata support
  - System information

- **v1.1.0**: Boundaries and Enrichment
  - Entry and exit points
  - External services
  - Analyzer contributions
  - Progressive disclosure hints

- **v1.2.0**: Multi-Perspective Analysis
  - Perspective support for multiple views
  - Enhanced node organization
  - Perspective-aware edges

- **v1.3.0**: Call Graph Tracking
  - Method call analysis
  - Call chain reconstruction
  - Decorator/annotation semantics
  - Performance hints

- **v1.4.0**: Documentation Extraction
  - Structured documentation parsing
  - Comment classification
  - TODO/FIXME tracking
  - Implementation status assessment
  - System health metrics

- **v1.5.0**: Class Relationships & Pattern Analysis
  - Class-to-class relationship edges (uses, depends_on, injects)
  - Pattern variation and deviation tracking
  - Enhanced entry points with full paths
  - Merged class/method-level guards
  - Required parent field for class members
  - External services filtering (no builtins)

- **v1.6.0**: Test Architecture & Visualization
  - New `'test'` entry point type (replaces event-based test detection)
  - Test categorization (unit, integration, e2e, acceptance, bdd)
  - Test suite and test case structures
  - BDD step extraction (Given/When/Then)
  - Mock and fixture node tracking
  - Test-to-code edge types (tests, mocks, covers, validates)
  - Per-node test coverage integration
  - Aggregated test summary statistics

- **v1.7.0**: Inference-Based Intelligence
  - Intent inference from commits, comments, and pattern deviations
  - Critical flow enhancement to CASCallChain (criticality, runtime_stats, test_coverage)
  - Flow summary for critical path statistics
  - Per-node change risk assessment with downstream impact analysis
  - Entity-centric data lifecycle tracking
  - Security boundary and trust level modeling
  - Flow-level test coverage with gap analysis
  - Git-based temporal stability metrics (churn, bug fix rate, legacy detection)

- **v1.8.0**: Incremental Analysis
  - Multi-tier change detection (mtime, git, content hash)
  - File-level analysis with import/export tracking
  - Incremental state management between analysis runs
  - Change set detection with dependency propagation
  - Rich change reporting with node/edge diffs
  - Change history storage and querying
  - Impact analysis for changes
  - Full rebuild triggers for major changes
  - Runtime-static correlation and instrumentation readiness
  - Evidence-backed analysis facts with confidence
  - Semantic impact reporting for workflows, capabilities, data entities, and contracts
  - Cross-repository link confidence and evidence

- **v1.9.0**: Codebase Idiom Intelligence
  - Repo-local idioms for naming, file organization, module boundaries, dependency injection, data access, error handling, validation, auth/tenant scope, logging, testing, migrations, async style, and configuration
  - Evidence-backed positive examples and deviations
  - Agent guidance with do, avoid, and validation instructions
  - MCP idiom queries, examples, validation, and idiom-aware agent contexts
  - Live copied-repo A/B idiom quality proof
  - Machine-wide real-repo discovery and accounting

- **v1.10.0**: Layered Analysis and Description Enrichment
  - `analysis_phases` explains which analysis layers ran, which are deferred, and what each layer provides to UI and agents
  - AI system narrative and primary capability descriptions are required default enrichment; unavailable AI is recorded as degraded provenance, not accepted as equivalent deterministic text
  - Per-element descriptions for nodes, services, entities, capabilities, entry points, and exit points are manually triggered enrichment outputs
  - Generated descriptions carry provenance, timestamps, and invalidation metadata so stale drilldown text is not trusted after source changes
  - MCP tools can request focused description enrichment without re-running the full analyzer or paying token cost for every element

### Appendix B: Language Support

Documentation patterns supported by language:

| Language | Doc Format | Comment Styles | TODO Markers |
|----------|------------|----------------|--------------|
| TypeScript/JavaScript | JSDoc, TypeDoc | //, /* */ | TODO, FIXME, HACK, NOTE |
| Python | Docstring (Google, NumPy, Sphinx) | # | TODO, FIXME, HACK, NOTE |
| Java | JavaDoc | //, /* */ | TODO, FIXME, XXX |
| C# | XML Doc | //, /* */, /// | TODO, FIXME, HACK |
| Go | GoDoc | //, /* */ | TODO, BUG, FIXME |
| Rust | RustDoc | //, /* */, ///, //! | todo!(), unimplemented!() |
| PHP | PHPDoc | //, /* */, # | TODO, FIXME, HACK |

### Appendix C: Framework Support

Framework-specific features supported:

| Framework | Decorators | Entry Points | Documentation |
|-----------|------------|--------------|---------------|
| NestJS | @Controller, @Get, @Post, @Injectable | HTTP endpoints | Swagger integration |
| Spring Boot | @RestController, @GetMapping | REST endpoints | JavaDoc + Swagger |
| Express | N/A | Route handlers | JSDoc |
| Django | N/A | URL patterns | Docstrings |
| React | N/A | Component exports | JSDoc + PropTypes |
| Angular | @Component, @Injectable | Components | TypeDoc |
| FastAPI | N/A | Route decorators | Docstrings + OpenAPI |

### Appendix D: Implementations

Known implementations of this specification:

- **Klauro Analyzer Framework** (Reference Implementation)
  - Full v1.4.0 support
  - Multi-language analyzers
  - Framework-specific analyzers

- **Community Implementations**
  - [Contributions welcome]

### Appendix E: References

- [RFC 2119](https://www.ietf.org/rfc/rfc2119.txt) - Key words for use in RFCs
- [JSON Schema](https://json-schema.org/) - Schema validation
- [Language Server Protocol](https://microsoft.github.io/language-server-protocol/) - Code analysis concepts
- [SARIF](https://www.oasis-open.org/committees/sarif/) - Static analysis format inspiration

## Copyright Notice

Copyright (c) 2024-2025 Klauro Team. This specification is released under the MIT License.

## Contact

- Specification repository: https://github.com/klauro/cas-specification
- Issue tracker: https://github.com/klauro/cas-specification/issues
- Discussion forum: https://github.com/klauro/cas-specification/discussions
