# CAS Determinism Boundary — Facts are deterministic, Comprehension is AI

Status: **authoritative target architecture (2026-07-07).** Supersedes the prior
"deterministic text is the default, AI replaces it after gates, on failure the
deterministic text is kept" model, which is retired. Sections marked *current*
describe shipped behavior; everything else is the target the build converges to.

## The one rule

There are exactly two kinds of output and they never cross:

- **FACTS (structure)** — produced *deterministically* from source analysis.
  Same source → byte-identical facts, always. AI never writes a fact.
- **COMPREHENSION (meaning)** — produced *only* by AI, always. There is **no
  deterministic comprehension**: no template description, no keyword domain
  label, no deterministic narrative, no "heuristic fallback." 

**AI is always available.** If a comprehension model call fails, that is a
**thrown exception**, not a degraded artifact and not a substituted string. We
never emit a deterministically-authored description/domain/narrative "because AI
was unavailable" — that situation does not exist as a supported mode. Remove the
fallback code; it is not a safety net, it is a defect.

This retires: `description_source: 'deterministic'`, `domain_source:
'deterministic'`, the keyword domain classifier (`orchestrator.ts` ~9095–11267),
every hardcoded description frame, the workspace-level (parent-CAS) `deterministic_narrative`, and the
"degraded default CAS" concept.

## The three camps (the code-intelligence layers; every CAS, leaf or parent, has all three)

| Camp | What | Determinism | Scope note |
|---|---|---|---|
| **B — Structure** | the compile/connectivity graph + all code facts | **deterministic** (the ONLY place determinism lives) | A leaf CAS: tree-sitter symbols + **resolved references** + entities, routes, endpoints, deployables, classes, contracts, communication seams, data lineage. A composed (parent) CAS: the **inter-sub-CAS-node** connectivity graph — runtime/integration links, cross-repo contracts, shared code, data-flow paths, deployables, topology, and communication seams between sub-CAS nodes (`docs/cas/SPECIFICATION.md` §0.8). |
| **A — Retrieval** | semantic search over the graph/code | deterministic infra, model-scored | surfaces the right grounding so Camp C isn't writing from thin air |
| **C — Comprehension** | meaning, in the comprehension ladder below | **AI only, or throw** | Every CAS, leaf or parent, has the full ladder |

## The comprehension ladder (Camp C) — code → up

Every CAS — a leaf project or a composed parent — carries every rung:

1. **Overall description**
2. **Capabilities** — description · related flows · entities · project connections · 3rd-party integrations. **No ICELOT.**
3. **Flows** — description · steps · related entities · project connections · 3rd-party integrations. **ICELOT.**
4. **Steps** — related entities · **functions** · 3rd-party integrations · project connections. **ICELOT. First rung bound to code.**
5. **Functions** (and the other code facts) — the leaves. **ICELOT.**

`Capability → Flow → Step → Function` is the ladder. A **step is not 1:1 with a
function** — a step (and thus its flow/capability) may span several functions or
be a logical sub-step inside one. Flows/steps are logical units laid over the
compile graph, not a renaming of it.

The ladder binds to **more than functions** as code facts: steps and ICELOT
facets reference entities, routes/endpoints, exit points, deployables, external
services, and data-lineage nodes — the full Camp-B vocabulary, not just
`function` nodes.

### ICELOT applies to everything *behavioral*

`ICELOT` = **I**nput · **C**onstraints · **E**ffects (state changes +
integrations) · **L**ogic · **O**utput · **T**elemetry. It applies to flows,
steps, and functions — **not** to capabilities and **not** to the
workspace-as-a-whole (too high-level to bind directly). See
[../UNDERSTANDING-MODEL.md](../UNDERSTANDING-MODEL.md) for the full facet spec.

ICELOT itself straddles the boundary, per-facet:
- **Deterministic (Camp B):** Input = signature/params; Effects = which entities
  are written / which integrations are called (from the call graph); Output =
  return types/produced entities; Telemetry = which telemetry calls fire.
- **AI (Camp C):** Logic and the interpretive meaning of every facet — *what the
  unit actually does and why*. Evidence-gated: an interpretive facet is written
  only when a real Camp-B fact grounds it, never invented.

## Camp B must be run-to-run deterministic

Same unchanged source → byte-identical Camp-B facts (nodes, edges, entry/exit
points, entities, routes), modulo the run-metadata allowlist (`analysis_id`,
`analysis_timestamp`, `generated_at`, `execution_time_ms`).

