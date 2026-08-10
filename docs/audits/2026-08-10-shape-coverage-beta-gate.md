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

*(scorecard rows 6-10 to follow in this document as each subject completes)*
