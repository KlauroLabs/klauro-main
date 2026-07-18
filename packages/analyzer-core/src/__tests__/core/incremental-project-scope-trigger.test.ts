jest.unmock('fs');
jest.unmock('fs-extra');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import { ChangeDetector } from '../../analyzer/core/change-detector';
import type { IncrementalState } from '../../types/cas.types';

/**
 * LIVE DEFECT (#60): a project-level analyzer pass (e.g. a platform-manifest
 * -> entry-point join, a container/topology join, a build/settings-driven
 * module-membership join) reads a project-scope file whose facts span the
 * WHOLE codebase, not just the one file. When ONLY that file changes, the
 * ordinary single-file incremental path re-parses the changed file but never
 * re-runs the project-level join that consumes it, so the join's output goes
 * stale with zero warnings until a forced cold rebuild.
 *
 * This guards the fix in change-detector.ts: PROJECT_SCOPE_TRIGGER_FILES
 * (platform manifests, container/topology descriptors, build/settings files)
 * unconditionally escalate ChangeDetector.detectChanges() to a full rebuild,
 * with a named reason ("project-scope trigger changed: <file>"), while
 * leaving the ordinary warm incremental path for regular source edits
 * untouched.
 */
function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
}

function initGitRepo(root: string): void {
  execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@klauro.test'], { cwd: root, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Klauro Test'], { cwd: root, stdio: 'pipe' });
}

function commitAll(root: string, message: string): string {
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', message], { cwd: root, stdio: 'pipe' });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: 'pipe' }).toString().trim();
}

async function basePreviousState(root: string, commitHash: string, files: Record<string, string>): Promise<IncrementalState> {
  const stateFiles: IncrementalState['files'] = {};
  for (const [relPath, content] of Object.entries(files)) {
    stateFiles[relPath] = {
      filePath: relPath,
      contentHash: contentHash(content),
      mtimeMs: Date.now() - 10_000,
      lastAnalyzed: new Date(Date.now() - 10_000).toISOString(),
      analyzerId: 'test-analyzer',
      nodeIds: [],
      edgeIds: [],
      entryPointIds: [],
      exitPointIds: [],
      importedFiles: [],
      exportedSymbols: [],
    };
  }
  return {
    version: '1.0.0',
    projectPath: root,
    lastFullAnalysis: new Date(Date.now() - 10_000).toISOString(),
    lastAnalysisTimestamp: Date.now() - 10_000,
    gitCommitHash: commitHash,
    files: stateFiles,
    analyzerVersions: {},
  };
}

describe('ChangeDetector project-scope trigger escalation (#60)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-project-scope-trigger-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('escalates to a full rebuild with a named reason when a platform manifest (AndroidManifest.xml) is added', async () => {
    const indexContent = 'export class Foo { bar(): number { return 1; } }\n';
    await fs.outputFile(path.join(root, 'src', 'index.ts'), indexContent);
    initGitRepo(root);
    const commitHash = commitAll(root, 'initial commit (no manifest)');
    const previousState = await basePreviousState(root, commitHash, { 'src/index.ts': indexContent });

    // Simulate the exact live incident: re-upload WITH the manifest, only
    // that file changed.
    await fs.outputFile(
      path.join(root, 'src', 'main', 'AndroidManifest.xml'),
      '<manifest package="com.example.app"><application/></manifest>'
    );

    const changeSet = await new ChangeDetector(root).detectChanges(previousState);

    expect(changeSet.requiresFullRebuild).toBe(true);
    expect(changeSet.reason).toContain('project-scope trigger changed');
    expect(changeSet.reason).toContain('AndroidManifest.xml');
  });

  it('escalates to a full rebuild when a container/topology file (docker-compose.yml) changes', async () => {
    const indexContent = 'export class Foo { bar(): number { return 1; } }\n';
    const composeContentBefore = 'services:\n  app:\n    image: app:1\n';
    await fs.outputFile(path.join(root, 'src', 'index.ts'), indexContent);
    await fs.outputFile(path.join(root, 'docker-compose.yml'), composeContentBefore);
    initGitRepo(root);
    const commitHash = commitAll(root, 'initial commit');
    const previousState = await basePreviousState(root, commitHash, {
      'src/index.ts': indexContent,
      'docker-compose.yml': composeContentBefore,
    });

    await fs.outputFile(path.join(root, 'docker-compose.yml'), 'services:\n  app:\n    image: app:2\n  db:\n    image: postgres\n');

    const changeSet = await new ChangeDetector(root).detectChanges(previousState);

    expect(changeSet.requiresFullRebuild).toBe(true);
    expect(changeSet.reason).toContain('project-scope trigger changed');
    expect(changeSet.reason).toContain('docker-compose.yml');
  });

  it('stays on the ordinary incremental path when only an everyday source file changes', async () => {
    const indexContentBefore = 'export class Foo { bar(): number { return 1; } }\n';
    await fs.outputFile(path.join(root, 'src', 'index.ts'), indexContentBefore);
    initGitRepo(root);
    const commitHash = commitAll(root, 'initial commit');
    const previousState = await basePreviousState(root, commitHash, { 'src/index.ts': indexContentBefore });

    await fs.outputFile(path.join(root, 'src', 'index.ts'), 'export class Foo { bar(): number { return 2; } }\n');

    const changeSet = await new ChangeDetector(root).detectChanges(previousState);

    expect(changeSet.requiresFullRebuild).toBe(false);
    expect(changeSet.reason).toBeUndefined();
    const allChanged = [...changeSet.added, ...changeSet.modified, ...changeSet.deleted];
    expect(allChanged).toEqual(['src/index.ts']);
  });

  it('escalates when a project-scope trigger file changes ALONGSIDE an ordinary source edit', async () => {
    const indexContentBefore = 'export class Foo { bar(): number { return 1; } }\n';
    await fs.outputFile(path.join(root, 'src', 'index.ts'), indexContentBefore);
    await fs.outputFile(path.join(root, 'Dockerfile'), 'FROM node:18\n');
    initGitRepo(root);
    const commitHash = commitAll(root, 'initial commit');
    const previousState = await basePreviousState(root, commitHash, {
      'src/index.ts': indexContentBefore,
      Dockerfile: 'FROM node:18\n',
    });

    await fs.outputFile(path.join(root, 'src', 'index.ts'), 'export class Foo { bar(): number { return 2; } }\n');
    await fs.outputFile(path.join(root, 'Dockerfile'), 'FROM node:20\n');

    const changeSet = await new ChangeDetector(root).detectChanges(previousState);

    expect(changeSet.requiresFullRebuild).toBe(true);
    expect(changeSet.reason).toContain('project-scope trigger changed');
    expect(changeSet.reason).toContain('Dockerfile');
  });
});
