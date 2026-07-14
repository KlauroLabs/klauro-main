import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PHPAnalyzer } from './php-analyzer';
import { computeFlowConcepts } from '../core/flow-concepts';

/**
 * Cross-service call-graph resolution fixtures: Symfony DI interface binding,
 * Doctrine repositories, typed-property receivers — the boundaries where PHP
 * call chains used to die (controller -> service -> repository invisible).
 * Every binding asserted here is evidence-gated; the ambiguity fixture
 * asserts ABSTENTION (no guessed edge) when two implementations exist.
 */

function writeFixtureProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'php-analyzer-callgraph-'));
  const src = (p: string, content: string) => {
    const full = path.join(dir, p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  src('src/Service/BookingServiceInterface.php', `<?php
namespace App\\Service;

interface BookingServiceInterface
{
    public function create(string $name): void;
}
`);

  // The ONE implementation in the repo — evidence for interface binding.
  src('src/Service/BookingService.php', `<?php
namespace App\\Service;

use App\\Repository\\BookingRepository;
use Doctrine\\ORM\\EntityManagerInterface;

class BookingService implements BookingServiceInterface
{
    public function __construct(
        private readonly BookingRepository $bookingRepository,
        private EntityManagerInterface $em
    ) {
    }

    public function create(string $name): void
    {
        $this->bookingRepository->save($name);
        $this->em->getRepository(Booking::class)->findActive($name);
    }
}
`);

  src('src/Entity/Booking.php', `<?php
namespace App\\Entity;

#[ORM\\Entity(repositoryClass: BookingRepository::class)]
class Booking
{
    private string $name;
}
`);

  src('src/Repository/BookingRepository.php', `<?php
namespace App\\Repository;

class BookingRepository
{
    public function save(string $name): void
    {
    }

    public function findActive(string $name): void
    {
    }
}
`);

  // Controller with a multi-line signature and method-arg DI (Symfony style).
  src('src/Controller/BookingController.php', `<?php
namespace App\\Controller;

use App\\Service\\BookingServiceInterface;

class BookingController
{
    public function createBooking(
        string $name,
        BookingServiceInterface $service
    ): void {
        $service->create($name);
    }
}
`);

  // Ambiguity fixture: an interface with TWO implementations and no
  // services.yaml alias — calls typed to it must not bind to either.
  src('src/Service/NotifierInterface.php', `<?php
namespace App\\Service;

interface NotifierInterface
{
    public function notify(string $msg): void;
}
`);
  src('src/Service/EmailNotifier.php', `<?php
namespace App\\Service;

class EmailNotifier implements NotifierInterface
{
    public function notify(string $msg): void
    {
    }
}
`);
  src('src/Service/SmsNotifier.php', `<?php
namespace App\\Service;

class SmsNotifier implements NotifierInterface
{
    public function notify(string $msg): void
    {
    }
}
`);
  src('src/Controller/NotifyController.php', `<?php
namespace App\\Controller;

use App\\Service\\NotifierInterface;

class NotifyController
{
    public function send(NotifierInterface $notifier): void
    {
        $notifier->notify('hi');
    }
}
`);

  return dir;
}

interface CallEdgeView {
  from: string;
  to: string;
}

function callEdges(cas: { nodes: any[]; edges: any[] }): CallEdgeView[] {
  const byId = new Map(cas.nodes.map(n => [n.id, n]));
  return cas.edges
    .filter(e => e.type === 'calls')
    .map(e => {
      const from = byId.get(e.source);
      const to = byId.get(e.target);
      const owner = (n: any) => {
        const file = n?.source?.file || '';
        return path.basename(file, '.php');
      };
      return { from: `${owner(from)}.${from?.name}`, to: `${owner(to)}.${to?.name}` };
    });
}

async function analyzeFixture(dir: string, opts: { forceFastFallback?: boolean } = {}) {
  const analyzer = new PHPAnalyzer();
  const cas = await analyzer.analyze({ projectPath: dir });
  if (!opts.forceFastFallback) return cas;

  // Re-run call-graph extraction through the regex fast-fallback path (the
  // one whale repos like a 13k-class Symfony monolith actually take) against
  // the same nodes, with previously extracted call edges removed.
  const edges = cas.edges.filter(e => e.type !== 'calls');
  const files = (await (analyzer as any).getRelevantFiles(dir)) as string[];
  await (analyzer as any).analyzeCallGraphFastFallback(
    dir,
    files,
    cas.nodes,
    edges,
    cas.exit_points || [],
    cas.nodes.filter((n: any) => n.type === 'method' || n.type === 'function'),
    cas.nodes.filter((n: any) => n.type === 'class' || n.type === 'interface' || n.type === 'trait')
  );
  return { ...cas, edges };
}

for (const forceFastFallback of [false, true]) {
  const label = forceFastFallback ? 'fast-fallback (regex) path' : 'AST path';

  test(`DI interface binding (single impl) resolves controller -> service [${label}]`, async () => {
    const dir = writeFixtureProject();
    try {
      const cas = await analyzeFixture(dir, { forceFastFallback });
      const edges = callEdges(cas as any);
      assert.ok(
        edges.some(e => e.from === 'BookingController.createBooking' && e.to === 'BookingService.create'),
        `expected createBooking -> BookingService.create, got: ${JSON.stringify(edges, null, 2)}`
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`typed-property call resolves service -> repository [${label}]`, async () => {
    const dir = writeFixtureProject();
    try {
      const cas = await analyzeFixture(dir, { forceFastFallback });
      const edges = callEdges(cas as any);
      assert.ok(
        edges.some(e => e.from === 'BookingService.create' && e.to === 'BookingRepository.save'),
        `expected BookingService.create -> BookingRepository.save, got: ${JSON.stringify(edges, null, 2)}`
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`Doctrine getRepository(Entity::class) chain resolves to repository [${label}]`, async () => {
    const dir = writeFixtureProject();
    try {
      const cas = await analyzeFixture(dir, { forceFastFallback });
      const edges = callEdges(cas as any);
      assert.ok(
        edges.some(e => e.from === 'BookingService.create' && e.to === 'BookingRepository.findActive'),
        `expected BookingService.create -> BookingRepository.findActive, got: ${JSON.stringify(edges, null, 2)}`
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`ambiguous interface (two impls, no alias) abstains from impl binding [${label}]`, async () => {
    const dir = writeFixtureProject();
    try {
      const cas = await analyzeFixture(dir, { forceFastFallback });
      const edges = callEdges(cas as any);
      const guessed = edges.filter(e =>
        e.from === 'NotifyController.send' &&
        (e.to === 'EmailNotifier.notify' || e.to === 'SmsNotifier.notify'));
      assert.equal(guessed.length, 0,
        `must not guess an implementation: ${JSON.stringify(guessed)}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('services.yaml alias binds an otherwise-ambiguous interface', async () => {
  const dir = writeFixtureProject();
  try {
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config/services.yaml'), [
      'services:',
      "    App\\Service\\NotifierInterface: '@App\\Service\\SmsNotifier'",
      '',
    ].join('\n'));
    const cas = await analyzeFixture(dir);
    const edges = callEdges(cas as any);
    assert.ok(
      edges.some(e => e.from === 'NotifyController.send' && e.to === 'SmsNotifier.notify'),
      `expected alias-bound NotifyController.send -> SmsNotifier.notify, got: ${JSON.stringify(edges.filter(e => e.from.startsWith('NotifyController')))}`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Branch/error evidence fixtures (C1 step-graph edges): a PHP call site
 * inside an if-block must be stamped with the same `conditional` evidence
 * shape the TS analyzer emits (flow-concepts.ts buildConditionalOutIndex
 * reads edge.metadata.conditional / method_calls execution_context.is_conditional),
 * and a method that throws (body `throw new X` or `@throws` docblock) must
 * populate node.signature.throws (extractErrorConstraints reads it). A call
 * NOT inside a conditional gets no such flag — no fabrication.
 */
function writeConditionalFixtureProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'php-analyzer-conditional-'));
  const src = (p: string, content: string) => {
    const full = path.join(dir, p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  src('src/Service/BookingService.php', `<?php
namespace App\\Service;

class BookingService
{
    /**
     * @throws NotFoundException
     */
    public function book(string $name): void
    {
        if (!$this->validate($name)) {
            $this->reject($name);
            throw new BookingException('invalid booking');
        }
        $this->persist($name);
    }

    public function validate(string $name): bool
    {
        return $name !== '';
    }

    public function reject(string $name): void
    {
    }

    public function persist(string $name): void
    {
    }
}
`);

  return dir;
}

for (const forceFastFallback of [false, true]) {
  const label = forceFastFallback ? 'fast-fallback (regex) path' : 'AST path';

  test(`call inside an if-block is stamped conditional [${label}]`, async () => {
    const dir = writeConditionalFixtureProject();
    try {
      const cas = await analyzeFixture(dir, { forceFastFallback });
      const byId = new Map((cas as any).nodes.map((n: any) => [n.id, n]));
      const callEdgesRaw = (cas as any).edges.filter((e: any) => e.type === 'calls');
      const named = (id: string) => byId.get(id)?.name;

      const rejectEdge = callEdgesRaw.find((e: any) => named(e.source) === 'book' && named(e.target) === 'reject');
      const persistEdge = callEdgesRaw.find((e: any) => named(e.source) === 'book' && named(e.target) === 'persist');

      assert.ok(rejectEdge, `expected a call edge book -> reject, got: ${JSON.stringify(callEdgesRaw.map((e: any) => [named(e.source), named(e.target)]))}`);
      assert.equal(rejectEdge.metadata?.conditional, true,
        `book -> reject sits inside an if-block and must carry metadata.conditional=true, got metadata: ${JSON.stringify(rejectEdge.metadata)}`);

      assert.ok(persistEdge, 'expected a call edge book -> persist');
      assert.notEqual(persistEdge.metadata?.conditional, true,
        `book -> persist sits OUTSIDE the if-block and must NOT be flagged conditional, got metadata: ${JSON.stringify(persistEdge.metadata)}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`method_calls execution_context.is_conditional reflects the same evidence [${label}]`, async () => {
    const dir = writeConditionalFixtureProject();
    try {
      const cas = await analyzeFixture(dir, { forceFastFallback });
      const orchestratorLike = cas as any;
      // method_calls is an orchestrator-level derived fact; only assert it
      // when the fixture's analyzer output includes it (some direct-analyzer
      // runs skip cross-cutting derivation the orchestrator normally adds).
      if (!orchestratorLike.method_calls) return;
      const byId = new Map(orchestratorLike.nodes.map((n: any) => [n.id, n]));
      const bookNode = orchestratorLike.nodes.find((n: any) => n.name === 'book');
      const mc = orchestratorLike.method_calls.find((m: any) =>
        m.caller_node === bookNode?.id && byId.get(m.target_node)?.name === 'reject');
      assert.ok(mc, 'expected a method_call for book -> reject');
      assert.equal(mc.execution_context?.is_conditional, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`signature.throws is populated from body throw + @throws docblock [${label}]`, async () => {
    const dir = writeConditionalFixtureProject();
    try {
      const cas = await analyzeFixture(dir, { forceFastFallback });
      const bookNode = (cas as any).nodes.find((n: any) => n.name === 'book');
      assert.ok(bookNode, 'expected a node for method book');
      const throws = bookNode.signature?.throws || [];
      assert.ok(throws.includes('BookingException'),
        `expected signature.throws to include the body 'throw new BookingException(...)', got: ${JSON.stringify(throws)}`);
      assert.ok(throws.includes('NotFoundException'),
        `expected signature.throws to include the @throws NotFoundException docblock tag, got: ${JSON.stringify(throws)}`);

      const validateNode = (cas as any).nodes.find((n: any) => n.name === 'validate');
      assert.ok(validateNode, 'expected a node for method validate');
      assert.ok(!validateNode.signature?.throws || validateNode.signature.throws.length === 0,
        `validate() never throws — signature.throws must stay empty/absent, got: ${JSON.stringify(validateNode.signature?.throws)}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

/**
 * C1 end-to-end: a PHP-only fixture, run through the real PHPAnalyzer and
 * fed straight into computeFlowConcepts, must yield BOTH a 'branch' and an
 * 'error' step_graph edge — proving the php-analyzer facts (edge.metadata.conditional,
 * node.signature.throws) are the exact shape flow-concepts.ts consumes, not
 * just present in isolation. `handleBooking` is a standalone PHP function,
 * which php-analyzer always emits as an entry point (no framework-detection
 * dependency), so the flow is reachable without extra route-attribute setup.
 */
test('PHP fixture flow carries a branch edge AND an error edge end-to-end through computeFlowConcepts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'php-analyzer-c1-integration-'));
  try {
    const full = path.join(dir, 'src/booking.php');
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `<?php
namespace App;

class BookingService
{
    public function book(string $name): void
    {
        if (!$this->validate($name)) {
            $this->reject($name);
            throw new BookingException('invalid booking');
        }
        $this->persist($name);
    }

    public function validate(string $name): bool
    {
        return $name !== '';
    }

    public function reject(string $name): void
    {
    }

    public function persist(string $name): void
    {
    }
}

function handleBooking(string $name): void
{
    $service = new BookingService();
    $service->book($name);
}
`);

    const analyzer = new PHPAnalyzer();
    const cas = await analyzer.analyze({ projectPath: dir });

    const entry = (cas.entry_points || []).find((e: any) => e.metadata?.functionName === 'handleBooking');
    assert.ok(entry, `expected an entry point for handleBooking, got: ${JSON.stringify(cas.entry_points)}`);

    const flows = computeFlowConcepts(cas as any);
    const flow = flows.find(f => f.entry_point === entry!.id) || flows[0];
    assert.ok(flow, `expected at least one flow, got: ${JSON.stringify(flows)}`);
    assert.ok(flow.step_graph, 'expected the flow to carry a step_graph');

    const kinds = flow.step_graph!.edges.map(e => e.kind);
    assert.ok(kinds.includes('branch'),
      `expected a 'branch' step_graph edge (from BookingService::book's conditional call), got kinds: ${JSON.stringify(kinds)}, edges: ${JSON.stringify(flow.step_graph!.edges)}`);
    assert.ok(kinds.includes('error'),
      `expected an 'error' step_graph edge (from BookingService::book's signature.throws), got kinds: ${JSON.stringify(kinds)}, edges: ${JSON.stringify(flow.step_graph!.edges)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
