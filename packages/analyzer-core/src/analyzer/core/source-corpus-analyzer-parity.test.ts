import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { withAnalyzerFileReadCache, getSourceCorpusStats } from './analyzer-file-read-cache';
import { TestFrameworkAnalyzer } from '../frameworks/testing/test-framework-analyzer';
import { AuthAnalyzer } from '../libraries/auth/auth-analyzer';
import { ValidationSchemaAnalyzer } from '../libraries/architecture/validation-schema-analyzer';
import { OutboundHttpClientAnalyzer } from '../libraries/http/outbound-http-client-analyzer';
import { ObservabilityAnalyzer } from '../libraries/observability/observability-analyzer';

test('shared source corpus preserves analyzer contributions while reusing derived evidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'source-corpus-parity-'));
  await fs.writeJson(path.join(root, 'package.json'), {
    name: 'source-corpus-parity',
    dependencies: {
      '@nestjs/passport': '^10.0.0',
      '@opentelemetry/api': '^1.9.0',
      axios: '^1.7.0',
      'class-validator': '^0.14.0',
    },
    devDependencies: { vitest: '^2.0.0' },
  });
  await fs.ensureDir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'account.dto.ts'), [
    `import { IsEmail } from 'class-validator';`,
    `export class AccountDto {`,
    `  @IsEmail()`,
    `  email!: string;`,
    `}`,
  ].join('\n'));
  await fs.writeFile(path.join(root, 'src', 'client.ts'), [
    `import axios from 'axios';`,
    `export async function loadAccount() {`,
    `  return axios.get('/accounts/active');`,
    `}`,
  ].join('\n'));
  await fs.writeFile(path.join(root, 'src', 'security.ts'), [
    `import { AuthGuard } from '@nestjs/passport';`,
    `@UseGuards(AuthGuard('jwt'))`,
    `export class AccountController {}`,
  ].join('\n'));
  await fs.writeFile(path.join(root, 'src', 'telemetry.ts'), [
    `import { trace } from '@opentelemetry/api';`,
    `const tracer = trace.getTracer('accounts');`,
    `export const span = tracer.startSpan('load-account');`,
  ].join('\n'));
  await fs.writeFile(path.join(root, 'src', 'account.test.ts'), [
    `import { test, expect } from 'vitest';`,
    `import { loadAccount } from './client';`,
    `test('loads the active account', async () => {`,
    `  expect(await loadAccount()).toBeDefined();`,
    `});`,
  ].join('\n'));

  const analyzers = [
    new TestFrameworkAnalyzer(),
    new AuthAnalyzer(),
    new ValidationSchemaAnalyzer(),
    new OutboundHttpClientAnalyzer(),
    new ObservabilityAnalyzer(),
  ];
  try {
    const direct = [];
    for (const analyzer of analyzers) direct.push(await analyzer.analyze({ projectPath: root }));

    const corpus = await withAnalyzerFileReadCache(async () => {
      const contributions = [];
      for (const analyzer of analyzers) contributions.push(await analyzer.analyze({ projectPath: root }));
      return contributions;
    });

    assert.deepEqual(corpus, direct);
    const stats = getSourceCorpusStats();
    assert.ok(stats.files >= 5, JSON.stringify(stats));
    assert.ok(stats.importIndexes >= 4, JSON.stringify(stats));
    assert.ok(stats.lineIndexes >= 4, JSON.stringify(stats));
    assert.ok(stats.lineLookups >= 4, JSON.stringify(stats));
    assert.ok(stats.linePrefixCharactersAvoided > 100, JSON.stringify(stats));
  } finally {
    await fs.remove(root);
  }
});
