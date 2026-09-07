import * as crypto from 'crypto';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as zlib from 'zlib';
import { execFile, spawn, spawnSync } from 'child_process';
import { open } from 'node:fs/promises';
import { Writable } from 'stream';
import { finished, pipeline } from 'stream/promises';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const brotliCompressAsync = promisify(zlib.brotliCompress);
const STREAM_WRITE_BUFFER_CHARS = 1024 * 1024;
const ATOMIC_JSON_BYTE_BUDGET = 256 * 1024;
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
    await replaceFileAtomic(tmpPath, filePath);
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
    await replaceFileAtomic(compressedTmpPath, filePath);
  } finally {
    await fs.remove(compressedTmpPath).catch(() => undefined);
  }
}

export async function writeCompressedChunksAtomic(
  filePath: string,
  chunks: AsyncIterable<Buffer | string>,
): Promise<void> {
  const codec = compressionCodecForPath(filePath);
  await fs.ensureDir(path.dirname(filePath));
  const tmpPath = atomicTempPath(filePath, 'compressed.tmp');
  try {
    if (codec === 'none') {
      const output = fs.createWriteStream(tmpPath);
      const completion = finished(output, { cleanup: true });
      try {
        await writeChunksToStream(output, chunks);
        output.end();
        await completion;
      } catch (error) {
        output.destroy();
        await completion.catch(() => undefined);
        throw error;
      }
    } else {
      await writeCompressedSource(tmpPath, codec, stream => writeChunksToStream(stream, chunks));
    }
    await replaceFileAtomic(tmpPath, filePath);
  } finally {
    await fs.remove(tmpPath).catch(() => undefined);
  }
}

class JsonFieldTooLarge extends Error {}

const JSON_FIELD_CHUNK_ITEMS = 2_048;

type JsonStringify = (value: unknown) => string | undefined;

function serializableField(value: unknown): boolean {
  return value !== undefined && typeof value !== 'function' && typeof value !== 'symbol';
}

function isPlainChunkableObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && typeof (value as { toJSON?: unknown }).toJSON !== 'function';
}

function stringifyOrThrow(stringify: JsonStringify, value: unknown, key: string): string | undefined {
  try {
    return stringify(value);
  } catch (error) {
    if (isJsonStringTooLargeError(error)) throw new JsonFieldTooLarge(key);
    throw error;
  }
}

async function* serializeJsonValueChunked(value: unknown, key: string, stringify: JsonStringify, count: (bytes: number) => void): AsyncGenerator<string> {
  const emit = (text: string): string => { count(Buffer.byteLength(text, 'utf8')); return text; };
  if (Array.isArray(value) && value.length > JSON_FIELD_CHUNK_ITEMS) {
    yield emit('[');
    for (let offset = 0; offset < value.length; offset += JSON_FIELD_CHUNK_ITEMS) {
      const slice = stringifyOrThrow(stringify, value.slice(offset, offset + JSON_FIELD_CHUNK_ITEMS), key)!;
      yield emit(`${offset === 0 ? '' : ','}${slice.slice(1, -1)}`);
    }
    yield emit(']');
    return;
  }
  if (isPlainChunkableObject(value) && Object.keys(value).length > JSON_FIELD_CHUNK_ITEMS) {
    yield emit('{');
    let first = true;
    for (const inner of Object.keys(value)) {
      if (!serializableField(value[inner])) continue;
      const serialized = stringifyOrThrow(stringify, value[inner], key);
      if (serialized === undefined) continue;
      yield emit(`${first ? '' : ','}${JSON.stringify(inner)}:${serialized}`);
      first = false;
    }
    yield emit('}');
    return;
  }
  yield emit(stringifyOrThrow(stringify, value, key)!);
}

