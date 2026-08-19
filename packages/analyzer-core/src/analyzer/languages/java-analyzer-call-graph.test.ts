import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { JavaAnalyzer } from './java-analyzer';

test('JavaAnalyzer resolves annotated parameters and inherited Spring Data operations through injected fields', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-java-spring-data-'));
  try {
    const source = path.join(root, 'src', 'main', 'java', 'example');
    await fs.ensureDir(source);
    await fs.writeFile(path.join(root, 'pom.xml'), '<project><artifactId>spring-boot-starter-data-jpa</artifactId></project>');
    await fs.writeFile(path.join(source, 'RecordRepository.java'), [
      'package example;',
      'public interface RecordRepository extends JpaRepository<Record, Long> {',
      '  java.util.List<Record> findByOwnerId(int ownerId);',
      '}',
    ].join('\n'));
    await fs.writeFile(path.join(source, 'RecordResource.java'), [
      'package example;',
      'public class RecordResource {',
      '  private final RecordRepository repository;',
      '  public RecordResource(RecordRepository repository) { this.repository = repository; }',
      '  public Record create(',
      '    @Valid @RequestBody Record record,',
      '    @PathVariable("ownerId") @Min(1) int ownerId) {',
      '    return repository.save(record);',
      '  }',
      '  public java.util.List<Record> read(int ownerId) {',
      '    return repository.findByOwnerId(ownerId);',
      '  }',
      '}',
    ].join('\n'));

    const contribution = await new JavaAnalyzer().analyze({ projectPath: root });
    const create = contribution.nodes.find(node => node.type === 'method' && node.name === 'create');
    assert.deepEqual(create?.signature?.parameters, [
      { name: 'record', type: 'Record' },
      { name: 'ownerId', type: 'int' },
    ]);
    const save = contribution.nodes.find(node => node.type === 'repository_operation' && node.name === 'save');
    assert.ok(save);
    assert.ok(contribution.edges.some(edge => edge.type === 'calls' && edge.source === create?.id && edge.target === save.id));
    assert.ok(contribution.exit_points.some(exit => exit.type === 'database' && exit.source_node === save.id));
    const read = contribution.nodes.find(node => node.type === 'method' && node.name === 'read');
    const find = contribution.nodes.find(node => node.type === 'interface_method' && node.name === 'findByOwnerId');
    assert.ok(find);
    assert.equal(find.signature?.return_type, 'java.util.List<Record>');
    assert.ok(contribution.edges.some(edge => edge.type === 'calls' && edge.source === read?.id && edge.target === find.id));
  } finally {
    await fs.remove(root);
  }
});

test('JavaAnalyzer keeps nested-class fields out of the outer class field set', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-java-nested-fields-'));
  try {
    const source = path.join(root, 'src', 'main', 'java', 'example');
    await fs.ensureDir(source);
    await fs.writeFile(path.join(source, 'Visit.java'), [
      'package example;',
      'public class Visit {',
      '  @Column(name = "visit_date")',
      '  private Date date;',
      '  static class VisitBuilder {',
      '    private Date date;',
      '  }',
      '}',
    ].join('\n'));

    const contribution = await new JavaAnalyzer().analyze({ projectPath: root });
    const outerFields = contribution.nodes.filter(node => node.id === 'field_class_example_Visit_date');
    const innerFields = contribution.nodes.filter(node => node.id === 'field_class_example_VisitBuilder_date');
    assert.equal(outerFields.length, 1);
    assert.equal(outerFields[0].source?.line, 4);
    assert.equal(innerFields.length, 1);
  } finally {
    await fs.remove(root);
  }
});
