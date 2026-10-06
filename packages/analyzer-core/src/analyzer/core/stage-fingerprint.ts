import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';









































declare const __KLAURO_PARSER_FINGERPRINT__: string | undefined;
declare const __KLAURO_DERIVED_FINGERPRINT__: string | undefined;

export interface StageFingerprints {
  parser_fingerprint: string;
  derived_fingerprint: string;
  channel: 'bundle' | 'dev';
}

let cached: StageFingerprints | undefined;

function bundledValue(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}



function walkSourceFiles(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'target') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkSourceFiles(full, exts));
    } else if (exts.some(ext => entry.name.endsWith(ext)) && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out.sort();
}

function hashSourceFiles(paths: string[], identityRoot: string): string {
  const hash = crypto.createHash('sha256');
  for (const filePath of paths) {
    hash.update(path.relative(identityRoot, filePath).split(path.sep).join('/'));
    try {
      hash.update(fs.readFileSync(filePath));
    } catch {
      hash.update('MISSING');
    }
  }
  return hash.digest('hex').slice(0, 16);
}

interface StageSources {
  directories: Array<{ path: string; extensions: string[] }>;
  files: string[];
}

interface StageManifest {
  version: number;
  parser: StageSources;
  derived: StageSources;
}

function loadStageManifest(analyzerCoreRoot: string): StageManifest {
  return JSON.parse(fs.readFileSync(path.join(analyzerCoreRoot, 'parser-stage-manifest.json'), 'utf8')) as StageManifest;
}

function computeStageFingerprint(analyzerCoreRoot: string, stage: StageSources): string {
  const walked = stage.directories.flatMap(directory =>
    walkSourceFiles(path.join(analyzerCoreRoot, directory.path), directory.extensions)
  );
  const declared = stage.files.map(file => path.join(analyzerCoreRoot, file));
  return hashSourceFiles([...new Set([...walked, ...declared])].sort(), analyzerCoreRoot);
}

export function computeParserFingerprintForRoot(analyzerCoreRoot: string): string {
  return computeStageFingerprint(analyzerCoreRoot, loadStageManifest(analyzerCoreRoot).parser);
}

export function computeDerivedFingerprintForRoot(analyzerCoreRoot: string): string {
  return computeStageFingerprint(analyzerCoreRoot, loadStageManifest(analyzerCoreRoot).derived);
}

export function getStageFingerprints(): StageFingerprints {
  if (cached) return cached;

  const bundledParser = bundledValue(typeof __KLAURO_PARSER_FINGERPRINT__ === 'string' ? __KLAURO_PARSER_FINGERPRINT__ : undefined);
  const bundledDerived = bundledValue(typeof __KLAURO_DERIVED_FINGERPRINT__ === 'string' ? __KLAURO_DERIVED_FINGERPRINT__ : undefined);

  if (bundledParser && bundledDerived) {
    cached = { parser_fingerprint: bundledParser, derived_fingerprint: bundledDerived, channel: 'bundle' };
    return cached;
  }

  const analyzerCoreRoot = path.resolve(__dirname, '..', '..', '..');
  cached = {
    parser_fingerprint: computeParserFingerprintForRoot(analyzerCoreRoot),
    derived_fingerprint: computeDerivedFingerprintForRoot(analyzerCoreRoot),
    channel: 'dev',
  };
  return cached;
}



export function resetStageFingerprintCacheForTests(): void {
  cached = undefined;
}
