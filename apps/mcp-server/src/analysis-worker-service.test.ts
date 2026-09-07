import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { once } from 'node:events';
import { startAnalysisWorkerService } from './analysis-worker-service';
import { WORKER_FRAME_MAX_BYTES, workerChannel } from './analysis-worker-channel';
import { runAnalysis, runLayeredAnalysis, shutdownAnalysisWorker } from './analyzer';

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-worker-service-'));
}

test('private service rejects occupied non-socket files without removing them', async () => {
  const root = workspace();
  const socket = path.join(root, 'worker.sock');
  fs.writeFileSync(socket, 'preserve');
  await assert.rejects(startAnalysisWorkerService(socket), /non-socket/);
  assert.equal(fs.readFileSync(socket, 'utf8'), 'preserve');
  fs.rmSync(root, { recursive: true, force: true });
});

test('private service refuses to replace a live owner', async () => {
  const root = workspace();
  const socket = path.join(root, 'worker.sock');
  const server = await startAnalysisWorkerService(socket);
  try {
    await assert.rejects(startAnalysisWorkerService(socket), /already owns/);
    assert.equal(fs.statSync(socket).mode & 0o777, 0o600);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('channel refuses an oversized unterminated frame without unbounded accumulation', async () => {
  const root = workspace();
  let refused!: (error: Error) => void;
  const failure = new Promise<Error>(resolve => { refused = resolve; });
  const server = net.createServer(socket => workerChannel(socket, () => assert.fail('oversized frame delivered'), refused));
  server.listen(path.join(root, 'worker.sock'));
  await once(server, 'listening');
  const client = net.createConnection(path.join(root, 'worker.sock'));
  client.on('error', () => undefined);
  client.write(Buffer.alloc(WORKER_FRAME_MAX_BYTES + 1, 120));
  assert.match((await failure).message, /memory bound/);
  client.destroy();
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});

test('disconnect terminates the owned worker group and a second client cannot overlap it', { timeout: 15_000 }, async () => {
  const root = workspace();
  const socketPath = path.join(root, 'worker.sock');
  const entry = path.join(root, 'lifecycle-fixture.cjs');
  fs.writeFileSync(entry, [
    'process.on("disconnect", () => process.exit(0));',
    'process.on("message", request => process.send({ type: "progress", id: request.id, pid: process.pid, sequence: 1, phase: "ready" }));',
  ].join('\n'));
  const server = await startAnalysisWorkerService(socketPath, entry);
  const clients: net.Socket[] = [];
  const connect = (id: number) => {
    const socket = net.createConnection(socketPath);
    clients.push(socket);
    let resolve!: (message: any) => void;
    let reject!: (error: Error) => void;
    const received = new Promise<any>((done, fail) => { resolve = done; reject = fail; });
    const channel = workerChannel(socket, resolve, reject);
    channel.send({ type: 'analyze', id, projectPath: root, forceFull: true, env: { KLAURO_ANALYSIS_HEAP_MB: '256' } });
    return { socket, received };
  };
  const waitForExit = async (pid: number): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { process.kill(pid, 0); } catch (error) {
        assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH');
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('worker survived its client disconnect');
  };
  try {
    const first = connect(1);
    const started = await first.received;
    assert.equal(started.type, 'progress');
    const second = connect(2);
    assert.match((await second.received).message, /busy/);
    first.socket.destroy();
    await waitForExit(started.pid);
    const third = connect(3);
    const restarted = await third.received;
    assert.equal(restarted.type, 'progress');
    assert.notEqual(restarted.pid, started.pid);
    third.socket.destroy();
    await waitForExit(restarted.pid);
  } finally {
    for (const client of clients) client.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('service-backed analysis recovers after a worker crash and preserves layered results', { timeout: 60_000 }, async () => {
  const root = workspace();
  const socketPath = path.join(root, 'worker.sock');
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'worker-service-fixture', main: 'index.js' }));
  fs.writeFileSync(path.join(project, 'index.js'), 'exports.greet = function greet(name) { return "Hello " + name; };');
  const keys = ['KLAURO_ANALYSIS_WORKER_SOCKET', 'KLAURO_ANALYSIS_HEAP_MB', 'KLAURO_STORAGE_PATH', 'KLAURO_LOG_DIR',
    'KLAURO_EMBEDDING_ENABLED', 'KLAURO_AI_INTERPRETATION', 'KLAURO_AI_ELEMENT_DESCRIPTIONS',
    'KLAURO_TEST_ANALYSIS_WORKER_CRASH', 'KLAURO_ANALYSIS_IN_PROCESS'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    KLAURO_ANALYSIS_WORKER_SOCKET: socketPath,
    KLAURO_ANALYSIS_HEAP_MB: '512',
    KLAURO_STORAGE_PATH: path.join(root, 'storage'),
    KLAURO_LOG_DIR: path.join(root, 'logs'),
    KLAURO_EMBEDDING_ENABLED: 'false',
    KLAURO_AI_INTERPRETATION: 'false',
    KLAURO_AI_ELEMENT_DESCRIPTIONS: 'false',
  });
  delete process.env.KLAURO_ANALYSIS_IN_PROCESS;
  const server = await startAnalysisWorkerService(socketPath);
  try {
    process.env.KLAURO_TEST_ANALYSIS_WORKER_CRASH = 'sigkill';
    await assert.rejects(runAnalysis(project, { forceFull: true }), /Analysis worker/);
    delete process.env.KLAURO_TEST_ANALYSIS_WORKER_CRASH;
    const first = await runAnalysis(project, { forceFull: true });
    assert.ok(first.nodes > 0);
    const second = await runAnalysis(project, { forceFull: true });
    assert.equal(second.nodes, first.nodes);
    const phases: string[] = [];
    const statuses: string[] = [];
    const layered = await runLayeredAnalysis(project, {
      analysisFocus: 'full',
      onPhase: phase => { phases.push(phase.phase); statuses.push(phase.status); },
    });
    assert.equal(layered.nodes, first.nodes);
    assert.deepEqual(phases, ['l0', 'rest', 'enrichment']);
    assert.deepEqual(statuses, ['succeeded', 'succeeded', 'failed']);
  } finally {
    shutdownAnalysisWorker();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('malformed requests close their connection without claiming the service', async () => {
  const root = workspace();
  const socketPath = path.join(root, 'worker.sock');
  const server = await startAnalysisWorkerService(socketPath);
  const client = net.createConnection(socketPath);
  client.on('error', () => undefined);
  client.write(JSON.stringify({ type: 'analyze', id: 1, projectPath: '/tmp', env: { NODE_OPTIONS: 'unsafe' } }) + '\n');
  await once(client, 'close');
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});
