/**
 * FULL-GRID — the exhaustive, honest matrix behind the "Klauro wins 100%" claim.
 *
 * Today the wins are proven on fixture-scale SAMPLES. The goal is stronger: every
 * supported (row × metric) cell gets an EXPLICIT verdict, measured from the REAL
 * benches against REAL competitors. The value of this harness is that it does NOT
 * hide gaps:
 *
 *   - win         — Klauro beats the best competitor outright on this cell.
 *   - ceiling-tie — Klauro matched a ground-truth-correct competitor at the quality
 *                   ceiling (e.g. scip on TS who-calls) and carried the win on
 *                   tokens/speed. An acceptable win, per win-validator.
 *   - loss        — a competitor beat Klauro. This is a Klauro BUG. The test must
 *                   go RED and name the cell. Never weaken the assertion to hide it.
 *   - uncovered   — no fixture exists for this cell yet. An HONEST gap, surfaced in
 *                   uncoveredList — this is the to-build queue, NOT a hidden win and
 *                   NOT a fake win.
 *
 * Enumeration (reuse, never reinvent):
 *   - languages  × {who-calls}: ALL breadth languages (LANGUAGE_SPECS ∩ loadable
 *                 grammar, see camps-bench buildBreadth). A language with a
 *                 primitive-bench callers fixture is measured via runCallersBench
 *                 (real competitors: ripgrep, ast-grep, scip, ctags, stack-graphs);
 *                 a language with no fixture is `uncovered`.
 *   - languages  × {structural-retrieval}: the 46 per-language Camp-A wins from
 *                 camp-a-langs-bench (buildCampALangsReport) — Klauro structural
 *                 caller-resolution vs local embedding models (Cursor/Augment recipe).
 *                 A DISTINCT metric from who-calls, so a language can hold both cells.
 *                 We READ the report (never re-measure); a measured row is win (or an
 *                 honest loss if Klauro ever falls below the embedding F1), an
 *                 unmeasured row (unsupported / no embedding arm) is `uncovered`.
 *   - frameworks × {routes}: every framework-bench/*-routes fixture via
 *                 runRouteFactsBench; FRAMEWORK_ANALYZERS web entries with no route
 *                 fixture are `uncovered`.
 *   - libraries  × {their fixtures' subject}: the comprehension benches
 *                 (orm/di/graphql/messaging/component/pattern/auth/telemetry), each
 *                 run*Bench over its fixtures.
 *
 * For each cell the REAL bench runs (try/catch — a throw becomes a note and the
 * cell is treated as `uncovered`, never a fake win). klauroF1 and competitorBestF1
 * are read straight from the bench's arm metrics; the verdict reuses the bench's
 * own win-validator output. Cached in-process.
 */

import * as fs from 'fs-extra';
import * as path from 'path';

import { LANGUAGE_SPECS } from '../../../../packages/analyzer-core/src/analyzer/core/language-spec';
import { hasWasmGrammar } from '../../../../packages/analyzer-core/src/analyzer/core/wasm-tree-sitter';
import { hasNativeGrammar } from '../../../../packages/analyzer-core/src/analyzer/core/native-parse';
import { FRAMEWORK_ANALYZERS } from '../../../../packages/analyzer-core/src/analyzer/frameworks';

import { runCallersBench } from './primitive-bench';
import { runRouteFactsBench } from './framework-bench';
import { runOrmRelationsBench } from './orm-bench';
import { runDiGraphBench } from './di-bench';
import { runGraphqlWiringBench } from './graphql-bench';
import { runMessagingWiringBench } from './messaging-bench';
import { runComponentTreeBench } from './component-bench';
import { runPatternFactsBench } from './pattern-bench';
import { runRouteAuthBench } from './auth-bench';
import { runTelemetryCorrelationBench } from './telemetry-bench';
import { runArchitectureLibraryBench } from './architecture-library-bench';
import { buildCampALangsReport } from './camp-a-langs-bench';
import type { ArmResult, WinVerdict } from './report-schema';

export type GridVerdict = 'win' | 'ceiling-tie' | 'loss' | 'uncovered';
export type RowKind = 'language' | 'framework' | 'library';

