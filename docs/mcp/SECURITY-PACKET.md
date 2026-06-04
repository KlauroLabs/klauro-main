# Security Packet

This is the minimum security and privacy material needed before onboarding customers to hosted or self-hosted analyzer deployments.

## What Runs Locally

- Thin CLI.
- Source snapshot and dirty-tree sync packer.
- Local MCP server.
- Local CAS cache reader.

## What Runs In The Analyzer Service

- CAS analyzers.
- Idiom and invariant extraction.
- Incremental analysis.
- Report and benchmark scoring.

## What Leaves The Machine

Full remote analysis sends filtered file contents selected by `.klaurorc`, `.klauroignore`, and safe defaults.

Dirty-tree sync sends:

- Changed file contents.
- Deleted file paths when enabled.
- Current Git base commit when available.
- Git diff when enabled.

Customers can inspect this before upload:

```bash
klauro upload-manifest .
klauro upload-manifest . --dirty-tree
```

## Default Exclusions

Klauro excludes dependency trees, generated outputs, caches, Git internals, local agent state, common virtual environments, and common secret files.

Examples:

- `.git`
- `.klauro`
- `.claude`
- `.codex`
- `node_modules`
- `dist`
- `build`
- `.next`
- `.cache`
- `.env`
- `.env.*`
- `*.pem`
- `*.key`
- `secrets/**`

Teams can add exclusions in `.klauroignore`.

## Credentials

Do not store analyzer tokens in `.klaurorc`.

Use:

- Login-managed credential storage for packaged CLI.
- `KLAURO_ANALYZER_TOKEN` for CI and local development.
- Short-lived tokens for hosted analyzer sessions.

## Retention

Hosted deployments should expose retention controls before general availability:

- Delete project.
- Delete uploaded source.
- Delete CAS history.
- Retention period by organization.
- Audit trail for analysis and sync events.

Self-hosted deployments keep source and CAS inside the customer's network.

## Audit And Abuse Controls

The analyzer service writes JSONL audit events for full analysis, incremental sync, and rate-limit rejections. Events include timestamp, analysis id, project id, organization id, file counts, byte counts, graph counts, and changed-file counts. They do not include source contents.

The service also supports a per-token/IP request limit through:

```bash
KLAURO_ANALYZER_RATE_LIMIT_PER_MINUTE=120
```

## Data Use

Customer code must not be used to train models.

If AI summarization is added to the analyzer service, the customer must be able to choose:

- Klauro-hosted model.
- Customer-provided hosted model.
- Self-hosted model.
- Static-analysis-only mode.

## Compliance Roadmap

Before larger enterprise rollout:

- Encryption in transit and at rest.
- Audit logs.
- Org/project access controls.
- SSO/SAML for admin surfaces.
- SOC 2 readiness work.
- Incident response and deletion SLA.
