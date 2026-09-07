import * as net from 'node:net';
import { workerChannel } from './analysis-worker-channel';

const socketPath = process.env.KLAURO_ANALYSIS_WORKER_SOCKET;
if (!process.send || !socketPath) throw new Error('Analysis worker proxy requires IPC and a private worker socket.');
const socket = net.createConnection(socketPath);
let finished = false;
let receivedTerminal = false;
const terminate = (error?: Error): void => {
  if (finished) return;
  finished = true;
  if (error) process.stderr.write(`Analysis worker connection failed: ${error.message}\n`);
  socket.destroy();
  process.exitCode = error ? 1 : 0;
  if (process.connected) process.disconnect();
};
const connectionTimer = setTimeout(() => terminate(new Error('Worker socket connection timed out.')), 10_000);
socket.once('connect', () => clearTimeout(connectionTimer));
socket.once('close', () => {
  clearTimeout(connectionTimer);
  terminate(receivedTerminal ? undefined : new Error('Worker service disconnected.'));
});
const channel = workerChannel(socket, message => {
  if (message?.type === 'output') {
    if (!process.stderr.write(String(message.text))) {
      socket.pause(); process.stderr.once('drain', () => socket.resume());
    }
  } else if (message?.type === 'worker-exit') {
    terminate(new Error(`Worker service reported exit ${message.code ?? message.signal ?? 'unknown'}.`));
  } else {
    if (message?.type === 'result' || message?.type === 'error') receivedTerminal = true;
    if (!process.send!(message, error => {
      if (error) terminate(error);
      else socket.resume();
    })) socket.pause();
  }
}, terminate);
process.on('message', message => {
  try { channel.send(message); } catch (error) { terminate(error as Error); }
});
process.on('disconnect', () => terminate());
