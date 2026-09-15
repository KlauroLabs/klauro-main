# The analysis MVP

What has to be true before this is worth putting in front of someone. Measured state as of
2026-09-15; every number here was taken this week and is reproduced in `ANALYSIS-NORTH-STAR.md` and
`ANALYSIS-PASS-STOCKTAKE.md`.

## The bar

An agent or a person, pointed at a repository they do not know, can find the right code and
understand how to reach it, faster and more reliably than by reading the repository. That is the
product. Everything else is an upsell on top of it.

## What already clears the bar

**Navigation.** The index is accurate: four TypeScript files missed of 3,743, none missed for Swift,
Kotlin, Go, Python or shell, and symbols matching the source line for line. Entry points attach to
the code they run, 438 of 471, and 343 reach the body of the system where 14 did before. Ask how to
get into a feature and the answer is nine commands with their handlers and file positions.

**Units.** Grouping entry points by what they reach recovers the real shape of a repository without
scanning for ship artifacts. It found an iOS application that artifact scanning missed entirely.

## What has to be done

**1. Scope every layer to a deployable.** Step 2 of the flow says a monorepo runs the rest of the
flow per deployable. It does not. A repository whose own `system.type` is `monorepo` still emits one
`codebase_type` of `cli` at 0.41 confidence and one `system_purpose` of `web-application` at 0.1,
which are the right answers to the wrong question averaged over fourteen things. Until this lands,
every field above it is answering at the wrong scope, and low confidence everywhere is the symptom.
This is the largest correctness item and nothing else should go first.

**2. Take the pipeline's internal state out of the output.** Roughly 25 of 115 fields are the
analysis talking about itself: stage timings, cache keys and hit rates, algorithm tuning parameters,
per-analyzer ledgers, and indexes built for our own use. They move to internal state stored beside
the analysis, where the incremental engine still reads them, and a build gate fails when one
reappears. Cheap, and it also removes the passes that exist only to produce them.

**3. Degrade out loud instead of silently.** Flows that can say what they do: 66% on a TypeScript
repository, 47% on a C one, 27% on another TypeScript one, and 1% on a Go service, which has 157
flows and two with an effect. Today those outputs look identical in shape. A consumer cannot tell a
well-understood repository from a barely-understood one. Every layer reports its own coverage, and a
layer below a threshold says so in the output rather than presenting thin results as complete.

**4. Mark effects that are not the flow's own.** 65 of 158 flows carrying effects have effects
identical to another flow, because an unresolved call leaves shared setup as the only path out of a
handler and whatever that setup reaches gets attributed to the command. The evidence to tell them
apart is already recorded, hop distance and whether the path crossed a shared helper. Use it: an
effect reached only through shared setup is reported as inherited, not as the flow's behaviour.

**5. A speed budget that is a release gate.** 43 s against a comparable tool's 5.7 s on the same
repository, with 70.9 s of CPU against 26.0 s and 1.64x parallelism against 4.58x. Three hypotheses
are already dead: regular expressions are 3.1 s, redundant traversals 3.8 s, and asynchronous
concurrency saves nothing because the analyzers are compute-bound. What remains is doing less, which
item 2 starts, and real threads, which the shared graph index now makes possible. Pick a number,
gate it, and let it force the choice.

## What is deliberately not in the MVP

**Outcomes from terminality.** It does not work and it is not a tuning problem. Ranking by
out-degree over a call graph finds the bottom of the graph, where the helpers live, so it reports
`loadConfig` and `Login` as the reasons a codebase exists. A call graph encodes uses, not then. This
needs a design, and the signal it should use is `effects`, which now exists.

**The comprehension layer.** Capabilities and AI descriptions come last, by instruction, and they
should: they interpret the layers below, and those layers are not yet worth interpreting.

**Workspace analysis and the telemetry overlay.** Both repeat or enrich a shape that is not yet
right for one repository.

**Type-aware call resolution as a default.** It doubled flows carrying an effect on TypeScript, 158
to 341, and costs about ten seconds. On a Go service it is pure cost. Make it conditional on the
repository being TypeScript-dominant before it ships on by default.

## The order

Items 1 and 2 are correctness and purity and go first, in that order. Item 4 is small and stops the
output being confidently wrong. Item 3 makes the remaining gaps legible instead of hidden, which is
what allows shipping before items outside the MVP are solved. Item 5 is gated last, because item 2
changes the number it measures.

## How it is measured

On at least four repositories across at least three language families, with the spread recorded
rather than the best case. Every figure in this document that was taken from one repository was
wrong about the others, which is why this rule exists.
