# CAS Analyzer Gaps

## Scope

This document is a historical v1.5.0 gap review. It is not the current CAS version summary. For the active specification, see [SPECIFICATION.md](./SPECIFICATION.md). For current product framing, see [README.md](./README.md).

## Historical State (v1.5.0)

The previously identified v1.5.0 gaps were addressed at the schema/spec level. See:
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
| 10 | Pattern variation detection | Schema added and standard pattern catalog documented |
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

## Resolved Gap

### Gap 12: Pattern Catalog

The active specification now defines a standard pattern catalog in `SPECIFICATION.md` under `Standard Pattern Catalog`. It covers:

1. Standard pattern IDs for repositories, services, controllers, dependency injection, modules, guards, layered architecture, MVC, circular dependencies, and oversized objects.
2. Detection criteria for each catalog pattern.
3. Required variation categories where multiple implementation styles are expected.
4. Deviation severity rules for `info`, `warning`, and `error`.

Analyzers may still emit framework- or language-specific pattern IDs, but common concepts should map back to the standard catalog when possible.

---

## Future Enhancements

| Feature | Description | Priority |
|---------|-------------|----------|
| Pattern Catalog Depth | Add more framework-specific catalog mappings as analyzers mature | Medium |
| Frontend component hierarchy | React components with parent/child relationships | Medium |
| Module boundaries | What's inside each NestJS module | Low |
| Middleware execution order | Guards/interceptors order | Low |
| Data flow types | Track what data flows between calls | Low |
