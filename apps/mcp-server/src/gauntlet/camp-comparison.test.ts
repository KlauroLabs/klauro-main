import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { runCallersBench } from './primitive-bench';
import {
  scipCliPath,
  scipTypescriptAvailable,
  scipCallers,
  stackGraphsTsPath,
  stackGraphsCallers,
  codebaseMemoryPath,
  codebaseMemoryCallers,
  codebaseMemoryNodesByLabel,
} from './real-camp-arms';
import { runRouteFactsBench } from './framework-bench';

// The REAL Camp-B head-to-head: Klauro vs scip-typescript (Sourcegraph's
// compiler-accurate SCIP indexer) and ctags (Universal Ctags), run for real.
// This is the honest proof behind the user's win philosophy: tie a
// ground-truth-correct tool at the quality ceiling, win on tokens, and win
// outright wherever the competitor cannot even run.

const ROOT = path.resolve(__dirname, '../../fixtures/primitive-bench');
const scipReady = !!scipCliPath() && scipTypescriptAvailable();
const stackGraphsReady = !!stackGraphsTsPath();
const codebaseMemoryReady = !!codebaseMemoryPath();

test(
  'Camp B (scip-typescript): TS who-calls is a CEILING TIE on quality, a Klauro WIN on tokens',
  { skip: scipReady ? false : 'scip-typescript / scip CLI not installed' },
  async () => {
    const r = await runCallersBench(path.join(ROOT, 'callers-ts'), { heavyArms: true });
    const klauro = r.detail.find(d => d.arm === 'klauro')!;
    const scip = r.detail.find(d => d.arm === 'scip-typescript');

    assert.ok(scip, 'scip-typescript arm must have run on the TS fixture');
    // Compiler-accurate: scip resolves Account#save vs the Logger#save decoy and
    // even catches the aliased import — so it matches Klauro at the ceiling.
    assert.equal(klauro.f1, 1, `Klauro F1 should be 1.0, got ${klauro.f1}`);
    assert.equal(scip!.f1, 1, `scip should also be F1 1.0 (compiler-accurate), got ${scip!.f1}`);

    // We do NOT fake a quality win over a compiler. The verdict must record the
    // honest tie at the ceiling, then win on efficiency.
    assert.equal(r.verdict.quality_tied_at_ceiling, true, 'quality is a ceiling tie vs scip, not an outright win');
    assert.equal(r.verdict.klauro_wins, true, r.verdict.violation?.summary || 'Klauro must still win via tokens');

    // Tokens: Klauro returns the exact caller set; scip makes you carry an index /
    // read the files. Klauro must be strictly cheaper.
    const kTokens = r.arms.find(a => a.arm_id === 'klauro')!.metrics.tokens!;
    const sTokens = r.arms.find(a => a.arm_id === 'scip-typescript')!.metrics.tokens!;
    assert.ok(kTokens < sTokens, `Klauro tokens (${kTokens}) must beat scip (${sTokens})`);

    // Camp A panel: every locally-pulled embedding model (nomic, all-minilm,
    // mxbai, …) is its own competitor. Klauro must out-quality ALL of them — they
    // retrieve "code about save", not the caller set. (No-op if Ollama is down.)
    for (const d of r.detail.filter(x => x.arm.startsWith('embeddings-'))) {
      assert.ok(klauro.f1 > d.f1, `Klauro F1 ${klauro.f1} must beat ${d.arm} F1 ${d.f1}`);
    }
  },
);

test(
  'Camp B (stack-graphs): TS who-calls ceiling tie, Go is uncovered — same honest shape',
  { skip: stackGraphsReady ? false : 'tree-sitter-stack-graphs-typescript not installed' },
  () => {
    // GitHub stack-graphs resolves each call site to its definition. On a simple
    // typed receiver it matches the compiler (decoy excluded, aliased import
    // resolved) — a ceiling tie. On Go it cannot run at all.
    const ts = stackGraphsCallers(path.join(ROOT, 'callers-ts'), 'Account', 'save');
    assert.ok(ts, 'stack-graphs must resolve the TS fixture');
    assert.deepEqual([...ts!.files].sort(), ['aliased.ts', 'service.ts'], 'exact caller set, decoy excluded');

    const go = stackGraphsCallers(path.join(ROOT, 'callers-go'), 'Account', 'Save');
    assert.equal(go, null, 'stack-graphs (TS) cannot index Go — coverage gap is real');
  },
);

