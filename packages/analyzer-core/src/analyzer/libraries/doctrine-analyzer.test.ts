import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { DoctrineAnalyzer } from './orm/doctrine-analyzer';

async function makeProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doctrine-analyzer-test-'));
  await fs.writeJson(path.join(dir, 'composer.json'), {
    name: 'doctrine-fixture',
    require: { 'doctrine/orm': '^2.14' }
  });

  const entityDir = path.join(dir, 'src', 'Entity');
  const repoDir = path.join(dir, 'src', 'Repository');
  const serviceDir = path.join(dir, 'src', 'Service');
  await fs.ensureDir(entityDir);
  await fs.ensureDir(repoDir);
  await fs.ensureDir(serviceDir);

  // Grouped PHP 8 attribute form (the exact shape that broke on truckspy's
  // Booking.php: `#[` and `ORM\Entity` on separate lines, multiple attributes
  // in one group, a second stacked `#[...]` group before a property).
  await fs.writeFile(path.join(entityDir, 'Booking.php'), [
    '<?php',
    '',
    'declare(strict_types=1);',
    '',
    'namespace App\\Entity;',
    '',
    'use App\\Repository\\BookingRepository;',
    'use Doctrine\\ORM\\Mapping as ORM;',
    '',
    '#[',
    '    ORM\\Entity(repositoryClass: BookingRepository::class),',
    '    ORM\\Table(',
    "        name: 'dispatching.tbl_bookings',",
    '        indexes: [',
    '            new ORM\\Index(columns: ["book_no"])',
    '        ]',
    '    )',
    ']',
    'class Booking',
    '{',
    '    #[ORM\\Id]',
    '    #[ORM\\GeneratedValue]',
    "    #[ORM\\Column(type: Types::INTEGER)]",
    '    private ?int $id = null;',
    '',
    "    #[ORM\\Column(name: 'book_no', type: Types::STRING)]",
    "    #[JMS\\Type('string')]",
    '    private ?string $bookNo = null;',
    '',
    "    #[ORM\\Column(type: Types::STRING, nullable: true)]",
    '    private ?string $notes = null;',
    '',
    '    #[',
    "        ORM\\ManyToOne(targetEntity: Customer::class),",
    "        ORM\\JoinColumn(name: 'customer_id', onDelete: 'SET NULL')",
    '    ]',
    '    private ?Customer $customer = null;',
    '',
    '    /**',
    '     * @var Collection<int, Stop>',
    '     */',
    "    #[ORM\\OneToMany(mappedBy: 'booking', targetEntity: Stop::class)]",
    '    private ?Collection $stops = null;',
    '',
    '    #[ORM\\OneToOne(targetEntity: BookingProfile::class)]',
    '    private ?BookingProfile $profile = null;',
    '',
    "    #[ORM\\ManyToMany(targetEntity: Tag::class)]",
    '    private ?Collection $tags = null;',
    '}',
    ''
  ].join('\n'));

  await fs.writeFile(path.join(entityDir, 'Customer.php'), [
    '<?php',
    '',
    'namespace App\\Entity;',
    '',
    'use Doctrine\\ORM\\Mapping as ORM;',
    '',
    '#[ORM\\Entity, ORM\\Table(name: "customers")]',
    'class Customer',
    '{',
    '    #[ORM\\Id]',
    '    #[ORM\\Column(type: Types::INTEGER)]',
    '    private ?int $id = null;',
    '',
    '    #[ORM\\Column(type: Types::STRING)]',
    '    private ?string $name = null;',
    '}',
    ''
  ].join('\n'));

  await fs.writeFile(path.join(entityDir, 'Stop.php'), [
    '<?php',
    'namespace App\\Entity;',
    'use Doctrine\\ORM\\Mapping as ORM;',
    '#[ORM\\Entity]',
    'class Stop',
    '{',
    "    #[ORM\\ManyToOne(targetEntity: Booking::class, inversedBy: 'stops')]",
    '    private ?Booking $booking = null;',
    '}',
    ''
  ].join('\n'));

  await fs.writeFile(path.join(entityDir, 'BookingProfile.php'), [
    '<?php',
    'namespace App\\Entity;',
    'use Doctrine\\ORM\\Mapping as ORM;',
    '#[ORM\\Entity]',
    'class BookingProfile { }',
    ''
  ].join('\n'));

  await fs.writeFile(path.join(entityDir, 'Tag.php'), [
    '<?php',
    'namespace App\\Entity;',
    'use Doctrine\\ORM\\Mapping as ORM;',
    '#[ORM\\Entity]',
    'class Tag { }',
    ''
  ].join('\n'));

  // Regression fixture for the truckspy Company.php defect class: THREE
  // stacked class-level attribute groups followed by a TRAILING docblock
  // (`/** @see ... */`) before `class` — the reverse of the more common
  // "docblock, then attributes" ordering. A field also stacks a second,
  // unrelated attribute group (`#[JMS\Type(...)]`) between `#[ORM\Column]`
  // and the property, same as Company's real fields.
  await fs.writeFile(path.join(entityDir, 'Vendor.php'), [
    '<?php',
    'namespace App\\Entity;',
    'use Doctrine\\ORM\\Mapping as ORM;',
    'use JMS\\Serializer\\Annotation as JMS;',
    '',
    '#[ORM\\Entity(repositoryClass: VendorRepository::class), ORM\\Table(name: "vendors")]',
    '#[UniqueEntity(fields: ["name"], ignoreNull: true)]',
    '#[JMS\\ExclusionPolicy("none"), JMS\\AccessType(type: "public_method")]',
    '/**',
    ' * @see VendorTest',
    ' */',
    'class Vendor',
    '{',
    '    #[ORM\\Column(type: Types::STRING, unique: true, nullable: true)]',
    "    #[JMS\\Type('string')]",
    '    private ?string $name = null;',
    '}',
    ''
  ].join('\n'));

  // Legacy annotation-style entity (PHP 5/7 docblock form).
  await fs.writeFile(path.join(entityDir, 'LegacyInvoice.php'), [
    '<?php',
    'namespace App\\Entity;',
    'use Doctrine\\ORM\\Mapping as ORM;',
    '',
    '/**',
    ' * @ORM\\Entity(repositoryClass="App\\Repository\\LegacyInvoiceRepository")',
    ' * @ORM\\Table(name="legacy_invoices")',
    ' */',
    'class LegacyInvoice',
    '{',
    '    /**',
    '     * @ORM\\Id',
    '     * @ORM\\Column(type="integer")',
    '     */',
    '    private $id;',
    '',
    '    /**',
    '     * @ORM\\Column(type="string", nullable=true)',
    '     */',
    '    private $reference;',
    '}',
    ''
  ].join('\n'));

  // Repository with a persist() call site bound via constructor injection.
  await fs.writeFile(path.join(repoDir, 'BookingRepository.php'), [
    '<?php',
    'namespace App\\Repository;',
    '',
    'use App\\Entity\\Booking;',
    'use Doctrine\\Bundle\\DoctrineBundle\\Repository\\ServiceEntityRepository;',
    'use Doctrine\\Persistence\\ManagerRegistry;',
    '',
    'class BookingRepository extends ServiceEntityRepository',
    '{',
    '    public function __construct(ManagerRegistry $registry)',
    '    {',
    '        parent::__construct($registry, Booking::class);',
    '    }',
    '',
    '    public function save(Booking $booking): void',
    '    {',
    '        $this->getEntityManager()->persist($booking);',
    '        $this->getEntityManager()->flush();',
    '    }',
    '',
    '    public function delete(Booking $booking): void',
    '    {',
    '        $this->getEntityManager()->remove($booking);',
    '        $this->getEntityManager()->flush();',
    '    }',
    '}',
    ''
  ].join('\n'));

  // Service that constructs a new entity inline and persists it.
  await fs.writeFile(path.join(serviceDir, 'BookingService.php'), [
    '<?php',
    'namespace App\\Service;',
    '',
    'use App\\Entity\\Customer;',
    'use Doctrine\\ORM\\EntityManagerInterface;',
    '',
    'class BookingService',
    '{',
    '    public function __construct(private EntityManagerInterface $em) {}',
    '',
    '    public function createCustomer(string $name): Customer',
    '    {',
    '        $customer = new Customer();',
    '        $this->em->persist($customer);',
    '        $this->em->flush();',
    '        return $customer;',
    '    }',
    '}',
    ''
  ].join('\n'));

  // ConnectionBind fixture — mirrors the real truckspy shape: the `connection`
  // ManyToOne relation is declared inside a shared TRAIT (used by every
  // *ConnectionBind subclass), while the domain-entity `entity` relation is
  // declared directly on the concrete subclass. A body-only scan sees only
  // the second relation; the trait-aware scan added here must see both, so
  // downstream entity classification has the evidence to tell an
  // integration-sync join record apart from a real domain entity.
  const modelConnectionDir = path.join(dir, 'src', 'Model', 'Connection');
  await fs.ensureDir(modelConnectionDir);
  await fs.writeFile(path.join(modelConnectionDir, 'ConnectionBindTrait.php'), [
    '<?php',
    'namespace App\\Model\\Connection;',
    '',
    'use App\\Entity\\Connection;',
    'use Doctrine\\ORM\\Mapping as ORM;',
    '',
    'trait ConnectionBindTrait',
    '{',
    "    #[ORM\\ManyToOne(targetEntity: Connection::class)]",
    '    protected ?Connection $connection = null;',
    '',
    '    #[ORM\\Column(type: Types::STRING, nullable: true)]',
    '    protected ?string $remoteId = null;',
    '}',
    ''
  ].join('\n'));

  await fs.writeFile(path.join(entityDir, 'Connection.php'), [
    '<?php',
    'namespace App\\Entity;',
    'use Doctrine\\ORM\\Mapping as ORM;',
    '#[ORM\\Entity, ORM\\Table(name: "integration.tbl_connection")]',
    'class Connection',
    '{',
    '    #[ORM\\Column(type: Types::STRING)]',
    '    private ?string $type = null;',
    '',
    '    #[ORM\\Column(type: Types::ARRAY, nullable: true)]',
    '    private ?array $auth = [];',
    '',
    '    #[ORM\\Column(type: Types::BOOLEAN)]',
    '    private bool $enabled = true;',
    '}',
    ''
  ].join('\n'));

  await fs.writeFile(path.join(entityDir, 'Device.php'), [
    '<?php',
    'namespace App\\Entity;',
    'use Doctrine\\ORM\\Mapping as ORM;',
    '#[ORM\\Entity, ORM\\Table(name: "tbl_device")]',
    'class Device',
    '{',
    '    #[ORM\\Column(type: Types::STRING)]',
    '    private ?string $serial = null;',
    '}',
    ''
  ].join('\n'));

  await fs.writeFile(path.join(entityDir, 'DeviceConnectionBind.php'), [
    '<?php',
    'namespace App\\Entity;',
    '',
    'use App\\Model\\Connection\\ConnectionBindTrait;',
    'use Doctrine\\ORM\\Mapping as ORM;',
    '',
    '#[ORM\\Entity, ORM\\Table(name: "integration.tbl_device_connection_bind")]',
    'class DeviceConnectionBind',
    '{',
    '    use ConnectionBindTrait;',
    '',
    "    #[ORM\\ManyToOne(targetEntity: Device::class)]",
    '    protected ?Device $entity = null;',
    '}',
    ''
  ].join('\n'));

  return dir;
}

