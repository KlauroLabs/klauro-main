# Klauro Agent Capsules

Klauro uses two prompt-native capsule formats over CAS-backed work packets:

- `K5`: the execution capsule for the next edit.
- `K15`: the agent context language for selected-node orientation, indexed file
  dictionary, idioms, reuse, risk, validation, and expansion rules.

They are not replacements for CAS. They are transmission layers over CAS:
enough context for the next turn, in the fewest tokens that an agent can still
execute correctly.

## Why Not Binary By Default

Binary and semi-binary formats such as Protocol Buffers, FlatBuffers,
MessagePack, and CBOR are excellent for server-to-server transport and storage.
PostgreSQL `jsonb` is useful for database-side storage, indexing, and querying
of semi-structured analysis artifacts. They are the wrong default prompt format
because agents receive text. Base64-wrapped binary payloads can be compact in
bytes but opaque to the model, so the agent must decode them with a tool or
ignore them. That usually costs more turns and makes the first action less
reliable.

JSON is readable, but the repeated keys and nested structure are expensive for
first-turn context. TOON-style table layouts are a strong general-purpose text
baseline for LLM prompts, but Klauro can do better by using CAS-specific
opcodes. JSON remains the expanded API format. `K5` and `K15` are prompt-native
text codecs in stable line formats.

## K5 Execution Format

```text
K5|m|target
F|1*:src/services/taskSummaryService.ts;2*:tests/taskSummaryService.test.ts;3:src/repositories/projectRepository.ts
O|1:ids=uniq(tasks.projectId)>findByIds(ids)>Map>sync map;2:inline repo counts findById/findByIds/capturedIds
A|unique projectIds>findByIds>Map>map tasks
Q|findByIds once;findById zero
N|package.json;controller edit;repository edit
P|service/repo boundary;public contract
V|node /tmp/validator.cjs
B|f2,w40
S|val-stop
```

Codes:

- `K5`: version, task code, target.
- `F`: exact file dictionary with role sigils. No sigil means read-only, `*`
  means read then edit, and `!` means edit-only. Operations use numeric indexes
  into this list.
- `O`: file-scoped executable operations, using `fileIndex:operation`.
- `A`: implementation actions when no file-scoped operation exists.
- `Q`: required proof, tests, or diff evidence.
- `N`: forbidden shortcuts, files, or patterns.
- `P`: conventions, boundaries, or risks to preserve.
- `V`: validation command.
- `V|klauro-post-edit`: delegate validation to Klauro/the harness after the
  edit so the agent does not spend model tokens reading validation logs.
- `B`: budget, where `f` is source-file budget and `w` is final-response words.
- `S`: stop rule.

Task codes:

- `m`: modify
- `d`: debug
- `r`: review
- `t`: trace
- `o`: orient

## Selection Criteria

The default prompt format must optimize for all of these:

- Token count lower than short-key JSON.
- Still directly understandable without a decoder.
- Preserves file order, edit scope, validation, and forbidden shortcuts.
- Can be copied into Claude, Codex, Cursor, or self-hosted model prompts.
- Can be parsed deterministically by Klauro tooling when needed.

`K5` is the default execution capsule inside capsule-only and first-turn MCP
packets. It supersedes the earlier `K3` and `K4` layouts by folding read/edit
scope into the file dictionary, preserving exact paths, and keeping direct
operations prompt-native. Expanded JSON remains available through the normal
`get_agent_work_packet` response and follow-up tools.

## K15 Agent Context Language

`K15` is the compact agent-readable context format. It carries the context
agents need before reading source files, without forcing them to parse the
expanded JSON packet. It supersedes `K14` by keeping role-grouped file aliases,
moving the default extension into the header, and removing separator spaces
from opcode lines without dropping exact paths or validation cues.

```text
K15mts UsersService tenant user creation
As src ts tests
Es users/users.service ts users/users.service.test
Os users/users.repository
Cs users/users.controller
@UsersService svc 1 12
IDIctor testProdSrc
UTenantUserMgmtReuse
RhiTenantBdry invAuthz
Vtest 2
!F idioms expandIfBlocked
```

Codes:

- `K15`: version, task code, optional default extension, and task. For example,
  `K15mts` means modify task plus default `.ts` restoration.
- `A`: optional path aliases. Agents expand aliases before opening files.
- `E`: indexed read-then-edit files.
- `O`: indexed read-first files.
- `C`: indexed candidate/read-only files. Other lines can refer to files as
  `1`, `2`, etc. in the order `E`, then `O`, then `C`.
- `@`: selected CAS node as `name type fileIndex line`.
- `I`: local idioms and conventions.
- `U`: capability memory and reuse constraints.
- `R`: risks and invariants to preserve.
- `V`: focused validation commands, with optional `#` file references.
- `!`: expansion rule.

Agents should request `get_agent_work_packet` with
`response_profile: "capsule-only"` when token savings matter most. Read `K15`
first for orientation, then execute `K5` for the exact edit. If `K15` and `K5`
disagree, prefer the more specific `K5` edit operation and report the conflict
as a Klauro packet issue. Retry with `response_profile: "first-turn"` only when
the capsules leave a concrete gap and the agent needs compact JSON fields.

## Benchmark

Run:

```bash
cd apps/mcp-server
npm run execution-capsule-benchmark -- --output /tmp/klauro-execution-capsule-benchmark.json
npm run agent-context-codec-benchmark -- --output /tmp/klauro-agent-context-codec-benchmark.json
```

The execution benchmark compares minified JSON, short-key JSON, line opcode
text, S-expressions, protobuf-style text, URI opcodes, gzip/base64 variants,
legacy `K4`, and `K5`.

The context benchmark compares minified JSON, short-key JSON, TOON-style tables,
TSV opcodes, protobuf-style text, JSONB-style rowsets, CBOR diagnostic JSON,
`K5` plus short JSON, gzip/base64 variants, legacy `K6`, `K7`, `K8`, `K9`, and
`K10`/`K11`/`K13`/`K14`/`K15`.

The winner is selected by a balanced score: estimated tokens, encode speed,
agent readability, actionability, exact-path preservation, prompt-native
execution, and byte size. Byte-only winners are rejected when they are opaque to
the model.
