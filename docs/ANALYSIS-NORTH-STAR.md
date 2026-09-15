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

## Layer order, and what is built

The comprehension layer is last. Everything below it is deterministic and must stand on its own
before a model is asked to describe any of it.

| Step | Layer | State |
|---|---|---|
| 1 | Index the codebase once | Built. Extraction complete for code; configuration not indexed |
| 2 | Units, from the index | Built. `units` is derived from entry points grouped by the code they reach |
| 3 | Entry and exit points, flows, entities, domains | Built. Entry points attach to handlers; a flow is one behaviour with several effects |
| 4 | Frameworks and the framework layer | Runs, not re-examined this pass |
| 5 | Outcomes through terminality | Diagnosed, not fixed. Terminality ranks shared utilities; `effects` is the signal, and it covers 158 of 507 flows |
| 6 | Comprehension layer and AI descriptions | Last. Deliberately untouched |
| 7 | Workspace level | Not started |
| 8 | Telemetry overlay | Not started |

Step 2 is now answered from the index rather than by scanning for ship artifacts. `units` groups
entry points by the body of code they reach, so a unit is a set of ways in that land on the same
system. On the measured repository that produces a unit of 64,659 nodes with 342 entry points for
the gateway and its command line, an Apple unit of 5,479 holding macOS and iOS, an Android unit of
986, and a tail of single-entry islands that are build tooling. It finds the iOS application that
artifact scanning missed, and it needs no Dockerfile.

`deployable_evidence` stays, because ship and run artifacts are real evidence about how a unit is
delivered. It is no longer what defines a unit.

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

## Units fall out of the index

Once entry points attach to the code they run, grouping them by what they reach produces the units
without any artifact scanning. Measured on the same repository:

| Nodes reached | Entry points | Kinds | Where the code lives |
|---|---|---|---|
| 115,527 | 314 | 292 command line, 22 HTTP | `src`, the extensions, `openclaw.mjs` |
| 5,507 | 6 | command line, lifecycle, event | `apps/macos`, `apps/ios`, the vendored Swift package |
| 987 | 4 | page, event, lifecycle | `apps/android` |
| 294 and below | 1 to 2 each | command line, pipeline | `scripts`, `.github`, `skills` |

The shape is right. One large unit that is the gateway and its command line, an Apple platform unit,
an Android unit, and a tail of small islands that are build and CI tooling rather than products.

Three things to note. The Apple unit includes `apps/ios`, which artifact scanning missed entirely
because its Xcode project is generated rather than committed. The vendored Swift package groups with
the Apple applications rather than standing alone, which is evidence that it is reached by them and
may be a component rather than a separate unit; its own licence and changelog argue the other way,
and the question is now answerable from evidence instead of from a rule. And the noise separates
itself: build tooling lands in islands of tens of nodes with one entry point each, next to a unit of
115,527 nodes with 314, so size and entry point count discriminate without a path heuristic.

This is the frame working. Nothing here consulted a Dockerfile.

## Is the index accurate

Measured against the source on the same repository. The short answer is that extraction is sound and
linkage is not, which means the starting point is good.

**Code coverage is essentially complete.**

| Extension | On disk | Not indexed |
|---|---|---|
| `.ts` | 3,743 | 4 |
| `.swift` | 486 | 0 |
| `.kt` | 77 | 0 |
| `.sh` | 51 | 0 |
| `.go` | 14 | 0 |
| `.py` | 6 | 0 |

**Symbols match the source.** Spot-checking a 361-line test file against its 45 indexed nodes: all
five top-level constants at the right lines, all functions including three nested helpers, all three
imports, and 26 tests with their real names. Two blemishes, both in the same family: the callbacks
passed to `describe` are named by position, `test_callback_45_34`, so one block's name is lost, and
one node is attributed to line 1 instead of line 45.

**Configuration and documentation are not indexed.** 91 JSON files, 782 markdown files and 26 YAML
files produce no nodes. Skipping lock files is right. Skipping configuration is not, because step 1
says the index carries configuration and manifests, and later layers need them.

**Half of the index is not code.** 49% of nodes are analyzer observations rather than symbols, and
42,241 of those are library usage records. That is not inaccuracy, but it inflates the graph and
makes structure harder to see.

**Inline callbacks in production code are not extracted at all.** This is the refinement that
matters, and it changes the plan. Top-level declarations are captured faithfully. Functions passed
inline as arguments are not, outside of test files.

A worked example. `extensions/voice-call/src/cli.ts` registers nine commands, each in the shape
`root.command("continue").description(...).requiredOption(...).action(async (options) => { ... })`.
The index holds 61 nodes for that file. Four are code: two helpers, a type, and
`registerVoiceCallCli`, a single node spanning lines 44 to 276 that absorbs all nine command
handlers. Nine are imports. The remaining forty-odd are library usage observations, one per line,
outnumbering the real code ten to one. None of the nine `.action` closures is a node.

