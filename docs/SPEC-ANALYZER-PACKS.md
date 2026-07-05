# SPEC — Declarative Analyzer Packs

Status: prototype implemented (engine + 2 proof packs), authoritative for the format/safety model, honest about full-spec gaps (see "Prototype vs full spec" at the end).

## Why this exists

Klauro covers ~150+ languages and ~120+ frameworks/libraries today, each via a
hand-coded `*-analyzer.ts` implementing `BaseAnalyzer`. That does not scale to
the long tail: every proprietary in-house router, every niche framework, every
company's custom `@Endpoint`-style decorator convention would otherwise need
its own PR into `packages/analyzer-core`.

**Analyzer packs** let anyone — Klauro engineers or the community — declare a
new source of CAS facts (routes, entities, edges, DI bindings, roles) as a
YAML file containing tree-sitter queries, with zero code changes and zero
code execution. This is how Klauro's coverage becomes unbounded instead of
gated on a coded-analyzer backlog.

## Relationship to `.klaurorc` conventions (the `custom-conventions` work)

The `custom-conventions` track (`apps/mcp-server/src/klauro-config.ts`,
`KlauroConventions`) lets a single repo declare its own conventions
(`routes`, `entry_points`, `entities`, `di_bindings`, `roles`, `flows`) inline
in `.klaurorc`, matched by **regex/glob/decorator-name** rules against the
already-extracted node graph. It is the fastest, lowest-ceremony tier: no
tree-sitter query authoring, good for "this one repo's oddball router."

Analyzer packs are the **shareable/community generalization of the same
declarative model**, one level up:

| | `.klaurorc conventions` | analyzer packs |
|---|---|---|
| Scope | one repo, inline in `.klaurorc` | any repo; shareable/publishable artifact |
| Matching | regex on names/decorators, glob on files | full tree-sitter AST query |
| Precision | good for simple shapes (`@Endpoint`, `app.register(...)`) | precise for arbitrary AST shapes (nested object literals, chained calls, destructuring) |
| Distribution | not distributed — lives in the repo | packaged, versioned, fetchable (registry tier) |
| Fact vocabulary | `entry_point{kind,method,path,handler}` / `entity{name}` / `edge` / `role` / DI `binding` | **the same fact vocabulary**, reused verbatim |

**Both tiers emit the same CAS facts.** A pack's `emit` mapping targets
exactly the fact shapes `KlauroConventions` already defines
(`entry_point{kind,method,path,handler}`, `entity{name}`, `edge{from,to,type}`,
`binding{token,implementation}`, `role{target,role}`) so downstream consumers
(MCP tools, route tables, entity maps) don't need to know which tier produced
a fact. `.klaurorc` conventions are the **local tier** of this same
declarative model (see "Three load tiers" below) — a project can also point
`.klaurorc` at its own local pack files for AST-precision matching without
publishing anything.

## The pack format

A pack is one `*.pack.yaml` file:

```yaml
pack: koa-routes                # unique id — also the analyzer id + node/edge namespace
name: Koa-style Router Routes   # optional human-readable name
version: "0.1.0"                # optional, informational in this prototype
language: typescript            # typescript | javascript | typescript-javascript

applies_when:                   # evidence gate — REQUIRED evidence, or the pack matches nothing
  dependency: [koa, "@koa/router"]     # any of these in package.json deps
  file: ["**/*.route.ts"]              # any of these globs must match a file
  import: ["from ['\"]koa['\"]"]       # any of these regexes must match an import/require line

rules:
  - name: route-call
    query: |                    # a tree-sitter query S-expression, run against the parsed AST
      (call_expression
        function: (member_expression
          object: (identifier) @receiver
          property: (property_identifier) @method)
        arguments: (arguments
          (string (string_fragment) @path)
          (identifier) @handler)
        (#any-of? @method "get" "post" "put" "delete" "patch" "all")
      )
    emit:                        # capture name -> CAS fact field mapping
      - fact: entry_point
        kind: http
        method: "@method"        # "@x" = substitute capture x's matched text
        path: "@path"
        handler: "@handler"
```

### `applies_when` — evidence-gated, never speculative

