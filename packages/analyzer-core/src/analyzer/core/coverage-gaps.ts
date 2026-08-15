import * as fs from 'fs';
import * as path from 'path';
import type { CASCoverageGap, CASEntryPoint, CASLibrary, CASNode } from '../../types/cas.types';
import type { CodebaseType } from './codebase-type';


























export interface UnknownDependencyGapInput {
  libraries: CASLibrary[];




  recognizedDependencyNames: Set<string> | string[];



  ignoreNames?: Set<string> | string[];
}

const DEFAULT_IGNORE_DEPENDENCIES = new Set([



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


function normalizeDependencyName(name: string): string {
  return name.trim().toLowerCase();
}






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


  minLines?: number;



  minNodesPerLine?: number;
}

const CODE_EXTENSIONS_FOR_RATIO = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'java', 'kt', 'go', 'rs', 'rb',
  'php', 'cs', 'swift', 'scala', 'c', 'cpp', 'cc', 'h', 'hpp',
]);






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
      continue;
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






export function findZeroEntryPointGap(input: ZeroEntryPointGapInput): CASCoverageGap[] {
  if (input.nodeCount === 0) return [];
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



  encounteredNodeTypeCounts: Map<string, number> | Record<string, number>;

  handledNodeTypes: Set<string> | string[];


  minOccurrences?: number;
}







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