Across the repository, 3,339 function nodes carry positional names, and every one of them comes from
the test analyzer as a `describe` or `it` callback. Production callbacks get none. Of the 1,161
function nodes spanning more than a hundred lines, the largest is a single node covering 2,413 lines
of a test file.

So the handler of a command-line entry point is not a node, and cannot be linked to, because it does
not exist in the index. All nine entry points in that file also record line 1, so nothing positional
can recover it either.

The earlier statement that extraction is sound and only linkage is missing was too generous.
Extraction is sound for declarations and absent for inline handlers, which is precisely where
command-line and modern route handlers live. Linking entry points to implementations therefore
requires extracting those implementations first.

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

## Terminality, and why it does not yet produce outcomes

The outcome signal is `flows[].effects`, and it is now populated consistently: every flow that has a
terminus records it as an effect, not only flows that happened to be merged. On the measured
repository that is 158 of 507 flows:

| Effect kinds | Flows |
|---|---|
| none recorded | 349 |
| sdk | 88 |
| file | 23 |
| api | 23 |
| file and sdk | 16 |
| database and sdk | 4 |
| other combinations | 4 |

**349 flows record no effect at all, and that is the gap in step 5.** A flow is built from a call
chain that runs from an entry point to an exit point, so every flow ought to end somewhere. Two
thirds of them do not say where. Until that is closed, ranking flows by what they affect can only
speak for a third of them, and no ranking rule will rescue the rest.

So the order for step 5 is: find why two thirds of flows lose their exit, then rank by effect. Not
the other way round.

## Why two thirds of flows have no exit

Traced. It is not the flow layer and not the chain builder, both of which do the right thing. Chain
building starts from the linked handler, traverses call edges with no depth limit, and every one of
the 3,827 exit points resolves to a real node.

| | |
|---|---|
| Entry handlers | 420 |
| With any outgoing call edge | 259 |
| That reach an exit point | 75 |
| Distinct exit source nodes reached | 101 of 2,374 |

The calls that would carry a handler to its effect are not resolved. Worked example, a command
handler whose body is four lines:

```
.action(async (options) => {
  const rt = await ensureRuntime();
  const result = await rt.manager.continueCall(options.callId, options.message);
```

The edge to `ensureRuntime` exists, because it is imported directly and resolves by name. The edge
to `continueCall` does not, because reaching it means knowing what `ensureRuntime` returns, then
what `.manager` is on that, then finding the method on that type. `continueCall` is where the
behaviour actually happens, and it is invisible.

Every command in that file shows the same shape: one outgoing edge, to the imported helper, and
nothing to the work. So the chain runs one hop and dead-ends, which is why 384 chains are dead ends
and 313 entry points produce no entry-to-exit chain at all.

This is receiver type resolution, and it is the last structural gap before outcomes. It is a
designed piece of work rather than a fix: resolving a call through a value requires knowing the type
of that value.

## Every measurement on one repository is a measurement of that repository

The numbers in this document were taken from one 5,315-file repository, worked on for a day. Checked
against three others they do not hold:

| Repository | Flows | Carrying an effect | | Entities | Units |
|---|---|---|---|---|---|
| The one tuned against | 518 | 341 | 66% | 42 | 47 |
| A C codebase | 85 | 40 | 47% | 1 | 48 |
| A TypeScript monorepo | 243 | 65 | 27% | 56 | 5 |
| A Go service | 157 | 2 | 1% | 25 | 12 |

The Go service has 157 flows and two of them can say what they do. The type-aware call resolution
that took the tuned repository from 31% to 66% covers TypeScript and JavaScript only, so it does
nothing here. The C codebase reports 48 units for what is one product, which means unit derivation
fragments on a codebase whose call graph is shaped differently. It also reports a single entity for
6,091 nodes.

So the honest reading of the day's work is: one language family improved markedly, and the layers
above the index remain thin or wrong everywhere else. A measurement taken on the repository being
worked on is a measurement of that work, not of the analysis.

Every future change to these layers is measured on at least four repositories across at least three
language families before it is called an improvement, and the spread is recorded, not the best case.

## Receiver resolution: measured, built behind a flag, not enabled

The unresolved calls are not evenly distributed. Across 3,034 files and 193,888 extracted calls:

| Call shape | Count |
|---|---|
| Bare name, resolves today | 106,229 |
| Member call on a value | 57,715 |
| Receiver could not be named at all | 29,937 |

