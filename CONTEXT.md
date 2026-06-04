# Klauro - Product Context

## The Thesis

Klauro is the visibility layer for AI-built software.

AI can now produce large codebases quickly, but humans still need to understand what was actually built. A working demo only proves the visible input/output path. It does not prove the internal behavior: dependencies, security assumptions, data movement, duplicate logic, untested paths, or change risk.

Klauro solves that by turning codebases into a complete, queryable relationship graph.

## Source of Truth

The Code Analysis Specification (CAS) is the product foundation. CAS should contain the complete graph of code elements and relationships:

- System metadata, languages, frameworks, libraries, and package managers
- Entry points such as HTTP routes, pages, CLI commands, events, and schedules
- Exit points such as databases, external APIs, queues, files, caches, and SDK calls
- Code nodes such as modules, classes, functions, methods, components, hooks, variables, imports, tests, and entities
- Relationships such as calls, imports, containment, injection, data access, tests, coverage, and flow membership
- Security boundaries, auth requirements, assumptions, and gaps
- Data entities, lifecycle, schema, and cross-service dependencies
- Change history, stability, hot spots, and risk assessment

The frontend and MCP server must render or query CAS. They must not compute relationships CAS is responsible for.

## Product Surfaces

### Human Surface: UI

The UI helps people see and verify the system. It should support a high-level overview, focused drilldown, flow tracing, and details for any selected node.

The UI matters because humans need a way to inspect AI-generated systems beyond the demo path. It should make behavior visible: what exists, what connects, what data moves, what is protected, what is tested, and what is risky to change.

### Agent Surface: MCP

The MCP server gives AI coding tools complete architectural context without reading every file first. It should let agents ask targeted questions:

- What is this system?
- What are the main modules and entry points?
- What calls this node?
- What does this route touch?
- What tests cover this flow?
- What will break if this changes?

### Runtime Surface: Telemetry

Telemetry should eventually connect production behavior back to the same graph. Static CAS explains what the code says. Runtime data explains what actually happened.

## What Good Looks Like

For a NestJS application, Klauro should expose controllers, routes, guards, middleware, services, repositories, entities, decorators, method calls, tests, database access, and external calls. A user should be able to start at a route and follow the behavior through every connected function and dependency.

For a React application, Klauro should expose routes, pages, components, hooks, contexts, state, data fetching, protected areas, events, tests, and component relationships.

For a multi-repo system, Klauro should link services through APIs, shared databases, messages, queues, SDK calls, and other integration points.

## Core User Questions

- What did this codebase actually build?
- How does this feature work from entry to exit?
- What depends on this component?
- What data does this flow create, read, update, delete, or send?
- What security boundary protects this path?
- What tests cover this behavior?
- What changed recently?
- What is risky to modify?

## Experience Goals

In 30 seconds, a user should understand the top-level system.

In 5 minutes, a user should know the major modules, entry points, external dependencies, and data model.

In 30 minutes, a user should be able to reason about a real change with enough confidence to know where to inspect, what tests matter, and what downstream behavior is affected.

## Competitive Context

Search tells you where text appears. Static diagrams tell you a partial structure. Runtime traces tell you what happened once.

Klauro should combine the parts that matter: framework-aware static analysis, relationship graph quality, UI inspection for humans, MCP access for agents, and runtime correlation when available.

## Value Proposition

Without Klauro, humans and agents discover a codebase file by file.

With Klauro, they start with a complete system map and drill down only where needed.

That means faster onboarding, safer AI-generated changes, clearer leadership visibility, lower token waste, and fewer hidden behavior surprises.
