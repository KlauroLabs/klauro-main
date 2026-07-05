import * as fs from 'fs';
import * as path from 'path';
import type { CASCoverageGap, CASEntryPoint, CASLibrary, CASNode } from '../../types/cas.types';
import type { CodebaseType } from './codebase-type';

/**
 * Coverage-gap self-discovery.
 *
 * The mechanism that makes gap-closing systematic: instead of only finding out
 * "we don't support X" when a human notices, this records a structured gap
 * the moment analysis itself sees evidence it doesn't understand. Four kinds:
 *
 *  (a) unknown-dependency  — a manifest dependency that matches no known
 *      analyzer/framework signal. The single biggest signal: it means "there's
 *      a whole framework/library here we have zero facts about."
 *  (b) low-extraction-ratio — a source file that got parsed (it produced file-
 *      level structure) but yielded almost no nodes relative to its size —
 *      i.e. tree-sitter/the language analyzer saw the file but barely anything
 *      in it was recognized as a meaningful construct.
 *  (c) zero-entry-points   — a root that clearly has source code but the
 *      analysis found NO entry points at all. Combined with codebase_type,
 *      this says "we don't have an entry-point model for this TYPE."
 *  (d) unhandled-node-type — aggregate counts of raw tree-sitter node types
 *      that were walked but never mapped to a CASNode by any analyzer.
 *
 * Every function here is pure (no fs writes, no AI, no orchestrator-internal
 * imports) so it can be unit-tested with plain fixtures and wired into the
 * orchestrator as a late, additive pass over already-produced facts.
 */

export interface UnknownDependencyGapInput {
  libraries: CASLibrary[];
  /** Every dependency name recognized by at least one registered analyzer
   *  (drawn from each AnalyzerRegistration.detectPatterns.dependencies at the
   *  orchestrator call site — kept as a plain string set here to avoid this
   *  module depending on orchestrator internals). */
  recognizedDependencyNames: Set<string> | string[];
  /** Dependency names ubiquitous enough (build tooling, type-only, testing
   *  utilities) that "no analyzer recognizes this" isn't a meaningful gap.
   *  Merged with a small built-in ignore list. */
  ignoreNames?: Set<string> | string[];
}

const DEFAULT_IGNORE_DEPENDENCIES = new Set([
  // Type-only / build-tooling / lint / test-infra packages: near-universal,
  // never themselves the subject of a framework analyzer, and would otherwise
  // dominate the gap list with noise on every single repo.
  'typescript', 'eslint', 'prettier', 'ts-node', 'tslib', 'rimraf', 'nodemon',
  'cross-env', 'dotenv', 'chalk', 'lodash', 'moment', 'uuid', 'axios',
  'node-fetch', 'jest', 'mocha', 'chai', 'sinon', 'vitest', 'ts-jest',
  'husky', 'lint-staged', 'jsdom', 'nyc', 'babel-jest', 'tsx', 'vite',
  'pytest', 'pytest-asyncio', 'pytest-mock', 'ruff', 'black', 'mypy', 'flake8',
  'newtonsoft.json', 'microsoft.extensions.dependencyinjection',
]);

function toSet(value: Set<string> | string[] | undefined): Set<string> {
  if (!value) return new Set();
  return value instanceof Set ? value : new Set(value);
}

/** Strip an npm scope + subpath so "@types/node" and "@babel/core/lib/x" compare cleanly. */
function normalizeDependencyName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * (a) Dependencies present in the manifest that match no analyzer's known
 * signal set. Skips type-only packages (`@types/*`) since those never carry
 * their own runtime framework identity.
 */
