import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { TSFileExtraction } from './tree-sitter-ts-extractor';
import { getStageFingerprints } from './stage-fingerprint';

function cacheRoot(): string | undefined {
  const configured = process.env.KLAURO_TS_EXTRACTION_CACHE_PATH?.trim();
  return configured || undefined;
}

function extractionKey(content: string, filePath: string): string {
  return crypto.createHash('sha256')
    .update(getStageFingerprints().parser_fingerprint)
    .update('\0')
    .update(path.extname(filePath).toLowerCase())
    .update('\0')
    .update(content)
    .digest('hex');
}

function cachePath(root: string, key: string): string {
  return path.join(root, key.slice(0, 2), `${key}.json`);
}

function isExtraction(value: unknown): value is TSFileExtraction {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<TSFileExtraction>;
  return Array.isArray(candidate.imports)
    && Array.isArray(candidate.functions)
    && Array.isArray(candidate.classes)
    && Array.isArray(candidate.variables)
    && Array.isArray(candidate.exports)
    && Array.isArray(candidate.comments)
    && typeof candidate.hasSyntaxErrors === 'boolean';
}

export async function readTreeSitterExtractionCache(
  content: string,
  filePath: string
): Promise<TSFileExtraction | undefined> {
  const root = cacheRoot();
  if (!root) return undefined;
  const file = cachePath(root, extractionKey(content, filePath));
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!isExtraction(parsed)) {
      await fs.rm(file, { force: true });
      return undefined;
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') await fs.rm(file, { force: true }).catch(() => undefined);
    return undefined;
  }
}

export async function writeTreeSitterExtractionCache(
  content: string,
  filePath: string,
  extraction: TSFileExtraction
): Promise<void> {
  const root = cacheRoot();
  if (!root) return;
  const key = extractionKey(content, filePath);
  const file = cachePath(root, key);
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(temporary, JSON.stringify(extraction), 'utf8');
    await fs.rename(temporary, file).catch(async error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}
