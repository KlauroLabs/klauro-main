import * as crypto from 'crypto';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as zlib from 'zlib';
import { execFile, spawn, spawnSync } from 'child_process';
import type { Writable } from 'stream';
import { finished, pipeline } from 'stream/promises';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const brotliCompressAsync = promisify(zlib.brotliCompress);
const STREAM_WRITE_BUFFER_CHARS = 1024 * 1024;
export type JsonStorageCodec = 'none' | 'brotli' | 'zstd';

function atomicTempPath(filePath: string, suffix: string): string {
  return `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(8).toString('hex')}.${suffix}`;
}

export async function writeJsonAtomic(filePath: string, value: unknown, options: { spaces?: number } = { spaces: 2 }): Promise<void> {
  await fs.ensureDir(path.dirname(filePath));
  const tmpPath = atomicTempPath(filePath, 'tmp');
  try {
    try {
      if (shouldStreamJson(value, options.spaces)) await writeJsonStreamed(tmpPath, value, options.spaces);
      else await fs.writeJson(tmpPath, value, options);
    } catch (error) {
      if (!isJsonStringTooLargeError(error)) throw error;
      await writeJsonStreamed(tmpPath, value, options.spaces);
    }
    await fs.move(tmpPath, filePath, { overwrite: true });
  } catch (error) {
    await fs.remove(tmpPath).catch(() => undefined);
    throw error;
  }
}

export async function writeCompressedJsonAtomic(filePath: string, value: unknown, options: { spaces?: number } = { spaces: 0 }): Promise<void> {
  const codec = compressionCodecForPath(filePath);
  if (codec === 'none') {
    await writeJsonAtomic(filePath, value, options);
    return;
  }

  await fs.ensureDir(path.dirname(filePath));
  const compressedTmpPath = atomicTempPath(filePath, 'compressed.tmp');
  try {
    await writeCompressedJsonStreamed(compressedTmpPath, value, codec, options.spaces);
    await fs.move(compressedTmpPath, filePath, { overwrite: true });
  } finally {
    await fs.remove(compressedTmpPath).catch(() => undefined);
  }
}

export async function compressLegacyJsonArtifact(basePath: string): Promise<void> {
  const extension = compressedJsonExtension();
  if (!extension || !(await fs.pathExists(basePath))) return;
  const targetPath = `${basePath}${extension}`;
  if (await fs.pathExists(targetPath)) return;
  const tmpPath = atomicTempPath(targetPath, 'tmp');
  try {
    await compressJsonFile(basePath, tmpPath, compressionCodecForPath(targetPath));
    await fs.move(tmpPath, targetPath, { overwrite: false });
    await fs.remove(basePath);
  } finally {
    await fs.remove(tmpPath).catch(() => undefined);
  }
}

export function compressedJsonExtension(): '' | '.zst' | '.br' {
  const codec = selectedAnalysisCompressionCodec();
  if (codec === 'zstd') return '.zst';
  if (codec === 'brotli') return '.br';
  return '';
}

export function compressionCodecForPath(filePath: string): JsonStorageCodec {
  if (filePath.endsWith('.json.zst')) return 'zstd';
  if (filePath.endsWith('.json.br')) return 'brotli';
  return 'none';
}

function selectedAnalysisCompressionCodec(): JsonStorageCodec {
  const requested = String(process.env.KLAURO_ANALYSIS_COMPRESSION || 'auto').toLowerCase();
  if (requested === 'none' || requested === 'off' || requested === 'false') return 'none';
  if (requested === 'brotli' || requested === 'br') return 'brotli';
  if (requested === 'zstd' || requested === 'zst') return hasZstdCommand() ? 'zstd' : 'brotli';
  return hasZstdCommand() ? 'zstd' : 'brotli';
}

let zstdCommandAvailable: boolean | undefined;

function hasZstdCommand(): boolean {
  if (zstdCommandAvailable !== undefined) return zstdCommandAvailable;
  const result = spawnSync('zstd', ['--version'], { stdio: 'ignore' });
  zstdCommandAvailable = result.status === 0;
  return zstdCommandAvailable;
}

async function compressJsonFile(sourcePath: string, targetPath: string, codec: JsonStorageCodec): Promise<void> {
  if (codec === 'zstd') {
    await execFileAsync('zstd', ['-q', '-3', '-T1', '-f', sourcePath, '-o', targetPath], {
      maxBuffer: 1024 * 1024,
    });
    return;
  }
  if (codec === 'brotli') {
    const json = await fs.readFile(sourcePath);
    const compressed = await brotliCompressAsync(json, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 6,
      },
    });
    await fs.writeFile(targetPath, compressed);
    return;
  }
  await fs.copy(sourcePath, targetPath, { overwrite: true });
}

function shouldStreamJson(value: unknown, spaces?: number): boolean {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as {
    nodes?: unknown[];
    edges?: unknown[];
    domain_concepts?: unknown[];
    method_calls?: unknown[];
    analysis_facts?: unknown[];
    test_gaps?: unknown[];
  };
  const graphItems =
    (candidate.nodes?.length || 0) +
    (candidate.edges?.length || 0) +
    (candidate.domain_concepts?.length || 0) +
    (candidate.method_calls?.length || 0) +
    (candidate.analysis_facts?.length || 0) +
    (candidate.test_gaps?.length || 0);
  return graphItems > (spaces === 0 ? 10_000 : 100_000);
}

function isJsonStringTooLargeError(error: unknown): boolean {
  return error instanceof RangeError && /invalid string length/i.test(error.message);
}

