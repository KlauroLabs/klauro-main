# Custom Conventions

Klauro auto-detects the architecture patterns it recognizes (frameworks,
routers, ORMs, DI containers, ...). Some codebases carry genuinely bespoke,
hand-rolled architecture no auto-detector can infer: a proprietary decorator
router, an internal naming convention for domain entities, a manually wired
dependency-injection helper, or a named business flow that only exists as
tribal knowledge. `conventions:` in `.klaurorc` lets you (or an agent) DECLARE
those patterns, in Klauro's own node/edge vocabulary, so they plug into the
same route_table/entry_points/data_entities/flows emission the built-in
analyzers use — not a parallel, second-class model.

Declarations are **additive**: they never replace auto-detection, and a
declared convention that matches nothing real in the analyzed code emits
nothing (evidence-gated — never fabricated). Check `conventions_applied` on
the CAS output (or ask an agent to check it) to see exactly what each
declaration matched, and why one that didn't match failed to.

## Schema

Add a `conventions` object to `.klaurorc`. Every key is optional; declare only
what you need.

```jsonc
{
  "version": 1,
  "project": { "name": "my-app" },
  // ...existing .klaurorc fields...
  "conventions": {
    "routes": [
      // Decorator-based custom router
      { "decorator": "@Endpoint", "path_arg": 0, "method_arg": 1 },
      // Registration-call-based custom router
      { "kind": "call", "call": "app.register", "method_arg": 0, "path_arg": 1, "handler_arg": 2 }
    ],
    "entry_points": [
      // Any exported symbol in matching files becomes an entry point of `kind`
      { "files": "src/jobs/**/*.ts", "export_matches": "^run", "kind": "cli" }
    ],
    "entities": [
      // Classes matching name_suffix / name_regex / decorator become data entities
      { "name_suffix": "Aggregate" }
    ],
    "di_bindings": [
      // A DI wiring call: token_arg/impl_arg are argument positions or names
      { "call": "provide", "token_arg": 0, "impl_arg": 1 }
    ],
    "roles": [
      // Tag matching nodes with a semantic role (surfaces on the node's tags/metadata)
      { "name_suffix": "UseCase", "role": "use-case" }
    ],
    "flows": [
      // A named, ordered sequence of Class.method steps — feeds get_flow_concepts
      { "name": "Checkout", "steps": ["CheckoutController.validate", "CheckoutController.charge", "CheckoutController.persist"] }
    ]
  }
}
```

### Field reference

- **routes** — either shape:
  - `{ decorator, path_arg?, method_arg?, default_method? }`: matches any
    function/method carrying that decorator. `path_arg`/`method_arg` select
    which decorator call argument (by position or name) is the route path /
    HTTP method; `default_method` is used when `method_arg` is omitted or
    unresolved (defaults to `GET`).
  - `{ kind: "call", call, method_arg, path_arg, handler_arg }`: matches a
    registration call like `app.register(method, path, handler)`. Argument
    resolution for call-based routes currently requires call-site argument
    capture that most analyzers don't yet emit for arbitrary calls — Klauro
    will confirm the call site exists but will not fabricate a route it can't
    read real arguments for (see `conventions_applied` for the reason).
- **entry_points** — `{ files, export_matches, kind }`: `files` is a glob
  (`**`, `*` supported), `export_matches` is a regex tested against the
  export's name, `kind` is any `CASEntryPoint.type` (`cli`, `event`,
  `schedule`, `task`, `pipeline`, ...).
- **entities** — `{ name_suffix?, name_regex?, decorator? }`: at least one
  required. Matching classes become `CASDataEntity` rows.
- **di_bindings** — `{ call, token_arg, impl_arg }`: same call-site-argument
  caveat as call-based routes.
- **roles** — `{ name_suffix?, name_regex?, role }`: tags matching nodes with
  `role` (visible as `tags: ["role:<role>"]` and
  `metadata.attributes.declared_role`).
- **flows** — `{ name, steps }`: `steps` is an ordered array of
  `"Class.method"` or bare `"function"` references. The first resolvable step
  becomes the root of a named entry point; `get_flow_concepts` then walks the
  REAL call graph forward from there, so the ordered contract (Input/Logic/
  Side-effects/Output/Constraints) per step comes from actual code, not the
  declaration.

