# Fact-Layer Ship Checklist (the "last-mile rule")

**A fact layer that is computed but not surfaced does not exist.** Every new
analyzer / fact layer ships only when ALL of the boxes below are checked — the
enforceable slice is locked by a standing test
(`apps/mcp-server/src/fact-layer-completeness.test.ts`), the rest is this
checklist.

Why this exists (session retro, 2026-07-05):

- **Communication seams did it right**: evidence-gated facts → CAS field →
  orient-capsule dimension → taught in `SERVER_INSTRUCTIONS` → MCP tool
  (`get_communication_seams`) + CLI (`klauro seams`) parity →
  include/exclude filters → metered with-vs-without measurement (~8× token
  saving on the consistency question, `new-context-impact-benchmark.ts`).
- **Runtime topology missed the last mile**: it shipped computed but
  unmeasured — and shipped broken. Nobody noticed, because nothing pulled it,
  nothing taught it, and no measurement would have failed.

## The gate

1. **Evidence-gated facts** — the layer emits deterministic facts backed by
   concrete evidence (file/line, config key, artifact), never keyword/brand
   heuristics. AI may interpret; it may not invent facts
   (see the cardinal rule in `docs/CLAUDE.md` / memory: deterministic facts +
   AI flavoring).
2. **CAS field** — the facts land in a named field on `CASOutput` with types
   in `packages/analyzer-core/src/types/cas.types.ts`.
3. **Capsule dimension** — add the layer to `buildOrientCapsule` in
   `apps/mcp-server/src/query.ts` (availability + count + the tool that pulls
   it). This is what makes the layer *discoverable* on the first orient call.
4. **Taught in instructions** — the dimension's tool is named in
   `SERVER_INSTRUCTIONS` (`apps/mcp-server/src/server.ts`) with a one-line
   when-to-pull. An untaught tool is a dead tool.
5. **Channel parity (MCP + CLI + API)** — the MCP tool is registered; decide
   the CLI story at ship time and record it in the `DIMENSION_PARITY` matrix
   in `fact-layer-completeness.test.ts`: either a thin read subcommand in
   `apps/mcp-server/src/cli.ts` (wrapping the SAME query builder — no logic
   fork) documented in the help text, or an explicit `null` (MCP-only by
   design). The HTTP/API surface follows the MCP tool automatically.
6. **Include/exclude filter coverage** — the layer participates in the
   response-budget opt-outs (`runtime`/`exclude_sections`-style include/exclude
   filters, per `docs/SPEC-RESPONSE-BUDGET.md`): excluding it must produce a
   strictly smaller response, not a blanked field.
7. **Metered with-vs-without measurement** — before calling the layer done,
   run the impact benchmark and record the result:

   ```bash
   cd apps/mcp-server
   npm run impact-benchmark            # defaults to a real corpus repo
   npm run impact-benchmark -- /path/to/repo --json out.json
   ```

   (`apps/mcp-server/src/new-context-impact-benchmark.ts` — metered
   with-context vs grep-baseline arms on real repos; honest about sections
   that produce no facts on the sampled repo.) A layer whose with-arm does not
   beat the baseline on tokens or correctness is not done — it is either
   broken (topology, above) or not worth teaching.

## What the standing test enforces (fails your build, not your memory)

`apps/mcp-server/src/fact-layer-completeness.test.ts` walks the
`buildOrientCapsule` dimension list and asserts, for every dimension:

- its `tool` is a **registered** MCP tool (full profile);
- the tool is **mentioned in `SERVER_INSTRUCTIONS`**;
- the dimension has a row in the **channel-parity matrix**, and where that row
  names a CLI subcommand, it is **wired and documented in `cli.ts`**.

Steps 1–2 (evidence gating, CAS types), 6 (filters) and 7 (measurement) are
gated by review plus the layer's own tests and the benchmark run — check them
here explicitly.
