import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Socket } from 'node:net';

export const WORKER_FRAME_MAX_BYTES = 8 * 1024 * 1024;

export function analysisWorkerExecArgv(execArgv: readonly string[]): string[] {
  const safe: string[] = [];
  for (let index = 0; index < execArgv.length; index++) {
    const argument = execArgv[index];
    if (['-e', '--eval', '-p', '--print', '--max-old-space-size', '--max_old_space_size'].includes(argument)) {
      index++;
      continue;
    }
    if (['--eval=', '--print=', '--max-old-space-size=', '--max_old_space_size='].some(prefix => argument.startsWith(prefix))) continue;
    safe.push(argument);
  }
  return safe;
}

export function resolveAnalysisWorkerEntry(name: 'analysis-worker' | 'analysis-worker-proxy'): string {
  for (const extension of ['cjs', 'ts']) {
    const file = path.join(__dirname, `${name}.${extension}`);
    if (fs.existsSync(file)) return file;
  }
  throw new Error(`${name} entry not found next to ${__dirname}; rebuild the hosted bundle.`);
}

export function workerChannel(
  socket: Socket,
  receive: (message: any) => void,
  fail: (error: Error) => void,
): { send: (message: unknown) => boolean } {
  let pending = Buffer.alloc(0);
  let failed = false;
  const failure = (error: unknown): void => {
    if (failed) return;
    failed = true;
    fail(error instanceof Error ? error : new Error(String(error)));
    socket.destroy();
  };
  socket.on('error', failure);
  socket.on('data', (chunk: Buffer) => {
    if (failed) return;
    try {
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        const fragment = chunk.subarray(offset, end);
        if (pending.length + fragment.length > WORKER_FRAME_MAX_BYTES) throw new Error('Analysis worker frame exceeds the memory bound.');
        pending = pending.length ? Buffer.concat([pending, fragment]) : Buffer.from(fragment);
        if (newline < 0) break;
        const frame = pending;
        pending = Buffer.alloc(0);
        receive(JSON.parse(frame.toString('utf8')));
        if (failed) return;
        offset = newline + 1;
      }
    } catch (error) {
      failure(error);
    }
  });
  return {
    send(message: unknown): boolean {
      if (failed || socket.destroyed) throw new Error('Analysis worker connection is closed.');
      const frame = JSON.stringify(message) + '\n';
      const bytes = Buffer.byteLength(frame);
      if (bytes > WORKER_FRAME_MAX_BYTES || socket.writableLength + bytes > WORKER_FRAME_MAX_BYTES) {
        throw new Error('Analysis worker channel exceeds the memory bound.');
      }
      return socket.write(frame);
    },
  };
}
