import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { NestJSAnalyzer } from './nestjs-analyzer';

test('NestJSAnalyzer.canAnalyze detects a real NestJS app from declared @nestjs/core', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nestjs-analyzer-'));
  await fs.writeJson(path.join(root, 'package.json'), {
    name: 'some-service',
    dependencies: { '@nestjs/core': '^10.0.0', '@nestjs/common': '^10.0.0' },
  });
  const analyzer = new NestJSAnalyzer();
  assert.equal(await analyzer.canAnalyze(root), true);
  await fs.remove(root);
});

// DEFECT regression: canAnalyze used to hard-exclude two literal package
// names (the analyzer's own host package, `@klauro/analyzer-core` /
// `@unravl/analyzer-core`) before ever checking real dependency evidence.
// That name-based gate is repo-specific and evidence-free — it blinded
// detection for ANY nested workspace package carrying one of those exact
// names, including a genuine, deployed NestJS application living there (this
// analyzer's own host package is exactly such a case: a real app.module.ts /
// *.controller.ts / *.service.ts NestJS service, not test scaffolding).
// Test/fixture paths are already excluded upstream (SCAFFOLD_GLOBS via
// getIgnorePatterns, and the product-path gate in framework-comprehension.ts
// downstream), so a name-based self-exclusion here was both redundant and,
// for this exact repo shape, wrong.
test('NestJSAnalyzer.canAnalyze detects a real NestJS app even when the package is named exactly the analyzer\'s own former self-exclusion names', async () => {
  for (const name of ['@klauro/analyzer-core', '@unravl/analyzer-core']) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nestjs-analyzer-self-'));
    await fs.writeJson(path.join(root, 'package.json'), {
      name,
      dependencies: { '@nestjs/core': '^10.0.0', '@nestjs/common': '^10.0.0', '@nestjs/platform-express': '^10.0.0' },
    });
    const analyzer = new NestJSAnalyzer();
    assert.equal(await analyzer.canAnalyze(root), true, `expected canAnalyze(true) for package name "${name}"`);
    await fs.remove(root);
  }
});

test('NestJSAnalyzer.canAnalyze rejects a project without any @nestjs/* dependency', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nestjs-analyzer-neg-'));
  await fs.writeJson(path.join(root, 'package.json'), { name: 'plain-app', dependencies: { express: '^4.0.0' } });
  const analyzer = new NestJSAnalyzer();
  assert.equal(await analyzer.canAnalyze(root), false);
  await fs.remove(root);
});
