# Klauro Agent Context Language

Klauro Agent Context Language is the prompt-native family used for compact MCP
context injection. It is not a storage format and it is not CAS. It is a small,
line-oriented language over CAS-backed agent contexts:

- `K15`: current existing-codebase orientation and task context.
- `K14`: previous existing-codebase capsule, kept only as a benchmark baseline.
- `K13`: previous existing-codebase capsule, kept only as a benchmark baseline.
- `K12`: previous existing-codebase capsule, kept only as a benchmark baseline.
- `K11`: previous existing-codebase capsule, kept only as a benchmark baseline.
- `K10`: previous existing-codebase capsule, kept only as a benchmark baseline.
- `K9`: previous existing-codebase capsule, kept only as a benchmark baseline.
- `K8`: earlier existing-codebase capsule, kept only as a benchmark baseline.
- `K5`: exact edit/execution capsule for direct-patch work.
- `G1`: greenfield and growing-codebase build capsule.

## Research Basis

The format choice separates three jobs:

- **Storage/querying:** keep CAS as JSON/JSONB-compatible structured data so it
  can be indexed, diffed, queried, and rendered.
- **Transport:** use gzip or another binary compression layer between Klauro
  clients and hosted analyzers when bytes over the wire matter.
- **Prompt injection:** use `K15`/`K5`/`G1`, because models need directly
  readable text, exact file paths, and task actions without an extra decode
  turn.

Alternatives considered:

- Protocol Buffers: excellent schema-based binary serialization for services,
  but opaque to an LLM prompt unless decoded first.
- CBOR and MessagePack: compact binary JSON-family encodings, useful for
  transport/storage, but not directly model-readable; in prompt benchmarks
  they are represented as diagnostic JSON or base64 payloads because that is
  what an agent would actually see without a decoder turn.
- PostgreSQL `jsonb`: excellent for persisted CAS artifacts and query indexes,
  but verbose as injected prompt context.
- TOON/table formats: strong general-purpose text baselines for LLM input, but
  not domain-specific enough to beat CAS-aware opcodes.
- YAML and XML prompt blocks: familiar to agents and useful as general prompt
  structure, but they spend too many tokens on repeated field labels/tags before
  expressing task ownership, file roles, validation, and anti-duplication rules.
- TSV/opcode rows: readable and cheap, but less task-specific than the final
  K15 grammar for selected node, role-grouped file aliases, header default-extension
  restoration, reuse, risk, and validation.

## K15 Grammar

```text
K15<task-code>[default-file-extension] <task>
A<alias> <path-prefix> [<alias> <path-prefix>...]
E<alias> <editable-path-suffix> [<editable-path-suffix>...] [...]
O<alias> <read-first-path-suffix> [<read-first-path-suffix>...] [...]
C<alias> <candidate-path-suffix> [<candidate-path-suffix>...] [...]
@<name> <kind> <file-index> <line>
I<idiom> [<idiom>...]
U<reuse-rule> [<reuse-rule>...]
R<risk-or-invariant> [<risk-or-invariant>...]
V<validation-command-with-file-indexes> [<validation-command>...]
!<expansion-rule>
```

Task codes:

- `m`: modify
- `d`: debug/fix
- `r`: review
- `t`: trace
- `o`: orient

File role lines:

- `E`: read then edit
- `O`: open/read first
- `C`: candidate/read-only

Default extension:

- `K15mts` means task code `m` plus a default `.ts` extension; suffixes without
  an explicit known extension restore to `.ts`.
- `auth.service` under alias `0 src/auth` expands to `src/auth/auth.service.ts`.
- Suffixes that already end with known extensions, such as `schema.prisma` or
  `README.md`, are left unchanged.

File references:

- `1`, `2`, etc. refer to the indexed files from the ordered `E`, `O`, and
  `C` role lines.
- `V test 2` means expand file index `2` to that file path before running the
  command.
- `@AuthService svc 1 18` means the selected node is in file `1` at line 18.

Example:

```text
K15mts Replace password auth OIDC keep tenantSess
A0 src/auth 1 tests/auth
E0 auth.service 1 auth.service.test
O0 oidc.client
C0 session.repository auth.controller _ src/users/entities/user.entity src/tenancy/tenant.guard
@AuthService svc 1 18
IDIctor tenantSess testProdMock
USessionRepoReuse OidcClientAdapter
RhiAuthSess invTenantId
Vtest 2 typecheck
!F idioms expandIfBlocked
```

