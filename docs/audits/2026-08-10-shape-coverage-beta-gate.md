# Shape-coverage beta gate: measurement, not fixing

Date: 2026-08-10. Author: measurement lane (no generator/orchestrator edits made).
Repo under measurement: mcp.klauro.com prod 1.0.136 / CLI 1.0.127+2235c82c0370-dirty, at
master `1683698f`.

## Mandate

Measure whether Klauro/Unravl works on **any kind of repo**, not just the 5
web-service-ish subjects used in the last cross-repo pass (~50% good / 30
capabilities / 5 repos, no better than baseline — before tier-1 route
extraction was known to be broken). Two peer lanes are fixing capability
recall and description provenance concurrently; this lane does not touch
generator/orchestrator code. Blackbox only (CLI + `mcp__klauro__*`), never the
engine internals, never a model/AI env var.

## Measurement hazard log

- **Self-inflicted, early**: `klauro init --help` is not a recognized flag; the
  CLI silently ran `klauro init` (no args) against cwd, which was
  `~/dev/personal` (the parent of every personal project, not a subject) and
  wrote a stray `.klaurorc` there — `project_id prj_ubse0jxpqZ5GVf4_`,
  `workspace_id wsp_uyobKLT25CE9a1YK`. Deleted the `.klaurorc` immediately.
  Then, separately, a follow-up bare `klauro analyze` (no path arg, still cwd
  `~/dev/personal`) returned `status: accepted, analysis_id
  fea1e54016d0e0afb2c751ab` — an upload was submitted for the wrong directory
  (the entire `~/dev/personal` tree: money/investor/mtg/kontinuum/etc, tens of
  MB) before the `.klaurorc` deletion was noticed. Local binding was already
  gone by the time I checked, so MCP could not resolve/cancel it
  (`resolve_agent_analysis` returns "No hosted Klauro project is bound to
  ~/dev/personal"). This is a live instance of the orphaned-upload class noted
  in prior sessions (`klauro init` headless-bind bug). Net effect: one
  unwanted analysis job landed on the shared VPS. No further commands were run
  bare (no path) after this — every `init`/`analyze` below uses an explicit
  path and `--workspace`.
- The scratchpad subjects directory (`scratchpad/subjects/`) already contained
  copies from other concurrent lanes (`openclaw-run2/3/4`,
  `kontinuum-run2/3/4`, `zerac-protocol`, `rust-arb-bot`, `klauro-parse`,
  `miniflux`, pre-existing `spring-petclinic-microservices`,
  `outcode-washup`) — confirms heavy concurrent lane activity sharing this
  box/scratchpad today. Used distinct subject directory names to avoid
  collision; did not touch or delete other lanes' directories.
- `git worktree list` on proof-of-concept shows 60+ live worktrees today —
  very heavy concurrent fleet activity on the analyzer/generator. VPS load
  checked via `/health` latency before each analyze call per the freeze
  protocol; noted per-subject below.

## Subject list (10) — shape coverage, not repeat web-service shapes

Corpus names appear only in this audit doc, never in product source, per
"specs are generic."

| # | Shape | Subject | Source path | Notes |
|---|-------|---------|-------------|-------|
| 1 | Web REST API, Java/Spring microservices | spring-petclinic-microservices | `~/dev/oss/spring-petclinic-microservices` | known regression: AI chat service (VectorStoreController, PetclinicChatClient, AIBeanConfiguration) |
| 2 | Web REST/mail app, Rails | washup (client) | `~/dev/clients/outcode/washup` | known regression: Notification/UserNotification models + mail subsystem confirmed present |
| 3 | Web GraphQL, Python/Django | hercules backend (client) | `~/dev/clients/hercules/portals/backend` | known regression: GPO module confirmed present (`modules/gpo/`); fleet/FDB to be checked in-repo |
| 4 | Native mobile, Kotlin/Android, no HTTP surface | openclaw android app | `~/dev/openclaw/apps/android` | tests ComposeAnalyzer entry-point emission |
| 5 | Library/SDK, no entry point, no deployable | simulation-engine | `~/dev/personal/knowledgebase/simulation-engine` | published-shaped TS package, "2D simulation engine for IT/cybersecurity training", own purpose = public API surface |
| 6 | Monorepo, multiple deployables | claudius | `~/dev/personal/claudius` | bot server + dashboard-ui + electron tray-app + vscode-extension |
| 7 | CLI tool, no HTTP, no UI | kontinuum | `~/dev/personal/kontinuum` | "Local-first personal intelligence substrate", bin entries kontinuum/kontinuum-runner |
| 8 | Infrastructure/IaC, little/no app code | electripure infra (client) | `~/dev/clients/electripure/infrastructure` | Terraform |
| 9 | Data/ML, notebook-heavy | rvc-webui | `~/dev/personal/vocalverse/rvc-webui` | voice-conversion pipeline, ipynb + Python |
| 10 | Odd shape: game, client/server | pixel-game | `~/dev/personal/pixel-game` | 2D game with client/server dirs |

All subjects copied read-only into
`scratchpad/subjects/<name>/` (rsync, excluding `.git`, `node_modules`,
build/dist artifacts). Source repos verified via `git status`/`git fsck`
before copying, none mutated. `washup` and `vocalverse` had pre-existing
local modifications from the owner (not caused here); copied as-is.

## Coordination note (mid-run, from the fix lane)

Production is **frozen at 1.0.136 / `56cde09aa104`** until this report lands —
every `analyzer_build` recorded below (and above) already matches that string
for my own fresh submissions, so this run is self-proving as the baseline. A
capability-recall fix (commit `6445460e`) has merged to master but is
**not deployed**; this scorecard is deliberately the pre-fix baseline, not a
mixed run. It targets `buildSystemCapabilities`'s `resourceGroups` candidate
generation: previously built only from `productEntryPoints`, so a subsystem
reached solely via an async/queue/cron seam could never become a candidate
even with effect-evidence widening. Expect movement on async-only subsystems
(notification/mail pipelines, sync jobs, chat/AI dispatch) on re-measure — no
predicted movement on the deployable-boundary case below.

**Correction to my own petclinic write-up (subject 1):** the fix lane
isolated `PetclinicChatClient.java` and confirmed it correctly emits
`POST /chatclient` with `chatclient` admitted as a non-generic resource key —
route extraction is not the cause of the missing AI-chat capability. The real
cause is a **deployable/multi-module-boundary gap** in
`buildSystemCapabilities` (open in-code near line 23105, known to break 8
tests when previously attempted). I did not claim route extraction was at
fault above, but recording the corrected mechanism here for the record: the
AI-chat capability miss on spring-petclinic-microservices is a
module-boundary defect, not a route/entry-point extraction defect.

**Subject substitution disclosure:** the fix lane flagged that a Rust subject
(`~/dev/personal/money/rust-arb-bot`) was expected but "not found" by a
different peer lane. It exists (confirmed above, `Cargo.toml` present) but is
a `clap`-based CLI binary with its own `main`, not a library/SDK with no
entry point — it fits the CLI-tool shape, which this run already covers via
`kontinuum`. I used `simulation-engine` (a published-shaped **TypeScript**
package, no Rust in this corpus fits the "no entry point, no deployable"
library shape after excluding zerac/soon) for shape #5 instead, disclosed at
the top of this doc. `hercules-backend` was independently re-confirmed and
freshly re-analyzed by me (subject 3 above, `prj_PuhKIMhlxPJmhMZN`) — it is
present and was not actually missing.

## Scorecard (filled in per subject as analyses complete)

Status: IN PROGRESS. Rows populated below as each subject finishes analysis
and is queried.

Methodology note: for subjects 1 and 2 below, a same-day (2026-08-10) completed
analysis already existed from a concurrent peer lane on an unmodified checkout
at the same paths I would have used (`scratchpad/subjects/spring-petclinic-microservices`,
`scratchpad/subjects/outcode-washup`). My own duplicate submissions for
petclinic (`prj_XMedFw5jgQRG1Icx`, then `prj_p1HB1kpruVyZ9B_A`) both returned
CLI `status:"accepted"` with a real `reuse_decision.source:"source_changed"`
and `analyzer_build:"1.0.136-dev+56cde09aa104"`, but the server-side
`analysis-status` endpoint never left `no_analysis` after 2+ minutes of
polling for either — a live orphaned-upload-class defect (see hazard log). To
avoid burning more shared-VPS budget on a repeat of that failure while two
peer lanes are also running load, I queried the peer lane's already-succeeded
analyses instead (both `analysis_version_status:"current"`, both from earlier
today). I could not independently re-confirm `analyzer_build` for those two
runs (the status endpoint doesn't expose it after the fact) — flagged as a
methodology gap for those two rows only. All other subjects below are my own
fresh submissions with `analyzer_build` confirmed via `reuse_decision`.

### 1. spring-petclinic-microservices — Web REST API, Java/Spring, monorepo microservices

- project `prj_eMFF21qPc0EyMvQe`, finished 2026-08-10T05:09:55Z, duration **8.79s**, errors 0, `analysis_version_status: current`, cas_version 2.1.0.
- capability count: **4** — Manage pet owners, Schedule and track pet visits, Manage veterinary staff, Categorize pet types. All 4 have real, readable, entity-grounded descriptions (no capability with no description).
- `primary_domain`: `spring-petclinic-microservices` (verbatim project/repo name, not a synthesized domain phrase) — mechanism-adjacent, not a hard violation but not a real domain label either.
- `flows_to_capabilities`: **0.5185** (14/27) — under half of derived flows ever land in a capability.
- journeys: 18 total (13 user-facing, 5 system).
- `tests_present`: false on all 4 capabilities; `health.tests.total = 0`. Consistent (repo genuinely has no visible test files in this snapshot) — no contradiction.
- raw source / mechanism leak: **yes** — `external_recipients` for the `Owner`/`Pet`/`PetType` exposure highlights are populated with Java stdlib call targets (`Collections.singletonList`, `List.of`, `Collections.unmodifiableList`, `Files.createTempFile`), not real external recipients. This is a live instance of the "raw source in a structured field" defect class, different flavor (Java stdlib API names instead of credentials).
- **Known regression check — AI chat service (VectorStoreController / PetclinicChatClient / AIBeanConfiguration): STILL MISSING.** The `genai-service` deployable and a `VectorStoreController` event-listener journey (`Handle application event -> PetType updated`) are present in the graph and in `runtime_topology.deployables`, so Tier 1/L1-L2 evidence exists — but no capability names the chat/AI-assistant outcome. It is folded as a side-effect trigger into the pet-type capability instead of surfaced as its own capability. **Recall miss, reproduces the named regression exactly.**
- **RECALL column**: missing capability — "Chat with an AI vet assistant about pet/visit data" (or similar), backed by VectorStoreController + PetclinicChatClient + AIBeanConfiguration + genai-service, present in the code and even in `runtime_topology` but never promoted to a capability.
- Verdict: mechanism-in-field defect (external_recipients) + one clear, high-value recall miss (the flagship regression case) on top of 4 clean capabilities.

### 2. washup (client) — Web app, Ruby on Rails + React

- project `prj_pdqGJOiTmJVV7xn9`, finished 2026-08-10T05:12:17Z, duration **40.66s**, errors 0, `analysis_version_status: current`, cas_version 2.1.0.
- capability count: **8** — Manage car wash locations, Schedule and manage tasks, Maintain equipment records, Handle incidents and notes, Manage company and user data, Track employee availability and shifts, Customize and order equipment, Delete services and recurring events. All 8 have real descriptions, all readable, entity-grounded, no vendor/framework words in the copy itself.
- `primary_domain`: **null** (`"unknown"` in `product_map.identity.domain`, `domain_source: null` in orient_capsule) despite `description_source: "ai"` and a rich AI-written description existing right next to it. Domain resolution failed even though enrichment ran — a real gap.
- `flows_to_capabilities`: **0.9939** (164/165) — near-total flow coverage.
- journeys: 312 total (309 user-facing route journeys, 3 system/sidekiq).
- `tests_present`: true on all listed capabilities; `health.tests` = 75/75 passing. Consistent, no artifact of the kind the Go fix corrected.
- raw source / mechanism leak in name or description: none observed in the 8 capability names/descriptions.
- **Known regression check — Notification/UserNotification + mail subsystem: PARTIAL.** `Notification`, `UserNotification`, and a `rails_mailer` node are all present in the data-entity/node inventory (Tier 1 evidence exists, `database_entities` lists both), and they are attached as entities under "Manage company and user data" — but there is **no standalone capability for notifying/emailing users**. The mail/notification outcome is invisible as its own line item; a PM skimming the 8 capabilities would not know the product sends notifications at all.
- **RECALL column**: missing capability — "Notify users of account/task/incident events" (or similar), backed by Notification + UserNotification + rails_mailer, present as entities but never promoted to a capability of its own.
- Verdict: best-quality sample so far (8 clean, readable capabilities, near-total flow coverage, tests_present consistent) but the domain gap and the still-buried notification capability are real, and the domain=null is a distinct new defect worth a bug report on its own.

### 3. hercules-backend (client, "HRx portal") — Web GraphQL, Python/Django, monorepo

- project `prj_PuhKIMhlxPJmhMZN`, my own submission, `analyzer_build: 1.0.136-dev+56cde09aa104`, `reuse_decision.source: source_changed` (fresh). Finished 2026-08-10T16:35:23Z, duration **196.03s**, `errors: 2` (recorded, cause not surfaced blackbox), `analysis_version_status: current`, cas_version 2.1.0.
- **Self-reported degraded**: `get_summary.comprehension.degraded: true` — `capability_naming_coverage: {total:11, authored:9, un_enriched:2}`, `capability_name_degradations: 3`, `capability_description_degradations: 1`. The product itself flags that part of its own capability catalog fell back to deterministic/un-enriched text.
- capability count: **11** — Manage company profiles, Manage user permissions, Manage product inventory, Manage delivery scheduling, Manage invoicing and payments, Manage REMS programs, Manage custom pricing, Manage shipping methods, Manage specialty classifications, Manage Location, Manage Order Origin.
- **Raw source path in description — confirmed, twice**: "Manage Location" → *"Location manages Location through 1 operation (e.g. **modules/users/schemas/types.py**)."*; "Manage Order Origin" → *"Order Origin manages OrderOrigin through 1 operation (e.g. **modules/orders/tasks.py**)."* Both are literal file paths inside a capability description shown to a non-technical reader — a hard violation of the bar, and exactly the `degraded`/un-enriched entries the summary flagged.
- "Manage REMS programs" is `description_source: "deterministic"` — template text ("...creates and reads Rems, RemsType through 11 operations"), not AI-authored, mechanical/count-shaped rather than an outcome statement.
- `primary_domain`: `"company-delivery-invoice"` — a real (if awkward) domain phrase, not raw mechanism; better than washup's null.
- top-level description reads oddly mechanism-flavored: *"The intent to create a graphql query results in the generation of a graphql query, which can read records like company, delivery, form, GPO, or invoice data."* — circular/protocol-flavored phrasing a PM would not write.
- `flows_to_capabilities`: 1.0 (89/89) on the flows that exist — but this ratio is blind to whole modules that never produced a flow at all (see recall below); `reachable_code_to_steps`: **0.5217** (84/161).
- `tests_present`: false on all 11 capabilities; `health.tests.total = 0`. Consistent, no contradiction.
- journeys: 21, all user-facing (0 system) — low relative to 146 entry_points/50 GraphQL operations, consistent with the low reachable-code-to-steps ratio.
- **Known regression check — GPO / change_requests / fleet / FDB drug-database integrations: ALL FOUR STILL MISSING as capabilities**, despite the source modules genuinely existing (`modules/gpo`, `modules/change_requests`, `modules/fleet`, `modules/fdb` all confirmed present on disk pre-analysis):
  - **GPO**: `GPO` appears as a database entity in the L3 inventory (Tier-1 evidence exists) but has zero capability of its own — folded into nothing.
  - **change_requests**: an entire module with its own models/admin/schema/migrations (`module_modules_change_requests_*` visible only as *orphan nodes* in the sub-CAS accounting) — no capability, no visible entity name.
  - **fleet**: **total invisibility** — no `Fleet`-named entity anywhere in the 55 `database_entities`, no capability, not even orphan-node evidence surfaced in this summary. The worst miss of the run.
  - **FDB**: substantial async evidence exists — `celery.task.sync_fdb_products`, `sync_fdb_from_sftp_file`, `update_gcn_products` all appear as real communication-seam edges into `modules/fdb` — yet no "sync drug pricing/FDB database" capability was generated. The mechanism-level plumbing is visible in the graph; the user-facing outcome is not.
- **RECALL column**: 4 missing capabilities — GPO compliance/approval management, change-request approval workflow, fleet management, and FDB drug-database sync — all four named in the regression brief, all four reproduce today on the current deployed analyzer.
- Verdict: worst sample so far. Confirms the regression brief's Django repo exactly: 4/4 named capabilities still absent, plus two literal file-path leaks in capability descriptions the product's own `degraded` flag also caught. This is the strongest evidence in the run that capability recall is still broken for a real, complex GraphQL/Celery backend.

---

### Progress checkpoint (3 of 10 subjects scored)

Common thread so far: capability *quality* (readability, entity-grounding) is fine to good on generated capabilities, but **recall is the real failure** — every subject tested against a known regression still reproduces it. Continuing with the remaining 7 shapes (native mobile, library/SDK, monorepo-multi-deployable, CLI, IaC, data/ML, odd/game) next.

### 4. openclaw-android — Native mobile, Kotlin/Jetpack Compose, no HTTP surface

- project `prj__ePndWvT_0jk4uIy`, my own submission, `analyzer_build: 1.0.136-dev+56cde09aa104`, fresh. Finished 2026-08-10T16:37:19Z, duration **7.06s**, `errors: 2`, cas_version 2.1.0.
- **ComposeAnalyzer entry-point fix confirmed generalizing to a new subject**: `entry_points: 7` (`page:4, event:1, lifecycle:2`), with real Compose-screen journeys (`journey_compose_entry_compose_component_.../ChatSessionsDialog...`, `.../RootScreen...`). Prior sessions noted ComposeAnalyzer used to emit **zero** entry points on Android apps (the confirmed cause of a 2/6 score elsewhere); this repo shows real page/lifecycle entry points and journeys, not zero. Positive signal that fix generalizes.
- capability count: **3** — Connect to Gateway, Chat with Gateway, Parse Talk Directives. All readable, entity-grounded, no mechanism/vendor leak in the copy.
- `primary_domain`: **null**; system-level `description`: **empty string `""`**, `description_source: null` — the AI enrichment ran (L5 marked ready) but produced no system purpose at all. Distinct defect from washup's null-domain case: here the *description itself* is blank, not just the domain.
- **Under-generation relative to entity evidence**: the entity/data inventory contains `ElevenLabsVoice`, `CameraHudState`, `Capture`, `Snapshot`, `PendingImageAttachment`, `OutgoingAttachment`, `InlineImage`, `ToolDisplaySummary`, `ToolDisplayConfig`, `StatusActivity` — real evidence of camera-capture, voice/TTS, image-attachment, and tool-call-display features — none of which is reflected in any of the 3 capabilities. `flows_to_capabilities: 0.8409` (37/44, 7 flows unmapped) is consistent with this.
- **RECALL column**: at least 2-3 missing capabilities — "Capture and send camera/image attachments", "Voice/text-to-speech responses", "Display tool-call status/results" — all backed by real entities the graph already extracted but never promoted past Tier 1.
- **`tests_present` vs `health.tests` contradiction, confirmed**: `orient_capsule.dimensions.tests = {available:true, count:13}` (13 test-related nodes exist) but `health.tests = {total:0, passing:0, failing:0}` and every capability shows `tests_present:false`. The two halves of the same response disagree about whether tests exist.
- `reachable_code_to_steps`: 1.0 (perfect). No HTTP routes (correct for this shape — `routes.available:false`).
- Verdict: best evidence in the run that a specific named regression fix (Compose entry points) is real and generalizes. But the system purpose is blank, capability count looks low against the entity evidence (voice/camera/tool-display all missing), and there's an internal `tests_present`/`health.tests` contradiction in the same payload.

---

### 5. simulation-engine — Library/SDK, no entry point, no deployable

- project `prj_QYeeFjQkO_-OY_Cs`, my own submission, `analyzer_build: 1.0.136-dev+56cde09aa104`, fresh. Finished 2026-08-10T16:39:16Z, duration **44.50s**, `errors: 1`, cas_version 2.1.0.
- **Deployable-boundary detection is correct**: `sub_cas_nodes.promoted: false`, `qualified_unit_count: 0`, `reason: "No tier-qualified ship unit found: no deployable_evidence row declares a ship or build artifact of its own."` — the product correctly recognizes this is not a deployable. `entry_points: 1` (lifecycle only), `journeys.total: 0` — also correct for a library with no HTTP/user-facing surface.
- `primary_domain`: `"cybersecurity-training"`, and the system-level `description` is genuinely good: *"The Simulation Engine is a library designed to create and manage 2D top-down simulations for IT and cybersecurity training... transforms configuration inputs... into interactive simulation outputs..."* — this is exactly right and matches the actual repo purpose (confirmed by reading its README: a browser-based vulnerable-web-app simulator for SQLi/XSS/command-injection training).
- **Capability count: 10 — this is the direct, named anti-pattern the owner called out, reproduced exactly.** The owner's bar: *"the correct answer is ~1-2 readable capabilities, NOT zero and NOT struct-field names like 'Manage Encrypted Packet Headers'."* The 10 generated here are: Configure Desktop Environment, Define System Hardware, Visualize Network Topology, Set Up Training Scenarios, Manage Email Communications, Organize Rack Units, Monitor Exploitation Progress, Customize Window States, Apply Dashboard Themes, Handle Process Management. At least 5 of these (Configure Desktop Environment, Organize Rack Units, Customize Window States, Apply Dashboard Themes, Handle Process Management) are one-entity, config-object-shaped capabilities — structurally identical to the "Manage Encrypted Packet Headers" anti-pattern named in the brief, not outcomes a PM would list as the library's product purpose.
- **Description/capability-catalog mismatch**: the system-level description correctly frames this as a library (consumer configures it, gets simulation output), but the capability catalog instead reads like a deployed desktop application's feature list (Configure Desktop Environment, Customize Window States) rather than the library's actual public API surface (create a scenario, run a simulation, subscribe to engine events). The two halves of the same analysis disagree about what kind of thing this is.
- `flows_to_capabilities`: 0.9783 (45/46). `reachable_code_to_steps`: 1.0.
- `tests_present`/`health.tests`: both show 0/false consistently (no contradiction here, unlike subject 4).
- No raw source/vendor names in the 10 capability names/descriptions themselves — the defect here is architectural (fragmentation), not a mechanism-leak-in-text defect.
- Verdict: **this is the clearest, most direct reproduction of a named owner concern in the whole run.** Deployable-boundary and entry-point detection are both correct for this shape, but capability generation over-fragments a library's config surface into 10 pseudo-capabilities instead of converging on 1-2 real ones ("Simulate common web-app vulnerabilities for hands-on training" / "Configure custom training scenarios and network topologies").

---

### 6. claudius — Monorepo, multiple deployables (bot server + dashboard-ui + Electron tray-app + VS Code extension)

- project `prj_VPZPPFlLxoA5FUgF`, my own submission, `analyzer_build: 1.0.136-dev+56cde09aa104`, fresh. Finished 2026-08-10T16:40:51Z, duration **44.14s**, `errors: 2`, cas_version 2.1.0.
- **Sub-CAS/deployable-boundary promotion missed the multi-deployable structure entirely.** `sub_cas_nodes.promoted: false`, `qualified_unit_count: 0`, `reason: "No tier-qualified ship unit found: no deployable_evidence row declares a ship or build artifact of its own."` This repo genuinely has 4 distinct deployables (a Node/Express bot server, a separate `dashboard-ui` web app, an `tray-app/` Electron app with its own `package.json` + `electron` main, and a `vscode-extension/` with its own `package.json` + `engines.vscode` + `activationEvents`) — none were recognized. Compare to subjects 1 and 3 above, where Docker/K8s-shaped boundary evidence let the same mechanism correctly promote 6 and 7 sub-CAS units respectively. **This looks like the deployable-boundary detector is biased toward container/K8s ship-artifact evidence and doesn't recognize Electron `main`/`vscode.engines`/multiple `package.json` roots as qualifying evidence** — a specific, falsifiable hypothesis for why sub-CAS promotion is shape-dependent rather than deployable-dependent.
- `primary_domain`: **null**, system-level `description`: **empty string `""`** — same blank-system-purpose defect seen on subject 4 (openclaw-android), now on a second, unrelated subject; not a one-off.
- capability count: **6** — Orchestrate AI agents, Manage agent skills, Handle agent memory, Manage network tunnels, Monitor agent sessions, Configure auto-approval rules. Readable and entity-grounded on the surface, but "Manage agent skills" has a grab-bag entity list mixing unrelated concepts — `Skill`/`SkillDefinition`/`SkillManifest` alongside `NgrokTunnel`, `TailscaleTunnel`, `TelegramUser`, `VSCodeClient`, `DashboardToken` — evidence of entity mis-attribution across capabilities, not clean grouping.
- **RECALL column**: the repo's own `package.json` description is *"Remote AI agent orchestration system with **Telegram interface**"* — Telegram is the headline user-facing surface — yet there is no "Control agents via Telegram" (or similar) capability anywhere in the 6. `TelegramUser` exists only as an orphaned entity folded into the unrelated "Manage agent skills" bucket. Also missing: a distinct capability for the VS Code bridge / dashboard control surface (both real, both structurally present as separate deployables per the boundary-evidence miss above).
- `flows_to_capabilities`: **0.5926** (16/27). `reachable_code_to_steps`: **0.4545** (30/66) — both under half, consistent with the multiple under-surfaced capabilities.
- journeys: only **2** total despite 26 entry_points (18 HTTP) — heavy under-representation relative to the route surface.
- `tests_present`/`health.tests`: both 0/false, no internal contradiction this time.
- Verdict: this is the shape most directly aimed at testing sub-CAS promotion, and it is the clearest miss on that specific mechanism in the run — 0 promoted units on a repo with 4 real deployables, immediately after two subjects where the same mechanism worked (both container/K8s-shaped). Combined with the blank system description (2nd occurrence) and the missing Telegram capability (the product's own headline feature), this is a strong negative sample for the monorepo shape specifically.

---

### 7. kontinuum — intended as "CLI tool, no HTTP" but turned out hybrid (CLI + real HTTP API)

- project `prj_NlukoM4NhiDxn_Dl`, my own submission, `analyzer_build: 1.0.136-dev+56cde09aa104`, fresh (`snapshot_source: committed-head` — a `.git` directory survived my rsync exclude for this one subject only; not a product defect, a copy-hygiene slip on my side, disclosed here). Finished 2026-08-10T16:43:29Z, duration **85.30s**, `errors: 1`, cas_version 2.1.0.
- **Disclosure**: I picked this repo as the CLI-tool shape from its README framing ("local-first personal intelligence substrate", `bin` entries), but the analysis correctly shows it is actually hybrid — `system_type: "backend-service"`, `architecture_type: "MCP server"`, 161 HTTP routes and a real `docker-compose`/Dockerfile-backed deployable, plus a genuine 8-entry-point `Shell Cli Surface`. It is not a pure headless-CLI sample; treat the CLI-specific findings below as the useful signal from this subject, not the whole picture.
- **Sub-CAS promotion worked here** (4 qualified units, Docker+compose+bin evidence) — reinforces the hypothesis from subject 6: Docker/compose-shaped boundary evidence is what the promotion mechanism actually keys on; Electron/VS-Code-only evidence (claudius) does not qualify.
- capability count: **9**, all named `Manage {Entity}` (Manage Remote Memory, Manage Operational Project, Manage Conversation Import, Manage Task, Manage Priority Arbitration, Manage Shared Recall Item, Manage Agent Profile, Manage Evaluation Fixture, Manage Claim) — a uniform CRUD-over-entity naming pattern, not outcome language. The system's own description states its purpose as preserving *"durable knowledge, provenance, decisions, project context, and agent learning independently of any one language model"* — none of the 9 capability names says anything like that; they read as generated from the entity list, not the product description sitting right next to them in the same payload.
- **RECALL column — CLI surface specifically missed**: 8 real CLI entry points exist (`Shell Cli Surface` behavior surface) and the README documents concrete CLI verbs (`ingest-text`, `health`, `kernel-summary`, `eval-runs`) but **zero of the 12 journeys are CLI-triggered** — all 12 are HTTP-route journeys. No capability like "Ingest and preserve durable knowledge via CLI" exists; the CLI surface this shape was chosen to test is present in `entry_points_by_type.cli: 8` but invisible in every downstream comprehension artifact (capabilities, journeys).
- top-level description is mostly good (matches the README's own framing closely) but ends with a mechanism-flavored trailing clause: *"The intent 'List conversation seed reports' yields a ConversationImport record, which is written as part of the process."* — a technical implementation detail leaking into an otherwise readable description.
- `primary_domain`: `"personal-intelligence-substrate"` — good.
- `flows_to_capabilities`: **0.6296** (51/81, 30 unmapped). `reachable_code_to_steps`: **0.5764**.
- `tests_present`: true only on 1 of 9 capabilities despite `health.tests: {total:239, passing:239}` — real tests exist project-wide but are attributed to almost none of the capability rows.
- Verdict: this subject didn't end up isolating the CLI shape cleanly (it's a hybrid), but the one clean CLI-specific finding it does provide is unambiguous: a real, documented CLI surface with 8 entry points produced zero CLI-attributed capabilities or journeys — everything downstream of L1 forgot the CLI existed.

---

### 8. electripure-infra (client) — Infrastructure/IaC, Terraform, near-zero application code

- project `prj_kBZexCVYDpGeCFIk`, my own submission, `analyzer_build: 1.0.136-dev+56cde09aa104`, fresh. Finished 2026-08-10T16:44:59Z, duration **32.07s**, `errors: 0`, cas_version 2.1.0.
- **This is the best "zero is never correct" result in the run.** capability count: **2** — "Provision and manage AWS infrastructure" (VPC/ECS/RDS/ALB) and "Control cloud access and routing" (Route53/CloudFront). Both readable by a non-technical reader, both correctly non-zero for a repo that is ~100% Terraform/HCL with 0 traditional data entities. `primary_domain`: `"electripure-infrastructure-cicd"`; description correctly frames it as infra-as-code provisioning AWS resources for a web app.
- `database_entities`: 0 (correct — no app data model in pure IaC). `journeys.total`: 0 (defensible — no user-facing journey concept in a Terraform repo).
- `sub_cas_nodes.promoted: false`, `reason: "no deployable_evidence row declares a ship or build artifact of its own"` — also correct; this repo provisions infrastructure, it isn't itself a deployable.
- **`flows_to_capabilities`: 0.0278 (1/36)** — the most extreme under-mapping ratio in the entire run. 35 of 36 derived flows never reached a capability. Read with a caveat (in an IaC repo a "flow" may be a mechanical per-resource/per-file unit rather than a true product-surface unit, so this ratio may overstate the miss relative to the app-code subjects above) — but at face value it is the worst coverage number measured today.
- **RECALL column**: the repo's `main.tf` defines 8 modules (vpc, s3, cloudfront, alb, route53, ecr, ecs, cicd-access; rds is present as a module but commented out of the root call). The 2 capabilities name VPC/ECS/RDS/ALB/Route53/CloudFront but **never mention ECR (container registry) or the `cicd-access` module (CI/CD IAM access provisioning)** — both real, both have their own `.tf` module directories, neither surfaced as or within a capability.
- Verdict: the strongest "non-zero, readable purpose for a near-code-free repo" result measured, and proof the bar is achievable — but still under-covers 2 of 8 real modules, and the flows-to-capabilities ratio is the worst of any subject today (with the stated caveat about how "flow" is counted for this shape).

---

### 9. rvc-webui (OSS, RVC-Project) — Data/ML, script-and-notebook-heavy, Python + FastAPI

- project `prj_t5wXvbsJX8WzNHOB`, my own submission, `analyzer_build: 1.0.136-dev+56cde09aa104`, fresh. Finished 2026-08-10T16:46:18Z, duration **32.55s**, `errors: 3`, cas_version 2.1.0, `comprehension.degraded: true`.
- **This is the single worst capability-recall result measured today, and it is close to a "zero" result in spirit.** capability count: **1** — `"Manage Config Data"`. That one capability **has no `description` field at all** (every other capability sampled today, across all 8 other subjects, has a `description` string; this one is simply absent) — the exact "capability with no description" the brief asked me to flag, and `comprehension.capability_description_degradations: 1` confirms the product's own self-check caught it too.
- **`flows_to_capabilities`: 0** (0 of 17 flows mapped) — total failure, not partial.
- Real evidence of a rich feature set exists throughout the graph and is not reflected in the single capability: 15 real user-facing journeys were derived (`Run main -> VC` — voice conversion inference, `Configure audio -> audio_api.set_values`, `List input/output devices`, ONNX export, model-similarity comparison), and 87 orphan modules include `infer_lib_train_*` (model training), `infer_lib_rmvpe`/`infer_lib_jit_get_rmvpe` (pitch extraction), `infer_lib_uvr5_pack_*` (vocal/instrumental separation — a full sub-feature with 15+ of its own files), and `infer_lib_rtrvc` (realtime conversion). None of this — train a voice model, run realtime voice conversion, separate vocals from a track, export/compare models — appears as a capability. The one capability that *did* get generated is the least interesting one available (a settings object), while every substantive ML capability is invisible.
- top-level `description` is actually good and specific: *"a voice conversion framework that allows users to list input and output devices, configure audio settings, and start or stop voice conversion processes... utilizes pre-trained models for voice conversion."* — the system-level description alone is closer to correct than the capability catalog is, another instance (like simulation-engine and hercules) of the description and capability list disagreeing about what the product does.
- `primary_domain`: `"voice-conversion"` — good, readable.
- Sub-CAS promotion worked correctly (2 qualified units, Docker+compose evidence, `coverage_ratio: 0.9817`) — the deployable-boundary mechanism is not the problem here; capability generation specifically is.
- `database_entities`: 1 (`ConfigData`) — consistent with the 1-capability output; the entity inventory itself is thin, which may be root-causing the capability thinness (an ML/inference codebase's real "entities" are models/checkpoints/audio buffers, not ORM rows, and the entity extractor may not recognize that shape).
- Verdict: **this is the clearest evidence in the whole run that "zero is never correct" is still being violated** — not literally zero, but one undescribed, uninteresting capability standing in for a feature-rich, well-known ML training/inference framework is functionally the same failure the owner named.

---

### 10. rpg-game — odd shape: 2D game, TypeScript client + Python/FastAPI server + LLM-driven NPCs (substituted for the image-only `pixel-game`)

- Disclosure: my originally-planned `pixel-game` subject (`~/dev/personal/pixel-game`) turned out on inspection to contain only PNG/GIF sprite assets and zero code — itself an interesting "near-zero code" edge case, but not a code-comprehension test. I substituted the actual game at `~/dev/personal/rpg` (TypeScript client + Python/FastAPI server + a `server/src/ai` module), per the substitution-disclosure rule.
- project `prj_idBVpOjHuxZEzmiD`, my own submission, `analyzer_build: 1.0.136-dev+56cde09aa104`, fresh. Finished 2026-08-10T16:48:45Z, duration **94.82s** (largest subject, 19,174 nodes), `errors: 1`, cas_version 2.1.0.
- capability count: **10** — Manage Quests, Manage Player, Manage Building, Save Game, Manage Autosave Config, Handle Items and Currency, Organize Player Relationships, Manage Enemy Behaviors, Craft and Use Recipes, Discover Mysteries. Most are genuinely good, readable, entity-grounded — this is the best-populated capability catalog of the run (107 journeys, 105 database entities) and matches the game's real systems well.
- **Raw source path in description — confirmed again, a third and fourth instance**: "Save Game" → *"Save Game updates SaveGame through 6 operations (e.g. **client/src/services/ServerConnection.ts, server/src/api/server.py**)."*; "Manage Autosave Config" → *"Autosave creates AutosaveConfig through 3 HTTP routes (**server/src/api/server.py**)."* Same defect class as hercules-backend (subject 3), now confirmed on a 3rd unrelated repo/stack — this is a systematic pattern in the un-enriched/deterministic-fallback description path, not a one-off.
- **RECALL column**: the server has a dedicated `ai` module and the entity inventory includes `NPCPersonality`, `NPCMemory`, `NPCBackground`, `NPCTrauma`, `NPCBelief`, `NPCTrigger`, `ExtendedPersonality` plus `library_ai_sdk_usage: 20` and `llm-call: 2` nodes — real, substantial evidence of LLM-driven NPC personality/dialogue generation, a headline feature for this kind of game. None of the 10 capabilities names it; NPC-related entities appear only as passengers inside other capabilities (e.g., `NPC` appears in "Manage Player" via a journey, not as its own AI-dialogue capability).
- `sub_cas_nodes.promoted: false`, `qualified_unit_count: 0`, same `"no deployable_evidence"` reason as claudius (subject 6) — this is a real client+server split with no Docker/compose file, and again got zero sub-CAS promotion, reinforcing the pattern that the promotion mechanism needs container/K8s-shaped evidence specifically.
- `tests_present`: false on all 10 capabilities despite `health.tests: {total:394, passing:394, failing:0}` — a fourth occurrence of the tests_present/health.tests disagreement pattern (also seen on subjects 4 and 7).
- Verdict: quality-wise the best capability catalog measured (10 real, mostly readable, well-grounded capabilities) — but still shows the run's two most repeated defects (raw file paths in un-enriched descriptions, tests_present/health.tests disagreement) plus a clear, evidence-backed recall miss on the game's most distinctive feature (LLM-driven NPCs).

---

## Cross-run defect frequency (not just per-subject — patterns that repeated)

- **Raw file path in a capability description**: hercules-backend (2x), rpg-game (2x) — 4 occurrences across 2 unrelated stacks (Python/Django, Python+TS game). Always on `description_source` entries that are un-enriched/deterministic fallback text, and the product's own `comprehension.degraded` flag correctly detects these entries exist — it just doesn't stop them from reaching the user-facing description field.
- **`tests_present` (per-capability) disagreeing with `health.tests`**: openclaw-android, kontinuum, rpg-game (3 of 10 subjects) — the two fields read from what should be the same underlying test signal and don't agree.
- **Blank/null system-level description or domain**: washup (domain null), openclaw-android (description `""`, domain null), claudius (description `""`, domain null) — 3 of 10 subjects have a broken system-purpose field despite `ai_enrichment: "ready"`/L5 marked complete.
- **Sub-CAS/deployable-boundary promotion correlates with Docker/compose evidence, not with deployable-ness**: promoted correctly on petclinic, hercules-backend, kontinuum, rvc-webui (all have Dockerfile/docker-compose) and failed on claudius and rpg-game (both have real multiple/split deployables — Electron+VSCode+dashboard+bot, and TS-client+Python-server — but no Docker/compose file). This is a specific, falsifiable hypothesis: the promotion heuristic is keyed on container-shaped ship evidence, not on deployable-shaped evidence in general.
- **Capability recall failures on named/flagship features, every single subject where a flagship feature was known or checkable**: petclinic (AI chat), washup (notifications/mail), hercules-backend (GPO/change-requests/fleet/FDB, 4-for-4), openclaw-android (camera/voice/tool-display), simulation-engine (correct purpose, but 10-way over-fragmentation instead), claudius (Telegram — the product's own headline feature), kontinuum (CLI surface entirely invisible downstream), rvc-webui (voice-model training/realtime-conversion/vocal-separation — the whole product, reduced to 1 undescribed capability), rpg-game (LLM-driven NPC personalities). **9 of 10 subjects have at least one clear, evidence-backed recall miss on a real, checkable feature.**
