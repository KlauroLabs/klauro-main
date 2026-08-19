import * as fs from 'fs-extra';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { deserialize, serialize } from 'node:v8';
import type { CASOutput } from '../../../../packages/analyzer-core/src/types/cas.types';

let sourceFingerprint: string | undefined;

export function benchCasCacheRuntimeFingerprint(): string {
  sourceFingerprint ||= computeBenchProductSourceFingerprint(path.resolve(__dirname, '..'));
  return `v8-structured-clone:${process.versions.v8}:product-analysis:${sourceFingerprint}`;
}

export function computeBenchProductSourceFingerprint(sourceRoot: string): string {
  const hash = crypto.createHash('sha256');
  for (const file of productionSourceFiles(sourceRoot)) {
    hash.update(path.relative(sourceRoot, file).split(path.sep).join('/'));
    hash.update(fs.readFileSync(file));
  }
  return hash.digest('hex').slice(0, 16);
}

function productionSourceFiles(directory: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionSourceFiles(target);
    if (!entry.isFile()) return [];
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) return [];
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [target] : [];
  }).sort();
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
