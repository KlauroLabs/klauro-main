/**
 * Analyzer quality scorer — measured precision/recall against a hand-curated
 * truth fixture. This is the bar that turns "is the analyzer GOOD?" from an
 * assertion into a number, per concept category (functions, classes, calls,
 * includes, entities, routes…).
 *
 * A truth fixture is a small project dir with an expected.json listing the
 * ground-truth symbols/edges. We run the analyzer through the orchestrator and
 * compare. Precision = correct/produced; Recall = correct/expected; F1 the
 * harmonic mean. Low recall = missing concepts (incomplete); low precision =
 * false positives (unsound).
 */

import * as path from 'path';
import * as fs from 'fs-extra';
import { analyzeForBench } from './product-analysis';

export interface CategoryScore {
  category: string;
  expected: number;
  produced: number;
  correct: number;          // # expected concepts matched (drives recall)
  correctProduced: number;  // # produced nodes that matched an expected (drives precision)
  precision: number;
  recall: number;
  f1: number;
  missing: string[];
  spurious: string[];
}

export interface QualityReport {
  fixture: string;
  stack: string;
  categories: CategoryScore[];
  overall: { precision: number; recall: number; f1: number };
}

/** Normalize a symbol name for matching: lowercase, strip Elixir arity (/2),
 *  call signatures (...), and a leading dotted namespace so `Query.user` ↔ `user`
 *  and `add/2` ↔ `add`. Keeps the comparison about the concept, not the vocab. */
function norm(s: string): string {
  return s.toLowerCase().replace(/\/\d+$/, '').replace(/\(.*\)$/, '').trim();
}
/** Node-aware scoring. Each produced item is ONE node carrying alternate names
 *  (e.g. [name, qualified_name]); it matches an expected symbol if ANY alternate
 *  matches (normalized, trailing-segment aware). So qualified names help recall
 *  without inflating the produced count (which would fake-deflate precision). */
