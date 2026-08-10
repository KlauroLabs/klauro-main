# Analysis Scope Specification

**Version:** 2.0.0
**Status:** Active
**Supersedes:** Code Analysis Specification (CAS) 1.11.0, Workspace Analysis
Specification (WAS) 1.0.0, and Deployable Analysis Specification (DAS) 1.0.0
as three separate document families. See §12 for the compatibility and
migration rules that keep analyses produced under those specifications
readable.

## Abstract

This specification defines the Analysis Scope: a single, recursively
composable structure for representing code analysis at any granularity, from
one deployable unit up through an unbounded number of organizational levels.
An Analysis Scope carries four tiers of analytical content — a structural
graph, framework/architecture/library conventions, a comprehension layer of
capabilities/flows/steps/entities, and an optional attachment of observed
runtime telemetry. Scopes nest without a fixed depth or a closed vocabulary of
level names. This specification defines the scope structure, the tier
contents each scope carries, the rules governing composition between a scope
and its children, and the invariants a conforming producer must satisfy.

## Table of Contents

1. [Introduction](#1-introduction)
2. [Conformance](#2-conformance)
3. [References](#3-references)
4. [The Analysis Scope](#4-the-analysis-scope)
5. [Tier 1 — Index / ICELOT / Graph](#5-tier-1--index--icelot--graph)
6. [Tier 2 — Framework / Architecture / Library](#6-tier-2--framework--architecture--library)
7. [Tier 3 — Comprehension](#7-tier-3--comprehension)
8. [Tier 4 — Realtime Telemetry](#8-tier-4--realtime-telemetry)
9. [Tier 5 — Action / Fabric (out of scope)](#9-tier-5--action--fabric-out-of-scope)
10. [Recursion and Composition](#10-recursion-and-composition)
11. [Semantic Rules and Invariants](#11-semantic-rules-and-invariants)
12. [Migration and Compatibility](#12-migration-and-compatibility)
13. [Query Interface](#13-query-interface)
14. [Extensions](#14-extensions)
15. [Security Considerations](#15-security-considerations)
16. [Gap Register](#16-gap-register)

## 1. Introduction

### 1.1 Purpose

An Analysis Scope is the unit of analysis for one node in a nesting of
organizations, domains, projects, and deployable units — or any other
granularity a user names. Every scope, regardless of where it sits in that
nesting, carries the same shape: a structural graph, the conventions that
graph follows, a comprehension layer built on top of it, and — when runtime
data exists — telemetry attached to that comprehension. This specification
defines that shape once and applies it at every level, replacing three
previously separate documents (CAS for a single project, WAS for a
composition of projects, DAS for a decomposition of one project into its
shippable units) that described overlapping content through three different,
partially-incompatible schemas.

### 1.2 Scope

This specification defines:

- The Analysis Scope envelope: identity, parent linkage, and the properties a
  consumer derives from scope structure rather than reads from a declared
  type.
- The data structures each of Tier 1 through Tier 4 populates within a scope.
- The composition rules relating a scope's own analysis to its children's.
- The semantic invariants a conforming producer must satisfy, and which of
  them are enforced today versus documented as intent.
- Migration from analyses produced under CAS 1.11.0, WAS 1.0.0, and DAS 1.0.0.

This specification does NOT define:

- Tier 5 (Action / Collaboration / Fabric). Fabric is an overlay informed by
  an Analysis Scope's Tier 1-3 content; it is stored separately from the
  scope and is out of scope for this document. §9 states the read seam only.
- Visualization or presentation formats.
- Analysis algorithms internal to a single tier (parsing, framework
  detection heuristics, ranking formulas) beyond what a producer must expose
  as output.

### 1.3 Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD",
"SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be
interpreted as described in RFC 2119.

**Scope** — one node in the recursive structure this specification defines.
**Source-backed scope** — a scope whose analysis is computed from its own
file set, as opposed to composed from children.
**Ship-backed scope** — a leaf scope for which deployable evidence (§6.4)
exists.
**Facts** — deterministic output: same source input produces byte-identical
facts across separate runs and processes. Tiers 1 and 2 are facts.
**Comprehension** — interpretive output produced by AI review of facts.
There is no deterministic comprehension: a template-generated description or
a keyword-matched domain label is not comprehension and MUST NOT be
presented as equivalent to it. Tier 3 is comprehension grounded in Tier 1-2
facts; a capability, flow, or entity classification is itself a fact (it is
structurally anchored — §7.6) even where its *name* or *description* is
AI-authored comprehension. Every field in this specification states which of
the two it is.

## 2. Conformance

A conforming implementation:

- MUST produce output matching the data structures in §5 through §8 for
  every scope it emits.
- MUST populate `id`, `parent_id`, and `label` on every scope per §4.
- MUST NOT emit a `scope_type` field or branch producer or consumer behavior
  on a closed enumeration of scope levels (§4.2).
- MUST derive `has_children`, leaf status, source-backed status, and
  ship-backed status structurally, never by declaration (§4.3).
- MUST satisfy every invariant in §11 marked enforced.
- SHOULD satisfy every invariant in §11 marked documented-only; a producer
  that does not MUST NOT claim conformance to that invariant.
- MAY extend the specification with additional fields under the reserved
  extension mechanism (§14).

## 3. References

### 3.1 Normative References

- RFC 2119: Key words for use in RFCs to Indicate Requirement Levels
- RFC 8259: The JavaScript Object Notation (JSON) Data Interchange Format
- ISO 8601: Date and time format

### 3.2 Related Specifications

- `docs/SPEC-DEPLOYABLE-DETECTION.md` — the evidence-gated ship/build-artifact
  detection that produces the `DeployableEvidence` rows this specification's
  ship-backed derivation (§4.3) consumes.
- `docs/SEMANTIC-MODEL.md` — the Capability/Flow/Step/ICELOT construction
  rules Tier 3 (§7) and the ICELOT contract (§5.4) implement.
- `docs/cas/DETERMINISM-BOUNDARY.md` — the facts-versus-comprehension rule
  referenced throughout this specification.
- `docs/SPEC-ABSTRACTION-TIERS.md` — the model and rationale behind Tiers 1-4
  (§5-§8 of this specification): what each tier contains, the one-directional
  dependency rule (§11.1), the two proven tier-skip defects that rule exists
  to prevent, and the CAS surfaces (temporal/churn, derived graph metrics,
  risk/health judgments, agent-facing knowledge) this specification does not
  yet place. Also records the journeys/workflows-collapse-into-flows decision
  (its §D) that motivates §7.1's `workflows?`/`user_journeys?` fields being
  targeted for collapse, and the god-file decomposition sequencing decision
  that must land before the composition model in §10 is implemented.
- `docs/SPEC-ANALYSIS-SCOPES.md` — the model and rationale behind the
  recursive `AnalysisScope` structure itself (§4, §10, §11.10 of this
  specification): the naming decision, the no-closed-type-vocabulary
  argument (§1a), the derivation gradient this specification's §10.2 restates
  as Option A/B (its §7a, resolved), and the implementation sequencing this
  specification's §12.1 status line reflects (its §8).

## 4. The Analysis Scope

### 4.1 The recursion

A scope MAY have child scopes. Depth is not fixed and is not validated
against any maximum. A single-repository, single-deployable case is a scope
with no children. A multi-level organization is a chain of scopes of
arbitrary length. Any level in a chain MAY be absent; a conforming consumer
MUST NOT assume a fixed number of levels between a root and a leaf.

**Termination rule.** A scope with no children is a leaf. A leaf is the
lowest analysable scope: analysis at a leaf is always computed from that
scope's own source, never composed from further children, because there are
none.

### 4.2 What a scope carries — no closed type vocabulary

```typescript
interface AnalysisScope {
  id: string;
  parent_id: string | null;   // null (or absent) marks a root scope
  label: string;               // the user's word for this level: "Organization",
                                // "Domain", "Project", "Deployable", or any other
                                // free text. Never read by producer or consumer
                                // logic — display only.

  // Tier content — see §5-§8.
  tier1: ScopeIndex;
  tier2: ScopeConventions;
  tier3: ScopeComprehension;
  tier4?: ScopeTelemetry;      // present only when runtime observations exist

  // Envelope metadata — see §11.
  scope_version: '2.0.0';
  analysis_id: string;
  analysis_timestamp: string;  // ISO 8601
  root_path: string;           // repo-relative for a source-backed scope;
                                // a synthesized organizational path otherwise
}
```

`AnalysisScope` MUST NOT carry a `scope_type` field, and no field anywhere in
this specification is permitted to hold a closed enumeration of scope levels
(`organization | domain | project | deployable` or any similar list). A
producer or consumer MUST NOT branch behavior on `label`. Every prior CAS/WAS/
DAS distinction that depended on such a type is restated in §4.3 as a
property derived from structure, and every one of those derivations is
already computed by the codebase this specification describes — see the
per-property citation below.

Rationale: a closed vocabulary requires a schema change, a migration, and a
naming decision every time a user's organization introduces a level the
enumeration did not anticipate (a subdomain, a squad, a bounded context, a
tenant, a region). Two users may use different words for structurally
identical levels, and both are correct; since no field switches on the word,
neither the producer nor the consumer needs to reconcile the vocabulary.

### 4.3 Derived properties

None of the following properties are stored. Each is computed at read time
from scope structure or from Tier 1/2 evidence already present in the scope
tree.

| property | derivation | what it drives |
|---|---|---|
| `has_children` | true iff at least one other scope's `parent_id` equals this scope's `id` | whether a system map (§7.7) is renderable for this scope |
| is a leaf | `has_children === false` | whether an architecture map (§7.7) is renderable for this scope |
| source-backed | the scope has its own file set (`tier1.nodes` etc. computed from source, not composed) | whether Tier 1-3 are computed from source (§10.1) or composed from children (§10.2) |
| ship-backed | `tier2.deployable_evidence` (§6.4) contains at least one tier-qualified row for this scope, per the promotion predicate in `docs/SPEC-DEPLOYABLE-DETECTION.md` | whether this leaf is presented as "ships as a unit" |

A "deployable" under this specification is not a type: it is a leaf scope
that is also ship-backed. An "organization" is not a type: it is a scope with
children and no source of its own. Both distinctions were previously
expressed as a `scope_type` discriminant (CAS's implicit "this is a
single-project analysis", WAS's `analysis_kind: 'workspace'`, DAS's
promotion boolean); under this specification they are read-time facts over
the same envelope, and the read-time computation for "ship-backed" is
identical to DAS's existing promotion predicate (`docs/SPEC-DEPLOYABLE-
DETECTION.md` §2), carried forward unchanged — see §12.3.

### 4.4 Every scope renders the same way

A consumer of this specification MUST be able to request the same categories
of information — capabilities, critical flows, health, complexity, dependency
usage — from any scope, regardless of its position in the tree. §7.7 states
the one rendering distinction that legitimately varies by structure (the
system map versus architecture map rule), which is itself derived, not typed.

## 5. Tier 1 — Index / ICELOT / Graph

Tier 1 is the structural substrate: nodes, edges, entry and exit points, and
the six ICELOT facets computed over them. Tier 1 is deterministic — the same
source input MUST produce byte-identical Tier 1 facts across separate runs
(§11.9). Tier 1 performs no interpretation: it records that one function
calls another; it does not know that either is an HTTP handler. That
knowledge is Tier 2.

### 5.1 ScopeIndex

```typescript
interface ScopeIndex {
  nodes: CASNode[];
  edges: CASEdge[];
  entry_points: EntryPoint[];
  exit_points: ExitPoint[];
  external_services: ExternalService[];
  method_calls?: CASMethodCall[];
  call_chains?: CASCallChain[];
  reachability_index?: CASReachabilityIndex;
  structural_importance_meta?: CASStructuralImportanceMeta;
  communities?: CASCommunity[];
  validation: ScopeGraphValidation;
}
```

`CASNode`, `CASEdge`, `CASMethodCall`, `CASCallChain`, `CASReachabilityIndex`,
and `CASStructuralImportanceMeta` are unchanged from CAS 1.11.0 (`docs/
cas/SPECIFICATION.md` §4.2-§4.4, §4.16, reproduced in full in
`packages/analyzer-core/src/types/cas.types.ts`) and are not restated here.
`ScopeGraphValidation` corresponds to CAS 1.11.0's `CASValidation.
graph_integrity`, unchanged.

#### EntryPoint / ExitPoint

Unchanged from CAS 1.11.0 §4.7, including the closed type-union invariant
(§11.6 below). Reproduced because entry/exit points are the seam Tier 3
capabilities anchor to (§7.2) and the seam ship-backed leaf status reads
(§4.3):

```typescript
const ENTRY_POINT_TYPES = [
  'http', 'websocket', 'cli', 'event', 'schedule', 'page', 'route',
  'message', 'file', 'test', 'lifecycle', 'api',
  'task', 'pipeline', 'notebook-cell', 'train',
  'interrupt', 'driver',
  'ipc', 'command',
  'rpc',
  'graphql',
] as const;
type CASEntryPointType = typeof ENTRY_POINT_TYPES[number];

interface EntryPoint {
  id: string;
  type: CASEntryPointType;
  name: string;
  description?: string;
  trigger: {
    method: string;
    path: string;
    base_path?: string;
    parameters?: Array<{ name: string; type: string; required?: boolean; location?: 'query' | 'path' | 'body' | 'header' }>;
  };
  handler: { node_id: string; method_name?: string; file: string; line: number };
  security: { authenticated: boolean; guards: string[]; roles?: string[]; permissions?: string[] };
  metadata?: Record<string, any>;
}

type CASExitPointType =
  'database' | 'api' | 'file' | 'message' | 'event' |
  'cache' | 'sdk' | 'webhook' | 'navigation' |
  'client_storage' | 'analytics';

interface ExitPoint {
  id: string;
  source_node: string;
  type: CASExitPointType;
  name: string;
  target?: { service_id?: string; endpoint?: string; resource?: string; sdk?: string };
  operation?: { action?: string; method?: string; async?: boolean };
  connected_nodes?: string[];
  metadata?: Record<string, any>;
}
```

### 5.2 Supporting Tier 1 structures

The following are unchanged from CAS 1.11.0 and remain valid Tier 1 (or, for
Documentation and Idiom material, Tier 1-adjacent facts consumed by Tier 2)
content. This specification does not restate their shapes; see the cited
section of `docs/cas/SPECIFICATION.md` and `cas.types.ts` for the full
interfaces:

- Documentation, comments, TODOs, implementation status (CAS §4.5).
- Decorators and framework-semantic call annotations (CAS §4.4 `CASDecorator`,
  `CASMethodCall.framework_semantics`) — these sit at the Tier 1/Tier 2
  boundary; see §6.2 for why they are necessary but not sufficient for Tier 2.
- `CASDependencyManifest` (CAS §4.16) — every declared dependency name, raw,
  uninterpreted. This is Tier 1: a fact about what is declared, carrying no
  role. §6.3 covers why a declared name is not the same as a Tier 2 library
  role.
- `CASCoverageGap` (CAS §4.16) — self-discovered gaps in this analysis pass.

### 5.3 ICELOT — where each facet lives

ICELOT (**I**nput, **C**onstraints, **E**ffects, **L**ogic, **O**utput,
**T**elemetry) is the six-facet contract every unit in a scope carries. It is
not a stored per-node field; it is a **derivable projection** over Tier 1
facts, computed on request at node, step, flow, capability, project, or
workspace-scope granularity (`get_interface_signature`, `get_flow_concepts`).
This is a deliberate storage decision, not a gap: persisting the contract at
every node would multiply Tier 1's stored size for a value the query layer
can always rebuild from facts already present. The table states where each
facet is grounded and is representable today:

| facet | grounded in | representable today |
|---|---|---|
| **I**nput | `node.signature.parameters`, `entry_point.trigger.parameters`, request/DTO data-entity shapes | yes |
| **C**onstraints | validation schemas, `entry_point.security` guards, `CASDataEntity.invariants`, `CASBehavioralInvariant`, consistency-model posture | yes, as a typed `FacetConstraint { kind, rule, evidence }` record — never a free-text guess |
| **E**ffects | `exit_points`, `data_lineage` writes/reads, `communication_seams` | yes, split into `state_changes` and `external_integrations` |
| **L**ogic | ordered step/function behavior, deterministic label; interpretive reframing is the AI-only `logic_summary` plug point | yes, deterministic label always present; interpretive summary absent unless AI ran |
| **O**utput | `node.signature` return, `exit_points`, flow terminus | yes |
| **T**elemetry | joined `RuntimeObservation` correlated to the same static id, when observations exist | yes when Tier 4 data exists for the unit; absent (not zero-filled) otherwise — see §8.3 for why this is NOT the same field as declared telemetry |

```typescript
type ConstraintKind = 'validation' | 'auth' | 'rate-limit' | 'error' | 'invariant' | 'business-rule' | 'consistency';

interface FacetConstraint {
  kind: ConstraintKind;
  rule: string;
  evidence: string;
}

interface ILSOContract {
  input: string[];
  logic: string;
  side_effects: { state_changes: string[]; external_integrations: string[] };
  output: string[];
  constraints: FacetConstraint[];
  telemetry?: ContractTelemetry;        // Tier 4 join — see §8
  facet_provenance?: FacetProvenance[];
  logic_summary?: LogicSummary;          // AI-only, absent in deterministic runs
}
```

**A necessary disambiguation, restated as a rule.** ICELOT's `T` is
*declared* telemetry capacity read off the same static facts as the other
five facets (log sites, metric registrations, span creation, entry/exit
correlation candidates). It is not Tier 4. Tier 4 is *observed* runtime
behavior joined onto the same contract at query time via `ContractTelemetry`
(§8.2). A conforming implementation MUST NOT populate `ILSOContract.
telemetry` from static capacity alone, and MUST NOT describe declared
telemetry capacity as an observation. Conflating the two collapses "this
code can report X" into "X happened," which is a category error the
`description_source`/provenance discipline in §11.2 exists to prevent.

## 6. Tier 2 — Framework / Architecture / Library

Tier 2 is the convention tier: it maps Tier 1 structure onto ecosystem
meaning — which framework a node's role comes from, what a third-party
dependency does, what architectural paradigm the codebase follows. Tier 2
depends on Tier 1 only, and Tier 3 MUST NOT read past Tier 2 to synthesize
product meaning directly from Tier 1 labels (§11.1 states this as an
invariant, with a citation to a real defect this rule exists to prevent).

### 6.1 ScopeConventions

```typescript
interface ScopeConventions {
  frameworks_detected: Record<string, boolean>;   // see §6.2 — known gap
  paradigm_conformance?: CASParadigmConformance[];
  architectural_conflicts?: CASArchitecturalConflict[];
  principle_violations?: CASPrincipleViolation[];
  codebase_idioms?: CASCodebaseIdiom[];
  idiom_summary?: CASIdiomSummary;
  idiom_examples?: CASIdiomExample[];
  idiom_violations?: CASIdiomViolation[];
  conventions_applied?: ConventionMatchReport[];
  communication_seams?: CommunicationSeamsResult;
  consistency_model?: ConsistencyModelResult;
  dependency_manifest?: CASDependencyManifest;      // Tier 1 fact, joined here for Tier 2 role assignment — see §6.3
  deployable_evidence?: DeployableEvidence[];
  codebase_type?: CodebaseType;
  codebase_type_confidence?: number;
  codebase_types?: Array<{ type: CodebaseType; confidence: number }>;
}
```

`CASParadigmConformance`, `CASArchitecturalConflict`, `CASPrincipleViolation`,
`CASCodebaseIdiom`, `CASIdiomSummary`, `ConventionMatchReport`,
`CommunicationSeamsResult`, and `ConsistencyModelResult` are unchanged from
CAS 1.11.0 §4.9 and §4.16.

### 6.2 Framework identity and version — GAP

Per the abstraction-tiers model, Tier 2 must carry "which frameworks are
present, at what version, serving what purpose (web, ORM, DI, test, build,
queue)". The current structure carries only `frameworks_detected: Record
<string, boolean>` — a per-analyzer-contribution boolean presence map with
**no version field and no purpose classification**. A framework's version
and purpose are not representable in the current schema; a consumer that
needs "which ORM, at what version" today must re-derive it from raw
dependency-manifest version strings (§6.3) with no structural join back to
the framework-role facts the analyzer already computed internally during
detection. **This is a genuine gap, not merely undocumented**: the
information Tier 2 needs to carry does not have a field.

### 6.2.1 Framework-conferred node roles — GAP

The abstraction-tiers model requires that a framework-conferred role — route
handler, persisted entity, migration, scheduled job, event listener, gateway,
middleware, guard, resolver — be reachable from structural evidence alone, so
that a framework-less codebase (Go's `net/http`, a hand-rolled dispatcher)
still resolves the same role a decorator-based framework would confer
explicitly. Today this is only **partially representable**, and inconsistently:

- **Route handler** is representable: it is the role `EntryPoint.handler`
  already assigns, framework-present or not (§5.1), and the fix that made a
  framework-less Go server classify correctly (`determineSystemType`, §12.4)
  demonstrates the derivation working end to end.
- **Persisted entity** is representable, evidence-gated: `CASDataEntity.kind
  === 'persisted-entity'` with a mandatory `kind_evidence` citation (§11.4).
- **Migration, scheduled job, event listener, gateway, middleware, guard,
  resolver** have **no dedicated role field anywhere in the structure**.
  `CASNode.type` is a free-form string set per-analyzer (`'class'`,
  `'function'`, `'module'`, and dozens of ecosystem-specific values with no
  closed vocabulary), and `CASNode.tags` is an accumulative, also-unclosed
  classification list. Neither is a role in the sense Tier 2 needs: a
  consumer cannot query "every node with role `middleware`" across ecosystems
  without knowing every per-analyzer string that happens to mean that in a
  given language. `CASDecorator.semantic_meaning.category` (`'routing' |
  'validation' | 'security' | 'lifecycle' | 'injection' | 'configuration' |
  'other'`) is the closest existing structure to a closed role vocabulary,
  but it exists **only when a decorator/annotation produced it** — so it
  fails exactly the framework-less case the model requires a role to survive.
  **This is the single largest gap this specification identifies**: a node
  role taxonomy with a closed vocabulary, populated from decorators where
  they exist and from structural fallback rules (signature shape, call-graph
  position, naming convention scored as weak evidence only) where they do
  not, has no home in the current schema.

### 6.3 Library and dependency roles — GAP

`CASDependencyManifest` (§5.2) carries every declared dependency name,
ecosystem, version, and scope — a Camp-B structural fact bundle, deliberately
uninterpreted (its own contract states dependency_manifest "MUST NOT carry
any interpretive label"). What the abstraction-tiers model asks for — HTTP
client, database driver, cache, message broker, payment SDK, observability
agent — is a **role classification of each declared dependency**, and **no
such field exists**. `SystemMetadata.frameworks?: string[]` is the nearest
neighbor and is even less structured than `dependency_manifest` (no
ecosystem, no version, no role). A consumer today gets the raw name list
(`stripe`, `redis`, `axios`) and must supply the name-to-role mapping itself;
the specification's own DETERMINISM-BOUNDARY doctrine explicitly assigns
that interpretation to "the AI comprehension pass," but there is no
structural field for that pass to write its answer into — the role, once
computed, has nowhere to be stored as a citable fact for the next reader to
reuse without recomputing it. This is the concrete mechanism behind the
capability-substance defect the abstraction-tiers document cites (a system's
~20 third-party integrations never becoming capability candidates): the
capability builder has no dependency-role facts to read.

### 6.4 Architecture paradigm and component kinds

Partially representable. `codebase_type` / `codebase_types` (§6.1) carries
the coarse system shape (`web-backend`, `library`, `cli`, ...).
`CASParadigmConformance.paradigm` carries a paradigm name as free text with
an adoption rate and deviation list, but **no structured list of the
component kinds that paradigm implies** (a layered-architecture paradigm
entry does not enumerate "controller / service / repository" as typed
component-kind rows the way `CASArchitecturalConflict.competing` enumerates
competing patterns for one concern). `ConventionMatchReport` covers the
custom-convention case (a declared `.klaurorc` convention matched or not) but
not the standard-paradigm case. Idioms, conventions, and adherence health are
otherwise well represented: `CASCodebaseIdiom` (evidence, prevalence,
positive examples, deviations, agent guidance) and `CASPrincipleViolation`
(layering / single-responsibility / coupling) are both structurally
complete for what they cover.

### 6.5 DeployableEvidence

Unchanged from CAS 1.11.0 §4.16. This is the fact `ship-backed` (§4.3) reads.

```typescript
interface DeployableEvidence {
  root_path: string;
  name: string;
  tier: 1 | 2 | 3;
  kind: 'container' | 'compose-service' | 'k8s' | 'serverless' | 'installer' |
        'ci-deploy' | 'bin' | 'server-entry' | 'package';
  evidence: string[];
  ships_paths?: string[];
  ports?: number[];
  entrypoint_member?: string;
  bundled_into?: string;
}
```

## 7. Tier 3 — Comprehension

Tier 3 is capabilities, flows, steps, and entities: what the system is for,
the ways through it, the steps of each way, and the domain things it holds.
Tier 3 depends on Tiers 1-2: a capability is only real if it anchors to
operations and entities that structurally exist (§11.5); an entity is
persisted because a Tier 2 persistence fact says so, not because it sits in
a directory named `entities` (§11.4).

### 7.1 ScopeComprehension

```typescript
interface ScopeComprehension {
  capabilities: SystemCapability[];
  behavior_surfaces: SystemCapability[];   // same shape, excluded from ranking — see §7.2
  flows: CASFlowGraph;
  workflows?: CASWorkflow[];
  user_journeys?: CASUserJourney[];
  entities: CASDataEntity[];
  data_lineage?: CASEntityLineage[];
  domain_concepts?: CASDomainConcept[];
  system_purpose?: EnhancedSystemPurpose;
  product_map?: CASProductMap;              // leaf-only — see §7.7
}
```

### 7.2 Capabilities

```typescript
interface SystemCapability {
  id: string;
  name: string;
  name_source?: 'ai' | 'manual' | 'reused';
  structural_label?: string;                // deterministic fact-shaped fallback
  description: string;
  description_source?: 'deterministic' | 'ai' | 'manual' | 'reused';
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
  evidence_kind?: 'behavior-surface' | 'infrastructure';
  related_flows?: Array<{ flow_id: string; role: string; rationale: string }>;
}
```

`name` is comprehension (AI, manual, or reused-from-a-prior-run only —
never a deterministic template); `structural_label` is the fact-shaped
fallback and is always present until the AI naming pass runs. `evidence_kind
=== 'infrastructure'` capabilities are excluded from the shipped catalog
(§11.5); `evidence_kind === 'behavior-surface'` capabilities (an MCP tool
server, a socket-event namespace with no persisted-entity anchor) are
force-included via the flagship-capability guarantee rather than pruned, and
are mirrored in `behavior_surfaces` at `category: 'internal'` with criticality
capped at `medium` so they can never outrank a domain capability.

### 7.3 Flows and steps

`flows: CASFlowGraph` is the materialized index every `flow_id` reference in
the scope resolves against; `CASFlowRef` rows within it are compact —
step/contract detail is derived on demand rather than persisted, to avoid
multiplying stored size for data the query layer rebuilds anyway.

```typescript
interface CASFlowRef {
  flow_id: string;
  name: string;
  intent: string;
  entry_point: string;
  call_chain_id?: string;
  capability_id?: string;                    // primary relationship, back-compat
  capability_ids?: string[];                 // full M:N set — see §7.4
  criticality?: 'critical' | 'high' | 'medium' | 'low';
  step_count: number;
  terminus?: { kind: string; produces: string };
}

interface CASFlowGraph {
  capabilities: CASCapability[];
  dependencies: CASCapabilityDependency[];
  flows?: CASFlowRef[];
  topology: { root_capabilities: string[]; leaf_capabilities: string[]; critical_path: string[]; max_depth: number };
  primary_flow: { core_capability_id: string; value_chain: string[]; supporting_capabilities: string[]; infrastructure_capabilities: string[] };
  layers: CASFlowLayer[];
}
```

**A flow need not have a parent capability.** `capability_id`/
`capability_ids` MAY be absent: some flows are legitimately isolated, and a
consumer requiring every flow to resolve to a capability is enforcing a rule
this specification does not impose.

A step, materialized on demand (`get_flow_concepts`) rather than persisted in
the scope's stored form, is:

```typescript
interface FlowStep {
  step_id: string;
  order: number;
  name: string;
  description_source: 'deterministic-label' | 'ai';
  contract: ILSOContract;                   // §5.4 — the same six-facet contract, step-scoped
  functions: Array<{ function_id: string; section?: { start_line: number; end_line: number; label?: string } }>;
  entities: string[];
  code_mappings?: StepCodeMapping[];
}
```

A step may span multiple functions, one function, or part of one — `section`
carries the sub-region when a step realizes only part of a function's body.
One function can host several steps.

### 7.4 Comprehension linkage — the asymmetry, and why it matters

Of comprehension's four members, three carry typed, evidenced linkage; the
fourth does not:

| relationship | shape | typed role? | evidence carried on the edge |
|---|---|---|---|
| capability ↔ flow | M:N | yes — `CapabilityFlowRole` (`primary`, `supporting`, `prerequisite`, `operational`, `recovery`, `observability`) | yes — `rationale` cites the operation ref, the shared entities, or the telemetry-exit facts that produced the edge |
| step ↔ code | many-to-many | yes — `StepCodeRelationship` (`implements`, `initiates`, `completes`, `validates`, `branches`, `causes_effect`, `observes`, `handles_failure`, `provides_input`, `consumes_output`, `partially_implements`, `transforms`) | yes — `contribution` + `confidence` per `StepCodeMapping` |
| flow ↔ entity | one-directional list | no | `FlowConcept.entities` is a name list, not a typed relationship |
| **entity ↔ capability** | **one-directional list** | **no** | **`SystemCapability.related_entities` is a bare string array — the only linkage among the four comprehension members with no role, no rationale, and no reciprocal field on the entity side** |

```typescript
type CapabilityFlowRole = 'primary' | 'supporting' | 'prerequisite' | 'operational' | 'recovery' | 'observability';

interface CapabilityFlowRelationship {
  capability_id: string;
  role: CapabilityFlowRole;
  rationale: string;
  evidence?: 'operation' | 'interior-step' | 'route' | 'entity-overlap' | 'surface-membership';
}

type StepCodeRelationship =
  | 'implements' | 'partially_implements' | 'initiates' | 'completes' | 'validates'
  | 'branches' | 'transforms' | 'causes_effect' | 'observes' | 'handles_failure'
  | 'provides_input' | 'consumes_output';

interface StepCodeMapping {
  step_id: string;
  code_region: { node_id: string; file?: string; line_range?: [number, number] };
  relationship: StepCodeRelationship;
  contribution: string;
  confidence: number;
}
```

**This asymmetry needs closing.** `CASDataEntity` has no field pointing back
to the capabilities that use it, no role describing *how* a capability uses
an entity (produces it, consumes it, merely references it in passing), and
no evidence-cited rationale the way `CapabilityFlowRelationship.rationale`
or `StepCodeMapping.contribution` provide. A consumer that wants "every
capability touching entity X" must scan every capability's
`related_entities` array rather than resolve a reverse index, and gets no
role or evidence when it does. Given that capability↔flow closed exactly
this gap by moving from a single back-compat `capability_id` to a full M:N
relationship type, the same treatment — `CASDataEntity.related_capabilities:
Array<{ capability_id: string; role: EntityCapabilityRole; rationale: string
}>` mirroring `capability_relationships`, plus a reciprocal edge on the
capability side — is the structurally consistent fix and is recorded here as
the concrete shape the gap register (§16) points at.

### 7.5 Entities

```typescript
type CASDataEntityKind = 'persisted-entity' | 'api-response' | 'request-dto' | 'domain-shape' | 'value-object';

interface CASDataEntity {
  id: string;
  name: string;
  description?: string;
  kind?: CASDataEntityKind;
  kind_source?: 'framework-evidence' | 'shape-inference';
  kind_evidence?: string;                    // mandatory for kind === 'persisted-entity' — §11.4
  fields?: Array<{ name: string; type: string; is_sensitive: boolean; is_relation?: boolean }>;
  lifecycle: { created_by: string[]; read_by: string[]; updated_by: string[]; deleted_by: string[] };
  relations?: Array<{ target_name: string; relation_type: string; kind: 'data' | 'structural'; evidence_source: string; evidence: string }>;
  invariants?: Array<{ description: string; enforced_by: string[]; source: string }>;
}
```

### 7.6 Domain concepts

```typescript
interface CASDomainConcept {
  id: string;
  name: string;
  frequency: number;                          // distinct usage sites, never a token count
  appears_in: { entry_points: string[]; entities: string[]; nodes: string[] };
  classification: 'core' | 'supporting' | 'infrastructure';
  distinctiveness?: number;
  distinctiveness_evidence?: string[];         // mandatory at least one — §11.3
}
```

### 7.7 System map vs. architecture map

A **system map** exists for a scope whenever `has_children` is true (§4.3) —
it shows how the child scopes relate. An **architecture map** exists only at
a leaf scope, because a scope with multiple children has no single coherent
architecture to draw: each child has its own, even where they overlap. This
rule is itself a structural derivation, not a declared field, and the same
derivation `has_children` already computes for every other purpose (§4.3).

`CASProductMap` — the whole-scope rollup of identity, capabilities, journeys,
entities, and health in one bounded payload — is meaningful at any scope, but
its `product_map.identity` field (a single description and domain) is a
leaf-scope concept in the architecture-map sense: at a parent scope with
children, the equivalent whole-tree summary is the composed view described
in §10, not a single-architecture identity claim.

## 8. Tier 4 — Realtime Telemetry

Tier 4 attaches observed runtime behavior to Tier 3's comprehension model. It
depends on Tiers 1-3, and necessarily on 3: a span or log line is only
meaningful once attached to a step, flow, or capability. Tier 4 is entirely
optional — a scope with no ingested telemetry omits `tier4` rather than
zero-filling it.

### 8.1 ScopeTelemetry

```typescript
interface ScopeTelemetry {
  observations: RuntimeObservation[];
  runtime_static_links?: CASRuntimeStaticLink[];
}

interface CASRuntimeStaticLink {
  id: string;
  kind: 'entry-point' | 'exit-point' | 'call-chain' | 'external-service' | 'telemetry-hook';
  static_id: string;
  runtime_signal: string;
  telemetry_status: 'observed' | 'instrumentable' | 'not-instrumented';
  confidence: number;
  evidence: CASFactEvidence[];
}
```

`RuntimeObservation` rows are produced by telemetry ingestion (event kinds
`request | error | log | metric`, correlated to a static target by route,
function hint, or trace context) and persisted independently of the scope's
Tier 1-3 content, with its own retention policy. They are not part of the
deterministic Tier 1-2 byte-stability guarantee (§11.9) — observed behavior
varies run to run by construction.

### 8.2 The join: ContractTelemetry

Tier 4's attachment point into Tier 3/ICELOT is `ILSOContract.telemetry`
(§5.4), populated only when a real observation correlates to the unit's
static id:

```typescript
interface ContractTelemetry {
  static_id: string;
  request_count: number;
  error_rate: number;
  p50_ms?: number;
  p95_ms?: number;
  p99_ms?: number;
  status_code_distribution?: Record<string, number>;
  source: string;             // 'ingested' | 'simulated' | 'mixed'
  last_seen?: string;
}
```

### 8.3 Declared vs. observed — restated as a field-level rule

`ICELOT.T` (§5.4) and `ScopeTelemetry`/`ContractTelemetry` are different
fields answering different questions, and a conforming implementation MUST
NOT merge them:

- **Declared** ("this code can report X") is a Tier 1 fact: log call sites,
  metric registrations, span creation, entry/exit correlation candidates.
  It is deterministic and requires no runtime data.
- **Observed** ("X happened N times, at P95 latency Y") is Tier 4: it
  requires an actual `RuntimeObservation` correlated to the unit, and it is
  never fabricated from declared capacity alone. A unit with declared
  telemetry capacity but zero observations MUST report an absent
  `ILSOContract.telemetry`, not a synthesized zero.
- Tier 4 MUST NOT silently overwrite a Tier 1-3 static fact. An unobserved
  path in production is not proof of dead code — it may be seasonal, behind
  a flag, or simply not yet exercised. Telemetry annotates; it does not
  delete.

## 9. Tier 5 — Action / Fabric (out of scope)

Tier 5 — proposals and edits, work claims, conflict and collision detection,
blast-radius-aware parallel planning, multi-agent and multi-human
coordination — is explicitly **not part of the Analysis Scope structure**.
It is an overlay, informed by a scope's Tier 1-3 content (and materially
better with Tier 4), stored separately. This keeps the scope substrate
reusable and deterministic-where-it-should-be, and keeps coordination state
— volatile, multi-writer, short-lived — out of a structure that must be
reproducible.

The seam this specification commits to, so the overlay contract is
well-defined without this document owning it:

- Fabric reads `tier1.reachability_index` for blast-radius and transitive
  collision computation — a graph-reachability question, answerable at
  Tier 1 alone.
- Fabric reads Tier 3 (capabilities, flows, steps) to distinguish "two
  agents editing the same file, unrelated work" from "two agents editing
  different files, same capability's behavior" — a distinction Tier 1 alone
  cannot make.
- Fabric does not write into any `tier1`-`tier4` field. A conforming Tier
  1-4 producer MUST NOT depend on Tier 5 state to compute any Tier 1-4
  field, per the one-directional dependency rule in §11.1.

## 10. Recursion and Composition

### 10.1 Source-backed scopes

A source-backed scope (§4.3) computes its own Tier 1-4 content directly from
its file set, exactly as CAS 1.11.0 computed a project-level analysis. No
composition is involved.

### 10.2 Composed scopes — an open question, stated as one

A scope with children and no source of its own must produce *some* Tier 1-4
content when queried, composed from its children. Two shapes are on the
table, and this specification does not resolve between them:

- **Option A — re-derive.** Union the children's Tier 1 graphs (or a
  reference index over them) and re-run Tier 2-3 construction over the
  union, exactly as if it were one large source tree. Produces a fully
  independent comprehension layer at the parent, but at real cost: Tier 3
  construction (capability/flow/step derivation) is not cheap, and a
  re-derived parent capability set can legitimately disagree with the union
  of children's capability sets, which then needs its own reconciliation
  story.
- **Option B — compose-with-provenance.** Union the children's already-
  computed Tier 3 objects, deduped by identity, each carrying which child
  scope(s) contributed it. Cheaper, and guarantees the parent's comprehension
  never contradicts a child's, but a "parent capability" is then always
  traceable to a child's capability rather than a fact about the parent as
  its own unit — a monorepo-shaped organization looking like a single
  product from the top would not automatically get a single "primary
  capability" without a synthesis pass on top of the composed set.

This specification does not choose between the two options. It matters for
the latency budget (Option A is not cheap at depth) and it has direct
precedent in a decision **already made, at one layer of the existing
structure, for exactly this tradeoff**: `docs/das/SPECIFICATION.md` §3.3
documents that a DAS unit's capabilities/flows are filtered down from the
parent CAS's already-computed set rather than re-projected through the full
semantic-model construction rules over the unit's subgraph — Option B, with
the same known limitation stated explicitly (a capability whose entry points
and entities span unit boundaries does not cleanly decompose under
filter-down). A conforming implementation MUST choose one option per scope
kind and MUST state which one it chose in `ScopeComprehension`'s provenance
(a `composition_mode: 're-derived' | 'composed'` field is the minimum
honesty requirement, whichever option is picked) rather than leaving a
reader to guess.

### 10.3 What composes, what's computed per scope, what's leaf-only

| field | at a composed (non-leaf) scope |
|---|---|
| `tier1.nodes` / `tier1.edges` | union of children's, deduped by content-derived id (§11.9) |
| `tier1.reachability_index` | recomputed over the unioned graph — cannot be composed piecewise, since SCC condensation is not additive |
| `tier2.frameworks_detected` / `dependency_manifest` | union of children's, deduped by name |
| `tier3.entities` | union of children's, **deduped by identity** — this is the interesting case: the same `Customer` entity modelled independently in two children is a *finding* (duplication across the tree, surfaced, not silently merged into one row) rather than a merge conflict to resolve away |
| `tier3.capabilities` / `tier3.flows` | per §10.2 — re-derived or composed, per the scope's declared `composition_mode` |
| `product_map.identity` (single description/domain) | **leaf-only** (§7.7) — a composed scope has no single architecture-map identity to claim |
| `tier4` | union of children's `observations`, when telemetry ingestion is scoped per child; not re-aggregated into new percentiles without restating the aggregation method |

### 10.4 Every scope renders the same surfaces

Per §4.4, capabilities, critical flows, health, complexity, and dependency-
usage-ordered-by-frequency-across-children are requestable at any scope. Two
surfaces are explicitly scope-position-sensitive and MUST be labeled as such
by a conforming implementation rather than presented uniformly:

- **Change activity** is valuable at a leaf and at a modest-depth parent; at
  a very broad root (many children, high aggregate commit volume) it MAY be
  too noisy to be useful un-filtered. This specification does not mandate a
  threshold; it requires that a consumer be told the activity view is an
  aggregate over N children rather than presented as if it described one
  coherent unit.
- **Architecture map** — leaf-only, §7.7.

## 11. Semantic Rules and Invariants

Each invariant below states whether it is enforced by code today (with the
enforcing mechanism cited) or documented-only (an intent not yet backed by a
check). A conforming implementation MUST satisfy every enforced invariant and
SHOULD satisfy every documented-only one; claiming conformance to a
documented-only invariant without the enforcement existing is a
misrepresentation.

### 11.1 Tier ordering (documented-only, with a proven-defect citation)

A tier may consume any tier below it and MUST NOT consume, or be synthesized
from, a tier above it. **Documented-only**: there is no automated check that
a Tier 3 code path never reads a raw Tier 1 label. The rule exists because
violating it has already produced real, shipped defects: `determineSystemType`
(fixed in commit `4676925e`, see §12.4) derived `service`/`library`/
`application` from Tier-1 `CASNode.type` values (`controller`, `component`,
`package`) — a Tier-3 claim reading Tier-1 data while skipping Tier 2
entirely — and misclassified every framework-less HTTP server as a library,
including a reproduced case with 175 live HTTP entry points. The fix reads
entry-point and deployable evidence (Tier 1 facts a Tier-2-aware consumer is
entitled to combine with Tier 2's absence) rather than a Tier-1 type-name
checklist. §16 records this as a pattern to gate, not a one-off bug.

### 11.2 Provenance discipline (enforced, structurally)

Every field distinguishing a fact from comprehension (`description_source`,
`name_source`, `domain_source`, `kind_source`) MUST take one of its declared
union values; `'deterministic'` MUST NOT be used to paper over an AI call
that did not run. **Enforced** via the type system (the unions are closed)
plus the runtime provenance-tagging discipline documented in `docs/cas/
DETERMINISM-BOUNDARY.md`; not independently gate-tested at the field level
beyond the type check.

### 11.3 Domain concept distinctiveness (enforced)

A `CASDomainConcept` MUST carry at least one cited channel in
`distinctiveness_evidence`; a term with zero citations MUST NOT be emitted
regardless of raw occurrence count. `frequency` MUST report distinct usage
sites, never a token count. Enforced in the domain-concept construction pass
(CAS 1.11.0 §5.30, carried forward unchanged).

### 11.4 Persisted-entity evidence (enforced)

`CASDataEntity.kind === 'persisted-entity'` MUST NOT be assigned without a
citable persistence fact in `kind_evidence` (an ORM mapping attribute, a
persistence decorator, an ORM base class, a schema table mapping, a
migration reference, or a repository/DAO reference — CAS 1.11.0 §5.28's
seven admissible carriers, unchanged). An entity's name, casing, or directory
residence MUST NOT be treated as persistence evidence; an entity failing the
gate MUST degrade to `domain-shape`, still surfaced, but excluded from any
ERD rendering that implies durable storage.

### 11.5 Capability structural anchoring (enforced)

Every emitted capability MUST be structurally anchored — a terminal
`api-response` entity, a `persisted-entity` operated on above a minimum
node-count floor, an unclassified entity with lifecycle breadth, or a
substantial business-implementation cluster. A capability anchored only in
runtime/lifecycle-shaped entities with no product evidence MUST carry
`evidence_kind: 'infrastructure'` and MUST be excluded from the shipped
catalog. Unchanged from CAS 1.11.0 §5.31.

### 11.6 Entry/exit point closed type sets (enforced)

`EntryPoint.type` and `ExitPoint.type` MUST be members of `ENTRY_POINT_TYPES`
/ `EXIT_POINT_TYPES` (§5.1), each defined once and consumed by both the type
union and the runtime validator (`isValidEntryPoint` / `isValidExitPoint`,
`packages/analyzer-core/src/analyzer/core/orchestrator.ts:6888`, `:6905`),
so the two cannot drift apart. Verified at that file location. Adding a kind
MUST extend the array only, never a second parallel allowlist.

### 11.7 Edge referential integrity (enforced, as a release gate)

Every `CASEdge.source`/`target` MUST resolve to a known id in `nodes`,
`entry_points`, or `exit_points`. Verified: `checkEdgeReferentialIntegrity`
exists in `packages/analyzer-core/src/analyzer/core/graph-referential-
integrity.ts`, is asserted by `packages/analyzer-core/src/__tests__/core/
graph-referential-integrity.test.ts`, and is run by `infrastructure/vps/
analysis-smoke.mjs` as a pre-deploy gate against a live deterministic
analysis — a nonzero dangling-edge count fails the deploy, not merely the
test suite.

### 11.8 Slice-local referential integrity (enforced within a scope's own tree)

A scope's own capabilities/flows MUST reference only entry points, flows,
and nodes present within that same scope's Tier 1-3 content — never a
dangling reference into a sibling scope. Carried forward from DAS 1.0.0 §9
(a per-unit instance of §11.7) and generalized here to apply at every scope
boundary, not only a within-repo deployable slice.

### 11.9 Determinism (enforced, with a scale caveat)

Same unchanged source input MUST produce byte-identical Tier 1-2 facts
across separate runs and processes, modulo a run-metadata allowlist
(`analysis_id`, `analysis_timestamp`, `generated_at`, `execution_time_ms`).
File/directory enumeration MUST be sorted before emission; generated ids MUST
derive from stable facts (file path + content position), never a per-run
counter. Enforced by `packages/analyzer-core/src/__tests__/ai/run-
stability.test.ts` and `run-stability-cross-process.test.ts` (byte-identity
across repeated and cross-process runs). **Not yet independently re-verified
at large-corpus scale** (the class of repository — tens of thousands of
nodes — where the determinism work originally found and fixed cross-file
`references`-edge variance); the module-level ordering, id-stability, and
glob-sorting guarantees are enforced today independent of that outstanding
scale re-check. Source paths in every location record (`SourceLocation.file`,
`StepCodeRegion.file`, evidence `file` fields) MUST be repository-relative,
never absolute — enforced by construction in every path-emitting analyzer
(no absolute path has ever been observed in stored output; not independently
gate-tested as a standalone assertion beyond the analyzers' own path-joining
discipline).

### 11.10 Scope structure invariants (new in 2.0.0, enforced at the derivation layer)

- `has_children`, leaf status, source-backed, and ship-backed MUST be
  computed at read time, never stored as a cached boolean that can go stale
  relative to the scope tree. Enforced by construction: none of the four
  derivations in §4.3 has a corresponding writable field in `AnalysisScope`.
- A scope tree MUST NOT contain a cycle (`parent_id` chains MUST terminate
  at a root). **Documented-only** in this specification; no cycle-detection
  pass is cited against the current codebase because the recursive-scope
  structure itself is not yet built (§12.1) — this is carried as a
  requirement for the implementation that does build it, not a verified
  property of shipped code.
- A composed scope MUST declare its `composition_mode` (§10.2).
  **Documented-only**, for the same reason: not yet implemented.

## 12. Migration and Compatibility

### 12.1 Status

The recursive `AnalysisScope` structure this specification defines has not
been built. This specification captures the target shape; §12.2-§12.4 define
how an implementation reads what exists today (CAS 1.11.0, WAS 1.0.0, DAS
1.0.0 analyses) through it, so that shipping the structure does not orphan
stored analyses.

### 12.2 Versioning policy

`scope_version` follows the same MAJOR.MINOR.PATCH discipline as
`cas_version` (`docs/analysis-scope/VERSIONING.md`, successor to `docs/cas/
VERSIONING.md`): MAJOR means the shape is not readable across the boundary;
MINOR adds optional fields; PATCH fixes content without changing shape. 2.0.0
is a MAJOR bump from the CAS 1.11.0 / WAS 1.0.0 / DAS 1.0.0 lineage because
the root shape changes (a single `CASOutput`/`WorkspaceAnalysis` root
replaced by a recursive `AnalysisScope` tree) — not because any individual
tier's field-level content changed incompatibly. Every field named in §5-§8
is either unchanged from its 1.11.0/1.0.0 shape or is new; none was renamed
or retyped in place.

### 12.3 Reading a v1 analysis as a scope

A stored CAS 1.11.0 analysis MUST be readable as a single source-backed,
leaf, `scope_version: '1.11.0'`-tagged `AnalysisScope` with:

- `tier1` populated from `nodes`, `edges`, `entry_points`, `exit_points`,
  `external_services`, `method_calls`, `call_chains`, `reachability_index`,
  `structural_importance_meta`, `communities` unchanged.
- `tier2` populated from `paradigm_conformance`, `architectural_conflicts`,
  `principle_violations`, `codebase_idioms`, `conventions_applied`,
  `communication_seams`, `consistency_model`, `dependency_manifest`,
  `deployable_evidence`, `codebase_type(s)` unchanged.
- `tier3` populated from `system_capabilities`, `behavior_surfaces`,
  `flow_graph`, `workflows`, `user_journeys`, `data_entities`,
  `data_lineage`, `domain_concepts`, `enhanced_system_purpose`,
  `product_map` unchanged.
- `tier4` absent unless a runtime-observation store exists for the analysis
  (unchanged: telemetry was never part of `CASOutput` itself).
- `ship-backed` computed exactly as DAS 1.0.0's promotion predicate already
  computes it (§4.3) — no behavior change for a promoted CAS.

A stored WAS 1.0.0 analysis MUST be readable as a non-leaf `AnalysisScope`
(`has_children: true`) whose children are the member `WorkspaceProject`
entries, each itself resolving to its CAS-derived scope per the rule above.
`WorkspaceCapability`/`WorkspaceWorkflow`/`workspace_domains`/
`workspace_entities` map onto the parent scope's `tier3` under the
`composition_mode: 'composed'` reading of §10.2 — WAS 1.0.0 was already
Option B in substance (it explicitly forbids inferring repo-local facts and
requires composing from member CAS outputs only), so no reinterpretation is
needed to fit it into §10.

A stored DAS unit (from a promoted CAS) MUST be readable as a leaf
`AnalysisScope` whose `parent_id` is the owning CAS-derived scope, with
`tier1`/`tier3` populated from the `DasUnitSlice` fields, under
`composition_mode` unset (a DAS unit is source-backed relative to its own
seed set — see DAS 1.0.0 §3.1 — but its comprehension is filter-down from the
parent, which §10.2 already flags as the concrete precedent for Option B's
known limitation).

### 12.4 Divergences found between code and prior documentation

Two divergences surfaced while grounding this specification in the current
codebase rather than the prior CAS/WAS/DAS prose. Both are resolved in favor
of the code, per this task's instruction, and are recorded here rather than
silently folded in:

1. **`determineSystemType` / `system.type`.** No prior version of `docs/cas/
   SPECIFICATION.md` documented the node-type-checklist behavior in enough
   detail to call it a divergence from documentation — the divergence was
   between the *implementation* and the tier-ordering rule this specification
   states in §11.1. Commit `4676925e` (merged as `5c59e755`, the commit this
   worktree branches from) already fixed it: `system.type` is now derived
   from entry-point liveness and deployable-evidence tiers, not
   `CASNode.type` vocabulary. This specification's §11.1 citation reflects
   the corrected, already-shipped behavior; no further code change was made
   as part of writing this document.
2. **`frameworks_detected` shape vs. the abstraction-tiers model's Tier 2
   requirement.** The abstraction-tiers input document (and, by extension,
   this specification's §6.2) requires framework identity, version, and
   purpose. The shipped type is a boolean presence map with none of the
   three. This is not a code defect to fix silently — it is the gap
   recorded in §6.2 and §16, left as a gap rather than patched, because
   closing it is a schema change with its own version bump, outside this
   consolidation's scope.

No divergence was found between the DAS 1.0.0 document and its implementation
during this review; DAS's own §3.3 and §10 already state their known
limitations more precisely than this specification could re-derive
independently, which is why §10.2 and §12.3 cite them directly rather than
restating them.

## 13. Query Interface

Implementations SHOULD support, at any scope:

- Retrieval by `scope_id` with an optional `depth` parameter (0 = this scope
  only, N = include N levels of children, unbounded = the full subtree). A
  project-scope id from a pre-2.0.0 analysis (CAS `analysis_id`) MUST
  continue to resolve under this interface per §12.3.
- Tag- and perspective-based node queries, unchanged from CAS 1.11.0 §6.1-
  §6.3.
- Evidence, runtime-link, and change-history queries, unchanged from CAS
  1.11.0 §6.4.
- Idiom queries, unchanged from CAS 1.11.0 §6.5.
- Progressive retrieval detail levels (`overview` / `connections` /
  `evidence` / `full`) at any scope with children, generalizing WAS 1.0.0
  §6 from "workspace" to "any non-leaf scope."
- Dependency-usage-ordered-by-frequency-across-children, for the project-
  manager-facing view named in the abstraction-tiers input document.

## 14. Extensions

### 14.1 Extension Mechanism

Implementations MAY add fields not defined in this specification. Extension
fields MUST NOT alter the meaning of defined fields, and a consuming
implementation MUST ignore extension fields it does not recognize rather
than failing.

### 14.2 Reserved Names

Field names beginning with `tier1`, `tier2`, `tier3`, `tier4`, `tier5`, or
`scope_` are reserved for this specification and MUST NOT be used for
unrelated extension fields.

## 15. Security Considerations

### 15.1 Sensitive Information

`CASDataEntity.fields[].is_sensitive` and `security` blocks on entry points
MAY be used to redact or restrict field-level output. Implementations
transmitting scope data across trust boundaries SHOULD apply the same
sensitivity flags before serialization, unchanged from CAS 1.11.0 §8.

### 15.2 Access Control

A recursive scope structure widens the blast radius of an access-control
mistake relative to a single-project CAS: a caller granted access to a leaf
scope MUST NOT thereby gain access to sibling or ancestor scope content. This
specification does not define an access-control model; it requires that any
implementation define one before granting cross-scope query access, since
the recursion itself (§10) makes composed queries span more content than a
single CAS ever could.

## 16. Gap Register

Consolidated from §6 and §7, for a reader who wants the list without the
surrounding rationale:

1. **Framework identity, version, and purpose** (§6.2) — no field carries a
   framework's version or its purpose (web/ORM/DI/test/build/queue); only a
   boolean presence map exists.
2. **Framework-conferred node roles beyond route-handler and persisted-
   entity** (§6.2.1) — migration, scheduled job, event listener, gateway,
   middleware, guard, and resolver have no closed-vocabulary role field
   reachable without a decorator/annotation.
3. **Library and dependency roles** (§6.3) — declared dependency names carry
   no role classification (HTTP client, DB driver, cache, broker, payment
   SDK, observability agent); the raw name list has no structural join to a
   role, deterministic or AI-assigned.
4. **Architecture paradigm component kinds** (§6.4) — a detected paradigm
   carries adoption rate and deviations but no structured list of the
   component kinds it implies.
5. **Entity ↔ capability linkage** (§7.4) — one-directional, untyped, and
   unevidenced, unlike the other three comprehension-member relationships.
   A concrete target shape (`related_capabilities` mirroring
   `capability_relationships`) is proposed in §7.4.
6. **Composition mode for non-leaf scopes** (§10.2) — genuinely undecided
   between re-derive and compose-with-provenance; this specification states
   the tradeoff and the existing DAS precedent rather than choosing.
7. **Cycle detection and `composition_mode` declaration enforcement**
   (§11.10) — stated as requirements for the not-yet-built recursive
   structure; no enforcement exists because the structure does not exist
   yet to enforce it against.
