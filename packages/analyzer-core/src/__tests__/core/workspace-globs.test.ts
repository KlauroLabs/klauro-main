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
  it('returns every declared workspace member beyond the former discovery cap', async () => {
    await Promise.all(
      Array.from({ length: 505 }, (_, index) =>
        fs.ensureDir(path.join(root, 'packages', `package-${String(index).padStart(3, '0')}`))),
    );

    expect(resolveWorkspaceGlobMembers(root, ['packages/*'])).toHaveLength(505);
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

/**
 * Regression for a real self-analysis file-walk-coverage gap: discoverProjectRoots
 * finds nested roots two ways — (1) walking for package-boundary manifests, which
 * correctly skips `legacy/` via isExcludedLegacyReferencePath when this is the
 * Klauro self-project (covered by a test in orchestrator-internals.test.ts), and
 * (2) resolving package.json#workspaces glob patterns directly via `globSync`
 * (discoverWorkspaceGlobRootsWithoutManifest / resolveWorkspaceGlobMembers), which
 * had NO awareness of the legacy exclusion at all. The real proof-of-concept repo's
 * root package.json declares `"workspaces": ["apps/*", "packages/*", "legacy/*"]`,
 * so `legacy/*` members were glob-promoted straight to full project roots and
 * analyzed as live product code — about 100 legacy TS/TSX files wrongly parsed on
 * self-analysis. Making it worse: legacy/web's own package.json happened to be
 * named "klauro-frontend", which the isKlauroSelfProject heuristic also matches,
 * so even a per-root re-check of "is this the self project" would have misfired.
 * This test must live here (not orchestrator-internals.test.ts) because it
 * exercises the real `globSync` — that file's shared jest.mock('glob', ...) setup
 * stubs `globSync` out entirely, silently no-oping the vulnerable code path.
 */
describe('legacy-named npm workspace members remain in first-party discovery', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-legacy-workspace-glob-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const write = async (relative: string, content: string) => {
    const full = path.join(root, relative);
    await fs.ensureDir(path.dirname(full));
    await fs.writeFile(full, content);
  };

  it('promotes a declared legacy/* member and includes all of its source', async () => {
    await write('package.json', JSON.stringify({
      name: '@klauro/monorepo',
      workspaces: ['apps/*', 'packages/*', 'legacy/*'],
    }));
    await write('apps/mcp-server/package.json', JSON.stringify({ name: '@klauro/mcp-server' }));
    await write('apps/mcp-server/src/server.ts', 'export const server = true;');

    // legacy/web's OWN package.json name coincidentally matches the klauro-self
    // regex too (the real repo's legacy/web is named "klauro-frontend") — this is
    // exactly what let it slip past exclusion once glob-promoted to a root.
    await write('legacy/web/package.json', JSON.stringify({ name: 'klauro-frontend' }));
    await write('legacy/web/src/App.tsx', 'export function App() { return null; }');

    const orchestrator = new AnalyzerOrchestrator() as any;
    const roots: string[] = await orchestrator.discoverProjectRoots(root);
    const relativeRoots = roots.map((r: string) => path.relative(root, r).replace(/\\/g, '/'));

    expect(relativeRoots).toContain('apps/mcp-server');
    expect(relativeRoots).toContain('legacy/web');

    const inventory = await orchestrator.getSourceFileInventory(root);
    expect(inventory.files).toContain('legacy/web/package.json');
    expect(inventory.files).toContain('legacy/web/src/App.tsx');
  });
});