test('DoctrineAnalyzer extracts a grouped-attribute entity (Booking regression)', async () => {
  const dir = await makeProject();
  try {
    const analyzer = new DoctrineAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true);

    const result = await analyzer.analyze({ projectPath: dir });

    const entities = result.nodes.filter(n => n.type === 'entity');
    const entityNames = entities.map(n => n.name).sort();
    assert.deepEqual(
      entityNames,
      [
        'Booking', 'BookingProfile', 'Connection', 'Customer', 'Device', 'DeviceConnectionBind',
        'LegacyInvoice', 'Stop', 'Tag', 'Vendor',
      ].sort(),
      `expected all entities including Booking, got ${JSON.stringify(entityNames)}`
    );

    const booking = entities.find(n => n.name === 'Booking')!;
    assert.ok(booking, 'Booking entity must be extracted (regression guard for the grouped-attribute bug)');
    assert.equal((booking.metadata as any).tableName, 'dispatching.tbl_bookings');
    assert.equal((booking.metadata as any).repositoryClass, 'BookingRepository');

    const bookingFields = (booking.metadata as any).fields as Array<{ name: string; type: string; relation: boolean }>;
    const nonRelationFields = bookingFields.filter(f => !f.relation).map(f => f.name).sort();
    // id, bookNo, notes — bookNo has a SECOND stacked #[JMS\Type(...)] attribute
    // group before the property, which the old adjacency regex would have missed.
    assert.deepEqual(nonRelationFields, ['bookNo', 'id', 'notes']);

    const relationFields = bookingFields.filter(f => f.relation).map(f => f.name).sort();
    assert.deepEqual(relationFields, ['customer', 'profile', 'stops', 'tags']);
  } finally {
    await fs.remove(dir);
  }
});

