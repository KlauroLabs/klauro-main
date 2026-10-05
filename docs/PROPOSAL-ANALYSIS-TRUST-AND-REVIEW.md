# Proposal: an honest analysis

Status: proposal, revised 2026-10-04 after an audit of what the repository already has, and after a correction from the owner: the goal is a good analysis, not layers of validation and verification, and gates are tests, not product. Nothing here is built. This document is generic by design (see `docs/KLAURO-PRODUCT-MODEL.md`) and names no outside product. The companion is `docs/PROPOSAL-ACCURACY-AND-DEPTH-FROM-THE-FIELD.md`.

## The principle

Nothing here adds a pass to the analysis pipeline. `docs/ANALYSIS-NORTH-STAR.md` already says there is no candidate stage, no repair loop, no confidence score and no validation pass; the code is read, not argued with. Where the analysis is wrong or silent, the fix goes into the extractor or resolver that produced the answer, and the answer becomes better or states what it does not know. Anything that only checks the analysis belongs in the offline tests, not in the product.

Rules that still apply: a failed comprehension call is a thrown exception, not a degraded artifact (`docs/cas/DETERMINISM-BOUNDARY.md`); the output never carries the pipeline talking about itself, and every new output field needs a line in `docs/ANALYSIS-OUTPUT-STOCKTAKE.md`; the local store is a read-through cache; unshipped code is tagged and kept; structure and delivery status stay separate.

## 1. A trail that runs out is not read-only

A flow's `standing` is terminal, proximal or reading, derived only from effects along the resolved path (`comprehend.rs`). A path that ends in a call the engine could not resolve, with no effect found, is labeled reading, as though proven read-only. That is wrong, and it feeds terminality, capability weights and absorption.

The facts already exist and are thrown away. `resolve.rs` counts unresolved and dynamic calls and unresolved names, but only to stderr. `steps.rs` stops silently at its depth and action limits, and `leads_into` is truncated silently.

Keep them. Per flow, keep the unresolved and dynamic counts and note when a limit cut the trail. Add `open` as a fourth standing for a flow whose trail ends in our own unresolved code or a cut, and let terminality, weights and absorption treat open as unknown, never as zero. A call into library, runtime or external-service code is a known boundary and stays terminal or proximal as today. Keep `tests/guessed_callee_terminal.rs` green: a trusted guessed edge to a hand-written callee stays terminal. This is a change to how the analysis computes standing, not a new check.

## 2. Edges say how they were found

`IndexEdge` carries only source, target and kind. The resolver already knows whether it found an edge by structure (imports, types, declared receivers), by name alone, or through a framework rule, and `resolve.rs` keeps a `guessed` set in memory that comprehension already distrusts. Keep that knowledge on the edge. A resolved call and a use with no uniquely proven target become different edge kinds. This costs one field, needs no type system, and lets terminality trust what it should, lets the accuracy benchmark score by kind, and lets a reader of an MCP result tell "calls this" from "refers to something like this". It is not a confidence score on capabilities.

## 3. An analysis never fails: incomplete items are kept, marked and scored

Decided: we never fail, and we need accuracy and completeness. A run once lost several hundred AI answers to a rate limit; failing the run was the wrong answer, and so was publishing it silently. Every ask is retried within its wait budget, jev asks included. An item whose ask is still unanswered after that is emitted with its structural content, marked `unsettled: "ai-unanswered"`, and given a low `confidence`. A capability that lacks provenance in a parent is kept, marked as an orphan (parent-originated) fact, and given a lowered `confidence`; it is never dropped. A non-zero exit remains an error and means the repository could not be read. `confidence` is computed from signals the engine already holds, with no extra pass and no extra ask (`SEMANTIC-MODEL.md`, Confidence).

## 4. Route between two steps

Reach already exists: `get_callers` and `get_callees` with depth and limit, `getAffectedSet`, `get_interface_signature` at function, flow, capability, project and workspace level, `assess_change_risk`, `get_call_chain`. Add one query: the path or paths between two arbitrary steps, with the evidence on each hop and the bound applied, so a reader knows when the answer is complete.

## 5. Comparison that survives renames

Comparison tools exist (`compare_analysis_iterations`, `diff_behavior`, `get_changes_between`, `get_analysis_at`, the fabric tools). Identifiers survive line shifts (`stable_ids.rs`), but a rename currently breaks identity, and the engine's capabilities, flows, steps and entities are not covered by a delta. Extend identity to survive renames and extend the existing comparison to the engine's output. `BreakingChange` is declared in `cas.types.ts` and nothing produces it; giving it a producer (each changed export marked breaking or not, with its consumers) is the useful part.

## 6. Smaller items

- **A documented Markdown export** on top of the existing machine export, so an analysis can be read without Klauro running.
- **A public gallery** of navigable analyses of well-known open-source projects, built from the pinned corpus mechanism (`gauntlet/fixtures/terminality-public-corpus.json`); it demonstrates the product and exposes weaknesses.
- **A reason when a part refreshed.** Refresh already keys on the facts text (`memory.rs`); show which fact changed.

## Not doing

Earlier drafts proposed a persisted run ledger with a publish gate, a mechanical evidence-check pass over capability claims, a pass/fail/unknown result type on every check, per-claim unknown fields, a staged readiness verifier, hidden-tool reasons, obligation closure and a claim-grounding model. They were dropped as layers of checking. The grounding that exists (`tighten_claims`, `Grounding`, the vetting step) stays as it is, and the audit loop stays a development tool.

## Order

1. Open ends and edge kinds (sections 1 and 2): they make the analysis itself more correct.
2. Failed asks fail the run (section 3): small.
3. Route and rename-safe comparison (sections 4 and 5).
4. The smaller items.

## Open questions

- Whether a provenance drop fails the run.
- The identity scheme that survives renames.
