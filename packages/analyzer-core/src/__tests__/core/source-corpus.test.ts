import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { AnalyzerSourceCorpus } from '../../analyzer/core/source-corpus';

describe('AnalyzerSourceCorpus', () => {
  it('derives immutable file evidence once and reuses it', () => {
    const corpus = new AnalyzerSourceCorpus();
    const file = path.resolve('/tmp/project/src/example.test.ts');
    const content = "import { test } from 'vitest';\r\nconst value = 1;\r\ntest('works', () => value);\r\n";

    const first = corpus.capture(file, content);
    const second = corpus.capture(file, content);

    assert.equal(first, second);
    assert.deepEqual(first.lineStarts, [0, 32, 50, 79]);
    assert.deepEqual(first.imports, ['vitest']);
    assert.deepEqual(first.categories, ['test', 'source']);
    assert.ok(Object.isFrozen(first));
    assert.ok(Object.isFrozen(first.lineStarts));
    assert.deepEqual(corpus.stats(), {
      files: 1,
      derivedEntries: 1,
      entryHits: 1,
      importIndexes: 1,
      lineIndexes: 1,
      lineArrays: 0,
      jsonParses: 0,
      lineLookups: 0,
      linePrefixCharactersAvoided: 0,
    });
  });

  it('provides language-neutral imports, lines, path categories, and manifest metadata', () => {
    const corpus = new AnalyzerSourceCorpus();
    const java = [
      'import org.springframework.kafka.core.KafkaTemplate;',
      'using Microsoft.Extensions.Logging;',
      '"github.com/nats-io/nats.go"',
    ].join('\n');
    const source = corpus.capture('/tmp/project/src/Transport.java', java);
    const manifest = corpus.capture('/tmp/project/package.json', '{"dependencies":{"kafkajs":"1.0.0"}}');

    assert.deepEqual(source.imports, [
      'org.springframework.kafka.core.KafkaTemplate',
      'Microsoft.Extensions.Logging',
      'github.com/nats-io/nats.go',
    ]);
    assert.deepEqual(source.lines, java.split('\n'));
    assert.deepEqual(corpus.pathCategories('/tmp/project/src/Transport.java'), ['source']);
    assert.equal(manifest.manifestKind, 'npm');
    assert.deepEqual(corpus.jsonForContent(manifest.content), { dependencies: { kafkajs: '1.0.0' } });
    assert.deepEqual(corpus.jsonForContent(manifest.content), { dependencies: { kafkajs: '1.0.0' } });
    assert.equal(corpus.stats().jsonParses, 1);
  });

  it('extracts import evidence across enterprise language syntaxes', () => {
    const corpus = new AnalyzerSourceCorpus();
    const cases = [
      ['/tmp/project/Main.kt', 'import io.ktor.server.application.Application', 'java', 'io.ktor.server.application.Application'],
      ['/tmp/project/main.go', 'import "go.uber.org/mock/gomock"', 'go', 'go.uber.org/mock/gomock'],
      ['/tmp/project/main.rs', 'use tokio::sync::mpsc;', 'rust', 'tokio/sync/mpsc'],
      ['/tmp/project/index.php', 'use Symfony\\Component\\Messenger\\MessageBusInterface;', 'php', 'Symfony/Component/Messenger/MessageBusInterface'],
      ['/tmp/project/main.dart', "import 'package:flutter_bloc/flutter_bloc.dart';", 'dart', 'flutter_bloc/flutter_bloc.dart'],
    ] as const;

    for (const [file, content, flavor, expected] of cases) {
      const entry = corpus.capture(file, content);
      assert.deepEqual(entry.importsFor(flavor), [expected]);
      assert.ok(entry.imports.includes(expected));
    }
  });

  it('preserves legacy line-number and line-count semantics', () => {
    const corpus = new AnalyzerSourceCorpus();
    const content = 'first\r\nsecond\nthird';
    corpus.capture('/tmp/project/src/file.ts', content);

    for (const index of [0, 1, 5, 6, 7, 13, content.length]) {
      assert.equal(corpus.lineForIndex(content, index), content.slice(0, index).split(/\r?\n/).length);
    }
    assert.equal(corpus.lineCount(content), content.split('\n').length);
    assert.equal(corpus.stats().lineLookups, 8);
    assert.equal(corpus.stats().lineIndexes, 1);
    assert.ok(corpus.stats().linePrefixCharactersAvoided > 0);
  });
});