test('DoctrineAnalyzer extracts an entity with stacked attribute groups AND a trailing docblock before class (Company regression)', async () => {
  const dir = await makeProject();
  try {
    const analyzer = new DoctrineAnalyzer();
    const result = await analyzer.analyze({ projectPath: dir });

    const vendor = result.nodes.find(n => n.type === 'entity' && n.name === 'Vendor');
    assert.ok(vendor, 'Vendor entity must be extracted despite 3 stacked attribute groups + a trailing docblock before `class`');
    assert.equal((vendor!.metadata as any).tableName, 'vendors');
    assert.equal((vendor!.metadata as any).repositoryClass, 'VendorRepository');

    const fields = (vendor!.metadata as any).fields as Array<any>;
    // The `name` field has a SECOND stacked `#[JMS\Type(...)]` attribute group
    // between `#[ORM\Column]` and the property declaration — the exact shape
    // that made truckspy's Company entity report only 7 of its real fields.
    assert.deepEqual(fields.map(f => f.name), ['name']);
    assert.equal(fields[0].type, 'string');
    assert.equal(fields[0].nullable, true);
    assert.equal(fields[0].unique, true);
  } finally {
    await fs.remove(dir);
  }
});

test('DoctrineAnalyzer extracts field types, nullability, and primary/generated flags', async () => {
  const dir = await makeProject();
  try {
    const analyzer = new DoctrineAnalyzer();
    const result = await analyzer.analyze({ projectPath: dir });
    const booking = result.nodes.find(n => n.type === 'entity' && n.name === 'Booking')!;
    const fields = (booking.metadata as any).fields as Array<any>;

    const idField = fields.find(f => f.name === 'id');
    assert.ok(idField, 'expected id field');
    assert.equal(idField.type, 'integer');
    assert.equal(idField.primary, true);
    assert.equal(idField.generated, true);

    const notesField = fields.find(f => f.name === 'notes');
    assert.equal(notesField.type, 'string');
    assert.equal(notesField.nullable, true);
  } finally {
    await fs.remove(dir);
  }
});

