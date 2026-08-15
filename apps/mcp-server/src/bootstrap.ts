import * as fs from 'fs';
import * as path from 'path';
import { PassThrough } from 'stream';

interface ProfileHandshake {
  initialize: {
    protocolVersion: string;
    capabilities: unknown;
    serverInfo: unknown;
    instructions?: string;
  };
  methods: Record<string, { result?: unknown; error?: unknown }>;
}

type HandshakeCapture = Record<string, ProfileHandshake>;

const handshake: HandshakeCapture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'handshake.json'), 'utf8')
);
const profile = process.env.KLAURO_TOOL_PROFILE === 'core' ? 'core' : 'full';
const profileHandshake = handshake[profile];

const answeredIds = new Set<string>();
const queuedLines: string[] = [];
let serverInput: PassThrough | null = null;
let stdinBuffer = '';

process.stdin.on('data', chunk => {
  stdinBuffer += chunk.toString();
  let newlineIndex;
  while ((newlineIndex = stdinBuffer.indexOf('\n')) >= 0) {
    const rawLine = stdinBuffer.slice(0, newlineIndex + 1);
    stdinBuffer = stdinBuffer.slice(newlineIndex + 1);
    handleClientLine(rawLine);
  }
});
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGHUP', () => process.exit(0));

function handleClientLine(rawLine: string): void {
  if (serverInput) {
    serverInput.write(rawLine);
    return;
  }
  queuedLines.push(rawLine);
  const trimmed = rawLine.trim();
  if (!trimmed) return;
  let message: { id?: unknown; method?: string; params?: { protocolVersion?: unknown } };
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (message.id === undefined || typeof message.method !== 'string') return;
  if (message.method === 'initialize') {
    const requested = message.params?.protocolVersion;
    const protocolVersion = typeof requested === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(requested)
      ? requested
      : profileHandshake.initialize.protocolVersion;
    answerForServer(message.id, { result: { ...profileHandshake.initialize, protocolVersion } });
    scheduleRealServerStart(250);
  } else if (profileHandshake.methods[message.method]) {
    answerForServer(message.id, profileHandshake.methods[message.method]);
  }
}

function answerForServer(id: unknown, payload: { result?: unknown; error?: unknown }): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...payload })}\n`);
  answeredIds.add(JSON.stringify(id));
}

function forwardServerLine(rawLine: string): void {
  const trimmed = rawLine.trim();
  if (trimmed) {
    try {
      const message = JSON.parse(trimmed);
      if (message.id !== undefined && message.method === undefined
        && answeredIds.delete(JSON.stringify(message.id))) {
        return;
      }
    } catch {

    }
  }
  process.stdout.write(rawLine);
}

async function startRealServer(): Promise<void> {
  process.env.KLAURO_DEFER_START = '1';
  const serverModule = require('./server.cjs') as {
    startServer: (input: NodeJS.ReadableStream, output: NodeJS.WritableStream) => Promise<void>;
  };
  const input = new PassThrough();
  const output = new PassThrough();
  let outputBuffer = '';
  output.on('data', chunk => {
    outputBuffer += chunk.toString();
    let newlineIndex;
    while ((newlineIndex = outputBuffer.indexOf('\n')) >= 0) {
      const rawLine = outputBuffer.slice(0, newlineIndex + 1);
      outputBuffer = outputBuffer.slice(newlineIndex + 1);
      forwardServerLine(rawLine);
    }
  });
  await serverModule.startServer(input, output);
  for (const rawLine of queuedLines) input.write(rawLine);
  queuedLines.length = 0;
  serverInput = input;
}

let realServerStarted = false;

function scheduleRealServerStart(delayMs: number): void {
  if (realServerStarted) return;
  realServerStarted = true;
  setTimeout(() => {
    startRealServer().catch(error => {
      process.stderr.write(`Klauro MCP server failed to start: ${error instanceof Error ? error.stack || error.message : error}\n`);
      process.exit(1);
    });
  }, delayMs);
}

setTimeout(() => scheduleRealServerStart(0), 300);