Of the member calls at depth two, most are not ours to resolve: 13,561 have an external import as the
base and 8,537 a language built-in. Only 2,735 base on an in-repo import. So the pool is far smaller
than the headline suggests, and volume is the wrong way to judge it.

Significance is the right way. In the worked file, every command handler makes exactly four calls:
an imported helper, a built-in log, a built-in serialise, and one method on a value. The last is the
only one that does anything, and it is the only one that fails.

The TypeScript compiler resolves those exactly. `rt.manager.continueCall` resolves to
`manager.ts:116`, with no name matching involved. Measured over the repository:

| | |
|---|---|
| Build the program | 2.1 s |
| Type checker | 0.7 s |
| Resolve 85,559 member calls | 2.5 s |
| Peak memory | 1.2 GB |
| Calls resolved to in-repo declarations | 6,920 |

It is implemented and tested, behind `KLAURO_TS_TYPE_RESOLUTION`, and it is off by default.

The first attempt looked far worse than it was. Node source paths are relative by the time they are
read, and `createProgram` resolves a relative path against the working directory, finds nothing, and
says nothing. It silently analysed a fraction of the repository. Resolving paths against the project
root and counting files that do not exist fixed it:

| | Before the path fix | After |
|---|---|---|
| Member calls seen | 46,237 | 148,863 |
| Resolved to in-repo declarations | 1,891 | 10,085 |
| Edges added | 362 | 1,258 |
| Added wall time | 11.6 s | 5.4 s |
| Peak resident memory | 3.0 GB | 1.87 GB, against 1.85 GB with it off |

The edges are the right ones. Every command handler in the worked file now reaches the method that
does its work: `continue` to `continueCall`, `speak` to `speak`, `end` to `endCall`, `status` to
`getCall`. Those edges did not exist in any previous run.

**And the flow layer is unchanged by it.** 507 flows, 158 with effects, 349 without, and the command
still reports the tunnel spawns. Entry-to-exit chains went from 590 to 597. The reason is that the
newly reached methods do not themselves reach a recorded exit point, so no chain forms through them
and the flow keeps the only chain it had.

So the gap has moved one level down rather than closed. It is no longer "the handler reaches
nothing". It is "the handler reaches its work, and the work reaches no recorded effect". That is the
next thing to measure, and it is a better question than the one before it.

Two further fixes finished it. Resolution was only being asked about member calls, so an aliased
import, `import { continueCall as continueCallWithContext }`, produced no edge at all; identifiers
now go through the checker too, which also corrects any bare call the name-based resolver got wrong.
And edges were being deduplicated by identifier rather than by the pair they connect, which added
23,060 duplicates of calls the graph already had.

Measured, on by default, with `KLAURO_TS_TYPE_RESOLUTION=off` as the escape hatch:

| | Off | On |
|---|---|---|
| Call edges | 36,443 | 46,833 |
| Duplicate call pairs | 0 | 0 |
| Entry-to-exit chains | 590 | 1,675 |
| Entry points with a chain | 158 | 341 |
| Flows carrying an effect | 158 of 507 | 341 of 518 |
| Wall clock | 35.3 s | 46.0 s |

Flows that can say what they do went from 31% to 66%. That is the step 5 gap more than halved, and
it is the reason this is on: the index must carry what the layers above need, and 10,390 of these
edges cannot be obtained any other way without guessing.

On whether TypeScript is the right tool for it: nothing else knows TypeScript's types. Reimplementing
that inference would mean reimplementing the language's type system, and the alternative that avoids
it, matching on bare names, is how a same-named function in an unrelated extension becomes a call.
The ten seconds is the price of edges that are correct rather than plausible. It is also why this
covers one language family only; every other language needs its own toolchain to answer the same
question.

## The missing edges do not only lose information, they misattribute it

Asked what the `continue` command does, the analysis answers: spawn, four more spawns, and a step
called "Get Tailscale Dns Name". The command actually continues a voice call. The tunnel spawning
belongs to a different command in the same file.

This follows from the same missing edge. The call that does the work is unresolved, so the only path
the chain builder can follow out of the handler runs through shared runtime setup, and whatever that
setup eventually reaches gets attributed to the command. Nine commands in that file are given the
same five effects, none of which are theirs.

Across the repository, 65 of the 158 flows that carry effects have effects identical to another
flow. Some of that is legitimate, two commands that both persist the same file genuinely share an
effect. Much of it is this.

So the honest count is not "158 flows describe their behaviour and 349 are silent". It is closer to
93 flows describing their own behaviour, 65 describing somebody else's, and 349 saying nothing. A
flow that says nothing is a gap. A flow that confidently reports the wrong effect is a defect, and
it is the more expensive of the two because a reader cannot tell which they are looking at.

