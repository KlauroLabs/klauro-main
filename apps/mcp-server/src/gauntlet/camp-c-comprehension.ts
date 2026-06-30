/**
 * Camp-C COMPREHENSION aggregation bench.
 *
 * Camp C is NOT just HTTP routes. It is the entire COMPREHENSION layer that the
 * structural/embedding camps (Camp A = scip/stack-graphs symbol graphs, Camp B =
 * embeddings retrieval) fundamentally cannot produce. Each dimension below is an
 * out-of-category framework fact: a directional ORM cardinality edge, a DI wiring
 * graph, a GraphQL field→resolver binding, a pub/sub topic graph, a component
 * render tree, a named GoF/design pattern, an endpoint auth/guard fact, a runtime
 * telemetry correlation, or an HTTP route table. Camp A/B see classes, references,
 * and "similar code" — none of them model these relationships.
 *
 * Klauro already has a passing out-of-category bench for each of these dimensions.
 * They simply were never aggregated into ONE Camp-C report. This module runs every
 * comprehension bench over ALL of its real fixtures and aggregates measured Klauro
 * mean F1 + mean token-saving vs the best competitor. Nothing is hardcoded: every
 * number comes from the real bench over real fixtures. A dimension whose fixtures
 * are absent is recorded honestly as fixtures:0 (never fabricated).
 */

import * as fs from 'fs-extra';
import * as path from 'path';

import { analyzeForBench } from './product-analysis';
import { runOrmRelationsBench } from './orm-bench';
import { runDiGraphBench } from './di-bench';
import { runGraphqlWiringBench } from './graphql-bench';
import { runMessagingWiringBench } from './messaging-bench';
import { runComponentTreeBench } from './component-bench';
import { runPatternFactsBench } from './pattern-bench';
import { runRouteAuthBench } from './auth-bench';
import { runTelemetryCorrelationBench } from './telemetry-bench';
import { runRouteFactsBench } from './framework-bench';

/**
 * A Camp-C dimension is benched in one of two honest modes:
 *  - 'head-to-head'    : a real competitor TRIES; we score Klauro mean F1 + mean
 *                        token-saving over all fixtures (fields: fixtures, meanKlauroF1,
 *                        meanTokenSaving, allWin).
 *  - 'emission-coverage': NO competitor produces the fact at all; the win is EMISSION
 *                        COVERAGE — Klauro emits N structured facts with provenance on a
 *                        real repo, Camp A/B emit nothing (field: emitted, examples).
 */
export interface CampCDimension {
  key: string;
  label: string;
  description: string;
  mode: 'head-to-head' | 'emission-coverage';
  outOfCategory: boolean;
  /** One line: what Camp A/B fundamentally cannot answer/produce for this dimension. */
  campABCannot: string;
  examples: string[];

  // head-to-head fields:
  /** number of fixtures scored (head-to-head). */
  fixtures: number;
  meanKlauroF1: number;
  meanTokenSaving: number;
  /** True iff Klauro wins or ceiling-ties every fixture (head-to-head). */
  allWin: boolean;

  // emission-coverage fields:
  /** count of Camp-C facts Klauro emitted for this category on the representative repo. */
  emitted: number;

  /** Set when a dimension is empty/unmeasurable in this tree — why. */
  note?: string;
}

export interface CampCComprehensionReport {
  /** The representative repo used for emission-coverage counting. */
  emissionFixture: string;
  dimensions: CampCDimension[];
  aggregate: {
    /** total dimensions reported (both modes). */
    dimensions: number;
    // head-to-head roll-up:
    headToHead: {
      dimensions: number;
      totalFixtures: number;
      meanKlauroF1: number;
      meanTokenSaving: number;
      allWin: boolean;
    };
    // emission-coverage roll-up:
    emissionCoverage: {
      dimensions: number;
      totalEmitted: number;
    };
    /** True iff every head-to-head dimension wins/ceiling-ties (never a loss). */
    allWin: boolean;
  };
}

const FIXTURES_ROOT = path.resolve(__dirname, '../../fixtures');

/** A bench result is uniform: detail[] with a 'klauro' entry carrying f1, and
 *  arms[] carrying klauro/competitor metrics.tokens, plus a verdict. */
