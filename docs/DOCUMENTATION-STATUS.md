# Documentation Status

Updated 2026-08-18. This index separates normative product contracts, current customer instructions, implementation evidence, design proposals, and historical investigations. Dated evidence does not establish current beta readiness unless `docs/PRODUCT-READINESS.md` cites it for the active candidate.

## Normative product contracts

| Document | Authority |
| --- | --- |
| `CONTEXT.md`, `docs/context/VISION.md` | Product origin, scope, and vision: Klauro is the understanding and visibility layer for any software. |
| `docs/PRODUCT-READINESS.md` | Non-UI beta requirements, current exact evidence, and open gates. |
| `docs/cas/SPECIFICATION.md` | Canonical recursive CAS graph contract. |
| `docs/SEMANTIC-MODEL.md`, `docs/COMPREHENSION-LAYER.md`, `docs/UNDERSTANDING-MODEL.md` | Canonical comprehension, ICELOT, capability, flow, step, entity, and evidence semantics. |
| `docs/SPEC-ABSTRACTION-TIERS.md`, `docs/TIER-BOUNDARY-GATE.md` | Tier dependency and enforcement contract. |
| `docs/SPEC-COORDINATION-FABRIC-V3.md`, `docs/SPEC-COORDINATION-ENGINE.md`, `docs/COORDINATION-FABRIC.md` | Fabric's overlap-preserving collaboration model and current product surface. |
| `docs/KLAURO-PRODUCT-MODEL.md`, `docs/ARCHITECTURE.md` | Current product and runtime architecture. |

If these documents disagree, resolve the conflict in source and update the less authoritative document rather than preserving two product models.

## Current customer documentation

| Document | Coverage |
| --- | --- |
| `docs/mcp/GETTING-STARTED.md` | Hosted installation, authentication, MCP registration, analysis, first agent context, and troubleshooting. |
| `docs/mcp/CUSTOMER-ONBOARDING.md` | First-ten-minutes journey, hosted and self-hosted options, implemented versus planned integrations, and buyer proof. |
| `docs/mcp/CONFIGURATION.md` | Native/npm customer install distinction, contributor requirements, provider configuration, MCP configuration, storage, and remote analysis. |
| `docs/mcp/CLAUDE-MD-PROMPT.md` | Agent operating loop over the MCP surface. |
| `docs/mcp/REMOTE-ANALYZER.md` | Hosted and self-hosted analyzer behavior and source transfer. |
| `docs/mcp/TELEMETRY-INGESTION.md` | Runtime event contract and ingestion. |
| `docs/AI-PROVIDER.md` | Supported hosted AI providers and provenance behavior. |
| `docs/SECURITY-PRIVACY.md` | Data, credential, source-transfer, and retention boundaries. |

The customer path is the published CLI/MCP plus hosted analyzer. Source-checkout commands are contributor instructions and must be labeled as such. A missing native binary uses the Node 20+ npm fallback; building the monorepo requires Node 22.

## Reference documentation

- `docs/mcp/TOOLS.md`, `PROMPTS.md`, `RESOURCES.md`, and `USAGE.md` describe the query surface. Registered tools remain authoritative when a reference entry lags.
- `docs/cas/README.md`, `VERSIONING.md`, and versioned CAS documents explain schema history. Versioned RFPs are historical snapshots, not current implementation claims.
- `docs/SPEC-ANALYZER-PACKS.md`, coverage specifications, entity/deployable specifications, and other `SPEC-*` documents may contain explicitly planned sections. Their status labels must not be read as shipped product evidence.
- `docs/cas/CAS_ROADMAP.md` contains only active priorities and implemented foundations; `docs/PRODUCT-READINESS.md` decides completion.
- `docs/PROPOSAL-ANALYSIS-TRUST-AND-REVIEW.md` is a proposal (2026-10-04): open ends in flow standing, resolver kind on edges, failed AI asks fail the run, a route query and rename-safe comparison. It explicitly adds no validation passes. Nothing in it is built.
- `docs/PROPOSAL-ACCURACY-AND-DEPTH-FROM-THE-FIELD.md` is a proposal (2026-10-04): improving speed, accuracy, depth and breadth of the engine's own output, with offline answer-key testing to find resolver misses. Nothing in it is built.

## Evidence and historical documents

Dated audits, corpus sweeps, scorecards, benchmark reports, fleet proofs, gap investigations, context plans, and raise material preserve how conclusions were reached. They may name repositories, record old versions, or describe defects that were later fixed. They are not production rules and must not be used as current release evidence without a fresh source-exact rerun.

This category includes:

- `docs/audits/`
- `docs/context/` files other than `VISION.md` when they describe a dated plan or implementation pass
- `docs/CORPUS-VALIDATION.md`, `CORPUS-DEPTH-SWEEP.md`, `CATALOG-VARIANCE-FINDINGS-33.md`, and dated proof documents
- `docs/cas/v*.md` version history
- `docs/RAISE-DECK.md`, competitive reports, and generated scorecards

Historical documents stay useful, but statements such as “absent,” “planned,” test counts, tool counts, live versions, and performance numbers are scoped to their recorded date unless refreshed.

## Documentation beta gate

Before release:

1. Run documentation contract tests on the final VPS candidate.
2. Execute the customer onboarding commands from a clean install prefix.
3. Confirm every command, required runtime version, URL, fallback, and recovery instruction against the released artifact.
4. Confirm implemented/planned status in customer docs against source.
5. Write final candidate identities and reports into `docs/PRODUCT-READINESS.md`.
