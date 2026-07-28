/**
 * TRUE old-vs-new differential parity harness for `TreeSitterTSExtractor`.
 *
 * This is a DIFFERENTIAL harness, not a golden-file one. It runs two distinct
 * implementations — the vendored pre-rewrite baseline in
 * `__tests__/baselines/tree-sitter-ts-extractor.baseline.ts` and the live
 * `analyzer/core/tree-sitter-ts-extractor.ts` — over the same corpus, under the
 * same tree-sitter build, in the same process, and compares the ENTIRE
 * `TSFileExtraction`: imports, functions (calls, complexity, throws,
 * decorators, params), classes, variables, exports, comments, syntax-error
 * flags. Not a field subset, because a subset is exactly how a rewrite's
 * regression slips through.
 *
 * The predecessor test it replaces compared the new extractor against a
 * baseline JSON that had itself been regenerated from the new extractor, over
 * one synthetic fixture. That is self-parity: it can only catch drift AFTER the
 * rewrite lands, never a regression the rewrite introduces.
 *
 * The baseline module is pinned by SHA-256 so a silent edit — "fixing" the
 * baseline to match new behaviour, which would erase the very thing being
 * measured — fails the gate instead of passing quietly.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { TreeSitterTSExtractor } from '../../analyzer/core/tree-sitter-ts-extractor';
import { BaselineTreeSitterTSExtractor } from '../baselines/tree-sitter-ts-extractor.baseline';
import { CorpusFile, defaultCorpus } from './extractor-corpus';
import {
  AllowedDivergence,
  INTENTIONAL_DIVERGENCES,
  isAllowed,
} from './extractor-parity-allowlist';
import {
  DivergenceKind,
  StructuralDivergence,
  diffStructural,
  pathShape,
  renderValue,
} from './structural-diff';

export const BASELINE_MODULE_PATH = path.join(
  __dirname,
  '..',
  'baselines',
  'tree-sitter-ts-extractor.baseline.ts',
);

export const BASELINE_HASH_PATH = path.join(
  __dirname,
  '..',
  'baselines',
  'tree-sitter-ts-extractor.baseline.hash.json',
);

export function hashBaselineModule(): string {
  const bytes = fs.readFileSync(BASELINE_MODULE_PATH);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function pinnedBaselineHash(): { sha256: string; sourceCommit: string; note: string } {
  return JSON.parse(fs.readFileSync(BASELINE_HASH_PATH, 'utf8'));
}

export interface FileDivergence {
  /** Repo-relative corpus path. */
  file: string;
  /** Divergences found in this file, in depth-first source order. */
  divergences: StructuralDivergence[];
  /** True when the harness could not even run one of the two extractors. */
  threw?: { side: 'baseline' | 'current'; message: string };
}

export interface ParityRunSummary {
  corpusSize: number;
  corpusBytes: number;
  filesCompared: number;
  filesDiverging: number;
  filesThrowing: number;
  /** Divergences by top-level fact kind (`functions`, `imports`, …). */
  byFactKind: Record<string, number>;
  /** Divergences by index-collapsed JSON path shape. */
  byPathShape: Record<string, number>;
  /** Divergences by structural kind (`value`, `length`, `type`, …). */
  byDivergenceKind: Record<DivergenceKind, number>;
  /** Files whose `hasSyntaxErrors` flag differs between the two extractors. */
  syntaxErrorFlips: Array<{ file: string; baseline: boolean; current: boolean }>;
  elapsedMs: number;
}

export interface ParityRunResult {
  summary: ParityRunSummary;
  /** Every diverging file, sorted by corpus order. */
  offenders: FileDivergence[];
  /** Divergences not covered by the allowlist — these fail the gate. */
  unallowed: FileDivergence[];
}

export interface ParityRunOptions {
  corpus?: CorpusFile[];
  allowlist?: AllowedDivergence[];
  /** Max divergences recorded per file before moving on. */
  perFileDivergenceLimit?: number;
  /** Called after each file, for progress reporting on long runs. */
  onProgress?: (done: number, total: number, file: string) => void;
}

/**
 * The extractor's own file-read path is not part of what is being compared, and
 * reading each file twice would double the I/O for no signal. Read once, feed
 * the identical string to both implementations via `extractFromSource`, so any
 * difference observed is attributable to extraction logic alone.
 */
