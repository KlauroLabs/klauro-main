# The analysis MVP

The specification already exists: `docs/cas/SPECIFICATION.md`, `docs/COMPREHENSION-LAYER.md`,
`docs/COMPREHENSION-FRAMEWORK.md`. This is not a new design. It is the list of places the
implementation does not do what those documents already say, and the order to close them in.

MVP is: **Tier 1 and Tier 2 complete enough that Tier 3 is true, for one deployable, fast.**

## Step 1 — Establish ground truth by hand, first

Nothing below can be judged without a target. Take three codebases of different shapes and languages
and produce the Tier 3 output manually: the capabilities, the flows, the steps, the entities. Record
how long it took, how many files were opened, and what was needed to be confident.

That gives three things the project does not have: a correct answer to compare against, a cost
baseline the automated analysis has to beat, and a concrete sense of which facts a human actually
used to reach the answer, which tells us what Tier 1 must carry.

The audience and universality tests in `COMPREHENSION-LAYER.md` are the acceptance criteria. They
are already written and already sharp.

## Step 2 — Audit Tier 1 against the specification, not against intuition

Tier 1 is defined as nodes, edges, entry and exit points, and the six ICELOT facets. Known gaps:

- **The data model is absent.** 19,474 property nodes, 1,034 classes and interfaces, and zero types
  that reach their own fields. `has_field` is 49 edges in the whole graph. Entities are a Tier 3
  member and their substrate is not there.
- **Type information is one language deep.** 9,232 return types across 23,551 TypeScript nodes, and
  zero across 3,501 Swift and 586 Kotlin nodes.
- **Configuration and manifests are not indexed.** 91 JSON, 26 YAML, every manifest.
- **ICELOT** needs checking facet by facet. Input, Constraints, Effects, Logic, Output and Telemetry
  are specified at code-unit, step and flow granularity; what is actually produced is unmeasured.

The rule to test against is the spec's own: a tier may consume any tier below it and must not read
source after Tier 1. The test is that Tiers 2 and 3 run with the source files deleted.

## Step 3 — Derive Tier 3 per deployable

The flow says a monorepo runs the analysis per deployable, and it does not. A capability belongs to
a product, not to a repository. This is the precondition for Tier 3 meaning anything on any
repository that ships more than one thing, and it is also why confidence numbers appear: an answer
averaged over fourteen products cannot be stated plainly, so it gets a probability attached instead.

## Step 4 — Capabilities by derivation, with the model authoring language only

Terminality and proximal terminality identify which flows are the reason the codebase exists. That
is a derivation over facts, not a guess, and it is the step that currently does not work: flows have
no flow-to-flow edges at all, so every flow reads as terminal, and node-level terminality ranks
helpers because out-degree over a call graph finds the bottom of the graph.

Fix the flow-chain relation first. Then the model names and describes what the derivation selected,
per the four-member model and the naming rules already specified. No confidence scores, no
candidates, no approval cycle: the derivation decides what is a capability, the model says it in
product language.

## Step 5 — Entities from the domain model

Currently 42, all third-party wire formats, because selection falls back to whatever declarations
carry a parseable field list. With Step 2 done the domain model is in the index and entities become
a derivation over it rather than a regular expression over source.

## Step 6 — Speed parity on Tiers 1 and 2

43 seconds against 5.7 for a comparable indexer on the same repository. Tiers 1 and 2 are
deterministic and should match that class of tool; AI enrichment is the only stage allowed to cost
real time. Dead ends already measured, so they are not re-tried: regular expressions are 3.1 s,
redundant traversals 3.8 s, and asynchronous concurrency saves nothing because the analyzers are
compute-bound. What is left is doing less and real threads.

Measured after Steps 2 through 5, because three of them change what runs.

## Deliberately not in the MVP

Patterns, idioms, test coverage, security boundaries, module health, change risk and the telemetry
overlay. All of them belong in the product and all of them are additive once Tier 3 is solid.

Workspace level. The spec's derivation gradient makes it cheap once a leaf is correct, and
worthless before that.

## What the product is

The whole thing, with filterable access: the graph, the semantic layer, and the comprehension layer,
queryable in sections through the existing APIs and MCP endpoints. Fabric depends on all of it. The
MVP narrows what has to be *correct* first, not what ships.

## How it is measured

Against the hand-built ground truth from Step 1, on at least four repositories across at least three
language families, with the spread recorded rather than the best case. Every number taken from a
single repository this week was wrong about the others.