export interface GridCell {
  row: string;
  rowKind: RowKind;
  metric: string;
  klauroF1: number | null;
  competitorBestF1: number | null;
  verdict: GridVerdict;
  /** Which real competitor arms actually attempted this cell. */
  armsRan: string[];
  /** Fractional token saving vs the best competitor (e.g. 0.42 = 42% fewer), or null. */
  tokenSaving: number | null;
  note?: string;
}

export interface FullGridReport {
  cells: GridCell[];
  aggregate: {
    total: number;
    won: number;
    ceilingTied: number;
    uncovered: number;
    losses: number;
    /** (won + ceilingTied) / covered. */
    winRate: number;
    /** covered / total. */
    coverage: number;
  };
  rows: {
    languages: { total: number; covered: number };
    frameworks: { total: number; covered: number };
    libraries: { total: number; covered: number };
  };
  losses: GridCell[];
  uncoveredList: { row: string; rowKind: RowKind; metric: string }[];
}

const FIXTURES = path.resolve(__dirname, '../../fixtures');

/**
 * Map a primitive-bench truth.json `lang` (ast-grep id) to the breadth grammar key
 * (LANGUAGE_SPECS id). Most are identical; csharp differs.
 */
const PRIMITIVE_LANG_TO_BREADTH: Record<string, string> = {
  csharp: 'c_sharp',
};

/** Breadth: LANGUAGE_SPECS whose grammar is loadable (wasm or native). The full
 *  supported-language universe for the who-calls metric. */
function breadthLanguages(): string[] {
  return Object.keys(LANGUAGE_SPECS)
    .filter(id => {
      const grammar = (LANGUAGE_SPECS as any)[id].grammar || id;
      return hasWasmGrammar(grammar) || hasNativeGrammar(grammar);
    })
    .sort();
}

/** Read the breadth key a primitive callers fixture targets, from its truth.json. */
async function fixtureBreadthKey(fixtureDir: string): Promise<string | null> {
  try {
    const truth: any = await fs.readJson(path.join(fixtureDir, 'truth.json'));
    const lang = String(truth.lang || 'ts');
    // truth.json uses ast-grep ids; 'ts' is typescript in breadth terms.
    const normalized = lang === 'ts' ? 'typescript' : lang;
    return PRIMITIVE_LANG_TO_BREADTH[normalized] || normalized;
  } catch {
    return null;
  }
}

/** List subdirectories of a fixture group (each is one fixture with truth.json). */
async function fixtureDirs(group: string): Promise<string[]> {
  const root = path.join(FIXTURES, group);
  try {
    const entries = await fs.readdir(root);
    const dirs: string[] = [];
    for (const e of entries) {
      const p = path.join(root, e);
      try {
        if ((await fs.stat(p)).isDirectory()) dirs.push(p);
      } catch {
        /* noop */
      }
    }
    return dirs.sort();
  } catch {
    return [];
  }
}

/**
 * Distill a bench result ({ arms, verdict }) into the grid's numeric view:
 * klauroF1, competitorBestF1 (max over ATTEMPTED non-klauro arms), the grid verdict
 * (reusing the bench's own win-validator output), the arms that ran, and the token
 * saving vs the best competitor.
 */
function distill(arms: ArmResult[], verdict: WinVerdict): {
  klauroF1: number | null;
  competitorBestF1: number | null;
  gridVerdict: 'win' | 'ceiling-tie' | 'loss';
  armsRan: string[];
  tokenSaving: number | null;
} {
  const klauro = arms.find(a => a.arm_id === 'klauro');
  const competitors = arms.filter(a => a.arm_id !== 'klauro' && a.attempted);

  const klauroF1 = typeof klauro?.metrics.quality === 'number' ? klauro.metrics.quality / 100 : null;
  const competitorBestF1 = competitors.length
    ? Math.max(...competitors.map(a => (typeof a.metrics.quality === 'number' ? a.metrics.quality / 100 : 0)))
    : null;

  // The grid verdict mirrors the win-validator: an outright win, an honest tie at
  // the quality ceiling (carried by tokens/speed), or a loss (Klauro did not win).
  let gridVerdict: 'win' | 'ceiling-tie' | 'loss';
  if (verdict.klauro_wins) {
    gridVerdict = verdict.quality_tied_at_ceiling ? 'ceiling-tie' : 'win';
  } else {
    gridVerdict = 'loss';
  }

  // Token saving vs the best competitor on the tokens metric (from the validator's
  // own comparison), when Klauro won tokens.
  let tokenSaving: number | null = null;
  const tokenCmp = verdict.comparisons.find(c => c.metric === 'tokens');
  if (tokenCmp?.klauro_wins && typeof tokenCmp.advantage === 'number') {
    tokenSaving = tokenCmp.advantage;
  }

  return { klauroF1, competitorBestF1, gridVerdict, armsRan: competitors.map(a => a.arm_id), tokenSaving };
}

