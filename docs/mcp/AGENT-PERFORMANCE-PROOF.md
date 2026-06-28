# Agent Performance Proof

This document records the current non-UI proof that Klauro helps coding agents work faster, with less context discovery, while preserving patch quality.

## What Is Proven

Klauro is materially valuable when the task requires behavioral target discovery. The strongest evidence comes from copied-repository live A/B trials where both agents received the same user-level task, but only the with-Klauro arm received a CAS work packet.

The current result is not "Klauro always wins on every tiny edit." On trivial grep-friendly tasks, the work-packet overhead can be neutral or negative. The product claim is narrower and stronger: for non-trivial agentic work where the target is not handed to the agent, Klauro reduces rediscovery cost and keeps quality intact.

Scratch/new-codebase work now has a separate live proof path. `npm run agent-scratch-build-benchmark` starts from an empty folder, gives one arm Klauro greenfield guidance plus capability-memory rules, gives the other arm only product requirements, analyzes both generated projects with normal CAS, and then runs continuation waves on the generated codebase. This directly tests whether Klauro helps agents build large systems without repeatedly re-deciding architecture or rebuilding domain concepts. The harness is now scenario-aware: `work-intake-backend` covers backend/API/data/migration/worker architecture, `project-manager-saas` covers a familiar todo/project-management SaaS with projects, lists, tasks, assignments, comments, labels, notifications, audits, migrations, and digest workers, and `operations-command-center-ui` covers UI-heavy route/view/component/service/domain-contract architecture.

The live harness now supports true divergent-history continuation. Earlier continuation trials copied the with-Klauro initial project into both continuation arms, which was useful for measuring prompt guidance but too weak to prove long-term anti-drift. The corrected runner can continue the with-Klauro arm from the Klauro-built project and the without-Klauro arm from the baseline-built project, so future multi-wave trials can measure accumulated architecture drift, duplicate concepts, and file-placement divergence across separate codebase histories.

There is also a concrete dogfood build, not just a benchmark harness. `npm run agent-scratch-dogfood-build` creates brand-new empty folders, asks Klauro for greenfield architecture guidance before files exist, writes production-shaped products, previews the generated files as normal CAS, analyzes the folders, then adds second product slices using the initial analyses as capability memory. The continuations must reuse existing model chains, avoid duplicate domain definitions, add the expected continuation evidence, and keep focused tests passing. The current dogfood covers two product shapes: a backend reliability platform and a UI-heavy operations command center.

The greenfield loop now has a dedicated product surface: `get_greenfield_build_packet` / `npm run greenfield-build-packet`. It works before a repository exists and then switches into CAS-backed continuation memory after files are written. This is the intended agent loop for building large new systems: ask Klauro for the first-slice packet in an empty folder, create the vertical slice, run tests and analysis, ask for the next packet, and extend the concepts already present instead of rebuilding them. The packet now includes a `growth_control_plane` so agents get an explicit product-slice focus, stop rule, architecture budget, concept ownership contract, duplication gate, and next Klauro loop instead of spending prompt budget re-deciding architecture. It also includes a compact `G1` build capsule so agents can start from a prompt-native first-slice or continuation language instead of injecting the full greenfield packet by default. `npm run greenfield-build-codec-benchmark` now verifies that G1 wins the greenfield prompt-format comparison: current representative results reduce prompt tokens by about 95.5% versus full greenfield JSON for empty-folder first-slice guidance and about 96.5% for CAS-backed continuation guidance.

Task-family coverage is now tracked separately from aggregate proof scores. Run `npm run agent-task-family-coverage` from `apps/mcp-server/` to generate `apps/mcp-server/.klauro-agent-task-family-coverage/latest-report.json` and `.md`. The current report is intentionally stricter about total tokens: a live family is strong only when Klauro improves quality and does not increase total provider tokens. After compacting the existing-project prompt path, tightening scenario validators, normalizing stored quality scores, and scoring relative patch minimality, the latest report is 17 of 17 engineering task families strong, 0 partial, and 0 gaps, for a 100/100 PASS. Strong families include real from-scratch creation, multi-wave greenfield growth, from-zero capability memory, existing-project orientation/targeting, bug diagnosis/root cause, bug fixes, product enhancements, architectural refactors, monolith decomposition, schema/migration work, auth/tenant boundary changes, auth-system replacement, MFA/security enhancement, test targeting, application performance fixes, cross-repo contract changes, and large feature integration.

AI description usefulness now has a dedicated proof path as well. `npm run description-quality-benchmark` simulates weak local-model first drafts, verifies that repair prompts produce stored AI-sourced service, capability, entity, and entry-point descriptions, and rejects deterministic/inventory-shaped text such as "Key capabilities", file coordination summaries, marketing filler, and `[object Object]` leaks. This is separate from `agent-fast`: coding agents keep the cheap structural graph, while UI overview and drilldowns can demand AI-written narrative quality with explicit provenance.

