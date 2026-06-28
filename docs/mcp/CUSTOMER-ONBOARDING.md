# Customer Onboarding

The first customer experience should prove value without asking the customer to trust a black box.

## First Ten Minutes

Current private distribution path:

```bash
node /absolute/path/to/proof-of-concept/apps/mcp-server/scripts/install.mjs /absolute/path/to/repo --first-value --claude-md /absolute/path/to/repo
```

The installer verifies Node/npm, installs dependencies if needed, builds deterministic `dist/` artifacts, registers the MCP server when Claude Code is available, writes or prints agent operating-loop instructions, runs MCP startup checks, and with `--first-value` returns a first agent work-packet summary.

After install, the direct CLI path is:

```bash
cd apps/mcp-server
node dist/cli.cjs init /absolute/path/to/repo
node dist/cli.cjs upload-manifest /absolute/path/to/repo
node dist/cli.cjs analyze /absolute/path/to/repo --analysis-focus agent-fast
node dist/cli.cjs doctor /absolute/path/to/repo
node dist/cli.cjs install-agent /absolute/path/to/repo
```

The future public-package equivalent is `klauro ...` once packaging and licensing are switched on. Do not tell customers to use `npx @klauro/cli` until that package is actually published.

Expected customer-visible outputs:

- `.klaurorc` with analyzer mode, analyzer URL, project identity, upload policy, and source rules.
- `.klauroignore` with repo-specific privacy exclusions.
- Upload manifest showing exactly which files would be sent.
- CAS stored locally in the MCP cache.
- Agent defaults installed under `.klauro/`, including the K15/K5 capsule-only
  loop for token-minimal agent context.
- A portable skill written to `.klauro/skills/klauro/SKILL.md` so Claude,
  Codex, Cursor-like tools, or other skill-aware agents can learn the same
  K15/K5/G1 decoding rules without relying on a one-off prompt.
- Agent Readiness output from `doctor`.

## Hosted Analyzer

Hosted mode keeps the analyzer implementation off the customer machine:

```bash
node dist/cli.cjs init /absolute/path/to/repo --mode remote --server-url https://analyzer.klauro.dev
node dist/cli.cjs upload-manifest /absolute/path/to/repo
node dist/cli.cjs analyze /absolute/path/to/repo
```

Tokens are not stored in `.klaurorc`. Customers should authenticate through login-managed credential storage or environment variables:

```bash
export KLAURO_ANALYZER_TOKEN=...
```

Use this as the default commercial path. Customers install the thin CLI/MCP
client locally, review the upload manifest, and send filtered source snapshots
or dirty-tree deltas to the hosted analyzer. The analyzer implementation remains
server-side, and returned CAS is cached locally so agents can work quickly after
sync.

## Self-Hosted Analyzer

Enterprise customers can run the analyzer container in their own network:

```bash
docker build -f apps/mcp-server/Dockerfile.analyzer -t klauro-remote-analyzer .
docker run --rm -p 8787:8787 \
  -e KLAURO_ANALYZER_TOKEN=... \
  klauro-remote-analyzer
```

Then:

```bash
node dist/cli.cjs init /absolute/path/to/repo --mode remote --server-url https://klauro.internal
```

Set `.klaurorc` policy gates:

```json
{
  "policy": {
    "allowRemoteAnalyzer": true,
    "allowedAnalyzerHosts": ["https://klauro.internal"],
    "requireSelfHosted": true,
    "blockUntrackedFiles": false
  }
}
```

Use this path when the customer cannot send source to Klauro-hosted
infrastructure. It preserves the same local-agent workflow, but the analyzer
image runs inside the customer's network.

## Deployment Options

| Option | Who runs analyzers | Analyzer IP exposure | Best for | Status |
| --- | --- | --- | --- | --- |
| Local analyzer | Customer machine | Highest; analyzer code is local | Internal development and early demos | Implemented and tested |
| Hosted analyzer | Klauro infrastructure | Lowest; customer receives thin client only | Default commercial deployment | Implemented locally; pending live deploy |
| Self-hosted analyzer | Customer infrastructure | Medium; analyzer image is shipped, not source | Enterprise/security-sensitive customers | Docker path implemented |
| GitHub import | Klauro infrastructure | Lowest | Hosted main-branch analysis and PR checks | Planned integration path; local dirty-tree sync still required |

## GitHub Import

GitHub import is for hosted main-branch truth. It does not replace dirty-tree sync for local agents.

```bash
node dist/cli.cjs github-import-plan /absolute/path/to/repo
```

The GitHub App should request:

- Repository contents: read, for source import.
- Repository metadata: read, for repo identity and default branch.
- Pull requests: read, for PR analysis.
- Checks: write, for Agent Readiness checks.

Webhook events:

- `push`
- `pull_request`
- `installation_repositories`

Local agents still call `remote-sync` for uncommitted changes because those changes do not exist in GitHub yet.

## Release Readiness Test

Before a customer install, run:

```bash
cd apps/mcp-server
npm run new-user-e2e
```

Passing means a fresh temp repo can install Klauro, get first value, start a local hosted analyzer, run full remote analysis, and sync an incremental dirty-tree change without mutating the source repo beyond `.klaurorc`/`.klauroignore` when explicitly initialized.

The command writes `.klauro-new-user-e2e/latest-report.json`. Full product acceptance (`npm run agent-proof-full`) includes this check before `agent-vision-acceptance`, so release readiness fails if the ten-minute install-to-value path or hosted incremental sync breaks.

## Buyer Proof

Each design partner should receive:

- Upload manifest.
- Agent Readiness report.
- With-Klauro vs without-Klauro benchmark report.
- Incremental sync timing.
- Idiom-conformance delta.
- Security packet.
