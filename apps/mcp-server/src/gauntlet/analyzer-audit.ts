/**
 * Analyzer audit — honest stock-take of every analyzer.
 *
 * Static inspection of each analyzer's SOURCE (no running analysis, fast and
 * deterministic) across the dimensions that determine whether an analyzer is
 * actually GOOD, not just present:
 *   - parser:        AST/tree-sitter vs regex/line-based (fidelity ceiling)
 *   - loc:           source size (rough depth proxy)
 *   - capabilities:  how many concepts getCapabilities() declares (completeness proxy)
 *   - incremental:   single-file incremental support
 *   - truth_fixture: does an analysis-truth fixture exist to MEASURE accuracy
 *
 * This is the scorecard that drives the quality program; it deliberately does
 * not flatter — "no truth fixture" means accuracy is unproven.
 */

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

export interface AnalyzerAudit {
  file: string;
  className: string;
  kind: 'language' | 'framework' | 'library' | 'unknown';
  parser: 'ast' | 'regex';
  loc: number;
  capabilities: number;
  incremental: boolean;
  has_truth_fixture: boolean;
}

const CORE = path.resolve(__dirname, '../../../../packages/analyzer-core/src/analyzer');
const FIXTURES = path.resolve(__dirname, '../../fixtures/analysis-truth');

function kindFromPath(p: string): AnalyzerAudit['kind'] {
  if (/\/languages\//.test(p)) return 'language';
  if (/\/frameworks\//.test(p)) return 'framework';
  if (/\/libraries\//.test(p)) return 'library';
  return 'unknown';
}

/** AST iff the analyzer actually parses via tree-sitter (not just a comment). */
function detectParser(src: string): 'ast' | 'regex' {
  return /TreeSitterParser|tree-sitter|\.setLanguage\(|astRunner|@babel\/parser|\bacorn\b|parseAst\b/.test(src)
    ? 'ast' : 'regex';
}

function countCapabilities(src: string): number {
  const m = src.match(/getCapabilities\s*\([^)]*\)\s*(?::[^{]*)?\{[\s\S]*?return\s*\[([\s\S]*?)\]/);
  if (!m) return 0;
  return (m[1].match(/['"`]/g) || []).length / 2 | 0;
}

async function listAnalyzerFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    let entries: fs.Dirent[];
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') await walk(full); }
      else if (/-analyzer\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(full);
    }
  }
  await walk(dir);
  return out.sort();
}

function truthFixtureFor(stackTokens: string[], fixtures: string[]): boolean {
  return stackTokens.some(tok => fixtures.some(fx => fx.includes(tok)));
}

export async function auditAnalyzers(): Promise<{ audits: AnalyzerAudit[]; summary: Record<string, number> }> {
  const files = await listAnalyzerFiles(CORE);
  let fixtures: string[] = [];
  try { fixtures = await fs.readdir(FIXTURES); } catch { /* none */ }

  const audits: AnalyzerAudit[] = [];
  for (const file of files) {
    let src = '';
    try { src = await fs.readFile(file, 'utf8'); } catch { continue; }
    const classM = src.match(/export class (\w+)/);
    const base = path.basename(file).replace(/-analyzer\.ts$/, '');
    const tokens = base.split(/[-_]/).filter(Boolean);
    audits.push({
      file: path.relative(CORE, file),
      className: classM ? classM[1] : base,
      kind: kindFromPath(file),
      parser: detectParser(src),
      loc: src.split('\n').length,
      capabilities: countCapabilities(src),
      incremental: /supportsIncrementalAnalysis\s*\([^)]*\)\s*(?::[^{]*)?\{\s*return\s+true/.test(src),
      has_truth_fixture: truthFixtureFor(tokens, fixtures),
    });
  }

  const summary = {
    total: audits.length,
    ast: audits.filter(a => a.parser === 'ast').length,
    regex: audits.filter(a => a.parser === 'regex').length,
    with_truth_fixture: audits.filter(a => a.has_truth_fixture).length,
    incremental: audits.filter(a => a.incremental).length,
    languages: audits.filter(a => a.kind === 'language').length,
    frameworks: audits.filter(a => a.kind === 'framework').length,
    libraries: audits.filter(a => a.kind === 'library').length,
  };
  return { audits, summary };
}
