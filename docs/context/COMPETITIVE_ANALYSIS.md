# Unravl Competitive Analysis

## Executive Summary

This analysis compares Unravl's vision and capabilities against CodeSee and other code visualization tools. **Unravl is pursuing a fundamentally more ambitious goal** - semantic, framework-aware architecture extraction with runtime telemetry and AI integration - while competitors focus on file-level dependency mapping.

**Verdict: Unravl's vision definitively beats the competition.**

---

## Market Landscape

### Key Players

| Tool | Primary Focus | Approach |
|------|--------------|----------|
| **CodeSee** (acquired by GitKraken 2024) | File dependencies, PR visualization | GitHub Action, static file analysis |
| **Sourcegraph** | Code search and navigation | Cross-repo search, code intelligence |
| **CodeScene** | Behavioral analysis, tech debt | Git history analysis, hotspots |
| **Understand (SciTools)** | Deep static analysis | Compliance-focused, legacy systems |
| **Unravl** | Living architecture blueprints | Semantic analysis + runtime telemetry + AI |

---

## CodeSee: What They Actually Offer

### Capabilities

**Codebase Maps**
- Visualizes directories, files, and file-level dependencies
- Auto-generates from GitHub repos via GitHub Action
- Updates automatically on PR merge
- Supports: C#, Go, Java, JavaScript, Python, Rust, TypeScript, VB.NET, Blazor, ASP.NET

**Function Maps** (IDE Extension)
- Shows function-to-function call relationships within a file/module
- IDE-integrated (VS Code)
- Limited depth/scope of call graph traversal

**Service Maps** (Enterprise Only)
- Visualizes microservice topology
- Requires external data source: **Datadog or OpenTelemetry**
- Does NOT perform its own runtime analysis
- Renders topology from existing APM/tracing data

**Review Maps**
- Generates visual diff for GitHub PRs
- Shows which files changed and their connections
- Enables "Tours" - guided walkthroughs of changes

### What CodeSee Cannot Do

| Capability | CodeSee |
|------------|---------|
| Framework-specific detection | No - NestJS controller looks like any TS file |
| Semantic node types | No - No Controllers, Services, Repositories |
| Decorator/annotation parsing | No - Cannot identify @Guard, @Injectable, etc. |
| Entry point extraction | No - HTTP routes not detected from code |
| Call graph with execution context | No - No async/conditional/try-catch context |
| Native runtime telemetry | No - Requires external Datadog/OTEL |
| Change risk scoring | No - No downstream impact analysis |
| Test-to-code relationships | No - No test coverage mapping |
| Intent inference | No - Cannot determine why code exists |
| AI/MCP integration | No - No packaging for AI coding assistants |

### Why CodeSee Failed as Standalone

GitKraken acquired CodeSee in May 2024. The acquisition signals:
1. CodeSee couldn't scale independently as a standalone business
2. File-level mapping wasn't differentiated enough for enterprise
3. Market demand exists but CodeSee's depth was insufficient

---

## Unravl: What We Offer

### Semantic Understanding

**CodeSee sees:**
```
src/users/
  ├── users.controller.ts
  ├── users.service.ts
  └── users.module.ts
```

**Unravl sees:**
```
NestJS Application
  └── UsersModule (DI container)
        ├── UsersController
        │     ├── GET /users (requires: AuthGuard)
        │     ├── POST /users (requires: AdminGuard)
        │     └── GET /users/:id
        └── UsersService
              ├── findAll() → calls UsersRepository.find()
              ├── create() → calls UsersRepository.save()
              │              → emits UserCreatedEvent
              └── findById() → calls UsersRepository.findOne()
                             → calls CacheService.get()
```

### Framework Intelligence

Unravl understands 12+ frameworks with dedicated analyzers:

