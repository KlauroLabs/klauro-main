/**
 * Gate assertion for the old-vs-new extractor differential parity harness.
 *
 * Lives under `__tests__/parity/`, which the default jest run ignores: a
 * full-corpus differential is minutes of work and does not belong in the
 * inner-loop unit suite. It runs via `npm run parity:extractor` (analyzer-core)
 * / `npm run parity:extractor` (root), which is the analyzer gate's home for
 * it, alongside `entry-point-type-parity`.
 */

import {
  formatFailure,
  hashBaselineModule,
  pinnedBaselineHash,
  runExtractorParity,
} from './extractor-differential-parity';
import { defaultCorpus } from './extractor-corpus';

// A full-corpus differential run over ~1.5k files, twice per file.
jest.setTimeout(30 * 60 * 1000);

describe('tree-sitter TS extractor: pre-rewrite vs current', () => {
  it('vendored baseline module matches its pinned content hash', () => {
    const pinned = pinnedBaselineHash();
    const actual = hashBaselineModule();
    expect({ sha256: actual }).toEqual({ sha256: pinned.sha256 });
  });

  it('produces byte-identical TSFileExtraction for every corpus file', () => {
    const corpus = defaultCorpus();
    // A corpus that silently collapsed to a handful of files would make this
    // test pass while proving nothing — assert scale before asserting parity.
    expect(corpus.length).toBeGreaterThan(500);

    const result = runExtractorParity({ corpus });
    if (result.unallowed.length > 0) {
      throw new Error(formatFailure(result, 10));
    }
  });
});