export function findUnknownDependencyGaps(input: UnknownDependencyGapInput): CASCoverageGap[] {
  const recognized = new Set([...toSet(input.recognizedDependencyNames)].map(normalizeDependencyName));
  const ignore = new Set([...DEFAULT_IGNORE_DEPENDENCIES, ...toSet(input.ignoreNames)].map(normalizeDependencyName));

  const gaps: CASCoverageGap[] = [];
  const seen = new Set<string>();
  for (const lib of input.libraries) {
    const norm = normalizeDependencyName(lib.name);
    if (!norm) continue;
    if (norm.startsWith('@types/')) continue;
    if (recognized.has(norm) || ignore.has(norm)) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    gaps.push({
      kind: 'unknown-dependency',
      evidence: `Dependency "${lib.name}"${lib.version ? `@${lib.version}` : ''} matches no known analyzer/framework signal`,
      severity: (lib.type ?? 'production') === 'production' ? 'medium' : 'low',
      key: norm,
      detail: { version: lib.version, type: lib.type, package_manager: lib.package_manager },
    });
  }
  return gaps;
}

export interface LowExtractionRatioInput {
  nodes: CASNode[];
  projectPath: string;
  /** Minimum lines for a file to be considered (skip trivial/near-empty files
   *  — a 5-line file with 0 nodes isn't a gap, it's just short). Default 40. */
  minLines?: number;
  /** Node-count-per-line threshold below which a file is flagged. Default
   *  0.02 (1 node per 50 lines) — deliberately generous so only files that
   *  are clearly "parsed but nothing recognized" trip it. */
  minNodesPerLine?: number;
}

const CODE_EXTENSIONS_FOR_RATIO = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'java', 'kt', 'go', 'rs', 'rb',
  'php', 'cs', 'swift', 'scala', 'c', 'cpp', 'cc', 'h', 'hpp',
]);

/**
 * (b) Files that produced file-level structure (they're in the graph at all)
 * but with a node-count-to-line-count ratio so low it signals an unhandled
 * construct rather than a genuinely tiny/simple file.
 */
export function findLowExtractionRatioGaps(input: LowExtractionRatioInput): CASCoverageGap[] {
  const minLines = input.minLines ?? 40;
  const minNodesPerLine = input.minNodesPerLine ?? 0.02;

  const nodesByFile = new Map<string, number>();
  for (const n of input.nodes) {
    const file = n.source?.file;
    if (!file) continue;
    nodesByFile.set(file, (nodesByFile.get(file) || 0) + 1);
  }

  const gaps: CASCoverageGap[] = [];
  for (const [file, nodeCount] of nodesByFile) {
    const ext = path.extname(file).replace(/^\./, '').toLowerCase();
    if (!CODE_EXTENSIONS_FOR_RATIO.has(ext)) continue;

    const absPath = path.isAbsolute(file) ? file : path.join(input.projectPath, file);
    let lineCount = 0;
    try {
      const content = fs.readFileSync(absPath, 'utf8');
      lineCount = content.split('\n').length;
    } catch {
      continue; // file not readable at this path — skip rather than guess
    }
    if (lineCount < minLines) continue;

    const ratio = nodeCount / lineCount;
    if (ratio < minNodesPerLine) {
      gaps.push({
        kind: 'low-extraction-ratio',
        evidence: `${file}: ${nodeCount} node(s) extracted from ${lineCount} lines (ratio ${ratio.toFixed(4)}) — likely an unhandled construct`,
        file,
        severity: ratio === 0 ? 'high' : 'medium',
        key: ext,
        detail: { nodeCount, lineCount, ratio },
      });
    }
  }
  return gaps.sort((a, b) => ((a.detail?.ratio as number) ?? 0) - ((b.detail?.ratio as number) ?? 0));
}

export interface ZeroEntryPointGapInput {
  projectPath: string;
  entryPoints: CASEntryPoint[];
  nodeCount: number;
  codebaseType?: CodebaseType;
}

/**
 * (c) A root with source (nodes were produced) but zero entry points at all.
 * Combined with codebase_type this pinpoints "we lack an entry-point model
 * for this TYPE" rather than just "this repo happens to have none."
 */
