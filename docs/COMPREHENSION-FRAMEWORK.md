# The Comprehension Framework

**Status:** working framework, revised after hand-validation against four real
repositories (a Go feed reader, a browser extension, a browser action-RPG, and
Klauro itself). Companion to `SEMANTIC-MODEL.md` (what the layers mean),
`UNDERSTANDING-MODEL.md` (ICELOT), `SPEC-ABSTRACTION-TIERS.md` (what may consume
what). Those define the model. **This defines how to derive one, and how to tell
a good answer from a bad one.**

Written because the existing docs state tests to apply *after* a candidate
exists, and say almost nothing about where candidates come from. An
implementation built from them becomes filter-heavy: it generates structurally,
rejects what fails the tests, and — measured on Klauro's own repository,
2026-08-26 — publishes `0 of at least 5 required capabilities`. Filtering cannot
turn a list of mechanisms into a list of outcomes. It can only delete.

---

## 1. Four members, four questions

| Member | Question | One word |
|---|---|---|
| **Capability** | Why does this system exist? | purpose |
| **Flow** | How does it deliver that? | behaviour |
| **Step** | What happens along the way? | action |
| **Entity** | What does it hold and change? | subject |

Journeys and workflows are **projections of flows**, not a fifth member
(`SPEC-ABSTRACTION-TIERS.md` §D).

Two things are deliberately **not** members and need their own homes: **system
qualities** (§8) and the **dispatch mechanism** (§6).

---

## 2. The derivation direction problem

Every observed defect is an instance of this.

**Bottom-up alone reliably produces mechanisms.** Cluster code into steps, group
into flows, name the groups — and you get the names of what you clustered.
Observed on Klauro analysing itself: 51 candidates became `Run Analysis Layer`,
`Get Freshness`, `Get Focus Profiles`. Those are MCP tool names, because the
generator anchored on entry points and this system's entry points *are* tools.

**Top-down alone produces fiction** — capabilities the code never implements.

**The altitude trap.** Moving up from mechanism does not automatically reach
purpose. There is an intermediate rung — the *artifact* — that feels like a
product answer and is not: "produces a relationship graph", "issues a claim
record". Easy to land on precisely because it is one honest step above the code.

### The procedure

```
1. PROPOSE from the product's own words   (README title/overview, manifest
                                           description, route + UI terminology)
   ...then apply the altitude ladder to THOSE WORDS TOO (§2.1)
2. GROUND each proposal in structural facts (entry points, termini, effects,
                                           dependency roles)
3. ARBITRATE with terminality              (outcome vs prerequisite — §7)
4. DEGRADE in confidence, never existence  (§9)
```

Propose from purpose, then ground. Not: generate structurally, then filter.

A proposal that cannot be grounded is a **documented gap** — the product claims
something the code does not show. That is a finding, not something to drop.

### 2.1 Where the product's own words live

In priority order, and **not only the README**:

| Source | Quality | Note |
|---|---|---|
| **PRD / spec document** | highest | states capabilities in product language |
| README title + overview | high | but see §2.2 |
| Manifest `description` | high | one line, usually outcome-shaped |
| Domain document *filenames* | medium | `LIQUIDATIONS.md`, `MAP_AND_ADVENTURE_MODE.md` |
| **Agent instruction files** | medium | `CLAUDE.md`, `AGENTS.md` — operating rules that reveal domain |
| Route / UI / journey terminology | medium | the words shown to users |
| Directory names at the product layer | low | `airdrop_farm`, `alpha_engine` |

**A scaffold README is worse than no README** — it produces a confident wrong
answer instead of an honest gap. Most projects never replace their framework's
starter file:

> `admin-portal-ui/README.md`: *"React + TypeScript + Vite. This template provides
> a minimal setup to get React working in Vite with HMR and some ESLint rules."*

Proposing from that yields "set up React with Vite and HMR" — the **scaffold
generator's** purpose, not the product's.

**Detect it structurally, never with a template blocklist:** measure the
**vocabulary overlap between the README and the code's domain nouns**. A README
about Vite, HMR and ESLint over a codebase about devices, tenants and orders has
a near-zero intersection and is not about this product. Demote it below directory
names and fall through. This generalises to every framework's starter text,
including ones that do not exist yet.

**A repository with no README is common and not a blocker.** Fall through the
list. A trading system with no README still declares itself through
`STRATEGIES.md`, `KALSHI_EVENTS.md`, and `TEN_K_CASHFLOW_PLAN.md`.

