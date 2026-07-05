# SPEC — The Coverage Model: Analyzing ANY Codebase

> **Status: SHIPPED core (coded analyzers) + VISION (the other two declarative tiers +
> self-improving gap discovery)**, as of 2026-07-05. Grounded in `docs/mcp/
> ANALYZER-COVERAGE.md`, `docs/CHANGELOG.md` (v1.0.13-v1.0.20 breadth waves), and the fabric's
> currently-active claims (`coverage-intel`, `type-library`, `type-cli`, `type-dataml`,
> `type-infra`, `type-desktop`, `type-game-embedded`, `custom-conventions`, `analyzer-packs` —
> confirmed active via `fab active` at time of writing, 2026-07-05). Peer specs:
> `docs/SPEC-ANALYZER-PACKS.md`, `docs/CUSTOM-CONVENTIONS.md`, `docs/
> COVERAGE-INTELLIGENCE.md` (peers own these; this doc cross-references, does not duplicate).

## 1. The problem this solves

Klauro's value depends on the CAS graph being *true* — entry points, calls, and contracts
that are actually there, not guessed. That is straightforward for the languages/frameworks
with a bespoke, hand-written analyzer. It breaks down for the long tail: a real portfolio of
repos contains CLIs, libraries, data/ML pipelines, infra-as-code, desktop apps, games, and
embedded systems — codebase *types* with fundamentally different entry-point shapes than "web
app with HTTP routes," plus frameworks nobody has written a dedicated analyzer for yet, plus
one-off internal conventions no public framework detector could ever know about. The coverage
model is the layered answer to "how does Klauro stay true across all of that, not just the
frameworks someone happened to build an analyzer for."

## 2. Codebase types and their entry-point models

A web app's entry points (HTTP routes) are not the only shape "the thing that starts
execution" takes. Different codebase types need different entry-point models entirely:

| Type | Entry-point shape | Status |
|---|---|---|
| **Web** | HTTP routes, WebSocket handlers, GraphQL resolvers | SHIPPED — the most mature model (Express/Fastify/NestJS/Spring/Django/Rails/… — see `docs/mcp/ANALYZER-COVERAGE.md`) |
| **Library** | Public API surface (exported functions/classes/types) — no "runtime" entry point at all, the entry point IS the API contract | VISION, in progress — fabric claim `type-library`, targeting `packages/analyzer-core/src/entry-points` |
| **CLI** | Commands/subcommands, argument parsing, exit codes | VISION, in progress — fabric claim `type-cli`, targeting `cli-analyzer.ts` |
| **Desktop** | Window/IPC boundaries (Electron main↔renderer, Tauri commands) | VISION, in progress — fabric claim `type-desktop` |
| **Data/ML** | Pipeline stages, notebook cells, training entry points, scheduled jobs | VISION, in progress — fabric claim `type-dataml`, targeting `frameworks/dataml` |
| **Infra** | IaC resource graphs — Terraform/Kubernetes already exist; Ansible/Pulumi/Helm targeted | VISION, in progress — fabric claim `type-infra` (Terraform + K8s are SHIPPED prior art the claim extends) |
| **Game** | Engine lifecycle hooks (Update/FixedUpdate, scene graph, actor spawn) | VISION, in progress — fabric claim `type-game-embedded`, targeting Unity/Unreal/Godot analyzers |
| **Embedded/systems** | Interrupt handlers, hardware init, main loop | VISION, in progress — same `type-game-embedded` claim, targeting embedded-C/Arduino/Linux-kernel-module analyzers |

Message/queue consumers and scheduled jobs are a cross-cutting entry-point shape already
SHIPPED for web-adjacent backends (`WorkflowAnalyzer` — Celery, Sidekiq, BullMQ, Kafka,
RabbitMQ, NATS, Temporal — and the newer `mediator-cqrs-analyzer.ts`, CQRS/mediator dispatch
resolution, both confirmed live per `~/.klauro/agent-feedback/2026-07-05-cqrs-messaging.md`).

**Honest note:** these seven "type" fabric claims were all active in parallel at the time
this doc was written — treat every VISION row above as "in active development this session,"
not "unstarted." Verify against `docs/CHANGELOG.md`'s next entries and `fab active`/
`analyzer.ts` registration before citing any of them as shipped in future docs.

## 3. Three declarative tiers (how coverage grows without a bespoke analyzer per framework)

Writing a deep, hand-coded TypeScript analyzer per framework does not scale to "any
codebase" — there are thousands of frameworks and countless one-off internal conventions. The
coverage model has three tiers, in order of who can extend it and how fast:

1. **Built-in coded analyzers (SHIPPED).** Hand-written, deep, evidence-gated. Highest
   fidelity; highest build cost; Klauro engineering owns this tier. ~68 live
   major-framework analyzers as of v1.0.20 (`docs/CHANGELOG.md`), plus dedicated
   architecture-defining-library analyzers (ORM/auth/payments/queues/DI/CQRS — `docs/mcp/
   ANALYZER-COVERAGE.md`). This is the tier every SHIPPED claim in this repo's CHANGELOG
   lives in.