test('DoctrineAnalyzer extracts all four relation kinds with correct targets', async () => {
  const dir = await makeProject();
  try {
    const analyzer = new DoctrineAnalyzer();
    const result = await analyzer.analyze({ projectPath: dir });
    const booking = result.nodes.find(n => n.type === 'entity' && n.name === 'Booking')!;
    const fields = (booking.metadata as any).fields as Array<any>;

    const byName = Object.fromEntries(fields.filter(f => f.relation).map(f => [f.name, f]));
    assert.equal(byName.customer.relationType, 'ManyToOne');
    assert.equal(byName.customer.type, 'Customer');
    assert.equal(byName.stops.relationType, 'OneToMany');
    assert.equal(byName.stops.type, 'Stop');
    assert.equal(byName.profile.relationType, 'OneToOne');
    assert.equal(byName.profile.type, 'BookingProfile');
    assert.equal(byName.tags.relationType, 'ManyToMany');
    assert.equal(byName.tags.type, 'Tag');

    const relationEdges = result.edges.filter(e => e.type === 'references');
    const targets = new Set(relationEdges.map(e => e.target));
    assert.ok(targets.has('entity_doctrine_customer'));
    assert.ok(targets.has('entity_doctrine_stop'));
  } finally {
    await fs.remove(dir);
  }
});

test('DoctrineAnalyzer extracts a legacy @ORM annotation-style entity', async () => {
  const dir = await makeProject();
  try {
    const analyzer = new DoctrineAnalyzer();
    const result = await analyzer.analyze({ projectPath: dir });
    const legacy = result.nodes.find(n => n.type === 'entity' && n.name === 'LegacyInvoice');
    assert.ok(legacy, 'expected the annotation-style LegacyInvoice entity to be extracted');
    assert.equal((legacy!.metadata as any).evidenceKind, 'annotation');
    assert.equal((legacy!.metadata as any).tableName, 'legacy_invoices');
    assert.equal((legacy!.metadata as any).repositoryClass, 'LegacyInvoiceRepository');

    const fields = (legacy!.metadata as any).fields as Array<any>;
    const fieldNames = fields.map((f: any) => f.name).sort();
    assert.deepEqual(fieldNames, ['id', 'reference']);
  } finally {
    await fs.remove(dir);
  }
});

