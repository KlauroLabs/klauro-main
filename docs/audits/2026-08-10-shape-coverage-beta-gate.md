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

---

*(scorecard rows and per-shape verdicts to follow in this document as each
subject completes)*
