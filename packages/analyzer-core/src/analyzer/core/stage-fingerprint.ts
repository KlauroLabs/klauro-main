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
function hashSourceFiles(paths: string[]): string {
  const hash = crypto.createHash('sha256');
  for (const filePath of paths) {
    hash.update(filePath);
    try {
      hash.update(fs.readFileSync(filePath));
    } catch {
      hash.update('MISSING');
    }
  }
  return hash.digest('hex').slice(0, 16);
}

/** Hash grammar/native-binary IDENTITY (name + byte size), not full content —
 * the vendored-grammars directory is 100+MB of .wasm; a full content hash on
 * every process start is wasteful when filename+size already changes whenever
 * a grammar is swapped, added, or upgraded. */
function hashBinaryIdentities(dir: string): string {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter(f => f.endsWith('.wasm')).sort();
  } catch {
    return 'no-grammars';
  }
  const hash = crypto.createHash('sha256');
  for (const name of entries) {
    let size = -1;
    try {
      size = fs.statSync(path.join(dir, name)).size;
    } catch {
      // leave size at -1 — still contributes a deterministic (if wrong) value
    }
    hash.update(`${name}:${size}`);
  }
  return hash.digest('hex').slice(0, 16);
}

/** The parser/language-analyzer layer, relative to this file's dev location
 * (packages/analyzer-core/src/analyzer/core). Kept in sync with the equivalent
 * PARSER_LAYER_DIRS list in apps/mcp-server/scripts/build-bundle.mjs. */
function computeDevParserFingerprint(): string {
  const analyzerDir = path.resolve(__dirname, '..');
  const sourceDirs = [
    path.join(analyzerDir, 'languages'),
    path.join(analyzerDir, 'ast'),
  ];
  const sourceFiles = [
    path.join(__dirname, 'tree-sitter-parser.ts'),
    path.join(__dirname, 'native-parse.ts'),
    path.join(__dirname, 'generic-tree-sitter-analyzer.ts'),
    path.join(__dirname, 'estree-parse-cache.ts'),
    path.join(__dirname, 'analyzer-file-read-cache.ts'),
    path.join(analyzerDir, 'enhanced-call-graph-extractor.ts'),
    path.join(analyzerDir, 'enhanced-rust-call-graph-extractor.ts'),
  ];
  const walked = sourceDirs.flatMap(dir => walkSourceFiles(dir, ['.ts', '.tsx']));
  const sourceHash = hashSourceFiles([...walked, ...sourceFiles].sort());

  const vendoredGrammarsDir = path.resolve(analyzerDir, '..', '..', 'vendored-grammars');
  const grammarHash = hashBinaryIdentities(vendoredGrammarsDir);

  return `${sourceHash}-${grammarHash}`.slice(0, 16);
}

/** The graph/decorator/derived-facts layer: everything else under
 * src/analyzer that is not part of the parser layer above. Deliberately
 * broad (whole-package minus parser files) so no new deriver can be added
 * without automatically joining this fingerprint. */
function computeDevDerivedFingerprint(): string {
  const analyzerDir = path.resolve(__dirname, '..');
  const parserDirs = new Set([
    path.join(analyzerDir, 'languages'),
    path.join(analyzerDir, 'ast'),
  ]);
  const parserFiles = new Set([
    path.join(__dirname, 'tree-sitter-parser.ts'),
    path.join(__dirname, 'native-parse.ts'),
    path.join(__dirname, 'generic-tree-sitter-analyzer.ts'),
    path.join(__dirname, 'estree-parse-cache.ts'),
    path.join(__dirname, 'analyzer-file-read-cache.ts'),
    path.join(analyzerDir, 'enhanced-call-graph-extractor.ts'),
    path.join(analyzerDir, 'enhanced-rust-call-graph-extractor.ts'),
    // This module itself and build-identity.ts are cache-invalidation
    // plumbing, not derived-fact producers — excluding them avoids the
    // fingerprint churning every time this comment is edited.
    path.join(__dirname, 'stage-fingerprint.ts'),
    path.join(__dirname, 'build-identity.ts'),
  ]);

  const all = walkSourceFiles(analyzerDir, ['.ts', '.tsx']).filter(filePath => {
    if (parserFiles.has(filePath)) return false;
    for (const dir of parserDirs) {
      if (filePath.startsWith(dir + path.sep)) return false;
    }
    return true;
  });
  return hashSourceFiles(all);
}

export function getStageFingerprints(): StageFingerprints {
  if (cached) return cached;

  const bundledParser = bundledValue(typeof __KLAURO_PARSER_FINGERPRINT__ === 'string' ? __KLAURO_PARSER_FINGERPRINT__ : undefined);
  const bundledDerived = bundledValue(typeof __KLAURO_DERIVED_FINGERPRINT__ === 'string' ? __KLAURO_DERIVED_FINGERPRINT__ : undefined);

  if (bundledParser && bundledDerived) {
    cached = { parser_fingerprint: bundledParser, derived_fingerprint: bundledDerived, channel: 'bundle' };
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