Layered analysis cost is now measured separately from description quality. `npm run analysis-focus-benchmark` proves that `agent-fast` keeps the core graph, agent context, required AI system narrative, and primary capability summaries enabled while deferring lazy entity/flow/node descriptions and semantic embeddings for a 100% reduction in optional enrichment work versus an enriched pass. The same report verifies that UI inspection routes to `ui-overview`, runtime/audit routes to `deep-context`, and ordinary MCP/CLI coding work never defaults to `full`.

Competitor-style context indexing now has a dedicated acceptance-gated proof. `npm run competitor-baseline-benchmark` regenerates the seeded existing-project task suite and compares Klauro's compact MCP packet against repeatable Cursor-style editor/index and Linear-style issue/workflow/code-context proxies. The claim is deliberately scoped: this is not a measurement of Cursor or Linear as products, but it is stable local proof against the main context shapes they represent. The report records quality score, retrieved-file recall/precision, packet tokens, proxy tokens, and per-scenario deltas, and final acceptance fails if Klauro does not show both quality lift and token reduction against both proxies.

True installed-tool comparisons now have a separate live benchmark path. `npm run competitor-live-benchmark` accepts a Klauro-enabled command plus real installed Cursor, Linear, or arbitrary competitor command templates. It runs the same copied-repo live A/B harness used by existing-project proof: each tool gets its own repo copy, the Klauro arm receives the compact CAS/MCP work packet, the competitor arm uses the installed product directly, and the harness captures wall time, diffs, validator results, changed-file precision, and provider token metrics when exposed. This is the proof path to cite for real Cursor/Linear comparisons after those tools are installed and wired through command adapters.

Cold product-output review is now a repeatable artifact instead of a prose caveat. `npm run analysis-output-cold-review` reads the latest full machine proof, samples representative large apps, infrastructure repos, libraries/SDKs, small repos, and Klauro itself, then scores agent-context usefulness separately from human-facing narrative quality. The latest run warns, not fails: average agent context is 97/100, but average narrative quality is 72/100 because the sampled analyses were generated with AI narrative disabled and therefore still carry deterministic-description debt. That is useful evidence for the current product boundary: MCP default use is strong, while UI-overview/human narrative enrichment still needs a targeted pass before claiming "perfect" product output.

Narrative-debt remediation is now measurable instead of hand-waved. `npm run analysis-narrative-enrichment-proof` reads the cold-review findings, loads each stored CAS, and emits a concrete queue of system, capability, service, entity, and entry-point descriptions to regenerate. The latest proof is `warn` with all gates passing: 12/13 narrative-debt outputs have queued element targets, 1/13 is accounted for as no-target debt, 133 enrichment targets were found, description mechanics passed for service/capability/entity/entry-point targets, and `agent-fast` stayed at 0 optional enrichment work while `ui-overview` carried the narrative cost. `npm run analysis-narrative-enrichment-runner` then executes bounded slices and records generated, generated-but-still-weak, target-removed, and before/after queue counts. That keeps the product framing precise: Klauro's default MCP path remains token-minimal, and human-facing polish is an explicit enrichment layer.

Runtime-informed agent work now has a dedicated proof path. `npm run runtime-impact-benchmark` ingests production-shaped telemetry for several CAS targets, including a statically high-risk checkout path and a higher-impact invoice-export failure. The benchmark verifies that ingested runtime errors and volume reorder the agent's "what should I fix today" priority away from the static-only guess, that `get_agent_work_packet` carries the runtime-backed target and next packet, and that the capsule-only K15/K5 response preserves that priority with at least 70% fewer tokens than the full packet. This keeps telemetry positioned as agent guidance, not a replacement safety gate: the fix still flows through normal CAS idioms, invariants, tests, and validation.

