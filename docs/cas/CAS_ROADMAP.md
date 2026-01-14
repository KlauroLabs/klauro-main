# CAS Analyzer Roadmap

## Current State (v1.2.0)

### Working Features
- Language analyzers: TypeScript/JavaScript, Python, Java, C#, Go, Rust, PHP
- Framework analyzers: NestJS, Express, React, Vue, Angular, Django, Flask, FastAPI, Laravel, Spring Boot
- Testing analyzers: Jest, Cypress
- Entry/exit point detection
- Call graph generation (97.9% valid edges)
- Architecture summary generation
- Route table extraction
- Database schema detection (entity-level)
- External services inventory
- Summary output format (30KB vs 26MB full)

### Known Limitations
- Database schema extraction only detects entities, not fields/relationships (requires ORM-specific decorator parsing)
- External services detection groups console/path as SDKs (need better filtering)
- No library-specific analyzers for deeper integration analysis

---

## Roadmap

### v1.3.0 - Library Analyzers

**Goal**: Add per-library analyzers for deeper analysis of common dependencies.

#### ORM Analyzers
```
backend/src/analyzer/libraries/orm/
  mikro-orm-analyzer.ts
  typeorm-analyzer.ts
  prisma-analyzer.ts
  sequelize-analyzer.ts
```

**MikroORM Analyzer Features**:
- Parse `@Entity()` decorator for table names
- Extract `@Property()` fields with types, nullable, default
- Detect `@PrimaryKey()`, `@Unique()` constraints
- Map `@ManyToOne()`, `@OneToMany()`, `@ManyToMany()` relationships
- Extract `@Index()` definitions
- Detect eager/lazy loading configuration

**TypeORM Analyzer Features**:
- Similar to MikroORM with TypeORM-specific decorators
- `@Column()`, `@Entity()`, `@JoinColumn()`, etc.

**Prisma Analyzer Features**:
- Parse `schema.prisma` file
- Extract models, fields, relations
- Detect indexes and constraints

#### AI/ML Library Analyzers
```
backend/src/analyzer/libraries/ai/
  openai-analyzer.ts
  anthropic-analyzer.ts
  langchain-analyzer.ts
```

**Features**:
- Detect API usage patterns (chat, embeddings, completions)
- Extract model configurations
- Identify prompt templates
- Map AI calls to exit points

#### Auth Library Analyzers
```
backend/src/analyzer/libraries/auth/
  passport-analyzer.ts
  auth0-analyzer.ts
  clerk-analyzer.ts
```

**Features**:
- Detect authentication strategies
- Map protected routes
- Extract OAuth provider configurations

### v1.4.0 - Cross-Repository Analysis

**Goal**: Enable linking multiple CAS outputs to understand microservice architectures.

**Features**:
- API contract matching (OpenAPI specs)
- Message broker integration (Kafka, RabbitMQ topics)
- Shared database detection
- Service mesh mapping

### v1.5.0 - Query Interface

**Goal**: Provide a CLI/API for querying CAS output without loading the full graph.

**Commands**:
```bash
cas query "show architecture"          # Summary view
cas query "list endpoints"             # Route table
cas query "trace POST /workspaces"     # Call chain from entry point
cas query "show entity User"           # Entity details
cas query "what calls UserService"     # Reverse dependency
```

### v2.0.0 - Telemetry Integration

**Goal**: Animate the static graph with runtime data.

**Features**:
- Runtime call frequency overlay
- Performance hotspot detection
- Error rate visualization
- Traffic flow animation

---

## Implementation Priority

| Priority | Feature | Value | Effort |
|----------|---------|-------|--------|
| 1 | MikroORM Analyzer | High (database schema) | Medium |
| 2 | TypeORM Analyzer | High (database schema) | Medium |
| 3 | OpenAI/Anthropic Analyzer | Medium (AI integrations) | Low |
| 4 | Passport Analyzer | Medium (auth patterns) | Low |
| 5 | Query Interface | High (usability) | High |
| 6 | Cross-Repository | High (microservices) | High |

---

## Architecture for Library Analyzers

Library analyzers should:
1. Register with the orchestrator like framework analyzers
2. Detect based on package.json/imports
3. Run AFTER framework analyzers (to enhance existing nodes)
4. Focus on adding metadata/relationships rather than new nodes

```typescript
interface LibraryAnalyzerRegistration {
  id: string;
  name: string;
  type: 'library';
  detectPatterns: {
    dependencies: string[];  // npm package names
    imports?: RegExp[];      // import patterns
  };
  enhances: string[];        // analyzer IDs this enhances
  analyzer: BaseAnalyzer;
}
```

Example registration:
```typescript
{
  id: 'mikro-orm',
  name: 'MikroORM Analyzer',
  type: 'library',
  detectPatterns: {
    dependencies: ['@mikro-orm/core', '@mikro-orm/postgresql']
  },
  enhances: ['typescript-javascript', 'nestjs'],
  analyzer: new MikroORMAnalyzer()
}
```
