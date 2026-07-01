# Code Analysis Specification (CAS)

> **Current Version:** [1.10.0](./SPECIFICATION.md)
> **Status:** Active
> **Full Specification:** [SPECIFICATION.md](./SPECIFICATION.md)

## Overview

The Code Analysis Specification (CAS) is Klauro's source-of-truth format for understanding one project, repo, folder, or codebase. CAS represents that codebase as a complete relationship graph that can be inspected by humans in the UI and queried by AI agents through MCP.

Workspace-level understanding is specified separately by the [Workspace Analysis Specification (WAS)](../was/SPECIFICATION.md). WAS is generated after all associated project/repo CAS analyses finish, and it composes those completed CAS outputs into a product/system map. WAS must not require source-code reads; if a workspace relationship cannot be generated from CAS outputs, that is a repo-level CAS analyzer gap.

CAS exists so Klauro can answer behavior-level questions:

- What did this codebase actually build?
- How does a feature flow from entry point to exit point?
- What calls this node, and what does this node call?
- What data, tests, and security boundaries are involved?
- What changed recently, and how risky is a modification?

## Core Concepts

### Shared Truth Layer

CAS is the shared model behind both product surfaces:

- **UI:** human inspection and verification of AI-built or human-built systems.
- **MCP:** agent access to codebase context without file-by-file rediscovery.

The UI and MCP server should render or query CAS. They should not invent relationships that belong in the analyzer output.

### Multi-Perspective Analysis

Every codebase can be understood from multiple perspectives:

- **Language perspective:** classes, functions, methods, variables, imports, and files.
- **Framework perspective:** controllers, services, components, routes, hooks, modules, guards, and framework conventions.
- **Library perspective:** ORMs, state libraries, routing, data fetching, realtime, testing, and package-specific behavior.
- **Domain perspective:** capabilities, workflows, business concepts, data entities, and critical flows.

### Progressive Disclosure

CAS supports progressive disclosure through levels and targeted query surfaces. Consumers can start with the system overview, then drill into modules, flows, nodes, callers, callees, tests, data entities, risks, and history.

## Version History

### [v1.0.0](./v1.0.0.md) - Initial Specification

- Basic node and edge structure
- Simple type and subcategory system
- Language analyzer foundation
- Initial framework analyzers

### [v1.1.0](./v1.1.0.md) - Multi-Perspective Architecture with Comprehensive Metadata

- Tag-based node classification replacing type/subcategory system
- Multiple analyzer perspectives with independent hierarchies
- Rich documentation and purpose tracking
- External service classification and tracking
- Repo-local interface and integration hints for later WAS composition
- Dependency and package management information
- Security context and access control metadata
- Quality metrics and code coverage
- Runtime correlation and telemetry hooks
- Data flow and transformation tracking
- Progressive disclosure support for efficient querying

### [v1.2.0](./v1.2.0.md) - Perspective and Pattern Refinement

- Expanded multi-perspective support
- Enhanced pattern representation
- Improved hierarchy and disclosure semantics

### [v1.3.0](./v1.3.0-rfp.md) - Call Graph Tracking

- Method invocation analysis
- Call chain structures
- Decorator metadata and framework call context

### [v1.4.0](./v1.4.0-rfp.md) - Documentation and Implementation Health

- Documentation extraction
- Comments and TODO tracking
- Implementation status and health summaries

### [v1.5.0](./v1.5.0-rfp.md) - Class Relationships and Pattern Variations

- Class-level relationship edges
- Enhanced entry point paths and guard detection
- Pattern variations and deviations

### [v1.6.0](./v1.6.0-rfp.md) - Test Architecture

- Test suites, test cases, mocks, fixtures, and assertions
- Test-to-code relationships
- Coverage summaries and test gap detection

### [v1.7.0](./v1.7.0-rfp.md) - Inference-Based Intelligence

- Intent inference
- Critical flow summaries
- Change risk
- Data entities
- Security boundaries
- Flow coverage
- Temporal stability

### [v1.8.0](./v1.8.0-rfp.md) - Incremental Analysis

- Change detection
- Incremental state
- File cache
- Change history
- Analysis snapshots
- Impact analysis
- Runtime-to-static correlation
- Evidence-backed analysis facts
- Semantic change impact
- Repo-local integration confidence for later WAS composition

### [v1.9.0](./v1.9.0-rfp.md) - Codebase Idiom Intelligence

- Repo-local idioms for naming, file organization, module boundaries, dependency injection, data access, error handling, validation, auth/tenant scope, logging, testing, migrations, async style, and configuration
- Positive examples, affected scopes, deviations, and agent guidance
- MCP idiom queries, examples, validation, and idiom-aware agent contexts
- Live copied-repo A/B proof for idiom conformance and quality
- Machine-wide real-repo discovery and proof accounting

### [v1.10.0](./v1.10.0-rfp.md) - Graph-Anchored Semantic Retrieval

- Per-node vector embeddings derived from structured, graph-aware documents
- Embedding provider abstraction with API and local implementations
- Vector store abstraction with file-backed and pgvector-backed implementations
- `embedding_index` CAS metadata with model, dimensions, and coverage provenance
- Hybrid lexical, semantic, and structural-rerank query path
- Graph-anchored semantic results that carry callers, callees, tests, and risk
- Incremental re-embedding of only changed nodes
- MCP `semantic_search`, `search_nodes` mode parameter, and `get_embedding_status`

## Key Principles

1. **CAS is authoritative:** downstream surfaces render or query the graph; they do not compute missing relationships.
2. **Analyzers collaborate:** language, framework, library, pattern, and domain analyzers hydrate the same output.
3. **Relationships matter most:** nodes are useful only when callers, callees, containment, data access, tests, entry points, and exits are connected.
4. **Framework semantics are first-class:** a controller, hook, route, repository, guard, and test are product concepts, not just syntax.
5. **Humans and agents share the same truth:** the UI and MCP should expose different views of the same CAS output.

## Implementation

The CAS is implemented through analyzers that work together:

1. **Language analyzers:** create foundational code nodes.
2. **Framework analyzers:** add framework-specific roles and relationships.
3. **Library analyzers:** add package-specific metadata and behavior.
4. **Pattern analyzers:** identify cross-cutting conventions, deviations, and risks.
5. **Incremental analysis:** tracks what changed and reuses prior analysis where possible.

## Usage

The CAS enables:

- **Klauro UI:** visual inspection, drilldown, and behavior verification.
- **MCP server:** AI agents that query codebase context directly.
- **Analysis APIs:** programmatic access to system structure, flow, risk, tests, and history.

## Contributing

When adding new analyzers or perspectives:

1. Define the nodes, tags, and metadata your analyzer contributes.
2. Define the relationships it must create or hydrate.
3. Preserve analyzer attribution.
4. Avoid duplicate nodes when an existing node can be enhanced.
5. Add query/MCP documentation for any new CAS field that should be visible downstream.

See [SPECIFICATION.md](./SPECIFICATION.md) for detailed implementation guidelines.