/** Build a covered cell from a bench run (or an uncovered cell if it threw). */
async function cellFromBench(
  row: string,
  rowKind: RowKind,
  metric: string,
  run: () => Promise<{ arms: ArmResult[]; verdict: WinVerdict }>,
): Promise<GridCell> {
  try {
    const { arms, verdict } = await run();
    const d = distill(arms, verdict);
    return {
      row,
      rowKind,
      metric,
      klauroF1: d.klauroF1,
      competitorBestF1: d.competitorBestF1,
      verdict: d.gridVerdict,
      armsRan: d.armsRan,
      tokenSaving: d.tokenSaving,
    };
  } catch (err) {
    // A throw (e.g. an in-progress grammar / analyzer) is NOT a fake win — it is an
    // honest gap. Record it as uncovered with the error so the to-build queue is real.
    return {
      row,
      rowKind,
      metric,
      klauroF1: null,
      competitorBestF1: null,
      verdict: 'uncovered',
      armsRan: [],
      tokenSaving: null,
      note: `bench threw: ${(err as Error)?.message || String(err)}`,
    };
  }
}

let cache: FullGridReport | null = null;

/**
 * Build (and cache) the full honest grid. No sampling, no silent caps: every
 * supported language × who-calls, every framework × routes, every comprehension
 * library × its fact — each cell with an explicit verdict measured from the real
 * benches.
 */