**A PRD is the best source and introduces the most valuable output.** It states
what was *intended*; grounding shows what was *built*. The difference is a
first-class finding:

> "The PRD claims 6 capabilities. 4 are implemented. 2 have no code behind them."

Report both directions: intended-but-absent (unbuilt), and built-but-undeclared
(undocumented). Neither is an error in the analysis; both are facts about the
product.

### 2.2 Top-down evidence is not clean

A README's own headings are typically ~half mechanisms. Miniflux declares
`Feed Reader`, `Privacy and Security`, `Bot Protection Bypass`, `Content
Manipulation`, `User Interface`, `Integrations`, `Authentication`, `Technical
Stuff`. Of those, three are capabilities, one is a quality (§8), two are
mechanisms, one is substrate for this product, and one is noise. Run the ladder
over the product's words before trusting them.

---

### 2.3 Worked example — the same repository, both ways

A voice/music product. Its README's second line reads *"AI-powered vocal coaching
and authentic music creation platform."* Its PRD states the product outright:

> 1. **AI Vocal Coach** — learn to sing with real-time feedback, personalised
>    exercises, progress tracking
> 2. **Authentic Music Studio** — create songs featuring your real voice with
>    professional mixing
> 3. **Creator Marketplace** — earn money from your songs, higher payouts for
>    authentic vocals

**Propose top-down, then ground** (this framework):

| Capability | Grounded in |
|---|---|
| Learn to sing with real-time feedback | audio-processor pipeline, scoring endpoints |
| Create songs featuring your real voice | mixing/effects services, render jobs |
| Earn money from songs you make | payout/authenticity tiering |
| *quality (§8):* authenticity scoring, 0–100% real-voice detection | detector model | 

**Generated bottom-up from entry points** (what the analyser actually published
for this repository, 2026-08):

```
"Process audio"                -> ProcessRequest, ProcessResponse
"Configure audio processing"   -> ConfigData
"Manage devices"
journeys: "Config (rvc-webui/api_231006.py)", "Demucs", "GET /:job Id"
```

Rung 2–3 against rung 5. The product is *learn to sing, make music with your own
voice, get paid for it*; the derivation said *process audio*. The evidence was in
the second line of the README.

Two further failures visible in the same output, both predicted by this document:

- `rvc-webui/` is **vendored third-party code** and `Demucs` is a third-party
  model. Both surfaced as product journeys — §6.1, presence is not membership.
- `Config (rvc-webui/api_231006.py)` is a **source path in a journey name** —
  rung 1 of the ladder.

## 3. The altitude ladder

| # | Rung | Example | Verdict |
|---|---|---|---|
| 1 | Identifier | `Config (rvc-webui/api_231006.py)`, `Action_text Management` | leaked code |
| 2 | Symbol / tool | `Get Freshness`, `getUserById`, `POST /orders` | mechanism |
| 3 | Component / layer | `Service Layer`, `Cart Management`, `User Interface` | architecture |
| 4 | **Artifact** | "a relationship graph", "a claim record", "a verdict" | **output, not outcome** |
| 5 | **Outcome** | **Buy products**, **Read articles from feeds you subscribe to** | **capability** |
| 6 | Vision | "Make any system understandable" | the whole product, not a capability |

Rungs 1–4 undershoot; rung 6 overshoots.

---

## 4. Capability

**Is:** an outcome someone gets from the system.

**Two tests:**

- **Audience test (audience-relative).** Would **this product's own audience**
  recognise it as something they came for? *Not* "would a non-technical person
  nod" — that version rejects every correct capability of a developer library.
  For a dependency-injection library, "Register services and have dependencies
  injected" is correct and no non-engineer nods at it. Identify the audience
  first (end user, operator, developer, agent, analyst), then apply the test to
  them.
  **The audience binds to the capability, not to the system.** One product often
  serves several: a device platform may expose an admin portal (administrator), a
  desktop app (end user), a CLI (developer) and Terraform (operator). "Administer
  tenants" and "Provision the production environment" are both correct
  capabilities of one product, judged by different audiences.
- **Universality test.** Would this be true of most codebases? Then it is
  infrastructure. ("Integrate with external services" fails.)

**Count is an output, not a target.** A focused tool legitimately has one.
flight-finder's entire purpose is *"find the cheapest flights by searching
multiple departure airports within driving distance"* — one capability, and one
is the right answer. **Any minimum-count gate is a repo-shape assumption in
disguise** and will reject correct analyses of single-purpose software.