| Framework | What Unravl Extracts |
|-----------|---------------------|
| **NestJS** | Modules, controllers, services, guards, interceptors, middleware, DI scopes, routes with HTTP methods |
| **Django** | Apps, models with fields/relationships, views (FBV/CBV), URL routing, admin config, forms, serializers |
| **React** | Components (functional/class), hooks, state management (Redux/Zustand/Recoil), lazy loading, context |
| **Spring Boot** | Components, controllers, services, repositories, endpoint mapping, DI |
| **FastAPI** | Routes with OpenAPI metadata, Pydantic models, dependency injection |
| **Express** | Routes, middleware chains, error handlers |
| **Flask** | Blueprints, routes, decorators |
| **Laravel** | Routes, models, middleware, service providers |
| **Vue.js** | Components, composition API |
| **Angular** | Services, decorators, modules |
| **Jest** | Test suites, cases, mocks, coverage |
| **Cypress** | E2E tests, commands, page objects |

CodeSee has **zero** framework-specific understanding.

### Complete Relationship Graph

**CAS Principle**: The frontend renders what's there, not computes it.

Unravl's CAS output contains:
- All nodes with semantic types
- All edges with relationship types
- Full call graphs with execution context (async, conditional, try-catch)
- Entry/exit points with complete metadata
- Test coverage mapped to code
- Complete flow paths through the system

### Multi-Perspective Analysis

Multiple views of the same codebase:

| Perspective | Purpose |
|-------------|---------|
| Structure | File and module organization |
| Flow | Data and control flow |
| Deployment | Infrastructure and runtime |
| Data | Schema and data relationships |
| Security | Access controls and boundaries |
| Custom | Framework-specific views |

CodeSee offers one view: file dependencies.

### Intelligence Layer

Capabilities no competitor offers:

**Intent Inference**
- WHY does this code exist?
- Derived from: commits, PRs, comments, pattern deviations
- Enables: explaining code purpose to non-technical stakeholders

**Change Risk Assessment**
- How risky is modifying this code?
- Factors: caller count, critical path involvement, test coverage, stability
- Enables: prioritizing code review effort

**Critical Flow Detection**
- Which paths are business-critical?
- Integration: payment flows, auth flows, data pipelines
- Enables: ensuring critical paths have proper coverage

**Data Entity Lifecycle**
- Where is data created, read, updated, deleted?
- Transformation tracking through the system
- Enables: data flow visualization, compliance

**Security Boundary Modeling**
- Trust levels propagating through call graph
- Confidence: enforced, assumed, missing
- Enables: security audit visualization

**Temporal Stability**
- Code volatility from git history
- Identifies: stable, evolving, volatile, fragile code
- Enables: risk-aware development

### Visualization System

21+ interactive views with deep drill-down:

| View | Capability |
|------|------------|
| **System Overview** | Tech stack, architecture layers, entry points, health, patterns, tests, critical flows, risks, security |
| **Graph View** | Interactive hierarchical diagram with pan/zoom, three-level expansion, connection visualization |
| **Flow View** | Request journey visualization with entry point, steps, bottlenecks, depth analysis |
| **Domain View** | Capabilities grouped by HTTP method with health tracking |
| **Entry Points** | Sortable/filterable table of all system entry points |
| **Critical Flows** | Call chain analysis with criticality grouping and coverage metrics |
| **Change Risk** | Risk assessment with hotspot detection and impact analysis |
| **Implementation Health** | Code completeness tracking with TODO markers |
| **Patterns** | Design and anti-pattern detection with deviation tracking |
| **Test Overview** | Testing analytics by type, category, coverage |
| **Security Boundaries** | Protection mechanism visualization |
| **Code Stability** | Volatility analysis |
| **Data Entities** | Database models with PII sensitivity |
| **System Capabilities** | Inferred system purposes with evidence |

**Drill-Down Capabilities:**
- System → Domain → Capability → Flow → Node → Connections
- Breadcrumb navigation with instant state restoration
- Node detail panel showing signatures, decorators, incoming/outgoing connections
- Call chain visualization through any selected node

### Runtime Telemetry (The "Living" Part)

Native SDK instrumentation:
- Automatic entry point instrumentation
- Traffic flow streaming to visualization
- Performance hotspot detection
- Error tracking with architectural context
- Live animation of static blueprints

CodeSee requires Datadog/OpenTelemetry and just renders their data. Unravl generates its own telemetry.

### AI Integration (MCP)

**Vision**: Package entire codebase into context for AI coding assistants.

