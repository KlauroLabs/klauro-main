import { fork, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { analysisWorkerExecArgv, resolveAnalysisWorkerEntry, workerChannel } from './analysis-worker-channel';
import { resolveAnalysisHeapMb } from './analysis-heap';
import { assertAnalysisWorkerMemoryAvailable } from './analysis-memory';

async function removeStaleSocket(socketPath: string): Promise<void> {
  if (!fs.existsSync(socketPath)) return;
  if (!fs.lstatSync(socketPath).isSocket()) throw new Error('Worker socket path is occupied by a non-socket file.');
  await new Promise<void>((resolve, reject) => {
    const probe = net.createConnection(socketPath);
    probe.once('connect', () => { probe.destroy(); reject(new Error('An analysis worker service already owns this socket.')); });
    probe.once('error', error => {
      if ((error as NodeJS.ErrnoException).code !== 'ECONNREFUSED') { reject(error); return; }
      fs.unlinkSync(socketPath);
      resolve();
    });
    probe.setTimeout(1000, () => { probe.destroy(); reject(new Error('Existing worker socket did not respond.')); });
  });
}

function terminateWorker(child?: ChildProcess): void {
  if (!child) return;
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL');
  }
}

export interface AnalysisWorkerService extends net.Server {
  shutdown(): Promise<void>;
}

export async function startAnalysisWorkerService(
  socketPath: string,
  workerEntry: string = resolveAnalysisWorkerEntry('analysis-worker'),
): Promise<AnalysisWorkerService> {
  if (!path.isAbsolute(socketPath)) throw new Error('Analysis worker socket must be an absolute private path.');
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  await removeStaleSocket(socketPath);
  let active: net.Socket | undefined;
  let activeChild: ChildProcess | undefined;
  const sockets = new Set<net.Socket>();
  const workers = new Map<ChildProcess, Promise<void>>();
  let stopping = false;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    const closed = new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      });
    });
    for (const socket of sockets) socket.destroy();
    for (const child of workers.keys()) terminateWorker(child);
    shutdownPromise = Promise.all([closed, ...workers.values()]).then(() => undefined);
    return shutdownPromise;
  };
  const server = net.createServer(socket => {
    if (stopping) { socket.destroy(); return; }
    sockets.add(socket);
    let child: ChildProcess | undefined;
    let requestId: number | undefined;
    let terminalMessage: unknown;
    const idleTimer = setTimeout(() => socket.destroy(), 10_000);
    const cleanup = (): void => {
      clearTimeout(idleTimer);
      sockets.delete(socket);
      if (child && workers.has(child)) {
        terminateWorker(child);
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      if (active === socket && !child) active = undefined;
    };
    socket.once('close', cleanup);
    const channel = workerChannel(socket, request => {
      if (stopping) throw new Error('Analysis worker service is shutting down.');
      if (requestId !== undefined) throw new Error('Worker service accepts one job per connection.');
      if (!request || !['analyze', 'layered'].includes(request.type) || !Number.isSafeInteger(request.id)
        || typeof request.projectPath !== 'string' || !path.isAbsolute(request.projectPath)
        || !request.env || typeof request.env !== 'object' || Array.isArray(request.env)
        || Object.entries(request.env).some(([key, value]) => !key.startsWith('KLAURO_') || typeof value !== 'string')) {
        throw new Error('Invalid analysis worker request.');
      }
      requestId = request.id;
      clearTimeout(idleTimer);
      if (active) {
        channel.send({ type: 'error', id: requestId, message: 'Analysis worker service is busy; retry after the current job finishes.' });
        socket.end();
        return;
      }
      active = socket;
      try {
        const heap = resolveAnalysisHeapMb({ ...process.env, ...request.env });
        assertAnalysisWorkerMemoryAvailable(heap.heapMb);
        child = fork(workerEntry, [], {
          execArgv: [...analysisWorkerExecArgv(process.execArgv), `--max-old-space-size=${heap.heapMb}`],
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          detached: process.platform !== 'win32',
          env: process.env,
        });
        activeChild = child;
        const ownedChild = child;
        workers.set(ownedChild, new Promise<void>(resolve => {
          ownedChild.once('close', () => {
            workers.delete(ownedChild);
            resolve();
          });
        }));
        const send = (message: unknown): void => {
          try { channel.send(message); } catch { socket.destroy(); }
        };
        for (const output of [child.stdout, child.stderr]) {
          output?.on('data', (chunk: Buffer) => {
            try {
              if (!channel.send({ type: 'output', text: chunk.toString('utf8') })) {
                output.pause();
                socket.once('drain', () => output.resume());
              }
            } catch { socket.destroy(); }
          });
        }
        child.on('message', (message: any) => {
          if (message?.id !== requestId) { socket.destroy(); return; }
          if (message.type === 'result' || message.type === 'error') {
            terminalMessage = message;
            if (child?.connected) child.disconnect();
            return;
          }
          send(message);
        });
        child.once('error', error => {
          if (active === socket) { active = undefined; activeChild = undefined; }
          terminalMessage = { type: 'error', id: requestId, message: error.message };
          send({ type: 'error', id: requestId, message: error.message });
          socket.end();
        });
        child.once('exit', (code, signal) => {
          terminateWorker(ownedChild);
          if (active === socket) { active = undefined; activeChild = undefined; }
          if (!socket.destroyed) {
            if (terminalMessage && code === 0 && signal === null) send(terminalMessage);
            else send({ type: 'worker-exit', code, signal });
          }
          socket.end();
        });
        child.send(request, error => {
          if (!error) return;
          send({ type: 'error', id: requestId, message: error.message });
          socket.destroy();
        });
      } catch (error) {
        active = undefined;
        channel.send({ type: 'error', id: requestId, message: error instanceof Error ? error.message : String(error) });
        socket.end();
      }
    }, () => socket.destroy());
  });
  server.on('close', () => {
    active?.destroy();
    terminateWorker(activeChild);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      fs.chmodSync(socketPath, 0o600);
      resolve();
    });
  });
  return Object.assign(server, { shutdown });
}

if (require.main === module) {
  const socketPath = process.env.KLAURO_ANALYSIS_WORKER_SOCKET;
  if (!socketPath) throw new Error('KLAURO_ANALYSIS_WORKER_SOCKET must name the private service socket.');
  startAnalysisWorkerService(socketPath).then(server => {
    const shutdown = (): void => {
      void server.shutdown().catch(error => {
        console.error(error);
        process.exitCode = 1;
      }).finally(() => {
        process.removeListener('SIGTERM', shutdown);
        process.removeListener('SIGINT', shutdown);
      });
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    process.stdout.write('Analysis worker service ready.\n');
  }).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
