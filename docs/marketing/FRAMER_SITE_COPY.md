# Klauro Framer Site Copy

This is the current Framer-ready marketing site source of truth. It should replace older Unravl/PoC language and avoid describing stale API, auth, or legacy web surfaces as current product.

## Positioning

Klauro is the codebase intelligence layer for AI-built software. It analyzes the real domains, flows, architecture, risks, tests, idioms, invariants, and change impact once, then turns that understanding into visualization for humans and compact MCP context for AI agents.

The core claim is not only "less context." It is better context: the right files, architecture, idioms, invariants, tests, and risks delivered before an agent starts rediscovering the repository.

Primary buyer promise:

- Humans see the system at a glance.
- Agents get compact, deterministic context before they edit.
- Teams ship faster with less token waste and fewer architecture-drifting changes.

Primary product surfaces:

- Visualization over the CAS graph for humans.
- MCP for Claude, Codex, Cursor, and other coding agents.
- Hosted analyzers with local thin clients.
- Local and self-hosted analyzer paths for sensitive teams.
- Proposal previews that analyze proposed iterations before they touch the real working tree.

## Homepage

### Hero

Eyebrow:

Codebase context infrastructure for AI agents and humans

Headline:

Klauro replaces repo rediscovery with codebase understanding.

Subheadline:

Every AI coding agent burns time building a mental model before it can make a good change. Klauro analyzes the system once, then gives agents compact agent contexts and gives humans visualization of the same CAS truth layer.

Proof line:

Reduce token usage up to 97%, finish agent tasks up to 88% faster, and improve architecture, pattern, idiom, and invariant adherence.

Primary CTA:

Contact us

Secondary CTA:

See how it works

Hero visual direction:

Use a dark product screenshot or high-fidelity product mock based on the codebase overview UI. The first viewport should show cards for Role in the System, Architecture, Critical Flows, Test Health, Patterns, Entry/Input, External/Output, and Core Data. Avoid generic abstract gradients.

### Problem

Section headline:

AI can build software faster than humans can understand it.

Body:

Most teams still judge AI-built software by inputs and outputs: the prompt, the diff, the demo, and whether tests pass. That is not enough. You still need to know what paths exist, what data crosses boundaries, which security assumptions hold, what tests cover the behavior, and what breaks when something changes.

Klauro makes the internals visible.

### Product Overview

Section headline:

One truth layer. Two product surfaces.

Card 1:

Title: Visualization for humans

Body: Engineers, founders, reviewers, and product leaders can inspect what was built without opening dozens of files. Klauro visualizes domains, flows, entry points, data models, external systems, tests, risks, and architectural patterns from the CAS graph.

Card 2:

Title: MCP agent contexts for agents

Body: Claude, Codex, Cursor, and other agents can query Klauro before broad source-file exploration. Agent contexts include target files, call paths, invariants, idioms, tests, risks, runtime priorities, and compact execution capsules.

Card 3:

Title: Iteration analysis

Body: Proposed changes can be analyzed as ephemeral codebase iterations. Klauro compares baseline and proposed CAS outputs, surfaces impacted contracts, changed flows, affected tests, and architecture risks, then returns a private preview link.

### What Klauro Knows

Section headline:

Not a file index. A behavior graph.

Intro:

Klauro analyzes source code into CAS, the Code Analysis Specification: a complete relationship graph designed for both visual inspection and agent guidance.

Tiles:

- Domains and capabilities: what the system exists to do.
- Entry points: routes, jobs, CLI commands, events, handlers, screens, and public APIs.
- Critical flows: how behavior moves through controllers, services, repositories, models, queues, and external systems.
- Core data: entities, relationships, data access patterns, migrations, and persistence boundaries.
- Architecture patterns: MVC, MVVM, repository, unit of work, dependency injection, mediator, singleton, message-driven flows, and framework-specific structure.
- Tests and confidence: test suites, coverage signals, behavioral gaps, and validation commands.
- Risks and drift: duplication, inconsistent paradigms, boundary violations, naming drift, missing tests, fragile flows, and architecture mismatch.
- Idioms and conventions: local naming, file organization, DI, validation, error handling, auth scope, logging, migrations, async style, and test style.
- Runtime context: telemetry, errors, traces, stack frames, volume, bottlenecks, and impact-ranked operational priorities.