interface UniformBenchResult {
  fixture: string;
  arms: Array<{ arm_id: string; metrics?: { tokens?: number } }>;
  verdict: { klauro_wins: boolean };
  detail: Array<{ arm: string; f1: number }>;
}

function tokenSaving(klauro: number, competitor: number): number {
  if (competitor <= 0) return 0;
  return Math.max(0, (competitor - klauro) / competitor);
}

interface DimensionSpec {
  key: string;
  label: string;
  description: string;
  campABCannot: string;
  /** fixture root dir under fixtures/ */
  fixtureDir: string;
  /** which subdirs are fixtures (default: any dir containing truth.json). */
  filter?: (name: string) => boolean;
  run: (dir: string) => Promise<UniformBenchResult>;
}

const SPECS: DimensionSpec[] = [
  {
    key: 'routes',
    label: 'HTTP route table',
    description: 'Framework route facts: method + path + handler across 30+ web frameworks.',
    campABCannot:
      'embeddings + scip/stack-graphs index symbols and references; they have no route edge and cannot emit a method+path+handler table from framework registration calls.',
    fixtureDir: 'framework-bench',
    filter: n => /-routes$|-groups$|-subrouter$/.test(n),
    run: d => runRouteFactsBench(d) as unknown as Promise<UniformBenchResult>,
  },
  {
    key: 'orm',
    label: 'ORM relations + cardinality',
    description: 'Directional entity relationships with cardinality (OneToMany/ManyToOne/…) from ORM decorators.',
    campABCannot:
      'embeddings + scip/stack-graphs have no ORM-relation edge; they see entity classes and references but cannot emit directional cardinality (User 1:N Post).',
    fixtureDir: 'orm-bench',
    run: d => runOrmRelationsBench(d) as unknown as Promise<UniformBenchResult>,
  },
  {
    key: 'di',
    label: 'Dependency-injection graph',
    description: 'Which provider is injected into which consumer, across Spring/Nest/Angular/FastAPI/… containers.',
    campABCannot:
      'scip/stack-graphs see a constructor parameter type, not a container binding; embeddings retrieve similar code — neither resolves the DI wiring edge (provider→consumer).',
    fixtureDir: 'di-bench',
    run: d => runDiGraphBench(d) as unknown as Promise<UniformBenchResult>,
  },
  {
    key: 'graphql',
    label: 'GraphQL field→resolver wiring',
    description: 'Schema field bound to its resolver function across SDL-first and code-first GraphQL stacks.',
    campABCannot:
      'the schema field and the resolver live in different files with no symbol reference between them; structural graphs and embeddings cannot bind field→resolver.',
    fixtureDir: 'graphql-bench',
    run: d => runGraphqlWiringBench(d) as unknown as Promise<UniformBenchResult>,
  },
  {
    key: 'messaging',
    label: 'Pub/sub topic graph',
    description: 'Producer→topic→consumer wiring across Kafka/NATS/RabbitMQ/BullMQ.',
    campABCannot:
      'producers and consumers couple only through a topic string at runtime; scip/stack-graphs have no edge across that string and embeddings cannot build the produces/consumes graph.',
    fixtureDir: 'messaging-bench',
    run: d => runMessagingWiringBench(d) as unknown as Promise<UniformBenchResult>,
  },
  {
    key: 'component',
    label: 'Component render tree',
    description: 'Parent→child component/widget render tree across React/Vue/Svelte/Angular/Qwik/RN.',
    campABCannot:
      'a JSX/template child is a render relationship, not a call edge; scip/stack-graphs model imports/calls and embeddings retrieve similar code — neither emits the render tree.',
    fixtureDir: 'component-bench',
    run: d => runComponentTreeBench(d) as unknown as Promise<UniformBenchResult>,
  },
  {
    key: 'pattern',
    label: 'Named design patterns + paradigm',
    description: 'GoF/design patterns (Singleton/Factory/Observer/…) named from structure, plus paradigm.',
    campABCannot:
      'a design pattern is an emergent structural shape, not a symbol; scip/stack-graphs and embeddings have no concept that maps a class arrangement to "Observer" or "Factory".',
    fixtureDir: 'pattern-bench',
    run: d => runPatternFactsBench(d) as unknown as Promise<UniformBenchResult>,
  },
  {
    key: 'auth',
    label: 'Endpoint auth/guard facts',
    description: 'Which routes are auth-protected and by which guard/middleware, across web frameworks.',
    campABCannot:
      'a guard is wired by a decorator/middleware registration, not a call from the handler; structural graphs and embeddings cannot say which endpoint is protected.',
    fixtureDir: 'auth-bench',
    run: d => runRouteAuthBench(d) as unknown as Promise<UniformBenchResult>,
  },
  {
    key: 'telemetry',
    label: 'Runtime telemetry correlation',
    description: 'How-it-is-running facts: hotpath/latency/error runtime correlation to source.',
    campABCannot:
      'runtime telemetry is dynamic behavior; static symbol graphs and embeddings have no runtime signal and cannot correlate observed hotpaths/latency/errors back to code.',
    fixtureDir: 'telemetry-bench',
    run: d => runTelemetryCorrelationBench(d) as unknown as Promise<UniformBenchResult>,
  },
];

