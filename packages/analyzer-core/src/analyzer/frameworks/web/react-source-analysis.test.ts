import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { cachedEstreeParse } from '../../core/estree-parse-cache';
import { ReactAnalyzer } from './react-analyzer';
import { isReactApplicableSource, ReactSourceAnalysis } from './react-source-analysis';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

test('reads and parses each React source at most once while sharing immutable indexes', async () => {
  const contents = new Map([
    ['src/App.tsx', "import Panel, { Item as Row } from './Panel'; const Lazy = lazy(() => import('./Lazy')); export function App() { return <Panel />; }"],
    ['src/useThing.ts', 'export function useThing() { return 1; }'],
  ]);
  let reads = 0;
  let parses = 0;
  const sources = await ReactSourceAnalysis.create({
    files: ['src/App.tsx', 'src/useThing.ts', 'src/missing.tsx'],
    projectPath: '/repo',
    read: async fullPath => {
      reads += 1;
      return contents.get(fullPath.replace('/repo/', '')) ?? null;
    },
    parse: (_file, content) => {
      parses += 1;
      return cachedEstreeParse(content, { loc: true, range: true, jsx: true });
    },
  });

  assert.equal(reads, 3);
  assert.equal(sources.files.length, 2);
  const app = sources.files[0];
  assert.equal(sources.ast(app), sources.ast(app));
  assert.equal(parses, 1);
  assert.equal(sources.componentModule(app, 'Panel'), './Panel');
  assert.equal(sources.componentModule(app, 'Row'), './Panel');
  assert.equal(sources.componentModule(app, 'Lazy'), './Lazy');
  assert.deepEqual(sources.stats(), { files: 2, reads: 3, parses: 1 });
  assert.throws(() => (sources.files as unknown[]).push(app));
});

class InstrumentedReactAnalyzer extends ReactAnalyzer {
  sourceAnalysis?: ReactSourceAnalysis;

  protected override async createSourceAnalysis(files: readonly string[], projectPath: string): Promise<ReactSourceAnalysis> {
    const sources = await super.createSourceAnalysis(files, projectPath);
    this.sourceAnalysis = sources;
    return sources;
  }
}

test('full React analysis shares one read and parse without changing emitted CAS', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'react-source-analysis-'));
  temporaryRoots.push(root);
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { react: '^18.0.0', 'react-router-dom': '^6.0.0' } }));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'App.tsx'), [
    "import React, { createContext, useState } from 'react';",
    "import { Route, Routes } from 'react-router-dom';",
    'export const AppContext = createContext({ value: 0 });',
    'export function useThing() { return useState(0); }',
    'export function App() {',
    '  const [value] = useThing();',
    '  return <AppContext.Provider value={{ value }}><Routes><Route path="/" element={<main>{value}</main>} /></Routes></AppContext.Provider>;',
    '}',
  ].join('\n'));

  const instrumented = new InstrumentedReactAnalyzer();
  const actual = await instrumented.analyze({ projectPath: root });
  const reference = await new ReactAnalyzer().analyze({ projectPath: root });

  assert.deepEqual(actual, reference);
  assert.deepEqual(instrumented.sourceAnalysis?.stats(), { files: 1, reads: 1, parses: 1 });
});

test('React applicability is semantic rather than every TypeScript extension', () => {
  assert.equal(isReactApplicableSource('src/lib/format.ts', 'export const format = (value: string) => value.trim();'), false);
  assert.equal(isReactApplicableSource('src/lib/react-cache.ts', "import { cache } from 'react'; export { cache };"), true);
  assert.equal(isReactApplicableSource('src/hooks/useMemoFilter.ts', 'export function useMemoFilter() { return null; }'), true);
  assert.equal(isReactApplicableSource('src/components/MemoCard.tsx', 'export const MemoCard = () => <article />;'), true);
  assert.equal(isReactApplicableSource('src/types/proto/memo.d.ts', "import type React from 'react'; export interface Memo {}"), false);
});
