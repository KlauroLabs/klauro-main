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




  writeSessionLock();





  try {
    const staleness = checkRunningBundleStaleness(__dirname);
    if (staleness.note) process.stderr.write(`Klauro MCP stale bundle: ${staleness.note}\n`);
  } catch {   }
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
