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
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkSourceFiles(full, exts));
    } else if (exts.some(ext => entry.name.endsWith(ext)) && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.test.tsx')) {
      out.push(full);
    }
  }
  return out.sort();
}



function hashSourceFiles(paths: string[], identityRoot?: string): string {
  const hash = crypto.createHash('sha256');
  for (const filePath of paths) {
    hash.update(identityRoot
      ? path.relative(identityRoot, filePath).split(path.sep).join('/')
      : filePath);
    try {
      hash.update(fs.readFileSync(filePath));
    } catch {
      hash.update('MISSING');
    }
  }
  return hash.digest('hex').slice(0, 16);
}

interface ParserStageManifest {
  version: number;
  source_directories: Array<{ path: string; extensions: string[] }>;
  source_files: string[];
  grammar_directory: string;
}

function loadParserStageManifest(analyzerCoreRoot: string): ParserStageManifest {
  const manifestPath = path.join(analyzerCoreRoot, 'parser-stage-manifest.json');
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ParserStageManifest;
}

function combineFingerprintParts(...parts: string[]): string {
  const hash = crypto.createHash('sha256');
  for (const part of parts) {
    hash.update(String(part.length));
    hash.update(':');
    hash.update(part);
  }
  return hash.digest('hex').slice(0, 16);
}




function hashBinaryContents(dir: string): string {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter(f => f.endsWith('.wasm')).sort();
  } catch {
    return 'no-grammars';
  }
  const hash = crypto.createHash('sha256');
  for (const name of entries) {
    hash.update(name);
    try {
      hash.update(fs.readFileSync(path.join(dir, name)));
    } catch {
      hash.update('MISSING');
    }
  }
  return hash.digest('hex').slice(0, 16);
}



export function computeParserFingerprintForRoot(analyzerCoreRoot: string): string {
  const manifest = loadParserStageManifest(analyzerCoreRoot);
  const walked = manifest.source_directories.flatMap(directory =>
    walkSourceFiles(path.join(analyzerCoreRoot, directory.path), directory.extensions)
  );
  const sourceFiles = manifest.source_files.map(file => path.join(analyzerCoreRoot, file));
  const sourceHash = hashSourceFiles([...walked, ...sourceFiles].sort(), analyzerCoreRoot);
  const configuredGrammarDirectory = process.env.KLAURO_GRAMMARS_DIR?.trim();
  const grammarHash = hashBinaryContents(configuredGrammarDirectory || path.join(analyzerCoreRoot, manifest.grammar_directory));

  return combineFingerprintParts(sourceHash, grammarHash);
}

function computeDevParserFingerprint(): string {
  return computeParserFingerprintForRoot(path.resolve(__dirname, '..', '..', '..'));
}





export function computeDerivedFingerprintForRoot(analyzerCoreRoot: string): string {
  const analyzerDir = path.join(analyzerCoreRoot, 'src', 'analyzer');
  const manifest = loadParserStageManifest(analyzerCoreRoot);
  const parserDirs = new Set(manifest.source_directories
    .map(directory => path.join(analyzerCoreRoot, directory.path))
    .filter(directory => directory === analyzerDir || directory.startsWith(`${analyzerDir}${path.sep}`)));
  const parserFiles = new Set(manifest.source_files.map(file => path.join(analyzerCoreRoot, file)));

  parserFiles.add(path.join(analyzerDir, 'core', 'stage-fingerprint.ts'));
  parserFiles.add(path.join(analyzerDir, 'core', 'build-identity.ts'));

  const all = walkSourceFiles(analyzerDir, ['.ts', '.tsx']).filter(filePath => {
    if (parserFiles.has(filePath)) return false;
    for (const dir of parserDirs) {
      if (filePath.startsWith(dir + path.sep)) return false;
    }
    return true;
  });
  return hashSourceFiles(all, analyzerCoreRoot);
}

function computeDevDerivedFingerprint(): string {
  return computeDerivedFingerprintForRoot(path.resolve(__dirname, '..', '..', '..'));
}

export function getStageFingerprints(): StageFingerprints {
  if (cached) return cached;

  const bundledParser = bundledValue(typeof __KLAURO_PARSER_FINGERPRINT__ === 'string' ? __KLAURO_PARSER_FINGERPRINT__ : undefined);
  const bundledDerived = bundledValue(typeof __KLAURO_DERIVED_FINGERPRINT__ === 'string' ? __KLAURO_DERIVED_FINGERPRINT__ : undefined);

  if (bundledParser && bundledDerived) {
    const configuredGrammarDirectory = process.env.KLAURO_GRAMMARS_DIR?.trim();
    cached = {
      parser_fingerprint: configuredGrammarDirectory
        ? combineFingerprintParts(bundledParser, hashBinaryContents(configuredGrammarDirectory))
        : bundledParser,
      derived_fingerprint: bundledDerived,
      channel: 'bundle',
    };
    return cached;
  }

  cached = {
    parser_fingerprint: computeDevParserFingerprint(),
    derived_fingerprint: computeDevDerivedFingerprint(),
    channel: 'dev',
  };
  return cached;
}



export function resetStageFingerprintCacheForTests(): void {
  cached = undefined;
}