async function* serializeJsonFields(value: Record<string, unknown>, bytes: Record<string, number>, stringify: JsonStringify): AsyncGenerator<string> {
  yield '{';
  let first = true;
  for (const key of Object.keys(value)) {
    const field = value[key];
    if (!serializableField(field)) continue;
    const probe = Array.isArray(field) || isPlainChunkableObject(field) ? '' : stringifyOrThrow(stringify, field, key);
    if (probe === undefined) continue;
    yield `${first ? '' : ','}${JSON.stringify(key)}:`;
    first = false;
    let total = 0;
    if (probe !== '') {
      total = Buffer.byteLength(probe, 'utf8');
      yield probe;
    } else {
      for await (const chunk of serializeJsonValueChunked(field, key, stringify, length => { total += length; })) yield chunk;
    }
    bytes[key] = total;
  }
  yield '}\n';
}

async function countJsonBytes(value: unknown): Promise<number> {
  let total = 0;
  const counter = new Writable({
    write(chunk, _encoding, callback) {
      total += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), 'utf8');
      callback();
    },
  });
  await writeJsonToStream(counter, value, 0);
  await new Promise<void>((resolve, reject) => counter.end((error?: Error | null) => (error ? reject(error) : resolve())));
  return total;
}

export async function writeCompressedJsonFieldsAtomic(
  filePath: string,
  value: Record<string, unknown>,
  stringify: JsonStringify = JSON.stringify,
): Promise<Record<string, number>> {
  const bytes: Record<string, number> = {};
  try {
    await writeCompressedChunksAtomic(filePath, serializeJsonFields(value, bytes, stringify));
    return bytes;
  } catch (error) {
    if (!(error instanceof JsonFieldTooLarge)) throw error;
  }
  await writeCompressedJsonAtomic(filePath, value, { spaces: 0 });
  const measured: Record<string, number> = {};
  for (const key of Object.keys(value)) {
    const field = value[key];
    if (!serializableField(field)) continue;
    measured[key] = await countJsonBytes(field);
  }
  return measured;
}

async function replaceFileAtomic(tmpPath: string, filePath: string): Promise<void> {
  const tmpHandle = await open(tmpPath, 'r');
  try {
    await tmpHandle.sync();
  } finally {
    await tmpHandle.close();
  }
  try {
    await fs.rename(tmpPath, filePath);
    await syncDirectory(path.dirname(filePath));
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== 'win32' || !['EEXIST', 'EPERM'].includes(code || '')) throw error;
  }
  const backupPath = atomicTempPath(filePath, 'backup.tmp');
  const hadDestination = await fs.pathExists(filePath);
  if (hadDestination) await fs.rename(filePath, backupPath);
  try {
    await fs.rename(tmpPath, filePath);
    await syncDirectory(path.dirname(filePath));
    await fs.remove(backupPath).catch(() => undefined);
  } catch (error) {
    if (hadDestination && await fs.pathExists(backupPath)) {
      await fs.remove(filePath).catch(() => undefined);
      await fs.rename(backupPath, filePath);
      await syncDirectory(path.dirname(filePath));
    }
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
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
  await writeCompressedSource(filePath, codec, stream => writeJsonToStream(stream, value, spaces));
}

async function writeCompressedSource(
  filePath: string,
  codec: Exclude<JsonStorageCodec, 'none'>,
  produce: (stream: Writable) => Promise<void>,
): Promise<void> {
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
      await produce(child.stdin);
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
    await produce(compressor);
    compressor.end();
    await compressed;
  } catch (error) {
    compressor.destroy();
    output.destroy();
    await compressed.catch(() => undefined);
    throw error;
  }
}

async function writeChunksToStream(stream: Writable, chunks: AsyncIterable<Buffer | string>): Promise<void> {
  for await (const chunk of chunks) {
    if (stream.write(chunk)) continue;
    await new Promise<void>((resolve, reject) => {
      const onDrain = () => { stream.off('error', onError); resolve(); };
      const onError = (error: Error) => { stream.off('drain', onDrain); reject(error); };
      stream.once('drain', onDrain);
      stream.once('error', onError);
    });
  }
}

