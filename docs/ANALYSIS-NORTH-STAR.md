# The Klauro analysis: north star

This document is the reference for what an analysis is, the order it runs in, what it produces, and what it must never do. Every other spec, every analyzer, and every release is measured against it. When a change and this document disagree, the change is wrong until this document is deliberately revised by the product owner.

## What an analysis is

An analysis turns one codebase into a complete, navigable understanding of the system: what it is for, how it is reached, what it does, what data it works with, how its parts connect, and where it reaches out. That understanding serves people at every level of an organization, AI coding agents, and the collaboration fabric. The output is the product. Nothing else the pipeline computes is the product.

## The flow

1. **Index the codebase once.** Read every source file one time and build the complete index: files, symbols, definitions, references, calls, imports, declarations, configuration, manifests, build and ship artifacts. Everything downstream runs from this index. The index must contain everything later stages need, so that no later stage goes back to the source. Going back to the code after the index is a defect to be removed, not a convenience to be kept.

2. **Identify deployables from the index.** Ship and run evidence (container definitions, entry commands, installers, compose files, binaries) defines the units. One deployable means a single analysis. Several means a monorepo, and the rest of the flow runs once per deployable.

3. **For each deployable, derive the structural layers from the index.** Entry points and exit points, each categorized by kind. Flows and the dependency chains between flows. Entities and their lifecycles. Domains. Design patterns and practices in use.

4. **Identify frameworks and libraries and run the framework layer.** This names the framework-specific elements (controllers, services, components, handlers, models) and, together with the patterns layer, exposes pattern deviation and framework sprawl. Those findings inform the analysis; they are not necessarily part of the output.

5. **Identify outcomes through terminality.** The flows at the end of a chain, or near the end, are the reasons the codebase exists. Executing a trade matters more than logging in. Terminal and proximal-terminal flows generate the outcomes; the structural layers corroborate them.

6. **Establish the comprehension layer.** Capabilities, flows, steps, and entities, grounded in the layers above. This is where AI descriptions come in: one batched request per layer with the full evidence bundle, and a second pass only for items the first pass could not ground. AI interprets evidence; it never invents structure.

7. **At the workspace level, repeat the same shape over the member analyses** to produce the cross-repository picture.

8. **Overlay runtime telemetry last.** When the SDK is installed in a codebase, its runtime observations attach to the finished analysis as a real-time overlay. They enrich the output; they never gate it.

## What scopes to what

This is the rule the implementation keeps losing, so it is written out rather than implied by
step 2.

**Everything from step 3 onward is a property of a deployable, not of the repository.** What kind of
thing this is, what it is for, what it can do, who reaches it, what data it owns: those belong to a
deployable. A repository is a container for deployables and has no purpose of its own.

For a repository with one deployable the two coincide, and the distinction costs nothing. For a
repository with several, the only honest repository-level answer is the list: this is a monorepo of
N deployables, and here is what each one is. An average across them is not a weaker answer, it is a
wrong one.

The measured failure, on a real 5,315-file repository: the analysis correctly set `system.type` to
`monorepo` and identified 14 top-level ship units, then produced a single analysis with one
`codebase_type` of `cli` at 0.41 confidence and one `system_purpose` of `web-application` at 0.1.
Both are defensible for some of the 14 and right for none of the whole. Low confidence everywhere is
the signature of this mistake: the layers are being asked a question at the wrong scope.

The 14 is itself too many, which is a second finding and a separate defect. Six of them are test
infrastructure: four containers under `scripts/docker/` named after install and cleanup smoke tests,
and two under `scripts/e2e`. One is a markdown file, `docs/platforms/mac/release.md`, classified as
an installer. The real count is closer to four or five. Deployable tiering already demotes internal
packages correctly, 43 of them to tier 3, so the mechanism exists; it just does not distinguish a
container that ships from a container that exists to run a test.

## Deterministic traits, interpreted purpose

The deterministic layers produce **traits**: ship and run artifacts, entry and exit points, symbols,
calls, imports, manifests, languages, what is reachable from what, which flows sit at the end of a
chain. Traits are facts about the code and are not negotiable.

**What something is for is an interpretation, not a trait.** It is the model's job, over the traits,
per deployable. Scoring keywords to pick a `system_purpose` is answering an interpretive question
with a deterministic mechanism, which is the same mistake as hardcoding a categoriser: it produces a
confident-looking label with no reasoning behind it and no way to be wrong out loud.

The split is therefore: deterministic layers establish what is there, the model says what it means,
and every claim it makes traces back to a trait.

## What the index must carry

The index is early and everything descends from it, so its contract is defined by what the layers
above need, not by what is convenient to extract.

Each downstream layer declares what it requires from the index. When a layer needs something the
index does not hold, the index gains it. A layer going back to the source is a defect in the index,
not a shortcut in the layer. The test of the index is that the entire chain from deployables to the
comprehension layer can run with the source files deleted.

## What the output contains

Everything the analysis determines about the codebase. A finding stays in the output whether or not a product surface displays it today; the absence of a page is not evidence that a fact is worthless.

What the output never contains is the pipeline talking about itself: intermediate steps, candidate lists awaiting approval, scoring scaffolding, algorithm tuning parameters, cache keys and hit rates, our own stage timings, per-analyzer ledgers, and indexes built for our own use. Those live in internal state stored beside the analysis, where the incremental engine and caches still read them. A build gate fails when one appears in the output.

The field-by-field stocktake, with the reason each field exists and its verdict, is in `ANALYSIS-OUTPUT-STOCKTAKE.md`. That document and the output type together are the contract. Adding a field requires a line in the stocktake saying what it tells a customer about their code.

## Capabilities

Capabilities come from terminality. The terminal and proximal-terminal flows, entities and outcomes are submitted to the model as one batched request, and the capabilities come back. Validation is light: names must be authored, claims must trace to evidence. There is no candidate stage, no approval cycle, and no repair loop, and no intermediate capability artifact reaches the output. Deterministic validation of an interpretive result buys very little and costs a great deal.

## Speed

The analysis must be fast. Speed comes from the shape of the flow, not from tuning: read the code once, derive everything from the index, batch the expensive layers, and do no work whose result is not in the output. Every stage carries a measured budget, the budgets are release gates, and a stage that cannot meet its budget is cut or redesigned rather than tolerated.

## Working rules

- Support any codebase. Degrade honestly on what is not understood; never fabricate.
- Every fact is evidence-grounded. AI is a flavoring over deterministic structure.
- The spec of the output is this document, the stocktake, and the output type. A new field must state what it tells a customer about their code.
- No client, benchmark, or corpus names anywhere in product source or specs.
