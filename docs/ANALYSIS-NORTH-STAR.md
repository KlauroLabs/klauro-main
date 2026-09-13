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

The 14 is itself too many, which is a second finding and a separate defect. Eight of the fourteen
are not products:

| Unit | Evidence | Verdict |
|---|---|---|
| `cleanup-smoke`, `install-sh-smoke`, `install-sh-e2e`, `install-sh-nonroot` | Dockerfiles under `scripts/docker/`, entrypoints named `openclaw-*-smoke` and `openclaw-install-*` | Test rigs |
| `e2e`, `qr-import` | Dockerfiles under `scripts/e2e/`, one with entrypoint `["bash"]` | Test rigs |
| `sandbox-common` | `Dockerfile.sandbox-common`, only `FROM ${BASE_IMAGE}`, no entrypoint | Base image fragment |
| `release.md` | `docs/platforms/mac/release.md`, classified as an installer | A markdown runbook |

The `release.md` case is the worst of them. It is a release procedure written in prose, read as an
installer, and its extracted binary list is English words lifted from the sentences: `Cutting`,
`validating`, `Updating`, `assets`, `now`, `must`, `to`, `private`, `check`, `We`, `your`, `keep`,
`also`, `when`, `verify`, `raw`, `an`, `attached`. That reaches the customer's output.

The discriminators are present in the evidence already and are not being used: a `scripts/` path, a
name carrying `smoke`, `e2e` or `test`, an entrypoint of `["bash"]` or `["sleep", "infinity"]`, a
Dockerfile with no entrypoint at all, and a `.md` extension on something claiming to be an installer.

Deployable tiering already demotes internal packages correctly, 43 of them to tier 3, so the
mechanism exists. It does not distinguish a container that ships from a container that exists to run
a test, and a false positive here is not one wrong row. Because step 2 sets the scope for everything
after it, each phantom product becomes a full analysis of something that does not exist.

## What counts as a deployable

A deployable is a unit of distinct behaviour that somebody runs. It is not a build artifact, and it
is not every thing with a manifest. Three tests, in order.

**Does it have its own entry points and flows?** This is the one that matters, because the whole
point of the split is that each deployable gets its own analysis. A command-line tool built for
macOS, Windows and Linux from one source tree has one set of entry points and one set of flows: it
is one deployable with three build targets, and analysing it three times would produce the same
answer three times. An iOS app and an Android app have separate source trees, separate lifecycles
and separate entry points, so they are separate deployables even though they are the same product to
a customer. The rule is one deployable per distinct behaviour, not per artifact.

**Does anyone outside get it?** If the product builds and runs the thing itself, it is a component,
not a deployable. Image inheritance is evidence of this and is currently ignored: on the measured
repository, `Dockerfile.sandbox-common` begins `ARG BASE_IMAGE=openclaw-sandbox` and derives from
the sandbox image, and both were still reported as independent ship units. A container that another
container in the same repository is built `FROM` rolls up into it.

**Does it have its own identity?** Its own licence, changelog, version and dependency set, and its
own release path. A vendored sibling project inside a monorepo passes this test and is a separate
deployable even though it shares the repository.

Applied to the measured repository, the fourteen reported units are not units of behaviour at all.
They are one packaging of the main system, two runtime environments it builds and runs, one build
layer whose Dockerfile is a single `FROM` line, six test harnesses, one documentation file, and
three applications. Every one of them was identified by a file pattern rather than by anything it
does.

The decisive evidence that the frame is wrong is not the false positives but the false negative.
`apps/ios` is a real iOS application with sources, tests, a fastlane configuration and an XcodeGen
`project.yml`. Artifact scanning found nothing there, because the Xcode project is generated rather
than committed and there is no `Package.swift`. Grouping by entry point finds it immediately: two
entry points, a lifecycle and an event. Scanning for ship files invented six test rigs, promoted a
markdown runbook, split one product into four container entries, and missed an entire application.

Grouping the 471 entry points by where they live recovers the real shape: 329 in `src` for the
gateway and its command line, then `apps/android`, `apps/macos`, `apps/ios`, a vendored Swift
package, and a set of extensions each with their own way in. It also shows why artifact scanning
drowned: `scripts` holds 74 entry points and `.github` holds 18 pipelines, so those directories are
full of genuinely executable things that are simply not the product.

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

## The measured state of the index

Working from endpoints through the index is the right frame, and it cannot run today. Measured on
the same 5,315-file repository:

| | |
|---|---|
| Nodes | 134,921 |
| Edges | 195,813, of which 1,196 dangle |
| Call edges that cross a file boundary | 20,820 of 36,443, 57% |
| Entry points | 471 |
| Entry points that appear anywhere in the call graph | 322 |
| Components those 322 are spread across | 83 |
| Entry points reaching the main body of the code | 14 |

The call graph is not the problem. Edges resolve, and most calls cross a file boundary, so
cross-module resolution works. The problem is that **entry points are not attached to it.**

149 of the 471 entry points appear nowhere in the call graph, including 72 under `scripts`, all 22
commands and all 17 pipelines. Of the 322 that do appear, 308 sit in 82 islands of between three and
twenty-four nodes. One component holds 17,241 nodes, the main body of the system, and exactly 14
entry points reach it, all of them HTTP. Every one of the 359 command-line entry points, the largest
category by far, is stranded in an island.

So nothing can walk from an endpoint to what it does. That single fact explains the rest of the
output: terminality finds four signals because there are no chains to sit at the end of, flows are
shallow, entities number 42 for 5,315 files, and system purpose falls back to scoring keywords
because there is no structure to reason from.

On top of that the published `reachability_index` is degenerate in its own right: 20,327 components
over 20,455 nodes, roughly one component per node, while the edges it should have been built from
support a 17,241-node component. That is a second defect and it is not the cause of the first.

The work is therefore: attach entry points to the code they run, for every entry point kind and not
just HTTP, and rebuild reachability from the edges that already exist. Deployable detection,
subsystem detection and terminality all become derivable once an endpoint can reach its own
implementation. Until then they are being computed from a graph that cannot answer the question.

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