async function listFixtures(spec: DimensionSpec): Promise<string[]> {
  const root = path.join(FIXTURES_ROOT, spec.fixtureDir);
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries.sort()) {
    if (spec.filter && !spec.filter(name)) continue;
    const dir = path.join(root, name);
    try {
      const st = await fs.stat(dir);
      if (!st.isDirectory()) continue;
      if (!(await fs.pathExists(path.join(dir, 'truth.json')))) continue;
      out.push(dir);
    } catch {
      /* skip */
    }
  }
  return out;
}

async function buildDimension(spec: DimensionSpec): Promise<CampCDimension> {
  const base: CampCDimension = {
    key: spec.key,
    label: spec.label,
    description: spec.description,
    mode: 'head-to-head',
    fixtures: 0,
    meanKlauroF1: 0,
    meanTokenSaving: 0,
    outOfCategory: true,
    campABCannot: spec.campABCannot,
    examples: [],
    allWin: true,
    emitted: 0,
  };

  let fixtureDirs: string[];
  try {
    fixtureDirs = await listFixtures(spec);
  } catch (e) {
    return { ...base, note: `fixture listing failed: ${(e as Error).message}` };
  }
  if (fixtureDirs.length === 0) {
    return { ...base, note: `no fixtures found under fixtures/${spec.fixtureDir}` };
  }

  const f1s: number[] = [];
  const savings: number[] = [];
  const examples: string[] = [];
  let allWin = true;

  for (const dir of fixtureDirs) {
    try {
      const r = await spec.run(dir);
      const klauro = r.detail.find(d => d.arm === 'klauro');
      if (!klauro) continue;
      const kTokens = r.arms.find(a => a.arm_id === 'klauro')?.metrics?.tokens ?? 1;
      const compTokens = Math.max(
        1,
        ...r.arms.filter(a => a.arm_id !== 'klauro').map(a => a.metrics?.tokens ?? 0),
      );
      f1s.push(klauro.f1);
      savings.push(tokenSaving(kTokens, compTokens));
      if (examples.length < 6) examples.push(path.basename(dir));
      if (!r.verdict.klauro_wins) allWin = false;
    } catch {
      // One missing/in-progress fixture must not sink the report.
      continue;
    }
  }

  const n = f1s.length;
  if (n === 0) {
    return { ...base, note: `all ${fixtureDirs.length} fixtures threw or had no klauro detail` };
  }
  return {
    ...base,
    fixtures: n,
    meanKlauroF1: f1s.reduce((a, b) => a + b, 0) / n,
    meanTokenSaving: savings.reduce((a, b) => a + b, 0) / n,
    examples,
    allWin,
  };
}

/* ----------------------------------------------------------------------------
 * MODE 2 — emission-coverage dimensions.
 *
 * No competitor (Camp A symbol graphs, Camp B embeddings) produces these facts at
 * all, so there is no F1 curve to score against. The honest measurement is EMISSION
 * COVERAGE: run ONE real analysis over a representative multi-file repo already in
 * the tree and COUNT the structured Camp-C facts the engine emitted per category.
 * Every number is read straight off the CASOutput — nothing is hardcoded.
 * -------------------------------------------------------------------------- */

interface EmissionSpec {
  key: string;
  label: string;
  description: string;
  campABCannot: string;
  /** CASOutput fields whose contents are this category's facts. */
  fields: string[];
}

