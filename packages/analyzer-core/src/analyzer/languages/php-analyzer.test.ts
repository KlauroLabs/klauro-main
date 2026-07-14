import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PHPAnalyzer } from './php-analyzer';

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