Seeded existing-project proof now covers the previously untested improvement families. `npm run agent-existing-task-benchmark` creates small existing codebases with a tenant/workspace visibility leak, blank-title validation bug, direct-controller-data-access refactor, N+1-style task summary path, producer/consumer contract change, task-label product enhancement, due-date migration, workspace-role hardening, simple auth replacement, MFA step-up auth, distributed auth replacement across service/module/controller/test boundaries, monolith decomposition, cross-cutting audit-log feature integration, and test-only archive coverage task. It checks whether MCP work packets include the task-specific behavioral owners, terms, and validation guidance needed before broad rediscovery. Latest deterministic result after switching existing-project default use to `response_profile: "capsule-only"` with compact context capsules plus `K5` execution capsules: pass 94/100 across 14/14 scenarios and 13 families, +33 average score delta versus a blind proxy, 38% fewer files, 96% fewer first-turn tokens than cold scan, and 13% fewer prompt tokens than the Cursor-style lexical index-retrieval proxy. The proof harness expands path aliases and file references before scoring guidance-file coverage, so compact path dictionaries are measured as agent-usable context instead of raw string matches. The default context format is now K15; the codec benchmark reports both the legacy `chars/4` estimate and a stricter promptish lexical estimate. K15 measures about 95 estimated tokens / 85 promptish tokens versus K14 at 98 / 90, K13 at 102 / 102, K12 at 104 / 109, K11 at 112 / 150, K10 at 115 / 167, K9 at 147 / 192, JSONB rowset at about 190 / 207, protobuf-style text at about 206 / 281, YAML brief at about 273 / 263, TOON-style table at about 287 / 261, XML tags at about 303 / 420, and minified JSON at about 354 / 448 on the representative packet. K15 won the balanced prompt-native codec benchmark over minified JSON, short-key JSON, TOON-style tables, YAML/XML prompt blocks, TSV/opcodes, protobuf-style text, JSONB rowsets, CBOR diagnostic JSON, K5+short JSON, K6/K7/K8/K9/K10/K11/K12/K13/K14, and gzip/base64 variants.

Existing-project live proof now includes semantic patch validation. `npm run agent-existing-task-benchmark -- --live ...` runs copied-repo A/B trials through the same live runner used by scratch proof, with external validators that inspect actual diffs for required changed files, forbidden shortcuts, minimality, production/test shape, and behavior-specific patterns. The live engineering-task set now covers diagnosis, bug fix, product enhancement, refactor, migration, auth/tenant hardening, auth replacement, MFA, test-only coverage, performance fix, monolith decomposition, large feature integration, and contract change. Klauro improved quality on every live existing-project task with non-negative token reduction: distributed auth replacement scored 99/100 vs 77/100, audit-feature integration 99/100 vs 90/100, product enhancement 93/100 vs 83/100, migration 95/100 vs 78/100, tenant hardening 99/100 vs 84/100 with 55% fewer tokens, MFA 99/100 vs 84/100 with 34% fewer tokens, performance 99/100 vs 82/100, test-only coverage 99/100 vs 74/100, refactor 95/100 vs 78/100 with 79% fewer tokens, bug fix 99/100 vs 93/100, monolith decomposition 99/100 vs 82/100, and cross-repo contract change 100/100 vs 96/100 with 56% fewer tokens and 28% faster wall time. This is now engineering-task evidence, not merely file-targeting evidence.

The live proof now treats token regression as a product regression. Earlier refactor, MFA, auth/tenant, and first N+1 reruns improved semantic quality but cost more tokens than the unguided arm, so the gate downgraded them. The latest reruns fixed those regressions by making existing-project prompts use compact execution capsules, preserving exact file paths, delegating validation outside the model loop when appropriate, distinguishing required edits from inspect-only owners, and tightening scenario validators so agents follow local ownership instead of over-editing. `K5` now supersedes the earlier `K3`/`K4` layout by folding read/edit scope into exact-path file role sigils. Future live evaluations still downgrade pass status when Klauro uses more total tokens, and task-family coverage only marks live proof strong when quality improves and total token reduction is non-negative.

Latest direct-patch live proof with compact execution capsules:

| Task Shape | With Klauro | Without Klauro | Result |
| --- | ---: | ---: | --- |
| Blank-title validation bug | 100/100 quality, validation passed, 64,469 provider tokens, 5,572 direct provider tokens, 14.7s, 5 turns | 93/100 quality, validation passed, 202,947 provider tokens, 7,884 direct provider tokens, 33.8s, 11 turns | +7 quality, 68% fewer provider tokens, 29% fewer direct provider tokens, 56% faster |
| N+1 task summary path | 100/100 quality, validation passed, 156,075 provider tokens, 8,475 direct provider tokens, 30.7s, 8 turns | 67/100 quality, validation failed, 204,371 provider tokens, 9,091 direct provider tokens, 36.4s, 11 turns | +33 quality, 24% fewer provider tokens, 7% fewer direct provider tokens, 16% faster |

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

Most recent scratch greenfield live trial:

