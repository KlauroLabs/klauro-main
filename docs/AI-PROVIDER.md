# AI Provider Setup (hosted, low-cost)

Klauro's analysis is **deterministic-first**: the system description, domains, and
primary capabilities are produced from source-backed evidence first, then AI
turns that evidence into concise, defensible prose. In the commercial product,
that AI enrichment runs on the hosted analyzer service, not on a customer's
laptop.

## Recommended posture: cheap hosted open-weight model

The AI layer is provider-agnostic (`packages/analyzer-core/src/config/ai.config.ts`)
and cascades through hosted providers in order (`AI_FALLBACK_PROVIDERS`, default
`openai,claude,fallback`). Point the OpenAI-compatible client at a cheap hosted
open-weight provider. DeepInfra is the current default recommendation for alpha.

```bash
# Primary: DeepInfra, first-class OpenAI-compatible hosted inference.
# Keep this secret out of the repo. Export it in the shell/service env that
# launches the hosted analyzer.
export DEEPINFRA_API_KEY="..."
export DEEPINFRA_MODEL="meta-llama/Meta-Llama-3.3-70B-Instruct"

# Optional but RECOMMENDED for reliability: a faster, cheaper model for the
# structured-extraction calls (capability catalog + workspace merge). These are
# dedup/classify/format-to-JSON tasks an 8B model handles well, and a fast model
# avoids the timeouts that variable shared-70B latency causes on those calls.
# Prose descriptions/narrative still use DEEPINFRA_MODEL.
export DEEPINFRA_STRUCTURED_MODEL="meta-llama/Meta-Llama-3.1-8B-Instruct"

# Optional compatibility form, useful for other OpenAI-compatible providers:
# export OPENAI_BASE_URL="https://api.deepinfra.com/v1/openai"
# export OPENAI_API_KEY="$DEEPINFRA_API_KEY"
# export OPENAI_MODEL="$DEEPINFRA_MODEL"
# export OPENAI_STRUCTURED_MODEL="$DEEPINFRA_STRUCTURED_MODEL"

# Workspace (WAS) narrative pass tuning
export KLAURO_WORKSPACE_AI_MAX_TOKENS=650
export KLAURO_WORKSPACE_AI_TIMEOUT_MS=120000
```

Customer machines should not set DeepInfra/OpenAI/Anthropic keys, run Ollama, or
download local model weights for Klauro. Local connectors do deterministic
indexing, cache reads, and branch overlays; hosted analyzers do the AI work.

## Capability & description AI overlay (the interpretation layer)

Klauro's pipeline is **deterministic facts → AI interpretation**. The analyzer extracts honest
structural facts (capability groupings, the data entities each touches, operations, entry-point
surfaces, repo-relative file paths) and writes a fact-grounded deterministic description. The AI
overlay then rewrites those facts into prose, grounded by `element-description-validator.ts` (which
rejects ungrounded/marketing/restated output and triggers a repair pass), and **falls back to the
deterministic description** whenever AI is unavailable or its output fails the grounding gate.

This overlay is **ON by default** (CAS-level capability/entity description interpretation). To get
AI prose instead of the deterministic baseline, point it at a capable model:

```bash
export DEEPINFRA_API_KEY="..."
export DEEPINFRA_MODEL="meta-llama/Meta-Llama-3.3-70B-Instruct"
export DEEPINFRA_STRUCTURED_MODEL="meta-llama/Meta-Llama-3.1-8B-Instruct"
# Give the interpretation pass enough wall-clock for a hosted model:
export KLAURO_AI_INTERPRETATION_BUDGET_MS=120000
```

Behavior:
- **Capable model configured** → capability/entity descriptions become `description_source: 'ai'`,
  grounded on the deterministic facts (the entities/operations/domains each capability touches).
- **No model / model fails grounding** → `description_source: 'deterministic'` with the honest
  fact-grounded text ("Payments Management creates and deletes payments records through 8 HTTP
  routes (src/app/controllers/payment/payment.controller.ts)"). Never canned, never brand-keyed.
- To disable the overlay entirely (pure deterministic): `export KLAURO_AI_INTERPRETATION=false`.

The same hosted provider cascade and AI cache (above) apply, so re-analysis of
unchanged code reuses cached AI output.

## Proving the hosted provider was used

CAS/WAS enrichment must not silently fall back to local inference when hosted
DeepInfra is expected. Set:

```bash
export KLAURO_EXPECT_AI_PROVIDER=deepinfra
```

Workspace artifacts and gauntlet reports include `ai_enrichment.provider`,
`ai_enrichment.model`, and `ai_enrichment.structured_model`. With
`KLAURO_EXPECT_AI_PROVIDER=deepinfra`, the workspace gauntlet fails if the run
uses OpenAI fallback, Anthropic fallback, or deterministic fallback instead.

## Cost guardrail (keeps real cost ~$1–5/mo)

Cost is driven by **which calls reach the paid host**, not by analysis volume:

- **Required** system/workspace summaries (description + domains + capabilities) —
  one bounded JSON call per repo plus one per workspace, ~3–4k tokens each, minus the
  content-hashed AI cache (`~/.klauro/ai-cache`). Route these to the hosted 70B.
- **Node/function-level descriptions and embeddings** — keep these **lazy**.
  Node descriptions are optional (`lazy` is a first-class flag), and embedding-heavy
  enrichment should run only when an MCP/API caller needs it.

Keep `AI_CACHE_ENABLED=true` (default) and use incremental analysis so unchanged code
re-uses cached AI output for free.

## Self-hosted analyzer deployments

Self-hosted Klauro can point the hosted analyzer process at a private
OpenAI-compatible endpoint, including a CPU-only inference box, but that endpoint
is still server-side from the customer's perspective. The local MCP connector
does not run AI enrichment.