---

## 5. Flow, Step, Entity

### Flow — behaviour
One end-to-end behaviour delivering part of a capability, from an initiating
trigger through its meaningful outcome. A step **graph**, not a list. An async
continuation is the *same* flow (`continuations` / `continued_from`). Roles are
**relational**: `primary` for one capability, `supporting` for another.

**Derive** from a trigger through to its `terminus` (`kind`, `produces`). The
terminus is what makes it a flow rather than a call chain.

**Failures:** one flow per entry point; flows with zero steps; names carrying
source paths.

### Step — action
A meaningful change in what the system knows, decides, validates, performs, or
produces. **Not a function.** One step may span several functions; one 30-line
handler that validates, mutates and persists is **three steps inside one
function** (`FlowStep.functions[].section` exists for this).

**Derive** from framework semantics: a validator boundary is a Validate step, an
ORM flush is a Persist step, a serializer boundary is a Respond step, a queue
dispatch is an async handoff.

**Failure:** one step per traced function —
`process_audio → HTTPException → pipeline.process_full_pipeline`. That is a
placeholder, not a segmentation.

### Entity — subject
A domain thing the system holds, changes, or delivers. Derive from persistence
and framework evidence, not directory names.

**Failures:** UI types in the ERD; config objects fragmented into pseudo-entities
on library repos; generic-noun rejection lists discarding `User`, `Account`,
`Session` — exactly wrong for an identity or settings product (§7).

---

### 5.4 Grounding — the harder half, and the differentiated one

Proposing a capability from a README takes minutes and needs no analyser.
**Grounding it is the half that requires the CAS, and the half a competitor
cannot copy.** It is also, measured, much harder.

**What grounding a proposal requires:**

| Proposal claims | Evidence that grounds it |
|---|---|
| an outcome a user reaches | a flow whose `terminus.produces` is that outcome |
| a thing the system holds | an entity with persistence or framework evidence |
| an integration or delivery | an **external service / outbound effect** on some flow |
| something reachable | an entry point, inside a ship unit (§6.1) |

A proposal with none of these is a **gap**, not a capability (§9).

#### Measured result

Five proposals derived top-down for a Go feed reader, then grounded against its
own complete analysis (all layers ready):

| Proposal | Grounded | Why |
|---|---|---|
| Read articles from feeds you subscribe to | yes | `Entry` entity, entry routes, `Entry updated` terminus |
| Read your feeds from other apps (API compat) | yes | among the HTTP route surface |
| Clean up article content for reading | unknown | no flow located |
| Fetch feeds from sites that block scrapers | **no** | `external_services: []` on every flow |
| Send articles to read-later services | **no** | same |

**2 of 5.** The three failures were not failures of the proposals — they were
missing or wrong structural facts.

#### The four blockers, and why they are fixable

1. **Outbound effects not captured.** `external_services: []` on *every* journey
   of a program whose entire purpose is fetching feeds over HTTP and pushing to
   read-later services. The Effects facet is empty exactly where it should be
   richest, which makes any integration-shaped proposal unfalsifiable.
2. **Terminus inferred wrongly for non-mutating handlers.** `GET /category/create`
   — the handler that *renders the form* — was credited with `Category **created**`.
   A wrong terminus produces a wrong capability, because the terminus names it.
3. **Steps polluted by shared infrastructure.** UI handlers call a shared
   content-loader; the tracer follows it into i18n and sidebar counters. The steps
   of "create a category" came back as *load translation files, parse plural
   forms, count unread badges*. Every UI route then has the same ~22 steps, so
   three different routes all render as the same title, and 156 of 181 flows
   become indistinguishable — `flows_to_capabilities: 0.138`.
4. **Capability attribution over-broad and token-derived.** A 3-step flow that
   updates one entity carried **11** capability ids, including one named after a
   parameter token, plus singular/plural duplicates of the same concept.

**Proof this is a tracer defect and not a model defect:** in the same analysis,
the API routes are clean. `PUT /v1/categories/:categoryID` yields the right name,
the right terminus, and seven relevant steps — because its handler is thin and
never enters shared plumbing. Same model, same repo, correct output.

**Therefore:** step traces must exclude shared infrastructure reached through a
common helper; terminus inference must distinguish a handler that *renders* from
one that *mutates*; and outbound calls must be captured as effects. Until then,
the naming half can be fixed by seeding from top-down evidence, but the grounding
half — the differentiated half — cannot be trusted.