```
MCP Server: unravl-codebase-context
    |
    ├── Resources
    │     ├── architecture://overview
    │     ├── architecture://modules/{name}
    │     ├── architecture://endpoints
    │     ├── architecture://data-flow
    │     └── architecture://tests
    |
    ├── Tools
    │     ├── get_callers(function_id)
    │     ├── get_callees(function_id)
    │     ├── trace_data_flow(entity)
    │     ├── assess_change_risk(node_id)
    │     ├── find_related_tests(node_id)
    │     └── explain_intent(node_id)
    |
    └── Prompts
          ├── architectural_context
          ├── safe_modification_guide
          └── test_coverage_analysis
```

**Use Cases:**

1. **Informed Code Generation**: AI knows the full architecture before writing code
2. **Safe Refactoring**: AI understands downstream impact before changes
3. **Onboarding Assistance**: AI can explain complete system flows

No competitor offers this. This is the difference between giving AI a phone book vs. giving it a map of the city with traffic patterns, building purposes, and relationship networks.

---

## Competitive Comparison Matrix

### Analysis Depth

| Capability | CodeSee | Sourcegraph | CodeScene | Unravl |
|------------|---------|-------------|-----------|--------|
| File dependencies | Full | Partial | Via git | Full |
| Function-level analysis | Basic | Cross-ref | No | Deep (AST) |
| Class relationships | No | Cross-ref | No | Full |
| Inheritance chains | No | Limited | No | Full |
| Call graphs | Basic | References | No | Full + context |
| Framework detection | No | No | No | 12+ frameworks |
| Entry point detection | No | No | No | HTTP, gRPC, GraphQL, CLI, events |
| Exit point detection | No | No | No | DB, API, Queue, Cache |

### Semantic Understanding

| Capability | CodeSee | Sourcegraph | CodeScene | Unravl |
|------------|---------|-------------|-----------|--------|
| Knows "this is a controller" | No | No | No | Yes |
| Knows "this is a service" | No | No | No | Yes |
| Knows "this guards auth" | No | No | No | Yes |
| Knows "this is middleware" | No | No | No | Yes |
| Knows HTTP routes/methods | No | No | No | Yes |
| Knows DI relationships | No | No | No | Yes |
| Knows test types | No | No | No | Yes |

### Intelligence Layer

| Capability | CodeSee | Sourcegraph | CodeScene | Unravl |
|------------|---------|-------------|-----------|--------|
| Intent inference | No | No | Partial | Yes (AI-powered) |
| Change risk scoring | No | No | Hotspots only | Comprehensive |
| Critical flow detection | No | No | No | Yes |
| Data entity lifecycle | No | No | No | Yes |
| Security boundaries | No | No | No | Yes |
| Temporal stability | No | No | Yes | Yes |
| Test gap analysis | No | No | No | Yes |

### Runtime & AI Integration

| Capability | CodeSee | Sourcegraph | CodeScene | Unravl |
|------------|---------|-------------|-----------|--------|
| Native telemetry SDK | No | No | No | Yes |
| Live traffic visualization | Via external APM | No | No | Native |
| Performance hotspots | Via external APM | No | No | Native |
| MCP for AI assistants | No | No | No | Yes |
| AI-powered queries | Basic Q&A | Cody (code-level) | No | Architectural intelligence |

---

## Does Unravl's Vision Beat the Competition?

### Yes. Definitively.

**1. Depth of Understanding**

CodeSee: "Here are your files and which files import which."
Unravl: "Here's your NestJS app with 12 controllers, 47 endpoints, 3 critical payment flows, 2 untested auth paths, and a god-object anti-pattern in UserService."

**2. Framework Awareness**

CodeSee: Treats all code the same regardless of framework.
Unravl: Knows NestJS guards from Django middleware from React hooks. Extracts framework-specific semantics.

**3. Runtime Integration**

CodeSee: Borrows data from Datadog/OpenTelemetry and displays it.
Unravl: Generates its own telemetry, animates its own blueprints, owns the full stack.

**4. AI-Era Positioning**

CodeSee: No AI integration beyond basic Q&A.
Unravl: MCP server gives AI coding assistants complete architectural context. This is the future of development tooling.

**5. Complete Graph Generation**

CodeSee: Frontend infers relationships from file imports.
Unravl: CAS contains the complete relationship graph. Frontend renders, doesn't compute.

