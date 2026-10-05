import { spawn, execFile } from 'child_process';
import path from 'path';

const ENGINE_BIN = path.join(__dirname, '..', '..', 'native', 'index-engine', 'target', 'release', 'engine-core');
const WORKER_SCRIPT = path.resolve('workers/payments/run.js');
const UNRELATED = path.join(__dirname, 'assets', 'logo.png');

export function startEngine() {
  return spawn(ENGINE_BIN, ['--stream']);
}

export function startWorker() {
  return execFile('node', [WORKER_SCRIPT]);
}

export function openLogo() {
  return spawn('open', [UNRELATED]);
}
