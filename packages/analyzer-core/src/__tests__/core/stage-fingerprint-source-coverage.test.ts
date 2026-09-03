jest.unmock('fs');
jest.unmock('fs-extra');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { computeDerivedFingerprintForRoot, computeParserFingerprintForRoot } from '../../analyzer/core/stage-fingerprint';

const buildFingerprintModule = require('../../../../../apps/mcp-server/scripts/stage-fingerprints.cjs') as {
  computeBuildStageFingerprints(root: string): { parser_fingerprint: string; derived_fingerprint: string };
};

interface ParserStageManifest {
  source_directories: Array<{ path: string; extensions: string[] }>;
  source_files: string[];
  grammar_directory: string;
}

const analyzerCoreRoot = path.resolve(__dirname, '..', '..', '..');
const manifest = fs.readJsonSync(path.join(analyzerCoreRoot, 'parser-stage-manifest.json')) as ParserStageManifest;

describe('parser stage fingerprint source coverage', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-parser-fingerprint-'));
    await fs.copy(
      path.join(analyzerCoreRoot, 'parser-stage-manifest.json'),
      path.join(root, 'parser-stage-manifest.json')
    );
    for (const file of manifest.source_files.filter(file => file !== 'parser-stage-manifest.json')) {
      await fs.outputFile(path.join(root, file), `fixture:${file}`);
    }
    for (const directory of manifest.source_directories) {
      await fs.outputFile(
        path.join(root, directory.path, `fixture${directory.extensions[0]}`),
        `fixture:${directory.path}`
      );
    }
    await fs.ensureDir(path.join(root, manifest.grammar_directory));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('covers the TypeScript extractor, worker, sanitizer implementation, and native Rust build inputs', async () => {
    expect(manifest.source_files).toEqual(expect.arrayContaining([
      'src/analyzer/core/tree-sitter-ts-extractor.ts',
      'src/analyzer/core/tree-sitter-grammar-limitations.ts',
      'src/analyzer/core/tree-sitter-ts-recovery.ts',
      'src/analyzer/core/tree-sitter-ts-worker.ts',
      'src/analyzer/core/source-corpus.ts',
      'native/klauro-parse/build.rs',
      'native/klauro-parse/Cargo.toml',
      'native/klauro-parse/Cargo.lock',
    ]));
    expect(manifest.source_directories).toContainEqual({
      path: 'native/klauro-parse/src',
      extensions: ['.rs'],
    });

    const extractor = await fs.readFile(
      path.join(analyzerCoreRoot, 'src/analyzer/core/tree-sitter-ts-extractor.ts'),
      'utf8'
    );
    expect(extractor).toContain('sanitizeForTreeSitterParse');
    expect(extractor).toContain('sanitizeAbstractPropertyKeyword');
  });

  it('build-time fingerprints exactly match runtime fingerprints', () => {
    const build = buildFingerprintModule.computeBuildStageFingerprints(root);
    expect(build).toEqual({
      parser_fingerprint: computeParserFingerprintForRoot(root),
      derived_fingerprint: computeDerivedFingerprintForRoot(root),
    });
    expect(build.parser_fingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(build.derived_fingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(build.parser_fingerprint).not.toBe('hosted');
    expect(build.derived_fingerprint).not.toBe('hosted');
  });

  it('build-time fingerprints change with parser and derived analyzer implementations', async () => {
    const before = buildFingerprintModule.computeBuildStageFingerprints(root);
    await fs.appendFile(path.join(root, 'src/analyzer/core/source-corpus.ts'), '\nparser-change');
    const parserChanged = buildFingerprintModule.computeBuildStageFingerprints(root);
    expect(parserChanged.parser_fingerprint).not.toBe(before.parser_fingerprint);
    expect(parserChanged.derived_fingerprint).toBe(before.derived_fingerprint);

    await fs.outputFile(path.join(root, 'src/analyzer/frameworks/example-analyzer.ts'), 'export const derived = 1;');
    const derivedChanged = buildFingerprintModule.computeBuildStageFingerprints(root);
    expect(derivedChanged.parser_fingerprint).toBe(parserChanged.parser_fingerprint);
    expect(derivedChanged.derived_fingerprint).not.toBe(parserChanged.derived_fingerprint);
  });

  it.each([
    'src/analyzer/core/tree-sitter-ts-extractor.ts',
    'src/analyzer/core/tree-sitter-grammar-limitations.ts',
    'src/analyzer/core/tree-sitter-ts-recovery.ts',
    'src/analyzer/core/tree-sitter-ts-worker.ts',
    'native/klauro-parse/build.rs',
    'native/klauro-parse/Cargo.toml',
    'native/klauro-parse/Cargo.lock',
  ])('changes when %s changes', async file => {
    const before = computeParserFingerprintForRoot(root);
    await fs.appendFile(path.join(root, file), '\nchanged');
    expect(computeParserFingerprintForRoot(root)).not.toBe(before);
  });

  it('changes when any native Rust source file changes', async () => {
    const rustFile = path.join(root, 'native/klauro-parse/src/fixture.rs');
    const before = computeParserFingerprintForRoot(root);
    await fs.appendFile(rustFile, '\nfn changed() {}');
    expect(computeParserFingerprintForRoot(root)).not.toBe(before);
  });

  it('changes when a vendored grammar identity changes', async () => {
    const grammar = path.join(root, manifest.grammar_directory, 'tree-sitter-typescript.wasm');
    await fs.outputFile(grammar, 'grammar-v1');
    const before = computeParserFingerprintForRoot(root);
    await fs.appendFile(grammar, '-changed-size');
    expect(computeParserFingerprintForRoot(root)).not.toBe(before);
  });

  it('changes when grammar bytes change without changing file size', async () => {
    const grammar = path.join(root, manifest.grammar_directory, 'tree-sitter-typescript.wasm');
    await fs.outputFile(grammar, 'grammar-a');
    const before = computeParserFingerprintForRoot(root);
    await fs.outputFile(grammar, 'grammar-b');
    expect(computeParserFingerprintForRoot(root)).not.toBe(before);
  });

  it('uses repository-relative identities so the same parser inputs hash equally across build roots', async () => {
    const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-parser-fingerprint-copy-'));
    try {
      await fs.copy(root, secondRoot);
      expect(computeParserFingerprintForRoot(secondRoot)).toBe(computeParserFingerprintForRoot(root));
    } finally {
      await fs.rm(secondRoot, { recursive: true, force: true });
    }
  });

  it('hashes the canonical source deriver tree independently of the runtime module directory', async () => {
    await fs.outputFile(path.join(root, 'src/analyzer/core/orchestrator.ts'), 'export const derived = 1;');
    const before = computeDerivedFingerprintForRoot(root);
    await fs.appendFile(path.join(root, 'src/analyzer/core/orchestrator.ts'), '\nexport const changed = 2;');
    expect(computeDerivedFingerprintForRoot(root)).not.toBe(before);
  });

  it('uses repository-relative identities for derived sources across deployment roots', async () => {
    await fs.outputFile(path.join(root, 'src/analyzer/core/orchestrator.ts'), 'export const derived = 1;');
    const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-derived-fingerprint-copy-'));
    try {
      await fs.copy(root, secondRoot);
      expect(computeDerivedFingerprintForRoot(secondRoot)).toBe(computeDerivedFingerprintForRoot(root));
    } finally {
      await fs.rm(secondRoot, { recursive: true, force: true });
    }
  });
});