**6. Intelligence Layer**

CodeSee: None.
Unravl: Intent inference, change risk, critical flows, security boundaries, data lifecycle, temporal stability.

### The Core Difference

CodeSee asks: "What files exist and what imports what?"
Unravl asks: "What is this system, what does it do, how does it work, what's risky, what's critical, and how can AI help you work with it?"

---

## Competitive Moat

### What Makes Unravl Defensible

1. **Semantic Understanding**: Competitors can't easily add framework awareness - it requires deep domain knowledge and per-framework development

2. **Complete Graph Generation**: Moving computation from frontend to analysis time creates a fundamentally different (and better) architecture

3. **Runtime Integration**: Native telemetry SDK creates data network effects - more users = better traffic patterns = better insights

4. **Intelligence Layer**: Intent inference and risk scoring require ML/heuristics that take time to develop and tune

5. **MCP Integration**: First-mover advantage in "AI-native architecture tools" creates lock-in

6. **Vision Clarity**: "Living blueprint" vs "file map" - the vision enables features competitors haven't imagined

### Why CodeSee's Acquisition Validates Our Approach

CodeSee proved:
1. Market demand exists for code visualization
2. File-level mapping isn't enough to sustain a standalone business
3. Deeper semantic understanding is the gap

Unravl fills exactly that gap.

---

## AI Layer: Deep Intent Inference

### Vision

Move beyond heuristic-based intent inference to LLM-powered understanding. The AI layer analyzes code semantically to answer questions humans actually ask:

- "Why does this function exist?"
- "What business problem does this solve?"
- "What would break if I changed this?"
- "How does data flow through this system?"

### Architecture

```
CAS Output (semantic graph)
        |
        v
  AI Analysis Layer
        |
        ├── Intent Inference Engine
        │     ├── Commit message analysis
        │     ├── Code pattern recognition
        │     ├── Documentation correlation
        │     └── LLM-powered reasoning
        |
        ├── Risk Assessment Engine
        │     ├── Dependency graph analysis
        │     ├── Test coverage correlation
        │     ├── Historical change patterns
        │     └── LLM-powered impact prediction
        |
        └── Natural Language Interface
              ├── "Explain this module"
              ├── "What calls this function?"
              ├── "Show me the payment flow"
              └── "What's the riskiest code to change?"
```

### Capabilities

| Capability | Description | Data Sources |
|------------|-------------|--------------|
| **Intent Synthesis** | Generate human-readable explanations of why code exists | Commits, PRs, comments, code patterns, documentation |
| **Impact Prediction** | Predict downstream effects of changes before they're made | Call graph, test coverage, historical failures |
| **Architectural Narration** | Generate prose descriptions of system architecture | CAS nodes, edges, perspectives, entry/exit points |
| **Risk Quantification** | Score change risk with explanations | Caller count, critical paths, test gaps, churn |
| **Query Interface** | Natural language queries against the codebase | Full CAS graph + LLM reasoning |

### Differentiation

| Tool | AI Capability |
|------|---------------|
| **CodeSee** | Basic AI Q&A over file structure |
| **Sourcegraph Cody** | Code search + generation, no architectural understanding |
| **GitHub Copilot** | Code completion, no system-level awareness |
| **Unravl AI Layer** | Full semantic graph + LLM = architectural intelligence |

The key difference: competitors give AI access to code text. Unravl gives AI access to **semantic understanding** - what the code means, not just what it says.

---

## MCP Integration: AI-Native Architecture

### Vision

> "I want to package an entire codebase into a package of information that could be used to inform something like Claude Code (to an MCP or something like that) so that Claude Code can work on a system with ALL of the context it needs without needing to read every file."

### What This Enables

CAS output becomes an MCP server that AI coding assistants can query. Instead of reading thousands of files, the AI gets:

- Complete architectural understanding
- All semantic relationships
- Entry/exit points with full context
- Framework-specific knowledge
- Test coverage and risk data
- Intent and purpose information

### Use Cases

**1. Informed Code Generation**
```
User: "Add a new endpoint to UserController that returns user preferences"

AI (with MCP context):
- Knows UserController exists at src/users/users.controller.ts
- Knows it uses UserService for business logic
- Knows UserService calls UserRepository
- Knows existing endpoints use AuthGuard
- Knows preferences data lives in user_preferences table
- Generates code that follows existing patterns
```

