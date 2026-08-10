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

---

*(scorecard rows 3-10 to follow in this document as each subject completes)*
