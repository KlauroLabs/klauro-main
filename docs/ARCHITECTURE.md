# Klauro Architecture — Master Index

> **Status: LIVING DOCUMENT.** Grounded in `docs/CHANGELOG.md` (v1.0.2 → v1.0.20 as of
> 2026-07-04) and `~/.klauro/agent-feedback/*.md`. This is the map, not the territory — every
> claim below links to the detailed spec or the changelog entry that proves it. Where a thing
> is roadmap rather than shipped, it is labeled **VISION**, not blended into the SHIPPED prose.

## 0. What Klauro is, in one paragraph

Klauro parses a codebase into a deterministic structural graph (the CAS — Code Analysis
Spec), composes multiple codebases into a workspace graph (the WAS — Workspace Analysis
Spec), lifts that graph into a human mental model (capability → flow → step → function,
with I/L/S/O + constraints at every level), and exposes all of it — plus a coordination
fabric for concurrent agents — over ~200 MCP tools. AI enriches the prose; it never decides
what is true. The moat is depth of understanding, not chat.

## 1. The four layers

```
┌─────────────────────────────────────────────────────────────────────┐
│ 4. COORDINATION FABRIC — awareness, claims, conceptual-conflict     │
│    detection for concurrent agents/humans on one codebase           │
├─────────────────────────────────────────────────────────────────────┤
│ 3. CONCEPTUAL UNDERSTANDING LAYER — Capability → Flow → Step →      │
│    Function, I/L/S/O + Constraints; structural perspectives         │
│    (architecture, paradigm)                                         │
├─────────────────────────────────────────────────────────────────────┤
│ 2. COVERAGE SYSTEM — what makes the graph correct across languages, │
│    frameworks, and codebase types (coded analyzers + declarative    │
│    packs + local conventions + self-improving gap-discovery)        │
├─────────────────────────────────────────────────────────────────────┤
│ 1. THE KERNEL — parse → CAS graph → entry points → WAS composition  │
└─────────────────────────────────────────────────────────────────────┘
```

Each layer is built ON the one below it, and each is queryable directly via MCP — an agent
does not have to climb the stack to get value; `get_summary` alone is useful, but
`get_flow_concepts` + the fabric together are where the compounding value lives.

## 2. Layer 1 — The kernel (SHIPPED)

**Parse → CAS graph → entry points → flows/capabilities → WAS.**

1. **Parse.** ~130 languages parse via tree-sitter; ~68 have live framework/library-level
   analyzers (was ~48 before the v1.0.20 six-agent breadth wave — see `docs/CHANGELOG.md`
   v1.0.20). Deep, coded analyzers exist per major language/framework (see `docs/mcp/
   ANALYZER-COVERAGE.md`); a generic tree-sitter walker covers the rest structurally.
2. **CAS graph** (Code Analysis Spec, `docs/cas/SPECIFICATION.md`, currently v1.11.0) —
   nodes (functions, classes, routes, entities, config, …) and typed edges (`calls`,
   `references`, `provides`, `binds`, `imports`, …), all evidence-gated: an edge is only
   emitted when real source evidence supports it, never guessed by name similarity. This is
   the "never fabricate" invariant that recurs through every analyzer built this session
   (DI-container bindings, mediator/CQRS dispatch resolution, ORM import-gating — see
   `~/.klauro/agent-feedback/2026-07-05-di-libs.md`, `2026-07-05-cqrs-messaging.md`).
