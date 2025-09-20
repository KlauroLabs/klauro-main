# Code Analysis Specification (CAS)

**Version:** 1.2.0
**Status:** Active
**Last Updated:** 2024-09-19

## Abstract

The Code Analysis Specification (CAS) defines a universal, language-agnostic format for representing comprehensive code analysis results. This specification enables tools to analyze, understand, and share insights about software systems through a standardized data structure supporting multiple analytical perspectives, rich metadata, and progressive disclosure.

## Table of Contents

1. [Introduction](#1-introduction)
2. [Conformance](#2-conformance)
3. [References](#3-references)
4. [Data Structures](#4-data-structures)
5. [Semantic Rules](#5-semantic-rules)
6. [Query Interface](#6-query-interface)
7. [Extensions](#7-extensions)
8. [Security Considerations](#8-security-considerations)
9. [IANA Considerations](#9-iana-considerations)
10. [Examples](#10-examples)

## Status of This Document

This document specifies version 1.2.0 of the Code Analysis Specification, which is the current active version. Previous versions are maintained for historical reference:

- [Version 1.0.0](./v1.0.0.md) - Initial release
- [Version 1.1.0](./v1.1.0.md) - Added progressive levels and extended metadata
- [Version 1.2.0](./v1.2.0.md) - Current version - Multi-perspective support

## 1. Introduction

### 1.1 Purpose

Modern software systems require analysis from multiple perspectives - language constructs, framework patterns, architectural layers, business domains, and quality metrics. The CAS provides a unified format for capturing and sharing these diverse analytical views.

### 1.2 Scope

This specification defines:
- Data structures for representing code analysis results
- Semantic rules for multi-perspective analysis
- Query interfaces for information retrieval
- Extension mechanisms for future capabilities

This specification does NOT define:
- Visualization or presentation formats
- Analysis algorithms or techniques
- Language-specific parsing rules
- Performance requirements

### 1.3 Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

## 2. Conformance

A conforming implementation:
- MUST produce output matching the specified data structures
- MUST implement the tag accumulation system correctly
- MUST maintain perspective independence
- MUST preserve analyzer attribution
- SHOULD support all defined metadata fields
- MAY extend the specification with additional fields

## 3. References

### 3.1 Normative References

- RFC 2119: Key words for use in RFCs to Indicate Requirement Levels
- RFC 8259: The JavaScript Object Notation (JSON) Data Interchange Format
- ISO 8601: Date and time format

### 3.2 Informative References

- Language Server Protocol Specification
- SARIF (Static Analysis Results Interchange Format)
- CodeQL Database Schema

## 4. Data Structures

### 4.1 CASOutput

The root structure containing complete analysis results:

```typescript
interface CASOutput {
  cas_version: "1.2.0";
  analysis_timestamp: string;  // ISO 8601
  analysis_id: string;          // Unique identifier

  system: {
    id: string;
    name: string;
    root_path: string;
    type?: string;
    description?: string;
    metadata?: Record<string, any>;
  };

  nodes: CASNode[];
  edges: CASEdge[];
  entry_points: EntryPoint[];
  exit_points: ExitPoint[];
  external_services: ExternalService[];

  repository_links?: RepositoryLink[];
  dependencies?: Dependencies;
  disclosure?: DisclosureHints;
  analyzer_contributions: AnalyzerContribution[];
  metadata?: SystemMetadata;
}
```

### 4.2 CASNode

Represents a code element with multi-perspective analysis:

```typescript
interface CASNode {
  id: string;                   // Unique identifier
  name: string;                  // Human-readable name
  tags: string[];                // Classification tags

  perspectives: {
    [perspectiveId: string]: {
      hierarchy: string[];       // Hierarchical path
      level: number;            // Depth (0 = top-level)
      priority: number;         // Importance (0-100)
      metadata?: Record<string, any>;
    }
  };

  analyzers: string[];          // Contributing analyzers
  primaryAnalyzer: string;      // Primary ownership

  source: SourceLocation;
  relationships?: Relationships;
  documentation?: Documentation;
  metrics?: Metrics;
  security?: SecurityContext;
  telemetry?: TelemetryHooks;
  dataFlow?: DataFlow;
  metadata?: Record<string, any>;
}
```

### 4.3 CASEdge

Represents relationships between nodes:

```typescript
interface CASEdge {
  id: string;
  source: string;               // Source node ID
  target: string;               // Target node ID
  type: string;                 // Relationship type

  analyzer?: string;            // Creating analyzer
  dataFlow?: EdgeDataFlow;
  metadata?: Record<string, any>;
}
```

### 4.4 Supporting Structures

[Complete definitions of all supporting interfaces including ExternalService, EntryPoint, ExitPoint, Documentation, Metrics, SecurityContext, etc.]

## 5. Semantic Rules

### 5.1 Node Identity

- Node IDs MUST be unique within an analysis result
- Node IDs SHOULD be deterministic across analyses
- Node IDs MUST NOT contain personal or sensitive information

### 5.2 Tag System

- Tags are additive and non-hierarchical
- Tags MUST be lowercase with hyphens for word separation
- Tags accumulate from all analyzers
- No single analyzer owns a tag

### 5.3 Perspective System

- Each analyzer provides one perspective
- Perspectives are independent
- A node MAY have multiple perspectives
- Perspective IDs MUST be unique

### 5.4 Analyzer Collaboration

1. Language analyzers create base nodes
2. Framework analyzers enhance with perspectives
3. Library analyzers add specialized metadata
4. Pattern analyzers identify cross-cutting concerns

### 5.5 External Services

- Services MUST be classified by type
- Direction MUST be specified (consumption/production/bidirectional)
- Connection node MUST exist in the node list

## 6. Query Interface

### 6.1 Tag-Based Queries

Implementations SHOULD support:
- Union: Nodes with any specified tags
- Intersection: Nodes with all specified tags
- Exclusion: Nodes without specified tags

### 6.2 Perspective Queries

Implementations SHOULD support:
- Filtering by perspective presence
- Level-based queries within perspectives
- Hierarchy path matching

### 6.3 Progressive Disclosure

Implementations SHOULD support:
- Level-based retrieval
- Incremental detail loading
- Context preservation

## 7. Extensions

### 7.1 Extension Mechanism

Implementations MAY extend the specification by:
- Adding fields prefixed with underscore (_)
- Creating new analyzer perspectives
- Defining additional tag vocabularies
- Adding metadata to existing structures

### 7.2 Reserved Names

The following are reserved for future versions:
- Field names: version, schema, constraints, policies, workflows
- Tag prefixes: cas-, spec-, system-
- Perspective IDs: cas-*, spec-*

## 8. Security Considerations

### 8.1 Sensitive Information

- Source file paths MAY contain sensitive information
- Implementations SHOULD provide path sanitization options
- API keys and secrets MUST NOT appear in analysis results

### 8.2 Access Control

- The security context provides access level information
- Implementations SHOULD respect security classifications
- Query interfaces SHOULD enforce access controls

## 9. IANA Considerations

This document has no IANA actions.

## 10. Examples

### 10.1 Minimal Valid Output

```json
{
  "cas_version": "1.1.0",
  "analysis_timestamp": "2024-01-01T00:00:00Z",
  "analysis_id": "analysis_123",
  "system": {
    "id": "system_example",
    "name": "Example System",
    "root_path": "/path/to/system"
  },
  "nodes": [],
  "edges": [],
  "entry_points": [],
  "exit_points": [],
  "external_services": [],
  "analyzer_contributions": []
}
```

### 10.2 Multi-Perspective Node

[Full example with multiple perspectives, tags, and metadata]

## Appendices

### Appendix A: Change Log

- **1.1.0** (Current): Added multi-perspective support, external services, rich metadata
- **1.0.0**: Initial specification

### Appendix B: Implementations

Known implementations of this specification:
- Unravl Analyzer Framework
- [Community implementations welcome]

### Appendix C: Acknowledgments

This specification was developed by the Unravl team with input from the software analysis community.

## Copyright Notice

This specification is released under [appropriate license].

## Contact

- Specification repository: [GitHub URL]
- Issue tracker: [GitHub Issues URL]
- Mailing list: [if applicable]