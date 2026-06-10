# CAS Determinism Boundary

Status: implemented and verified as of this audit. Everything described here is current behavior unless explicitly marked planned.

## Guarantee

Every structural claim in a CAS output is produced deterministically from source analysis. AI is used only to generate descriptive text (system description, domain label, element descriptions), every AI-written value carries provenance fields, and a failed, disabled, or absent AI provider never changes the structure of the output.

Structural fields with zero AI influence:

`nodes`, `edges`, `entry_points`, `exit_points`, `route_table`, `database_schema`, `data_entities` (fields, lifecycle, relationships), `system_capabilities` (id, category, criticality, operations, related_entities, related_domains), `patterns`, `flow_graph`, `call_chains`, `workflows`, `workflow_graph`, `behavioral_invariants`, `codebase_idioms`, `security_boundaries`, `security_contexts`, `security_summary`, `change_risks`, `analysis_facts`, `test_suites`, `test_summary`, `method_calls`, `progressive_levels`, `architecture_summary`, `external_services`, `repository_links`, `configuration`, `runtime`, `validation`.

The AI interpretation pass (`applyAIInterpretation` in `packages/analyzer-core/src/analyzer/core/orchestrator.ts`) runs after `buildEnhancedSystemPurpose` and writes only the fields listed in the table below. `buildAnalysisFacts` and `detectCodebaseIdioms` run after the AI pass but read only structural capability fields (name, category, criticality, operations), never descriptions.

## AI-touchable fields

| Field | Writer | Provenance mechanism | Notes |
|---|---|---|---|
| `enhanced_system_purpose.inferred_description` | `applyAIInterpretation` (orchestrator.ts) | `description_source` ('deterministic' / 'ai' / 'manual' / 'reused') + `description_generation` (`CASDescriptionGeneration`: status, attempted, reason, budget_ms, generated_at) | Deterministic heuristic text is the default; AI text replaces it only after passing `validateAIInterpretation` quality gates. On skip/failure/rejection the deterministic text is kept and the generation record says why. |
| `enhanced_system_purpose.primary_domain` | `applyAIInterpretation` | `domain_source` ('deterministic' / 'ai' / 'reused') | Deterministic value from domain extraction by default. An AI relabel is applied only when `normalizeAIDomainLabel` and `isGroundedAIDomainLabel` accept it, and is always tagged `domain_source: 'ai'`. It is a display label; no structural field is derived from it after the AI pass. |
| `system_capabilities[].description` | `applyElementDescription` (orchestrator.ts), called from `applyAIInterpretation` / `applyAIElementDescriptions` | `description_source` + `description_generation` | 'ai' for accepted generated text, 'manual' for the curated catalog in `curatedElementDescription`, 'deterministic' when AI text was rejected or skipped, 'reused' when carried forward by incremental analysis. id, category, criticality, and operations are never AI-written. |
| `data_entities[].description` | `applyElementDescription` | `description_source` + `description_generation` | In the analysis pipeline, entities are only ever stamped with provenance records; AI-generated entity text currently arrives only through the manual MCP path below (`applyAIElementDescriptions` with `includeEntities` is not invoked by the pipeline). |
| `nodes[]/data_entities[]/system_capabilities[]/entry_points[]/exit_points[].description` (manual enrichment) | `apps/mcp-server/src/description-enrichment.ts` (`generateElementDescription`, `applyStoredElementDescriptions`) | `description_source: 'ai'` + `description_generation` (status `ai_applied`, reason `manual-trigger` / `manual-trigger-repaired` / `stored-manual-description`), plus an out-of-band store (`element-descriptions.json`) with a content fingerprint that invalidates stale text | Explicit user-triggered path. Descriptions failing the quality gate are never stored. Only the `description` string and its provenance fields are written. |
| `analysis_phases[]` (status of `ai-system-narrative` / `deferred-element-descriptions`) | `buildAnalysisPhases` (orchestrator.ts) | The phase record is itself provenance metadata | Phase status reflects whether AI ran and succeeded. It describes the generation process and is not a structural claim about the analyzed codebase. |
| `embedding_index` | `EmbeddingPhase.run` (`packages/analyzer-core/src/analyzer/embedding/embedding-phase.ts`) | `model`, `provider`, `coverage`, `degraded`, `degraded_reason` | Coverage metadata only. Vectors live in the vector store, not in CAS, and nothing in CAS structure is derived from them. The phase also backfills `node.source.raw` from local file content, which is deterministic file reading, not AI output. |

`enhanced_system_purpose.description_source = 'reused'` and capability `description_source = 'reused'` are set by incremental analysis when prior AI/manual text is carried forward unchanged (orchestrator.ts incremental path); the original source is preserved in `description_generation.reason`.

## Kill switches