| Task Shape | With Klauro | Without Klauro | Result |
| --- | ---: | ---: | --- |
| Empty-folder work intake backend | 100/100 scratch score, 16 files, 10 source files, 2 test files / 3 test cases, 1 migration, 125 CAS nodes, 141 edges | 92/100 scratch score, 24 files, 17 source files, 1 test file / 3 test cases, 0 migrations, 170 CAS nodes, 154 edges | +8 initial quality delta, 18% faster, fewer changed files |
| Continuation wave on that backend | 100/100 continuation score, 2 test files / 6 test cases, 2 migrations, 147 CAS nodes, 174 edges | 100/100 continuation score, 3 test files / 7 test cases, 2 migrations, 160 CAS nodes, 190 edges | Quality preserved; estimated continuation tokens 64% lower |
| Empty-folder project-manager SaaS | 100/100 scratch score, 25 changed files, 1 test file / 3 test cases, 1 migration, 89 CAS nodes, 70 edges | 92/100 scratch score, 17 changed files, 2 test files / 0 detected test cases, 0 migrations, 164 CAS nodes, 185 edges | +8 quality delta, 56% faster, migration evidence preserved; Klauro used 40% more initial provider tokens |
| Two project-manager continuation waves | 100/100 and 100/100 with Klauro | 90/100 and 90/100 without Klauro | +10 and +10 workspace quality deltas, +57 and +70 changed-file precision deltas, 13% and 3% fewer provider tokens; wave 1 was slower, wave 2 was 16% faster |
| Empty-folder operations command center UI | 100/100 scratch score, 23 files, 17 source files, 3 test files / 3 test cases, 140 CAS nodes, 139 edges | 100/100 scratch score, 26 files, 20 source files, 3 test files / 5 test cases, 135 CAS nodes, 141 edges | Quality preserved; compact Klauro packet fixed token overhead and produced 14% fewer initial tokens, 29% faster |
| Continuation wave on that UI | 100/100 continuation score, 3 test files / 3 test cases | 100/100 continuation score, 3 test files / 4 test cases | Quality preserved; token overhead remains a watch item for UI continuation |

The scratch live benchmark exposed two product issues and produced fixes:

- Scratch report output paths now create their parent directories, so live proof runs cannot fail after the agents finish.
- Scratch scoring now counts focused test cases as well as test files, so agents are rewarded for behavior coverage instead of file proliferation.
- Greenfield scratch packets now use a compact build brief and make the full compact packet optional. The UI initial trial moved from 105% more tokens before compaction to 14% fewer tokens after compaction.
- Continuation waves can now start from each arm's own prior workspace instead of copying one shared baseline. This makes `npm run agent-scratch-build-multi-wave` the stronger live proof command for the "build massive projects cleanly" claim.

Scratch proof artifacts:

- `apps/mcp-server/.klauro-agent-scratch-build-benchmark/live-work-intake-codex-rescored.json`: current backend empty-folder live A/B result after test-case-aware rescoring.
- `apps/mcp-server/.klauro-agent-scratch-build-benchmark/live-work-intake-codex-rescored.md`: markdown summary.
- `apps/mcp-server/.klauro-agent-scratch-build-benchmark/live-work-intake-multi-wave-strict-rescored-codex.json`: backend divergent-history multi-wave live A/B result after strict continuation validation and live-delta-aware rescoring.
- `apps/mcp-server/.klauro-agent-scratch-build-benchmark/live-work-intake-multi-wave-strict-rescored-codex.md`: markdown summary.
- `apps/mcp-server/.klauro-agent-scratch-build-benchmark/live-project-manager-saas-multi-wave-focused-tests-codex.json`: project-manager SaaS divergent-history multi-wave live A/B result after focused-test prompt hardening.
- `apps/mcp-server/.klauro-agent-scratch-build-benchmark/live-project-manager-saas-multi-wave-focused-tests-codex.md`: markdown summary.
- `apps/mcp-server/.klauro-agent-scratch-build-benchmark/live-operations-ui-compact-codex.json`: current UI-heavy empty-folder live A/B result after compact packet fix.
- `apps/mcp-server/.klauro-agent-scratch-build-benchmark/live-operations-ui-compact-codex.md`: markdown summary.
- `apps/mcp-server/.klauro-agent-scratch-build-benchmark/live-operations-ui-multi-wave-strict-codex.json`: UI-heavy divergent-history multi-wave live A/B result.
- `apps/mcp-server/.klauro-agent-scratch-build-benchmark/live-operations-ui-multi-wave-strict-codex.md`: markdown summary.
- `apps/mcp-server/.klauro-agent-scratch-build-benchmark/live-compliance-evidence-multi-wave-strict-codex.json`: compliance/evidence divergent-history multi-wave live A/B result.
- `apps/mcp-server/.klauro-agent-scratch-build-benchmark/live-compliance-evidence-multi-wave-strict-codex.md`: markdown summary.
- `/tmp/klauro-scratch-dogfood-build.json`: latest concrete empty-folder dogfood build report.
- `/Users/michaelshattuck/.klauro/scratch-dogfood-build/reliability-platform`: generated backend scratch product.
- `/Users/michaelshattuck/.klauro/scratch-dogfood-build/operations-command-center`: generated UI-heavy scratch product.
- `/Users/michaelshattuck/.klauro/scratch-dogfood-build/reliability-platform-initial.html`: local CAS preview for the backend initial state.
- `/Users/michaelshattuck/.klauro/scratch-dogfood-build/reliability-platform-continuation.html`: local CAS preview for the backend continuation state.
- `/Users/michaelshattuck/.klauro/scratch-dogfood-build/operations-command-center-initial.html`: local CAS preview for the UI-heavy initial state.
- `/Users/michaelshattuck/.klauro/scratch-dogfood-build/operations-command-center-continuation.html`: local CAS preview for the UI-heavy continuation state.
- `/Users/michaelshattuck/.klauro/from-zero-dogfood/market-signal-ops`: manual from-zero dogfood project created after calling `greenfield-build-packet` on an empty folder.
- `/tmp/klauro-from-zero-initial-packet.json`: first packet for the empty folder; status `ready`, stage `empty_workspace_first_slice`.
- `/tmp/klauro-from-zero-continuation-packet.json`: continuation packet after the first slice; CAS memory reported 41 nodes, 44 edges, 8 capabilities, and 2 tests.
- `/tmp/klauro-from-zero-after-second-slice-packet.json`: packet after the second slice; CAS memory reported 51 nodes, 54 edges, 11 capabilities, and 3 tests.
- `/tmp/klauro-from-zero-dogfood-report.json`: summarized proof artifact.
- `apps/mcp-server/.klauro-from-zero-build-packet-proof/latest-report.json`: latest repeatable multi-domain baseline comparison for from-zero continuation with and without the compact build packet.
- `apps/mcp-server/.klauro-from-zero-build-packet-proof/latest-report.md`: markdown summary of that comparison.
- `/tmp/klauro-from-zero-five-slice-split.json`: previous expanded five-slice from-zero proof with split continuation services.
- `/tmp/klauro-from-zero-five-slice-split.md`: markdown summary of the previous expanded five-slice proof.