A pack with **no** evidence (no matching dependency/file/import) contributes
**nothing**, exactly like a coded analyzer's `canAnalyze()` returning `false`.
If `applies_when` is entirely omitted, the pack has no gate at the pack level
but is *still* evidence-gated at the rule level: a query that finds zero
matches in the repo emits zero facts. Packs never fabricate a fact that isn't
backed by a real AST match in real source (see `pack-analyzer.test.ts`:
*"never fabricates facts when applies_when finds no evidence"*).

### `rules[].query` — the tree-sitter query

One rule = one tree-sitter query string, executed via the SAME vendored
tree-sitter WASM path every other Klauro analyzer already uses
(`queryWasm()` in `packages/analyzer-core/src/analyzer/core/wasm-tree-sitter.ts`,
backed by `tree-sitter-wasms`' prebuilt `tree-sitter-typescript.wasm` /
`tree-sitter-javascript.wasm`). No new parsing stack, no new grammar-loading
path — packs get exactly the same grammar coverage the generic breadth walker
and the 150+ language specs already have.

Queries are grounded, not guessed: every capture name a rule declares (e.g.
`@method`, `@path`, `@handler`) must correspond to something the real grammar
actually produces for the target syntax shape. The two proof packs below were
authored by dumping the real AST for representative source (see "Proof" for
the exact node shapes) — the same "ground before you ship" discipline
`language-spec.ts`'s `LANGUAGE_SPECS` table documents for the 150+-language
breadth engine.

Predicate helpers (`#eq?`, `#any-of?`, etc.) and "helper" captures used only
to anchor a match (e.g. `@_call`, `@_mkey` in the Hapi pack, prefixed with
`_` by convention) are fully supported — tree-sitter's query engine handles
them natively; the pack engine does not special-case predicates at all, it
just calls `.query()` and reads back `.captures()`.

### `rules[].emit` — capture → fact mapping

Each `emit` entry declares which CAS fact kind a rule match produces and how
to fill its fields from captures:

| `fact` | CAS shape produced | required fields |
|---|---|---|
| `entry_point` | `CASEntryPoint` (`type`, `trigger.method/path`, `handler.method_name`) | `kind`; needs `path` or `handler` to resolve |
| `entity` | `CASNode` (arbitrary `node_type`) | `name` |
| `edge` | `CASEdge` | `from`, `to`, `type` — both endpoints must resolve to an already-emitted `entry_point`/`entity` name in the SAME analysis run, or the edge is dropped |
| `binding` | a `binds` edge between two already-emitted entity nodes | `token`, `implementation` |
| `role` | a tag (`role:<label>`) attached to an already-emitted node | `target`, `role` |

Field values are either a literal string or `"@captureName"` — substituted
with that capture's matched source text for the current match. A template
referencing a capture the query did **not** actually produce for a given
match resolves to `undefined` and the fact field is dropped (or, for a
required field, the whole fact is skipped) — evidence-first, matching
`validateConventions`'s posture in `klauro-config.ts` ("a declared convention
that matches nothing real emits nothing").

## The safety model — packs are pure data

**No code execution, ever.** A pack file contains:
- YAML data (parsed with `js-yaml`'s `CORE_SCHEMA` — plain JSON-shaped values
  only, no custom type constructors, no `!!js/function` or similar tags);
- a tree-sitter query string, which is DATA fed to `Language.query()`, not
  code — tree-sitter's query language is a declarative pattern-matching
  S-expression grammar with no side-effecting constructs;
- string templates (`"@capture"` / literals) resolved by simple substitution,
  not `eval`'d or interpolated into any executed context.