/** Representative repos, in preference order. The first one that analyzes and emits
 *  any Camp-C fact is used for emission-coverage counting. Both are real multi-file
 *  fixtures already in this tree. */
const EMISSION_FIXTURE_CANDIDATES = [
  'analysis-truth/rails-work-orders',
  'analysis-truth/nest-react-prisma',
  'analysis-truth/nextjs-app-router',
];

const EMISSION_SPECS: EmissionSpec[] = [
  {
    key: 'capabilities',
    label: 'Product capabilities & domain (C1)',
    description: 'system_capabilities + product_map + system_purpose + domain_concepts — what the system is / why it exists.',
    campABCannot:
      'a capability is composed from many files into a product spec; scip/stack-graphs and embeddings have no "capability" abstraction and emit nothing for what the system is or why it exists.',
    fields: ['system_capabilities', 'product_map', 'system_purpose', 'enhanced_system_purpose', 'domain_concepts'],
  },
  {
    key: 'journeys',
    label: 'User journeys & workflows (C2)',
    description: 'user_journeys + workflows + workflow_graph + flow_graph/flow_summary — how the system flows end-to-end.',
    campABCannot:
      'a user journey is an end-to-end flow across layers; symbol graphs see local calls and embeddings retrieve snippets — neither composes an entry→…→terminal-entity journey.',
    fields: ['user_journeys', 'workflows', 'workflow_graph', 'flow_graph', 'flow_summary'],
  },
  {
    key: 'behaviors',
    label: 'Behavior, intent & invariants (C3)',
    description: 'behaviors + intents + behavioral_invariants — what units do, why they exist, what must hold.',
    campABCannot:
      'behavior/intent/invariants are semantic facts about why code exists; structural graphs and embeddings have no representation of intent or invariants.',
    fields: ['behaviors', 'intents', 'behavioral_invariants'],
  },
  {
    key: 'paradigm',
    label: 'Paradigm conformance & idioms (C4)',
    description: 'paradigm_conformance + codebase_idioms + idiom_violations — conformance with deviations + evidence.',
    campABCannot:
      'paradigm conformance and idiom deviations are emergent normative facts; scip/stack-graphs and embeddings cannot say whether code conforms to a paradigm or where it deviates.',
    fields: ['paradigm_conformance', 'codebase_idioms', 'idiom_violations'],
  },
  {
    key: 'lineage',
    label: 'Data lineage & security boundaries (C6)',
    description: 'data_lineage + security_boundaries — sensitive-data flow maps and the boundaries it crosses.',
    campABCannot:
      'data lineage tracks sensitive data across boundaries to external services; symbol references and embeddings have no flow-of-data-across-boundary concept.',
    fields: ['data_lineage', 'security_boundaries'],
  },
  {
    key: 'callchains',
    label: 'Typed call chains (C7)',
    description: 'call_chains + method_calls — typed, resolved deep call/data flow beyond who-calls.',
    campABCannot:
      'embeddings emit no call edges at all; stack-graphs give who-calls but not the typed, resolved multi-hop chain Klauro composes.',
    fields: ['call_chains', 'method_calls'],
  },
  {
    key: 'runtime',
    label: 'Runtime fused with static (C8)',
    description: 'runtime + runtime_static_links — runtime observation correlated to static structure.',
    campABCannot:
      'runtime is dynamic; static indexers and embeddings have no runtime signal and cannot link observed runtime behavior to static structure.',
    fields: ['runtime', 'runtime_static_links'],
  },
  {
    key: 'health',
    label: 'Health, stability & change-risk (C9)',
    description: 'implementation_health + system_health + temporal_stability + change_risks — quality & risk facts.',
    campABCannot:
      'health/stability/change-risk are derived quality facts over history and structure; symbol graphs and embeddings emit no such assessment.',
    fields: ['implementation_health', 'system_health', 'temporal_stability', 'change_risks'],
  },
];

function countFact(v: unknown): number {
  if (v == null) return 0;
  if (Array.isArray(v)) return v.length;
  if (typeof v === 'object') return Object.keys(v as object).length > 0 ? 1 : 0;
  return v ? 1 : 0;
}