## Validation and errors

Every convention is validated before it's used — a malformed entry degrades
to a specific, actionable error (not a crash):

```
conventions.entities[0]: must set at least one of "name_suffix", "name_regex", "decorator" to match classes
conventions.flows[0]: "steps" must be a non-empty array of "Class.method" or "function" references, in order
```

`initialize_klauro_project`/hand-edited `.klaurorc` files with invalid
conventions are simply skipped for that analysis run (logged as a warning) —
a config typo never blocks a real analysis. `declare_convention` (see below)
rejects an invalid convention outright and writes nothing.

## Declaring a convention as you work

An agent that discovers a bespoke pattern mid-task can persist it immediately
via the `declare_convention` MCP tool, instead of waiting for a human to hand-
edit `.klaurorc`:

```
declare_convention({
  path: "/abs/path/to/repo",
  kind: "entities",
  convention: { "name_suffix": "Aggregate" }
})
```

This validates the convention, appends it to the matching `conventions[kind]`
array in `.klaurorc` (never overwriting prior declarations), and returns the
full updated `conventions` object plus a `next_step` reminder to re-run
`analyze_codebase` and check `conventions_applied`. `get_klauro_project_config`
always reflects the current declared conventions in its `config.conventions`
field.

## Applying conventions

Conventions are applied automatically on every `analyze_codebase` /
`analyze_codebase_remote` run — no separate step. The applier
(`conventions-applier.ts`) runs deterministically over the already-extracted
nodes/edges, immediately after auto-detection and before route_table/
data_entities/flow computation, so declared facts flow through the exact same
downstream tools (`get_route_table`, `get_data_entities`, `get_flow_concepts`,
...) as anything auto-detected.

## Three real examples

### 1. Custom decorator router

```jsonc
"conventions": {
  "routes": [{ "decorator": "@Endpoint", "path_arg": 0, "method_arg": 1 }]
}
```

Given:

```ts
class OrdersController {
  @Endpoint('/orders', 'GET')
  listOrders() { /* ... */ }
}
```

**Before declaring:** `get_route_table` has no row for `/orders`; the handler
is an ordinary, unremarkable method with no entry point.
**After declaring** (once the decorator's arguments are resolvable — see the
call-site-argument-capture note above): a `GET /orders` row appears in
`get_route_table`, resolved to `OrdersController.listOrders`.

### 2. Custom entity suffix

```jsonc
"conventions": {
  "entities": [{ "name_suffix": "Aggregate" }]
}
```

Given `OrderAggregate` and `CustomerAggregate` classes with no ORM decorator
Klauro recognizes:

**Before:** `get_data_entities` doesn't include them — they're two more plain
classes.
**After:** both appear in `get_data_entities`, each with a
`description_source: "deterministic"` note that they matched a declared
convention.

### 3. Declared flow

```jsonc
"conventions": {
  "flows": [{ "name": "Checkout", "steps": ["CheckoutController.validate", "CheckoutController.charge", "CheckoutController.persist"] }]
}
```

**Before:** these three methods are just a private call chain — no capability
or flow groups them.
**After:** `get_flow_concepts({ target: "Checkout" })` returns a flow named
"Checkout" rooted at `CheckoutController.validate`, with steps traced through
the real call graph (`validate -> charge -> persist`) and each step carrying
its own Input/Logic/Side-effects/Output/Constraints contract.

## How this complements auto-detection (coverage-intel)

A separate, parallel effort (coverage-intel) builds a codebase-type
classifier and self-discovered coverage-gap reporting
(`analyzer/core/coverage-gaps.ts`, `codebase-type.ts`) — it tells you *that*
something in the repo isn't understood (an unrecognized dependency, a
zero-entry-point root, tree-sitter node types no analyzer handles). Custom
conventions are the resolution mechanism for those gaps: once a gap is
identified as "this is actually a bespoke `@Endpoint` router" or "this is our
internal `*Aggregate` convention," a human or agent declares it here and the
gap becomes real, evidence-backed structure instead of a standing unknown.
