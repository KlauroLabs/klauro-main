



















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










export interface CampCDimension {
  key: string;
  label: string;
  description: string;
  mode: 'head-to-head' | 'emission-coverage';
  outOfCategory: boolean;

  campABCannot: string;
  examples: string[];



  fixtures: number;
  attemptedFixtures: number;
  failedFixtures: number;
  meanKlauroF1: number;
  meanTokenSaving: number;

  allWin: boolean;



  emitted: number;


  note?: string;
}

export interface CampCComprehensionReport {

  emissionFixture: string;
  dimensions: CampCDimension[];
  aggregate: {

    dimensions: number;

    headToHead: {
      dimensions: number;
      totalFixtures: number;
      meanKlauroF1: number;
      meanTokenSaving: number;
      allWin: boolean;
    };

    emissionCoverage: {
      dimensions: number;
      totalEmitted: number;
    };

    allWin: boolean;
  };
}

const FIXTURES_ROOT = path.resolve(__dirname, '../../fixtures');



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

  fixtureDir: string;

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

    }
  }
  return out;
}

export async function buildDimension(spec: DimensionSpec): Promise<CampCDimension> {
  const base: CampCDimension = {
    key: spec.key,
    label: spec.label,
    description: spec.description,
    mode: 'head-to-head',
    fixtures: 0,
    attemptedFixtures: 0,
    failedFixtures: 0,
    meanKlauroF1: 0,
    meanTokenSaving: 0,
    outOfCategory: true,
    campABCannot: spec.campABCannot,
    examples: [],
    allWin: false,
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
  const errors: string[] = [];
  let allWin = true;
  let failedFixtures = 0;

  for (const dir of fixtureDirs) {
    try {
      const r = await spec.run(dir);
      const klauro = r.detail.find(d => d.arm === 'klauro');
      if (!klauro) {
        failedFixtures++;
        if (errors.length < 3) errors.push(`${path.basename(dir)}: missing Klauro result`);
        continue;
      }
      const kTokens = r.arms.find(a => a.arm_id === 'klauro')?.metrics?.tokens ?? 1;
      const compTokens = Math.max(
        1,
        ...r.arms.filter(a => a.arm_id !== 'klauro').map(a => a.metrics?.tokens ?? 0),
      );
      f1s.push(klauro.f1);
      savings.push(tokenSaving(kTokens, compTokens));
      if (examples.length < 6) examples.push(path.basename(dir));
      if (!r.verdict.klauro_wins) allWin = false;
    } catch (error) {
      failedFixtures++;
      if (errors.length < 3) {
        errors.push(`${path.basename(dir)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const n = f1s.length;
  if (n === 0) {
    return {
      ...base,
      attemptedFixtures: fixtureDirs.length,
      failedFixtures,
      note: `all ${fixtureDirs.length} fixtures threw or had no klauro detail${errors.length ? ': ' + errors.join('; ') : ''}`,
    };
  }
  return {
    ...base,
    fixtures: n,
    attemptedFixtures: fixtureDirs.length,
    failedFixtures,
    meanKlauroF1: f1s.reduce((a, b) => a + b, 0) / n,
    meanTokenSaving: savings.reduce((a, b) => a + b, 0) / n,
    examples,
    allWin: allWin && failedFixtures === 0,
    note: errors.length > 0 ? errors.join('; ') : undefined,
  };
}











interface EmissionSpec {
  key: string;
  label: string;
  description: string;
  campABCannot: string;

  fields: string[];
}




const EMISSION_FIXTURE_CANDIDATES = [
  'analysis-truth/rails-work-orders',
  'analysis-truth/nest-react-prisma',
  'analysis-truth/nextjs-app-router',
];

const EMISSION_SPECS: EmissionSpec[] = [
  {
    key: 'capabilities',
    label: 'Product capabilities & domain (C1)',
    description: 'capabilities + product_map + system_purpose + domain_concepts — what the system is / why it exists.',
    campABCannot:
      'a capability is composed from many files into a product spec; scip/stack-graphs and embeddings have no "capability" abstraction and emit nothing for what the system is or why it exists.',
    fields: ['capabilities', 'product_map', 'system_purpose', 'enhanced_system_purpose', 'domain_concepts'],
  },
  {
    key: 'journeys',
    label: 'User journeys (C2)',
    description: 'get_user_journeys projects the canonical flows into a user-facing end-to-end view at read time.',
    campABCannot:
      'a user journey is an end-to-end flow across layers; symbol graphs see local calls and embeddings retrieve snippets — neither composes an entry→…→terminal-entity journey.',
    fields: ['flows', 'steps', 'flow_graph', 'flow_summary'],
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
      attemptedFixtures: 0,
      failedFixtures: 0,
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


  const headToHead: CampCDimension[] = [];
  for (const spec of SPECS) {
    headToHead.push(await buildDimension(spec));
  }


  const { fixture: emissionFixture, cas } = await analyzeEmissionFixture();
  const emission = buildEmissionDimensions(cas, emissionFixture);
  cache = summarizeCampCComprehension(headToHead, emission, emissionFixture);
  return cache;
}

export function summarizeCampCComprehension(
  headToHead: readonly CampCDimension[],
  emission: readonly CampCDimension[],
  emissionFixture: string,
): CampCComprehensionReport {
  const dimensions = [...headToHead, ...emission];


  const h2h = headToHead.filter(d => d.fixtures > 0);
  const totalFixtures = h2h.reduce((a, d) => a + d.fixtures, 0);
  const meanKlauroF1 = h2h.length
    ? h2h.reduce((a, d) => a + d.meanKlauroF1, 0) / h2h.length
    : 0;
  const meanTokenSaving = h2h.length
    ? h2h.reduce((a, d) => a + d.meanTokenSaving, 0) / h2h.length
    : 0;
  const allWin = headToHead.length > 0 && headToHead.every(d =>
    d.fixtures > 0 && d.attemptedFixtures === d.fixtures && d.failedFixtures === 0 && d.allWin,
  );


  const emitted = emission.filter(d => d.emitted > 0);
  const totalEmitted = emitted.reduce((a, d) => a + d.emitted, 0);

  return {
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
}
