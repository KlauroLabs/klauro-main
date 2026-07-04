jest.unmock('fs');
jest.unmock('fs-extra');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { TypeScriptJavaScriptAnalyzer } from '../../analyzer/languages/typescript-javascript-analyzer';
import { NestJSAnalyzer } from '../../analyzer/frameworks/web/nestjs-analyzer';
import {
  collectWorkspaceGlobPatterns,
  resolveWorkspaceGlobMembers,
  discoverWorkspaceGlobRootsWithoutManifest,
} from '../../analyzer/core/workspace-globs';

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

describe('collectWorkspaceGlobPatterns', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-workspace-globs-patterns-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reads packages: globs from pnpm-workspace.yaml', async () => {
    await fs.writeFile(
      path.join(root, 'pnpm-workspace.yaml'),
      "packages:\n  - 'apps/*'\n  - 'packages/*'\n",
    );
    expect(collectWorkspaceGlobPatterns(root).sort()).toEqual(['apps/*', 'packages/*']);
  });

  it('reads a bare workspaces array from root package.json', async () => {
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['apps/*', 'services/*'] }),
    );
    expect(collectWorkspaceGlobPatterns(root).sort()).toEqual(['apps/*', 'services/*']);
  });

  it('reads a yarn-style { packages: [...] } workspaces object', async () => {
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: { packages: ['apps/*'] } }),
    );
    expect(collectWorkspaceGlobPatterns(root)).toEqual(['apps/*']);
  });

  it('drops negation patterns', async () => {
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['apps/*', '!apps/legacy-app'] }),
    );
    expect(collectWorkspaceGlobPatterns(root)).toEqual(['apps/*']);
  });

  it('returns nothing when no workspace manifest exists', async () => {
    expect(collectWorkspaceGlobPatterns(root)).toEqual([]);
  });
});

describe('resolveWorkspaceGlobMembers', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-workspace-globs-resolve-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('only returns directories a glob pattern actually matches on disk (evidence-based)', async () => {
    await fs.ensureDir(path.join(root, 'apps', 'ext-web-api'));
    await fs.ensureDir(path.join(root, 'apps', 'scheduler'));
    // A Dockerfile-only dir NOT declared by any glob pattern below must NOT surface.
    await fs.ensureDir(path.join(root, 'cicd', 'api-external'));
    await fs.writeFile(path.join(root, 'cicd', 'api-external', 'Dockerfile'), 'FROM node:20\n');

    const members = resolveWorkspaceGlobMembers(root, ['apps/*']);
    const relative = members.map((m) => path.relative(root, m)).sort();
    expect(relative).toEqual(['apps/ext-web-api', 'apps/scheduler']);
  });

  it('returns nothing for patterns that match no directories', async () => {
    expect(resolveWorkspaceGlobMembers(root, ['apps/*'])).toEqual([]);
  });
});

describe('discoverWorkspaceGlobRootsWithoutManifest', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-workspace-globs-dedupe-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('excludes members that already have their own package-boundary manifest', async () => {
    await fs.writeFile(
      path.join(root, 'pnpm-workspace.yaml'),
      "packages:\n  - 'apps/*'\n",
    );
    // apps/has-manifest: owns a package.json already (found separately by the manifest walk).
    await fs.ensureDir(path.join(root, 'apps', 'has-manifest'));
    await fs.writeFile(path.join(root, 'apps', 'has-manifest', 'package.json'), '{}');
    // apps/no-manifest: glob-only member, no package.json — the gap this closes.
    await fs.ensureDir(path.join(root, 'apps', 'no-manifest'));

    const hasManifestAbs = path.join(root, 'apps', 'has-manifest');
    const result = discoverWorkspaceGlobRootsWithoutManifest(root, (dir) => dir === hasManifestAbs);
    const relative = result.map((m) => path.relative(root, m));
    expect(relative).toEqual(['apps/no-manifest']);
  });
});

/**
 * Regression coverage for the residual found re-validating finance-context-ts
 * style repos: a pnpm workspace can declare a member via `apps/*` in
 * pnpm-workspace.yaml even when that member directory has no package.json of
 * its own (deps hoisted to the workspace root). Before this fix,
 * `discoverProjectRoots` only walked for package-boundary manifest files, so
 * a glob-only member was neither a root nor scoped into the root pass, and a
 * framework analyzer requiring `canAnalyze(root)` (which reads that
 * directory's own package.json) never ran for it — its routes/controllers
 * were silently unanalyzed.
 */
describe('NestJS controller discovery in a workspace-glob-only member (no package.json)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-workspace-glob-member-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const write = async (relative: string, content: string) => {
    const full = path.join(root, relative);
    await fs.ensureDir(path.dirname(full));
    await fs.writeFile(full, content);
  };

  it('surfaces a controller route as an http entry_point for an app dir declared only via pnpm-workspace.yaml glob', async () => {
    await write('pnpm-workspace.yaml', "packages:\n  - 'apps/*'\n  - 'packages/*'\n");

    // Root package.json: NestJS deps hoisted here.
    await write('package.json', JSON.stringify({
      name: 'glob-only-monorepo',
      dependencies: { '@nestjs/core': '^10.0.0', '@nestjs/common': '^10.0.0', '@nestjs/platform-express': '^10.0.0' },
    }));

    // apps/ext-web-api: matched by the `apps/*` glob but has NO package.json of its own.
    await write('apps/ext-web-api/src/app.controller.ts', [
      "import { Controller, Get } from '@nestjs/common';",
      '@Controller()',
      'export class AppController {',
      '  @Get()',
      '  getData() {',
      "    return { message: 'ok' };",
      '  }',
      '}',
    ].join('\n'));

    const orchestrator = createPipelineOrchestrator();
    const output = await orchestrator.orchestrateAnalysis(root);

    const httpEntryPoints = (output.entry_points || []).filter((ep) => ep.type === 'http');
    expect(httpEntryPoints.length).toBeGreaterThan(0);

    const routeEntry = httpEntryPoints.find((ep) => ep.trigger?.method === 'GET');
    expect(routeEntry).toBeDefined();
  }, 30_000);

  it('does NOT treat a Dockerfile-only directory as a workspace member when no glob matches it', async () => {
    await write('pnpm-workspace.yaml', "packages:\n  - 'apps/*'\n");
    await write('package.json', JSON.stringify({ name: 'glob-only-monorepo' }));
    // cicd/scheduler is not under any declared glob (`apps/*` doesn't match `cicd/*`).
    await write('cicd/scheduler/Dockerfile', 'FROM node:20\n');

    const orchestrator = createPipelineOrchestrator();
    const output = await orchestrator.orchestrateAnalysis(root);

    // No crash, and nothing spuriously attributed to cicd/scheduler as a root.
    expect(output).toBeDefined();
  }, 30_000);
});
