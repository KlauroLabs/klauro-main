# Agent Performance Proof

This document records the current non-UI proof that Klauro helps coding agents work faster, with less context discovery, while preserving patch quality.

## What Is Proven

Klauro is materially valuable when the task requires behavioral target discovery. The strongest evidence comes from copied-repository live A/B trials where both agents received the same user-level task, but only the with-Klauro arm received a CAS work packet.

The current result is not "Klauro always wins on every tiny edit." On trivial grep-friendly tasks, the work-packet overhead can be neutral or negative. The product claim is narrower and stronger: for non-trivial agentic work where the target is not handed to the agent, Klauro reduces rediscovery cost and keeps quality intact.

## Live A/B Trials

Most recent copied-repository live trial:

| Codebase | Task Shape | With Klauro | Without Klauro | Result |
| --- | --- | ---: | ---: | --- |
| Zerac API | No explicit class/path; fix service-account activity logging and add focused tests | 218,551 tokens, 215.7s, 10 files read, 2 files changed, validation passed | 476,638 tokens, 232.9s, 13 files read, 2 files changed, validation passed | 54% fewer tokens, 7% faster, equal success, quality within 1 point |
| Kadra | No explicit file/path; fix `PUT /v1/settings` provider normalization and add focused tests | 69,529 tokens, 163.2s, 4 files read, 2 files changed, validation passed | 258,078 tokens, 250.3s, 7 files read, 2 files changed, validation passed | 73% fewer tokens, 35% faster, equal quality |

Combined across the current two no-target live trials:

- Provider tokens: 288,080 with Klauro vs 734,716 without Klauro, about 61% fewer tokens.
- Wall time: 378.9s with Klauro vs 483.3s without Klauro, about 22% faster.
- Files read: 14 with Klauro vs 20 without Klauro, about 30% fewer files.
- Patch quality: both arms passed validation in both trials; Klauro preserved quality while reducing discovery work.

Historical no-target live trials remain useful for trend evidence:

- `live-hard-zerac-api-inferred`: 52% fewer tokens, 21% faster, equal validation success.
- `live-hard-kadra-inferred`: 13% faster and 57% fewer files read, equal validation success; token usage was roughly neutral.
- `live-current-zerac-api`: 54% fewer tokens, 7% faster, equal validation success.
- `live-current-kadra`: 73% fewer tokens, 35% faster, equal validation success.

The generated live reports are local benchmark artifacts:

- `.klauro-agent-quality-benchmark/live-current-zerac-api.json`
- `.klauro-agent-quality-benchmark/live-current-zerac-api.md`
- `.klauro-agent-quality-benchmark/live-current-kadra.json`
- `.klauro-agent-quality-benchmark/live-current-kadra.md`
- `.klauro-agent-quality-benchmark/live-hard-zerac-api-inferred.json`
- `.klauro-agent-quality-benchmark/live-hard-zerac-api-inferred.md`
- `.klauro-agent-quality-benchmark/live-hard-kadra-inferred.json`
- `.klauro-agent-quality-benchmark/live-hard-kadra-inferred.md`

Persisted MCP reports can be inspected with `get_agentic_benchmark_report`. Use `benchmark_type` to load the latest report for a specific family, or call `get_agent_performance_proof` to ask MCP for the current proof summary across live quality, deterministic usefulness, and incremental-analysis reports. The proof summary defaults to reports generated in the last 7 days and rolls up persisted live A/B reports, so the current two-trial live evidence is available directly through MCP as 61% fewer tokens, 22% faster wall time, and 30% fewer files read.

The full non-UI product bar is enforced by `npm run agent-vision-acceptance` from `apps/mcp-server/`. That command reads the latest proof artifacts and fails if CAS mastery, default-use agent readiness, real-repo vision coverage, deterministic usefulness, deterministic quality, copied-repo live A/B evidence, or incremental edit-loop value stops meeting the thresholds that justify default agent use.

Use `npm run agent-proof-full` when the proof must be regenerated before acceptance. It runs MCP typecheck/tests, all non-UI gauntlets and benchmarks, and then `agent-vision-acceptance`.

## Deterministic Benchmark Suite

The deterministic agent quality suite covers 48 generated tasks across 6 real repositories.

Latest result:

- Status: pass, 100/100.
- With-Klauro context success: 100%.
- Projected without-Klauro success: 59%.
- Average quality delta: +41 points.
- Token reduction vs targeted search: 89%.
- Time reduction vs targeted search: 89%.
- File reduction vs targeted search: 91%.
- Context completeness: 100/100.

The agent usefulness benchmark covers the same 48-task suite and reports:

- Token reduction vs cold scan: 96%.
- Token reduction vs targeted search: 89%.
- File reduction: 99%.
- Estimated speedup vs cold scan: 165.65x.
- Estimated speedup vs targeted search: 86.64x.

## Iterative Analysis Proof

The incremental value benchmark copies repositories, runs a full analysis, reruns with no changes, applies a syntactically valid source edit, reruns incremental analysis, verifies that CAS changed, and then asks MCP for a post-edit work packet.

Latest result:

- Status: pass, 100/100.
- Targets: 6.
- Incremental success rate: 100%.
- Average full analysis: 13.628s.
- Average no-change incremental analysis: 856ms.
- Average edit incremental analysis: 7.236s.
- Average no-change speedup vs full: 10.61x.
- Average edit speedup vs full: 2.16x.
- Average post-edit work-packet generation: 172ms.
- Average post-edit file-read plan: 2 files.
- Average post-edit packet size: 6,503 estimated tokens.
- Full-verify count similarity: 99%.