### Agent Workflow

Section headline:

Agents should start with understanding, not repo search.

Body:

Before an agent edits, Klauro resolves the relevant analysis, selects the target, returns a compact agent context, and narrows the first files to inspect. The context includes local architecture, idioms, behavioral invariants, risks, tests, runtime signals, and validation steps. After the edit, agents can validate behavior and idiom conformance before finalizing.

Steps:

1. Resolve the right codebase or monorepo slice.
2. Get an agent start context and task-specific tool plan.
3. Read a compact agent context instead of scanning the repo.
4. Inspect only the first files Klauro identifies.
5. Edit against local patterns and architecture.
6. Validate invariants, tests, and idiom conformance.

### Proof

Section headline:

Less context. Higher quality. Faster completion.

Stat cards:

- Up to 97% fewer tokens versus cold scan.
- Up to 88% faster than targeted search.
- 81% token reduction in the latest machine-wide proof.
- 7.18x average incremental edit speedup.
- 102 of 102 eligible local repos passed agent-context-ready readiness in the latest machine gauntlet.
- 17 of 17 engineering task families strong under the quality-plus-token bar.

Context paragraph:

The proof suite covers existing-project orientation, bug diagnosis, bug fixes, product enhancements, architectural refactors, monolith decomposition, schema and migration work, auth and tenant boundary changes, MFA, test targeting, performance fixes, cross-repo contracts, large feature integration, and from-zero product builds. The goal is to beat the agent's default behavior: less rediscovery, better architecture adherence, and faster completion in the same workflow developers already use.

Note for small print:

Use "up to" when presenting peak token and time reductions. Do not call these "early benchmarks." The numbers come from Klauro's current proof gauntlets and live A/B artifacts.

### Greenfield

Section headline:

Build large systems without forgetting what already exists.

Body:

Klauro also works before a repo exists. For a new product, agents can request a greenfield build context that carries architecture guidance, domain ownership, test strategy, duplication gates, and growth rules. After the first slice is written, Klauro analyzes the new codebase and uses that CAS memory to guide the next slice.

Use cases:

- Create the first vertical slice from an empty folder.
- Continue a generated system without duplicating models or concepts.
- Preserve architecture across multiple product waves.
- Keep agents focused on product behavior instead of re-deciding structure every turn.

### Security And Deployment

Section headline:

Use it locally, hosted, or self-hosted.

Body:

Klauro is local-only by default. With no remote analyzer mode, AI provider key, embedding API key, or artifact bucket configured, analysis makes zero network calls and stores artifacts under the local Klauro cache. Commercial deployments can use a thin local client with hosted analyzers so the analyzer implementation stays server-side, or a self-hosted analyzer container for teams that need the service inside their own network.

Security points:

- Upload manifests show exactly what would be sent.
- `.klaurorc` controls analyzer mode, source rules, policy gates, and allowed hosts.
- `.klauroignore` excludes secrets, generated files, dependency trees, and private paths.
- Local mode sends no source, paths, CAS, embeddings, telemetry, or git metadata over the network.
- Cloud AI and remote analyzer modes are explicit opt-ins.

### Differentiation

Section headline:

Not another agent. The context layer underneath them.

Body:

Editor indexes help agents find files. Project-management agents help teams act inside workflow tools. Klauro is the codebase truth layer underneath them: deterministic CAS output, architecture-aware context, compact MCP contexts, idiom intelligence, proposal previews, incremental analysis, and runtime-informed priorities.

Comparison points:

- Portable across agents instead of tied to one IDE or planning tool.
- Makes Claude, Codex, Cursor, and future agents more effective instead of replacing them.
- Designed for both humans and agents from the same CAS graph.
- Focused on architecture, behavior, risk, and conventions, not just text retrieval.
- Built to reduce total token usage, not add context overhead.
- Supports local, hosted, and self-hosted analyzer paths.

### CTA

Headline:

Make your codebase visible.

Body:

