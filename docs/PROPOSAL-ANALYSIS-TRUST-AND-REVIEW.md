# Proposal: analysis trust and review

Status: proposal, 2026-10-04. Nothing here is built. These ideas come from comparing Klauro with adjacent tools in which an agent re-reads a repository and authors a diagram or map each time. Klauro starts ahead on truth because it computes the graph once. The aim here is to make that advantage visible and checkable. This document is generic by design (see `docs/KLAURO-PRODUCT-MODEL.md`); it names no outside product.

## 1. An analysis receipt

Every analysis carries a receipt saying what it is and what it is not. Today a degraded run can look complete: a run once lost several hundred AI answers to a rate limit and still published normally; a provenance rule can drop capabilities without a trace.

The receipt records, per analysis and per sub-project:

- the revision analyzed and which paths were dirty;
- AI requests asked, answered from memory, answered fresh, and unanswered after all retries;
- capabilities, flows or entities dropped by an invariant, with the reason;
- sub-projects that fell back to a default;
- the engine, contract and prompt-contract versions;
- a single `complete` flag that is false whenever anything above is non-zero.

Consumers (CLI, desktop, MCP) show a degraded analysis as degraded and never present it as complete. A failed gate returns a structured repair report, not a silent partial result. Publication is atomic: nothing is stored until the checks pass. This extends the honest-degradation rule in `docs/ANALYSIS-NORTH-STAR.md` and the existing "went unanswered" counter.

## 2. Claims next to evidence, with unknowns

Every AI-written sentence about code is a claim. Each claim should sit beside:

- **evidence**: the code regions it rests on (path and line range at the analyzed revision), checked mechanically for existence and for membership in the facts handed to the model;
- **unknowns**: what the facts did not settle, written next to the claim they limit (for example, "a file write exists here; durability is not established");
- **kind**: whether the thing is observed, configured, stubbed, or only declared. A configured provider, an injected adapter, a local stub and a durable service are different claims. A function exported but never called on any normal path is an optional capability, not a runtime edge.

A claim with no supporting evidence is rejected, not softened. A label, a package description or a config value never becomes an observed service. This builds on the grounding step and the stub and configuration rules already in the tighten pass, and adds the missing explicit unknowns and the mechanical check.

## 3. Analysis delta

A first-class comparison of two analyses of the same project: which capabilities, flows, steps, entities, seams and sub-projects were added, removed or changed, matched by stable identity, with a receipt naming both revisions. This serves pull-request review, Fabric (what a participant's in-flight work changes), and release notes. It reuses stable identifiers and the incremental machinery; the new part is the comparison and its review surface.

## 4. Reach and route as read operations

Two queries over the analysis graph, available through MCP and every client:

- **reach**: everything downstream (or upstream) of a step, flow or entity, with minimum depth per item and a hop bound recorded;
- **route**: the path or paths between two steps, with the evidence on each hop.

Results state their bounds so a reader knows when a result is complete. These are natural views for flow navigation and impact review.

## 5. Refresh keyed on cited evidence

An analysis refreshes a part only when something it cites changed: files added, removed or renamed, or a source that one of its answers rests on. Edits to prose, specs or documents that nothing cites cost nothing. The memo already keys on prompt content; the refinement is to key each answer on the evidence it used and to expose the reason a part refreshed. An optional repository hook on branch movement can trigger the check without polling.

## 6. Structure and status stay separate

The analysis states where a capability touches the code and how it is delivered. It does not state whether the work is planned, active or done; that belongs to whatever tracks work. Keep status fields out of capabilities, flows and entities.

## 7. A plain-file export

A documented export of an analysis as human-diffable Markdown or JSON files, with a written contract, so any agent or tool can read it without Klauro running. It also makes the analysis easy to attach to a ticket or review.

## 8. A public proof gallery

A gallery of navigable analyses of well-known open-source projects, each with its receipt and its evidence links, built from the existing corpus. It demonstrates the product, and it exposes weaknesses early.

## Order

1. The receipt (section 1): small, and it closes a real failure mode.
2. Claim unknowns and the mechanical evidence check (section 2).
3. Analysis delta (section 3).
4. Reach and route (section 4), then the export (section 7), then the gallery (section 8).
5. Evidence-keyed refresh (section 5) alongside the next incremental-analysis work.

## Open questions

- Where the receipt lives in the stored analysis and how it is versioned.
- Whether the unknowns are AI-authored, deterministic, or both.
- The identity scheme that survives renames for the delta.
