jest.unmock('fs');
jest.unmock('fs-extra');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { isPackageBoundaryManifest, isRegisteredManifest } from '../../analyzer/core/language-registry';
import { TypeScriptJavaScriptAnalyzer } from '../../analyzer/languages/typescript-javascript-analyzer';
import { NestJSAnalyzer } from '../../analyzer/frameworks/web/nestjs-analyzer';

function createPipelineOrchestrator(): AnalyzerOrchestrator {
  const orchestrator = new AnalyzerOrchestrator();
  orchestrator.registerAnalyzer({
    id: 'typescript-javascript',
    name: 'TypeScript/JavaScript Analyzer',
    type: 'language',
    version: '1.0.0',
    detectPatterns: {
      files: ['package.json', 'tsconfig.json'],
      content: [/\.ts$/, /\.js$/],
    },
    analyzer: new TypeScriptJavaScriptAnalyzer(),
  });
  orchestrator.registerAnalyzer({
    id: 'nestjs',
    name: 'NestJS Analyzer',
    type: 'framework',
    version: '1.0.0',
    detectPatterns: {
      dependencies: ['@nestjs/core', '@nestjs/common'],
    },
    requires: ['typescript-javascript'],
    analyzer: new NestJSAnalyzer(),
  });
  return orchestrator;
}

/**
 * Regression test for a real bug found on zerac-api (an Nx-style monorepo):
 * NestJS dependencies are hoisted to the workspace root package.json, but each
 * app (apps/user-api, apps/admin-api, ...) has ONLY a Dockerfile — no nested
 * package.json. The orchestrator's `discoverProjectRoots` used the generic
 * `isRegisteredManifest` (which treats Dockerfile as a "manifest") to find
 * nested project roots, so every Dockerfile-only app directory was counted as
 * its own "project". `getAnalyzerScopeFilters` then excluded those directories
 * from the root-scoped NestJS analyzer pass (assuming a dedicated pass would
 * cover them), and since no nested pass exists without a real package.json,
 * every controller under apps/* was silently dropped — 0 entry_points for a
 * repo with hundreds of real HTTP routes.
 *
 * Fix: `isPackageBoundaryManifest` excludes Dockerfile/Containerfile from the
 * predicate used for project-root discovery, so a Dockerfile-only directory is
 * no longer treated as an independent package boundary.
 */
describe('isPackageBoundaryManifest', () => {
  it('still counts Dockerfile as a general registered manifest', () => {
    expect(isRegisteredManifest('apps/user-api/Dockerfile')).toBe(true);
  });

  it('does NOT treat Dockerfile as a package boundary', () => {
    expect(isPackageBoundaryManifest('apps/user-api/Dockerfile')).toBe(false);
    expect(isPackageBoundaryManifest('apps/user-api/Containerfile')).toBe(false);
  });

  it('still treats package.json as a package boundary', () => {
    expect(isPackageBoundaryManifest('libs/business/auth/package.json')).toBe(true);
  });

  it('still treats other real package manifests (Cargo.toml, pom.xml) as boundaries', () => {
    expect(isPackageBoundaryManifest('services/worker/Cargo.toml')).toBe(true);
    expect(isPackageBoundaryManifest('services/api/pom.xml')).toBe(true);
  });
});

describe('NestJS controller discovery in a Dockerfile-only monorepo app', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-monorepo-dockerfile-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const write = async (relative: string, content: string) => {
    const full = path.join(root, relative);
    await fs.ensureDir(path.dirname(full));
    await fs.writeFile(full, content);
  };

  it('still surfaces a controller route as an http entry_point when the app dir has only a Dockerfile (no nested package.json)', async () => {
    // Root package.json: NestJS deps hoisted here, as in a real Nx/Turborepo monorepo.
    await write('package.json', JSON.stringify({
      name: 'zerac-like-monorepo',
      dependencies: { '@nestjs/core': '^10.0.0', '@nestjs/common': '^10.0.0', '@nestjs/platform-express': '^10.0.0' },
    }));

    // apps/user-api: Dockerfile only, NO package.json — the exact shape that broke.
    await write('apps/user-api/Dockerfile', 'FROM node:20\nCOPY . .\nCMD ["node", "main.js"]\n');
    await write('apps/user-api/src/app/app.controller.ts', [
      "import { Controller, Get } from '@nestjs/common';",
      '@Controller()',
      'export class AppController {',
      '  @Get()',
      '  getData() {',
      "    return { message: 'ok' };",
      '  }',
      '}',
    ].join('\n'));

    // A sibling lib WITH a real package.json — must still be treated as its own
    // package boundary (this proves the fix does not over-broaden scope).
    await write('libs/shared/package.json', JSON.stringify({ name: '@app/shared' }));
    await write('libs/shared/src/util.ts', 'export const util = () => 1;\n');

    const orchestrator = createPipelineOrchestrator();
    const output = await orchestrator.orchestrateAnalysis(root);

    const httpEntryPoints = (output.entry_points || []).filter(ep => ep.type === 'http');
    expect(httpEntryPoints.length).toBeGreaterThan(0);

    const routeEntry = httpEntryPoints.find(ep => ep.trigger?.method === 'GET');
    expect(routeEntry).toBeDefined();

    // The handler must resolve to the real controller method node, not a
    // synthetic route-only node — otherwise flow-concepts can't root a real
    // flow at it.
    const handlerNodeId = routeEntry?.handler?.node_id || routeEntry?.source_node;
    const handlerNode = (output.nodes || []).find(n => n.id === handlerNodeId);
    expect(handlerNode).toBeDefined();
    expect(['method', 'function']).toContain(handlerNode?.type);

    // route_table is bridged from entry_points and should include the route too.
    const routeTableEntry = (output as any).route_table?.find((r: any) => r.method === 'GET');
    expect(routeTableEntry).toBeDefined();
  }, 30_000);
});