test(
  'codebase-memory (LSP knowledge graph): TS who-calls is measured against the current released tool',
  { skip: codebaseMemoryReady ? false : 'codebase-memory-mcp not installed' },
  () => {
    const cm = codebaseMemoryCallers(path.join(ROOT, 'callers-ts'), 'Account', 'save');
    assert.ok(cm, 'codebase-memory must resolve the TS fixture');
    assert.deepEqual([...cm!.files].sort(), ['service.ts'], 'current release resolves the direct call, excludes the decoy, and misses the aliased call');
  },
);

test(
  'Camp B (scip-typescript): cannot index Go — Klauro wins by coverage, not by handicap',
  { skip: scipReady ? false : 'scip-typescript / scip CLI not installed' },
  () => {
    // scip-typescript is a TS/JS indexer. On Go (a language Klauro resolves to
    // F1 1.0) it produces nothing. That absence is a fact of the tool — the
    // decisive, not-even-close coverage gap, with no handicap imposed.
    const goDir = path.join(ROOT, 'callers-go');
    const scip = scipCallers(goDir, 'Account', 'Save');
    assert.equal(scip, null, 'scip-typescript must not produce a Go index — coverage gap is real');
  },
);

// LIVE out-of-category head-to-head vs the strongest contender. codebase-memory
// advertises first-class `Route` nodes, so we let it answer with its OWN best
// tool (search_graph label=Route) on a real Express fixture it indexes live.
// It recognizes `app`/`requireAuth` but NOT `app.get('/users')` as a route —
// returning 0 routes — while Klauro emits the full method+path table. This is
// the Camp-C win, measured against the contender at full strength, not a proxy.
const FW_ROOT = path.resolve(__dirname, '../../fixtures/framework-bench');

test(
  'codebase-memory (LIVE arm): cannot extract routes — Klauro wins out-of-category, measured',
  { skip: codebaseMemoryReady ? false : 'codebase-memory-mcp not installed' },
  async () => {
    const dir = path.join(FW_ROOT, 'express-routes');

    // The contender, run live with its strongest route query.
    const cm = codebaseMemoryNodesByLabel(dir, 'Route');
    assert.ok(cm, 'codebase-memory must index the fixture');
    const cmRoutes = cm!.names.filter(n => /\/(users)/.test(n) || /GET|POST|DELETE/i.test(n));
    assert.equal(cmRoutes.length, 0, `codebase-memory must surface 0 routes, got ${JSON.stringify(cm!.names)}`);

    // Klauro emits the structured route table for the same fixture.
    const r = await runRouteFactsBench(dir);
    const klauro = r.detail.find(d => d.arm === 'klauro')!;
    assert.equal(klauro.f1, 1, 'Klauro emits the exact route set the contender cannot');
    assert.equal(klauro.can_answer, true);
  },
);

import { runOrmRelationsBench } from './orm-bench';
import { runComponentTreeBench } from './component-bench';
import { codebaseMemoryEdgeTypes } from './real-camp-arms';

const ORM_ROOT = path.resolve(__dirname, '../../fixtures/orm-bench');
const COMP_ROOT = path.resolve(__dirname, '../../fixtures/component-bench');

test(
  'codebase-memory (LIVE arm): no ORM-relation edge — Klauro emits directional cardinality the contender cannot',
  { skip: codebaseMemoryReady ? false : 'codebase-memory-mcp not installed' },
  async () => {
    const dir = path.join(ORM_ROOT, 'typeorm-rel');
    const cm = codebaseMemoryEdgeTypes(dir);
    assert.ok(cm, 'codebase-memory must index the ORM fixture');
    // It indexes the entities and even sees @OneToMany as a DECORATES edge, but
    // never produces the directional relation (User 1:N Post).
    const hasRelationEdge = cm!.types.some(t => /onetomany|manytoone|onetoone|relation|cardinal/i.test(t));
    assert.equal(hasRelationEdge, false, `contender must have no ORM-relation edge, got ${JSON.stringify(cm!.types)}`);

    const r = await runOrmRelationsBench(dir);
    const klauro = r.detail.find(d => d.arm === 'klauro')!;
    assert.equal(klauro.f1, 1, 'Klauro emits the directional ORM relations');
    assert.ok(klauro.relations.some(x => /1:N|N:1/.test(x)), 'with explicit cardinality');
  },
);

