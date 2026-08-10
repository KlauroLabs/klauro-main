# Customer MCP + CLI Surface Audit — 2026-08-10

Scope: the surface a paying customer actually touches.

- CLI shipped to customers: `apps/mcp-server/src/installed-cli.ts` (bundled to `dist/cli.cjs`, the `klauro` binary). `apps/mcp-server/src/cli.ts` is the developer-only CLI and is **not** shipped — confirmed via `scripts/build-bundle.mjs`.
- MCP shipped to customers: `apps/mcp-server/src/installed-client-server.ts` (`INSTALLED_TOOL_NAMES`, 40 tools).
- `apps/mcp-server/src/server.ts` (~179 tools) is the hosted-only surface — intentionally a different surface, not audited for count parity per the brief.

Method: built the real bundle (`npm run build` → `dist/cli.cjs`) on Node 22.22.0 (never 26 — CLAUDE.md), ran it against scratch git repos, with auth isolated via `KLAURO_AUTH_CONFIG_PATH` pointed at a scratch file. Never ran `klauro login` for real, never touched `/opt/homebrew/bin/klauro`, `~/.klaurorc`, `~/.claude.json`, or `~/.klauro/auth.json`. Work done in an isolated `git worktree` on branch `audit/mcp-cli-surface-0810`, seeded from master `8ca33695`.

Everything under "KNOWN DEFECTS IN THIS AREA" in the brief (#49, #129, #132, #134, the login dead-end, the cross-account dead-end, `signed_in: true` with a dead token) is **already fixed on master** — the fixing commits are ancestors of `8ca33695` (`4d640241`, `7e6629af`, `080365ed`, `3b99146d`, `ab621a89`). Below is verification of those fixes plus what the audit found beyond them.

## A. Argument-parsing correctness matrix

All cells run against the real `dist/cli.cjs`.

| Command | Flag before path | Flag after path | Flag-with-value (`--server-url X`) | Repeated flag | Unknown flag | No path | Relative path | Path with spaces |
|---|---|---|---|---|---|---|---|---|
| `upload-manifest` | PASS — resolves to given path | PASS | PASS | PASS (no-op) | PASS — rejected with usage hint, exit 1 | PASS (defaults to cwd) | PASS | PASS |
| `analyze` | PASS | PASS | PASS | PASS | PASS | PASS — multi-repo root refused with named candidates + remedy (`--yes`), exit 1, no hang; single-repo root without login fails cleanly with the login remedy | PASS | not separately re-tested; parser is shared, no reason to differ |
| `init` | PASS — `--project-id VALUE path` resolves `project_id=VALUE`, `path=<path>`, not swapped | PASS | PASS | PASS | PASS | PASS (defaults to cwd) | not separately re-tested | not separately re-tested |
| `status` | PASS | PASS | PASS, including a **dangling** `--server-url` with no following value (falls back to default server, no crash) | — | — | PASS | — | — |
| `login` | — | — | — | — | PASS | see first-run walkthrough (correctly prompts/explains instead of erroring blind) | — | — |
| `admin-mint-reset-token` | — | — | — | — | PASS | — | — | — |
| unrecognized top-level command (`klauro frobnicate`) | — | — | — | — | — | falls through to usage text, **exit 0** | — | — |
| `--help`/`-h` anywhere in argv (including after other flags) | PASS — prints usage, does not run the command | | | | | | | |

Findings from the matrix:
- **The #49/positional-arg-swallowing class is fixed and holds up under adversarial ordering** (`init --project-id prj_fake123 /path`, `status --server-url http://x /path`, flags before/after/interleaved). Verified `resolvePositionalArg`/`validateFlags` against real runs, not just by reading the code.
- **Low severity — unrecognized top-level command exits 0.** `klauro frobnicate` prints usage and exits `0`, identical to `klauro --help`. A script or CI step that mistypes a subcommand gets silent "success" instead of a nonzero exit. `apps/mcp-server/src/installed-cli.ts:554` (`printUsage()` at the end of `main()`, no `process.exitCode` set for the unmatched-command path).
- **Low severity — undocumented command aliases.** `remote-analyze` (alias for `analyze`) and `sync` (alias for `remote-sync`) are fully wired in `COMMAND_FLAGS`/`PATH_COMMANDS` but never appear in `USAGE_TEXT`. Not broken, just surface a customer can stumble into (e.g. guessing `klauro sync`) that isn't documented, and a second name for the same operation is one more thing to keep straight. `apps/mcp-server/src/installed-cli.ts:104-107` vs `187-224`.

## New defect found and fixed: plain-text mode silently ignored by six commands

`klauro version`, `upload-manifest`/`index`, `init`, `install`, `logout`, and `login` all accept `--json` in `COMMAND_FLAGS` (implying a plain-text default exists) but handed a bare object straight to the shared `output()` helper:

```js
function output(value, json) {
  process.stdout.write(json ? JSON.stringify(...) : (typeof value === 'string' ? value : JSON.stringify(value, null, 2)));
}
```

Since `output()` JSON-stringifies anything that isn't already a string, **every one of these six commands printed a raw JSON dump even without `--json`** — this is exactly the defect class task #129 fixed for `analyze`/`remote-sync` (see that commit's own header comment in `remote-result-format.ts`), just never ported to the rest of the file written by the same pattern. Verified live before the fix:

```
$ klauro version
{
  "version": "1.0.138+8ca3369599dc (bundle, built ...)"
}
$ klauro logout
{
  "file": "...auth.json",
  "removed": false,
  "serverUrl": "https://mcp.klauro.com"
}
```

Fixed in this session (`apps/mcp-server/src/installed-cli.ts`, `apps/mcp-server/src/remote-result-format.ts`, commit `6db74a65`) by giving each a real plain-text branch, added a `formatUploadManifest()` helper alongside the existing `formatRemoteResult()`. Verified after the fix (rebuilt `dist/cli.cjs`):

```
$ klauro version
1.0.138+8ca3369599dc-dirty (bundle, built ...)
$ klauro logout
Not signed in to https://mcp.klauro.com; nothing to do.
$ klauro upload-manifest .
Root: /path/to/repo
Revision: master @ 0986bd0 (working tree dirty)
Would upload 1 file(s), 1974 bytes; 3 file(s) excluded.
Run with --json for the full file-by-file manifest.
$ klauro init
Ready: /path/to/repo
Config written to /path/to/repo/.klaurorc
Not signed in — no hosted project was bound. Run `klauro login` then `klauro init` again to bind one, or `klauro analyze` will fail with a sign-in prompt.
Next: klauro analyze /path/to/repo
```

The `init` fix also closes a first-run gap (see walkthrough below): it now says explicitly when hosted binding was skipped for lack of a session, instead of unconditionally declaring `"status": "ready"`.

`typecheck` clean on the touched files; full bundle rebuilt and re-verified against the scratch repos above.

## B. Naming and shape coherence — customer MCP surface (`installed-client-server.ts`)