Klauro helps teams understand what AI built, guide what agents change next, and keep large systems coherent as they grow.

Primary CTA:

Contact us

Secondary CTA:

Request a demo

## Product Pages

### Agents Page

Headline:

Give coding agents the context they should have started with.

Body:

Klauro MCP gives agents compact, task-specific context from the full CAS graph: target files, call paths, invariants, local idioms, risks, tests, runtime priorities, and validation steps. Agents spend less time rediscovering the codebase and more time making the right change.

Key modules:

- Start context for orientation.
- Tool plans for modify, debug, review, trace, runtime, and cross-repo tasks.
- Agent contexts for concrete code changes.
- Coding context for selected nodes or files.
- Idiom validation before final output.
- Behavioral invariant validation after edits.
- Greenfield build contexts for new projects.
- Proposal previews for multi-file plans and refactors.

### Visualization Page

Headline:

See what the system actually does.

Body:

Klauro visualizes domains, flows, architecture, entry points, data, tests, risks, external systems, and conventions from the same CAS graph agents use. It is built for humans reviewing AI-generated software, onboarding into unfamiliar systems, and validating proposed changes before they land.

Views:

- Overview.
- Architecture.
- Critical flows.
- Core entities.
- Entry and exit surfaces.
- Tests and confidence.
- Risks and drift.
- Patterns and idioms.
- Proposal diff overlay.

### Hosted Analyzer Page

Headline:

Hosted analyzers, local agent speed.

Body:

Customers install a thin local client. Klauro's hosted analyzer receives filtered snapshots or dirty-tree deltas, returns CAS output, and caches it locally so agents can query the graph quickly. The analyzer implementation stays server-side while local MCP workflows remain fast.

Key points:

- Upload manifest before source leaves the machine.
- Filtered source snapshots.
- Dirty-tree incremental sync.
- Local CAS cache for fast agent access.
- Policy gates for allowed hosts and remote analysis.
- Self-hosted container option for enterprise customers.

## FAQ

Question:

How do I get access?

Answer:

Use the contact form or email mike.shattuck@klauro.com. Klauro is currently being introduced through direct customer conversations, not public self-serve pricing.

Question:

Is Klauro replacing Claude, Codex, Cursor, or Linear?

Answer:

No. Klauro gives those tools better codebase context. Agents still do the work; Klauro gives them a trusted map of the system before they start.

Question:

Is Klauro just code search?

Answer:

No. Search finds text. Klauro builds a relationship graph of behavior, architecture, data, tests, risks, idioms, and runtime signals.

Question:

Does Klauro send source code to your servers?

Answer:

Not by default. Local mode makes zero network calls. Hosted analyzer mode is explicit, policy-controlled, and starts with an upload manifest so customers can see what would be sent.

Question:

Can Klauro work with local AI agents?

Answer:

Yes. The MCP server is designed for Claude Code, Codex, Cursor-like tools, and other MCP or skill-aware agents. CAS is cached locally so agents can query it without rereading the repository.

Question:

Can it help with new projects?

Answer:

Yes. Greenfield build contexts guide the first slice of a new system, then CAS memory guides later slices so agents avoid duplicated concepts and architecture drift.

Question:

Does Klauro improve code quality?

Answer:

Klauro is built to improve agent output by giving agents local architecture, idioms, invariants, tests, and risk context before edits. The proof suite measures this through live A/B tasks, copied-repo trials, idiom validation, and from-zero build continuation tests.

## Framer Implementation Notes

- Keep the homepage direct and product-first. Avoid a vague AI infrastructure hero.
- Put the codebase visualization mock in the first viewport.
- Use proof numbers near the top, but do not overload the hero with every metric.
- Use a short nav: Product, Agents, Visualization, Security, Proof, Contact.
- Avoid stale API/SaaS dashboard claims until the hosted product is deployed.
- Avoid pricing claims until pricing exists.
- Avoid saying "open source" or implying the analyzers are given away.
- Avoid "early benchmarks." Use "current proof gauntlets" or omit the qualifier.
- Do not call Klauro a safety gate. It is a reference and visibility layer for humans and agents.