async function writeJsonStreamed(filePath: string, value: unknown, spaces = 0): Promise<void> {
  const stream = fs.createWriteStream(filePath, { encoding: 'utf8' });
  const completion = finished(stream, { cleanup: true });
  try {
    await writeJsonToStream(stream, value, spaces);
    stream.end();
    await completion;
  } catch (error) {
    stream.destroy();
    await completion.catch(() => undefined);
    throw error;
  }
}

async function writeCompressedJsonStreamed(filePath: string, value: unknown, codec: Exclude<JsonStorageCodec, 'none'>, spaces = 0): Promise<void> {
  if (codec === 'zstd') {
    const child = spawn('zstd', ['-q', '-3', '-T1', '-f', '-o', filePath]);
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    child.stderr.on('data', chunk => {
      if (stderrBytes >= 1024 * 1024) return;
      const bytes = chunk as Buffer;
      stderr.push(bytes);
      stderrBytes += bytes.length;
    });
    const exited = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0
        ? resolve()
        : reject(new Error(`zstd exited with ${signal ? `signal ${signal}` : `code ${code}`}: ${Buffer.concat(stderr).toString('utf8').trim()}`)));
    });
    child.stdin.on('error', () => undefined);
    try {
      await writeJsonToStream(child.stdin, value, spaces);
      child.stdin.end();
      await Promise.all([finished(child.stdin, { cleanup: true }), exited]);
    } catch (error) {
      child.stdin.destroy();
      child.kill('SIGTERM');
      await exited.catch(() => undefined);
      throw error;
    }
    return;
  }
  const output = fs.createWriteStream(filePath);
  const compressor = zlib.createBrotliCompress({
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 },
  });
  const compressed = pipeline(compressor, output);
  void compressed.catch(() => undefined);
  try {
    await writeJsonToStream(compressor, value, spaces);
    compressor.end();
    await compressed;
  } catch (error) {
    compressor.destroy();
    output.destroy();
    await compressed.catch(() => undefined);
    throw error;
  }
}

async function writeJsonToStream(stream: Writable, value: unknown, spaces = 0): Promise<void> {
  let bufferedChunks: string[] = [];
  let bufferedCharacters = 0;
  const flush = async (): Promise<void> => {
    if (bufferedCharacters === 0) return;
    const chunk = bufferedChunks.length === 1 ? bufferedChunks[0] : bufferedChunks.join('');
    bufferedChunks = [];
    bufferedCharacters = 0;
    if (stream.write(chunk)) return undefined;
    await new Promise<void>((resolve, reject) => {
      const onDrain = () => {
        stream.off('error', onError);
        resolve();
      };
      const onError = (error: Error) => {
        stream.off('drain', onDrain);
        reject(error);
      };
      stream.once('drain', onDrain);
      stream.once('error', onError);
    });
  };
  const write = async (chunk: string): Promise<void> => {
    bufferedChunks.push(chunk);
    bufferedCharacters += chunk.length;
    if (bufferedCharacters >= STREAM_WRITE_BUFFER_CHARS) await flush();
  };

  const indent = ' '.repeat(Math.min(10, Math.max(0, Math.trunc(spaces))));
  const pretty = indent.length > 0;
  const newline = async (depth: number): Promise<void> => write(`\n${indent.repeat(depth)}`);
  const ancestors = new Set<object>();
  const normalize = (current: unknown, key: string): unknown => current !== null
    && typeof current === 'object'
    && typeof (current as { toJSON?: unknown }).toJSON === 'function'
    ? (current as { toJSON: (key: string) => unknown }).toJSON(key)
    : current;
  const unsupported = (current: unknown): boolean => current === undefined
    || typeof current === 'function'
    || typeof current === 'symbol';
  const writeValue = async (input: unknown, key: string, depth: number, arrayElement = false, normalized = false): Promise<void> => {
    const current = normalized ? input : normalize(input, key);
    if (unsupported(current)) {
      if (arrayElement) {
        await write('null');
        return;
      }
      throw new TypeError('Value is not JSON serializable');
    }
    if (current === null || typeof current !== 'object') {
      const serialized = JSON.stringify(current);
      if (serialized === undefined) throw new TypeError('Value is not JSON serializable');
      await write(serialized);
      return;
    }
    if (current instanceof Number || current instanceof String || current instanceof Boolean) {
      await write(JSON.stringify(current));
      return;
    }
    if (ancestors.has(current as object)) throw new TypeError('Converting circular structure to JSON');
    ancestors.add(current as object);
    if (Array.isArray(current)) {
      await write('[');
      for (let index = 0; index < current.length; index++) {
        if (index > 0) await write(',');
        if (pretty) await newline(depth + 1);
        await writeValue(current[index], String(index), depth + 1, true);
      }
      if (pretty && current.length > 0) await newline(depth);
      await write(']');
      ancestors.delete(current);
      return;
    }
    await write('{');
    let first = true;
    for (const [key, rawChild] of Object.entries(current as Record<string, unknown>)) {
      const child = normalize(rawChild, key);
      if (unsupported(child)) continue;
      if (!first) await write(',');
      if (pretty) await newline(depth + 1);
      first = false;
      await write(JSON.stringify(key));
      await write(pretty ? ': ' : ':');
      await writeValue(child, key, depth + 1, false, true);
    }
    if (pretty && !first) await newline(depth);
    await write('}');
    ancestors.delete(current as object);
  };

  await writeValue(value, '', 0);
  await write('\n');
  await flush();
}
