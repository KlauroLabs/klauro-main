# Customer Onboarding

The first customer experience should prove value without asking the customer to trust a black box.

## First Ten Minutes

```bash
npx @unravl/cli init
npx @unravl/cli upload-manifest
npx @unravl/cli analyze
npx @unravl/cli doctor
npx @unravl/cli install-agent
```

In this repository today, the equivalent development commands are:

```bash
cd mcp-server
npm run init -- /absolute/path/to/repo
npm run upload-manifest -- /absolute/path/to/repo
npm run analyze -- /absolute/path/to/repo
npm run doctor -- /absolute/path/to/repo
npm run install-agent -- /absolute/path/to/repo
```

Expected customer-visible outputs:

- `.unravlrc` with analyzer mode, analyzer URL, project identity, upload policy, and source rules.
- `.unravlignore` with repo-specific privacy exclusions.
- Upload manifest showing exactly which files would be sent.
- CAS stored locally in the MCP cache.
- Agent defaults installed under `.unravl/`.
- Agent Readiness output from `doctor`.

## Hosted Analyzer

Hosted mode keeps the analyzer implementation off the customer machine:

```bash
npx @unravl/cli init --mode remote --server-url https://analyzer.unravl.dev
npx @unravl/cli upload-manifest
npx @unravl/cli analyze
```

Tokens are not stored in `.unravlrc`. Customers should authenticate through login-managed credential storage or environment variables:

```bash
export UNRAVL_ANALYZER_TOKEN=...
```

## Self-Hosted Analyzer

Enterprise customers can run the analyzer container in their own network:

```bash
docker build -f mcp-server/Dockerfile.analyzer -t unravl-remote-analyzer .
docker run --rm -p 8787:8787 \
  -e UNRAVL_ANALYZER_TOKEN=... \
  unravl-remote-analyzer
```

Then:

```bash
npx @unravl/cli init --mode remote --server-url https://unravl.internal
```

Set `.unravlrc` policy gates:

```json
{
  "policy": {
    "allowRemoteAnalyzer": true,
    "allowedAnalyzerHosts": ["https://unravl.internal"],
    "requireSelfHosted": true,
    "blockUntrackedFiles": false
  }
}
```

## GitHub Import

GitHub import is for hosted main-branch truth. It does not replace dirty-tree sync for local agents.

```bash
npx @unravl/cli github-import-plan
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
- With-Unravl vs without-Unravl benchmark report.
- Incremental sync timing.
- Idiom-conformance delta.
- Security packet.
