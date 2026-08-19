import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { SpringBootAnalyzer } from './spring-boot-analyzer';

test('SpringBootAnalyzer exposes endpoint contracts and operational boundaries', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-spring-boot-contracts-'));
  try {
    const source = path.join(root, 'src', 'main', 'java', 'example');
    const resources = path.join(root, 'src', 'main', 'resources');
    await fs.ensureDir(source);
    await fs.ensureDir(resources);
    await fs.writeFile(path.join(root, 'pom.xml'), [
      '<project><dependencies>',
      '<dependency><artifactId>spring-boot-starter-web</artifactId></dependency>',
      '<dependency><artifactId>spring-cloud-starter-netflix-eureka-client</artifactId></dependency>',
      '</dependencies></project>',
    ].join('\n'));
    await fs.writeFile(path.join(resources, 'application.yml'), [
      'spring:',
      '  config:',
      '    import: optional:configserver:${CONFIG_SERVER_URL:http://localhost:8888/}',
    ].join('\n'));
    await fs.writeFile(path.join(source, 'Application.java'), [
      'package example;',
      '@EnableDiscoveryClient',
      '@SpringBootApplication',
      'public class Application {',
      '  public static void main(String[] args) {}',
      '}',
    ].join('\n'));
    await fs.writeFile(path.join(source, 'Record.java'), [
      'package example;',
      '@Entity',
      '@Table(name = "records")',
      'public class Record {',
      '  @Id private Long id;',
      '}',
    ].join('\n'));
    await fs.writeFile(path.join(source, 'RecordResource.java'), [
      'package example;',
      '@RestController',
      'public class RecordResource {',
      '  @PostMapping("owners/{ownerId}/records")',
      '  @ResponseStatus(HttpStatus.CREATED)',
      '  public Record create(',
      '    @Valid @RequestBody Record record,',
      '    @PathVariable("ownerId") @Min(1) int ownerId) {',
      '    return record;',
      '  }',
      '}',
    ].join('\n'));

    const contribution = await new SpringBootAnalyzer().analyze({ projectPath: root });
    const route = contribution.entry_points.find(entry => entry.type === 'http');
    assert.equal(route?.output?.type, 'Record');
    assert.deepEqual(route?.output?.status_codes, [201]);
    assert.deepEqual(route?.trigger?.parameters, [
      { name: 'record', type: 'Record', required: true, location: 'body' },
      { name: 'ownerId', type: 'int', required: true, location: 'path' },
    ]);
    assert.deepEqual(route?.input?.validation, ['Valid', 'Min(1)']);
    assert.ok(contribution.entry_points.some(entry => entry.type === 'lifecycle' && entry.trigger?.event === 'application-start'));
    assert.ok(contribution.exit_points.some(exit => exit.type === 'database' && exit.target?.resource === 'records'));
    assert.ok(contribution.exit_points.some(exit => exit.type === 'api' && exit.target?.service_id === 'eureka'));
    assert.ok(contribution.exit_points.some(exit => exit.type === 'api' && exit.target?.service_id === 'spring-config'));
  } finally {
    await fs.remove(root);
  }
});
