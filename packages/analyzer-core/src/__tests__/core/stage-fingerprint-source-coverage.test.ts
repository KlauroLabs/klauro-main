jest.unmock('fs');
jest.unmock('fs-extra');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { computeDerivedFingerprintForRoot, computeParserFingerprintForRoot } from '../../analyzer/core/stage-fingerprint';

const buildFingerprintModule = require('../../../../../apps/mcp-server/scripts/stage-fingerprints.cjs') as {
  computeBuildStageFingerprints(root: string): { parser_fingerprint: string; derived_fingerprint: string };
};

interface StageSources {
  directories: Array<{ path: string; extensions: string[] }>;
  files: string[];
}

interface StageManifest {
  parser: StageSources;
  derived: StageSources;
}

const analyzerCoreRoot = path.resolve(__dirname, '..', '..', '..');
const manifest = fs.readJsonSync(path.join(analyzerCoreRoot, 'parser-stage-manifest.json')) as StageManifest;

function importedSources(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file) || !fs.existsSync(file)) return seen;
  seen.add(file);
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(/(?:from|import\()\s*['"](\.[^'"]+)['"]/g)) {
    const base = path.resolve(path.dirname(file), match[1]);
    const resolved = [`${base}.ts`, path.join(base, 'index.ts')].find(candidate => fs.existsSync(candidate));
    if (resolved) importedSources(resolved, seen);
  }
  return seen;
}

describe('stage fingerprint source coverage', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-stage-fingerprint-'));
    await fs.copy(path.join(analyzerCoreRoot, 'parser-stage-manifest.json'), path.join(root, 'parser-stage-manifest.json'));
    for (const stage of [manifest.parser, manifest.derived]) {
      for (const file of stage.files.filter(file => file !== 'parser-stage-manifest.json')) {
        await fs.outputFile(path.join(root, file), `fixture:${file}`);
      }
      for (const directory of stage.directories) {
        await fs.outputFile(path.join(root, directory.path, `fixture${directory.extensions[0]}`), `fixture:${directory.path}`);
      }
    }
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('hashes the engine crate sources, data tables, grammars and build inputs', () => {
    expect(manifest.parser.directories.map(directory => directory.path)).toEqual(expect.arrayContaining([
      'native/klauro-engine/src',
      'native/klauro-engine/data',
      'native/klauro-engine/grammars',
    ]));
    expect(manifest.parser.files).toEqual(expect.arrayContaining([
      'native/klauro-engine/Cargo.toml',
      'native/klauro-engine/Cargo.lock',
      'native/klauro-engine/build.rs',
    ]));
  });

  it('hashes every module the tier-stack mapper imports', () => {
    const hashed = new Set<string>();
    for (const directory of manifest.derived.directories) {
      for (const file of fs.readdirSync(path.join(analyzerCoreRoot, directory.path))) {
        hashed.add(path.join(analyzerCoreRoot, directory.path, file));
      }
    }
    for (const file of manifest.derived.files) hashed.add(path.join(analyzerCoreRoot, file));
    const tierStack = path.join(analyzerCoreRoot, 'src/analyzer/tier-stack');
    const mapperFiles = fs.readdirSync(tierStack).filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts'));
    const imported = new Set<string>();
    for (const file of mapperFiles) importedSources(path.join(tierStack, file), imported);
    const typeModules = path.join(analyzerCoreRoot, 'src/types');
    const buildIdentity = path.join(analyzerCoreRoot, 'src/analyzer/core/build-identity.ts');
    const missing = [...imported]
      .filter(file => !file.startsWith(typeModules) && file !== buildIdentity)
      .filter(file => !hashed.has(file))
      .map(file => path.relative(analyzerCoreRoot, file));
    expect(missing).toEqual([]);
  });

  it('build-time fingerprints exactly match runtime fingerprints', () => {
    const build = buildFingerprintModule.computeBuildStageFingerprints(root);
    expect(build).toEqual({
      parser_fingerprint: computeParserFingerprintForRoot(root),
      derived_fingerprint: computeDerivedFingerprintForRoot(root),
    });
    expect(build.parser_fingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(build.derived_fingerprint).toMatch(/^[a-f0-9]{16}$/);
  });

  it('parser fingerprint changes only with engine inputs and derived fingerprint only with mapper inputs', async () => {
    const before = buildFingerprintModule.computeBuildStageFingerprints(root);
    await fs.appendFile(path.join(root, 'native/klauro-engine/src/fixture.rs'), '\nfn changed() {}');
    const engineChanged = buildFingerprintModule.computeBuildStageFingerprints(root);
    expect(engineChanged.parser_fingerprint).not.toBe(before.parser_fingerprint);
    expect(engineChanged.derived_fingerprint).toBe(before.derived_fingerprint);

    await fs.appendFile(path.join(root, 'src/analyzer/tier-stack/fixture.ts'), '\nexport const changed = 1;');
    const mapperChanged = buildFingerprintModule.computeBuildStageFingerprints(root);
    expect(mapperChanged.parser_fingerprint).toBe(engineChanged.parser_fingerprint);
    expect(mapperChanged.derived_fingerprint).not.toBe(engineChanged.derived_fingerprint);
  });

  it.each([
    'native/klauro-engine/Cargo.toml',
    'native/klauro-engine/Cargo.lock',
    'native/klauro-engine/build.rs',
    'native/klauro-engine/data/fixture.tsv',
    'native/klauro-engine/grammars/fixture.c',
  ])('parser fingerprint changes when %s changes', async file => {
    const before = computeParserFingerprintForRoot(root);
    await fs.appendFile(path.join(root, file), '\nchanged');
    expect(computeParserFingerprintForRoot(root)).not.toBe(before);
  });

  it('uses repository-relative identities so the same inputs hash equally across build roots', async () => {
    const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-stage-fingerprint-copy-'));
    try {
      await fs.copy(root, secondRoot);
      expect(computeParserFingerprintForRoot(secondRoot)).toBe(computeParserFingerprintForRoot(root));
      expect(computeDerivedFingerprintForRoot(secondRoot)).toBe(computeDerivedFingerprintForRoot(root));
    } finally {
      await fs.rm(secondRoot, { recursive: true, force: true });
    }
  });
});