This proves the edit loop can stay incremental, detect real CAS deltas from source edits, and produce immediate agent-facing context after a codebase changes.

## Default-Use Readiness

The agent gauntlet passed 100/100 across 12 configured repositories, with 12/12 marked default-use ready:

- Klauro
- Kadra
- Money
- Zerac UI
- Zerac API
- Zerac Demo
- Zerac Scan
- Soon Sync
- Soon UI
- Soon BOS
- SoundSyft
- SoundSyft Backend

The vision gauntlet passed 100/100 across the same real-repo set and found 208 cross-repo links with zero conflicts.

The analysis mastery gauntlet passed 100/100 across the built-in ground-truth fixtures, with truth expectations, framework depth, runtime instrumentation readiness, semantic map availability, and agent task proof all passing.

## What Changed Because Of The Proof Runs

The live trials exposed and fixed product-level gaps:

- Natural-language tasks now infer likely CAS targets from instructions and success criteria, so users do not need to name exact classes or files.
- Route nodes receive stronger ranking when the task names an HTTP method/path such as `PUT /v1/settings`.
- Concrete implementation nodes outrank DTO properties, tests, imports, and synthetic call-site nodes when they are better edit targets.
- Agent work packets filter out structural edges such as `contains`, `provides`, and `has_method` from the first read plan, leaving behavioral callers/callees and tests.
- Validation plans and focused test guidance are included in live work packets, so Klauro can improve patch quality, not only locate files.
- Agent work packets now compact repository-wide risk summaries and enforce call-chain limits, keeping default MCP context useful without bloating token usage.
- File-read plans now include bounded line windows, so agents can inspect the relevant slice of a large file first and expand only when the local evidence requires it.
- Validation plans resolve package-level scripts from monorepo roots, so a root-path task can still get concrete commands such as `cd packages/analyzer-core && npm test` or `cd apps/mcp-server && npm run typecheck`.
- Python API route tasks now infer conventional API test files such as `tests/test_api.py`, so agents get focused pytest commands instead of a validation gap.
- Live with-Klauro prompts now read the precomputed MCP work packet first instead of spending time regenerating analysis during the benchmark.
- Live evaluation no longer treats route strings such as `/v1/settings` as expected edit-file paths when scoring changed-file precision.
- Incremental analysis now forces a full rebuild when cached CAS is stale or missing agent-critical fields such as graph integrity, call chains, or analysis facts.
- Live copied-repo benchmarks exclude local virtual environments, caches, and build artifacts, and now fail fast if a clean git baseline cannot be created.
- Live benchmark reports separate patch quality, command completion, hidden validation, changed-file precision, token usage, and wall-clock time.
- Incremental benchmarks now apply language-aware source edits, require edit detection, require CAS deltas, verify post-edit full-analysis parity, and record the exact edit kind in the JSON and Markdown reports.
- Agent CLI compact JSON now emits bounded `line_window` metadata, so a non-MCP agent can consume the same focused read plan without expanding entire files.
- Installed agent defaults now preserve selected-path routing metadata for monorepos and avoid unresolved placeholders in generated defaults.
- Integration-depth reports now separate extracted missing depth from unobserved optional surfaces, so agents are not misled by broad keywords such as finance exchanges or HTML span symbols.
- Analysis mastery reports now separate blocking gaps from non-blocking agent observations, so fixture caveats do not masquerade as failed proof.
- Incremental benchmark workspaces now discard copied repositories by default, exclude local environments and dependency caches such as `.venv`, and compact test/invariant evidence in work packets so proof runs stay operational and token-bounded.

## How To Reproduce

Run deterministic suites from `apps/mcp-server/`:

```bash
npm run agentic-benchmark-suite
npm run agent-quality-benchmark
npm run incremental-benchmark -- --output .klauro-incremental-benchmark/latest-report.json --markdown .klauro-incremental-benchmark/latest-report.md
npm run agent-gauntlet
npm run vision-gauntlet
npm run analysis-gauntlet
npm run agent-vision-acceptance
```

Or run the same non-UI proof sequence as one command:

```bash
npm run agent-proof-full
```

Run a copied-repo live trial from `apps/mcp-server/`:

```bash
npx tsx src/agent-quality-benchmark.ts \
  --repo zerac-api=/Users/michaelshattuck/dev/zerac/zerac-api \
  --task-type modify \
  --instructions "Fix service-account activity logging so logUserActivity persists the provided serviceAccountId when the target is a service account or when dto.serviceAccountId is supplied. Preserve existing resource/network service inference and do not change unrelated activity log behavior." \
  --success-criterion "libs/business/agent/src/services/activityLog.service.ts uses dto.serviceAccountId to populate the serviceAccount field" \
  --success-criterion "Focused regression coverage is added or an existing focused test is updated when feasible" \
  --agent-with-cmd "codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -C {workspace} - < {prompt_file}" \
  --agent-without-cmd "codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -C {workspace} - < {prompt_file}" \
  --test-command "git diff --check && grep -q 'dto.serviceAccountId' libs/business/agent/src/services/activityLog.service.ts" \
  --work-root /Users/michaelshattuck/.klauro/agent-live-trials \
  --timeout-ms 600000 \
  --test-timeout-ms 60000 \
  --output .klauro-agent-quality-benchmark/live-hard-zerac-api-inferred.json \
  --markdown .klauro-agent-quality-benchmark/live-hard-zerac-api-inferred.md
```

For fair live proof, keep implementation paths out of the agent prompt whenever the point is target discovery. Hidden validation may still assert exact files, strings, tests, or diffs through `--test-command`.
