import { spawn, spawnSync } from 'node:child_process';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as zlib from 'node:zlib';
import { parserStream } from 'stream-json';
import Assembler from 'stream-json/assembler.js';

type ZstdCapableZlib = typeof zlib & {
  zstdDecompressSync?: (buffer: NodeJS.ArrayBufferView) => Buffer;
  createZstdDecompress?: () => NodeJS.ReadWriteStream;
};

export function decodeCasExport(raw: Buffer, codec: string): Buffer | null {
  if (codec !== 'zstd') return raw;

  const nativeDecoder = (zlib as ZstdCapableZlib).zstdDecompressSync;
  if (nativeDecoder) return Buffer.from(nativeDecoder(raw));

  const decoded = spawnSync('zstd', ['-q', '-d', '-c'], {
    input: raw,
    maxBuffer: 1024 * 1024 * 1024,
  });
  return decoded.status === 0 ? decoded.stdout : null;
}

export async function decodeCasExportStream<T>(source: Readable, codec: string): Promise<T> {
  const decoded = codec === 'zstd' ? streamZstdDecompression(source) : { stream: source, completion: Promise.resolve() };
  const completion = decoded.completion.then<unknown>(() => undefined, error => error);
  const assembler = new Assembler<T>();
  const parser = parserStream();
  const forwardDecoderError = (error: Error): void => {
    parser.destroy(error);
  };
  decoded.stream.once('error', forwardDecoderError);
  try {
    for await (const token of decoded.stream.pipe(parser)) assembler.consume(token);
  } catch (error) {
    const transportError = await completion;
    throw transportError || error;
  } finally {
    decoded.stream.off('error', forwardDecoderError);
  }
  const transportError = await completion;
  if (transportError) throw transportError;
  if (!assembler.done || assembler.current === null) throw new Error('CAS export contained incomplete JSON');
  return assembler.current;
}

function streamZstdDecompression(source: Readable): { stream: NodeJS.ReadableStream; completion: Promise<void> } {
  const nativeDecoder = (zlib as ZstdCapableZlib).createZstdDecompress;
  if (nativeDecoder) {
    const decoder = nativeDecoder();
    return { stream: decoder, completion: pipeline(source, decoder) };
  }

  const child = spawn('zstd', ['-q', '-d', '-c'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000);
  });
  const processCompletion = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0
      ? resolve()
      : reject(new Error(`zstd could not decode CAS export: ${stderr || `exit ${code ?? 1}`}`)));
  });
  const completion = Promise.all([pipeline(source, child.stdin), processCompletion])
    .then(() => undefined)
    .catch(error => {
      child.kill();
      throw error;
    });
  return { stream: child.stdout, completion };
}