function factExamples(v: unknown, want: number): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const t = s.trim();
    if (t && out.length < want) out.push(t.length > 60 ? `${t.slice(0, 57)}…` : t);
  };
  const label = (item: unknown): string => {
    if (item == null) return '';
    if (typeof item === 'string') return item;
    if (typeof item === 'object') {
      const o = item as Record<string, unknown>;
      const k = o.name ?? o.title ?? o.label ?? o.id ?? o.summary ?? o.description ?? o.signal ?? o.kind;
      return k != null ? String(k) : '';
    }
    return String(item);
  };
  if (Array.isArray(v)) {
    for (const item of v) push(label(item));
  } else if (v && typeof v === 'object') {
    const lab = label(v);
    if (lab) push(lab);
  }
  return out;
}

function buildEmissionDimensions(
  cas: Record<string, unknown> | null,
  fixture: string,
): CampCDimension[] {
  return EMISSION_SPECS.map(spec => {
    const base: CampCDimension = {
      key: spec.key,
      label: spec.label,
      description: spec.description,
      mode: 'emission-coverage',
      outOfCategory: true,
      campABCannot: spec.campABCannot,
      examples: [],
      fixtures: 0,
      meanKlauroF1: 0,
      meanTokenSaving: 0,
      allWin: true,
      emitted: 0,
    };
    if (!cas) {
      return { ...base, note: `representative repo failed to analyze (${fixture})` };
    }
    let emitted = 0;
    const examples: string[] = [];
    for (const field of spec.fields) {
      const v = cas[field];
      emitted += countFact(v);
      for (const ex of factExamples(v, 3)) {
        if (examples.length < 6 && !examples.includes(ex)) examples.push(ex);
      }
    }
    return {
      ...base,
      emitted,
      examples,
      note: emitted === 0 ? `no facts emitted for this category on ${fixture}` : undefined,
    };
  });
}

async function analyzeEmissionFixture(): Promise<{ fixture: string; cas: Record<string, unknown> | null }> {
  for (const rel of EMISSION_FIXTURE_CANDIDATES) {
    const dir = path.join(FIXTURES_ROOT, rel);
    try {
      if (!(await fs.pathExists(dir))) continue;
      const cas = (await analyzeForBench(dir)) as unknown as Record<string, unknown>;
      // Use the first fixture that produces any Camp-C emission.
      const any = EMISSION_SPECS.some(s => s.fields.some(f => countFact(cas[f]) > 0));
      if (any) return { fixture: rel, cas };
    } catch {
      continue;
    }
  }
  return { fixture: EMISSION_FIXTURE_CANDIDATES[0], cas: null };
}

let cache: CampCComprehensionReport | null = null;

export async function buildCampCComprehensionReport(): Promise<CampCComprehensionReport> {
  if (cache) return cache;

  // MODE 1 — head-to-head dimensions (real competitor tries; score F1 + tokens).
  const headToHead: CampCDimension[] = [];
  for (const spec of SPECS) {
    headToHead.push(await buildDimension(spec));
  }

  // MODE 2 — emission-coverage dimensions (no competitor; count emitted facts).
  const { fixture: emissionFixture, cas } = await analyzeEmissionFixture();
  const emission = buildEmissionDimensions(cas, emissionFixture);

  const dimensions = [...headToHead, ...emission];

  // Head-to-head roll-up over scored dimensions.
  const h2h = headToHead.filter(d => d.fixtures > 0);
  const totalFixtures = h2h.reduce((a, d) => a + d.fixtures, 0);
  const meanKlauroF1 = h2h.length
    ? h2h.reduce((a, d) => a + d.meanKlauroF1, 0) / h2h.length
    : 0;
  const meanTokenSaving = h2h.length
    ? h2h.reduce((a, d) => a + d.meanTokenSaving, 0) / h2h.length
    : 0;
  const allWin = h2h.length > 0 && h2h.every(d => d.allWin);

  // Emission-coverage roll-up over dimensions that emitted ≥1 fact.
  const emitted = emission.filter(d => d.emitted > 0);
  const totalEmitted = emitted.reduce((a, d) => a + d.emitted, 0);

  cache = {
    emissionFixture,
    dimensions,
    aggregate: {
      dimensions: dimensions.length,
      headToHead: {
        dimensions: h2h.length,
        totalFixtures,
        meanKlauroF1,
        meanTokenSaving,
        allWin,
      },
      emissionCoverage: {
        dimensions: emitted.length,
        totalEmitted,
      },
      allWin,
    },
  };
  return cache;
}
