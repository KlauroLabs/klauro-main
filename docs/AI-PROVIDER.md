# AI Provider Setup (self-hostable, GPU-free, low-cost)

Klauro's analysis is **deterministic-first**: the system description, domains, and
primary capabilities are produced from source-backed evidence and are correct even
with a weak or absent model. AI is *flavoring* — it turns the deterministic fact
sheet into prose. So you do **not** need a frontier model, a GPU, or Anthropic.

## Recommended posture: cheap open 70B + local fallback

The AI layer is provider-agnostic (`packages/analyzer-core/src/config/ai.config.ts`)
and cascades through providers in order (`AI_FALLBACK_PROVIDERS`, default
`openai,claude,local,fallback`). Point the OpenAI-compatible client at a cheap host
running an **open-weight** model; keep the local CPU model as the automatic fallback.

```bash
# Primary: any OpenAI-compatible host running an open 70B
#   (Groq / DeepInfra / Together / OpenRouter / your own vLLM box)
export OPENAI_BASE_URL="https://api.groq.com/openai/v1"   # example
export OPENAI_API_KEY="sk-..."
export OPENAI_MODEL="llama-3.3-70b-versatile"             # or qwen2.5-72b-instruct

# Optional but RECOMMENDED for reliability: a faster, cheaper model for the
# structured-extraction calls (capability catalog + workspace merge). These are
# dedup/classify/format-to-JSON tasks an 8B model handles well, and a fast model
# avoids the timeouts that variable shared-70B latency causes on those calls.
# Prose descriptions/narrative still use OPENAI_MODEL.
export OPENAI_STRUCTURED_MODEL="meta-llama/Meta-Llama-3.1-8B-Instruct"  # example (DeepInfra)

# Fallback: local CPU model (no GPU). ONNX is the zero-dependency default;
# Ollama gives better prose if installed.
export AI_LOCAL_MODEL="onnx-community/Qwen2.5-0.5B-Instruct"   # default, $0
# or, with Ollama running locally:
#   export OLLAMA_BASE_URL="http://127.0.0.1:11434"
#   export OLLAMA_MODEL="qwen2.5:7b-instruct"

# Workspace (WAS) narrative pass tuning
export KLAURO_WORKSPACE_AI_MAX_TOKENS=650
export KLAURO_WORKSPACE_AI_TIMEOUT_MS=120000   # raise for slow CPU fallback
```

Everything here is open-weight, so anything you run hosted now can be repatriated to
your own CPU box (e.g. a Hetzner dedicated-CPU VPS running Ollama exposed as
OpenAI-compatible) without touching Klauro.

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
export OPENAI_BASE_URL="https://api.groq.com/openai/v1"   # any OpenAI-compatible 70B host
export OPENAI_API_KEY="sk-..."
export OPENAI_MODEL="llama-3.3-70b-versatile"             # or qwen2.5-72b-instruct
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

The same provider cascade and AI cache (above) apply, so re-analysis of unchanged code is free.

## Cost guardrail (keeps real cost ~$1–5/mo)

Cost is driven by **which calls reach the paid host**, not by analysis volume:

- **Required** system/workspace summaries (description + domains + capabilities) —
  one bounded JSON call per repo plus one per workspace, ~3–4k tokens each, minus the
  content-hashed AI cache (`~/.klauro/ai-cache`). Route these to the hosted 70B.
- **Node/function-level descriptions and embeddings** — keep these **local and lazy**.
  Node descriptions are optional (`lazy` is a first-class flag) and embeddings have a
  local ONNX provider, so both can stay `$0`. Routing *these* to a paid model is the
  only way to exceed the budget.

Keep `AI_CACHE_ENABLED=true` (default) and use incremental analysis so unchanged code
re-uses cached AI output for free.

## Offline / fully self-hosted

Drop the `OPENAI_BASE_URL` block entirely. The default is local ONNX
(`onnx-community/Qwen2.5-0.5B-Instruct`) on CPU — fully private, `$0`, no GPU. With the
deterministic-first fixes, the workspace narrative is still specific and correctly
identifies domains (e.g. a crypto/digital-asset workspace) even on the small local
model, because the evidence handed to it is already ranked and crypto-aware.
