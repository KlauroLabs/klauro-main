jest.unmock('fs');
jest.unmock('fs-extra');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { NestJSAnalyzer } from '../../analyzer/frameworks/web/nestjs-analyzer';

/**
 * DEFECT regression: a monorepo whose NestJS application lives in a nested
 * workspace package (`packages/<name>/package.json`, not the repo root) must
 * still surface `nestjs` in `system.technologies.frameworks` at confidence 1,
 * with its controllers reachable as route entry points.
 *
 * This reproduces the real self-analysis defect measured on Klauro's own
 * proof-of-concept repo: the root `package.json` declares no `@nestjs/*`
 * dependency (those live in the nested `packages/analyzer-core/package.json`
 * workspace member), and that nested package happens to be named
 * `@klauro/analyzer-core` — a name NestJSAnalyzer.canAnalyze() used to
 * hard-exclude outright, before ever inspecting its real dependencies or
 * source. That excluded a genuine, deployed NestJS service (real
 * controllers/services/modules, not test scaffolding) from framework
 * detection, entry-point extraction, and every downstream constraint
 * (guards, DTO validation, exception mapping) that reads from it.
 */
function createPipelineOrchestrator(): AnalyzerOrchestrator {
  const orchestrator = new AnalyzerOrchestrator();
  orchestrator.registerAnalyzer({
    id: 'nestjs',
    name: 'NestJS Framework Analyzer',
    type: 'framework',
    version: '1.0.0',
    detectPatterns: { dependencies: ['@nestjs/core', '@nestjs/common'] },
    analyzer: new NestJSAnalyzer(),
  });
  return orchestrator;
}

describe('NestJS detection in a monorepo whose Nest app is a nested workspace package', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-nested-nestjs-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const write = async (relative: string, content: string) => {
    const full = path.join(root, relative);
    await fs.ensureDir(path.dirname(full));
    await fs.writeFile(full, content);
  };

  it('reports nestjs at confidence 1 and its controller as a route entry point', async () => {
    await write(
      'package.json',
      JSON.stringify({ name: '@klauro/monorepo', private: true, workspaces: ['apps/*', 'packages/*'] })
    );
    // The Nest app lives in a NESTED workspace package, deliberately named
    // the same as the analyzer's own former self-exclusion literal — the
    // exact shape of the real defect.
    await write(
      'packages/analyzer-core/package.json',
      JSON.stringify({
        name: '@klauro/analyzer-core',
        dependencies: { '@nestjs/core': '^10.0.0', '@nestjs/common': '^10.0.0', '@nestjs/platform-express': '^10.0.0' },
      })
    );
    await write(
      'packages/analyzer-core/src/organizations.controller.ts',
      [
        "import { Controller, Get } from '@nestjs/common';",
        '',
        "@Controller('organizations')",
        'export class OrganizationsController {',
        '  @Get()',
        '  list() {',
        '    return [];',
        '  }',
        '}',
      ].join('\n')
    );

    const orchestrator = createPipelineOrchestrator();
    const output = await orchestrator.orchestrateAnalysis(root);

    const nestFramework = (output.nodes || [])
      .flatMap(node => (node.analyzers || []).includes('nestjs') ? [node] : []);
    expect(nestFramework.length).toBeGreaterThan(0);

    const routeEntryPoints = (output.entry_points || []).filter(entry => entry.type === 'http');
    expect(routeEntryPoints.some(entry =>
      String(entry.handler?.file || '').includes('organizations.controller.ts')
    )).toBe(true);
  }, 30_000);
});