**Cross-file `references`-edge resolution — status as of 2026-07-30 (updated,
was documented as an open defect since 2026-07-07):** a 2026-07-07 audit
documented ambiguous cross-file name resolution (the same identifier declared
in more than one file) as depending on async file-processing order, with
~6–13 fuzzy reference edges flipping present/absent across separate processes
on a 24k-node repo. That same day, a few hours later, commit `a3b6e0c2`
("import-source-aware ref resolution, refs run-stability + deployable
fixtures") landed the fix this note called for — but this doc was never
revisited against it until now. What `a3b6e0c2` established, in
`typescript-javascript-analyzer.ts`:
- Ambiguous same-named candidates resolve **import-source-aware first**
  (`selectDeclarationCandidate`, via `importsByConsumerFile` /
  `indexImportNode`): if the consumer imported the name from a specific
  module, that module's declaration wins.
- Any remaining ambiguity is broken by `compareNodesStable` — a total order
  over source file, then line, then node id — never insertion/discovery
  order. Declaration node ids are content-hashed (`generateNodeId(type,
  filePath, name)`, sha256 of file path + name, no counters); variable-node
  ids are a position-within-its-own-file index. Neither depends on the order
  files were processed in, so the tiebreak is order-independent by
  construction, not just in practice.
- `6f15b06b` (2026-07-30, "make cachedGlob deterministic outside orchestrator
  runs") is a separate, later contributor: it closed a no-token gap in
  `glob-cache.ts` where calls outside a `beginGlobRun`/`endGlobRun` window
  (every analyzer's own unit test) skipped the sort `a3b6e0c2` didn't touch.
  Not the fix for the ambiguous-resolution defect itself, but it removes an
  adjacent source of file-discovery-order variance.

**Reproduced:** `run-stability-cross-process.test.ts` spawns 5 genuinely
separate, cold `node` child processes (no shared module cache, no shared
event loop — unlike `run-stability.test.ts`'s in-process repeated calls)
against a fixture with real 3-way cross-file name ambiguity (12 groups, each
name declared in 3 different files, 72 cross-file consumers, 150 unrelated
filler files for realistic file-discovery/read concurrency). All 5 processes
produced a byte-identical `references`-edge set (144 edges) with 100% correct
import-source attribution (every consumer resolved to the exact module it
imported from, zero misattributions). A companion code audit of the
resolution path (orchestrator merge/dedup, tree-sitter extraction, the
worker-pool call-graph integration, and the other language analyzers) found
no other completion-order-dependent pattern feeding `references`-edge
resolution — see `appendGraphItemsUnique`'s cross-analyzer bucket tiebreak
below for the one latent (not live) risk that turned up and was hardened.

**What remains unverified:** this is small-fixture, cross-process proof, not
a repeat of the original measurement at realistic corpus scale — the ~24k-node
class of repo the 2026-07-07 defect was originally measured on. The exception
above is very likely closed, but that specific scale has not been re-run
since `a3b6e0c2`/`6f15b06b`. Until it is, treat "closed" as "closed at fixture
scale, unconfirmed at corpus scale" rather than an unconditional invariant.

Enforcement mechanisms that DO hold today: run-scoped glob results are sorted
before emission — ENFORCED in `glob-cache.ts` since task #20, and outside a
run since `6f15b06b` (raw async glob order was never deterministic; it merely
looked stable while minimatch cost serialized the walker). Direct glob
callers and `withFileTypes` walks remain OUTSIDE that protection and must
sort their own results. Ids must derive from stable facts (file path +
content position), never per-instance run counters —
`comment_${++counter}`-style ids drift on WARM re-analysis in the long-lived
server even though fresh-process runs look stable (fixed across 19 analyzers,
task #20). `applyCanonicalOrdering` canonicalizes nodes/edges/entry/exit/libraries;
tie-broken fallback selection; the Rust analyzer's two-phase link;
`appendGraphItemsUnique`'s cross-analyzer entry-point bucket pick
(`orchestrator.ts`) now has its own id-sorted tiebreak rather than relying on
callers to hand it a pre-sorted array. Regression:
`npx jest src/__tests__/ai/run-stability.test.ts` (warm re-analysis
byte-identity, rejects `^(comment|todo)_\d+$` ids) and
`npx jest src/__tests__/ai/run-stability-cross-process.test.ts` (cross-process
references-edge byte-identity + import-source attribution correctness).

## Camp C generation contract

- Every comprehension value (overall description, capability/flow/step
  descriptions, domain, workspace narrative, interpretive ICELOT facets) is
  written by the AI pass, grounded in the Camp-B evidence bundle (real
  languages, full dependency manifest, entities, integrations, deployables,
  connectivity) + Camp-A retrieval.
- Provenance is always `ai` (or `manual` for user-curated, `reused` for
  incremental carry-forward of prior AI/manual text). `deterministic` is not a
  valid comprehension provenance and must not appear.
- Evidence-gated: the model is given facts and told to interpret them, never to
  invent. No fact for a claim → the claim is omitted, not fabricated. This is how
  "reads as crypto" happens for a repo that depends on `ccxt`/`web3` — the model
  reads the real dependency + integration facts, not a keyword in a name.
- Model-call failure throws. No silent degrade.

## How to re-verify

1. No `description_source: 'deterministic'` / `domain_source: 'deterministic'`
   is ever written (grep the orchestrator; the assignment sites are deleted).
2. No hardcoded domain/description keyword classifier remains
   (`grep -niE 'solana|arbitrage|tokens.includes' orchestrator.ts` → only
   incidental, none producing a label or a sentence).
3. Structural builders never read `description`/`inferred_description`.
4. Run-stability test passes AND is extended to assert identical edge sets
   across separate processes (the open defect above).
5. On a crypto-exchange-shaped codebase the domain + description read as a
   crypto-exchange system (grounded in `ccxt`/`web3`/`blockchains/`), answering
   what-is / does / how-works / how-built; on klauro they read as an AI
   code-analysis tool — same pipeline, zero hardcoding.
