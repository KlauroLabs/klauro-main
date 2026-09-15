# The analysis MVP

Derived from the stated purpose: **the whole point of the analysis is to build the index and the
comprehension layer.** Everything here is either one of those two or a link in the chain between
them. Measured state as of 2026-09-15.

## The chain, and where it breaks

The flow is seven steps and each one feeds the next. An honest reading of where each stands:

| Step | State |
|---|---|
| 1. Index the codebase once | Works for code. Configuration and manifests are not indexed |
| 2. Deployables, then everything per deployable | Deployables detected, the split is **not implemented** |
| 3. Entry and exit points, flows, flow chains, entities, domains, patterns | Entry and exit points work. **Entities are wrong. Flow chains do not exist** |
| 4. Frameworks and the framework layer | Runs, never examined |
| 5. Outcomes through terminality | **Produces helpers, not outcomes** |
| 6. Comprehension layer | Cannot be judged until 3 and 5 are real |
| 7. Workspace level | Not started |

The MVP is steps 1 through 6 producing something true. Not a subset of them shipped early with the
rest labelled partial. Reporting coverage honestly is worth doing, but it describes the hole rather
than filling it, and on its own it is a way of shipping without fixing anything.

## What has to be done

### 1. Entities are the wrong things entirely

42 entities on a 5,315-file repository, and every one is a wire format from a third-party
integration: `FeishuMessageEvent`, `TwitchChatMessage`, `ZaloMessage`, `TelnyxEvent`,
`MattermostPost`, `BlueBubblesAttachment`. The system's own nouns, session, agent, conversation,
call, skill, channel, are absent. Another repository reports a single entity for 6,091 nodes.

The material is in the graph: 574 DTOs, 2,380 types, 909 classes, 125 interfaces, and 730 domain
concepts that are much closer to the real nouns. Selection is picking payload shapes because they
carry explicit field lists, which is a proxy for being easy to extract rather than for mattering.

Entities are one of the four things the comprehension layer is made of. Nothing above this is
trustworthy until it is fixed, and no amount of interpretation repairs a wrong noun list.

### 2. Flows have no chains, so there are no outcomes

Terminality over flows reports every flow as terminal and none as proximal, because there are no
flow-to-flow edges at all. The four things that could produce them all depend on capabilities, which
do not exist without the model, so the deterministic path produces nothing.

Terminality over nodes, which does have edges, ranks `loadConfig` and `Login` as the reasons a
codebase exists, because ranking by out-degree over a call graph finds the bottom of the graph where
the helpers live. A call graph encodes uses, not then.

Step 5 is where outcomes come from and step 5 currently cannot work. This needs the flow-chain
relation designed, not tuned.

### 3. Delete the keyword scorers, do not rescope them

`codebase_type` is `cli` at 0.41 confidence while `system_purpose` is `web-application` at 0.1, in
the same output, on a repository whose own `system.type` is `monorepo`. These are not fields that
need per-deployable scoping. They are a keyword scorer standing in for the comprehension layer,
answering an interpretive question with a deterministic mechanism, which is the mistake the doctrine
already forbids.

The deterministic layers produce traits. What a system is and what it is for comes from the
comprehension layer, over those traits, per deployable. The confidence number is the tell: a real
answer cites evidence, it does not carry a probability.

### 4. Everything after step 2 is per deployable

Not for its own sake, but because the comprehension layer cannot describe fourteen things at once.
A capability belongs to a deployable. So does an entity, a flow, and a purpose. The split is the
precondition for step 6 saying anything true, which is why it is here rather than in a later phase.

### 5. The index carries what the layers need

91 JSON files, 26 YAML files and every manifest are absent from the index, so layers that need
configuration go back to the filesystem for it, which is the thing the first step exists to prevent.
The test is that the whole chain from deployables to comprehension can run with the source files
deleted.

### 6. Then the comprehension layer, and only then

Capabilities, flows, steps and entities, batched per layer with the full evidence bundle, one retry
for anything that cannot be grounded. It comes last in the order and it is the point of the
exercise, not an optional upper tier. It is also the only thing that can answer what a system is
for, which is why item 3 deletes the stand-in rather than repairing it.

## Not in the MVP

Workspace analysis and the telemetry overlay. Both repeat or enrich a shape that has to be right for
one repository first.

## Speed

43 s against a comparable tool's 5.7 s on the same repository. Three explanations are already dead:
regular expressions are 3.1 s, redundant traversals 3.8 s, and asynchronous concurrency saves
nothing because the analyzers are compute-bound. What is left is doing less and real threads.

Items 1, 2 and 3 all delete work rather than adding it, so the speed number is taken again after
them, not before. A budget set now would be measuring a pipeline that is about to change shape.

## How it is measured

At least four repositories across at least three language families, spread recorded rather than best
case. Every figure taken from a single repository this week was wrong about the others.
