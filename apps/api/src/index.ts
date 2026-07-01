import { createRemoteAnalyzerHttpServer } from '../../mcp-server/src/remote-analyzer-service.js';

const port = Number(process.env.PORT || process.env.KLAURO_API_PORT || process.env.KLAURO_ANALYZER_PORT || 8787);
const server = createRemoteAnalyzerHttpServer();

server.listen(port, () => {
  process.stdout.write(`Klauro API listening on http://0.0.0.0:${port}\n`);
});