export function runExtractorParity(options: ParityRunOptions = {}): ParityRunResult {
  const corpus = options.corpus ?? defaultCorpus();
  const allowlist = options.allowlist ?? INTENTIONAL_DIVERGENCES;
  const perFileLimit = options.perFileDivergenceLimit ?? 5;

  const baselineExtractor = new BaselineTreeSitterTSExtractor();
  const currentExtractor = new TreeSitterTSExtractor();

  const offenders: FileDivergence[] = [];
  const byFactKind: Record<string, number> = {};
  const byPathShape: Record<string, number> = {};
  const byDivergenceKind = {
    'missing-in-current': 0,
    'extra-in-current': 0,
    length: 0,
    type: 0,
    value: 0,
  } as Record<DivergenceKind, number>;
  const syntaxErrorFlips: ParityRunSummary['syntaxErrorFlips'] = [];

  let corpusBytes = 0;
  let filesCompared = 0;
  let filesThrowing = 0;
  const started = Date.now();

  for (let i = 0; i < corpus.length; i++) {
    const entry = corpus[i];
    corpusBytes += entry.size;

    let source: string;
    try {
      source = fs.readFileSync(entry.absolutePath, 'utf8');
    } catch {
      continue;
    }

    let baselineOut: unknown;
    let currentOut: unknown;
    try {
      baselineOut = baselineExtractor.extractFromSource(source, entry.absolutePath);
    } catch (error: any) {
      filesThrowing++;
      offenders.push({
        file: entry.relativePath,
        divergences: [],
        threw: { side: 'baseline', message: String(error?.message ?? error) },
      });
      options.onProgress?.(i + 1, corpus.length, entry.relativePath);
      continue;
    }
    try {
      currentOut = currentExtractor.extractFromSource(source, entry.absolutePath);
    } catch (error: any) {
      filesThrowing++;
      offenders.push({
        file: entry.relativePath,
        divergences: [],
        threw: { side: 'current', message: String(error?.message ?? error) },
      });
      options.onProgress?.(i + 1, corpus.length, entry.relativePath);
      continue;
    }

    filesCompared++;

    const divergences = diffStructural(baselineOut, currentOut, perFileLimit);
    if (divergences.length > 0) {
      offenders.push({ file: entry.relativePath, divergences });
      for (const d of divergences) {
        const shape = pathShape(d.path);
        const factKind = shape.split(/[.[]/)[0] || '<root>';
        byFactKind[factKind] = (byFactKind[factKind] ?? 0) + 1;
        byPathShape[shape] = (byPathShape[shape] ?? 0) + 1;
        byDivergenceKind[d.kind]++;
      }
    }

    const bFlag = (baselineOut as any)?.hasSyntaxErrors;
    const cFlag = (currentOut as any)?.hasSyntaxErrors;
    if (bFlag !== cFlag) {
      syntaxErrorFlips.push({
        file: entry.relativePath,
        baseline: Boolean(bFlag),
        current: Boolean(cFlag),
      });
    }

    options.onProgress?.(i + 1, corpus.length, entry.relativePath);
  }

  const unallowed: FileDivergence[] = [];
  for (const offender of offenders) {
    if (offender.threw) {
      unallowed.push(offender);
      continue;
    }
    const remaining = offender.divergences.filter(
      d => !isAllowed(offender.file, pathShape(d.path), allowlist),
    );
    if (remaining.length > 0) unallowed.push({ ...offender, divergences: remaining });
  }

  return {
    summary: {
      corpusSize: corpus.length,
      corpusBytes,
      filesCompared,
      filesDiverging: offenders.filter(o => !o.threw).length,
      filesThrowing,
      byFactKind,
      byPathShape,
      byDivergenceKind,
      syntaxErrorFlips,
      elapsedMs: Date.now() - started,
    },
    offenders,
    unallowed,
  };
}

/**
 * Actionable failure text: the first `maxFiles` offenders, each reduced to its
 * FIRST divergence with the structural JSON path and both values. No blob diff
 * — the reader gets a path they can jump to and two values they can compare.
 */
export function formatFailure(result: ParityRunResult, maxFiles = 10): string {
  const lines: string[] = [];
  const { summary, unallowed } = result;

  lines.push(
    `extractor differential parity FAILED: ${unallowed.length} of ${summary.filesCompared} corpus files diverge ` +
      `(${summary.corpusSize} files enumerated, ${(summary.corpusBytes / 1024 / 1024).toFixed(1)} MiB, ${summary.elapsedMs}ms)`,
  );
  lines.push('');
  lines.push(`first ${Math.min(maxFiles, unallowed.length)} diverging files:`);

  for (const offender of unallowed.slice(0, maxFiles)) {
    if (offender.threw) {
      lines.push(`  ${offender.file}`);
      lines.push(`    ${offender.threw.side} extractor THREW: ${offender.threw.message}`);
      continue;
    }
    const first = offender.divergences[0];
    lines.push(`  ${offender.file}`);
    lines.push(`    path     ${first.path}   (${first.kind})`);
    lines.push(`    baseline ${renderValue(first.baseline)}`);
    lines.push(`    current  ${renderValue(first.current)}`);
    if (offender.divergences.length > 1) {
      lines.push(`    (+${offender.divergences.length - 1} more in this file)`);
    }
  }

  if (unallowed.length > maxFiles) {
    lines.push(`  … and ${unallowed.length - maxFiles} more diverging files`);
  }

  lines.push('');
  lines.push('divergences by fact kind:');
  for (const [kind, count] of Object.entries(summary.byFactKind).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${count.toString().padStart(6)}  ${kind}`);
  }

  return lines.join('\n');
}

/** Full categorized report, for the CLI target rather than the assertion. */
export function formatReport(result: ParityRunResult, maxExamplesPerShape = 3): string {
  const { summary, offenders } = result;
  const lines: string[] = [];

  lines.push('# tree-sitter TS extractor — old vs new differential parity');
  lines.push('');
  lines.push(`corpus files          ${summary.corpusSize}`);
  lines.push(`corpus bytes          ${(summary.corpusBytes / 1024 / 1024).toFixed(2)} MiB`);
  lines.push(`files compared        ${summary.filesCompared}`);
  lines.push(`files diverging       ${summary.filesDiverging}`);
  lines.push(`files throwing        ${summary.filesThrowing}`);
  lines.push(`unallowed offenders   ${result.unallowed.length}`);
  lines.push(`elapsed               ${(summary.elapsedMs / 1000).toFixed(1)}s`);
  lines.push('');

  lines.push('## divergences by fact kind');
  const factKinds = Object.entries(summary.byFactKind).sort((a, b) => b[1] - a[1]);
  if (factKinds.length === 0) lines.push('(none)');
  for (const [kind, count] of factKinds) lines.push(`${count.toString().padStart(7)}  ${kind}`);
  lines.push('');

  lines.push('## divergences by structural kind');
  for (const [kind, count] of Object.entries(summary.byDivergenceKind)) {
    if (count > 0) lines.push(`${count.toString().padStart(7)}  ${kind}`);
  }
  lines.push('');

  lines.push('## divergences by JSON path shape (with examples)');
  const shapes = Object.entries(summary.byPathShape).sort((a, b) => b[1] - a[1]);
  if (shapes.length === 0) lines.push('(none)');
  for (const [shape, count] of shapes) {
    lines.push(`### ${shape}  — ${count}`);
    let shown = 0;
    for (const offender of offenders) {
      if (shown >= maxExamplesPerShape) break;
      const hit = offender.divergences.find(d => pathShape(d.path) === shape);
      if (!hit) continue;
      lines.push(`  ${offender.file}`);
      lines.push(`    path     ${hit.path}`);
      lines.push(`    baseline ${renderValue(hit.baseline, 160)}`);
      lines.push(`    current  ${renderValue(hit.current, 160)}`);
      shown++;
    }
    lines.push('');
  }

  const throwers = offenders.filter(o => o.threw);
  if (throwers.length > 0) {
    lines.push('## extractor crashes');
    for (const t of throwers) lines.push(`  ${t.file}  [${t.threw!.side}] ${t.threw!.message}`);
    lines.push('');
  }

  if (summary.syntaxErrorFlips.length > 0) {
    lines.push('## hasSyntaxErrors flips');
    for (const flip of summary.syntaxErrorFlips) {
      lines.push(`  ${flip.file}  baseline=${flip.baseline} current=${flip.current}`);
    }
    lines.push('');
  }

  lines.push('## all diverging files');
  for (const offender of offenders) {
    const first = offender.divergences[0];
    lines.push(
      offender.threw
        ? `  ${offender.file}  THREW(${offender.threw.side}): ${offender.threw.message}`
        : `  ${offender.file}  ${first.path}  (${first.kind})  baseline=${renderValue(first.baseline, 80)} current=${renderValue(first.current, 80)}`,
    );
  }

  return lines.join('\n');
}