Most recent scratch dogfood result:

| Stage | Result |
| --- | --- |
| Backend initial empty-folder build | 11 files, 54 CAS nodes, 58 edges, 7 capabilities, 4 entry points, tests passed |
| Backend continuation using initial analysis memory | 20 files, 94 CAS nodes, 91 edges, 13 capabilities, reused Organization/Workspace/Service/Incident/Alert IDs, zero duplicate core domain definitions, tests passed |
| UI initial empty-folder build | 10 files, 48 CAS nodes, 53 edges, 11 capabilities, 2 entry points, tests passed |
| UI continuation using initial analysis memory | 16 files, 83 CAS nodes, 82 edges, 16 capabilities, reused Workspace/Dashboard/Widget/AnalysisStatus IDs, zero duplicate core domain definitions, tests passed |
| Manual from-zero build packet dogfood | Empty folder packet produced first-slice domain/service/entry/test guidance; after the first slice, the packet used CAS memory to preserve Organization, Workspace, SignalSource, SignalRule, AlertPolicy, OperatorReview, AuditEvent, and SignalDigest; after the second slice, it preserved NotificationPreference, SavedQueueFilter, and SignalRuleComparisonOverlay with zero duplicate domain class definitions |
| Repeatable from-zero baseline comparison | Three scratch domains (`market-signal-ops`, `grant-review-ops`, and `fleet-maintenance-ops`), each starting from an empty folder and then growing through five product slices: first slice, continuation, scale expansion, collaboration expansion, and operations/evidence expansion. With Klauro: tests passed, product-focus guidance was present in every packet, later behavior split into adjacent services while reusing the same domain concepts, no duplicate domain classes were introduced, and the proof scored 100. Without Klauro: tests still passed but created duplicate domain/model classes. Latest expanded result: +96 average quality delta, +18 duplicate-class delta, zero with-Klauro duplicate classes, 27 fewer focused files read, and 13.33% fewer context characters. |
| Live divergent-history backend multi-wave | Strict backend run starts with separate empty-folder A/B projects, then carries each arm's own output through two continuation waves. Latest rescored result: pass, 92/100. Initial arm scores tied at 100/100 after strict validation, but Klauro used 40% fewer initial tokens. Wave 1 preserved quality with +2 live evaluator quality, +67 changed-file precision delta, +45 completion delta, 45% faster, and 2 fewer changed files. Wave 2 preserved quality with +2 live evaluator quality, +63 changed-file precision delta, 39% fewer provider tokens, 28% faster, and 3 fewer changed files. |
| Live divergent-history UI multi-wave | UI-heavy run starts with separate empty-folder A/B projects, then carries each arm's own output through two continuation waves. Latest result: pass, 97/100. Initial arm scores tied at 100/100, but Klauro used 42% fewer initial tokens, finished 31% faster, and changed 15 fewer files. Wave 1 produced +10 live quality, +31 changed-file precision delta, 58% fewer provider tokens, 45% faster, and 10 fewer changed files. Wave 2 produced +10 live quality, +48 changed-file precision delta, +45 completion delta, 43% faster, and 6 fewer changed files. |
| Live divergent-history compliance backend multi-wave | Compliance/evidence run starts with separate empty-folder A/B projects, then carries each arm's own output through two continuation waves. Latest result: pass, 98/100. Klauro passed hard validation with migration evidence; the unguided initial arm failed hard validation for missing migration evidence. Initial workspace quality was 100 with Klauro vs 92 without, while Klauro used more provider tokens and time. Wave 1 produced +10 workspace quality, +9 live quality, +56 changed-file precision, and 56% fewer provider tokens. Wave 2 produced +10 workspace quality, +15 live quality, and +59 changed-file precision, but used more provider tokens and time. This is a quality/file-targeting win with mixed token cost on compliance-shaped work. |
| Overall | PASS, 3/3 live multi-wave scenario families plus deterministic from-zero proof. Quality, continuity, and file-targeting are improving; token/time value is strong in backend/UI and still mixed in compliance continuation. |

