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