test(
  'codebase-memory (LIVE arm): no renders edge — Klauro emits the component tree the contender cannot',
  { skip: codebaseMemoryReady ? false : 'codebase-memory-mcp not installed' },
  async () => {
    const dir = path.join(COMP_ROOT, 'react-tree');
    const cm = codebaseMemoryEdgeTypes(dir);
    assert.ok(cm, 'codebase-memory must index the component fixture');
    // It has IMPORTS/USAGE (App imports UserCard) but no `renders` edge.
    const hasRendersEdge = cm!.types.some(t => /render/i.test(t));
    assert.equal(hasRendersEdge, false, `contender must have no renders edge, got ${JSON.stringify(cm!.types)}`);

    const r = await runComponentTreeBench(dir);
    const klauro = r.detail.find(d => d.arm === 'klauro')!;
    assert.equal(klauro.f1, 1, 'Klauro emits the render tree (App renders UserCard)');
  },
);

import { runDiGraphBench } from './di-bench';
const DI_ROOT = path.resolve(__dirname, '../../fixtures/di-bench');

test(
  'codebase-memory (LIVE arm): no injection edge — Klauro emits the DI graph the contender cannot',
  { skip: codebaseMemoryReady ? false : 'codebase-memory-mcp not installed' },
  async () => {
    const dir = path.join(DI_ROOT, 'nestjs-di');
    const cm = codebaseMemoryEdgeTypes(dir);
    assert.ok(cm, 'codebase-memory must index the DI fixture');
    // It captures IMPORTS/USAGE/CALLS but has no injection/wiring edge.
    const hasInjectionEdge = cm!.types.some(t => /inject|wire|provide|autowir/i.test(t));
    assert.equal(hasInjectionEdge, false, `contender must have no injection edge, got ${JSON.stringify(cm!.types)}`);

    const r = await runDiGraphBench(dir);
    const klauro = r.detail.find(d => d.arm === 'klauro')!;
    assert.equal(klauro.f1, 1, 'Klauro emits the injection chain');
    assert.ok(klauro.injections.some(x => /injects/.test(x)), 'with injection semantics');
  },
);

import { runRouteAuthBench } from './auth-bench';
const AUTH_ROOT = path.resolve(__dirname, '../../fixtures/auth-bench');

test(
  'codebase-memory (LIVE arm): no route/auth concept — Klauro names the protected endpoints, the contender cannot',
  { skip: codebaseMemoryReady ? false : 'codebase-memory-mcp not installed' },
  async () => {
    const dir = path.join(AUTH_ROOT, 'express-auth');
    const cm = codebaseMemoryNodesByLabel(dir, 'Route');
    assert.ok(cm, 'codebase-memory must index the fixture');
    assert.equal(cm!.names.filter(n => /users/i.test(n)).length, 0, `no routes -> no auth, got ${JSON.stringify(cm!.names)}`);

    const r = await runRouteAuthBench(dir);
    const klauro = r.detail.find(d => d.arm === 'klauro')!;
    assert.equal(klauro.f1, 1, 'Klauro names the protected routes');
    assert.ok(klauro.protected_routes.length > 0);
  },
);

import { runPatternFactsBench } from './pattern-bench';
const PATTERN_ROOT = path.resolve(__dirname, '../../fixtures/pattern-bench');

test(
  'codebase-memory (LIVE arm): no named design pattern — Klauro names the architectural intent the contender cannot',
  { skip: codebaseMemoryReady ? false : 'codebase-memory-mcp not installed' },
  async () => {
    const dir = path.join(PATTERN_ROOT, 'strategy');
    // codebase-memory's schema has Class/Interface/Method labels but no `Pattern`
    // concept: its graph describes SHAPE (classes implementing an interface),
    // never the NAMED intent (Strategy/Polymorphism).
    const cm = codebaseMemoryNodesByLabel(dir, 'Pattern');
    assert.ok(cm, 'codebase-memory must index the pattern fixture');
    assert.equal(cm!.names.length, 0, `contender must name 0 patterns, got ${JSON.stringify(cm!.names)}`);

    const r = await runPatternFactsBench(dir);
    const klauro = r.detail.find(d => d.arm === 'klauro')!;
    assert.equal(klauro.f1, 1, 'Klauro names the pattern');
    assert.ok(klauro.patterns.some(p => /strategy/i.test(p)), 'Strategy/Polymorphism named');
  },
);