This raises the priority of receiver resolution from "completes the outcome layer" to "stops the
output being wrong", and it argues for a second rule: an effect reached only through shared setup,
with no resolved call of the flow's own in between, is not evidence about that flow.

One caution found while tracing. A helper in one extension resolved its call to a function of the
same name in an unrelated extension. Bare-name matching across module boundaries produces edges that
are confidently wrong, which is the failure mode of resolving more calls carelessly. Whatever closes
this gap has to be type-aware rather than name-aware, and the existing cross-module edges deserve
their own audit.

Terminality was being computed over every node and every edge type. 110,937 of 136,928 nodes came
back terminal, led by class properties with over a thousand incoming edges each. Scoping it to
executable code joined by invocation edges brings it to 28,009 members, and the things at the end of
chains are functions rather than fields. Deriving flow chains from the call graph takes flows from
939 terminal and none proximal to 798 and 141.

Both are improvements and neither produces outcomes. Here is what comes out on top:

| Rank by | Result |
|---|---|
| Terminal executable nodes, most callers | `loadConfig`, `logVerbose`, `danger`, `errorShape` |
| Terminal flows, most callers | `Login`, `Add`, `Get`, `Clear` |

Those are shared utilities. Ranking by out-degree over a call graph finds the bottom of the graph,
and the bottom of a call graph is where the helpers live. `Login` coming out on top is the exact
inversion the north star warns about, arrived at honestly.

The reason is that a call graph encodes *uses*, not *then*. "A calls B" does not mean B happens
after A in the sense that matters; it means A depends on B. A chain of flows in the product sense is
a sequence of things the system does, and its end is an effect on the outside world.

That effect is already recorded. 590 of 939 flows carry a `terminus` naming the exit point they end
at, and the kinds are exactly the vocabulary of outcomes:

| Terminus kind | Flows |
|---|---|
| sdk | 389 |
| file | 78 |
| database | 71 |
| api | 52 |

## Flows are entry points crossed with exit points

The blocking defect sits above terminality. A flow is currently one path from an entry point to one
exit point, so a single command becomes as many flows as it has reachable effects.

On the measured repository, `Call (voice call)` appears five times, identical except for the
terminus: `runNgrokCommand`, `runTailscaleCommand`, `startNgrokTunnel`, `startTailscaleTunnel`,
`stopTailscaleTunnel`. `Search (database)` appears 48 times, `Run (cli)` 30, `Status (cli)` 29. In
total 939 flows carry only 512 distinct names, and 124 of those names are duplicated.

That is why 471 entry points produce 939 flows, and it undermines every layer above. Terminality
ranks duplicates against each other, capability naming sees the same behaviour repeatedly, and a
reader is shown one command five times.

A flow should be a coherent unit of behaviour with one entry and possibly several effects, rather
than the cross product of the two. Fixing that comes before outcomes are worth computing.

## The index records the shape of the code, not the shape of the data

This is the gap under every comprehension failure, and it is one gap rather than several.

The comprehension layer is capabilities, flows, steps and entities. Three of those four are about
data: an entity is a named thing with fields, a step's contract is what it takes and returns, and an
outcome is data landing somewhere outside the system. The index holds almost none of it.

| | |
|---|---|
| Property nodes | 19,474 |
| Classes and interfaces | 1,034 |
| Classes or interfaces that reach their own properties | **0** |
| `has_field` edges in the whole graph | 49 |
| `data_lineage` records | 42 |

Properties are attached to the file that contains them, 17,339 by a `contains` edge from a file
node. So the index can answer "this file declares a field called `text`" and cannot answer "`HookJob`
has a field `text`". The type and its fields are both present and unconnected.

Type annotations exist as strings on function signatures, 23,635 of 27,931 code nodes, but they are
TypeScript's alone: 9,232 return types of 23,551 TypeScript nodes against 0 of 3,501 Swift and 0 of
586 Kotlin.

Everything downstream follows from this:

- **Entities cannot be derived from the index**, so extraction falls back to regular expressions over
  declarations that happen to carry an explicit field list. That is why all 42 entities on a
  5,315-file repository are third-party wire formats and the system's own nouns are absent.
- **A step has no real contract**, because what a flow takes and returns is not in the graph.
- **An outcome cannot be recognised by what data it moves**, leaving out-degree over a call graph,
  which finds helpers.
- **What a system is for falls back to scoring keywords**, because there is no domain model to reason
  from, and the confidence number is what that guess looks like when written down.

The requirement was stated at the outset: the index must contain everything later stages need. It
contains what the code is made of. It does not contain what the system's data is made of, and the
comprehension layer is mostly a statement about data.

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
