# Corpus Depth Sweep — the v1.0.21–28 layers across the real ~/dev corpus

Date: 2026-07-05 · Agent: corpus-depth · Harness: `apps/mcp-server/src/gauntlet/coverage-intel-sweep.ts`
(depth mode: `COVERAGE_SWEEP_DEPTH=1`, blackbox `analyzeForBench` over the product's own analyzer-server; no engine imports, no AI env)

**Mission**: the v1.0.21–28 layers (communication seams, consistency/CAP, runtime topology,
CI/CD, testing/mocking, messaging, auth, observability, validation, http-client) were each
validated on 1–2 repos + fixtures. This sweep ran them across **60 real repos** under `~/dev`
(59 analyzed, 1 timeout) and compared what fired against ground-truth applicability
(deps/configs actually present on disk).

## Corpus & exclusions

- Discovery: manifests at depth ≤ 3 under `~/dev`, capped at 60. `.sln` added as a project
  boundary this session — without it one .NET solution (soon/Finance-Context, 28 `.csproj`
  sub-projects) ate 28 of the 60 slots as separate "repos".
- Skipped: `unravl` (Klauro itself — 14GB, already continuously self-analyzed),
  `google-cloud-sdk` (vendored, already in SKIP list).
- `personal/money` timed out at 240s (6.4GB repo, mostly data — 64 TS files). Only non-ok repo.
- Harness note: after ~46 sequential analyses the in-process sweep driver hit the default V8
  heap (OOM). Resumed with `--max-old-space-size=8192`. Worth watching as an
  analyzer-server memory-growth signal on long-lived servers.

## Layer firing table (fired / 59 ok repos, vs. disk-level applicability)

"applicable" = npm deps / config files on disk say the tech is present (root package.json,
CI config dirs, Dockerfile/compose at root). `n/a` = no cheap disk-level ground truth.

| Layer | Fired | Applicable | Fired ∩ applicable | Verdict |
| --- | --- | --- | --- | --- |
| communication seams (any) | 52/59 | 59 | 52 | ✅ the 7 silents are tiny repos (0–175 nodes) — honest zeros |
| seams: sync | 52/59 | n/a | — | ✅ |
| seams: async | 34/59 | n/a | — | ✅ fires on every repo with queues/events found |
| seams: passive (shared state) | 26/59 | n/a | — | ✅ incl. big counts on investor (471), soon-sync (104), zerac-api (329) |
| consistency/CAP store postures | 7/59 | n/a | — | ✅ evidence-gated by design; fires exactly on the repos with recognized stores |
| runtime topology (deployables) | 23/59 | 19 (Dockerfile/compose at root) | 19/19 | ✅ ALL container-applicable repos fired (+4 with nested infra) |
| topology infra→code edges | 23/59 | — | — | ✅ every deployables-repo also has edges |
| CI/CD pipelines (`ci_pipeline` nodes) | 8/59 | 7 (CI config present) | 7/7 | ✅ 100% of repos with CI config |
| testing (test_suites) | 24/59 | ~20 (test files on disk) | — | ✅ |
| mocking/test-doubles | ran 27, nodes>0 on 8 | n/a | — | ✅ audited kontinuum/kadra.ai "zeros": genuinely no vi.mock/jest.mock — honest |
| messaging | ran 9, nodes>0 on 6 | 4 (dep-level) | 2 + Rails/Sidekiq repos | ⚠️ one real silent: soon-sync (filed, below) |
| auth | ran 15, nodes>0 on 8 | 16 | 7 | ❌ **was the worst layer** — 9 applicable-but-silent; 3 root causes found, all FIXED (below) |
| observability | ran 13, nodes>0 on 12 | 11 | 8 | ⚠️ silents = Datadog browser/mobile SDKs (filed, below) |
| validation | ran 12, nodes>0 on 8 | 11 | 8 | ⚠️ one real silent: finance-context-ts named-import Joi (filed) |
| http-client | ran 27/59 (all 19 dep-applicable) | 19 | 19 | ❌ **ran everywhere but extracted ~nothing** — 4 root causes found, all FIXED (below) |

## Crash list

- **Product crashes: 0 / 60.** No repo crashed the analyzer.
- 1 timeout: `personal/money` (240s; 6.4GB working tree). Not an analyzer fault.
- 1 harness (not product) failure: sweep-driver V8 OOM after 46 repos at default heap; resumable state made this a non-event.

## Misses found → FIXED this session (with regression tests, all suites green)

### 1. Outbound http-client: ran on 27 repos, extracted calls on ~2 (`outbound-http-client-analyzer.ts`)
Root-caused on WashUp-React (axios wrapper) + investor. Four independent misses, all the *norm* in real code:
- **TS generic call sites** — `http.get<User[]>('/users')`: the call regexes required `(` directly after the method name. Fixed (optional `<...>` group).
- **Cross-file client instances** — `export default axios.create(...)` in one module, calls in every other: context was per-file only. Fixed (project-level instance map + second-order candidate files that call a known instance).
- **Non-literal baseURL** — `axios.create({ baseURL: import.meta.env.X })` didn't even register the instance. Fixed (instance tracked with empty base).
- **Template-literal endpoints dropped whole** — `` `/users/${id}` `` was discarded by `normalizeEndpoint`. Fixed (`${expr}` → `{param}`; placeholder-ONLY paths still dropped to avoid fabricated targets).
- Verified: investor 1 → **52** exit points; admin-portal-ui 0 → 1; new fixture tests (cross-file + generics + template, placeholder-only guard). 7/7 pass, old guard test (`local.get('/internal-only')` must not match) intact.

### 2. Jest analyzer over-claims vitest repos → duplicate suite/entry ids (`jest-analyzer.ts`)
The **single largest error source in the corpus: 1,735 `PARTIAL_ANALYSIS` errors across 7 repos**
(mtg/app 692, investor 438, kontinuum 256, …). JestAnalyzer's `canAnalyze` accepted any repo with
`*.test.ts` containing `describe(`/`it(` — including pure-vitest repos — and its suite/case ids
deliberately mirror TestFrameworkAnalyzer's, so every vitest suite+case was emitted twice and
dedup-dropped with an error logged each time (and one analyzer's differing version silently lost).
- Fixed: vitest-importing files are never jest evidence and never claimed (`JestAnalyzer.isVitestFile`).
- Verified: jest `canAnalyze(investor)` now false; duplicate-id suite 10/10 (one fixture updated: it used a vitest import incidentally while testing `env-*` filename globs).

### 3. Auth layer blind to SPA and NestJS idioms (`auth-analyzer.ts` + registration in `apps/mcp-server/src/analyzer.ts`)
9 of 16 auth-applicable repos were silent. Three concrete causes, all fixed:
- **`@auth0/auth0-react` SPAs** (4 repos: admin-portal-ui, zerac client-ui/admin-ui/demo-ui): the analyzer knew the package but only server-SDK call shapes; and the orchestrator registration dep-list didn't include it at all, so on most repos the analyzer never even ran. Fixed: `useAuth0(` / `<Auth0Provider` / `withAuthenticationRequired(` sitePatterns + registration deps.
- **`@clerk/clerk-react` SPAs** (soon-ui): package missing from both the clerk rule and registration. Fixed (+ `<ClerkProvider|SignedIn|SignedOut|RedirectToSignIn`, `use(Auth|User|Session|Clerk)(`).
- **NestJS passport** (zerac-api, zerac/legacy/api, soon-sync): Nest code says `@UseGuards(AuthGuard('jwt'))` and `extends PassportStrategy(...)`, never `passport.use(...)` — auth ran with 0 nodes. Fixed (Nest idiom sitePatterns + `@nestjs/passport`/`@nestjs/jwt` packages & registration deps).
- Verified on the real repos: admin-portal-ui 0 → **64** auth nodes, soon-ui 0 → **21**, zerac-api 0 → **8**, legacy/api 0 → 1. Auth test suite 7/7 (3 new tests).

### 4. Sweep harness (`coverage-intel-sweep.ts`)
- Depth-mode per-repo capture (seam counts, consistency counts, topology, ci nodes, per-analyzer `nodes_created`, analysis_errors, test_suites) + resumable JSON state + `.sln` project boundary + `COVERAGE_SWEEP_SKIP`.

## Misses found → FILED (bigger than an inline fix)

1. **Rust/anchor exit ids embed the absolute snapshot path and duplicate** —
   `rust-analyzer.ts:2555` builds `ext_call:${filePath}:...` with an absolute
   `/var/folders/.../workspaces/<hash>/...` path (id-stability violation: ids differ per
   machine/snapshot), and on Rust workspaces the same file is emitted twice → 176 dup-exit
   errors on investor (anchor) and 314 on a zerac Rust repo (axum). Expected: project-relative,
   deduplicated ids. Needs the project root threaded into the extractor + a walk-level dedup.
2. **Messaging blind to NestJS/amqp-connection-manager style** — soon-sync has
   `amqplib` + `amqp-connection-manager` + `nats` in deps; `async-messaging` ran and produced
   0 nodes (no `sendToQueue`/`publish('...')` literal shapes; connection-manager wrappers +
   Nest microservice patterns). Expected: at least the channel/producer surface.
3. **Observability blind to Datadog browser/mobile SDKs** — soon-ui (`@datadog/browser-logs`,
   `@datadog/browser-rum`) and mobile-ui (`@datadog/mobile-react-native`) never trigger the
   observability analyzer (registration deps list has `dd-trace` only; analyzer rules lack the
   browser/mobile SDK shapes: `datadogLogs.init`, `datadogRum.init`, `DdSdkReactNative`).
4. **Validation blind to named-import Joi** — finance-context-ts imports
   `import { string } from 'joi'` (never `Joi.object(...)`); `validation-schema-contracts` ran
   with 0 nodes. Expected: named-import Joi schema shapes.
5. **Analyzer id drift** — registration id `mocking-test-doubles-fixtures`
   (apps/mcp-server/src/analyzer.ts:682) vs the analyzer's own constructor id
   `mocking-test-double-fixtures` (mocking-library-analyzer.ts:149). Contributions use the
   registration id; anything keying on the analyzer's self-id misses. Align them.
6. **React analyzer logs full TSError stacks to stderr** for unparseable content files
   (e.g. deliberately-broken code-example fixtures in kadra.ai) instead of only recording the
   `analysis_errors` entry — noisy on corpus runs.

## Per-repo detail

Raw per-repo JSON (all counts incl. per-analyzer `nodes_created`, errors, seams/topology/ci):
sweep state file, regenerable via
`COVERAGE_SWEEP_DEPTH=1 COVERAGE_SWEEP_STATE=<file> npx tsx apps/mcp-server/src/gauntlet/coverage-intel-sweep.ts`.

Columns: seams sync/async/passive · topology deployables/edges · ci pipelines/jobs ·
layer nodes mock/msg/auth/obs/val/http (`-` = analyzer did not run) · test suites · analysis errors.

| repo | type | nodes | seams | topo | ci | mock/msg/auth/obs/val/http | tests | errs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| WashUp-React | web-frontend | 591 | 94/11/0 | – | 1/1 | 0/-/-/-/-/0 | 1 | 0 |
| washup | web-backend | 6807 | 49/20/0 | – | 2/2 | 0/4/1/-/-/0 | 9 | 0 |
| admin-portal-ui | web-frontend | 4082 | 402/353/13 | – | 0/0 | -/-/-/-/-/- | 0 | 18 |
| electron-app | desktop | 43 | 1/0/0 | – | 0/0 | -/-/-/-/-/- | 0 | 0 |
| yisda-desktop | desktop | 757 | 38/50/0 | – | 0/0 | 0/-/1/2/-/0 | 0 | 7 |
| yisda-desktop-old | desktop | 331 | 8/12/0 | – | 0/0 | 0/-/1/10/-/0 | 1 | 7 |
| graph-ui | web-frontend | 659 | 127/205/0 | – | 0/0 | 0/-/-/-/-/- | 0 | 0 |
| openclaw | cli | 76604 | 2999/8/2 | 3/5 | 1/1 | 7/-/0/5/3/0 | 1166 | 27 |
| claudius | web-backend | 2874 | 99/46/4 | – | 0/0 | -/45/-/3/1/- | 0 | 1 |
| cleanmusic/backend | web-backend | 1443 | 52/24/0 | 1/1 | 0/0 | -/18/-/-/-/0 | 13 | 0 |
| flight-finder | cli | 701 | 17/0/3 | – | 0/0 | -/-/-/-/-/0 | 0 | 0 |
| investor | web-backend | 22030 | 860/247/471 | 1/3 | 2/2 | 31/-/0/10/1/1 | 43 | 627 |
| kadra.ai | cli | 2389 | 199/122/1 | – | 0/0 | 0/-/-/10/-/- | 20 | 12 |
| knowledgebase/platform | web-backend | 5251 | 459/730/7 | 1/3 | 0/0 | -/-/3/-/-/- | 0 | 4 |
| simulation-engine | web-frontend | 7522 | 68/0/7 | – | 0/0 | 0/-/-/-/-/- | 0 | 0 |
| kontinuum | cli | 5828 | 302/225/8 | 4/11 | 0/0 | 0/-/-/-/-/- | 35 | 256 |
| mtg/app | fullstack | 13962 | 1417/1242/52 | – | 0/0 | 13/-/38/-/3/- | 30 | 700 |
| music-studio/backend | web-backend | 926 | 0/0/0 | – | 0/0 | -/0/-/-/-/0 | 0 | 0 |
| music-studio/frontend | web-frontend | 574 | 85/85/0 | – | 0/0 | -/-/-/-/-/- | 0 | 0 |
| pumpfun-portal | web-backend | 247 | 143/0/0 | – | 1/1 | -/-/-/43/-/- | 1 | 0 |
| rpg/client | web-frontend | 2035 | 15/0/7 | – | 0/0 | 1/-/-/-/-/- | 2 | 0 |
| side-scroller | library | 2021 | 164/0/0 | – | 0/0 | -/-/-/-/-/- | 0 | 0 |
| starlink | web-backend | 175 | 0/0/0 | – | 0/0 | -/-/-/-/-/- | 0 | 0 |
| vocalverse/backend | web-backend | 169 | 7/0/1 | – | 0/0 | -/-/-/-/-/0 | 0 | 0 |
| rvc-webui | data-ml | 4647 | 31/0/0 | 2/3 | 6/7 | -/-/-/-/-/0 | 0 | 1 |
| wired-up | library | 330 | 1/0/0 | – | 0/0 | 0/-/-/-/-/- | 1 | 0 |
| Finance-Context (.NET, 28 csproj) | web-backend | 15692 | 739/13/0 | 4/6 | 0/0 | -/-/-/-/-/- | 0 | 0 |
| algo-test | web-backend | 334 | 2/35/0 | – | 0/0 | 0/-/-/-/-/0 | 0 | 0 |
| alphaclaw | web-backend | 13996 | 1252/0/1 | – | 1/1 | 8/-/-/-/-/- | 84 | 0 |
| ccxt-test | web-frontend | 263 | 20/5/0 | – | 0/0 | -/-/-/-/-/- | 0 | 0 |
| coinbase_connector | unknown | 2 | 0/0/0 | – | 0/0 | -/-/-/-/-/- | 0 | 0 |
| fa-test | unknown | 0 | 0/0/0 | – | 0/0 | -/-/-/-/-/- | 0 | 0 |
| finance-context-ts | web-backend | 3477 | 134/10/18 | 1/1 | 0/0 | 0/2/0/4/0/1 | 8 | 0 |
| fortress-dashboard-api | web-backend | 32 | 0/0/0 | – | 0/0 | -/-/-/-/-/0 | 0 | 0 |
| mobile-ui | mobile | 7274 | 185/854/0 | – | 0/0 | -/-/0/-/-/1 | 0 | 16 |
| soon-bos | web-backend | 7239 | 457/1105/0 | 5/5 | 0/0 | -/-/-/-/-/- | 16 | 1 |
| soon-decrypter | library | 10 | 0/0/0 | – | 0/0 | -/-/-/-/-/- | 0 | 0 |
| soon-lens | web-backend | 26870 | 1431/1140/56 | 3/5 | 0/0 | 7/-/2/2/70/3 | 61 | 40 |
| soon-link | web-backend | 3490 | 357/119/5 | 4/21 | 0/0 | 0/2/-/2/0/1 | 16 | 312 |
| soon-simulation | library | 2503 | 6/0/2 | – | 0/0 | -/-/-/-/-/- | 1 | 0 |
| soon-sync | web-backend | 7311 | 445/9/104 | 2/4 | 0/0 | 91/0/1/2/3/0 | 27 | 0 |
| soon-ui | web-frontend | 8703 | 748/925/1 | – | 0/0 | -/-/-/-/2/0 | 0 | 19 |
| testing-utilities-net | unknown | 24 | 2/0/0 | – | 1/2 | 0/-/-/-/-/- | 0 | 0 |
| user-service | web-backend | 5903 | 498/9/0 | 6/17 | 0/0 | -/-/-/-/-/- | 0 | 0 |
| zerac/admin-ui | web-frontend | 12721 | 2238/2020/5 | 1/1 | 0/0 | 0/-/-/-/-/0 | 0 | 11 |
| zerac/client-ui | web-frontend | 2096 | 241/173/1 | – | 0/0 | 0/-/-/-/-/0 | 0 | 2 |
| zerac/contractors/backend | web-backend | 2847 | 23/41/63 | 1/1 | 0/0 | -/48/0/-/0/0 | 0 | 0 |
| rdp-service | web-backend | 381 | 401/0/0 | 1/1 | 0/0 | 0/-/-/-/-/- | 2 | 0 |
| zerac/contractors/ui | web-frontend | 1251 | 146/381/10 | 1/1 | 0/0 | 0/-/-/-/-/0 | 1 | 1 |
| zerac/alternative | cli | 227 | 109/0/0 | 4/10 | 0/0 | -/-/-/-/-/- | 0 | 0 |
| zerac/legacy/api | web-backend | 448 | 110/0/0 | – | 0/0 | 0/-/0/0/0/0 | 9 | 0 |
| zerac/legacy/demo-ui | web-frontend | 1240 | 88/118/5 | – | 0/0 | 0/-/-/-/-/0 | 0 | 1 |
| zerac/prototype | cli | 288 | 167/0/0 | 4/10 | 0/0 | -/-/-/-/-/- | 0 | 0 |
| quic-test | cli | 37 | 31/0/0 | 4/10 | 0/0 | -/-/-/-/-/- | 0 | 0 |
| zerac/poc | cli | 12087 | 4683/238/1 | 8/69 | 0/0 | -/-/-/-/-/1 | 17 | 318 |
| zerac/poc-old | cli | 347 | 86/0/0 | 7/16 | 0/0 | -/-/-/-/-/- | 0 | 0 |
| heroku-auth | web-backend | 23 | 0/0/0 | – | 0/0 | -/-/2/-/-/- | 0 | 0 |
| zerac/website | fullstack | 196 | 23/12/0 | – | 0/0 | -/-/-/-/-/- | 0 | 0 |
| zerac-api | web-backend | 13089 | 1911/62/329 | 8/33 | 0/0 | 86/0/0/6/113/0 | 90 | 0 |

(Repo names disambiguated by path where the basename collides; layer-node columns reflect
the PRE-fix sweep — the auth/http-client fixes above were verified per-repo post-fix:
admin-portal-ui auth 0→64, soon-ui 0→21, zerac-api 0→8, legacy/api 0→1, investor http exits 1→52.)

## Verification

- `tsc --noEmit` clean: `packages/analyzer-core`, `apps/mcp-server`.
- 55 tests green across every touched/affected suite: outbound-http-client (7),
  auth (7, 3 new), duplicate-id-namespacing (10, 1 fixture corrected), validation-schema,
  messaging, observability, ci-pipeline, communication-seams, consistency-model.
- Real-repo spot verification for every fix (numbers above).
