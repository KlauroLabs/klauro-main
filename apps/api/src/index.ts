import { createRemoteAnalyzerHttpServer } from '../../mcp-server/src/remote-analyzer-service.js';
import { prewarmAnalysisWorker } from '../../mcp-server/src/analyzer.js';

const port = Number(process.env.PORT || process.env.KLAURO_API_PORT || process.env.KLAURO_ANALYZER_PORT || 8787);
prewarmAnalysisWorker();
const server = createRemoteAnalyzerHttpServer();

server.listen(port, () => {
  process.stdout.write(`Klauro API listening on http://0.0.0.0:${port}\n`);
});

// Graceful shutdown (defect #24 companion): without a SIGTERM handler the
// container dies by signal and docker reports a non-zero exit on every stop /
// recreate — log noise that masks real crashes. Close the listener, then exit
// 0; the 5s fail-safe covers a close() wedged on a stuck keep-alive socket.
function shutdown(): void {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