- `KLAURO_AI_INTERPRETATION=false` disables the system-description/domain pass (`description_generation.reason: 'disabled-by-env'`).
- `KLAURO_AI_ELEMENT_DESCRIPTIONS=false` disables capability/entity description generation.
- `KLAURO_EMBEDDING_ENABLED=false` disables the embedding phase (read in `apps/mcp-server/src/analyzer.ts`; the core orchestrator runs no embedding unless `configureEmbedding` is called).
- With no provider configured (no `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `AI_LOCAL_ENABLED`), all AI passes are skipped with `reason: 'no-ai-provider-configured'`.

In every disabled/failed case the deterministic text remains and structure is byte-identical to an AI-enabled run.

## Run-to-run stability

Beyond AI-on/off equality, repeated analyses of the same unchanged source tree produce an identical CAS, byte-for-byte, except for a small allowlist of run metadata:

- `analysis_timestamp` (top-level)
- `analysis_id` (top-level, time-and-random run identifier; it never appears anywhere else in the output)
- `generated_at` (inside `description_generation` records and `analysis_phases`)
- `execution_time_ms` (inside `analyzer_contributions` and `analysis_phases`)

Everything else is guaranteed identical across runs: node, edge, entry-point, and exit-point arrays in the same order, all derived structures (`index`, `progressive_levels`, `analysis_facts`, `test_gaps`, `temporal_stability`, `system.quality` including floating-point aggregates), descriptions, capabilities, journeys, conformance, lineage, and the product map.

Three mechanisms enforce this:

1. File discovery in the language analyzers sorts glob results before emission (`glob` v9+ returns results in nondeterministic filesystem order).
2. The orchestrator applies a canonical ordering (`applyCanonicalOrdering` in `packages/analyzer-core/src/analyzer/core/orchestrator.ts`) to merged nodes (by source file, line, id; nodes without a source file sort last), edges (by source, target, type, id), entry points, exit points, and libraries before and after route-handler linking, so every downstream builder and order-sensitive aggregate (such as the maintainability index average) consumes a deterministic sequence.
3. Selections that previously fell back to array order now use explicit tie-breaks: the orientation fallback entry point (`selectFallbackEntryNode`) breaks score ties by connection degree, then source file, line, and id, so the synthesized `entry_orientation_*` entry point is identical across runs.

Regression test (two full in-process analyses, deep equality of the full CAS minus the allowlist above):

```bash
cd packages/analyzer-core
npx jest src/__tests__/ai/run-stability.test.ts
```

## Not in the pipeline

`packages/analyzer-core/src/ai/ai-analyzer.ts` (risk assessment, recommendations, code analysis via AI) is not imported by the orchestrator or any pipeline code; only its own tests reference it. It does not influence CAS output.

## Audit findings (this audit)

- No structural leak found: no AI output feeds nodes, edges, entry/exit points, capability operations or criticality, patterns, flows, call chains, workflows, invariants, idioms, or security data.
- Fixed: `CASEntryPoint` and `CASExitPoint` in `packages/analyzer-core/src/types/cas.types.ts` did not declare `description_source` / `description_generation` even though the manual enrichment path writes them. The fields are now declared, matching the provenance pattern used by nodes, entities, and capabilities.

## How to re-verify

Grep entry points (every AI write into CAS must appear in these results and must route through a provenance-stamping helper):

```bash
grep -rn "aiService\|generateComponentDescription" packages/analyzer-core/src --include="*.ts" | grep -v __tests__
grep -rn "applyElementDescription\|recordDescriptionGeneration\|description_source" packages/analyzer-core/src/analyzer/core/orchestrator.ts
grep -rn "applyDescriptionToTarget\|description_source" apps/mcp-server/src/description-enrichment.ts
```

Expected invariants:

1. The only `aiService` import in pipeline code is `packages/analyzer-core/src/analyzer/core/orchestrator.ts`.
2. Every assignment of AI text goes through `applyElementDescription`, `recordDescriptionGeneration`, or `applyDescriptionToTarget`, each of which writes `description_source` and `description_generation` alongside the text.
3. No structural builder reads `description`, `description_source`, or `inferred_description`.

Regression test (runs a full analysis with AI off, with AI enabled but a failing provider, and with AI enabled and a mocked successful provider, and asserts structural equality of nodes, edges, entry points, exit points, and capability ids/operations across all three):

```bash
cd packages/analyzer-core
npx jest src/__tests__/ai/determinism-boundary.test.ts
```

## Planned (not implemented)

- Runtime telemetry correlation may later add runtime evidence to CAS; it is intended to remain deterministic (measured, not generated).
- On-demand AI descriptions for additional element kinds beyond the current manual MCP path are described in the deferred `analysis_phases` entry but only run when explicitly requested.