## Agent Decoding Rule

1. Read `K15` before broad source exploration.
2. Expand `A` aliases and restore the header default extension before opening
   files.
3. Expand numeric file references from the ordered `E`, `O`, then `C`
   dictionaries.
4. Read the `E` and `O` files first; inspect `C` only as needed.
5. Edit only files listed under `E` unless source evidence proves the target
   moved.
6. Preserve `I`, `U`, and `R` constraints.
7. Run `V` validation or stop for Klauro-managed validation when instructed.
8. Expand to `first-turn` or full JSON only when `K15`/`K5` is contradictory,
   missing a concrete required file, or validation points to a missing owner.

## G1 Grammar

`G1` is the greenfield build language. It is returned by
`get_greenfield_build_context` as `agent_build_capsule` and is used when a
project starts from an empty folder or when an existing new project needs the
next product slice without duplicating concepts.

```text
G1|<stage-code>|<product-slice>
B|<requested-behavior>[;<requested-behavior>...]
P|<pattern>[;<pattern>...]
C|<known-concept>[;<known-concept>...]
E|<behavior>@<owner-file>[;<behavior>@<owner-file>...]
O|<owner-file>[;<owner-file>...]
R|<read-first-file>[;<read-first-file>...]
N|<next-file>[;<next-file>...]
D|<do-not-rebuild-rule>[;<do-not-rebuild-rule>...]
V|<validation-check>[;<validation-check>...]
!|<stop-rule>
```

Stage codes:

- `0`: empty-folder first slice.
- `c`: continuation/growth slice after files exist.

Agent decoding rule:

1. Build exactly the `G1` product slice, not the whole imagined product.
2. Use `P` as the architecture budget.
3. Reuse `C`, extend `E`, and inspect `O`/`R` before creating new concepts.
4. Treat `D` as the anti-duplication contract.
5. Create/update only what `N` requires unless source evidence proves a missing
   owner.
6. Run `V`, then stop for Klauro re-analysis before the next slice.

## Benchmark Command

```bash
cd apps/mcp-server
npm run agent-context-codec-benchmark -- --output /tmp/klauro-agent-context-codec-benchmark.json
```

The benchmark scores token count, byte size, encode speed, agent readability,
actionability, exact-path preservation, and prompt-native execution. It reports
two local token lenses: the old `chars/4` estimate and a stricter `promptish`
lexical estimate that counts words, numbers, path punctuation, and delimiters.
K15 wins the balanced score because it keeps K14's direct usability while
folding the dominant file extension into the header and removing separator
tokens from opcode lines. On the representative existing-project context, K15
measured about 95 estimated tokens and 85 promptish tokens versus K14 at 98 /
90, K13 at 102 / 102, K12 at 104 / 109, K11 at 112 / 150, K10 at 115 / 167,
and minified JSON at 354 / 448.
Binary/base64 variants can be smaller in bytes, but they lose because the model
cannot use them without a decoder/tool turn.

Greenfield compactness has its own codec benchmark:

```bash
cd apps/mcp-server
npm run greenfield-build-codec-benchmark -- --output /tmp/klauro-greenfield-build-codec-benchmark.json
```

The benchmark compares full JSON, short-key JSON, Markdown, TSV/opcodes,
protobuf-style text, JSONB rowsets, CBOR diagnostic JSON, MessagePack-style
base64 payloads, gzip/base64 variants, and `G1`. It scores token count, encode speed, agent readability,
actionability, ownership-memory preservation, and prompt-native execution.
Current representative results select `g1-build-capsule`: about 95.5% token
reduction versus full greenfield JSON for empty-folder first-slice guidance and
about 96.5% reduction for CAS-backed continuation guidance, while preserving
the owner/read/next-file and do-not-rebuild rules an agent needs.

Greenfield build quality is verified separately:

```bash
cd apps/mcp-server
npm run agent-from-zero-build-context-proof
```

That proof starts from empty folders, grows multiple product slices, and checks
that `G1` preserves concept ownership, avoids duplicate domain classes, keeps
tests passing, and reduces continuation context versus unguided baselines.
