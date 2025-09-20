# Code Analysis Specification (CAS)

> **Current Version:** [1.1.0](./SPECIFICATION.md)
> **Status:** Active
> **Full Specification:** [SPECIFICATION.md](./SPECIFICATION.md)

## Overview

The Code Analysis Specification (CAS) defines how Unravl analyzes, structures, and represents codebases as interconnected nodes and edges. It enables multiple analytical perspectives through a flexible tagging and hierarchy system that adapts to different languages, frameworks, and libraries.

## Core Concepts

### Multi-Perspective Analysis
Every codebase can be understood from multiple perspectives:
- **Language perspective**: Basic code constructs (classes, functions, variables)
- **Framework perspective**: Framework-specific patterns (controllers, services, components)
- **Library perspective**: Library-specific patterns (reducers, sagas, queries)
- **Domain perspective**: Business logic organization (features, modules, bounded contexts)

### Progressive Disclosure
The CAS supports progressive disclosure through hierarchical levels, allowing consumers (UI, MCP) to request only the depth of information needed, from high-level architecture down to individual functions.

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
- Cross-repository linking capabilities
- Dependency and package management information
- Security context and access control metadata
- Quality metrics and code coverage
- Runtime correlation and telemetry hooks
- Data flow and transformation tracking
- Progressive disclosure support for efficient querying

## Key Principles

1. **Analyzers Don't Compete, They Collaborate**: Each analyzer adds its perspective without overwriting others
2. **Tags Over Types**: Nodes have multiple tags rather than a single type, enabling multi-faceted classification
3. **Hierarchies Are Perspective-Specific**: Each analyzer defines its own organizational hierarchy
4. **Progressive Enhancement**: Language analyzers provide the base, frameworks add specificity
5. **Query From Any Angle**: Users can explore and query the codebase from any analytical perspective

## Implementation

The CAS is implemented through a series of analyzers that work together:

1. **Language Analyzers**: Create the foundational nodes (TypeScript, Python, Java, etc.)
2. **Framework Analyzers**: Tag and enhance nodes with framework-specific metadata (NestJS, React, Django, etc.)
3. **Library Analyzers**: Add library-specific patterns and relationships (Redux, MikroORM, etc.)
4. **Pattern Analyzers**: Identify cross-cutting concerns (authentication, caching, logging)

Each analyzer declares its capabilities, dependencies, and the perspectives it provides.

## Usage

The CAS enables:
- **Unravl UI**: Interactive visualization with multiple viewing perspectives
- **MCP Services**: AI assistants that understand codebases from any angle
- **Analysis APIs**: Programmatic access to multi-perspective codebase understanding

## Contributing

When adding new analyzers or perspectives:
1. Define the tags your analyzer will use
2. Specify the hierarchical organization for your perspective
3. Document how your analyzer collaborates with others
4. Provide examples of the insights your perspective enables

See the latest version specification for detailed implementation guidelines.