test(
  'codebase-memory (LIVE arm): no Proxy/Visitor either — pattern naming generalizes across GoF roles',
  { skip: codebaseMemoryReady ? false : 'codebase-memory-mcp not installed' },
  async () => {
    // The contender sees ImageProxy/RenderVisitor as plain Classes implementing an
    // interface — never the named GoF intent. Klauro names Proxy + Visitor.
    const dir = path.join(PATTERN_ROOT, 'proxy-visitor');
    const cm = codebaseMemoryNodesByLabel(dir, 'Pattern');
    assert.ok(cm, 'codebase-memory must index the pattern fixture');
    assert.equal(cm!.names.length, 0, `contender must name 0 patterns, got ${JSON.stringify(cm!.names)}`);

    const r = await runPatternFactsBench(dir);
    const klauro = r.detail.find(d => d.arm === 'klauro')!;
    assert.equal(klauro.f1, 1, 'Klauro names Proxy + Visitor');
    assert.ok(klauro.patterns.some(p => /proxy/i.test(p)) && klauro.patterns.some(p => /visitor/i.test(p)));
  },
);

import { runGraphqlWiringBench } from './graphql-bench';
const GQL_ROOT = path.resolve(__dirname, '../../fixtures/graphql-bench');

test(
  'codebase-memory (LIVE arm): no schema-field→resolver wiring — Klauro emits the GraphQL wiring the contender cannot',
  { skip: codebaseMemoryReady ? false : 'codebase-memory-mcp not installed' },
  async () => {
    const dir = path.join(GQL_ROOT, 'apollo-svc');
    const cm = codebaseMemoryEdgeTypes(dir);
    assert.ok(cm, 'codebase-memory must index the GraphQL fixture');
    // It sees functions/objects but has no `resolved_by` edge (Query.user -> the
    // resolver that fulfils it).
    const hasResolvedBy = cm!.types.some(t => /resolved_by|resolver|schema.?field/i.test(t));
    assert.equal(hasResolvedBy, false, `contender must have no resolver-wiring edge, got ${JSON.stringify(cm!.types)}`);

    const r = await runGraphqlWiringBench(dir);
    const klauro = r.detail.find(d => d.arm === 'klauro')!;
    assert.equal(klauro.f1, 1, 'Klauro emits the schema-field -> resolver wiring');
    assert.ok(klauro.fields.length > 0);
  },
);

test(
  'codebase-memory (LIVE arm): no Go gqlgen schema→resolver wiring either — GraphQL win spans TS+Go',
  { skip: codebaseMemoryReady ? false : 'codebase-memory-mcp not installed' },
  async () => {
    // gqlgen resolver methods on *queryResolver are generic Go methods to the
    // contender — no link from SDL field Query.user to the method that fulfils it.
    const dir = path.join(GQL_ROOT, 'gqlgen-go');
    const cm = codebaseMemoryEdgeTypes(dir);
    assert.ok(cm, 'codebase-memory must index the Go GraphQL fixture');
    const hasResolvedBy = cm!.types.some(t => /resolved_by|resolver|schema.?field/i.test(t));
    assert.equal(hasResolvedBy, false, `contender must have no resolver-wiring edge, got ${JSON.stringify(cm!.types)}`);

    const r = await runGraphqlWiringBench(dir);
    const klauro = r.detail.find(d => d.arm === 'klauro')!;
    assert.equal(klauro.f1, 1, 'Klauro wires gqlgen resolvers to SDL fields');
  },
);

test(
  'codebase-memory (LIVE arm): no ORM cardinality on PHP Eloquent either — the win generalizes across languages',
  { skip: codebaseMemoryReady ? false : 'codebase-memory-mcp not installed' },
  async () => {
    const dir = path.join(ORM_ROOT, 'eloquent-rel');
    const cm = codebaseMemoryEdgeTypes(dir);
    assert.ok(cm, 'codebase-memory must index the Eloquent fixture');
    // Eloquent relations are model METHODS (hasMany/belongsTo) — the contender
    // sees the methods but never the directional cardinality.
    const hasRelationEdge = cm!.types.some(t => /onetomany|manytoone|onetoone|relation|cardinal/i.test(t));
    assert.equal(hasRelationEdge, false, `contender must have no relation edge, got ${JSON.stringify(cm!.types)}`);

    const r = await runOrmRelationsBench(dir);
    const klauro = r.detail.find(d => d.arm === 'klauro')!;
    assert.equal(klauro.f1, 1, 'Klauro emits Eloquent directional relations');
    assert.ok(klauro.relations.some(x => /1:N|N:1/.test(x)));
  },
);

import { runMessagingWiringBench } from './messaging-bench';
const MSG_ROOT = path.resolve(__dirname, '../../fixtures/messaging-bench');

