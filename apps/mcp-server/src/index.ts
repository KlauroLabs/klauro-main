import type { Readable, Writable } from 'stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './installed-client-server.js';
import { checkRunningBundleStaleness } from './bundle-staleness';
import { writeSessionLock, removeSessionLock } from './session-lock';

process.on('uncaughtException', (error) => {
  process.stderr.write(`Klauro MCP uncaught exception: ${error?.stack || error}\n`);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
  process.stderr.write(`Klauro MCP unhandled rejection: ${msg}\n`);
});

process.stdin.on('end', () => { removeSessionLock(); process.exit(0); });
process.stdin.on('close', () => { removeSessionLock(); process.exit(0); });
process.on('SIGTERM', () => { removeSessionLock(); process.exit(0); });
process.on('SIGHUP', () => { removeSessionLock(); process.exit(0); });
process.on('exit', () => removeSessionLock());

export async function startServer(
  input: Readable = process.stdin,
  output: Writable = process.stdout
): Promise<void> {
  // Best-effort session lock (~/.klauro/mcp-sessions/<pid>.json): lets
  // `klauro update`/`klauro status` tell the human "a running MCP session was
  // detected — restart it after updating" instead of updating silently with
  // no signal that anything needs to change client-side. Never blocks startup.
  writeSessionLock();
  // Stale-bundle guard: an MCP client is registered against the BUILT bundle,
  // so a bundle older than the sources beside it keeps serving an outdated
  // contract with no outward sign. Report it here rather than letting the
  // mismatch present later as an unexplained tool failure. Never blocks
  // startup — a stale-but-working client beats no client at all.
  try {
    const staleness = checkRunningBundleStaleness(__dirname);
    if (staleness.note) process.stderr.write(`Klauro MCP stale bundle: ${staleness.note}\n`);
  } catch { /* the guard must never be the reason the server fails to start */ }
  const server = createServer();
  const transport = new StdioServerTransport(input, output);
  await server.connect(transport);
}

if (!process.env.KLAURO_DEFER_START) {
  startServer().catch((error) => {
    process.stderr.write(`Klauro MCP server failed to start: ${error}\n`);
    process.exit(1);
  });
}