test('DoctrineAnalyzer emits persist/remove write facts bound to entities', async () => {
  const dir = await makeProject();
  try {
    const analyzer = new DoctrineAnalyzer();
    const result = await analyzer.analyze({ projectPath: dir });

    const dbExits = (result.exit_points || []).filter(e => e.type === 'database');
    assert.ok(dbExits.length >= 3, `expected >=3 database exit points, got ${dbExits.length}`);

    const bookingWrites = dbExits.filter(e => e.target?.resource === 'Booking');
    assert.ok(bookingWrites.some(e => e.operation?.action === 'update'), 'expected a Booking persist (repository-scoped) write');
    assert.ok(bookingWrites.some(e => e.operation?.action === 'delete'), 'expected a Booking remove (delete) write');

    const customerWrites = dbExits.filter(e => e.target?.resource === 'Customer');
    assert.ok(
      customerWrites.some(e => e.operation?.action === 'insert'),
      'expected a Customer insert write (inline "new Customer()" binding)'
    );

    const writeEdges = result.edges.filter(e => ['creates', 'updates', 'deletes'].includes(e.type));
    assert.ok(writeEdges.some(e => e.target === 'entity_doctrine_booking'));
    assert.ok(writeEdges.some(e => e.target === 'entity_doctrine_customer'));
  } finally {
    await fs.remove(dir);
  }
});

test('DoctrineAnalyzer resolves an ORM relation declared inside a used TRAIT (ConnectionBind regression)', async () => {
  const dir = await makeProject();
  try {
    const analyzer = new DoctrineAnalyzer();
    const result = await analyzer.analyze({ projectPath: dir });

    const bind = result.nodes.find(n => n.type === 'entity' && n.name === 'DeviceConnectionBind');
    assert.ok(bind, 'DeviceConnectionBind entity must be extracted');

    const fields = (bind!.metadata as any).fields as Array<{ name: string; type: string; relation: boolean; relationType?: string }>;
    const relationsByName = Object.fromEntries(fields.filter(f => f.relation).map(f => [f.name, f]));

    // The `entity` relation is declared directly on the subclass — always
    // visible even without trait support.
    assert.equal(relationsByName.entity?.type, 'Device');
    assert.equal(relationsByName.entity?.relationType, 'ManyToOne');

    // The `connection` relation is declared INSIDE ConnectionBindTrait, which
    // DeviceConnectionBind only `use`s — this is the regression this fixture
    // targets. Without trait-aware parsing this relation is invisible, and
    // an entity classifier can never see that the shape pairs a domain
    // entity (Device) with a connection/integration entity (Connection).
    assert.equal(relationsByName.connection?.type, 'Connection', 'expected the trait-declared "connection" relation to be resolved');
    assert.equal(relationsByName.connection?.relationType, 'ManyToOne');

    // A non-relation field declared in the trait (`remoteId`) must also be
    // folded in.
    const nonRelationNames = fields.filter(f => !f.relation).map(f => f.name);
    assert.ok(nonRelationNames.includes('remoteId'), 'expected the trait-declared remoteId column to be folded in');

    const relationEdges = result.edges.filter(e => e.type === 'references' && e.source === bind!.id);
    const relationTargets = new Set(relationEdges.map(e => e.target));
    assert.ok(relationTargets.has('entity_doctrine_device'));
    assert.ok(relationTargets.has('entity_doctrine_connection'));
  } finally {
    await fs.remove(dir);
  }
});

test('DoctrineAnalyzer output is byte-stable across repeated runs', async () => {
  const dir = await makeProject();
  try {
    const analyzer = new DoctrineAnalyzer();
    const first = await analyzer.analyze({ projectPath: dir });
    const second = await analyzer.analyze({ projectPath: dir });
    assert.equal(JSON.stringify(first.nodes), JSON.stringify(second.nodes));
    assert.equal(JSON.stringify(first.edges), JSON.stringify(second.edges));
    assert.equal(JSON.stringify(first.exit_points), JSON.stringify(second.exit_points));
  } finally {
    await fs.remove(dir);
  }
});
