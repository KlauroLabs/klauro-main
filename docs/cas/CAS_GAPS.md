# CAS Analyzer Gaps

## Current State (v1.5.0)

All previously identified gaps have been addressed in CAS v1.5.0. See:
- [v1.5.0 RFP](./v1.5.0-rfp.md) - Detailed specification of fixes
- [SPECIFICATION.md](./SPECIFICATION.md) - Updated spec with new features

### Resolved in v1.5.0

| Gap | Issue | Resolution |
|-----|-------|------------|
| 1 | Class properties not parented | `parent` field now REQUIRED for class members |
| 2 | MikroORM decorator parsing | Handled by TypeScript analyzer decorator extraction |
| 3 | Anonymous function call graph | Anonymous function calls attributed to containing named function |
| 4 | External services noise | JS builtins and stdlib filtered from `external_services` |
| 5 | NestJS DI resolution | Synthetic nodes created for external injectables |
| 6 | Controller base paths missing | `combinePaths()` merges controller + route paths |
| 7 | Guards not applied to entry points | `allGuards` merges class-level + method-level guards |
| 8 | Repository detection without @Injectable | Detection by naming convention and file path |
| 9 | Constructor stub detection | Framework-aware detection (DI constructors valid) |
| 10 | Pattern variation detection | Schema added - **detection not implemented (see Gap 12)** |
| 11 | Class-level edges missing | New `uses`, `depends_on`, `injects` edge types |

### New in v1.5.0

1. **Class Relationship Edges**
   - `uses`: ClassA has method that calls method in ClassB
   - `depends_on`: ClassA receives ClassB via constructor injection
   - `injects`: Module provides ClassB to ClassA
   - `instantiates`: ClassA creates instance of ClassB

2. **Pattern Variations Schema**
   - Track multiple implementations of same pattern
   - Percentage breakdown by implementation style
   - Deviation detection for inconsistent adoption

3. **Enhanced Entry Points**
   - Full paths including controller base paths
   - Merged guards (class + method level)
   - Proper authentication detection

---

## Verification Commands

```bash
# Verify class-level edges exist
cat cas-output.json | jq '[.edges[] | select(.type == "uses" or .type == "depends_on")] | length'

# Verify full HTTP paths
cat cas-output.json | jq '[.entry_points[] | select(.type == "http")] | .[0:3] | .[].trigger.path'

# Verify authentication detection
cat cas-output.json | jq '[.entry_points[] | select(.security.authenticated == true)] | length'

# Verify repository detection
cat cas-output.json | jq '[.nodes[] | select(.type == "repository")] | length'

# Verify pattern variations
cat cas-output.json | jq '.patterns[] | select(.variations)'

# Verify external services filtering (no builtins)
cat cas-output.json | jq '[.external_services[] | select(.name == "Object" or .name == "Array")] | length'

# Verify class member parenting
cat cas-output.json | jq '[.nodes[] | select(.type == "method" and .parent == null)] | length'
```

---

## Open Gaps

### Gap 12: Pattern Catalog Not Specified (Critical)

**Problem:** The CAS spec defines `CASPattern`, `CASPatternVariation`, and `CASPatternDeviation` data structures but does NOT specify:
1. What patterns are defined by the spec
2. Detection criteria for each pattern
3. How to identify variations within patterns
4. Deviation thresholds and severity rules

**Missing from Spec:**

```typescript
// Standard Architectural Patterns
type ArchitecturalPattern =
  | 'mvc'                    // Model-View-Controller
  | 'layered-architecture'   // Presentation/Business/Data layers
  | 'microservices'          // Service decomposition
  | 'modular-monolith';      // Module-based organization

// Standard Design Patterns
type DesignPattern =
  | 'repository'             // Data access abstraction
  | 'service-layer'          // Business logic encapsulation
  | 'controller'             // Request handling
  | 'dependency-injection'   // DI container usage
  | 'factory'                // Object creation
  | 'singleton'              // Single instance
  | 'middleware'             // Request pipeline
  | 'guard'                  // Authorization
  | 'decorator';             // Metadata decoration

// Standard Anti-Patterns
type AntiPattern =
  | 'god-object'             // >1000 lines or >50 complexity
  | 'circular-dependency'    // A -> B -> A
  | 'feature-envy'           // Method uses other class more than own
  | 'data-clump'             // Same data groups repeated
  | 'dead-code';             // Unreachable code

// Variation Detection Rules
interface PatternVariationRule {
  pattern: string;
  variations: Array<{
    id: string;
    implementation: string;
    detection: {
      has_decorator?: string[];      // e.g., ['@Injectable']
      extends_class?: string[];      // e.g., ['Repository']
      naming_pattern?: RegExp;       // e.g., /Repository$/
      file_path_pattern?: RegExp;    // e.g., /\/repositories\//
      uses_library?: string[];       // e.g., ['typeorm', 'mikroorm']
    };
  }>;
  deviation_threshold: number;       // e.g., 0.9 = flag if <90% use preferred
}
```

**Resolution Required:**
1. Add pattern catalog to CAS spec (Section 4.8.1)
2. Define detection criteria for each pattern type
3. Define variation detection rules
4. Define deviation thresholds and severity mapping

---

## Future Enhancements

| Feature | Description | Priority |
|---------|-------------|----------|
| Pattern Detection Spec | Define patterns, criteria, variations in CAS spec | **Critical** |
| Frontend component hierarchy | React components with parent/child relationships | Medium |
| Module boundaries | What's inside each NestJS module | Low |
| Middleware execution order | Guards/interceptors order | Low |
| Data flow types | Track what data flows between calls | Low |
