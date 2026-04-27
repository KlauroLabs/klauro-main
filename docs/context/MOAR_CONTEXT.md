# Analyzer Perspectives and Traversal Notes

This document captures product context that should inform CAS, analyzers, the UI, and MCP tools.

## Core Idea

Unravl should not treat a codebase as one flat hierarchy. A useful analysis has multiple perspectives that overlap:

- Language perspective: functions, classes, interfaces, variables, imports, decorators, type references, inheritance, call sites, and exports.
- Framework perspective: controllers, routes, services, repositories, pages, hooks, providers, middleware, validators, modules, jobs, and framework-specific entry points.
- Library perspective: ORMs, message queues, routers, auth libraries, validation libraries, test libraries, data fetching, state management, and telemetry clients.
- Repository perspective: root folders, packages, apps, services, shared modules, generated code, and build boundaries.
- Product perspective: flows, critical paths, data lifecycle, risk, ownership, stability, and test coverage.

Nodes can belong to many perspectives at once. A TypeScript class can be a language-level class, a NestJS controller, a route owner, a dependency injection participant, and a security boundary participant. CAS should preserve those overlapping facts rather than forcing one primary category.

## Analyzer Responsibilities

Language analyzers own language mechanics. They should detect syntax-level and semantic relationships such as:

- Defines, imports, exports, extends, implements, calls, reads, writes, instantiates, and decorates.
- Function and method signatures.
- Variable and property references.
- Type relationships.
- Entry and exit points that are visible at the language level.

Framework analyzers own framework semantics. They should explain what language structures mean inside a framework:

- NestJS controllers, routes, modules, guards, interceptors, pipes, services, providers, repositories, and dependency injection.
- React routes, pages, components, hooks, contexts, state, data fetching, and user-facing flows.
- Express routers, middleware, handlers, validation, and downstream service calls.
- Django, Flask, Spring Boot, ASP.NET Core, Laravel, and other framework concepts as analyzers are added.

Library analyzers add package-specific meaning. Examples include ORM entities and relations, queue producers and consumers, auth policies, validation schemas, cache keys, API clients, and test assertions.

Analyzers should collaborate rather than duplicate work. A framework analyzer should add framework meaning to language nodes, not rebuild language parsing from scratch.

## Perspective Metadata

Every node should expose the analyzers and perspectives that contributed to it:

- Analyzer id and display name.
- Analyzer family: language, framework, library, repository, or product.
- Perspective tags.
- Confidence and evidence.
- Priority when multiple analyzers describe the same node.

The UI and MCP should be able to filter by one perspective or combine several, such as "TypeScript plus NestJS" or "C# plus ASP.NET Core plus MediatR."

## Hierarchy Guidance

Hierarchy should come from the best available perspective, not from folders alone.

For a NestJS service:

- Top layer: backend application or package.
- Framework layer: NestJS module.
- Role layer: controller, service, repository, provider, guard, validator, or entity.
- Node layer: class, function, method, property, decorator, import, or type.
- Relationship layer: calls, injects, validates, queries, publishes, subscribes, reads, writes, protects, and returns.

For a React application:

- Top layer: frontend application or package.
- Framework layer: route, page, layout, provider, component group, or feature folder.
- Role layer: component, hook, context, store, data fetcher, form, validation schema, or API client.
- Node layer: function, component, variable, import, event handler, prop, or state value.
- Relationship layer: renders, calls, fetches, provides, consumes, reads, writes, validates, and navigates.

Folders are still useful, especially in monorepos and apps with `frontend`, `backend`, `packages`, or service directories, but folder structure should be one perspective among several.

## Traversal Requirements

The UI should make graph traversal feel direct:

- Drag the diagram when the current view exceeds the viewport.
- Zoom with controls and keyboard or trackpad gestures.
- Use a perspective selector that changes the graph, not passive tags.
- Drill into a concept card to see everything inside it.
- Drill into a node to see what it calls, what calls it, and what data or control crosses through it.
- Group connected nodes by role so the user does not have to scroll through long lists.
- Let users toggle relationship types on and off.
- Keep side context visible on desktop and collapsible on smaller screens.

The first view of an analysis should show analysis metadata from CAS: analyzers used, file counts, languages, frameworks, errors, warnings, coverage, and freshness. The UI should not invent data that CAS did not provide.

## Example: Controller Trace

For a NestJS controller method, CAS should be able to represent:

- The route, HTTP method, decorators, query params, body, response type, guards, and validation.
- The method body and every service method it calls.
- Injected services and provider definitions.
- Repository or ORM calls downstream.
- External file, network, queue, or database exits.
- Recursive or repeated calls in orchestrators.
- Interfaces, abstract classes, and concrete implementations involved in dispatch.
- Tests, mocks, fixtures, and assertions that cover the route.

The user should be able to start at the route and traverse to every connected function, variable, import, provider, query, and test that CAS knows about.

## Product Model Notes

Unravl is a B2B SaaS product as well as a local analysis and MCP surface.

- Users can belong to organizations.
- Organizations can contain workspaces.
- Workspaces can contain projects or codebases.
- A project can contain multiple codebases when a real system spans repos or services.
- Personal workspaces exist for individual use.
- Ownership transfer, account management, team management, billing, and private repository access are product requirements, but docs must only claim them as implemented when active code supports them.

## CAS Implication

CAS needs enough structure for both humans and agents to ask behavior-level questions:

- What is this node?
- Which analyzers recognized it?
- What framework or library roles apply to it?
- What calls it?
- What does it call?
- What data does it read, write, validate, or expose?
- What protects it?
- What tests cover it?
- What changed recently?
- What would likely break if it changed?

If CAS cannot answer those questions, the UI and MCP should expose that gap clearly instead of papering it over.