test(
  'codebase-memory (LIVE arm): no topic/produces/consumes graph — Klauro emits the pub/sub wiring the contender cannot',
  { skip: codebaseMemoryReady ? false : 'codebase-memory-mcp not installed' },
  async () => {
    const dir = path.join(MSG_ROOT, 'kafka-pubsub');
    const cm = codebaseMemoryEdgeTypes(dir);
    assert.ok(cm, 'codebase-memory must index the messaging fixture');
    // It sees producer.send(...) / consumer.subscribe(...) as generic CALLS but
    // has no topic node nor produces/consumes edge.
    const hasTopicGraph = cm!.types.some(t => /produc|consum|publish|subscrib|topic/i.test(t));
    assert.equal(hasTopicGraph, false, `contender must have no topic graph, got ${JSON.stringify(cm!.types)}`);

    const r = await runMessagingWiringBench(dir);
    const klauro = r.detail.find(d => d.arm === 'klauro')!;
    assert.equal(klauro.f1, 1, 'Klauro emits produces/consumes per topic');
    assert.ok(klauro.wiring.some(w => /produces/.test(w)) && klauro.wiring.some(w => /consumes/.test(w)));
  },
);

test(
  'codebase-memory (LIVE arm): no Go topic graph either — the messaging win generalizes across languages',
  { skip: codebaseMemoryReady ? false : 'codebase-memory-mcp not installed' },
  async () => {
    // The contender indexes 158 languages incl. Go, but its schema has no
    // topic/produces/consumes concept — so segmentio/kafka-go writers/readers
    // are generic CALLS, not a publish/subscribe wiring. Klauro reads the Go
    // Writer/Reader Topic fields and emits the directional pub/sub edges.
    const dir = path.join(MSG_ROOT, 'go-kafka');
    const cm = codebaseMemoryEdgeTypes(dir);
    assert.ok(cm, 'codebase-memory must index the Go messaging fixture');
    const hasTopicGraph = cm!.types.some(t => /produc|consum|publish|subscrib|topic/i.test(t));
    assert.equal(hasTopicGraph, false, `contender must have no Go topic graph, got ${JSON.stringify(cm!.types)}`);

    const r = await runMessagingWiringBench(dir);
    const klauro = r.detail.find(d => d.arm === 'klauro')!;
    assert.equal(klauro.f1, 1, 'Klauro emits produces orders / consumes shipments for kafka-go');
  },
);

test(
  'codebase-memory (LIVE arm): no Rust topic graph either — the messaging win spans Go + Rust',
  { skip: codebaseMemoryReady ? false : 'codebase-memory-mcp not installed' },
  async () => {
    // rdkafka FutureRecord::to(...) / consumer.subscribe(&[...]) are generic CALLS
    // to the contender; it has no topic/produces/consumes concept. Klauro reads the
    // rdkafka record/subscribe sites and emits the directional pub/sub edges.
    const dir = path.join(MSG_ROOT, 'rust-kafka');
    const cm = codebaseMemoryEdgeTypes(dir);
    assert.ok(cm, 'codebase-memory must index the Rust messaging fixture');
    const hasTopicGraph = cm!.types.some(t => /produc|consum|publish|subscrib|topic/i.test(t));
    assert.equal(hasTopicGraph, false, `contender must have no Rust topic graph, got ${JSON.stringify(cm!.types)}`);

    const r = await runMessagingWiringBench(dir);
    const klauro = r.detail.find(d => d.arm === 'klauro')!;
    assert.equal(klauro.f1, 1, 'Klauro emits produces orders / consumes shipments for rdkafka');
  },
);

test(
  'codebase-memory (LIVE arm): no JVM topic graph either — the messaging win spans TS+Go+Rust+Java',
  { skip: codebaseMemoryReady ? false : 'codebase-memory-mcp not installed' },
  async () => {
    // spring-kafka KafkaTemplate.send(...) / @KafkaListener are generic CALLS +
    // an annotation to the contender; no topic/produces/consumes concept. Klauro
    // reads the send target + @KafkaListener topics and emits the pub/sub edges.
    const dir = path.join(MSG_ROOT, 'java-kafka');
    const cm = codebaseMemoryEdgeTypes(dir);
    assert.ok(cm, 'codebase-memory must index the Java messaging fixture');
    const hasTopicGraph = cm!.types.some(t => /produc|consum|publish|subscrib|topic/i.test(t));
    assert.equal(hasTopicGraph, false, `contender must have no JVM topic graph, got ${JSON.stringify(cm!.types)}`);

    const r = await runMessagingWiringBench(dir);
    const klauro = r.detail.find(d => d.arm === 'klauro')!;
    assert.equal(klauro.f1, 1, 'Klauro emits produces orders / consumes shipments for spring-kafka');
  },
);