This means a community-authored (even adversarial) pack can, at worst:
- fail schema validation (clear, field-specific error, pack simply doesn't load);
- have a query that fails to compile (`PackQueryError`, scoped to that one
  rule — every other rule/pack keeps running; see
  `pack-analyzer.test.ts`: *"degrades a bad tree-sitter query to a
  rule-scoped error, not a crash"*);
- match nothing (produces zero facts);
- match something real and produce a fact that's simply low-quality/wrong —
  never a fact fabricated from nothing, and never arbitrary code running in
  the analysis process.

This is the entire reason the format is declarative rather than
"write a JS plugin file": a plugin model would need sandboxing, permission
scoping, and a trust story per author. A pure-data model needs none of that —
the worst case is a bad or empty analysis, not a compromised analyzer host.

## Three load tiers

1. **Built-in bundled** — packs shipped inside `analyzer-core` itself
   (`packages/analyzer-core/src/analyzer/packs/examples/*.pack.yaml`). These
   ship with every install, same trust level as a coded analyzer.
2. **Local project tier** — a project's own pack files, declared via
   `.klaurorc` (planned field, not yet wired into `KlauroConfig` in this
   prototype — see "Prototype vs full spec"). Conceptually: `packs: ["./klauro-packs/*.pack.yaml"]`
   resolved relative to the project root. This is the peer of `.klaurorc conventions`
   — a repo can express the SAME kind of custom router either as inline
   regex conventions (fast, low ceremony) or as a local pack (AST-precise).
3. **Community registry** — packs published to a registry and fetched by
   `pack` id + version (NOT implemented in this prototype; design below).

**Precedence**: local > built-in on `pack` id collision (`pack-loader.ts`'s
`loadPacksForProject` — local packs override a built-in of the same id, the
same "most specific wins" posture as `.klaurorc` overriding defaults).
Registry packs, once implemented, would sit between built-in and local
(a project can always override a registry pack locally).

## Registry / distribution design (not implemented — design only)

Reuses the existing hosted-tarball infrastructure documented in
`klauro-distribution-release.md` (curl|sh installer, `dist/latest.json`,
`release.sh` bump→pack→upload→tag) rather than inventing a new distribution
channel:

- A pack registry entry is `{ pack_id, version, sha256, tarball_url }`,
  published the same way CLI releases are today (`mcp.klauro.com/packs/<id>/<version>.tar.gz`
  + a `packs/latest.json` index, mirroring `dist/latest.json`).
- **Fetch**: `klauro pack add <id>[@version]` downloads the tarball, verifies
  its sha256 against the registry index (integrity — not yet authenticity),
  and drops the `.pack.yaml` into the project's local pack directory. This
  makes every registry pack a **local-tier** pack once fetched — there is no
  "trust the network at analysis time" step; analysis always runs off the
  already-fetched, already-validated file on disk.
- **Signing** (future hardening, not in this prototype): sign each published
  tarball with the same key management `release.sh` already touches, and
  verify the signature at fetch time — because a pack cannot execute code,
  the integrity bar is "don't silently swap someone's expected query for a
  different one," not "don't run malware," which lowers how urgent signing is
  relative to a code-plugin model.
- **Versioning**: packs are versioned independently of Klauro itself (a pack
  targeting `koa@2.x`'s route-registration shape doesn't change when Klauro
  ships a new release) — `version` in the pack YAML is the pack's own semver.

## Migration path — coded analyzers → packs

Not every coded analyzer should migrate: analyzers that need multi-file
resolution, cross-file state (Express's nested-router prefix composition,
Hono's mount-prefix resolution), or non-AST evidence (package.json field
inspection beyond `applies_when`, OpenAPI file parsing) exceed what a
single-file tree-sitter query rule can express in this prototype. Good
migration candidates are **single-call-shape route/entity registrations** —
exactly the shape both proof packs below demonstrate. The `koa-routes` pack
is a direct existence proof: it reproduces the same fact shape Klauro's
hand-coded Express analyzer's simplest case produces
(`app.<method>('<path>', handler)` → `entry_point{kind:'http', method, path, handler}`),
from pure declaration.

## Engine implementation

`packages/analyzer-core/src/analyzer/packs/`:

- `pack-schema.ts` — Zod schema (`PackSchema`) + `validatePack()`. Every
  validation failure returns field-path-qualified error strings
  (`"rules.0.emit: rule must have at least one \"emit\" entry"`), never throws.
- `pack-loader.ts` — `loadPacksForProject()` finds and parses `*.pack.yaml`
  files across the built-in/local tiers, validates each, and reports
  per-file errors without failing the whole load.
- `pack-query-runner.ts` — `runPackQuery()` calls `queryWasm()` (the existing
  vendored tree-sitter path) and groups the flat capture list tree-sitter
  returns into per-match capture sets, so a rule matching N call sites in one
  file resolves N independent fact instances, not one merged blob. Grouping
  is anchor-based (the first-seen capture name marks a new match boundary) —
  exact for the non-quantified capture shapes this prototype supports (see
  "Prototype vs full spec").
- `pack-fact-mapper.ts` — `mapMatchToFacts()` resolves `"@capture"` templates
  against one match's captures and produces typed intermediate `MappedFact`
  objects (`entry_point` / `entity` / `edge` / `binding` / `role`), dropping
  any fact whose required fields don't resolve.
- `pack-applies-when.ts` — `evaluateAppliesWhen()` checks dependency/file/import
  evidence before a pack's rules run at all.
- `pack-analyzer.ts` — `PackAnalyzer extends BaseAnalyzer`. One analyzer
  instance loads and runs **every** applicable pack (packs don't need their
  own `BaseAnalyzer` subclass — that's the whole point). Converts `MappedFact`s
  into real `CASNode`/`CASEdge`/`CASEntryPoint` objects using the same
  `createNodeBuilder`/`createEdge`/`createEntryPoint`/`generateNodeId` helpers
  every coded analyzer uses, so pack-sourced facts are indistinguishable in
  shape from hand-coded-analyzer facts (tagged `pack:<id>` for traceability).

### Wiring into the orchestrator (additive)

`PackAnalyzer` registers exactly like any other analyzer — one
`registerAnalyzer({ id: 'analyzer-packs', type: 'pattern', analyzer: new PackAnalyzer(), ... })`
call alongside the existing 150+ registrations in
`apps/mcp-server/src/analyzer.ts`. It does not touch `orchestrator.ts` at
all: the orchestrator has no concept of "packs," it just runs another
`BaseAnalyzer`. This is intentionally the smallest possible integration
surface — the analyzer-packs track owns new files only, per the fabric
coordination note in this session's task brief. (Not yet wired in this
prototype pass, since `apps/mcp-server/src/analyzer.ts` is outside this
track's claimed paths and several fabric peers are touching that
registration list concurrently — see "Prototype vs full spec.")

## Proof — 2 example packs, real facts on real fixtures

Both packs live in `packages/analyzer-core/src/analyzer/packs/examples/` and
are proven end-to-end in `pack-analyzer.test.ts` (run via `node:test`, see
`npm run test:node` in `packages/analyzer-core`).

### Proof pack 1 — `koa-routes.pack.yaml` (migrating a coded-analyzer-equivalent shape)

Fixture (`routes.ts`, deps: `koa`, `@koa/router`):
```ts
router.get('/users/:id', getUserHandler);
router.post('/users', createUserHandler);
```

AST grounding (dumped from the real `tree-sitter-typescript` grammar):
```
(call_expression
  function: (member_expression object: (identifier) property: (property_identifier))
  arguments: (arguments (string (string_fragment)) (identifier)))
```

Real facts emitted (verified in the test, not asserted from documentation):

| method | path | handler |
|---|---|---|
| get | `/users/:id` | `getUserHandler` |
| post | `/users` | `createUserHandler` |

Ground truth = 2 routes in the fixture; the pack produced exactly 2
`entry_point` facts, each with the correct method/path/handler — 100% match,
zero fabrication, zero omission.

### Proof pack 2 — `hapi-routes.pack.yaml` (community pack for an un-coded framework)

Klauro has NO coded Hapi analyzer. Hapi registers routes as an object literal
(`server.route({ method, path, handler })`), a shape a regex analyzer would
need bespoke parsing logic for.

Fixture (`server.ts`, dep: `@hapi/hapi`):
```ts
server.route({ method: 'GET', path: '/items/{id}', handler: getItemHandler });
server.route({ method: 'POST', path: '/items', handler: createItemHandler });
```

AST grounding:
```
(call_expression
  function: (member_expression object: (identifier) property: (property_identifier)))
  arguments: (arguments (object (pair key: (property_identifier) value: (string ...))
                                 (pair key: (property_identifier) value: (string ...))
                                 (pair key: (property_identifier) value: (identifier)))))
```

Real facts emitted:

| method | path | handler |
|---|---|---|
| GET | `/items/{id}` | `getItemHandler` |
| POST | `/items` | `createItemHandler` |

Ground truth = 2 routes; the pack produced exactly 2 `entry_point` facts,
correct in every field, with **zero engine code changes** — proving the
declarative model actually covers a framework Klauro doesn't otherwise know
about, purely from a `.pack.yaml`.

**Cross-gating verified**: running the Koa pack's fixture produces zero Hapi
facts and vice versa (`applies_when` correctly isolates each pack to repos
with real evidence of that framework) — see
`pack-analyzer.test.ts`: *"Cross-gating: the Koa pack must NOT fire on a
Hapi-only repo."*

## Prototype vs full spec — honest scope

**What actually works today (this session):**
- Pack schema + validation (good/bad packs, clear field-path errors).
- Loader for built-in + arbitrary local pack directories (via
  `PackAnalyzer.localPackGlobs`, tested).
- Tree-sitter query execution against real parsed TS/JS source via the
  existing vendored WASM path.
- `applies_when` evidence gating (dependency/file/import).
- `entry_point` fact emission end-to-end, proven on 2 real packs/fixtures.
- `entity`/`edge`/`binding`/`role` fact emission is implemented in the mapper
  and analyzer (`pack-fact-mapper.ts`, `pack-analyzer.ts`'s `emitFact()`) but
  **not yet proven on a dedicated example pack** — only `entry_point` has an
  end-to-end fixture proof in this pass. Treat `entity`/`edge`/`binding`/`role`
  as implemented-but-unproven until a follow-up pack exercises them.
- Bad-query and bad-schema failure paths are proven non-crashing.

**Explicitly NOT done, by design, in this pass:**
- **`.klaurorc` wiring**: `KlauroConfig` does not yet have a `packs: string[]`
  field pointing at local pack globs — `PackAnalyzer.localPackGlobs` exists
  and is tested, but nothing yet reads it from `.klaurorc`. This is the
  natural next slice and is a `custom-conventions`-track-adjacent change
  (that track owns `klauro-config.ts`), which is why it's left as a
  documented gap rather than an edit to a file another in-flight peer is
  actively changing.
- **Orchestrator registration**: `PackAnalyzer` is not yet added to the
  `registerAnalyzer(...)` list in `apps/mcp-server/src/analyzer.ts`. That file
  is a long shared registration list many fabric peers append to
  concurrently; the analyzer itself is complete and covered by its own tests,
  and wiring in one `registerAnalyzer` call is a small, safe follow-up once
  this track's `git status` is otherwise clean to merge.
- **Community registry fetch/verify**: design only (see above); no
  `klauro pack add` command, no registry server endpoint, no signing.
- **Multi-language packs beyond TS/JS**: schema supports only
  `typescript`/`javascript`/`typescript-javascript` for now. Any WASM grammar
  `wasm-tree-sitter.ts` already loads (Python, Go, Rust, etc.) is reachable by
  the same `queryWasm()` call — extending `language` to more of them is a
  schema-enum change plus per-language `DEFAULT_EXTENSIONS`, not new engine
  work.
- **Quantified-capture query grouping**: the anchor-based match grouping in
  `pack-query-runner.ts` is exact for queries where every capture name
  appears at most once per logical match (true for both proof packs). A rule
  whose query uses a repeating/quantified capture (e.g. `(x)+ @item`) would
  need real match-boundary tracking from tree-sitter's `.matches()` API
  rather than the current name-position zip; `web-tree-sitter`'s query
  surface in this repo's vendored version exposes `.captures()` but the
  match-grouped API was not verified available — flagged rather than
  silently mishandled.
- **Cross-pack/coded-analyzer dedup**: if both a coded analyzer and a pack
  match the same route, both contribute (duplicate `entry_point` facts with
  different `source_analyzer`). No merge/deconfliction logic exists yet.
