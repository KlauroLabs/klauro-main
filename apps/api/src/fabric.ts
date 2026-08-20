import { createRemoteAnalyzerHttpServer } from '../../mcp-server/src/remote-analyzer-service.js';
import { restrictProcessFileCreation } from '../../mcp-server/src/hosted-storage-security.js';

restrictProcessFileCreation();
const port = Number(process.env.KLAURO_FABRIC_PORT || 8788);
const server = createRemoteAnalyzerHttpServer({ coordinationOnly: true });

server.listen(port, () => {
  process.stdout.write(`Klauro Fabric listening on http://0.0.0.0:${port}\n`);
});

function shutdown(): void {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
