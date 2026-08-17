import * as fs from 'fs-extra';
import * as path from 'node:path';
import { deserialize, serialize } from 'node:v8';
import type { CASOutput } from '../../../../packages/analyzer-core/src/types/cas.types';

export function benchCasCacheRuntimeFingerprint(): string {
  return `v8-structured-clone:${process.versions.v8}`;
}

export async function readBenchCasCache(file: string): Promise<CASOutput | undefined> {
  try {
    return deserialize(await fs.readFile(file)) as CASOutput;
  } catch {
    return undefined;
  }
}

export async function writeBenchCasCache(file: string, cas: CASOutput): Promise<void> {
  await fs.ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, serialize(cas));
    await fs.move(temporary, file, { overwrite: true });
  } finally {
    await fs.remove(temporary).catch(() => undefined);
  }
}
