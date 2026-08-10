// Unified entry point for the self-contained `klauro` binary (Node SEA —
// see scripts/build-sea-binary.mjs).
//
// A Node "single executable application" embeds exactly ONE script; there is
// no `dist/` directory beside it to `require()` a second file from, the way
// the npm-installed client does (dist/cli.cjs for the CLI, dist/index.cjs ->
// dist/server.cjs for the stdio MCP server — see bootstrap.ts). Both entry
// points are combined here and dispatched on argv[2], each still built from
// the exact same source files (installed-cli.ts, index.ts) esbuild already
// bundles for the npm path, so the two distribution channels run identical
// client logic.
//
// Deliberate scope cut for this first SEA build: this skips bootstrap.ts's
// fast-handshake trick (answer `initialize` instantly from a pre-captured
// dist/handshake.json, then lazily require the real server from a SEPARATE
// file to shave startup latency). That trick is keyed to two files on disk;
// reproducing it inside one embedded blob needs its own design and is left
// for a follow-up. The binary starts the real MCP server directly — still a
// cold start, but with no `npm install` / node-gyp step ahead of it, which is
// the latency and failure mode this binary exists to remove.
//
// `require()` (not a static `import`) is required here: esbuild lowers a
// top-level `import` into an unconditional call in source order, which would
// execute BOTH installed-cli.ts's and index.ts's unconditional top-level
// main()/startServer() side effects every run. The two modes must stay
// mutually exclusive, so the branch not taken must never even be required.
const mode = process.argv[2];
if (mode === '__mcp_server') {
  // Drop the sentinel so downstream argv-reading code (none today, but
  // installed-cli.ts's flag validation runs on this same argv shape) sees
  // the same argv[2].. it would after `node dist/server.cjs` with no extra
  // leading token.
  process.argv.splice(2, 1);
  require('./index');
} else {
  require('./installed-cli');
}
