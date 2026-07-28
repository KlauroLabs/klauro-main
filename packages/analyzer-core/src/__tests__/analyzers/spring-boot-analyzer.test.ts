jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { SpringBootAnalyzer } from '../../analyzer/frameworks/web/spring-boot-analyzer';

/**
 * Regression tests (2026-07-17, R7) for four compounding SpringBootAnalyzer
 * defects measured on the real spring-petclinic-microservices repo (0
 * controllers/entities/routes surfaced from 62 real Java files):
 *
 *  1. extractClassName required a `public` modifier. Package-private
 *     (default-visibility) classes are a routine, idiomatic Spring choice —
 *     the reference app itself declares its @RestControllers as bare
 *     `class OwnerResource { ... }` — and were silently invisible.
 *  2. extractEndpoints required the handler's return type to be a single
 *     bare word (`\w+`), so any generic return type (`Optional<Owner>`,
 *     `List<Owner>`) dropped the whole endpoint.
 *  3. extractEndpoints/extractRequestMapping only recognized the bare
 *     positional annotation-argument form (`@GetMapping("/x")`), not the
 *     equally common `value = "/x"` / `path = "/x"` named-argument form.
 *  4. analyzeEntities recorded `metadata.attributes.fields` as a bare
 *     COUNT (fields.length) instead of the field array the orchestrator's
 *     buildDataEntities() fallback expects, so entities.length was always 0
 *     even once the entity node itself was detected.
 */
