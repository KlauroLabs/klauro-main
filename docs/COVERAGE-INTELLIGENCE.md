# Coverage Intelligence Report

Generated 2026-07-05T07:24:37.132Z. Empirical sweep of 30 real ~/dev repos
(25 analyzed successfully, 5 crashed) using the codebase-TYPE
classifier + coverage-gap self-discovery layer (see
`packages/analyzer-core/src/analyzer/core/codebase-type.ts` and `coverage-gaps.ts`).

This is the empirical backlog: which unknown deps/frameworks recur most, which
types have zero-entry-point repos, which tree-sitter node types are most
unhandled. Drives the next fix waves.

## Codebase TYPE distribution

| Type | Repo count |
| --- | --- |
| web-backend | 8 |
| web-frontend | 5 |
| desktop | 3 |
| cli | 3 |
| unknown | 3 |
| library | 2 |
| data-ml | 1 |

## Top recurring unknown dependencies (no analyzer recognizes them)

| Dependency | Repos affected | Occurrences |
| --- | --- | --- |
| vite | 4 | 4 |
| torchaudio | 2 | 2 |
| scipy | 2 | 2 |
| dev | 2 | 2 |
| pytest | 2 | 2 |
| tsx | 2 | 2 |
| newtonsoft.json | 2 | 2 |
| @sentry/react | 1 | 1 |
| @sentry/tracing | 1 | 1 |
| @auth0/auth0-react | 1 | 1 |
| @electron-toolkit/preload | 1 | 1 |
| @electron-toolkit/utils | 1 | 1 |
| electron-updater | 1 | 1 |
| @electron-toolkit/eslint-config | 1 | 1 |
| @electron-toolkit/eslint-config-prettier | 1 | 1 |
| @vitejs/plugin-react | 1 | 1 |
| electron-builder | 1 | 1 |
| electron-vite | 1 | 1 |
| eslint-plugin-react | 1 | 1 |
| @tailwindcss/vite | 1 | 1 |
| tailwind-merge | 1 | 1 |
| tailwindcss | 1 | 1 |
| ml | 1 | 1 |
| openai-whisper | 1 | 1 |
| stable-ts | 1 | 1 |
| demucs | 1 | 1 |
| rapidfuzz | 1 | 1 |
| pytest-asyncio | 1 | 1 |
| pytest-mock | 1 | 1 |
| ruff | 1 | 1 |

## Top low-extraction-ratio file extensions (parsed but nearly nothing extracted)

| Extension | Repos affected | Occurrences |
| --- | --- | --- |
| ts | 14 | 606 |
| js | 8 | 155 |
| rs | 1 | 63 |
| tsx | 6 | 61 |
| cjs | 2 | 31 |
| rb | 1 | 16 |
| py | 4 | 12 |
| cs | 1 | 10 |
| mjs | 2 | 3 |
| jsx | 1 | 1 |

## Zero-entry-point repos by codebase_type (missing entry-point model for this type)

| codebase_type | Repos affected | Occurrences |
| --- | --- | --- |
| _(none found)_ | | |

## Top unhandled tree-sitter node types

| Node type | Repos affected | Occurrences |
| --- | --- | --- |
| _(none found — no per-node-type walker instrumentation wired into this sweep's analyzer pass yet)_ | | |

## Per-repo detail

| Repo | codebase_type | confidence | nodes | entry points | unknown-deps | low-extraction | zero-entry | unhandled-node-type |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| repo-a-frontend | web-frontend | 0.50 | 584 | 21 | 2 | 12 | 0 | 0 |
| repo-a-backend | web-backend | 0.54 | 6701 | 316 | 0 | 67 | 0 | 0 |
| admin-portal-ui | web-frontend | 0.50 | 4082 | 445 | 1 | 23 | 0 | 0 |
| electron-app | desktop | 0.45 | 43 | 1 | 10 | 1 | 0 | 0 |
| yisda-desktop | desktop | 0.30 | 754 | 53 | 0 | 9 | 0 | 0 |
| yisda-desktop-old | desktop | 0.30 | 320 | 22 | 0 | 1 | 0 | 0 |
| graph-ui | web-frontend | 0.81 | 659 | 206 | 3 | 1 | 0 | 0 |
| claudius | web-backend | 0.45 | 2825 | 31 | 0 | 46 | 0 | 0 |
| backend | web-backend | 0.46 | 1425 | 60 | 12 | 5 | 0 | 0 |
| flight-finder | cli | 0.52 | 701 | 32 | 7 | 15 | 0 | 0 |
| investor | web-backend | 0.43 | 21982 | 853 | 0 | 388 | 0 | 0 |
| cli-assistant-a | cli | 0.34 | 2379 | 192 | 21 | 6 | 0 | 0 |
| platform | web-backend | 0.55 | 5247 | 773 | 2 | 97 | 0 | 0 |
| simulation-engine | web-frontend | 0.58 | 7522 | 2 | 3 | 100 | 0 | 0 |
| cli-assistant-b | cli | 0.34 | 5828 | 677 | 3 | 69 | 0 | 0 |
| pumpfun-portal | web-backend | 0.60 | 193 | 1 | 0 | 0 | 0 | 0 |
| client | web-frontend | 1.00 | 2016 | 1 | 6 | 46 | 0 | 0 |
| side-scroller | library | 0.69 | 2021 | 2 | 0 | 41 | 0 | 0 |
| starlink | web-backend | 0.66 | 175 | 10 | 2 | 0 | 0 | 0 |
| backend | web-backend | 0.67 | 169 | 12 | 0 | 4 | 0 | 0 |
| rvc-webui | data-ml | 0.46 | 4605 | 68 | 2 | 5 | 0 | 0 |
| wired-up | library | 1.00 | 330 | 23 | 2 | 12 | 0 | 0 |
| Finance.Domain.Abstractions | unknown | 0.00 | 3270 | 1 | 6 | 0 | 0 | 0 |
| Finance.Domain.Entities | unknown | 0.00 | 1391 | 1 | 2 | 10 | 0 | 0 |
| Finance.Domain.Events | unknown | 0.00 | 9 | 1 | 0 | 0 | 0 | 0 |

## Crashed (5)

- assistant-runtime-x: timed out after 90000ms analyzing assistant-runtime-x
- finance-app-y: timed out after 90000ms analyzing finance-app-y
- app: timed out after 90000ms analyzing app
- backend: timed out after 90000ms analyzing backend
- frontend: timed out after 90000ms analyzing frontend

