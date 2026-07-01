# Klauro Analysis Flow

Klauro analysis is one product workflow with multiple states. It is not a choice between local analysis and remote analysis. The customer experiences Klauro as a single analysis system that can understand committed code, already-analyzed code, and in-flight work before it lands in Git.

## Core Idea

Git is excellent at durable history, but it only helps after work is committed, pushed, rebased, or merged. Modern software work, especially agentic work, needs visibility earlier than that. Multiple humans and agents can be changing the same system at the same time. They need to know:

- what already exists;
- what is already analyzed on the selected branch;
- what another developer or agent is currently changing;
- whether their planned work overlaps, duplicates, or conflicts with that in-flight work;
- how to extend the existing system without rebuilding what someone else is already building.

Klauro should make that visible before Git can. This is the collaboration layer: realtime enough to prevent duplicate work and merge pain, asynchronous enough that teams can filter by branch, author, workspace, confidence, or status.

## Analysis States

### Cold Analysis

Cold analysis starts when Klauro has not yet analyzed the project or workspace state.

Examples:

- a new customer runs `klauro init` in a repo for the first time;
- a connected Git repository is imported for the first time;
- a new workspace is created from a folder that contains multiple repos;
- a greenfield proposal or empty-folder build creates its first real files.

The result is a normal Klauro CAS or WAS output. Some phases may run from the installed client, some may run in Klauro-hosted services, and AI enrichment must run through Klauro-managed providers. The implementation split is not exposed as separate products.

### Warm Understanding

Warm understanding starts from an existing analysis.

Examples:

- an agent asks MCP for a agent context before editing;
- a human opens the UI to inspect a project or workspace;
- an agent asks for idioms, invariants, tests, risks, capabilities, entities, call chains, or workspace relationships;
- a teammate asks what changed between analyzed revisions.

Warm queries should avoid broad source rediscovery. They should retrieve the smallest useful slice of CAS/WAS, plus follow-up tool calls for drilldown.

### In-Flight Analysis

In-flight analysis represents work that is not yet durable project truth.

Examples:

- uncommitted working-tree changes;
- a local branch that has not been pushed;
- a pushed branch that is not the selected mainline;
- an agent session making edits across copied or sandboxed workspaces;
- a teammate's active feature branch;
- a multi-agent plan where several agents are implementing adjacent slices.

In-flight analysis is not "local-only." It can be published to Klauro as provisional context so other authorized users and agents can see that work is coming. It should be clearly marked as in-flight, scoped by workspace/project/branch/author/session, and excluded from durable project truth until it becomes a committed analyzed revision.

The MCP must treat in-flight context as advisory but actionable:

- warn when a requested task overlaps with another in-flight change;
- suggest extending another branch/session instead of duplicating work;
- identify likely merge conflicts before Git sees them;
- show which capabilities, entities, routes, tests, files, contracts, and workspace links are being touched;
- allow teams to filter in-flight work by branch, author, agent, confidence, recency, or status;
- keep durable CAS/WAS separate from provisional facts while allowing both to inform agent contexts.

## Product Tracks

Every Klauro-aware agent session should be able to reason over three tracks:

| Track | Meaning | Product Role |
| --- | --- | --- |
| Durable analyzed track | Selected branch or committed tree that Klauro has accepted as project/workspace truth | UI default, baseline CAS/WAS, normal MCP orientation |
| In-flight track | Provisional local/branch/session changes that have been analyzed but not accepted as durable truth | Deduplication, soft merge, overlap detection, active collaboration |
| Incoming track | Remote analyzed revisions that exist but are not in the user's current checkout | Pull/rebase awareness, conflict avoidance, branch drift detection |

These tracks are not separate products. They are states inside the Klauro analysis flow.

## MCP Behavior

The MCP should expose the unified Klauro picture without forcing agents to understand implementation mechanics.

Before editing, a agent context should include:

- durable target context from CAS/WAS;
- relevant in-flight overlaps and adjacent work;
- incoming analyzed changes that may affect the task;
- repo-local idioms, invariants, tests, risks, and expected validation;
- branch/session confidence and provenance for any provisional facts.

After edits, MCP validation should:

- analyze the new in-flight state;
- compare it to durable project truth;
- compare it to other visible in-flight work;
- flag duplicate capabilities, duplicate entities, conflicting contracts, overlapping migrations, and likely merge pressure;
- recommend whether to continue, split, coordinate, or commit.

## UI Behavior

The UI primarily shows durable project and workspace truth, because that is what the team has accepted. It should also be able to overlay in-flight work when useful:

- activity view: active branches, agents, authors, and impacted areas;
- project/workspace graph: provisional changed nodes and edges;
- capability/entity drilldown: who is touching this, where, and why;
- soft-merge view: overlap, conflicts, and duplicate-work warnings;
- branch filters: mainline only, branch, author, session, agent, or all in-flight work.

The UI must make provisional status visually and semantically obvious. In-flight facts are useful because they are early, not because they are final.

## Gauntlet Bar

The gauntlet must test Klauro the way customers use Klauro.

It should exercise:

1. **Cold product analysis:** initialize a real repo or workspace, submit or connect source, generate CAS/WAS, and verify accurate descriptions, capabilities, entities, architecture, risks, idioms, and MCP readiness.
2. **Warm understanding:** query the already-analyzed project through MCP and verify that agents get compact, useful context without rediscovering the source tree.
3. **In-flight analysis:** make realistic uncommitted or branch changes, publish/analyze them as in-flight Klauro context, and verify that MCP agent contexts explain impact, risk, tests, idioms, and overlap.
4. **Collaboration collision:** create two simultaneous agents or branches that target adjacent or overlapping behavior. Klauro must warn about duplicate work, conflicting files/contracts/migrations, and likely merge pressure before commit.
5. **Incoming change awareness:** analyze a remote/other-branch revision that the local checkout does not yet have. MCP must warn the local agent before it builds against stale assumptions.
6. **Quality, token, and speed proof:** measure whether agents using Klauro finish faster, use fewer tokens or only a tiny quality-justified token increase, and produce changes that better match the codebase's architecture, patterns, idioms, and current in-flight work.
7. **Workspace proof:** repeat the same flow across multi-repo workspaces, where in-flight changes in one repo can affect APIs, messages, SDKs, deployables, infrastructure, or downstream apps in another.

Passing the gauntlet means the installed Klauro product path produces one coherent analysis experience across cold, warm, durable, incoming, and in-flight states. It does not mean a dev harness ran a partial analyzer in isolation.

## Why This Matters

The value is larger than code search, indexing, or static visualization.

Klauro should make software teams and AI agents aware of the system before, during, and after a change:

- before: understand what exists and where the right change belongs;
- during: see other in-flight work and avoid duplication or conflict;
- after: turn committed work into durable shared project truth.

That loop can reduce merge conflicts, duplicate implementations, agent drift, onboarding time, token use, and architecture erosion. It is the product foundation for AI-era software collaboration.
