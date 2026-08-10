# Capability catalog variance findings (task #33)

**Date:** 2026-08-10
**Method:** blackbox only — `klauro` CLI (`analyze`/`init`/`status`) and
`mcp__klauro__get_summary` / `get_conceptual_analysis` against the hosted
product (`mcp.klauro.com`), plus read-only code inspection of the analyzer
source (`packages/analyzer-core/src`, `apps/mcp-server/src`) in an isolated
`git worktree` at `master` (`a3004f12`). No engine import, no AI env var set,
no `klauro login`. All hosted work respected the one-analysis-at-a-time /
load-check-first constraint; SSH to the VPS rate-limited partway through, so
load was checked via `mcp.klauro.com/health` request latency as a proxy after
that point.

## Summary

Live measurement (8 genuine, independently-verified hosted analysis runs
across two subjects of different size) found **zero capability-set variance**
— but that result is a measurement of the AI response cache working
correctly, not of AI-sampling determinism, and the report below says so
explicitly rather than claiming "no variance." The strongest evidence on the
actual question (deterministic-candidate-set vs. AI-naming-layer as the
source of #33's original variance) comes from code already in the repo: a
postmortem comment at `orchestrator.ts:11463-11466` and a cache-key comment at
`ai-service.ts:611-614` that together settle the attribution. See Finding 3.

## Method: forcing genuine re-runs

Two subjects were used, copied to scratch dirs (owner repos never touched —
verified via `git status`/`git fsck` before and after):

- **Subject A ("small"):** 166 files, TypeScript/JS + React + shell, single
  deployable.
- **Subject B ("large"):** ~3,868 TS/JS source files, multi-surface (chat,
  voice, gateway, scheduling).

`klauro analyze --force` does **not** force a fresh run — `--force` is parsed
into `parsed.force` at `cli.ts:1932-1933` but never passed into
`analyzeCodebaseRemotely` at the `analyze` command's call site
(`cli.ts:392-399`), so it is a dead flag for this command. It is live for the
`purge`/`init` commands where it's actually threaded through, which is a
separate, real bug worth its own fix but out of scope here.

Instead, each "run" used `klauro init <path> --workspace <unique-name>`,
which (per `placeHostedProjectHeadless`, `cli.ts:1609-1639`) creates a
genuinely new hosted workspace + project when the workspace name doesn't
already exist, guaranteeing the subsequent `analyze` call has no prior stored
revision to reuse (confirmed every time via the response's
`reuse_decision: {reused: false, reason: "Source snapshot differs from every
stored revision"}`).

**Completion was verified against the authoritative endpoint, not the CLI's
return or `klauro status` text.** `klauro analyze` returns as soon as the
upload is accepted, well before the server-side analysis finishes (confirmed:
one run's CLI call returned in seconds while the server took 51s-334s to
actually finish). `klauro status` can print a stale "fresh"/"ready" reading
while `last_attempt.state` is still `in-progress` (observed directly — see
raw poll log excerpts below). Every one of the 8 samples was instead
confirmed via `GET /api/projects/{id}/analysis-status` polled to
`last_attempt.state == "succeeded"`, and the recorded `finished_at`
timestamps are strictly increasing and consistent with real wall-clock
duration (16s-52s for the small subject, 250s-335s for the large one) — these
are 8 genuine, distinct, non-stale analysis executions.

## Finding 1: the deterministic candidate set is stable

Across all 4 runs per subject, the **capability name set was identical**,
including which single item (when one existed) fell back to a
`deterministic` description. This is consistent with the deterministic
candidate-generation layer being a pure function of the (unchanged) CAS —
expected, and not itself surprising.

## Finding 2: the AI response cache defeats content-preserving re-runs by design

All 8 runs also produced **byte-identical AI descriptions**, including for
the large subject's 11-capability catalog. Investigating why turned up a
second, independent cache that content-preserving re-submission cannot
bypass:

- `packages/analyzer-core/src/ai/ai-service.ts:592-614`
  (`normalizeContextForCacheKey`) deliberately **scrubs absolute/temp paths,
  12-64 char hex tokens (exactly the shape of project-id/workspace-id
  strings), and ISO timestamps before hashing** — "so identical source
  content re-analyzed from a different absolute path... would otherwise
  produce a different key on every run and never hit. Normalize that noise
  out BEFORE hashing so identical prompt-relevant facts yield an identical
  key."
- The retry-hint comment at `orchestrator.ts:11393-11396` independently
  confirms the same fact from the caller's side: "Distinct on the retry so an
  under-count retry is a real resample (**a byte-identical request would just
  replay the cached short answer**)."

Both are deliberate, documented design choices (they make repeat customer
submissions of unchanged code cheap and reproducible), but the direct
consequence for this investigation is: **there is no content-preserving,
black-box way to force a second independent AI sample of the same source.**
Any method that keeps the deterministic facts identical (which is required —
changing them would mean measuring a different input, not variance) also
keeps the AI cache key identical.

Bypassing this would require a server-side change (disable/short-TTL the AI
cache, e.g. via env var) on the shared VPS. That was judged unsafe to do here
with peer lanes concurrently running analyses on the same container — an env
change requires a container restart, which would interrupt their in-flight
work (this is the same class of action that caused the earlier OOM/console-
recovery incident today). **This was not attempted.**

**Conclusion: the "zero variance" measured today is real, but it is evidence
that the AI cache is doing its job on unchanged content — it is not evidence
that a genuine second AI sample would be identical.** The honest label for
that specific question is "not measured," not "no variance."

## Finding 3: what *does* answer the deterministic-vs-AI-layer question

The task's central attribution question — is the *deterministic candidate
set* unstable, or does only the *AI naming/description layer* vary — already
has a direct, first-party answer in the code, from the actual historical
incident that opened #33:

`orchestrator.ts:11463-11466`:

> "THIN-CATALOG NUDGE (defect #33 — catalog VARIANCE, measured live: v1.0.83
> returned exactly ONE usable item on the [...] CAS, v1.0.84 returned 6,
> **same CAS/prompt/facts**, pure inference luck."

This is a first-party admission that, in the actual #33 incident, the
deterministic candidate set (`rankedCandidateAreas`), the CAS, and the prompt
were held constant, and only the AI's returned catalog size changed (1 vs 6).
That directly answers the question: **the deterministic layer was stable;
the AI naming/catalog layer was the source of the variance.**

A mitigation for exactly this shape of failure already exists and is live in
current `master`: the "THIN-CATALOG NUDGE" (`orchestrator.ts` ~11463-11560)
triggers specifically when `catalog.length === 1`, and spends one bounded
extra AI call (`CATALOG_MAX_BOUNDED_ATTEMPTS = 3`, `CATALOG_ATTEMPT_BOUND_MS
= 40000`) that enumerates the deterministic candidate families by name and
requires one grounded capability per family, rather than accepting a
collapsed single item. This is precisely the "third retry" / "`catalog.length
=== 1` nudge" #33's own notes suggested, and it's already shipped.

## Finding 4: root cause is still present, but its live impact is unconfirmed

The AI catalog call (`aiExtractCapabilityCatalog` →
`aiService.generateComponentDescription` → provider chain →
`provider.generateDescription`) runs at **non-zero temperature**, confirmed
directly in current `master`:

- `ai/providers/claude-provider.ts:57`: `generateDescription` hardcodes
  `temperature: 0.3` unconditionally — not read from config, not
  overridable via `context.additionalContext`.
- `ai/providers/fallback-provider.ts:116` (Hugging Face fallback path): same
  pattern, hardcoded `temperature: 0.3, do_sample: true`.
- `ai/providers/local-provider.ts:42`: defaults to `0.3` (`do_sample:
  temperature > 0`, so sampling is on).
- `ai/providers/openai-provider.ts:114`: **the exception** —
  `temperature: this.config.openai.temperature`, and
  `config/ai.config.ts:237` defaults `OPENAI_TEMPERATURE` to **`'0'`**
  (vs. `ANTHROPIC_TEMPERATURE` defaulting to `0.3` at line 250).

The catalog call passes `model: process.env.DEEPINFRA_STRUCTURED_MODEL ||
process.env.OPENAI_STRUCTURED_MODEL || undefined` (`orchestrator.ts:11397`),
which reads as a preference for the OpenAI-compatible/DeepInfra provider path
for this specific call — the one path that already defaults to temperature 0.
**Whether that path is actually first in the live provider chain on
`mcp.klauro.com`, and whether `OPENAI_TEMPERATURE` is left at its `'0'`
default there, could not be confirmed from the CLI/MCP surface** — provider
selection and env config are hosted-service internals not exposed to a
blackbox client, and this investigation did not have safe SSH access to check
(rate-limited partway through the session; reading env vars on a
shared/concurrently-used box was also not attempted for the same
one-analysis-at-a-time/no-disruption reason as the cache bypass above).

**This is the one concrete unknown left**, and it is exactly the kind of
check someone with VPS/container access can do safely in under a minute:
confirm which provider actually served a recent catalog call (the
`recordSemanticDecision` call at `ai-service.ts` — `decision_type:
'ai_provider_attempt'` — already logs `provider` and `model` per attempt into
the semantic-decision dataset) and what `OPENAI_TEMPERATURE` is set to in
that container's environment.

## Finding 5: bad runs are visibly marked, every time

All 8 live runs, on both subjects, correctly reported degradation when one
capability's description could not be AI-enriched:

- Top-level `status: "degraded"` (not silently `"ready"`).
- `comprehension: {degraded: true, capability_description_degradations: 1,
  detail: "Part of the capability catalog could not be AI-enriched; those
  entries carry deterministic evidence text, not authored comprehension."}`.
- The specific capability that fell back was the same one, every run, on
  each subject — consistent with a specific entity/evidence shape that the
  naming layer legitimately can't ground yet, not a random failure.

This held across both a build tagged `2c275ace172e` and a later build tagged
`fdd6b6403c93` that was deployed to the VPS mid-session by a peer lane
(confirmed via the `reuse_decision.analyzer_build` field changing between
runs) — degradation marking survived a live redeploy without regressing.

No run in this sample silently shipped a degraded catalog as if it were
healthy. The mocked contract tests
(`__tests__/ai/l5-capability-degradation.test.ts`,
`__tests__/ai/determinism-boundary.test.ts`) independently assert the same
invariant (never a `deterministic` provenance standing in for a real AI
failure, `comprehension.degraded` always set on failure) at the unit level.

## Recommendation

Not proposing a code change here, for the same reason a speculative fix was
avoided in Finding 4: the one lever with real evidence behind it (temperature
on the catalog call) may already be at 0 in production depending on provider-
chain order and `OPENAI_TEMPERATURE`, and changing it blind — without being
able to re-measure against the live cache — risks a no-op change or an
unverified regression on an already-tuned retry path (the THIN-CATALOG
NUDGE).

Concrete next steps, in order of cost:

1. **Cheapest — confirm the unknown in Finding 4.** Check the VPS
   container's `OPENAI_TEMPERATURE`/`ANTHROPIC_TEMPERATURE` env and which
   provider actually wins the chain for a catalog call (via the existing
   `ai_provider_attempt` semantic-decision log). This alone may close the
   loop: if the live path is already temperature-0 OpenAI-compatible, #33's
   root cause is already gone in the common case and the historical 1-vs-6
   incident predates it or hit a fallback path.
2. **If temperature is confirmed non-zero on the live path:** add an
   explicit, plumbed-through temperature override (`context.additionalContext
   .temperature`, honored by all four providers' `generateDescription`,
   defaulting to today's per-provider value when absent) and set it to `0`
   specifically at the `aiExtractCapabilityCatalog` call site. Small, scoped,
   reversible, and does not touch the other `generateDescription` call sites
   (system description, entity descriptions, risk/recommendations) or the
   THIN-CATALOG NUDGE's own retry logic.
3. **To re-measure variance for real** (either to verify step 2 or as a
   standing capability): a maintainer-only, explicitly-flagged cache-bypass
   (e.g. `KLAURO_AI_CACHE_BYPASS=1` salting the cache key with a nonce only
   when set) would let a live re-sampling test run without disabling the
   cache for real customer traffic or needing a container restart. Not
   built here — flagged as a real gap in "can this class of bug even be
   re-verified live" for next time.

**#33 is not closed by this investigation** — it is de-risked: the failure
mode it originally reported has a working mitigation in `master` already
(Finding 3), degradation is never silently shipped (Finding 5), and the
remaining root-cause question (Finding 4) is now a single, cheap,
VPS-side check rather than an open-ended one.
