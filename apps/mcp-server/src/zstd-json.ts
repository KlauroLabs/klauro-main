import { spawn } from 'child_process';
import { stat } from 'node:fs/promises';
import { parserStream } from 'stream-json';
import Assembler from 'stream-json/assembler.js';

const DEFAULT_BUFFERED_COMPRESSED_BYTES = 32 * 1024 * 1024;

export async function readZstdJson(
  filePath: string,
  options: { maxBufferedCompressedBytes?: number } = {}
): Promise<any> {
  const maxBufferedCompressedBytes = options.maxBufferedCompressedBytes ?? DEFAULT_BUFFERED_COMPRESSED_BYTES;
  const fileSize = (await stat(filePath)).size;
  return fileSize <= maxBufferedCompressedBytes
    ? readZstdJsonBuffered(filePath)
    : readZstdJsonStreaming(filePath);
}

async function readZstdJsonBuffered(filePath: string): Promise<any> {
  const child = spawn('zstd', ['-q', '-d', '-c', filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks: Buffer[] = [];
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000);
  });
  const exit = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code ?? 1));
  });
  try {
    for await (const chunk of child.stdout) chunks.push(Buffer.from(chunk));
  } catch (error) {
    child.kill('SIGTERM');
    await exit.catch(() => undefined);
    throw error;
  }
  const code = await exit;
  if (code !== 0) throw new Error(`zstd could not decompress ${filePath}: ${stderr || `exit ${code}`}`);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function readZstdJsonStreaming(filePath: string): Promise<any> {
  const child = spawn('zstd', ['-q', '-d', '-c', filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
  const tokens = child.stdout.pipe(parserStream());
  const assembler = new Assembler<any>();
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000);
  });
  const exit = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code ?? 1));
  });
  try {
    for await (const token of tokens) assembler.consume(token);
  } catch (error) {
    child.kill('SIGTERM');
    await exit.catch(() => undefined);
    throw error;
  }
  const code = await exit;
  if (code !== 0) throw new Error(`zstd could not decompress ${filePath}: ${stderr || `exit ${code}`}`);
  if (!assembler.done || assembler.current === null) throw new Error(`zstd produced incomplete JSON for ${filePath}`);
  return assembler.current;
}
