import { test } from 'node:test';
import { spawn } from 'node:child_process';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { once } from 'node:events';
import { startAnalysisWorkerService } from './analysis-worker-service';
import { WORKER_FRAME_MAX_BYTES, analysisWorkerExecArgv, workerChannel } from './analysis-worker-channel';
import { runAnalysis, runLayeredAnalysis, shutdownAnalysisWorker } from './analyzer';

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-worker-service-'));
}


async function waitForAnalysisChild(parentPid: number): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const children = fs.readFileSync('/proc/' + parentPid + '/task/' + parentPid + '/children', 'utf8').trim().split(/\s+/).filter(Boolean);
    for (const child of children) {
      try {
        const command = fs.readFileSync('/proc/' + child + '/cmdline', 'utf8');
        if (/[/\\]analysis-worker\.(ts|cjs)\x00/.test(command)) return Number(child);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Service did not spawn the analysis worker.');
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try { process.kill(pid, 0); } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('owned worker process survived cleanup: ' + pid);
}

test('service shutdown closes active and idle connections and reaps only its owned worker group', { timeout: 20_000 }, async () => {
  const root = workspace();
  const socketPath = path.join(root, 'worker.sock');
  const entry = path.join(root, 'shutdown-fixture.cjs');
  fs.writeFileSync(entry, [
    'const { spawn } = require("node:child_process");',
    'process.on("message", request => {',
    '  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    '  process.send({ type: "progress", id: request.id, pid: process.pid, descendant: descendant.pid, sequence: 1, phase: "ready" });',
    '});',
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const unrelatedExit = once(unrelated, 'exit');
  const server = await startAnalysisWorkerService(socketPath, entry);
  const active = net.createConnection(socketPath);
  const idle = net.createConnection(socketPath);
  const ready = new Promise<any>((resolve, reject) => {
    workerChannel(active, resolve, reject).send({
      type: 'analyze', id: 1, projectPath: root, env: { KLAURO_ANALYSIS_HEAP_MB: '256' },
    });
  });
  let started: any;
  try {
    await once(idle, 'connect');
    started = await ready;
    assert.equal(started.type, 'progress');
    assert.ok(started.pid && started.descendant);
    const activeClosed = once(active, 'close');
    const idleClosed = once(idle, 'close');
    const stopped = server.shutdown();
    assert.equal(server.shutdown(), stopped, 'shutdown is idempotent');
    await stopped;
    await Promise.all([activeClosed, idleClosed]);
    assert.equal(server.listening, false);
    await waitForProcessExit(started.pid);
    await waitForProcessExit(started.descendant);
    assert.doesNotThrow(() => process.kill(unrelated.pid!, 0));
    const replacement = await startAnalysisWorkerService(socketPath, entry);
    await replacement.shutdown();
  } finally {
    active.destroy();
    idle.destroy();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    if (started) {
      await waitForProcessExit(started.pid);
      await waitForProcessExit(started.descendant);
    }
    unrelated.kill('SIGKILL');
    await unrelatedExit;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('shutdown completes while worker output is paused behind a non-reading client', { timeout: 15_000 }, async () => {
  const root = workspace();
  const socketPath = path.join(root, 'worker.sock');
  const entry = path.join(root, 'output-fixture.cjs');
  fs.writeFileSync(entry, [
    'process.on("message", request => process.send({ type: "progress", id: request.id, pid: process.pid }, () => {',
    '  const block = Buffer.alloc(65536, 120);',
    '  const pump = () => { while (process.stdout.write(block)) {} process.stdout.once("drain", pump); };',
    '  pump();',
    '}));',
  ].join('\n'));
  const server = await startAnalysisWorkerService(socketPath, entry);
  let serviceSocket: net.Socket | undefined;
  server.on('connection', socket => { serviceSocket = socket; });
  const client = net.createConnection(socketPath);
  const ready = new Promise<any>((resolve, reject) => {
    workerChannel(client, message => { if (message.type === 'progress') resolve(message); }, reject).send({
      type: 'analyze', id: 1, projectPath: root, env: { KLAURO_ANALYSIS_HEAP_MB: '256' },
    });
  });
  let workerPid: number | undefined;
  try {
    workerPid = (await ready).pid;
    client.pause();
    for (let attempt = 0; attempt < 200 && !serviceSocket?.writableNeedDrain; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(serviceSocket?.writableNeedDrain, true, 'exercise actual output backpressure');
    await server.shutdown();
    await waitForProcessExit(workerPid!);
  } finally {
    client.destroy();
    await server.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  test('service entrypoint handles ' + signal + ' during an active socket job', { timeout: 20_000, skip: process.platform !== 'linux' }, async () => {
    const root = workspace();
    const socketPath = path.join(root, 'worker.sock');
    const serviceEntry = process.env.KLAURO_TEST_HOSTED_BUNDLE === '1'
      ? path.join(__dirname, '..', 'dist-hosted', 'analysis-worker-service.cjs')
      : path.join(__dirname, 'analysis-worker-service.ts');
    const service = spawn(process.execPath, [...analysisWorkerExecArgv(process.execArgv), serviceEntry], {
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=512', KLAURO_ANALYSIS_WORKER_SOCKET: socketPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(service, 'exit');
    let diagnostics = '';
    service.stderr!.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-8192); });
    const ready = new Promise<void>((resolve, reject) => {
      let output = '';
      service.stdout!.on('data', chunk => {
        output += chunk.toString();
        if (output.includes('Analysis worker service ready.')) resolve();
      });
      service.once('error', reject);
      service.once('exit', () => reject(new Error('Service exited before readiness: ' + diagnostics)));
    });
    let workerPid: number | undefined;
    let client: net.Socket | undefined;
    try {
      await ready;
      client = net.createConnection(socketPath);
      client.on('error', () => undefined);
      workerChannel(client, () => undefined, () => undefined).send({
        type: 'layered', id: 1, projectPath: root,
        env: { KLAURO_ANALYSIS_HEAP_MB: '512', KLAURO_TEST_ANALYSIS_WORKER_STALL: 'before-start' },
      });
      workerPid = await waitForAnalysisChild(service.pid!);
      assert.doesNotThrow(() => process.kill(workerPid!, 0));
      const clientClosed = once(client, 'close');
      assert.equal(service.kill(signal), true);
      assert.deepEqual(await exited, [0, null], diagnostics);
      await clientClosed;
      await waitForProcessExit(workerPid);
      assert.equal(fs.existsSync(socketPath), false);
    } finally {
      client?.destroy();
      if (service.exitCode === null && service.signalCode === null) service.kill('SIGKILL');
      await exited;
      if (workerPid) {
        try { process.kill(-workerPid, 'SIGKILL'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
        await waitForProcessExit(workerPid);
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
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

test('service-backed analysis recovers after a worker crash and preserves layered results', { timeout: 60_000 }, async t => {
  const root = workspace();
  const socketPath = path.join(root, 'worker.sock');
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'worker-service-fixture', main: 'index.js' }));
  fs.writeFileSync(path.join(project, 'index.js'), 'exports.greet = function greet(name) { return "Hello " + name; };');
  const keys = ['KLAURO_ANALYSIS_WORKER_SOCKET', 'KLAURO_ANALYSIS_HEAP_MB', 'KLAURO_STORAGE_PATH', 'KLAURO_LOG_DIR',
    'KLAURO_EMBEDDING_ENABLED', 'KLAURO_AI_INTERPRETATION', 'KLAURO_AI_ELEMENT_DESCRIPTIONS',
    'KLAURO_TEST_ANALYSIS_WORKER_CRASH', 'KLAURO_ANALYSIS_IN_PROCESS',
    'KLAURO_TEST_ANALYSIS_WORKER_STALL', 'KLAURO_ANALYSIS_STALL_MS'];
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
    await t.test('a silent socket-backed worker times out and is reaped', { skip: process.platform !== 'linux' }, async () => {
      process.env.KLAURO_ANALYSIS_STALL_MS = '2000';
      process.env.KLAURO_TEST_ANALYSIS_WORKER_STALL = 'before-start';
      const stalled = assert.rejects(runLayeredAnalysis(project, { forceFullRebuild: true }), /analysis-stalled/);
      const silentWorker = await waitForAnalysisChild(process.pid);
      await stalled;
      await waitForProcessExit(silentWorker);
      delete process.env.KLAURO_TEST_ANALYSIS_WORKER_STALL;
      delete process.env.KLAURO_ANALYSIS_STALL_MS;
    });
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
    assert.deepEqual(phases, ['l0', 'rest']);
    assert.deepEqual(statuses, ['succeeded', 'succeeded']);
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
