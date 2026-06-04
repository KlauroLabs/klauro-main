# Golden Repo Gauntlet

The golden repo gauntlet is the product proof loop for Klauro. It runs the same CAS analyzer path used by MCP against real local repositories and scores whether the output is useful enough for humans and agents to trust.

The goal is not just "analysis completed." The goal is: can someone see what was built, drill from product surface to implementation, and ask an agent precise questions without rereading the repo from scratch?

## Default Targets

The gauntlet discovers these repos under `~/dev` when present:

- `klauro/proof-of-concept`
- `personal/kadra.ai`
- `personal/money`
- `zerac/zerac-ui`
- `zerac/zerac-api`
- `zerac/zerac-demo`
- `zerac/zerac-scan`
- `soon/soon-sync`

Run discovery without analysis:

```bash
cd apps/mcp-server
npm run gauntlet -- --dry-run
```

Run one repo:

```bash
cd apps/mcp-server
npm run gauntlet -- --repo klauro=/Users/michaelshattuck/dev/klauro/proof-of-concept
```

Run discovered repos and write the default report:

```bash
cd apps/mcp-server
npm run gauntlet
```

The default report is written to `.klauro-gauntlet/latest-report.json`.

## What It Scores

Each repo gets a 0-100 score from:

- Analyzer errors: any analysis error fails the target.
- Node and edge volume against the repo expectation.
- Entry point coverage.
- Method-call and call-chain coverage.
- Required language/framework detection.
- Graph integrity from `validation.graph_integrity`.
- Entry point handler coverage.
- Exit point source coverage.
- Analysis facts with evidence.

The score is intentionally blunt. A repo with lots of nodes but no reachable behavior should not pass. A repo with a nice diagram but analyzer errors should not pass.

## Product Bar

For a repo to count as mastered, the gauntlet should pass and a human should be able to:

- Open the system overview and identify the major applications/packages.
- Drill into controllers, pages, routes, services, repositories, data entities, tests, and external calls.
- Select an entry point and follow the connected implementation path.
- See evidence for important claims.
- See runtime signals mapped back to CAS node ids when telemetry exists.
- Ask MCP "what changes if I touch this?" and receive a bounded answer grounded in CAS.

## How To Use Failures

Failures become analyzer or UI backlog, not exceptions to explain away.

- Missing languages/frameworks: improve detection or repo-root discovery.
- Low entry point coverage: improve framework route/page/controller analyzers.
- Low method-call/call-chain coverage: improve language analyzer body traversal.
- Dangling graph edges: fix CAS relationship generation.
- Missing evidence: improve `analysis_facts` generation.
- Missing runtime links: improve SDK instrumentation or static runtime mapping.

The gauntlet is the loop that turns "this is cool" into "this is dependable."

## Companion: Answer Gauntlet

After this structural gauntlet passes, run the answer gauntlet:

```bash
cd apps/mcp-server
npm run answer-gauntlet
```

The answer gauntlet checks whether MCP-style product questions can be answered from CAS with evidence. It is the next bar after graph completeness.