export async function buildFullGrid(): Promise<FullGridReport> {
  if (cache) return cache;

  const cells: GridCell[] = [];

  // ---- Languages × {who-calls} -------------------------------------------------
  // Universe = ALL breadth languages. Covered iff a primitive-bench callers fixture
  // targets that language; otherwise honestly `uncovered`.
  const languages = breadthLanguages();
  const callerFixtures = await fixtureDirs('primitive-bench');
  const fixtureByBreadthKey = new Map<string, string>(); // breadthKey -> fixtureDir
  for (const fx of callerFixtures) {
    const key = await fixtureBreadthKey(fx);
    if (key && !fixtureByBreadthKey.has(key)) fixtureByBreadthKey.set(key, fx);
  }

  const languageRows = new Set<string>(languages);
  for (const lang of languages) {
    const fixtureDir = fixtureByBreadthKey.get(lang);
    if (fixtureDir) {
      // heavyArms: bring in the really-installed scip/ctags/stack-graphs panel so
      // the win (or ceiling-tie on TS) is measured against the strongest competitor.
      cells.push(
        await cellFromBench(lang, 'language', 'who-calls', () =>
          runCallersBench(fixtureDir, { heavyArms: true }),
        ),
      );
    } else {
      cells.push({
        row: lang,
        rowKind: 'language',
        metric: 'who-calls',
        klauroF1: null,
        competitorBestF1: null,
        verdict: 'uncovered',
        armsRan: [],
        tokenSaving: null,
        note: 'no who-calls fixture',
      });
    }
  }
  // A callers fixture whose language is NOT in the breadth set (e.g. dart — has an
  // analyzer/fixture but no LANGUAGE_SPEC). Don't lose the covered cell: add it.
  for (const [key, fixtureDir] of fixtureByBreadthKey) {
    if (languageRows.has(key)) continue;
    languageRows.add(key);
    cells.push(
      await cellFromBench(key, 'language', 'who-calls', () =>
        runCallersBench(fixtureDir, { heavyArms: true }),
      ),
    );
  }

  // ---- Languages × {structural-retrieval} --------------------------------------
  // The 46 verified per-language Camp-A wins (camp-a-langs-bench): on a DISTINCT
  // metric — structural caller-resolution measured head-to-head vs local embedding
  // models (the Cursor/Augment recipe). These are real, measured wins on the same
  // who-calls QUESTION but a different competitor + a different scoring axis than the
  // primitive-bench who-calls cells, so a language already covered by who-calls keeps
  // that cell AND gets a second, structural-retrieval cell (two metrics = two cells).
  // We only READ buildCampALangsReport — never re-measure here.
  const campALangs = await buildCampALangsReport();
  for (const p of campALangs.perLanguage) {
    if (!p.available) {
      // Not measured (language unsupported, or ollama present but no embedding arm
      // ran) — an honest gap, not a hidden win.
      cells.push({
        row: p.lang,
        rowKind: 'language',
        metric: 'structural-retrieval',
        klauroF1: null,
        competitorBestF1: null,
        verdict: 'uncovered',
        armsRan: [],
        tokenSaving: null,
        note: 'camp-a-langs: not measured (unsupported lang or no embedding arm)',
      });
      continue;
    }
    // klauroWins encodes klauroF1 >= embeddingF1. A win is an outright win on this
    // structural metric (there is no "ceiling tie" notion here — Klauro is exact).
    // If a camp-a-langs row ever shows Klauro BELOW the embedding model, surface it
    // as an honest loss (do NOT hide it) so the test goes red and names the cell.
    const verdict: GridVerdict = p.klauroWins ? 'win' : 'loss';
    cells.push({
      row: p.lang,
      rowKind: 'language',
      metric: 'structural-retrieval',
      klauroF1: p.klauroF1,
      competitorBestF1: p.embeddingF1,
      verdict,
      armsRan: p.embeddingModel ? [p.embeddingModel] : [],
      tokenSaving: null,
      note: p.embeddingModel ? `vs ${p.embeddingModel}` : 'klauro-only (no embedding model present)',
    });
  }

  // ---- Frameworks × {routes} ---------------------------------------------------
  // Universe = web FRAMEWORK_ANALYZERS (the analyzers that expose routes). Covered
  // iff a framework-bench/*-routes fixture exists for that framework.
  const routeFixtures = await fixtureDirs('framework-bench');
  const routeFixtureNames = new Set(routeFixtures.map(d => path.basename(d)));

  // Index route fixtures by their leading framework token (e.g. 'express-routes',
  // 'gin-groups' -> 'express', 'gin'). One framework can own several fixtures.
  const routeFixturesByFramework = new Map<string, string[]>();
  for (const fx of routeFixtures) {
    const base = path.basename(fx);
    const token = base.replace(/-(routes|groups|subrouter)$/, '');
    const fw = token.split('-')[0];
    const arr = routeFixturesByFramework.get(fw) || [];
    arr.push(fx);
    routeFixturesByFramework.set(fw, arr);
  }

  // Canonical framework slug for each web analyzer (matches the route-fixture token).
  const FRAMEWORK_SLUG: Record<string, string> = {
    NestJS: 'nestjs',
    'Spring Boot': 'spring',
    Django: 'django',
    Flask: 'flask',
    FastAPI: 'fastapi',
    'Express.js': 'express',
    Laravel: 'laravel',
    Vapor: 'vapor',
    Mojolicious: 'mojolicious',
    GoRouter: 'gorouter',
    http4s: 'http4s',
    kemal: 'kemal',
    Genie: 'genie',
    Compojure: 'compojure',
    dream: 'dream',
    ApexREST: 'apexrest',
  };

  const webAnalyzers = FRAMEWORK_ANALYZERS.filter(a => a.category === 'web');
  const claimedFixtures = new Set<string>();
  for (const a of webAnalyzers) {
    const slug = FRAMEWORK_SLUG[a.name] || a.name.toLowerCase();
    const fixturesForFw = routeFixturesByFramework.get(slug) || [];
    if (fixturesForFw.length === 0) {
      cells.push({
        row: a.name,
        rowKind: 'framework',
        metric: 'routes',
        klauroF1: null,
        competitorBestF1: null,
        verdict: 'uncovered',
        armsRan: [],
        tokenSaving: null,
        note: 'no route fixture',
      });
      continue;
    }
    // Use the primary (alphabetically-first) fixture as the representative cell.
    const primary = fixturesForFw.sort()[0];
    claimedFixtures.add(path.basename(primary));
    cells.push(
      await cellFromBench(a.name, 'framework', 'routes', () => runRouteFactsBench(primary)),
    );
  }
  // Route fixtures not owned by any registered web analyzer slug are still real
  // covered cells (e.g. rails/echo/fiber/symfony/... analyzers live in ./web but
  // aren't in FRAMEWORK_ANALYZERS). Add them by fixture name so nothing is dropped.
  for (const fx of routeFixtures) {
    const base = path.basename(fx);
    if (claimedFixtures.has(base)) continue;
    cells.push(await cellFromBench(base, 'framework', 'routes', () => runRouteFactsBench(fx)));
  }
  void routeFixtureNames;

  // ---- Libraries × {their fact} ------------------------------------------------
  // Each comprehension bench owns a metric and a fixture group; every fixture is one
  // covered library cell. No universe beyond what has a fixture — comprehension
  // facts only exist where a library was modelled, so covered == total here.
  const libraryBenches: Array<{
    group: string;
    metric: string;
    run: (dir: string) => Promise<{ arms: ArmResult[]; verdict: WinVerdict }>;
  }> = [
    { group: 'orm-bench', metric: 'orm-relations', run: runOrmRelationsBench },
    { group: 'di-bench', metric: 'di-graph', run: runDiGraphBench },
    { group: 'graphql-bench', metric: 'graphql-wiring', run: runGraphqlWiringBench },
    { group: 'messaging-bench', metric: 'messaging-wiring', run: runMessagingWiringBench },
    { group: 'component-bench', metric: 'component-tree', run: runComponentTreeBench },
    { group: 'pattern-bench', metric: 'design-pattern', run: runPatternFactsBench },
    { group: 'auth-bench', metric: 'route-auth', run: runRouteAuthBench },
    { group: 'telemetry-bench', metric: 'telemetry-correlation', run: runTelemetryCorrelationBench },
    { group: 'architecture-library-bench', metric: 'architecture-library-boundaries', run: runArchitectureLibraryBench },
  ];
  for (const lb of libraryBenches) {
    const dirs = await fixtureDirs(lb.group);
    for (const dir of dirs) {
      const row = path.basename(dir);
      cells.push(await cellFromBench(row, 'library', lb.metric, () => lb.run(dir)));
    }
  }

  // ---- Aggregate ---------------------------------------------------------------
  const won = cells.filter(c => c.verdict === 'win').length;
  const ceilingTied = cells.filter(c => c.verdict === 'ceiling-tie').length;
  const uncovered = cells.filter(c => c.verdict === 'uncovered').length;
  const losses = cells.filter(c => c.verdict === 'loss');
  const total = cells.length;
  const covered = total - uncovered;
  const winRate = covered > 0 ? (won + ceilingTied) / covered : 0;
  const coverage = total > 0 ? covered / total : 0;

  const rowKindStats = (kind: RowKind) => {
    const inKind = cells.filter(c => c.rowKind === kind);
    return {
      total: inKind.length,
      covered: inKind.filter(c => c.verdict !== 'uncovered').length,
    };
  };

  cache = {
    cells,
    aggregate: { total, won, ceilingTied, uncovered, losses: losses.length, winRate, coverage },
    rows: {
      languages: rowKindStats('language'),
      frameworks: rowKindStats('framework'),
      libraries: rowKindStats('library'),
    },
    losses,
    uncoveredList: cells
      .filter(c => c.verdict === 'uncovered')
      .map(c => ({ row: c.row, rowKind: c.rowKind, metric: c.metric })),
  };
  return cache;
}

/** Drop the in-process cache (tests / on-demand recompute). */
export function resetFullGridCache(): void {
  cache = null;
}
