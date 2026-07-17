# The Uniform Understanding Contract (ICELOT)

Every unit of a codebase Klauro understands — a **function/node**, a **step**, a
**flow**, on up to a **capability** — carries the *same* contract shape.
**ICELOT is not an execution order; it's the six questions asked of every unit:**

> **I**nput — what does it take? · **C**onstraints — what bounds it? ·
> **E**ffects — what does it touch? · **L**ogic — how does it decide? ·
> **O**utput — what does it emit? · **T**elemetry — how does it behave?

Contract surface (**I, C**) → impact surface (**E**) → internal behavior
(**L, O**) → observable runtime behavior (**T**). The answer comes back in the
same six facets at every level — the middle of the level-drilling path
(`get_summary` → `get_flow_concepts` → `get_coding_context`).

The model name lives in exactly one place — the exported constant
`CONTRACT_MODEL_NAME` (value **`ICELOT`**) in
`packages/analyzer-core/src/analyzer/core/flow-concepts.ts` — so it is trivially
renamable. The facet list is the exported `UNDERSTANDING_CONTRACT_FACETS`.

## The cardinal rule: EVIDENCE-GATED, never fabricated

A facet is populated **only** from a fact the analysis already extracted. When
no supporting fact exists, the facet is **omitted** (or empty), never invented,
never zero-filled. Constraints carry their driving evidence string; telemetry
appears only when real runtime observations correlate to the unit. If you see a
facet, a concrete fact produced it.

## The six facets

| # | Facet | Question | Derived from |
|---|-------|----------|--------------|
| I | **Input** | What does it take? | signature params, `data_lineage` reads, consumed request shape |
| C | **Constraints** | What bounds it? | validation, auth, rate-limit, error, invariant, business-rule, consistency facts |
| E | **Effects** | What does it touch? | `exit_points` + `data_lineage`, **split two ways** (below) |
| L | **Logic** | How does it decide? | the ordered step/function names |
| O | **Output** | What does it emit? | signature return types, produced entities/responses |
| T | **Telemetry** | How does it behave? | joined runtime metrics, when observations exist |

### The Effects facet — system effects, split

`side_effects` is deliberately **two lists**, because "writes the DB" and "calls
Stripe" are different risks:

- **`state_changes`** — DB / cache / file writes, entity mutations
  (`exit.type ∈ {database, cache, file}`, `data_lineage` writers).
- **`external_integrations`** — outbound calls: http-client, SOAP, messaging
  produce, SDK/webhook exits, external data-lineage recipients.

### Facet 5 — Constraints, first-class

Each constraint is a `{ kind, rule, evidence }` record (not a bare string), so
an agent can both *honor* it and *trace why it holds*. `kind` is one of:

| kind | source | example rule |
|------|--------|--------------|
| `validation` | validation-schema analyzer → `entry_point.input.validation` | `total must be a positive number` |
| `auth` | auth analyzer → `entry_point.security` | `caller must be authenticated`, `guarded by: OrganizationGuard` |
| `rate-limit` | entry-point rate-limit facts, when surfaced | `rate limited: 100/min` |
| `error` | error contracts (`get_error_contracts`) | (failure modes / uncaught paths) |
| `invariant` | `data_entities[].invariants` / behavioral invariants enforced by a node here | `order total must be positive` |
| `business-rule` | guard clauses in the unit's own source (`require`/`assert`/`if…throw`) | `must hold: order.status === "PENDING"` |
| `consistency` | `consistency_model` — a staleness-risky store this unit reads, or a passive seam it consumes | `reads from aurora-replica are eventually consistent (AP) — may observe stale data` |

The **consistency** kind is the subtle one: "reads here may be eventually
consistent / stale" is a real *correctness* constraint, not a hint. It fires
only when the unit's own exit point reads a store the consistency model tagged
`staleness_risk`, or when the unit is the reader side of a passive
replica/CDC/sink/materialized seam.

### Facet 6 — Telemetry, joined

`contract.telemetry` is a compact projection of the per-node runtime rollup
(`buildNodeRuntimeMetrics`): `request_count`, `error_rate`, `p50/p95/p99_ms`,
`status_code_distribution`, `source`, `last_seen`. It is **joined at the query
layer** (where persisted observations live), not by the pure static analyzer —
so `computeFlowConcepts` stays a pure pass over the CAS, and the telemetry
facet is simply **absent** when no observation matches the unit.

## Where to get it

- `get_flow_concepts` — the full 6-facet contract per **flow** *and* per **step**.
- `get_coding_context` — the contract (including the telemetry facet) for one
  resolved **node**.

## Worked example — `POST /web/gateway` (reference NestJS monorepo)

Analyzed live via `analyzeForBench`. The "Gateway" flow grounds every facet in
real evidence:

```jsonc
{
  "name": "Gateway",
  "entry_point": "entry_route_..._createUnified_post___ee7f50d6",
  "entities": ["User", "License", "Network", "Gateway"],
  "contract": {
    // 1. INPUT — params + entity reads
    "input": [
      "user: AuthenticatedUser", "createGatewayDto: CreateGatewayDto",
      "organizationId: string", "networkName: string",
      "reads Network", "reads Gateway", "reads User", "reads License"
    ],
    // 3. LOGIC — ordered steps
    "logic": "Persist Network -> Process Network -> Persist User",
    // 4. SYSTEM EFFECTS — split
    "side_effects": {
      "state_changes": ["database", "Gateway updated", "User updated", "Network updated"],
      "external_integrations": ["sdk:Call to validate", "curl", "MikroORM", "@app/auth", "..."]
    },
    // 2. OUTPUT — real DTOs
    "output": ["Promise<Gateway>", "Promise<Network>", "Promise<Gateway | null>", "..."],
    // 5. CONSTRAINTS — first-class, each with evidence
    "constraints": [
      { "kind": "auth", "rule": "caller must be authenticated",
        "evidence": "entry point \"POST /web/gateway\" security.authenticated=true" },
      { "kind": "auth", "rule": "guarded by: OrganizationGuard",
        "evidence": "entry point \"POST /web/gateway\" security.guards" },
      { "kind": "auth", "rule": "guarded by: ImpersonationGuard", "evidence": "..." },
      { "kind": "auth", "rule": "guarded by: GlobalAuthGuard", "evidence": "..." }
    ],
    // 6. TELEMETRY — joined from real observations
    "telemetry": {
      "static_id": "method_class_...GatewayWebController_0_createUnified_3",
      "request_count": 8423, "error_rate": 0.011,
      "p50_ms": 12, "p95_ms": 78, "p99_ms": 210,
      "status_code_distribution": { "200": 8330, "400": 60, "500": 33 },
      "source": "ingested", "last_seen": "2026-07-05T12:00:00.000Z"
    }
  }
}
```

And a unit with nothing to say stays honest — a step with no guards and no
runtime data omits both facets entirely:

```jsonc
{ "step": "Process User", "constraints": [], /* no `telemetry` key at all */ }
```