function score(expected: string[], produced: string[][]): Omit<CategoryScore, 'category'> {
  const exp = expected.map(norm);
  const tail = (s: string) => s.split(/[.#:]/).pop() || s;
  const items = produced.map(alts => alts.map(norm));
  const itemMatchesExpected = (alts: string[], e: string) =>
    alts.some(a => a === e || tail(a) === e || a === tail(e) || tail(a) === tail(e));
  const matchedExp = exp.filter(e => items.some(alts => itemMatchesExpected(alts, e)));
  const correctItems = items.filter(alts => exp.some(e => itemMatchesExpected(alts, e)));
  const precision = items.length ? correctItems.length / items.length : (exp.length ? 0 : 1);
  const recall = exp.length ? matchedExp.length / exp.length : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    expected: exp.length, produced: items.length, correct: matchedExp.length,
    correctProduced: correctItems.length,
    precision: round(precision), recall: round(recall), f1: round(f1),
    missing: exp.filter(e => !items.some(alts => itemMatchesExpected(alts, e))),
    spurious: items.filter(alts => !exp.some(e => itemMatchesExpected(alts, e))).map(a => a[0]),
  };
}
function round(n: number): number { return Math.round(n * 100) / 100; }

function truthRoot(): string {
  return path.resolve(__dirname, '../../fixtures/analysis-truth');
}

/** Score every fixture under fixtures/analysis-truth/* that has an expected.json. */
export async function scoreAllFixtures(): Promise<QualityReport[]> {
  const root = truthRoot();
  let dirs: string[] = [];
  try { dirs = await fs.readdir(root); } catch { return []; }
  const reports: QualityReport[] = [];
  for (const d of dirs.sort()) {
    const dir = path.join(root, d);
    if (!(await fs.pathExists(path.join(dir, 'expected.json')))) continue;
    try { reports.push(await scoreFixture(dir)); } catch (err) {
      reports.push({ fixture: d, stack: d, categories: [], overall: { precision: 0, recall: 0, f1: 0 } });
    }
  }
  return reports;
}

/** Score one analysis-truth fixture (must contain expected.json). */
export async function scoreFixture(fixtureDir: string): Promise<QualityReport> {
  const expected = await fs.readJson(path.join(fixtureDir, 'expected.json'));
  // Fresh orchestrator per fixture: the shared singleton leaks state across
  // analyses in one process, which made aggregate scores nondeterministic
  // (e.g. elixir flipping 1.0↔0.92 by run order). Isolation = trustworthy numbers.
  const cas: any = await analyzeForBench(fixtureDir);
  const nodes: any[] = cas.nodes || [];
  const edges: any[] = cas.edges || [];

  // Match on BOTH name and qualified_name so e.g. an Elixir module emitted as
  // name 'Math' / qualified_name 'App.Math' still satisfies expected 'App.Math'.
  const nodeNames = (pred: (n: any) => boolean): string[][] => nodes.filter(pred)
    .map(n => [n.name, n.qualified_name].filter(Boolean).map(String));
  const edgePairs = (type: RegExp) => edges
    .filter(e => type.test(String(e.type || '')))
    .map(e => {
      const s = nodes.find(n => n.id === (e.source || e.from));
      const t = nodes.find(n => n.id === (e.target || e.to));
      return [String(s?.name || '').toLowerCase(), String(t?.name || '').toLowerCase()].join('→');
    });

  // Inclusive type predicates — analyzers use different node-type vocab for the
  // same concept (module/contract/namespace are all "type-like containers";
  // table/schema/dto are all entities). Matching is by NAME within the right
  // family, so this stays a fair precision/recall test, not a type-name gotcha.
  const FN = (n: any) => /function|method|procedure|rpc|operation|instruction|action/.test(String(n.type));
  const TYPE = (n: any) => /class|interface|struct|enum|module|namespace|contract|protocol|component|service|controller|trait/.test(String(n.type));
  const ENTITY = (n: any) => /entity|data-entity|table|schema|dto|model/.test(String(n.type));
  const ROUTE = (n: any) => /route|endpoint|operation|rpc/.test(String(n.type));

  const cats: CategoryScore[] = [];
  if (expected.functions) cats.push({ category: 'functions', ...score(expected.functions, nodeNames(FN)) });
  if (expected.classes) cats.push({ category: 'types', ...score(expected.classes, nodeNames(TYPE)) });
  if (expected.types) cats.push({ category: 'types', ...score(expected.types, nodeNames(TYPE)) });
  if (expected.entities) cats.push({ category: 'entities', ...score(expected.entities, nodeNames(ENTITY)) });
  if (expected.routes) cats.push({ category: 'routes', ...score(expected.routes, nodeNames(ROUTE)) });
  if (expected.calls) cats.push({ category: 'calls', ...score(expected.calls.map((c: string[]) => c.join('→')), edgePairs(/call|invoke/).map(p => [p])) });
  // Relations = entity↔entity associations only (NOT has_field column ownership).
  if (expected.relations) cats.push({ category: 'relations', ...score(expected.relations.map((c: string[]) => c.join('→')), edgePairs(/relat|references|belongs|foreign|association/).map(p => [p])) });
  if (expected.includes) cats.push({
    category: 'includes',
    ...score(expected.includes.map((c: string[]) => c.map((x: string) => x.split('/').pop()).join('→').toLowerCase()),
      edges.filter(e => /import|include|depend/.test(String(e.type || ''))).map(e => {
        const s = nodes.find(n => n.id === (e.source || e.from));
        const t = nodes.find(n => n.id === (e.target || e.to));
        return [[path.basename(String(s?.source?.file || s?.name || '')), path.basename(String(t?.source?.file || t?.name || ''))].join('→').toLowerCase()];
      })),
  });

  const sumExp = cats.reduce((a, c) => a + c.expected, 0);
  const sumProd = cats.reduce((a, c) => a + c.produced, 0);
  const sumCorrect = cats.reduce((a, c) => a + c.correct, 0);
  const sumCorrectProduced = cats.reduce((a, c) => a + c.correctProduced, 0);
  // Precision counts produced nodes that matched an expected concept (consistent
  // with per-category precision) — NOT matchedExpected/produced, which unfairly
  // penalized legitimately-distinct same-name nodes (e.g. a protocol-requirement
  // `fetch` and its implementation `fetch`, which have different qualified names).
  const precision = sumProd ? sumCorrectProduced / sumProd : 0;
  const recall = sumExp ? sumCorrect / sumExp : 0;
  return {
    fixture: path.basename(fixtureDir),
    stack: expected.stack || path.basename(fixtureDir),
    categories: cats,
    overall: { precision: round(precision), recall: round(recall), f1: round(precision + recall ? (2 * precision * recall) / (precision + recall) : 0) },
  };
}
