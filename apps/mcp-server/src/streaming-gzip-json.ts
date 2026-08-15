import { createReadStream, createWriteStream } from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import * as fs from 'fs-extra';
import { parserStream } from 'stream-json';
import Assembler from 'stream-json/assembler.js';
import { writeJsonAtomic } from './storage';

export async function readStreamingGzipJson<T>(filePath: string): Promise<T> {
  const tokens = parserStream();
  const assembler = new Assembler<T>();
  const completed = pipeline(createReadStream(filePath), createGunzip(), tokens);
  try {
    for await (const token of tokens) assembler.consume(token);
    await completed;
  } catch (error) {
    await completed.catch(() => undefined);
    throw error;
  }
  if (!assembler.done || assembler.current === null) {
    throw new Error(`gzip produced incomplete JSON for ${filePath}`);
  }
  return assembler.current;
}

export async function writeStreamingGzipJson(filePath: string, value: unknown): Promise<void> {
  await fs.ensureDir(path.dirname(filePath));
  const attempt = `${process.pid}.${Date.now()}`;
  const jsonPath = `${filePath}.${attempt}.json.tmp`;
  const gzipPath = `${filePath}.${attempt}.gzip.tmp`;
  try {
    await writeJsonAtomic(jsonPath, value, { spaces: 0 });
    await pipeline(createReadStream(jsonPath), createGzip(), createWriteStream(gzipPath));
    await fs.move(gzipPath, filePath, { overwrite: true });
  } finally {
    await fs.remove(jsonPath).catch(() => undefined);
    await fs.remove(gzipPath).catch(() => undefined);
  }
}
