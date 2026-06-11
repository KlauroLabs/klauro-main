jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NestJSAnalyzer } from '../../analyzer/frameworks/web/nestjs-analyzer';
import type { CASEdge, CASEntryPoint, CASNode } from '../../types/cas.types';

describe('NestJS bootstrap entry point ids', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-bootstrap-ids-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const write = (relative: string, content: string) => {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  const bootstrapMain = (port: number) => [
    "import { NestFactory } from '@nestjs/core';",
    'async function bootstrap() {',
    '  const app = await NestFactory.create(AppModule);',
    `  await app.listen(${port});`,
    '}',
    'bootstrap();',
  ].join('\n');

  const analyzeEntryPoints = async (files: string[]) => {
    const analyzer = new NestJSAnalyzer() as any;
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    await analyzer.analyzeEntryPoints(files, root, nodes, edges, entryPoints, []);
    return { nodes, entryPoints };
  };

  it('emits app-qualified unique ids for multiple app.listen bootstraps', async () => {
    write('apps/api/src/main.ts', bootstrapMain(3000));
    write('apps/api-internal/src/main.ts', bootstrapMain(3030));
    write('apps/scheduler/src/main.ts', bootstrapMain(3000));

    const files = [
      'apps/api/src/main.ts',
      'apps/api-internal/src/main.ts',
      'apps/scheduler/src/main.ts',
    ];
    const { nodes, entryPoints } = await analyzeEntryPoints(files);

    const httpEntries = entryPoints.filter(entry => entry.id.startsWith('entry_http_server'));
    expect(httpEntries.map(entry => entry.id).sort()).toEqual([
      'entry_http_server_apps_api_internal_src_main',
      'entry_http_server_apps_api_src_main',
      'entry_http_server_apps_scheduler_src_main',
    ]);

    const bootstrapEntries = entryPoints.filter(entry => entry.id.startsWith('entry_bootstrap'));
    expect(bootstrapEntries.map(entry => entry.id).sort()).toEqual([
      'entry_bootstrap_apps_api_internal_src_main',
      'entry_bootstrap_apps_api_src_main',
      'entry_bootstrap_apps_scheduler_src_main',
    ]);

    const bootstrapNodes = nodes.filter(node => node.id.startsWith('bootstrap_main'));
    expect(bootstrapNodes.map(node => node.id).sort()).toEqual([
      'bootstrap_main_apps_api_internal_src_main',
      'bootstrap_main_apps_api_src_main',
      'bootstrap_main_apps_scheduler_src_main',
    ]);

    for (const entry of httpEntries) {
      const qualifier = entry.id.replace('entry_http_server_', '');
      expect(entry.source_node).toBe(`bootstrap_main_${qualifier}`);
    }
  });

  it('is deterministic across repeated analyses', async () => {
    write('apps/api/src/main.ts', bootstrapMain(3000));
    write('apps/scheduler/src/main.ts', bootstrapMain(3000));
    const files = ['apps/api/src/main.ts', 'apps/scheduler/src/main.ts'];

    const first = await analyzeEntryPoints(files);
    const second = await analyzeEntryPoints(files);

    expect(second.entryPoints.map(entry => entry.id)).toEqual(first.entryPoints.map(entry => entry.id));
    expect(second.nodes.map(node => node.id)).toEqual(first.nodes.map(node => node.id));
  });

  it('creates the bootstrap node for createMicroservice bootstraps so listen entries resolve', async () => {
    write('apps/scheduler/src/main.ts', [
      "import { NestFactory } from '@nestjs/core';",
      'async function bootstrap() {',
      '  const app = await NestFactory.createMicroservice(SchedulerModule);',
      '  await app.listen();',
      '}',
      'bootstrap();',
    ].join('\n'));

    const { nodes, entryPoints } = await analyzeEntryPoints(['apps/scheduler/src/main.ts']);

    expect(nodes.map(node => node.id)).toContain('bootstrap_main_apps_scheduler_src_main');
    const httpEntry = entryPoints.find(entry => entry.id === 'entry_http_server_apps_scheduler_src_main');
    expect(httpEntry).toBeDefined();
    expect(httpEntry!.source_node).toBe('bootstrap_main_apps_scheduler_src_main');
    const bootstrapEntry = entryPoints.find(entry => entry.id === 'entry_bootstrap_apps_scheduler_src_main');
    expect(bootstrapEntry).toBeDefined();
    expect((bootstrapEntry!.metadata as any)?.bootstrap_method).toBe('NestFactory.createMicroservice');
  });

  it('disambiguates multiple listen calls in a single bootstrap file', async () => {
    write('src/main.ts', [
      "import { NestFactory } from '@nestjs/core';",
      'async function bootstrap() {',
      '  const app = await NestFactory.create(AppModule);',
      '  await app.listen(3000);',
      '  await app.listen(3443);',
      '}',
      'bootstrap();',
    ].join('\n'));

    const { entryPoints } = await analyzeEntryPoints(['src/main.ts']);
    const httpEntries = entryPoints.filter(entry => entry.id.startsWith('entry_http_server'));
    expect(httpEntries.map(entry => entry.id).sort()).toEqual([
      'entry_http_server_src_main',
      'entry_http_server_src_main_2',
    ]);
  });
});
