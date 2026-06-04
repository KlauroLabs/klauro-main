# Customer Onboarding

The first customer experience should prove value without asking the customer to trust a black box.

## First Ten Minutes

```bash
npx @klauro/cli init
npx @klauro/cli upload-manifest
npx @klauro/cli analyze
npx @klauro/cli doctor
npx @klauro/cli install-agent
```

In this repository today, the equivalent development commands are:

```bash
cd apps/mcp-server
npm run init -- /absolute/path/to/repo
npm run upload-manifest -- /absolute/path/to/repo
npm run analyze -- /absolute/path/to/repo
npm run doctor -- /absolute/path/to/repo
npm run install-agent -- /absolute/path/to/repo
```

Expected customer-visible outputs:

- `.klaurorc` with analyzer mode, analyzer URL, project identity, upload policy, and source rules.
- `.klauroignore` with repo-specific privacy exclusions.
- Upload manifest showing exactly which files would be sent.
- CAS stored locally in the MCP cache.
- Agent defaults installed under `.klauro/`.
- Agent Readiness output from `doctor`.

## Hosted Analyzer

Hosted mode keeps the analyzer implementation off the customer machine:

```bash
npx @klauro/cli init --mode remote --server-url https://analyzer.klauro.dev
npx @klauro/cli upload-manifest
npx @klauro/cli analyze
```

Tokens are not stored in `.klaurorc`. Customers should authenticate through login-managed credential storage or environment variables:

```bash
export KLAURO_ANALYZER_TOKEN=...
```

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
npx @klauro/cli init --mode remote --server-url https://klauro.internal
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

## GitHub Import

GitHub import is for hosted main-branch truth. It does not replace dirty-tree sync for local agents.

```bash
npx @klauro/cli github-import-plan
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

## Buyer Proof

Each design partner should receive:

- Upload manifest.
- Agent Readiness report.
- With-Klauro vs without-Klauro benchmark report.
- Incremental sync timing.
- Idiom-conformance delta.
- Security packet.