## 6. Dispatch mechanisms, and non-transactional systems

**Every system has a dispatch mechanism, and it is never a flow.** The flows are
what it dispatches.

| System kind | Dispatch mechanism (not a flow) | Flows are dispatched from |
|---|---|---|
| Web service | accept loop / router | routes, handlers |
| CLI | argument parser | subcommands |
| Worker | message pump | consumers, jobs |
| Scheduler | cron/timer | scheduled tasks |
| **Game / simulation** | **frame loop (`update`/`tick`)** | **input bindings, collisions, state transitions** |
| Daemon | event loop | signals, watchers, timers |

Treating the mechanism as a flow yields exactly one flow — "run the game", "serve
requests" — which is the same failure as one-flow-per-entry-point, from the
opposite end.

**Therefore two definitions must be broader than network semantics:**

- **Entry point** is any *initiation* of behaviour: HTTP route, CLI subcommand,
  message, scheduled tick, **player input binding, collision/trigger volume,
  state-threshold transition**.
- **Terminus** is any *meaningful outcome*: persisted write, external call,
  emitted message, response — **or an in-memory domain state change** (an enemy
  defeated, a channel opened, a zone entered), which for a game is the real
  outcome and may only reach disk at save time.

### Worked example — a browser action-RPG

Top-down evidence here is *narrative*, not product claims: the README describes
islands, seals, and essence. The ladder still applies; the story names the
outcomes.

```
Capability   Channel essence and grow your power
  Flow       Open an essence channel
    trigger  player interacts with an essence node        (input binding)
    steps    check attunement -> drain node -> bind channel -> unlock ability
    terminus EssenceChannel exists; Player.abilities changed   (state change)
  Flow       Attune to a stronger node
    ...

Capability   Explore an archipelago of floating islands
  Flow       Travel to another island
    trigger  enter skiff / portal volume                  (collision trigger)
    steps    unload zone -> stream in zone -> place player -> spawn inhabitants
    terminus current island changed

Capability   Make a life in a frontier town
  Flow       Trade with a Thornwick merchant
    trigger  interact with NPC
    steps    open ledger -> price goods -> exchange -> update standing
    terminus Inventory and Reputation changed

Entities     Player · EssenceChannel · Island · Enemy · Item · Quest · SaveState
```

Note what this does *not* contain: `update()`, `render()`, `Physics`, `Renderer`,
`GameLoop`. Those are the dispatch mechanism and the engine — rung 2 and 3.

The same shape covers daemons and streaming pipelines: the loop is machinery, the
dispatched behaviours are the flows.

---

## 6.1 Presence is not membership

A repository contains more than the product:

| What is in the folder | Has capabilities? |
|---|---|
| the shipped product | **yes** |
| retired / superseded implementations | no — that is history |
| vendored or forked third-party code | no — not yours, and often not shipped |
| content, assets, fixtures, sample data | no (unless the artifact *is* the product — §8.3) |
| scaffolding, generators, build tooling | no |

Derive capabilities **only from what ships**. The filter is structural —
**ship-unit reachability** — never a folder-name convention:

- not present in the workspace/build configuration
- not reachable from any container entrypoint, binary target, or deploy job
- not imported by any live module
- no recent change activity (temporal axis, corroborating not deciding)

Measured on Klauro itself: 131 TypeScript files of a retired platform sit in
`legacy/`, absent from `workspaces`, shipping nothing. A naive derivation reports
its routes and entities as current product capabilities — telling a customer the
system still does what it stopped doing.

The same analysis reports `orphan_node_count: 53129 / 62634` — 85% of nodes
belong to no ship unit. That figure is currently a coverage statistic. **It is
also a capability filter.**

## 7. Scope relativity

**The same behaviour is a capability or substrate depending on what the system is
for, and only graph position can tell you which.**

| System | Authentication is… | Why |
|---|---|---|
| e-commerce | substrate | Checkout, Order History, Returns all depend on it |
| an identity product | **the flagship capability** | nothing product-specific follows it |

Same code, opposite verdicts. Therefore **no word list can decide this**. A
constant asserting that `auth, identity, session, account` are plumbing is wrong
for every identity product that exists.

The structural signal is dependency direction: how many other flows depend on
this one as a prerequisite. Many dependents → substrate. None → terminal → strong
capability candidate. Absent direction evidence, record unknown and exclude it;
never default it.