The machine proof now enforces this as a gate. The latest full machine run at `apps/mcp-server/.klauro-agent-proof-machine/latest-report.json` passed 100/100 with the from-zero gate present: three passing scenarios, product-focus evidence in all three, 15 growth iterations, +96 average quality delta, +18 duplicate-class delta, 13.33% context reduction, and zero with-Klauro duplicate classes. The full run also verified 102/102 eligible repositories, 102/102 default-use readiness, 102/102 analysis-quality/usefulness/idiom pass, 100% incremental success, 7.18x average edit speedup, and 81% token reduction versus targeted search.

Cold review found one important greenfield product gap: later from-zero continuation packets were good at saying what not to duplicate, but weak at saying where to extend. The build packet now resolves each requested adjacent behavior to existing concepts and owner files. The proof gate now requires continuation `existing_behavior_to_extend` entries with `owner_files`, so a packet cannot pass on prohibition alone.

Important caveat: the evaluator is now more aligned with the product goal, but it is still a heuristic. It checks entry boundaries, data-access boundaries, migrations/persistence evidence, focused continuation tests, CAS graph shape, duplicate-concept avoidance, and owner-file extension guidance for greenfield-shaped tasks. The live proof now covers backend-shaped, UI-shaped, and compliance-shaped divergent-history multi-wave scratch runs. Compliance proves that Klauro can improve quality and file targeting while token/time cost remains mixed, so continuation packets still need ongoing cold review of generated CAS outputs and live agent runs. The G1 capsule is the current compactness fix for greenfield prompts; its repeatable from-zero proof must stay passing before claiming greenfield default-use readiness.

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

The full non-UI product bar is enforced by `npm run agent-vision-acceptance` from `apps/mcp-server/`. That command reads the latest proof artifacts and fails if CAS mastery, default-use agent readiness, real-repo vision coverage, deterministic usefulness, deterministic quality, AI description quality, idiom-quality improvement, from-zero build memory, persisted MCP proof, live scratch-build coverage, divergent-history multi-wave quality/file-targeting proof, machine-wide repo accounting, or incremental edit-loop value stops meeting the thresholds that justify default agent use.

Use `npm run agent-proof-full` when the proof must be regenerated before acceptance. It runs MCP typecheck/tests, all non-UI gauntlets and benchmarks, and then `agent-vision-acceptance`.

Use `npm run agent-task-family-coverage -- --strict` when the question is not "does the aggregate proof pass?" but "have we proven every real engineering task family?" Strict mode now exits zero for the current report because every family is strong under the stricter quality-plus-token bar.

## Deterministic Benchmark Suite

The deterministic agent quality suite covers 48 generated tasks across 6 real repositories.

Latest result:

- Status: pass, 100/100.
- With-Klauro context success: 100%.
- Projected without-Klauro success: 60%.
- Average quality delta: +40 points.
- Token reduction vs targeted search: 89%.
- Time reduction vs targeted search: 87%.
- File reduction vs targeted search: 89%.
- Context completeness: 100/100.

The agent usefulness benchmark covers the same 48-task suite and reports:

- Token reduction vs cold scan: 97%.
- Token reduction vs targeted search: 88%.
- File reduction: 99%.
- Estimated speedup vs cold scan: 200.2x.
- Estimated speedup vs targeted search: 89.07x.

The idiom-quality benchmark now uses a repo/task-sensitive deterministic blind-agent baseline instead of a fixed penalty. The latest report at `apps/mcp-server/.klauro-agent-idiom-benchmark/latest-report.json` passed 96/100 across 23 tasks with +38 idiom-conformance delta and +24 total quality delta. Its without-Klauro model is `repo-task-sensitive-blind-agent-proxy-v2`; penalties vary by idiom category, missed support files, idiom density, confidence, evidence density, and target idiom relevance. Latest penalty range: 18-42, with 9 distinct idiom penalties. Final acceptance fails if deterministic idiom penalties collapse to one constant again.