This surface is clean. Specifically checked and found no defects:
- **Every one of the 40 tools uses `path` for "project root on disk"** — no `projectPath`/`repo_path`/`dir`/`root`/`cwd` split naming anywhere in `installed-client-server.ts`'s `inputSchema`s (grepped for the alternates, zero hits). The internal handler variables are sometimes renamed to `projectPath` for readability, but the wire-level parameter name a client agent sees is always `path`.
- **No retired vocabulary** (`WAS`, `DAS`, "Analysis Scope") appears anywhere in this file's tool names or `.describe()` text — grepped, zero hits. "Workspace" here consistently means the *current* concept (an account-level group of analyzed projects, `list_workspaces`/`run_workspace_analysis`/`get_workspace_analysis`), described plainly as such, not as the retired Workspace-Analysis-Scope model.
- **`validate_was_contract` correctly does not exist on this surface** — it's a hosted-only (`server.ts`) tool id, which is fine and expected; the id itself is preserved there per the no-rename rule, out of scope here.
- No duplicate tools under different names were found; no parameter doing double duty for two different concepts.
- `fab_*`/`plan_*`/`check_conceptual_conflicts` (coordination fabric) and `list_workspaces`/`run_workspace_analysis`/`get_workspace_analysis` (account-workspace composition) are newer additions (called out in the file's own comments as task #130 / SPECIFICATION.md §0.12 item 7 gap-fills) and follow the same `path`-first, `workspace` (optional, defaults sanely) shape as the rest of the surface — they read as part of one system, not bolted on.

Minor, not a defect: `analyze_codebase`'s `run_answer_pack` tool exposes `pack: z.literal('mastery').optional()` — an enum of exactly one value. This mirrors the hosted server's actual current state (`'mastery' is the only pack` — `server.ts:2127`), so it isn't wrong, just a parameter that can't yet do anything other than its default. Not worth changing until a second pack exists.

## C. First-run path, as a customer, end to end

Walked every step through `klauro install` (not run — see prohibition below), `login`, `init`, `analyze`, first query, stopping before account creation.

1. **`klauro --help`** — usage is complete and mentions every command including the auth-lifecycle ones. Good starting point.
2. **`klauro login` (no args, real terminal)** — prompts for email then a no-echo password prompt. In a non-interactive context (CI, agent harness) it fails immediately with the exact command to run instead (`klauro login --email you@example.com --password-stdin`), and separately for `--register` (`klauro login --register --email you@example.com --password-stdin`) and for password-only-missing. All three verified live above. This is the fix for the owner's "pretty bad experience" / "still terrible" complaint, and it holds up — did not proceed to create an account, per the audit's own no-account-creation constraint.
3. **`klauro init` before login** — succeeds, writes a local `.klaurorc`, but (before this session's fix) unconditionally said `"status": "ready"` with no indication that no hosted project was bound. **Fixed** as part of the plain-text fix above: it now says `Not signed in — no hosted project was bound...` explicitly.
4. **`klauro analyze` without login** — fails cleanly: `Klauro account required for https://mcp.klauro.com. Run \`klauro login\` or set KLAURO_ACCOUNT_TOKEN...`. No hang, no silent success, clear remedy. Good.
5. **`klauro analyze` on a multi-repo root** (task #134) — refuses, names the candidate subdirectories, explains why, and gives the exact flag to override (`--yes`) or the better fix (point at one project). Verified this does not hang on a non-interactive run and exits 1. Good.
6. **`klauro status`** at any point along this path gives an honest one-glance report (account/release/project/in-flight/fabric/analysis/MCP), including truthfully reporting "not signed in" and "not analyzed" rather than a false positive — this is the #117 class of bug (`signed_in: true` with a dead token) and it does not reproduce; `whoami`/`auth-status` both round-trip to `GET /api/me` per `resolveAuthStatus`'s own header comment, not just check file presence.

No new dead ends found past this point that weren't already fixed. The one first-run gap this audit found (`init`'s silent-success message) is fixed above.

## D. Ranked fix list

1. **[Fixed this session]** `version`/`upload-manifest`/`index`/`init`/`install`/`logout`/`login` ignored the plain-text default and always dumped JSON — highest-likelihood hit because `version` and `upload-manifest` are two of the first commands anyone runs (sanity-check the install; preview what will be uploaded before trusting `analyze`). `apps/mcp-server/src/installed-cli.ts`, commit `6db74a65`.
2. **[Fixed this session, as a side effect of #1]** `klauro init` before `klauro login` reported unconditional `"status": "ready"` with no signal that hosted binding was skipped — a customer who runs `init` before `login` (a very natural ordering) would only discover the gap later, at `analyze` time. Now stated explicitly in `init`'s own output.
3. **[Not fixed — low severity, recommend fixing]** `klauro <unrecognized-command>` exits `0`. A one-line fix (`process.exitCode = 1` on the fallthrough path in `main()`, `installed-cli.ts:554`) closes a real but low-frequency script-safety gap.
4. **[Not fixed — cosmetic]** `remote-analyze`/`sync` are undocumented aliases for `analyze`/`remote-sync`. Either document them in `USAGE_TEXT` or remove the alias surface; leaving it silent is the only issue.
5. **[Verified fixed, no action needed]** Everything listed under "KNOWN DEFECTS" in the audit brief (#49 positional-arg swallowing, #134 upload-scope guard, #132 `--force`, #129 accepted-vs-complete, the login dead-end, `signed_in: true` with a dead token) — all confirmed fixed and holding up under adversarial live testing, not just code reading.
6. **[No defect found]** MCP customer surface naming/shape coherence (part B) — clean; no action needed.

## Constraints followed

- Isolated `git worktree add` at `/Users/michaelshattuck/dev/unravl-worktrees/audit-mcp-cli-surface`, branch `audit/mcp-cli-surface-0810` off master `8ca33695`. No `git stash` used.
- `npm ci` run at the worktree root and in `apps/mcp-server` only (Node 22.22.0 via `nvm`, never 26).
- No analysis run on this Mac; no deploy; test repos were scratch git init's under `/private/tmp/klauro-audit-isolated/`, never the shared session scratchpad (which is a busy multi-session directory — confirmed via `ls` before running anything destructive-adjacent there, then moved off it).
- Auth isolated via `KLAURO_AUTH_CONFIG_PATH`; `klauro login` never run for real; `/opt/homebrew/bin/klauro`, `~/.klaurorc`, `~/.claude.json`, `~/.klauro/auth.json` never touched. `klauro install` (which registers into `~/.claude.json`/Codex config) was deliberately never run.
- Committed early (`6db74a65`) with the fix and verification in the same session.