3. **Entry points.** HTTP routes, CLI commands, message/queue consumers, scheduled jobs,
   MCP tools, raw socket servers — each becomes a flow root. v1.0.13–v1.0.14 closed the
   biggest historical gap here: monorepo blindness (Nx/Turborepo `apps/*` misclassified as
   independent projects, a reference multi-service monorepo's entry points 12→519) and missing
   Fastify/cron detectors.
4. **Flows/capabilities.** `get_flow_concepts` computes the behavioral hierarchy over the
   CAS graph (detailed in Layer 3 below). `system_capabilities` are extracted structurally
   and ranked by terminal-entity proximity (the last-in-chain entity reveals the domain —
   see the terminal-entity principle in `docs/SPEC-INTELLIGENCE-CAPITALIZATION.md` §1).
5. **WAS composition** (Workspace Analysis Spec, `docs/was/SPECIFICATION.md`) — composes
   one or more CAS graphs into a cross-codebase view: deployables (evidence-gated, not
   folder-name-guessed — see `docs/SPEC-DEPLOYABLE-DETECTION.md`), cross-repo contracts,
   shared libraries, and a workspace-level capability map.

**Honest gaps (kernel):** `get_callers` blast-radius completeness is a recurring theme —
fixed for function-call edges and several cross-file-reference shapes as of v1.0.20 ("grep
parity" claimed, measured on two symbols on a reference multi-service monorepo), but the independent
`docs/IMPACT-BENCHMARK.md` re-run on 2026-07-04 found `get_callers` still missing 100% of
real cross-file consumers of plain exported constants/entity classes on two different repos
and languages (PHP, TypeScript) — read that gap as **not yet independently re-verified
after the v1.0.20 fix**, since the benchmark predates it. Re-run the benchmark's r1/r3 tasks
before citing blast-radius completeness as fully closed.

## 3. Layer 2 — The coverage system (SHIPPED core + VISION extensions)

**How Klauro analyzes "any" codebase**, not just the languages/frameworks it has bespoke
code for. Full detail: `docs/SPEC-COVERAGE-MODEL.md`.

- **Coded analyzers (SHIPPED)** — hand-written, deep, per-language/framework. ~68 live
  major-framework analyzers as of v1.0.20, plus dedicated architecture-defining-library
  analyzers (ORM, auth, payments, queues, DI containers, CQRS/mediator, message brokers —
  `docs/mcp/ANALYZER-COVERAGE.md`). Highest fidelity, highest build cost per language.
- **Codebase-type model (VISION, in progress)** — a fabric claim (`type-library`,
  `type-cli`, `type-dataml`, `type-infra`, `type-desktop`, `type-game-embedded`, and the
  umbrella `coverage-intel` claim) is actively building entry-point models for library/CLI/
  data-ml/infra/desktop/game/embedded codebase types — the recognition that "web app" is
  only one of several fundamentally different entry-point shapes. See
  `docs/SPEC-COVERAGE-MODEL.md` §2.
- **Declarative analyzer packs (VISION, in progress)** — a fabric claim (`analyzer-packs`)
  is building a YAML + tree-sitter-query engine so new framework coverage doesn't require a
  bespoke TypeScript analyzer per framework — the second of the three declarative tiers.
  See `docs/SPEC-COVERAGE-MODEL.md` §3, peer spec `docs/SPEC-ANALYZER-PACKS.md`.
- **Local conventions / `.klaurorc` (VISION, in progress)** — a fabric claim
  (`custom-conventions`) is building a way for a single repo to declare its own
  architecture conventions/entry-point shapes without waiting for a built-in or community
  pack. Third declarative tier. See `docs/SPEC-COVERAGE-MODEL.md` §3.
- **Inference + gap-discovery (VISION, in progress)** — the self-improving loop: detect
  where the graph is structurally thin (a file with no resolved entry points/edges in an
  otherwise well-covered repo) and surface it as an actionable gap rather than silently
  under-reporting. See `docs/SPEC-COVERAGE-MODEL.md` §4.

**Honest coverage matrix** (languages parse vs. frameworks-deep vs. types-covered) lives in
`docs/SPEC-COVERAGE-MODEL.md` §5 — do not conflate "~130 languages parse" with "~130
languages have framework-level depth"; the gap between those two numbers is real and
tracked there.

## 4. Layer 3 — The conceptual understanding layer (SHIPPED core, v1.0.12)

Full detail: `docs/SPEC-CONCEPTUAL-LAYER.md`.

The index (files, functions, call graph) is the substrate. Over it, Klauro computes the
concepts a human architect actually thinks in:

- **Behavioral hierarchy:** Capability → Flow → Step → Function/sub-section. A Step maps to
  one function, many functions, or a slice of one function's body. Every Flow and Step
  carries a uniform contract: **I**nput / **L**ogic / **S**ide-effects (split into
  `state_changes` vs `external_integrations`) / **O**utput / **C**onstraints (business rules
  and invariants recovered from guard clauses and validation). Same shape from one function
  up to a whole capability. Tool: `get_flow_concepts`.
- **Structural perspectives:** architectural-layer/principle conformance and paradigm
  (OO/functional/procedural/reactive/actor) conformance, unified with the behavioral
  hierarchy via `get_unified_perspectives` — a Flow/Step carries its architectural layer and
  paradigm deviations, and an architectural conflict resolves back to the flows/steps it
  touches.

**Why this matters beyond comprehension:** it is the vocabulary the coordination fabric
uses. "I own the Charge step of the Checkout flow" is a claim a fleet of agents can reason
about; "I'm editing lines 40-60 of file X" is not. See §5.

**Shipped in v1.0.12** (one 7+ agent parallel session, converged clean): `get_flow_concepts`,
flow/entity derivation, registration→handler edge-linking (closed the "flows degrade to
single steps" gap for React hooks and this repo's own MCP-tool entry points),
`get_unified_perspectives`, and the fabric's conceptual vocabulary
(`ConceptualCoordinate`, `conceptual-scope.ts`).

## 5. Layer 4 — The coordination fabric (SHIPPED core model, VISION at fleet scale)

Full detail: `docs/SPEC-COORDINATION-FABRIC-V2.md` (the current, authoritative model — read
its own header before citing anything from `docs/SPEC-COORDINATION-FABRIC.md`, which is v1
and superseded on the core mechanism). User-facing companion: `docs/COORDINATION-FABRIC.md`.

**The core model (§1.7 of v2, SHIPPED same-machine):** concurrent work + awareness +
semantic reconciliation — **not** locking. Two agents editing the same file, even the same
function, concurrently is fine as long as they have awareness of each other. Locking is
demoted to an opt-in tool (`claim_work`/`grant-manager.ts`) for the rare genuine-exclusive
case, not the default coordination mechanism.

- **Awareness substrate (SHIPPED)** — every agent always sees who holds what, with what
  intent, and the CAS/WAS blast radius, without needing to request anything.
- **Conceptual-conflict detection (SHIPPED, the crown jewel)** — comparing concurrent
  agents' intents + in-flight diffs against the CAS/WAS graph to flag *jointly incoherent*
  changes: contract divergence, invariant conflicts, structural divergence, behavior drift.
  This is invisible to git/linters (they only catch textual/merge conflicts) and only
  detectable with code semantics + intent.
- **Opt-in exclusive grants (SHIPPED, proven at scale)** — `grant-manager.ts`, symbol-level,
  lease + heartbeat + FIFO queue. `docs/FABRIC-FLEET-PROVEN.md` stress-tested this with REAL
  OS-process concurrency (not single-process simulation) at N=8/16/32/64 agents: **0
  double-grant violations across 960+ processes**, ground-truth-verified by replaying the
  on-disk claim log, not trusting self-reports. Conceptual-conflict precision 1.0 at all
  sizes; recall 1.0 at N≤32, 0.857 at N=64 in one run (traced to a harness timing gap, not a
  fabric defect — see that doc's Methodology Notes).
- **Same-machine only (honest limit).** Cross-machine coordination (the remote tier,
  `remote-store.ts`) is a write-through cache design, unit-tested with a mocked fetch, but
  **not** proven under real second-machine concurrency. This is the single largest open gap
  between "proven" and "the vision."

**VISION — the giant fleet (100-200 agents).** A fabric claim (`giant-fleet`) is actively
scaling this same model and writing `docs/SPEC-GIANT-FLEET.md`. The full vision — how an
entire project's scope decomposes into a claimable work-DAG that hundreds of agents execute
in parallel at ~100x less wall-clock than single-piece flow — is `docs/
SPEC-PARALLEL-DEV-FLEET.md` (§6).

## 6. How the layers compose (the actual value chain)

1. **Kernel** produces ground truth agents can query in one call instead of grep+read
   (`docs/IMPACT-BENCHMARK.md` measured **~98% fewer tokens at equal correctness** for
   orientation, on a small honest sample — see that doc for the wins AND the losses).
2. **Coverage system** is what keeps the kernel's ground truth actually true across the
   long tail of languages/frameworks a real portfolio contains, not just the handful with
   bespoke analyzers.
3. **Conceptual layer** turns the kernel's graph into the vocabulary humans and agents
   already think in — capability/flow/step, not node-id/edge-type.
4. **Fabric** lets many agents work that vocabulary concurrently without stepping on each
   other, using the conceptual layer's vocabulary as the coordination unit ("own a step of a
   flow," not "own a file").

The whole stack exists to make one thing possible: a large fleet of agents (and humans)
executing a big, ambiguous, real-world change to a real codebase in parallel, safely, aligned
on meaning. That is the thesis of `docs/SPEC-PARALLEL-DEV-FLEET.md`.

## 7. Detailed specs (index)

| Spec | Layer | Status |
|---|---|---|
| `docs/cas/SPECIFICATION.md` | 1 (kernel) | SHIPPED, v1.11.0 |
| `docs/was/SPECIFICATION.md` | 1 (kernel) | SHIPPED |
| `docs/SPEC-DEPLOYABLE-DETECTION.md` | 1 (kernel/WAS) | SHIPPED |
| `docs/SPEC-ENTITY-MODEL.md` | 1 (kernel/WAS) | DESIGN STUDY, not implemented |
| `docs/SPEC-COVERAGE-MODEL.md` | 2 (coverage) | SHIPPED core + VISION (this doc set) |
| `docs/SPEC-ANALYZER-PACKS.md` | 2 (coverage) | VISION, peer in progress |
| `docs/SPEC-CONCEPTUAL-LAYER.md` | 3 (conceptual) | SHIPPED core, v1.0.12 |
| `docs/SPEC-INTELLIGENCE-CAPITALIZATION.md` | 3 (conceptual) | mostly shipped, audit doc |
| `docs/SPEC-COORDINATION-FABRIC.md` | 4 (fabric) | v1, superseded — kept for history |
| `docs/SPEC-COORDINATION-FABRIC-V2.md` | 4 (fabric) | SHIPPED core model, authoritative |
| `docs/FABRIC-FLEET-PROVEN.md` | 4 (fabric) | evidence: multi-process stress proof |
| `docs/FABRIC-FLEET-PROOF.md` | 4 (fabric) | evidence: single-process API proof |
| `docs/SPEC-PARALLEL-DEV-FLEET.md` | 4 (fabric, vision) | VISION (this doc set) |
| `docs/SPEC-GIANT-FLEET.md` | 4 (fabric, vision) | VISION, peer in progress |
| `docs/SPEC-FRESHNESS.md` | cross-cutting | SHIPPED (~2026-07-02), wiring breadth still growing |
| `docs/SPEC-RESPONSE-BUDGET.md` | cross-cutting | PARTIALLY SHIPPED |
| `docs/COMPREHENSION-LAYER.md` | 1-3, user-facing | SHIPPED, tool-to-concept map |
| `docs/COORDINATION-FABRIC.md` | 4, user-facing | SHIPPED, user-facing companion |
| `docs/IMPACT-BENCHMARK.md` | cross-cutting | evidence, honest wins+losses |
| `docs/CAMPS.md` | competitive framing | SHIPPED |
| `docs/CHANGELOG.md` | everything | living, source of truth for "when did X ship" |

## 8. Reading order

- **New to the product:** this doc → `docs/KLAURO-PRODUCT-MODEL.md` → `docs/
  COMPREHENSION-LAYER.md` → `docs/CHANGELOG.md` (latest entries).
- **Building the vision:** this doc §5-6 → `docs/SPEC-PARALLEL-DEV-FLEET.md` → `docs/
  SPEC-COORDINATION-FABRIC-V2.md` → `docs/SPEC-CONCEPTUAL-LAYER.md`.
- **Extending coverage:** `docs/SPEC-COVERAGE-MODEL.md` → `docs/mcp/ANALYZER-COVERAGE.md` →
  the peer specs (`SPEC-ANALYZER-PACKS.md`, and the coverage-intel/custom-conventions fabric
  claims for current in-flight state).
- **Auditing honesty:** `docs/IMPACT-BENCHMARK.md` → `docs/DOCUMENTATION-STATUS.md` → any
  spec's own header (every spec in this repo is required to carry a status line — trust
  that line, verify against source before citing as shipped in new work).
