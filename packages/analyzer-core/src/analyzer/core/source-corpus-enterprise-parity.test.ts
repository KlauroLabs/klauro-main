import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { getSourceCorpusStats, withAnalyzerFileReadCache } from './analyzer-file-read-cache';
import { ArchitecturalLibraryAnalyzer } from '../libraries/architecture/architectural-library-analyzer';
import { MessagingAnalyzer } from '../libraries/messaging/messaging-analyzer';
import { MockingLibraryAnalyzer } from '../libraries/testing/mocking-library-analyzer';
import { ReactAnalyzer } from '../frameworks/web/react-analyzer';
import { JestAnalyzer } from '../frameworks/testing/jest-analyzer';
import { AnalyzerSourceCorpus } from './source-corpus';

function analyzers() {
  return [
    new ArchitecturalLibraryAnalyzer(),
    new MessagingAnalyzer(),
    new MockingLibraryAnalyzer(),
    new ReactAnalyzer(),
    new JestAnalyzer(),
  ];
}

test('enterprise shared evidence preserves contributions across language stacks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'source-corpus-enterprise-'));
  await fs.writeJson(path.join(root, 'package.json'), {
    name: 'enterprise-corpus-parity',
    dependencies: {
      '@mikro-orm/core': '^6.0.0',
      kafkajs: '^2.2.4',
      react: '^18.3.0',
      sinon: '^19.0.0',
    },
    devDependencies: { jest: '^29.7.0' },
  });
  await fs.writeFile(path.join(root, 'requirements.txt'), 'celery==5.4.0\nresponses==0.25.0\n');
  await fs.writeFile(path.join(root, 'pom.xml'), [
    '<project><dependencies>',
    '<dependency><groupId>org.springframework.kafka</groupId><artifactId>spring-kafka</artifactId><version>3.2.0</version></dependency>',
    '<dependency><groupId>org.mockito</groupId><artifactId>mockito-core</artifactId><version>5.12.0</version></dependency>',
    '</dependencies></project>',
  ].join(''));
  await fs.writeFile(path.join(root, 'go.mod'), [
    'module example.com/enterprise',
    'go 1.22',
    'require github.com/nats-io/nats.go v1.36.0',
    'require go.uber.org/mock v0.4.0',
  ].join('\n'));
  await fs.writeFile(path.join(root, 'Enterprise.Tests.csproj'), [
    '<Project><ItemGroup>',
    '<PackageReference Include="Moq" Version="4.20.70" />',
    '</ItemGroup></Project>',
  ].join(''));

  await fs.ensureDir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'App.tsx'), [
    `import React from 'react';`,
    `export function App() {`,
    `  const [ready] = React.useState(true);`,
    `  return <main>{ready ? 'Ready' : 'Waiting'}</main>;`,
    `}`,
  ].join('\n'));
  await fs.writeFile(path.join(root, 'src', 'broker.ts'), [
    `import { Kafka } from 'kafkajs';`,
    `const producer = new Kafka({ clientId: 'enterprise', brokers: ['localhost:9092'] }).producer();`,
    `export async function publishOrder() {`,
    `  await producer.send({ topic: 'orders.created', messages: [{ value: '{}' }] });`,
    `}`,
  ].join('\n'));
  await fs.writeFile(path.join(root, 'src', 'repository.ts'), [
    `import { EntityManager } from '@mikro-orm/core';`,
    `export async function store(em: EntityManager, order: object) {`,
    `  await em.persistAndFlush(order);`,
    `}`,
  ].join('\n'));
  await fs.writeFile(path.join(root, 'src', 'tasks.py'), [
    'from celery import Celery',
    "app = Celery('enterprise')",
    "@app.task(name='orders.reconcile')",
    'def reconcile_order(order_id):',
    '    return order_id',
  ].join('\n'));
  await fs.writeFile(path.join(root, 'src', 'OrderListener.java'), [
    'import org.springframework.kafka.annotation.KafkaListener;',
    'public class OrderListener {',
    '  @KafkaListener(topics = "orders.created")',
    '  public void consume(String payload) {}',
    '}',
  ].join('\n'));
  await fs.writeFile(path.join(root, 'src', 'publisher.go'), [
    'package enterprise',
    'import "github.com/nats-io/nats.go"',
    'func publish(nc *nats.Conn) error {',
    '  return nc.Publish("orders.created", []byte("{}"))',
    '}',
  ].join('\n'));

  await fs.ensureDir(path.join(root, 'tests'));
  await fs.writeFile(path.join(root, 'tests', 'App.test.tsx'), [
    `import React from 'react';`,
    `import sinon from 'sinon';`,
    `import { App } from '../src/App';`,
    `describe('App', () => {`,
    `  it('renders readiness', () => {`,
    `    const spy = sinon.spy();`,
    `    spy();`,
    `    expect(App).toBeDefined();`,
    `  });`,
    `});`,
  ].join('\n'));
  await fs.writeFile(path.join(root, 'tests', 'test_tasks.py'), [
    'from unittest.mock import MagicMock',
    'def test_reconcile():',
    '    service = MagicMock()',
    '    assert service is not None',
  ].join('\n'));
  await fs.writeFile(path.join(root, 'tests', 'OrderServiceTest.java'), [
    'import org.mockito.Mockito;',
    'public class OrderServiceTest {',
    '  Object service = Mockito.mock(Object.class);',
    '}',
  ].join('\n'));
  await fs.writeFile(path.join(root, 'tests', 'publisher_test.go'), [
    'package enterprise',
    'import "go.uber.org/mock/gomock"',
    'func TestPublisher() { _ = gomock.NewController(nil) }',
  ].join('\n'));
  await fs.writeFile(path.join(root, 'tests', 'OrderServiceTests.cs'), [
    'using Moq;',
    'public class OrderServiceTests {',
    '  Mock<object> service = new Mock<object>();',
    '}',
  ].join('\n'));

  const scale = Math.max(1, Number(process.env.KLAURO_EVIDENCE_SCALE || '1'));
  const sourceFiles = ['App.tsx', 'broker.ts', 'repository.ts', 'tasks.py', 'OrderListener.java', 'publisher.go'];
  const testFiles = ['App.test.tsx', 'test_tasks.py', 'OrderServiceTest.java', 'publisher_test.go', 'OrderServiceTests.cs'];
  for (let index = 1; index < scale; index++) {
    const sourceDir = path.join(root, 'src', `batch-${index}`);
    const testDir = path.join(root, 'tests', `batch-${index}`);
    await fs.ensureDir(sourceDir);
    await fs.ensureDir(testDir);
    for (const file of sourceFiles) {
      const content = await fs.readFile(path.join(root, 'src', file), 'utf8');
      const marker = file.endsWith('.py') ? '#' : '//';
      await fs.writeFile(path.join(sourceDir, file), `${content}\n${marker} batch ${index}`);
    }
    for (const file of testFiles) {
      const content = await fs.readFile(path.join(root, 'tests', file), 'utf8');
      const marker = file.endsWith('.py') ? '#' : '//';
      await fs.writeFile(path.join(testDir, file), `${content}\n${marker} batch ${index}`);
    }
  }

  try {
    const runDirect = async () => {
      const cpuStart = process.cpuUsage();
      const contributions = [];
      for (const analyzer of analyzers()) contributions.push(await analyzer.analyze({ projectPath: root }));
      return { contributions, cpu: process.cpuUsage(cpuStart) };
    };
    const runShared = async () => {
      const cpuStart = process.cpuUsage();
      const contributions = await withAnalyzerFileReadCache(async () => {
        const values = [];
        for (const analyzer of analyzers()) values.push(await analyzer.analyze({ projectPath: root }));
        return values;
      });
      return { contributions, cpu: process.cpuUsage(cpuStart) };
    };
    const sharedFirst = process.env.KLAURO_EVIDENCE_ORDER === 'shared-first';
    const first = sharedFirst ? await runShared() : await runDirect();
    const second = sharedFirst ? await runDirect() : await runShared();
    const direct = sharedFirst ? second.contributions : first.contributions;
    const shared = sharedFirst ? first.contributions : second.contributions;

    assert.deepEqual(shared, direct);
    assert.deepEqual(shared.map(contribution => contribution.analyzer_metadata?.analyzer_id), [
      'architectural-libraries',
      'async-messaging',
      'mocking-test-double-fixtures',
      'react',
      'jest',
    ]);
    const importProof = new AnalyzerSourceCorpus();
    const goImports = importProof.capture(
      path.join(root, 'tests', 'publisher_test.go'),
      await fs.readFile(path.join(root, 'tests', 'publisher_test.go'), 'utf8'),
    ).importsFor('go');
    assert.ok(goImports.includes('go.uber.org/mock/gomock'), JSON.stringify(goImports));
    const stats = getSourceCorpusStats();
    assert.ok(stats.files >= 12, JSON.stringify(stats));
    assert.ok(stats.entryHits >= 20, JSON.stringify(stats));
    assert.ok(stats.importIndexes >= 8, JSON.stringify(stats));
    assert.ok(stats.lineArrays >= 8, JSON.stringify(stats));
    assert.ok(stats.lineIndexes >= 3, JSON.stringify(stats));
    assert.ok(stats.jsonParses >= 1, JSON.stringify(stats));
    assert.ok(stats.linePrefixCharactersAvoided > 100, JSON.stringify(stats));
    if (process.env.KLAURO_EVIDENCE_BENCH === '1') {
      const rounds = Math.max(1, Number(process.env.KLAURO_EVIDENCE_ROUNDS || '4'));
      let directTotal = 0;
      let sharedTotal = 0;
      for (let round = 0; round < rounds; round++) {
        const ordered = round % 2 === 0
          ? [await runDirect(), await runShared()]
          : [await runShared(), await runDirect()];
        const measuredDirect = round % 2 === 0 ? ordered[0] : ordered[1];
        const measuredShared = round % 2 === 0 ? ordered[1] : ordered[0];
        directTotal += measuredDirect.cpu.user + measuredDirect.cpu.system;
        sharedTotal += measuredShared.cpu.user + measuredShared.cpu.system;
      }
      process.stdout.write(`${JSON.stringify({
        rounds,
        direct_cpu_ms_mean: directTotal / rounds / 1000,
        shared_cpu_ms_mean: sharedTotal / rounds / 1000,
        reduction_pct: 100 * (1 - sharedTotal / directTotal),
        stats: getSourceCorpusStats(),
      })}\n`);
    }
  } finally {
    await fs.remove(root);
  }
});
