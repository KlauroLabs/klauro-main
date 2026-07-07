# CAS / WAS Determinism Boundary — Facts are deterministic, Comprehension is AI

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
every hardcoded description frame, the WAS `deterministic_narrative`, and the
"degraded default CAS" concept.

## The three camps (the code-intelligence layers; both CAS and WAS have all three)

| Camp | What | Determinism | Scope note |
|---|---|---|---|
| **B — Structure** | the compile/connectivity graph + all code facts | **deterministic** (the ONLY place determinism lives) | CAS: tree-sitter symbols + **resolved references** + entities, routes, endpoints, deployables, classes, contracts, communication seams, data lineage. WAS: the **cross-repo** connectivity graph — runtime/integration/application links, cross-repo contracts, shared code, data-flow paths, deployables, topology. |
| **A — Retrieval** | semantic search over the graph/code | deterministic infra, model-scored | surfaces the right grounding so Camp C isn't writing from thin air |
| **C — Comprehension** | meaning, in the comprehension ladder below | **AI only, or throw** | CAS + WAS both have the full ladder |

## The comprehension ladder (Camp C) — code → up

Both project (CAS) and workspace (WAS) carry every rung:

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

## Camp B must be run-to-run deterministic (and currently is NOT, in one place)

Same unchanged source → byte-identical Camp-B facts (nodes, edges, entry/exit
points, entities, routes), modulo the run-metadata allowlist (`analysis_id`,
`analysis_timestamp`, `generated_at`, `execution_time_ms`).

**Known open defect (2026-07-07):** cross-file `references`-edge resolution is
NOT yet deterministic — ~6–13 fuzzy reference edges flip present/absent across
separate processes (edge count 8128↔8134 on a 24k-node repo) because ambiguous
name resolution depends on async file-processing order. This must be fixed
(deterministic candidate selection over sorted inputs) — it is a Camp-B
correctness bug, since a fact must not change run-to-run.

Enforcement mechanisms that DO hold today: glob results are sorted before
emission; `applyCanonicalOrdering` canonicalizes nodes/edges/entry/exit/libraries;
tie-broken fallback selection; the Rust analyzer's two-phase link. Regression:
`npx jest src/__tests__/ai/run-stability.test.ts` (must be extended to cover the
reference-edge case above).

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
5. On soon-lens the domain + description read as a crypto-exchange system
   (grounded in `ccxt`/`web3`/`blockchains/`), answering what-is / does /
   how-works / how-built; on klauro they read as an AI code-analysis tool — same
   pipeline, zero hardcoding.