## Iterative Analysis Proof

The incremental value benchmark copies repositories, runs a full analysis, reruns with no changes, applies a syntactically valid source edit, reruns incremental analysis, verifies that CAS changed, and then asks MCP for a post-edit work packet.

Latest all-eligible machine result:

- Status: pass, 100/100.
- Repositories discovered under `/Users/michaelshattuck/dev`: 105.
- Eligible repositories analyzed: 102/102.
- Unsupported repositories reported with reasons: 3.
- Default-use ready: 102/102.
- Analysis quality/usefulness/idioms: 102/102.
- Incremental targets passed cleanly: 101/102.
- Incremental success rate: 100% stayed incremental.
- Non-pass incremental targets: 0 failed, 1 warned.
- Average full analysis: 9.022s.
- Average no-change incremental analysis: 2.649s.
- Average edit incremental analysis: 1.776s.
- Average no-change speedup vs full: 13.34x.
- Average edit speedup vs full: 7.18x.
- Average post-edit work-packet generation: 143ms.
- Average post-edit file-read plan: 2 files.
- Average post-edit packet size: 3,334 estimated tokens.
- Average total context after edit: 4,500 estimated tokens.
- Average token reduction vs targeted search: 81%.
- Average token reduction vs cold scan: 67%.
- Greenfield continuity proof: 3/3 deterministic scenarios improved, 2/2 continuity trials, +54 average continuity delta.
- Capability memory proof: 34 tasks, 100% hit rate, +52 duplicate-avoidance delta.

Latest all-eligible artifact:

- `apps/mcp-server/.klauro-agent-proof-machine/latest-report.json`
- `apps/mcp-server/.klauro-agent-proof-machine/latest-report.md`

The current machine proof passes every gate. The machine incremental aggregate still has one warning target even though all 102 targets stayed incremental and no target failed; this is treated as an explicit watch item instead of being hidden. A focused rerun of that target, `zerac/releases`, passed 100/100 at 76ms edit incremental time and 3.92x edit speedup, so the aggregate warning appears to be run-level noise rather than a persistent repo failure. Focused follow-up work also fixed the two dominant causes behind earlier severe outliers: file-backed embeddings were rewriting the full vector index once per small batch, and source-only incremental runs were rediscovering analyzer/project roots even when core manifests had not changed.

Latest focused slow-outlier result after those fixes:

- Artifact: `/tmp/klauro-incremental-outliers-detection-cache.json`
- Markdown: `/tmp/klauro-incremental-outliers-detection-cache.md`
- Status: pass, 100/100.
- Targets: 4/4 passed and stayed incremental.
- Average edit speedup vs full analysis: 5.5x.
- Average post-edit packet generation: 1.229s.
- Average token reduction vs targeted search: 100%.
- `truckspyapp`: 70.824s full, 14.778s edit incremental, 4.79x speedup.
- `openclaw`: 54.042s full, 6.953s edit incremental, 7.77x speedup.
- `HogganScientific-Rebuild`: 40.469s full, 12.061s edit incremental, 3.36x speedup.
- `ProtocolApp-Api`: 28.841s full, 4.731s edit incremental, 6.1x speedup.
- `zerac/releases` focused warning rerun: `/tmp/klauro-releases-incr.json`, pass, 100/100, 298ms full, 76ms edit incremental, 3.92x speedup, 47% token reduction vs targeted search.

The full 102-repo machine proof has now been regenerated after these performance fixes and passes the full acceptance suite. The remaining performance work is not correctness; it is reducing first-run latency for the largest mixed-language repos and converting the one incremental warning target into a clean pass.

Earlier focused incremental fixture result:

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

Latest focused incremental benchmark after the compact work-packet fix:

- Status: pass, 100/100.
- Targets: 6.
- Incremental success rate: 100%.
- Average full analysis: 8.612s.
- Average no-change incremental analysis: 391ms.
- Average edit incremental analysis: 1.227s.
- Average no-change speedup vs full: 13.06x.
- Average edit speedup vs full: 4.53x.
- Average post-edit work-packet generation: 80ms.
- Average post-edit file-read plan: 3 files.
- Average post-edit packet size: 7,067 estimated tokens.
- Full-verify count similarity: 99.965%.

This proves the edit loop can stay incremental, detect real CAS deltas from source edits, and produce immediate agent-facing context after a codebase changes.

For the current requirement-by-requirement evidence audit, see `docs/mcp/ANALYSIS-PERFECTION-AUDIT.md`.

## Default-Use Readiness

