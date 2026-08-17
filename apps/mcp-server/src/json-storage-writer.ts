import * as crypto from 'crypto';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as zlib from 'zlib';
import { execFile, spawnSync } from 'child_process';
import type { Writable } from 'stream';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const brotliCompressAsync = promisify(zlib.brotliCompress);
export type JsonStorageCodec = 'none' | 'brotli' | 'zstd';

function atomicTempPath(filePath: string, suffix: string): string {
  return `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(8).toString('hex')}.${suffix}`;
}

export async function writeJsonAtomic(filePath: string, value: unknown, options: { spaces?: number } = { spaces: 2 }): Promise<void> {
  await fs.ensureDir(path.dirname(filePath));
  const tmpPath = atomicTempPath(filePath, 'tmp');
  try {
    try {
      if (shouldStreamJson(value, options.spaces)) await writeJsonStreamed(tmpPath, value);
      else await fs.writeJson(tmpPath, value, options);
    } catch (error) {
      if (!isJsonStringTooLargeError(error)) throw error;
      await writeJsonStreamed(tmpPath, value);
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
  const jsonTmpPath = atomicTempPath(filePath, 'json.tmp');
  const compressedTmpPath = atomicTempPath(filePath, 'compressed.tmp');
  try {
    await writeJsonAtomic(jsonTmpPath, value, options);
    await compressJsonFile(jsonTmpPath, compressedTmpPath, codec);
    await fs.move(compressedTmpPath, filePath, { overwrite: true });
  } finally {
    await fs.remove(jsonTmpPath).catch(() => undefined);
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

async function writeJsonStreamed(filePath: string, value: unknown): Promise<void> {
  const stream = fs.createWriteStream(filePath, { encoding: 'utf8' });
  const finished = new Promise<void>((resolve, reject) => {
    stream.on('error', reject);
    stream.on('finish', resolve);
  });
  try {
    await writeJsonToStream(stream, value);
    stream.end();
    await finished;
  } catch (error) {
    stream.destroy();
    await finished.catch(() => undefined);
    throw error;
  }
}

async function writeJsonToStream(stream: Writable, value: unknown): Promise<void> {
  const write = (chunk: string) => {
    if (stream.write(chunk)) return undefined;
    return new Promise<void>((resolve, reject) => {
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

  const writeValue = async (current: unknown): Promise<void> => {
    if (current === undefined || typeof current === 'function' || typeof current === 'symbol') {
      await write('null');
      return;
    }
    if (current === null || typeof current !== 'object') {
      await write(JSON.stringify(current));
      return;
    }
    const jsonValue = typeof (current as { toJSON?: unknown }).toJSON === 'function'
      ? (current as { toJSON: () => unknown }).toJSON()
      : current;
    if (jsonValue !== current) {
      await writeValue(jsonValue);
      return;
    }
    if (Array.isArray(current)) {
      await write('[');
      for (let index = 0; index < current.length; index++) {
        if (index > 0) await write(',');
        if (canStringifyStreamArrayItem(current[index])) await write(JSON.stringify(current[index]));
        else await writeValue(current[index]);
      }
      await write(']');
      return;
    }
    await write('{');
    let first = true;
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      if (child === undefined || typeof child === 'function' || typeof child === 'symbol') continue;
      if (!first) await write(',');
      first = false;
      await write(JSON.stringify(key));
      await write(':');
      await writeValue(child);
    }
    await write('}');
  };

  await writeValue(value);
  await write('\n');
}

function canStringifyStreamArrayItem(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (Array.isArray(value)) return false;
  return typeof (value as { toJSON?: unknown }).toJSON !== 'function';
}
