# Klauro Vision

## The Problem

AI can now generate large amounts of software faster than humans can inspect it. A demo can pass an input/output check while the internal behavior remains unclear: duplicated flows, hidden coupling, missing guards, fragile dependencies, untested paths, and data movement nobody has verified.

Codebases were already hard to see. AI-built code makes that gap bigger.

## The Product

Klauro is the visibility layer for AI-built software. It turns a codebase into a complete relationship graph that both humans and AI agents can inspect.

The CAS is the source of truth. It captures the system as code elements and relationships: entry points, exits, controllers, services, repositories, components, hooks, tests, data entities, security boundaries, external services, call chains, and change risk.

Two product surfaces sit on top of that same truth:

- **UI for humans:** inspect what was actually built, drill into behavior, explain the system to engineers and leaders, and verify AI-generated work beyond the demo path.
- **MCP for agents:** give Claude Code, Codex, Cursor, and other assistants complete codebase context without file-by-file rediscovery.

Runtime telemetry later closes the loop by showing whether the system behaves in production the way static analysis says it should.

Klauro also introduces a collaboration state that Git does not cover: analyzed
in-flight work. Durable commits remain the accepted project truth, but humans
and agents should also be able to see provisional branch, session, and working
tree changes before they land. That lets teams avoid duplicate work, spot likely
merge conflicts, and coordinate multi-agent or multi-human development while the
work is still happening.

## Core Principles

### 1. Semantic Understanding

Klauro does not map files for their own sake. It maps meaning.

A NestJS controller is not just a TypeScript file. It is a request entry point with routes, guards, validation, service dependencies, data access, tests, and downstream exits. A React page is not just JSX. It is a user-facing route with components, state, hooks, data fetching, permissions, and behavior.

### 2. Complete Graph Generation

CAS must contain the complete relationship graph. The frontend and MCP clients render or query what CAS provides; they do not invent relationships that belong in analysis.

### 3. Framework Intelligence

Klauro understands frameworks and libraries, not only language syntax.

| Area | What CAS Should See |
| --- | --- |
| NestJS | Modules, controllers, routes, guards, services, repositories, DI, entities |
| React | Routes, pages, components, hooks, context, state, data fetching |
| Express | Routes, middleware chains, handlers, error paths |
| Django/FastAPI/Flask | Routes, views, serializers, models, dependencies |
| Spring Boot | Controllers, services, repositories, DI, endpoints |
| ORMs | Entities, fields, relations, queries, migrations |
| Testing | Suites, cases, assertions, mocks, fixtures, coverage gaps |
| External systems | APIs, databases, queues, caches, SDKs, files, messages |

### 4. Behavior-Level Verification

Input/output checks tell you whether a visible path seems to work. Klauro shows the behavior inside: what was called, what data moved, what boundary was crossed, what test covers it, and what else depends on it.

That is why the UI matters. It gives humans a way to verify and understand what AI-generated code actually contains.

### 5. AI-Native Context

AI agents should start from the architecture and then inspect code with intent. MCP gives agents a compact, queryable map before they spend tokens reading files.

### 6. In-Flight Collaboration

Klauro should understand active work before Git does. A developer's uncommitted
changes, an agent's sandboxed edits, a teammate's feature branch, and incoming
analyzed commits are all part of the product context. They are not durable truth
until accepted, but they are valuable provisional facts. MCP and the UI should
surface them with provenance so agents can deduplicate work, preserve local
architecture, and avoid conflicts before commit, push, or merge.

## What Users Should Be Able To See

### System Level

- Tech stack and framework detection
- Architecture layers and major modules
- Entry points by type
- Exit points and external dependencies
- Data model from the code's perspective
- Security boundaries and auth assumptions
- Test coverage and gaps
- Implementation health and technical debt

### Flow Level

- Request and user-action journeys from entry to exit
- Call chains with criticality and risk
- Data creation, reads, updates, deletes, and external transfers
- Security boundaries crossed along the path
- Tests that protect the flow

### Node Level

- Signatures, decorators, metadata, and source locations
- Incoming and outgoing relationships
- Parent and child code elements
- Tests and examples
- Change risk and downstream impact

## Product Surfaces

### UI

The UI is the human verification surface. It should make the graph easy to scan at the top level and deep enough to traverse down to specific functions, variables, imports, tests, routes, and data access.

### MCP

The MCP server is the agent verification surface. It should answer questions like:

- What are the main parts of this system?
- What calls this function?
- What does this route call?
- What data does this flow touch?
- What tests cover this node?
- What is risky about changing this component?
- Is someone else already changing this capability, entity, route, migration,
  contract, deployable, or workspace dependency?
- Are there incoming analyzed changes that make my local plan stale?

### Telemetry

Telemetry should eventually show runtime behavior against the same model: traffic, errors, bottlenecks, hot paths, unused components, and production drift from static expectations.

### Analysis Flow

See [`../KLAURO-ANALYSIS-FLOW.md`](../KLAURO-ANALYSIS-FLOW.md) for the unified
cold, warm, in-flight, incoming, and durable analysis model. The short version:
there is one Klauro analysis experience. Some phases may happen from the
installed client and some may happen in hosted Klauro services, but customers
and agents should experience one coherent product flow.

## The Vision Statement

Make any system understandable. Turn the lights on. Give humans and AI agents a complete, trustworthy view of what was built, how it behaves, and how safely it can change.

## Who This Is For

- **Engineering leaders:** understand systems, risks, and team-owned code without reading every file.
- **New developers:** onboard by seeing structure and behavior before changing code.
- **Large teams:** replace tribal knowledge with a shared system map.
- **AI coding assistants:** work from complete context instead of discovery-by-grep.
- **Non-technical stakeholders:** understand what exists and where issues live without reading code.

## Tagline

Klauro: see what the code actually built.