export function findZeroEntryPointGap(input: ZeroEntryPointGapInput): CASCoverageGap[] {
  if (input.nodeCount === 0) return []; // no source at all — not a gap, nothing to find entry points in
  if (input.entryPoints.length > 0) return [];
  const type = input.codebaseType ?? 'unknown';
  return [{
    kind: 'zero-entry-points',
    evidence: `Root has ${input.nodeCount} extracted node(s) but zero entry points found (codebase_type=${type}) — likely missing an entry-point model for this type`,
    severity: 'high',
    key: type,
    detail: { nodeCount: input.nodeCount, codebaseType: type },
  }];
}

export interface UnhandledNodeTypeInput {
  /** Raw tree-sitter node-type -> occurrence count, aggregated by the walker
   *  during this analysis pass, BEFORE any per-language resolver/declFilter
   *  claims them (see generic-tree-sitter-analyzer.ts). */
  encounteredNodeTypeCounts: Map<string, number> | Record<string, number>;
  /** Node types any analyzer actually turned into a CASNode/edge this pass. */
  handledNodeTypes: Set<string> | string[];
  /** Only report node types seen at least this many times (default 3) — a
   *  one-off exotic node isn't worth a gap entry. */
  minOccurrences?: number;
}

/**
 * (d) Tree-sitter node types the walker saw but no analyzer ever mapped to a
 * CASNode/edge, aggregated by count. This is the raw material for "which
 * constructs are we blind to" across a language, independent of any single
 * file's extraction ratio.
 */
export function findUnhandledNodeTypeGaps(input: UnhandledNodeTypeInput): CASCoverageGap[] {
  const counts = input.encounteredNodeTypeCounts instanceof Map
    ? input.encounteredNodeTypeCounts
    : new Map(Object.entries(input.encounteredNodeTypeCounts));
  const handled = new Set(input.handledNodeTypes instanceof Set ? input.handledNodeTypes : input.handledNodeTypes);
  const minOccurrences = input.minOccurrences ?? 3;

  const gaps: CASCoverageGap[] = [];
  for (const [nodeType, count] of counts) {
    if (handled.has(nodeType)) continue;
    if (count < minOccurrences) continue;
    gaps.push({
      kind: 'unhandled-node-type',
      evidence: `Tree-sitter node type "${nodeType}" encountered ${count} time(s) but never handled by any analyzer`,
      severity: count > 50 ? 'high' : count > 10 ? 'medium' : 'low',
      key: nodeType,
      detail: { count },
    });
  }
  return gaps.sort((a, b) => ((b.detail?.count as number) ?? 0) - ((a.detail?.count as number) ?? 0));
}

export interface CollectCoverageGapsInput {
  projectPath: string;
  nodes: CASNode[];
  entryPoints: CASEntryPoint[];
  libraries: CASLibrary[];
  recognizedDependencyNames: Set<string> | string[];
  codebaseType?: CodebaseType;
  encounteredNodeTypeCounts?: Map<string, number> | Record<string, number>;
  handledNodeTypes?: Set<string> | string[];
  ignoreDependencyNames?: Set<string> | string[];
}

/** Runs all four gap-discovery passes and returns the combined, deduped list. */
export function collectCoverageGaps(input: CollectCoverageGapsInput): CASCoverageGap[] {
  const gaps: CASCoverageGap[] = [];

  gaps.push(...findUnknownDependencyGaps({
    libraries: input.libraries,
    recognizedDependencyNames: input.recognizedDependencyNames,
    ignoreNames: input.ignoreDependencyNames,
  }));

  gaps.push(...findLowExtractionRatioGaps({
    nodes: input.nodes,
    projectPath: input.projectPath,
  }));

  gaps.push(...findZeroEntryPointGap({
    projectPath: input.projectPath,
    entryPoints: input.entryPoints,
    nodeCount: input.nodes.length,
    codebaseType: input.codebaseType,
  }));

  if (input.encounteredNodeTypeCounts) {
    gaps.push(...findUnhandledNodeTypeGaps({
      encounteredNodeTypeCounts: input.encounteredNodeTypeCounts,
      handledNodeTypes: input.handledNodeTypes ?? [],
    }));
  }

  return gaps;
}