describe('SpringBootAnalyzer', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spring-boot-'));
    await fs.writeFile(
      path.join(tmpDir, 'pom.xml'),
      '<project><dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>',
      'utf-8'
    );
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  async function writeJava(relPath: string, content: string): Promise<void> {
    const full = path.join(tmpDir, relPath);
    await fs.ensureDir(path.dirname(full));
    await fs.writeFile(full, content, 'utf-8');
  }

  describe('controller + route extraction', () => {
    it('detects a package-private @RestController and composes class + method mapping into a canonical route', async () => {
      await writeJava(
        'src/main/java/com/example/web/OwnerResource.java',
        [
          '@RequestMapping("/owners")',
          '@RestController',
          'class OwnerResource {',
          '',
          '    @PostMapping',
          '    public Owner createOwner(@RequestBody OwnerRequest req) {',
          '        return null;',
          '    }',
          '',
          '    @GetMapping(value = "/{ownerId}")',
          '    public Optional<Owner> findOwner(@PathVariable("ownerId") int ownerId) {',
          '        return null;',
          '    }',
          '',
          '    @GetMapping',
          '    public List<Owner> findAll() {',
          '        return null;',
          '    }',
          '',
          '    @PutMapping(value = "/{ownerId}")',
          '    public void updateOwner(@PathVariable("ownerId") int ownerId) {',
          '    }',
          '}',
        ].join('\n')
      );

      const analyzer = new SpringBootAnalyzer();
      const contribution = await analyzer.analyze({ projectPath: tmpDir } as any);

      const controllerNodes = (contribution.nodes || []).filter(n => n.type === 'controller');
      expect(controllerNodes.map(n => n.name)).toContain('OwnerResource');

      const routes = (contribution.entry_points || []).map(ep => `${ep.trigger?.method} ${ep.trigger?.path}`);
      expect(routes).toEqual(
        expect.arrayContaining([
          'POST /owners',
          'GET /owners/:ownerId',
          'GET /owners',
          'PUT /owners/:ownerId',
        ])
      );
      // Every real endpoint must be found — none dropped by the generic
      // return-type or value=/path= annotation-argument bugs.
      expect(routes).toHaveLength(4);
      for (const entryPoint of contribution.entry_points || []) {
        expect(entryPoint.handler?.file).toMatch(/src\/main\/java\/com\/example\/web\/OwnerResource\.java$/);
        expect(entryPoint.handler?.file).not.toBe(entryPoint.trigger?.path);
      }
    });

    it('does not emit a route for a plain @Component with no mapping annotations (negative control)', async () => {
      await writeJava(
        'src/main/java/com/example/service/OwnerService.java',
        [
          '@Component',
          'class OwnerService {',
          '    public void save() {}',
          '}',
        ].join('\n')
      );

      const analyzer = new SpringBootAnalyzer();
      const contribution = await analyzer.analyze({ projectPath: tmpDir } as any);

      expect((contribution.nodes || []).filter(n => n.type === 'controller')).toHaveLength(0);
      expect(contribution.entry_points || []).toHaveLength(0);
    });
  });

  describe('JPA entity extraction', () => {
    it('extracts a public @Entity class with @Column fields as a model node carrying a real field array', async () => {
      await writeJava(
        'src/main/java/com/example/model/Owner.java',
        [
          '@Entity',
          '@Table(name = "owners")',
          'public class Owner {',
          '',
          '    @Id',
          '    private Integer id;',
          '',
          '    @Column(name = "first_name")',
          '    private String firstName;',
          '',
          '    @Column(name = "last_name")',
          '    private String lastName;',
          '}',
        ].join('\n')
      );

      const analyzer = new SpringBootAnalyzer();
      const contribution = await analyzer.analyze({ projectPath: tmpDir } as any);

      const entityNode = (contribution.nodes || []).find(n => n.type === 'model' && n.name === 'Owner');
      expect(entityNode).toBeDefined();
      expect(entityNode!.metadata?.attributes?.table).toBe('owners');

      // The bug: this used to be a bare number (fields.length), which the
      // orchestrator's buildDataEntities() Array.isArray fallback check
      // silently rejected, so the entity surfaced with zero fields.
      const fields = entityNode!.metadata?.attributes?.fields as Array<{ name: string; type: string }>;
      expect(Array.isArray(fields)).toBe(true);
      expect(fields.map(f => f.name)).toEqual(expect.arrayContaining(['id', 'firstName', 'lastName']));
    });

    it('does not fabricate an entity for a plain non-@Entity class (negative control)', async () => {
      await writeJava(
        'src/main/java/com/example/model/OwnerRequest.java',
        ['public class OwnerRequest {', '    private String firstName;', '}'].join('\n')
      );

      const analyzer = new SpringBootAnalyzer();
      const contribution = await analyzer.analyze({ projectPath: tmpDir } as any);

      expect((contribution.nodes || []).filter(n => n.type === 'model')).toHaveLength(0);
    });
  });

  describe('bare @RequestMapping method-level mapping (P0 gate fixture)', () => {
    it('a @RestController with a class-level @RequestMapping("/base") and 5 method-level mappings yields exactly 5 http entry points with correctly combined paths', async () => {
      await writeJava(
        'src/main/java/com/example/web/ThingResource.java',
        [
          '@RequestMapping("/base")',
          '@RestController',
          'class ThingResource {',
          '',
          '    @GetMapping',
          '    public List<Thing> findAll() {',
          '        return null;',
          '    }',
          '',
          '    @RequestMapping(value = "/{id}", method = RequestMethod.GET)',
          '    public Optional<Thing> findOne(@PathVariable("id") int id) {',
          '        return null;',
          '    }',
          '',
          '    @RequestMapping(value = "/{id}", method = RequestMethod.PUT)',
          '    public void update(@PathVariable("id") int id) {',
          '    }',
          '',
          '    @RequestMapping(value = "/{id}", method = RequestMethod.DELETE)',
          '    public void remove(@PathVariable("id") int id) {',
          '    }',
          '',
          '    @PostMapping',
          '    public Thing create(@RequestBody Thing t) {',
          '        return null;',
          '    }',
          '}',
        ].join('\n')
      );

      const analyzer = new SpringBootAnalyzer();
      const contribution = await analyzer.analyze({ projectPath: tmpDir } as any);

      const httpEntries = (contribution.entry_points || []).filter(ep => ep.type === 'http');
      expect(httpEntries).toHaveLength(5);

      const routes = httpEntries.map(ep => `${ep.trigger?.method} ${ep.trigger?.path}`);
      expect(routes).toEqual(
        expect.arrayContaining([
          'GET /base',
          'GET /base/:id',
          'PUT /base/:id',
          'DELETE /base/:id',
          'POST /base',
        ])
      );

      // Every http entry point must carry a code-location handler so the
      // orchestrator's dedup can key on real code, not a guess.
      for (const ep of httpEntries) {
        expect(ep.handler?.file).toContain('ThingResource.java');
        expect(typeof ep.handler?.line).toBe('number');
        expect(ep.handler!.line).toBeGreaterThan(0);
      }
    });

    it('defaults a bare @RequestMapping with no method= attribute to verb "all" rather than dropping it', async () => {
      await writeJava(
        'src/main/java/com/example/web/AnyMethodResource.java',
        [
          '@RestController',
          'class AnyMethodResource {',
          '    @RequestMapping("/anything")',
          '    public String anyMethod() {',
          '        return "ok";',
          '    }',
          '}',
        ].join('\n')
      );

      const analyzer = new SpringBootAnalyzer();
      const contribution = await analyzer.analyze({ projectPath: tmpDir } as any);

      const routes = (contribution.entry_points || [])
        .filter(ep => ep.type === 'http')
        .map(ep => `${ep.trigger?.method} ${ep.trigger?.path}`);
      expect(routes).toContain('ALL /anything');
    });
  });

  describe('messaging, scheduling, event, and GraphQL trigger annotations', () => {
    it('emits a message entry point for @KafkaListener with topic and group metadata', async () => {
      await writeJava(
        'src/main/java/com/example/messaging/OrderKafkaListener.java',
        [
          '@Component',
          'class OrderKafkaListener {',
          '    @KafkaListener(topics = "orders", groupId = "order-group")',
          '    public void onOrder(String payload) {',
          '    }',
          '}',
        ].join('\n')
      );

      const analyzer = new SpringBootAnalyzer();
      const contribution = await analyzer.analyze({ projectPath: tmpDir } as any);

      const entries = (contribution.entry_points || []).filter(ep => ep.type === 'message' && ep.metadata?.annotation === 'KafkaListener');
      expect(entries).toHaveLength(1);
      expect(entries[0].metadata?.topics).toEqual(['orders']);
      expect(entries[0].metadata?.groupId).toBe('order-group');
      expect(entries[0].handler?.file).toContain('OrderKafkaListener.java');
      expect(entries[0].handler?.method_name).toBe('onOrder');
    });

    it('emits a message entry point for @RabbitListener with queue metadata', async () => {
      await writeJava(
        'src/main/java/com/example/messaging/OrderRabbitListener.java',
        [
          '@Component',
          'class OrderRabbitListener {',
          '    @RabbitListener(queues = "order-queue")',
          '    public void onMessage(String payload) {',
          '    }',
          '}',
        ].join('\n')
      );

      const analyzer = new SpringBootAnalyzer();
      const contribution = await analyzer.analyze({ projectPath: tmpDir } as any);

      const entries = (contribution.entry_points || []).filter(ep => ep.type === 'message' && ep.metadata?.annotation === 'RabbitListener');
      expect(entries).toHaveLength(1);
      expect(entries[0].metadata?.queues).toEqual(['order-queue']);
    });

    it('emits a message entry point for @JmsListener with destination metadata', async () => {
      await writeJava(
        'src/main/java/com/example/messaging/OrderJmsListener.java',
        [
          '@Component',
          'class OrderJmsListener {',
          '    @JmsListener(destination = "order-dest")',
          '    public void onMessage(String payload) {',
          '    }',
          '}',
        ].join('\n')
      );

      const analyzer = new SpringBootAnalyzer();
      const contribution = await analyzer.analyze({ projectPath: tmpDir } as any);

      const entries = (contribution.entry_points || []).filter(ep => ep.type === 'message' && ep.metadata?.annotation === 'JmsListener');
      expect(entries).toHaveLength(1);
      expect(entries[0].metadata?.destinations).toEqual(['order-dest']);
    });

    it('emits a schedule entry point for @Scheduled carrying the cron expression', async () => {
      await writeJava(
        'src/main/java/com/example/jobs/CleanupJob.java',
        [
          '@Component',
          'class CleanupJob {',
          '    @Scheduled(cron = "0 0 * * * *")',
          '    public void cleanup() {',
          '    }',
          '}',
        ].join('\n')
      );

      const analyzer = new SpringBootAnalyzer();
      const contribution = await analyzer.analyze({ projectPath: tmpDir } as any);

      const entries = (contribution.entry_points || []).filter(ep => ep.type === 'schedule');
      expect(entries).toHaveLength(1);
      expect(entries[0].trigger?.schedule).toBe('0 0 * * * *');
      expect(entries[0].metadata?.cron).toBe('0 0 * * * *');
    });

    it('emits a schedule entry point for @Scheduled(fixedRate=...) when no cron is given', async () => {
      await writeJava(
        'src/main/java/com/example/jobs/PollJob.java',
        [
          '@Component',
          'class PollJob {',
          '    @Scheduled(fixedRate = 5000)',
          '    public void poll() {',
          '    }',
          '}',
        ].join('\n')
      );

      const analyzer = new SpringBootAnalyzer();
      const contribution = await analyzer.analyze({ projectPath: tmpDir } as any);

      const entries = (contribution.entry_points || []).filter(ep => ep.type === 'schedule');
      expect(entries).toHaveLength(1);
      expect(entries[0].metadata?.fixedRate).toBe(5000);
    });

    it('emits an event entry point for @EventListener and @TransactionalEventListener', async () => {
      await writeJava(
        'src/main/java/com/example/events/OrderEventHandler.java',
        [
          '@Component',
          'class OrderEventHandler {',
          '    @EventListener',
          '    public void onOrderCreated(OrderCreatedEvent event) {',
          '    }',
          '',
          '    @TransactionalEventListener',
          '    public void onOrderCommitted(OrderCommittedEvent event) {',
          '    }',
          '}',
        ].join('\n')
      );

      const analyzer = new SpringBootAnalyzer();
      const contribution = await analyzer.analyze({ projectPath: tmpDir } as any);

      const entries = (contribution.entry_points || []).filter(ep => ep.type === 'event');
      expect(entries).toHaveLength(2);
      expect(entries.map(e => e.metadata?.annotation)).toEqual(
        expect.arrayContaining(['EventListener', 'TransactionalEventListener'])
      );
    });

    it('emits a message entry point for @MessageMapping (STOMP/WebSocket) with the destination', async () => {
      await writeJava(
        'src/main/java/com/example/ws/ChatController.java',
        [
          '@Controller',
          'class ChatController {',
          '    @MessageMapping("/chat")',
          '    public void handleChat(String message) {',
          '    }',
          '}',
        ].join('\n')
      );

      const analyzer = new SpringBootAnalyzer();
      const contribution = await analyzer.analyze({ projectPath: tmpDir } as any);

      const entries = (contribution.entry_points || []).filter(ep => ep.type === 'message' && ep.metadata?.annotation === 'MessageMapping');
      expect(entries).toHaveLength(1);
      expect(entries[0].metadata?.destination).toBe('/chat');
    });

    it('emits http entry points for Spring GraphQL @QueryMapping/@MutationMapping/@SchemaMapping', async () => {
      await writeJava(
        'src/main/java/com/example/graphql/OwnerGraphQLController.java',
        [
          '@Controller',
          'class OwnerGraphQLController {',
          '    @QueryMapping',
          '    public List<Owner> owners() {',
          '        return null;',
          '    }',
          '',
          '    @MutationMapping',
          '    public Owner addOwner(@Argument String name) {',
          '        return null;',
          '    }',
          '',
          '    @SchemaMapping',
          '    public List<Pet> pets(Owner owner) {',
          '        return null;',
          '    }',
          '}',
        ].join('\n')
      );

      const analyzer = new SpringBootAnalyzer();
      const contribution = await analyzer.analyze({ projectPath: tmpDir } as any);

      const graphqlEntries = (contribution.entry_points || []).filter(ep =>
        ['QueryMapping', 'MutationMapping', 'SchemaMapping'].includes(ep.metadata?.annotation)
      );
      expect(graphqlEntries).toHaveLength(3);
      for (const ep of graphqlEntries) {
        expect(ep.type).toBe('http');
      }
      expect(graphqlEntries.map(e => e.metadata?.operation)).toEqual(
        expect.arrayContaining(['owners', 'addOwner', 'pets'])
      );
    });

    it('does not emit any trigger entry point for a plain @Service with no trigger annotations (negative control)', async () => {
      await writeJava(
        'src/main/java/com/example/service/PlainService.java',
        [
          '@Service',
          'class PlainService {',
          '    public void doWork() {',
          '    }',
          '}',
        ].join('\n')
      );

      const analyzer = new SpringBootAnalyzer();
      const contribution = await analyzer.analyze({ projectPath: tmpDir } as any);

      const triggerEntries = (contribution.entry_points || []).filter(ep =>
        ['message', 'schedule', 'event'].includes(ep.type)
      );
      expect(triggerEntries).toHaveLength(0);
    });
  });

  describe('multi-module maven layout with a samples package segment', () => {
    it('still finds controllers and entities when real source lives under a directory literally named "samples"', async () => {
      await writeJava(
        'module-a/src/main/java/org/example/samples/app/model/Vet.java',
        [
          '@Entity',
          '@Table(name = "vets")',
          'public class Vet {',
          '    @Id',
          '    private Integer id;',
          '}',
        ].join('\n')
      );
      await writeJava(
        'module-a/src/main/java/org/example/samples/app/web/VetResource.java',
        [
          '@RequestMapping("/vets")',
          '@RestController',
          'class VetResource {',
          '    @GetMapping',
          '    public List<Vet> findAll() {',
          '        return null;',
          '    }',
          '}',
        ].join('\n')
      );

      const analyzer = new SpringBootAnalyzer();
      const contribution = await analyzer.analyze({ projectPath: tmpDir } as any);

      expect((contribution.nodes || []).find(n => n.type === 'model' && n.name === 'Vet')).toBeDefined();
      expect((contribution.nodes || []).find(n => n.type === 'controller' && n.name === 'VetResource')).toBeDefined();
      const routes = (contribution.entry_points || []).map(ep => `${ep.trigger?.method} ${ep.trigger?.path}`);
      expect(routes).toContain('GET /vets');
    });
  });
});
