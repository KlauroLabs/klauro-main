# The Klauro analysis: north star

This document is the reference for what an analysis is, the order it runs in, what it produces, and what it must never do. Every other spec, every analyzer, and every release is measured against it. When a change and this document disagree, the change is wrong until this document is deliberately revised by the product owner.

## What an analysis is

An analysis turns one codebase into a complete, navigable understanding of the system: what it is for, how it is reached, what it does, what data it works with, how its parts connect, and where it reaches out. That understanding serves people at every level of an organization, AI coding agents, and the collaboration fabric. The output is the product. Nothing else the pipeline computes is the product.

## The flow

1. **Index the codebase once.** Read every source file one time and build the complete index: files, symbols, definitions, references, calls, imports, declarations, configuration, manifests, build and ship artifacts. Everything downstream runs from this index. The index must contain everything later stages need, so that no later stage goes back to the source. Going back to the code after the index is a defect to be removed, not a convenience to be kept.

2. **Identify deployables from the index.** Ship and run evidence (container definitions, entry commands, installers, compose files, binaries) defines the units. One deployable means a single analysis. Several means a monorepo, and the rest of the flow runs once per deployable.

3. **For each deployable, derive the structural layers from the index.** Entry points and exit points, each categorized by kind. Flows and the dependency chains between flows. Entities and their lifecycles. Domains. Design patterns and practices in use.

4. **Identify frameworks and libraries and run the framework layer.** This names the framework-specific elements (controllers, services, components, handlers, models) and, together with the patterns layer, exposes pattern deviation and framework sprawl. Those findings inform the analysis; they are not necessarily part of the output.

5. **Identify outcomes through terminality.** The flows at the end of a chain, or near the end, are the reasons the codebase exists. Executing a trade matters more than logging in. Terminal and proximal-terminal flows generate the candidate outcomes; the structural layers corroborate them.

6. **Establish the comprehension layer.** Capabilities, flows, steps, and entities, grounded in the layers above. This is where AI descriptions come in: one batched request per layer with the full evidence bundle, and a second pass only for items the first pass could not ground. AI interprets evidence; it never invents structure.

7. **At the workspace level, repeat the same shape over the member analyses** to produce the cross-repository picture.

8. **Overlay runtime telemetry last.** When the SDK is installed in a codebase, its runtime observations attach to the finished analysis as a real-time overlay. They enrich the output; they never gate it.

## What the output contains

Only what the product means to say:

- Identity: what was analyzed, when, and at what version.
- The system: purpose, domain, languages, frameworks, deployables.
- Entry points and exit points, categorized.
- The graph: code elements and the connections between them.
- Entities, their fields, relationships, and lifecycles.
- Capabilities, flows, and steps, with descriptions.
- Tests and what they cover.
- Change risk.
- Runtime observations when present.
- Honest degradation: which layers are ready, which are not, and why.

## What the output never contains

Internal decision-making, intermediate results, candidate lists, scoring scaffolding, fingerprints, phase timings, per-analyzer ledgers, caches, indexes built for the pipeline's own use, or any field whose only reader is another stage of the pipeline. Those live in internal state beside the analysis, and a build gate fails when one appears in the output.

## Speed

The analysis must be fast. Speed comes from the shape of the flow, not from tuning: read the code once, derive everything from the index, batch the expensive layers, and do no work whose result is not in the output. Every stage carries a measured budget, the budgets are release gates, and a stage that cannot meet its budget is cut or redesigned rather than tolerated.

## Working rules

- Support any codebase. Degrade honestly on what is not understood; never fabricate.
- Every fact is evidence-grounded. AI is a flavoring over deterministic structure.
- The spec of the output is this document plus the output type. Adding a field to the output requires a reader on a product surface and a line in this document.
- No client, benchmark, or corpus names anywhere in product source or specs.