Applies equally to logging (substrate, unless the product is observability),
payments, search, scheduling, and dependency injection.

### 7.1 Container is not monorepo

| Shape | What it is | Capabilities at the parent node |
|---|---|---|
| **Monorepo** | one product across several deployables | the product's capabilities; members compose |
| **Container** | N *unrelated* products sharing a path | **none** — the parent has no purpose of its own |

A folder holding a car-wash app, a signage app, a foam e-commerce store and a
shooting-coach app has no capability set. Their union — "wash cars, sell displays,
order foam, coach shooting" — is a category error, not a system.

At a container node the correct output is a **classification**: "container of N
unrelated systems; analyse each." Capabilities are never inherited upward into a
parent that has no purpose to compose them into.

---

## 8. System qualities are not capabilities

Some things that legitimately belong in a product description are **properties of
how the system does everything**, not outcomes it delivers: privacy, self-
hostability, performance, offline operation, accessibility, determinism.

"Privacy and Security" is a genuine reason people choose miniflux. It is not a
capability — forcing it into one produces a fake ("Protect user privacy" with no
flow behind it), and dropping it loses a real product fact.

Model them as **evidence-backed system qualities**: a named property, its
evidence (no third-party telemetry calls, self-host artifacts, CSP headers, local
model support), and the capabilities it modifies. They belong beside the
capability list, never inside it.

### 8.1 Three things that live near capabilities without being one

| Thing | Example | Why not a capability |
|---|---|---|
| **Quality** | privacy, self-hostability, offline operation | a property of *how*, not an outcome |
| **Goal** | "reach $10k/mo cashflow" (`TEN_K_CASHFLOW_PLAN.md`) | the owner's objective, not something the system delivers |
| **Exemplar role** | "this is a sample application" | a fact about the repo's purpose, not its behaviour |

### 8.2 The exemplar paradox

Some repositories have a **depicted** domain that is not their **actual**
purpose: samples, demos, tutorials, templates, scaffolds, starter kits,
benchmark fixtures.

`spring-petclinic-microservices` declares itself a *"Sample Application"*. Its
actual purpose is demonstrating Spring Cloud patterns; its depicted purpose is
running a veterinary clinic. Strict derivation picks the actual one — "demonstrate
a distributed architecture" — which is correct and useless to someone asking what
the code does.

**Rule:** report the **depicted** capabilities (they are genuinely implemented —
the code really does manage owners, pets and visits) and record the exemplar role
as a **system quality**. Never silently replace one with the other, and never
merge them.

### 8.3 Content and artifact repositories

Some repositories produce a document, dataset, site, or infrastructure
definition rather than runtime behaviour. They fit, with one substitution: the
**terminus is the published artifact or the provisioned environment**, and the
build/deploy pipeline supplies the flows.

| Repo kind | Audience | Terminus |
|---|---|---|
| Docs site, dataset, knowledge base | reader | the published artifact |
| Infrastructure-as-code, deploy repo | operator | the provisioned environment |

"Publish a cybersecurity knowledge base" (validation and assembly as steps);
"Provision the production environment" (plan, apply, verify as steps). Both pass
the audience test *for their audience*.

This is the one case where rung 4 (§3) *is* the answer: when producing the
artifact is the point, the artifact is the outcome.

---

## 9. Degradation, and the three honest empty answers

**Zero is never correct for a system that runs.** A running system has a purpose;
an empty catalog means the analysis failed, not the codebase.

- Publish the best available set with **confidence** and an explicit gap note.
- Refuse individual members; never reject the whole catalog because some fail.
- **No minimum count** (§4). No maximum either.
- Report *which* gate rejected *which* candidate, so failures are diagnosable.

But three states legitimately produce no capabilities, and each is a **finding, not
a failure**. Reporting them as "analysis failed" is wrong; so is inventing a
capability to avoid them.

| State | Test | Correct output |
|---|---|---|
| **Not a running system** | no entry points and no executable code — an empty directory; a docs-only, asset-only, planning, or research/notes repository | classification: "this repository does not run"; capability count 0 is correct |
| **Insufficient evidence** | proposals exist but none ground — e.g. a single file in an unanalysed language, or a compiled binary with no source | "insufficient evidence", with the ungrounded proposals listed as gaps |
| **Ungrounded proposal** | the product's words claim something the code does not show | documented gap (§2.1), never published as a capability |

