# Customer Onboarding

The first customer experience should prove value without asking the customer to trust a black box.

The customer is not choosing between separate "local" and "remote" products.
They are using Klauro. A Klauro analysis can start from a connected Git repo, a
local committed tree, a workspace folder, or in-flight branch/session work. The
result should be one coherent CAS-backed experience (repo- and workspace-level) for UI and MCP.

## First Ten Minutes

macOS and Linux:

```bash
curl -fsSL https://mcp.klauro.com/install.sh | sh
klauro login --email you@example.com
cd /absolute/path/to/repo
klauro init
klauro analyze
klauro doctor
```

Windows PowerShell:

```powershell
irm https://mcp.klauro.com/install.ps1 | iex
klauro login --email you@example.com
Set-Location C:\absolute\path\to\repo
klauro init
klauro analyze
klauro doctor
```

The installer downloads the checksum-verified platform executable, smoke-tests it, and installs `klauro`. If no executable is available for the platform, it explicitly offers the dependency-free npm-package fallback. `klauro init` binds the repository, writes the local policy files, configures supported agent clients, and enables Fabric when the account and workspace permit it. `klauro analyze` submits the filtered committed-source context to the hosted analyzer and waits for a queryable CAS.

Expected customer-visible outputs:

- `.klaurorc` with analyzer mode, analyzer URL, project identity, upload policy, and source rules.
- `.klauroignore` with repo-specific privacy exclusions.
- Upload manifest showing exactly which files would be sent.
- Hosted CAS identity and bounded response cache stored locally for MCP access.
- Agent defaults installed under `.klauro/`, including the K15/K5 capsule-only
  loop for token-minimal agent context.
- A portable skill written to `.klauro/skills/klauro/SKILL.md` so Claude,
  Codex, Cursor-like tools, or other skill-aware agents can learn the same
  K15/K5/G1 decoding rules without relying on a one-off prompt.
- Agent Readiness output from `doctor`.

## Hosted Analyzer

Hosted mode keeps the analyzer implementation off the customer machine.

When a customer connects a Git provider repo to Klauro, Klauro's VPS/cloud does
the full shared analysis from selected-branch pushed commits. The local MCP then
gives agents that shared CAS context (repo- and workspace-level).

When a customer starts from a local folder before connecting a repo, or for a
local-only repo, the local client sends a filtered, compressed committed-source
context to hosted analyzers:

```bash
node dist/cli.cjs init /absolute/path/to/repo --mode remote
node dist/cli.cjs upload-manifest /absolute/path/to/repo
node dist/cli.cjs analyze /absolute/path/to/repo
```

Tokens are not stored in `.klaurorc`. Customers should authenticate through login-managed credential storage or environment variables:

```bash
export KLAURO_ANALYZER_TOKEN=...
```

Customers install the thin CLI/MCP client for agent access, account login,
cache reads, committed-source submission, and in-flight analysis for active
branch/session/working-tree work. Before uploading local source, customers can
review the upload manifest. The analyzer implementation remains server-side
where appropriate, and returned CAS context (repo- and workspace-level) is cached so agents can work
quickly after sync.

In-flight analysis is provisional, not private by definition. Teams should be
able to share it with authorized workspace members so another human or agent can
see that work is coming before commit or push. That enables deduplication,
soft-merge planning, and overlap warnings across humans, agents, branches, and
incoming analyzed revisions.

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
| Connected-repo hosted analyzer | Klauro infrastructure | Lowest; Klauro pulls connected Git repos on the VPS/cloud | Automatic selected-branch analysis on push | Provider detection/planning implemented; Git app import service pending |
| Local committed-source analyzer | Klauro infrastructure | Medium; filtered/compressed source contexts leave the laptop | Local-only repos, pre-push commit analysis, and teams without connected providers | Implemented and tested |
| Self-hosted analyzer | Customer infrastructure | Medium; analyzer image is shipped, not source | Enterprise/security-sensitive customers | Docker path implemented |
| GitHub import | Klauro infrastructure | Lowest | Hosted selected-branch analysis and PR checks | Planned integration path; in-flight context still supports uncommitted and branch/session work |

## GitHub Import

GitHub import is for automatic selected-branch analysis on push. It does not
replace in-flight context for active human and agent work.

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

Local agents still submit in-flight context for uncommitted or not-yet-shared
branch work because those changes may not exist in the connected provider yet.
When the work becomes a committed analyzed revision, Klauro promotes it from
provisional context into durable project truth.

## Release Readiness Test

Before a customer install, run:

```bash
cd apps/mcp-server
npm run new-user-e2e
```

Passing means a fresh temp repo can install Klauro, get first value, reach the
Klauro analyzer service, run a cold product analysis, query warm MCP context,
and submit an in-flight change without mutating the source repo beyond
`.klaurorc`/`.klauroignore` when explicitly initialized.

The command writes `.klauro-new-user-e2e/latest-report.json`. Full product acceptance (`npm run agent-proof-full`) includes this check before `agent-vision-acceptance`, so release readiness fails if the ten-minute install-to-value path or hosted incremental sync breaks.

## Buyer Proof

Each design partner should receive:

- Upload manifest.
- Agent Readiness report.
- With-Klauro vs without-Klauro benchmark report.
- Incremental sync timing.
- Idiom-conformance delta.
- Security context.
