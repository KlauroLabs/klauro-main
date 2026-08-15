import { spawn, spawnSync } from 'node:child_process';
import type { Readable } from 'node:stream';
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
  const assembler = new Assembler<T>();
  for await (const token of decoded.stream.pipe(parserStream())) assembler.consume(token);
  await decoded.completion;
  if (!assembler.done || assembler.current === null) throw new Error('CAS export contained incomplete JSON');
  return assembler.current;
}

function streamZstdDecompression(source: Readable): { stream: NodeJS.ReadableStream; completion: Promise<void> } {
  const nativeDecoder = (zlib as ZstdCapableZlib).createZstdDecompress;
  if (nativeDecoder) {
    const decoder = nativeDecoder();
    source.pipe(decoder);
    return { stream: decoder, completion: Promise.resolve() };
  }

  const child = spawn('zstd', ['-q', '-d', '-c'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000);
  });
  source.pipe(child.stdin);
  const completion = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0
      ? resolve()
      : reject(new Error(`zstd could not decode CAS export: ${stderr || `exit ${code ?? 1}`}`)));
  });
  return { stream: child.stdout, completion };
}
