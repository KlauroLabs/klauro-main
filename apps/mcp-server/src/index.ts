import type { Readable, Writable } from 'stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { grammarHealth } from '../../../packages/analyzer-core/src/analyzer/core/wasm-tree-sitter';
import { writeSessionLock, removeSessionLock } from './session-lock';

/**
 * Boot self-check for the tree-sitter breadth path. In the dev tree this always
 * passes (hoisted deps + vendored grammars). It exists to catch a BROKEN
 * install/deploy loudly on stderr — the failure mode that shipped grammar-less
 * to the wild — instead of silently degrading every breadth language to nothing.
 * Non-fatal: native/regex languages still work; this only governs WASM breadth.
 */
function reportGrammarHealth(): void {
  try {
    const h = grammarHealth();
    if (h.count === 0) {
      process.stderr.write(
        `Klauro WARNING: 0 tree-sitter grammars resolved — WASM breadth analysis is DISABLED. ` +
          `Searched [${h.dirs.join(', ') || 'no existing dirs'}]. ` +
          `Rebuild the bundle (npm run build) or set KLAURO_GRAMMARS_DIR.\n`,
      );
    } else if (h.count < 30) {
      process.stderr.write(
        `Klauro WARNING: only ${h.count} tree-sitter grammars resolved (expected ~160). ` +
          `Dirs: [${h.dirs.join(', ')}]. Breadth coverage is degraded.\n`,
      );
    } else {
      if (process.env.KLAURO_DEBUG_STARTUP === '1') {
        process.stderr.write(`Klauro: ${h.count} tree-sitter grammars available (e.g. ${h.sample.join(', ')}).\n`);
      }
    }
  } catch (err) {
    process.stderr.write(`Klauro: grammar self-check failed: ${err instanceof Error ? err.message : err}\n`);
  }
}

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
  reportGrammarHealth();
  // Best-effort session lock (~/.klauro/mcp-sessions/<pid>.json): lets
  // `klauro update`/`klauro status` tell the human "a running MCP session was
  // detected — restart it after updating" instead of updating silently with
  // no signal that anything needs to change client-side. Never blocks startup.
  writeSessionLock();
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
