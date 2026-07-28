import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import {
  readTreeSitterExtractionCache,
  writeTreeSitterExtractionCache,
} from '../../analyzer/core/tree-sitter-ts-extraction-cache';
import type { TSFileExtraction } from '../../analyzer/core/tree-sitter-ts-extractor';

describe('tree-sitter TypeScript extraction cache', () => {
  let directory: string;
  const extraction: TSFileExtraction = {
    imports: [],
    functions: [],
    classes: [],
    variables: [],
    exports: [],
    comments: [],
    hasSyntaxErrors: false,
  };

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-ts-cache-'));
    process.env.KLAURO_TS_EXTRACTION_CACHE_PATH = directory;
  });

  afterEach(async () => {
    delete process.env.KLAURO_TS_EXTRACTION_CACHE_PATH;
    await fs.remove(directory);
  });

  it('round-trips exact extraction IR and keys it by source content', async () => {
    await writeTreeSitterExtractionCache('export const value = 1;', 'src/value.ts', extraction);
    await expect(readTreeSitterExtractionCache('export const value = 1;', 'src/value.ts'))
      .resolves.toEqual(extraction);
    await expect(readTreeSitterExtractionCache('export const value = 2;', 'src/value.ts'))
      .resolves.toBeUndefined();
  });

  it('is disabled unless the hosted service configures a cache path', async () => {
    delete process.env.KLAURO_TS_EXTRACTION_CACHE_PATH;
    await writeTreeSitterExtractionCache('export const value = 1;', 'src/value.ts', extraction);
    await expect(readTreeSitterExtractionCache('export const value = 1;', 'src/value.ts'))
      .resolves.toBeUndefined();
  });
});
