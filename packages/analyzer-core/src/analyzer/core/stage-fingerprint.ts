import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// --- Stage fingerprints: scoped cache-invalidation for incremental analysis --
//
// The incident this exists for: `analyzer_build` (base package version + git
// sha of the WHOLE monorepo — see build-identity.ts) changes on EVERY commit,
// including releases that only touch MCP tools or WAS/product-map code and
// never touch the parse/graph pipeline. Because `fullRebuildReasonForPreviousOutput`
// forced a full rebuild whenever `analyzer_build` differed at all, every deploy
// threw away the ENTIRE persisted CASOutput (parse results + every derived
// layer: ERD, flow concepts, call chains, entrenchment, product_map, ...) for
// every analyzed project, turning the first re-analysis after each release
// into a cold rebuild regardless of what actually changed.
//
// Stage fingerprints replace that single whole-repo version stamp with two
// narrower, evidence-grounded fingerprints, each scoped to the source files
// that can actually change the artifacts they gate:
//
//  - parser_fingerprint: the language-analyzer + parser layer (tree-sitter
//    bindings, native parse glue, per-language analyzers, vendored grammars).
//    Changes here can change PARSED node/edge shape for any file, so a
//    mismatch still forces a full rebuild (today's behavior, unchanged).
//  - derived_fingerprint: the graph/decorator layer that turns parsed nodes
//    into derived facts (call chains, flow concepts, product map, coverage
//    gaps, entrenchment, ...). Changes here also force a full rebuild (we
//    do not yet have a way to reuse parse output while only recomputing
//    derived facts — see orchestrator.ts fullRebuildReasonForPreviousOutput
//    for the honest limitation), but the derived-layer changing is a MUCH
//    narrower / rarer event than "the monorepo git sha changed".
//
// When NEITHER fingerprint changes, the analyzer_build stamp is allowed to
// differ (e.g. an MCP-tool-only or WAS-only release) without forcing a full
// rebuild — the ordinary file-diff-driven incremental path decides instead.
//
// Bundle channel: fingerprints are computed at BUILD time (see
// apps/mcp-server/scripts/build-bundle.mjs) over the same file lists below and
// baked in via esbuild `define` as __KLAURO_PARSER_FINGERPRINT__ /
// __KLAURO_DERIVED_FINGERPRINT__ — the shipped bundle has no source tree to
// walk at runtime. Dev channel: computed by walking the real source tree
// relative to this file, exactly mirroring build-identity.ts's dev/bundle
// split.

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

/** Recursively collect files under `dir` matching `exts`, skipping `.test.ts`
 * files and node_modules — sorted so the walk order is deterministic. */
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

/** Hash file CONTENT for source files (small, fast, and correctness-critical —
 * a one-line change must move the fingerprint). */
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

/** Hash grammar/native-binary content once per process. Same-size grammar
 * replacements can change parse behavior, so filename and size are not a
 * correctness-safe cache identity. */
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

/** The parser/language-analyzer layer. The shared parser-stage manifest keeps
 * the dev runtime and bundle builder on one cache-invalidation source set. */
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

/** The graph/decorator/derived-facts layer: everything else under
 * src/analyzer that is not part of the parser layer above. Deliberately
 * broad (whole-package minus parser files) so no new deriver can be added
 * without automatically joining this fingerprint. */
export function computeDerivedFingerprintForRoot(analyzerCoreRoot: string): string {
  const analyzerDir = path.join(analyzerCoreRoot, 'src', 'analyzer');
  const manifest = loadParserStageManifest(analyzerCoreRoot);
  const parserDirs = new Set(manifest.source_directories
    .map(directory => path.join(analyzerCoreRoot, directory.path))
    .filter(directory => directory === analyzerDir || directory.startsWith(`${analyzerDir}${path.sep}`)));
  const parserFiles = new Set(manifest.source_files.map(file => path.join(analyzerCoreRoot, file)));
  // Cache-invalidation plumbing does not itself produce analysis facts.
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

/** Test-only: clear the module-level cache so tests can simulate different
 * source trees / bundle defines without leaking state across cases. */
export function resetStageFingerprintCacheForTests(): void {
  cached = undefined;
}