The canonical `capability_reconciliation.unverified_declarations` report preserves
explicit feature declarations for which no corroborating structural candidate was
found, including unfamiliar wording and claims that may be qualities rather than
outcomes. Each entry retains its original text, document role and source. It is
not a capability and does not prove functionality is absent. Declarations with
candidate evidence but no published outcome remain visible in the existing
intent-gap proposals. These reports can overlap; their counts must not be added
as independent missing-capability totals. An absent declaration report in older
analyses means unreported, not zero gaps. The conceptual catalog pages every
entry without truncating the canonical collection.

`wifi-fix` is the second: one Swift file, no README, and the only top-down
evidence is the folder name. "Reconnect wifi when it drops" is a reasonable
*proposal* — and it must stay a proposal, because nothing grounds it. This is
precisely how the propose/ground split stops a folder name from becoming a
capability.

---

## 10. Interlocking invariants

Checkable, not prose:

1. Every capability has ≥ 1 grounded flow. None → unevidenced claim → report as a
   gap, do not publish as fact.
2. Every flow rolls up to ≥ 1 capability, or is explicitly isolated with a reason.
3. Every step maps to ≥ 1 code region and belongs to ≥ 1 flow.
4. Every flow reaches a terminus — persisted write, external call, emitted
   message, response, **or domain state change** (§6).
5. A flow's terminal entity is strong evidence for its capability's subject.
6. An entity no flow touches is inert — dead data, or missing analysis.
7. The dispatch mechanism is never itself a flow (§6).

Violations are findings. Publishing around them is how a catalog becomes
plausible and wrong.

---

## 11. Failure taxonomy (observed, not hypothetical)

| Symptom | Cause |
|---|---|
| Capabilities are tool/endpoint names | generated bottom-up from entry points |
| Capabilities are artifact names | stopped one rung short of outcome (§3) |
| `Report Reporting`, `Manages mcp management` | template stutter, no name hygiene |
| `Action_text Management`, `Dismiss_x Workflow` | code identifier reached the label |
| Every repo gets "Integrate with external services" | universality test never applied |
| Identity product's auth ranked as plumbing | vocabulary used where position was needed |
| Catalog publishes zero | gates composed to an empty intersection (§9) |
| Correct single-purpose tool rejected | minimum-count gate (§4) |
| One flow called "run the game" / "serve requests" | dispatch mechanism treated as a flow (§6) |
| Steps mirror the call stack | segmentation by function instead of by action |
| Library config objects become capabilities | entity inference without persistence evidence |
| Every DI/tooling capability rejected | audience test applied absolutely, not relative (§4) |
| Sample repo reported as "demonstrates a framework" | exemplar role replaced the depicted capabilities (§8.2) |
| Repo with no README yields nothing | top-down search stopped at README (§2.1) |
| Owner's goal published as a capability | goal/capability confusion (§8.1) |
| Infra services given product capabilities | scope relativity not applied per CAS node (§7) |
| Folder name published as a capability | ungrounded proposal promoted to fact (§9) |
| Empty/docs-only repo reported as "analysis failed" | not-a-running-system state missing (§9) |
| Competitor's marketing features copied as capabilities | qualities and mechanisms not run through the ladder (§2.2, §8) |
| "Set up React with Vite and HMR" as a capability | scaffold README trusted as top-down evidence (§2.1) |
| Unrelated client products merged into one capability list | container treated as a monorepo (§7.1) |
| Operator/admin capabilities rejected as "not user-facing" | audience bound to the system instead of the capability (§4) |
| Retired platform's routes reported as current capabilities | derived from folder contents, not ship-unit reachability (§6.1) |
| Vendored dependency's features attributed to the product | same (§6.1) |
| Docs/asset nodes inflating the graph and the catalog | content not separated from product (§6.1) |
| Every UI route yields the same steps and the same title | tracer follows a shared helper into i18n/rendering (§5.4) |
| A form-rendering GET credited with creating the record | terminus inferred from route/handler shape, not effects (§5.4) |
| A 3-step flow carrying 11 capabilities | attribution over-broad and token-derived (§5.4) |
| `cap_x_management` and `cap_xs_management` both present | no singular/plural collapse in capability identity (§5.4) |
| Integration capabilities unfalsifiable | outbound calls not captured as effects (§5.4) |

**Rule of thumb:** a wrong answer at one member is usually a missing input from
the member or tier beneath it.
