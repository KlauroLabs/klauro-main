import * as fs from 'fs-extra';
import * as zlib from 'zlib';
import { promisify } from 'util';
import { casSectionForField } from './cas-sections';
import { readZstdJson } from './zstd-json';

const brotliDecompressAsync = promisify(zlib.brotliDecompress);

export function projectTopLevelKeys<T>(value: T, keys?: readonly string[]): T {
  if (!keys || !value || typeof value !== 'object' || Array.isArray(value)) return value;
  const keep = new Set(keys);
  const output: Record<string, unknown> = {};
  for (const [field, item] of Object.entries(value as Record<string, unknown>)) {
    if (keep.has(field) || casSectionForField(field) === 'identity') output[field] = item;
  }
  return output as T;
}

export async function readJsonMaybeCompressed(
  filePath: string,
  options: { maxBufferedZstdBytes?: number; topLevelKeys?: readonly string[] } = {},
): Promise<any> {
  const resolved = await resolveJsonStoragePath(filePath);
  if (!resolved) {
    throw new Error(`JSON file not found: ${filePath}`);
  }

  if (resolved.endsWith('.json.zst')) {
    return readZstdJson(resolved, { maxBufferedCompressedBytes: options.maxBufferedZstdBytes, topLevelKeys: options.topLevelKeys });
  }

  if (resolved.endsWith('.json.br')) {
    const compressed = await fs.readFile(resolved);
    const json = await brotliDecompressAsync(compressed);
    return projectTopLevelKeys(JSON.parse(json.toString('utf8')), options.topLevelKeys);
  }

  return projectTopLevelKeys(await fs.readJson(resolved), options.topLevelKeys);
}

export async function resolveJsonStoragePath(filePath: string): Promise<string | null> {
  if (await fs.pathExists(filePath)) return filePath;
  const candidates = jsonStoragePathCandidates(filePath);
  for (const candidate of candidates) {
    if (await fs.pathExists(candidate)) return candidate;
  }
  return null;
}

export function jsonStoragePathCandidates(filePath: string): string[] {
  if (filePath.endsWith('.json')) return [`${filePath}.zst`, `${filePath}.br`];
  if (filePath.endsWith('.json.zst')) return [filePath.replace(/\.zst$/, ''), filePath.replace(/\.zst$/, '.br')];
  if (filePath.endsWith('.json.br')) return [filePath.replace(/\.br$/, ''), filePath.replace(/\.br$/, '.zst')];
  return [];
}

export interface SectionParseLimits {
  expansion: number;
  parsedSectionBudget: number;
  bufferedSectionLimit: number;
}

export function sectionParseLimits(heapSizeLimit: number, env: NodeJS.ProcessEnv = process.env): SectionParseLimits {
  const expansion = Math.max(1, Number(env.KLAURO_SECTION_PARSE_EXPANSION) || 24);
  const configuredBudgetMb = Number(env.KLAURO_SECTION_PARSE_BUDGET_MB);
  const configured = Number.isFinite(configuredBudgetMb) && configuredBudgetMb > 0 ? configuredBudgetMb * 1024 * 1024 : undefined;
  return {
    expansion,
    parsedSectionBudget: configured ?? heapSizeLimit / 8,
    bufferedSectionLimit: configured ?? heapSizeLimit / 4,
  };
}
