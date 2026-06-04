# Answer Gauntlet

The answer gauntlet is Klauro's truth-quality loop. The golden repo gauntlet proves the analyzer can build a connected CAS graph. The answer gauntlet proves MCP-style product questions can be answered from that graph with evidence.

It asks the same core questions a human reviewer or AI coding agent needs answered:

- What is this codebase and what technologies does it use?
- What are the main ways execution enters this system?
- What happens after a representative entry point is invoked?
- What would be affected if a central code element changed?
- What data does this system read or write?
- What tests and flow coverage exist?
- What external systems, files, messages, APIs, or caches does this code touch?
- Where are the security boundaries and auth-related code?

Each answer must include structured evidence: node IDs, entry point IDs, exit point IDs, call chain IDs, facts, tests, files, and line numbers when CAS has them. A response that sounds plausible but cannot point back to CAS should not pass.

## Run It

```bash
cd apps/mcp-server
npm run answer-gauntlet
```

Run one repo:

```bash
cd apps/mcp-server
npm run answer-gauntlet -- --repo klauro=/Users/michaelshattuck/dev/klauro/proof-of-concept
```

Run discovery without analysis:

```bash
cd apps/mcp-server
npm run answer-gauntlet -- --dry-run
```

The default report is written to `.klauro-answer-gauntlet/latest-report.json`.

## How It Scores

For each target repo, the answer gauntlet runs a fixed set of answer probes. Each probe checks:

- The relevant MCP query surface returns a useful answer.
- The answer has CAS evidence.
- Every evidence reference resolves back to the current CAS output.
- Missing data is reported as a gap rather than hidden.

The report status is:

- `pass`: all probes meet the current product bar.
- `warn`: the repo is mostly answerable but has one or more weak surfaces.
- `fail`: an answer is missing, ungrounded, or analysis produced errors.

## Product Bar

A repo is not mastered just because it has many nodes and edges. It is mastered when Klauro can explain it:

- Overview answers describe the system with detected technologies and evidence.
- Entry answers expose real entry points, not guessed routes.
- Flow answers connect entry points to call chains.
- Impact answers show callers, callees, tests, and change risk context.
- Data answers expose entities, schema, or database exits when present.
- Boundary answers expose external systems and security-related surfaces.

The answer gauntlet is intentionally deterministic. It does not depend on an LLM judge. Once this is green, the next layer can add natural-language answer snapshots and maintainer review.