**2. Safe Refactoring**
```
User: "Refactor the payment processing module"

AI (with MCP context):
- Knows PaymentService has 47 callers
- Knows it's in critical flow for checkout
- Knows 3 tests cover it, but 2 edge cases are untested
- Warns about risk before proceeding
- Suggests incremental approach with test additions
```

**3. Onboarding Assistance**
```
User: "Explain how authentication works in this codebase"

AI (with MCP context):
- Traces from AuthController entry points
- Follows to AuthService, JwtStrategy, UserRepository
- Identifies guards used across controllers
- Explains the complete flow with actual code references
```

### Competitive Advantage

No other tool offers this:

| Approach | What AI Knows |
|----------|---------------|
| **Raw file access** | Text of files, must infer structure |
| **Sourcegraph** | Search results, cross-references |
| **Unravl MCP** | Complete semantic graph, framework understanding, call chains, risk data |

---

## Strategic Roadmap

### Phase 1: Prove the Depth

**Goal**: Demonstrate semantic advantage

| Priority | Item |
|----------|------|
| Critical | Complete core visualization rendering all CAS data |
| High | Change risk scoring |
| High | Temporal stability analysis |
| Medium | Demo with real NestJS/Django/React apps |

### Phase 2: Intelligence Layer

**Goal**: Add AI-powered understanding

| Priority | Item |
|----------|------|
| Critical | AI intent inference engine |
| Critical | MCP server implementation |
| High | Natural language query interface |
| High | Critical flow detection |
| Medium | Risk quantification with explanations |

### Phase 3: Go Live

**Goal**: Animate the static blueprint

| Priority | Item |
|----------|------|
| Critical | Runtime SDK (TypeScript/Node) |
| High | Traffic flow visualization |
| High | Performance hotspot detection |
| Medium | Error tracking integration |
| Medium | Cross-repo linking |

### Phase 4: Enterprise & Scale

**Goal**: Enterprise differentiators

| Priority | Item |
|----------|------|
| High | Security boundary modeling |
| High | Data entity lifecycle tracking |
| High | Additional runtime SDKs (Python, Java) |
| Medium | Library analyzers (ORMs, auth) |
| Medium | Multi-tenant SaaS platform |

### AI Layer Roadmap

| Phase | AI Capability |
|-------|---------------|
| Phase 1 | Basic LLM integration for documentation generation |
| Phase 2 | Intent inference engine, MCP server, natural language queries |
| Phase 3 | Predictive impact analysis, AI-guided refactoring suggestions |
| Phase 4 | Autonomous architectural recommendations, anomaly detection |

---

## Conclusion

**Unravl's vision definitively beats the competition.**

CodeSee mapped files. Unravl maps architecture.
CodeSee borrowed runtime data. Unravl generates its own.
CodeSee had no AI integration. Unravl is AI-native.

The vision of a "living blueprint" that makes any system instantly understandable - with semantic depth, runtime animation, and AI integration - is beyond what any competitor offers or is positioned to offer.

CodeSee's acquisition proves the market exists. Unravl's vision proves what the market actually needs.

---

## Sources

- [CodeSee Homepage](https://www.codesee.io/)
- [CodeSee Codebase Maps](https://www.codesee.io/codebase-maps)
- [CodeSee Function Maps](https://www.codesee.io/function-maps)
- [CodeSee Service Maps](https://www.codesee.io/service-map-visibility)
- [CodeSee Documentation](https://docs.codesee.io/docs)
- [CodeSee Review Maps](https://www.codesee.io/visual-code-reviews)
- [GitKraken Acquires CodeSee](https://www.gitkraken.com/press/gitkraken-acquires-codesee-launches-devex-platform)
- [CodeSee Alternatives - SaaSworthy](https://www.saasworthy.com/product-alternative/35060/codesee-io)
- [Code Visualization Tools Comparison - Swimm](https://swimm.io/learn/code-visualization/visualizing-code-top-7-tools-compared)
- [Best Code Visualization Tools - The CTO Club](https://thectoclub.com/tools/best-code-visualization-tools/)