The agent gauntlet passed 100/100 across 13 configured repositories, with 13/13 marked default-use ready:

- Klauro
- Kadra
- Money
- Zerac UI
- Zerac API
- Zerac Demo
- Zerac Scan
- OpenClaw
- Soon Sync
- Soon UI
- Soon BOS
- SoundSyft
- SoundSyft Backend

The vision gauntlet passed 100/100 across the same real-repo set and found 145 cross-repo links with zero conflicts.

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
- Live benchmarks can now start from a truly empty folder because baseline git commits allow empty baselines.
- `agent-scratch-build-benchmark` adds real empty-folder scratch builds plus continuation waves, can rescore existing live reports with `--score-existing-report`, and supports multiple live scenario families through `--scenario`.
- `agent-scratch-build-multi-wave` runs the same live scratch harness with additional continuation slices. Continuation waves now carry each arm's own prior workspace forward, so this command can expose accumulated duplication and architecture drift that a shared-baseline continuation cannot.
- Scratch greenfield scoring now penalizes missing route/controller boundaries, data-access boundaries, migration evidence, duplicate concepts, weak continuation tests, and missing continuation capabilities instead of counting source-file presence as sufficient quality.
- Generic live evaluation now blends architecture-continuity scoring into greenfield/scratch/continuation quality scores, so future live reports do not need a separate scratch-only interpretation layer to see architecture quality differences.

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

Run the scratch/new-codebase proof from `apps/mcp-server/`:

```bash
npm run agent-scratch-build-benchmark -- \
  --scenario work-intake-backend \
  --live \
  --agent-with-cmd "codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -C {workspace} - < {prompt_file}" \
  --agent-without-cmd "codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -C {workspace} - < {prompt_file}" \
  --timeout-ms 1200000 \
  --work-root /Users/michaelshattuck/.klauro/scratch-build-benchmark \
  --output /tmp/klauro-scratch-build-live.json \
  --markdown /tmp/klauro-scratch-build-live.md
```

Run the UI-heavy scratch live scenario:

```bash
npm run agent-scratch-build-benchmark -- \
  --scenario operations-command-center-ui \
  --live \
  --agent-with-cmd "codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -C {workspace} - < {prompt_file}" \
  --agent-without-cmd "codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -C {workspace} - < {prompt_file}" \
  --timeout-ms 1200000 \
  --work-root /Users/michaelshattuck/.klauro/scratch-build-benchmark \
  --output /tmp/klauro-scratch-build-ui-live.json \
  --markdown /tmp/klauro-scratch-build-ui-live.md
```

List available scratch scenarios:

```bash
npm run agent-scratch-build-benchmark -- --list-scenarios
```

Run the concrete scratch dogfood build from `apps/mcp-server/`:

```bash
npm run agent-scratch-dogfood-build -- \
  --output-root /Users/michaelshattuck/.klauro/scratch-dogfood-build \
  --report /tmp/klauro-scratch-dogfood-build.json
```

Run the repeatable from-zero build-packet comparison:

```bash
npm run agent-from-zero-build-packet-proof
```

Run the prompt-format benchmark for the greenfield build packet:

```bash
npm run greenfield-build-codec-benchmark -- --output /tmp/klauro-greenfield-build-codec-benchmark.json
```

The current proof starts from truly empty folders, builds initial slices, then runs four continuation slices with fresh Klauro build packets before each growth step. The latest expanded multi-domain run is `apps/mcp-server/.klauro-from-zero-build-packet-proof/latest-report.json`: pass, 100/100, 3/3 scenarios passed, 3/3 scenarios carried product-focus packet evidence across all five slices, +96 average quality delta, +18 duplicate-class delta avoided, zero with-Klauro duplicate classes, 27 fewer focused files read, 13.33% fewer context characters, and unguided baselines that still pass tests while duplicating domain/model classes.

Rescore existing scratch live artifacts after evaluator changes:

```bash
npm run agent-scratch-build-benchmark -- \
  --score-existing-report /tmp/klauro-scratch-build-live-clean.json \
  --output /tmp/klauro-scratch-build-live-clean-rescored.json \
  --markdown /tmp/klauro-scratch-build-live-clean-rescored.md
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

When the live agent is Claude Code, measure Klauro-guided execution in lean mode:

```bash
claude -p --safe-mode --no-session-persistence --permission-mode bypassPermissions \
  --add-dir {workspace} --output-format json -- "$(cat {prompt_file})"
```

This keeps both arms on the same agent while removing unrelated project memory, plugin, hook, and session-persistence overhead from the measurement. The `--` before the prompt is required because `--add-dir` accepts multiple directories and can otherwise consume the prompt. The benchmark still records provider token totals and direct provider tokens; non-lean Claude commands are reported as `full-agent` so a token regression is not mistaken for a CAS packet failure.