async function writeJsonToStream(stream: Writable, value: unknown, spaces = 0): Promise<void> {
  const write = async (chunk: string): Promise<void> => {
    if (stream.write(chunk)) return;
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
  const indent = ' '.repeat(Math.min(10, Math.max(0, Math.trunc(spaces))));
  const pretty = indent.length > 0;
  const ancestors = new Set<object>();
  const normalize = (current: unknown, key: string): unknown => current !== null
    && typeof current === 'object'
    && typeof (current as { toJSON?: unknown }).toJSON === 'function'
    ? (current as { toJSON: (key: string) => unknown }).toJSON(key)
    : current;
  const unsupported = (current: unknown): boolean => current === undefined
    || typeof current === 'function'
    || typeof current === 'symbol';
  function* serializeValue(input: unknown, key: string, depth: number, arrayElement = false, normalized = false): Generator<string> {
    const current = normalized ? input : normalize(input, key);
    if (unsupported(current)) {
      if (arrayElement) {
        yield 'null';
        return;
      }
      throw new TypeError('Value is not JSON serializable');
    }
    if (current === null || typeof current !== 'object') {
      const serialized = JSON.stringify(current);
      if (serialized === undefined) throw new TypeError('Value is not JSON serializable');
      yield serialized;
      return;
    }
    if (current instanceof Number || current instanceof String || current instanceof Boolean) {
      yield JSON.stringify(current);
      return;
    }
    if (ancestors.has(current as object)) throw new TypeError('Converting circular structure to JSON');
    if (!pretty && canSerializeAtomically(current, ATOMIC_JSON_BYTE_BUDGET)) {
      const serialized = JSON.stringify(current);
      if (serialized === undefined) throw new TypeError('Value is not JSON serializable');
      yield serialized;
      return;
    }
    ancestors.add(current as object);
    if (Array.isArray(current)) {
      yield '[';
      for (let index = 0; index < current.length; index++) {
        if (index > 0) yield ',';
        if (pretty) yield `\n${indent.repeat(depth + 1)}`;
        yield* serializeValue(current[index], String(index), depth + 1, true);
      }
      if (pretty && current.length > 0) yield `\n${indent.repeat(depth)}`;
      yield ']';
      ancestors.delete(current);
      return;
    }
    yield '{';
    let first = true;
    for (const [key, rawChild] of Object.entries(current as Record<string, unknown>)) {
      const child = normalize(rawChild, key);
      if (unsupported(child)) continue;
      if (!first) yield ',';
      if (pretty) yield `\n${indent.repeat(depth + 1)}`;
      first = false;
      yield JSON.stringify(key);
      yield pretty ? ': ' : ':';
      yield* serializeValue(child, key, depth + 1, false, true);
    }
    if (pretty && !first) yield `\n${indent.repeat(depth)}`;
    yield '}';
    ancestors.delete(current as object);
  }

  let buffered = '';
  for (const token of serializeValue(value, '', 0)) {
    buffered += token;
    if (buffered.length < STREAM_WRITE_BUFFER_CHARS) continue;
    await write(buffered);
    buffered = '';
  }
  await write(`${buffered}\n`);
}

function canSerializeAtomically(value: object, byteBudget: number): boolean {
  const ancestors = new Set<object>();
  let remaining = byteBudget;
  const visit = (current: unknown, depth: number): boolean => {
    if (remaining < 0 || depth > 64) return false;
    if (current === null || typeof current !== 'object') {
      remaining -= typeof current === 'string' ? current.length * 6 + 2 : 32;
      return remaining >= 0;
    }
    if (current instanceof Number || current instanceof String || current instanceof Boolean) {
      return visit(current.valueOf(), depth);
    }
    if (hasToJSON(current)) return false;
    if (ancestors.has(current)) return false;
    ancestors.add(current);
    if (Array.isArray(current)) {
      remaining -= current.length * 5;
      if (remaining < 0) return false;
    }
    const keys = Object.keys(current);
    if (keys.length > 1_024) return false;
    remaining -= keys.length * 2 + 2;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || descriptor.get || descriptor.set) return false;
      remaining -= key.length * 6 + 3;
      if (!visit(descriptor.value, depth + 1)) return false;
    }
    ancestors.delete(current);
    return remaining >= 0;
  };
  return visit(value, 0);
}

function hasToJSON(value: object): boolean {
  let current: object | null = value;
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, 'toJSON');
    if (descriptor) return Boolean(descriptor.get || descriptor.set || typeof descriptor.value === 'function');
    current = Object.getPrototypeOf(current) as object | null;
  }
  return false;
}