2. **Community declarative packs (VISION, in progress).** A YAML + tree-sitter-query engine
   (`packages/analyzer-core/src/analyzer/packs`, fabric claim `analyzer-packs`) so a new
   framework's coverage does not require writing a bespoke analyzer class — a declarative
   pack describes the node shapes (route decorator, handler signature, …) and the engine
   resolves them the same evidence-gated way the coded analyzers do. Lower build cost than
   tier 1, still requires someone to author and validate the pack. Full spec: `docs/
   SPEC-ANALYZER-PACKS.md` (peer-owned).
3. **Local `.klaurorc` conventions (VISION, in progress).** A single repo declares its own
   architecture conventions/entry-point shapes without waiting for a built-in or community
   pack to exist — the escape hatch for genuinely one-off internal frameworks. Fabric claim
   `custom-conventions`, targeting `apps/mcp-server/src/klauro-config.ts` (applied in
   extraction) and `server.ts` (declared as an MCP surface). Full spec: `docs/
   CUSTOM-CONVENTIONS.md` (peer-owned).

Each tier is strictly more accessible and lower-latency than the one above it, at the cost of
some fidelity/vetting — the same tradeoff open-source plugin ecosystems make, applied to
structural analysis instead of runtime behavior.

## 4. Inference + gap-discovery: the self-improving loop

**VISION, in progress** — fabric claim `coverage-intel`, targeting `packages/analyzer-core/
src/analyzer/core/codebase-type.ts` (the codebase-type classifier from §2) and `coverage-
gaps.ts` (the gap-discovery layer).

The idea: rather than silently under-reporting when a file has no resolved entry points/edges
in an otherwise well-covered repo, the classifier should (a) infer the codebase's type from
structural signals (manifest shape, directory conventions, dependency graph) to pick the
right entry-point model from §2, and (b) surface a file/region as an **actionable coverage
gap** — "this file looks like it should have resolved entry points/edges given its neighbors,
but doesn't" — rather than a silent zero. This closes the same class of problem the
freshness/response-budget work already treats as a first-class product concern: an agent
should never be silently told less than the truth without knowing it.

**Honest status:** this is a claimed, in-progress workstream as of this writing, not a
shipped capability. No CHANGELOG entry yet describes `coverage-gaps.ts` landing. Verify its
existence and test coverage directly before citing it as built in any future doc.

## 5. The honest coverage matrix

Three different claims get conflated in casual conversation about "language support." They
are NOT the same:

| Claim | What it means | Current shape |
|---|---|---|
| **Languages that parse** | tree-sitter grammar exists; a generic AST walker can produce SOME structural facts (functions, classes, containment) | ~130 languages (per the language-breadth sessions referenced in the user's memory: `klauro-breadth-158-architecture`, `klauro-breadth-native-stage`) |
| **Frameworks with deep coded analysis** | routes/handlers/DI/ORM/etc. resolved to real entry points and edges, not just generic AST facts | ~10 major languages' majors covered as of v1.0.20 (JS/TS has the deepest, dozens-per-language coverage; other languages have their web/major-framework majors, not exhaustive framework lists — see `docs/CHANGELOG.md` v1.0.20's own honest framing: *"~130 languages parse; the majors now covered for ~10 major languages (not 'dozens per language' — that's JS/TS only)"*) |
| **Codebase types covered** | entry-point MODEL exists for the codebase's actual shape (library/CLI/data-ml/infra/desktop/game/embedded), not just "assume it's a web app" | Web: SHIPPED, mature. The other seven types: VISION, all actively in progress per §2's table — none shipped as of this writing |

**Do not conflate these three rows.** A codebase can parse (row 1) and even have deep
framework analysis for its web layer (row 2) while still being mis-modeled at the type level
(row 3) if it's actually a CLI tool with an incidental HTTP debug server, for example. The
gap-discovery loop (§4) is aimed specifically at catching this kind of mismatch once built.

## 6. Design principle carried from the rest of the product

Every tier here inherits the same cardinal rule that governs the CAS graph itself
(`klauro-deterministic-facts-plus-ai` in the user's standing memory, reflected throughout
`docs/CHANGELOG.md`'s per-analyzer entries): **deterministic structural facts, evidence-gated,
never a bare-keyword/folder-name categorizer.** A declarative pack or a `.klaurorc`
convention is still required to point at real source evidence (an import, a decorator, a
call shape) before it emits a node or edge — the declarative tiers change *who can add
coverage and how fast*, not the evidence standard every fact must clear.

## 7. Cross-references

- `docs/ARCHITECTURE.md` §3 — this model's place in the overall four-layer architecture.
- `docs/mcp/ANALYZER-COVERAGE.md` — the current, concrete list of shipped coded analyzers
  (tier 1).
- `docs/SPEC-ANALYZER-PACKS.md` — peer spec, tier 2 detail.
- `docs/CUSTOM-CONVENTIONS.md` — peer spec, tier 3 detail.
- `docs/COVERAGE-INTELLIGENCE.md` — peer spec, §4 (inference/gap-discovery) detail.
- `docs/CHANGELOG.md` — the ground truth for "which analyzer shipped when"; verify any
  coverage claim against its entries, not against this doc's prose, before repeating it.
