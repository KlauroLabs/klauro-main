import { execFileSync } from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as crypto from 'crypto';
import { glob } from 'glob';
import {
  IncrementalState,
  FileAnalysisRecord,
  ChangeSet,
  FULL_REBUILD_THRESHOLD,
} from '../../types/cas.types';
import { computeAffectedFileClosure } from './incremental-impact';
import { getRegisteredSourceExtensions, isRegisteredSourceExtension } from './language-registry';
import { BUILD_ARTIFACT_GLOBS, THIRD_PARTY_SOURCE_GLOBS } from './build-artifact-paths';

const CORE_CONFIG_FILES = [
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'tsconfig.*.json',
  'angular.json',
  'nest-cli.json',
  'next.config.js',
  'next.config.mjs',
  'vite.config.ts',
  'vite.config.js',
  'webpack.config.js',
  'pyproject.toml',
  'setup.py',
  'requirements.txt',
  'Cargo.toml',
  'Cargo.lock',
  'go.mod',
  'go.sum',
  'pubspec.yaml',
  'pubspec.lock',
  'pom.xml',
  'build.gradle',
  'composer.json',
  'composer.lock',
];

const CORE_CONFIG_PATTERNS = CORE_CONFIG_FILES.flatMap(pattern =>
  pattern.startsWith('**/') || pattern.includes('/')
    ? [pattern]
    : [pattern, `**/${pattern}`]
);

const PROJECT_SCOPE_TRIGGER_FILES = [
  'AndroidManifest.xml',
  'Dockerfile*',
  'docker-compose*.yml',
  'docker-compose*.yaml',
  'compose.yml',
  'compose.yaml',
  'settings.gradle',
  'settings.gradle.kts',
  '*.csproj',
  'Cargo.toml',
  'go.mod',
  'package.json',
  'pom.xml',
];

export const PROJECT_SCOPE_TRIGGER_PATTERNS = PROJECT_SCOPE_TRIGGER_FILES.flatMap(pattern =>
  pattern.startsWith('**/') || pattern.includes('/')
    ? [pattern]
    : [pattern, `**/${pattern}`]
);

function basenameMatchesGlob(basename: string, pattern: string): boolean {
  const escaped = pattern
    .split(/([*?])/)
    .map(part => {
      if (part === '*') return '.*';
      if (part === '?') return '.';
      return part.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${escaped}$`).test(basename);
}

function matchesProjectScopeTrigger(file: string): boolean {
  const basename = path.basename(file);
  return PROJECT_SCOPE_TRIGGER_FILES.some(pattern => basenameMatchesGlob(basename, pattern));
}

const SOURCE_EXTENSIONS = getRegisteredSourceExtensions().map(extension => `.${extension}`);

const IGNORE_PATTERNS = [
  '**/node_modules/**',
  ...BUILD_ARTIFACT_GLOBS,
  '**/build/**',
  '**/out/**',
  '**/.git/**',
  '**/.claude/**',
  '**/.codex/**',
  '**/.agents/**',
  '**/.klauro*/**',
  '**/.terraform/**',
  '**/coverage/**',
  '**/.nyc_output/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/.cache/**',
  '**/.vite/**',
  '**/__pycache__/**',
  '**/.pytest_cache/**',
  '**/target/**',
  ...THIRD_PARTY_SOURCE_GLOBS,
  '**/examples/**',
  '**/Examples/**',
  '**/fixtures/**',
  '**/__fixtures__/**',
  '**/testdata/**',
  '**/cas-tests/**',
  '**/samples/**',
  '**/Samples/**',
  '**/.venv/**',
  '**/venv/**',
  '**/env/**',
  '**/site-packages/**',
  '**/.sourcemaps/**',
  '**/sourcemaps/**',
  '**/.dart_tool/**',
  '**/.flutter-plugins',
  '**/.flutter-plugins-dependencies',
  '**/*.js.map',
  '**/*.css.map',
  '**/*.bundle.js',
  '**/*.bundle.css',
  '**/*.min.js',
  '**/*.min.css',
  '**/storybook-static/**',
  '**/storybook-build/**',
  '**/public/assets/**',
  '**/static/assets/**',
  '**/src/assets/**',
  '**/web/assets/**',
  '**/Generated/**',
  '**/generated/**',
];

export class ChangeDetector {
  private projectPath: string;
  private projectRealPath: string;
  private gitRoot: string | null = null;
  private isGitRepo: boolean;
  private lastSourceFileScan: string[] | null = null;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
    try {
      this.projectRealPath = fs.realpathSync(projectPath);
    } catch {
      this.projectRealPath = projectPath;
    }
    this.isGitRepo = this.checkGitRepo();
  }

  private checkGitRepo(): boolean {
    try {
      execFileSync('git', ['rev-parse', '--git-dir'], {
        cwd: this.projectPath,
        stdio: 'pipe',
      });
      const reportedRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: this.projectPath,
        stdio: 'pipe',
      }).toString().trim();
      try {
        this.gitRoot = fs.realpathSync(reportedRoot);
      } catch {
        this.gitRoot = reportedRoot;
      }
      return true;
    } catch {
      this.gitRoot = null;
      return false;
    }
  }

  async detectChanges(previousState: IncrementalState | null): Promise<ChangeSet> {
    if (!previousState) {
      return this.createFullRebuildChangeSet('No previous analysis state');
    }

    if (previousState.version !== '1.0.0') {
      return this.createFullRebuildChangeSet('State version mismatch');
    }

    if (this.isGitRepo && previousState.gitCommitHash && !this.commitExists(previousState.gitCommitHash)) {
      return this.createFullRebuildChangeSet('Previous Git commit is no longer reachable');
    }

    const mtimeCandidates = await this.scanByMtime(previousState.lastAnalysisTimestamp);

    if (mtimeCandidates.length === 0 && this.isGitRepo) {
      const gitStatus = this.getGitStatus();
      if (gitStatus.length === 0) {
        return this.createEmptyChangeSet();
      }
    }

    if (this.isGitRepo) {
      const gitChanges = await this.detectGitChanges(previousState.gitCommitHash);
      if (gitChanges) {
        const contentFilteredGitChanges = await this.filterUnchangedGitChanges(gitChanges, previousState);
        if (this.isEmptyChangeSet(contentFilteredGitChanges)) {
          return this.createEmptyChangeSet();
        }
        const hashChanges = mtimeCandidates.length > 0
          ? await this.detectByHash(mtimeCandidates, previousState)
          : null;
        const detectedChanges = hashChanges
          ? this.mergeChangeSets(contentFilteredGitChanges, hashChanges)
          : contentFilteredGitChanges;
        const coreConfigChanged = this.checkCoreConfigChanges([
          ...detectedChanges.added,
          ...detectedChanges.modified,
          ...detectedChanges.deleted,
        ]);
        if (coreConfigChanged && this.shouldFullRebuildForCoreConfigChange()) {
          return this.createFullRebuildChangeSet(`Core configuration changed: ${coreConfigChanged}`);
        }
        const projectScopeTrigger = this.checkProjectScopeTrigger([
          ...detectedChanges.added,
          ...detectedChanges.modified,
          ...detectedChanges.deleted,
        ]);
        if (projectScopeTrigger) {
          return this.createFullRebuildChangeSet(`project-scope trigger changed: ${projectScopeTrigger}`);
        }
        const enriched = await this.enrichWithDependencies(detectedChanges, previousState);
        if (this.shouldTriggerFullRebuild(enriched, previousState)) {
          return this.createFullRebuildChangeSet(enriched.reason || 'Threshold exceeded');
        }
        return enriched;
      }
    }

    return this.detectByHash(mtimeCandidates, previousState);
  }

  private async scanByMtime(lastAnalysisTimestamp: number): Promise<string[]> {
    const candidates: string[] = [];
    const entries = await this.scanSourceFileEntries();
    this.lastSourceFileScan = entries.map(entry => entry.file);

    for (const entry of entries) {
      if (entry.mtimeMs === null || entry.mtimeMs >= lastAnalysisTimestamp - 1000) {
        candidates.push(path.relative(this.projectPath, entry.file));
      }
    }

    return candidates;
  }

  private async getAllSourceFiles(): Promise<string[]> {
    const entries = await this.scanSourceFileEntries();
    return entries.map(entry => entry.file);
  }

  private async scanSourceFileEntries(): Promise<Array<{ file: string; mtimeMs: number | null }>> {
    const patterns = [
      ...SOURCE_EXTENSIONS.map(ext => `**/*${ext}`),
      ...CORE_CONFIG_PATTERNS,
      ...PROJECT_SCOPE_TRIGGER_PATTERNS,
    ];

    const matches = await glob(patterns, {
      cwd: this.projectPath,
      ignore: IGNORE_PATTERNS,
      nodir: true,
      withFileTypes: true,
      stat: true,
    });

    const entries: Array<{ file: string; mtimeMs: number | null }> = [];
    const seen = new Set<string>();
    for (const match of matches) {
      const file = match.fullpath();
      if (seen.has(file)) continue;
      seen.add(file);
      entries.push({ file, mtimeMs: match.mtimeMs ?? null });
    }
    return entries;
  }

  private async detectGitChanges(previousCommit?: string): Promise<ChangeSet | null> {
    try {
      const committed = previousCommit ? this.getCommittedChanges(previousCommit) : [];
      const uncommitted = this.getUncommittedChanges();

      const added: string[] = [];
      const modified: string[] = [];
      const deleted: string[] = [];

      const processChange = (rawFile: string, status: string) => {
        const file = this.toProjectRelativeGitPath(rawFile);
        if (!file) return;
        if (status === 'A' || status === '?') {
          if (!added.includes(file)) added.push(file);
        } else if (status === 'D') {
          if (!deleted.includes(file)) deleted.push(file);
        } else if (status === 'M' || status === 'R' || status === 'C') {
          if (!modified.includes(file)) modified.push(file);
        }
      };

      for (const { file, status } of committed) {
        processChange(file, status);
      }
      for (const { file, status } of uncommitted) {
        processChange(file, status);
      }

      return {
        added: added.filter(f => this.isTrackedAnalysisFile(f)),
        modified: modified.filter(f => this.isTrackedAnalysisFile(f)),
        deleted: deleted.filter(f => this.isTrackedAnalysisFile(f)),
        affectedFiles: [],
        affectedNodeIds: new Set<string>(),
        requiresFullRebuild: false,
        detectionMethod: 'git',
      };
    } catch (error) {
      console.warn('Git change detection failed:', error);
      return null;
    }
  }

  private getCommittedChanges(previousCommit: string): Array<{ file: string; status: string }> {
    try {
      const commitExists = this.commitExists(previousCommit);
      if (!commitExists) {
        return [];
      }

      const output = execFileSync(
        'git',
        ['diff', '--name-status', '-z', `${previousCommit}..HEAD`],
        { cwd: this.projectPath, stdio: 'pipe', maxBuffer: 1024 * 1024 * 50 }
      ).toString();

      return this.parseGitDiffZ(output);
    } catch {
      return [];
    }
  }

  private commitExists(commit: string): boolean {
    try {
      execFileSync('git', ['rev-parse', '--verify', `${commit}^{commit}`], {
        cwd: this.projectPath,
        stdio: 'pipe',
      });
      return true;
    } catch {
      return false;
    }
  }

  private async filterUnchangedGitChanges(changeSet: ChangeSet, previousState: IncrementalState): Promise<ChangeSet> {
    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];

    for (const file of changeSet.added) {
      const previousRecord = previousState.files[file];
      if (!previousRecord) {
        added.push(file);
        continue;
      }
      if (await this.fileHashChanged(file, previousRecord)) {
        modified.push(file);
      }
    }

    for (const file of changeSet.modified) {
      const previousRecord = previousState.files[file];
      if (!previousRecord) {
        added.push(file);
        continue;
      }
      if (await this.fileHashChanged(file, previousRecord)) {
        modified.push(file);
      }
    }

    for (const file of changeSet.deleted) {
      if (!(await fs.pathExists(path.join(this.projectPath, file)))) {
        deleted.push(file);
      }
    }

    return {
      ...changeSet,
      added: this.uniquePaths(added),
      modified: this.uniquePaths(modified).filter(file => !added.includes(file) && !deleted.includes(file)),
      deleted: this.uniquePaths(deleted),
      affectedFiles: [],
      affectedNodeIds: new Set<string>(),
      requiresFullRebuild: false,
      reason: undefined,
      detectionMethod: 'hybrid',
    };
  }

  private async fileHashChanged(file: string, previousRecord: FileAnalysisRecord): Promise<boolean> {
    const fullPath = path.join(this.projectPath, file);
    if (!(await fs.pathExists(fullPath))) return true;
    const currentHash = await this.computeFileHash(fullPath);
    return currentHash !== previousRecord.contentHash;
  }

  private getUncommittedChanges(): Array<{ file: string; status: string }> {
    const output = execFileSync('git', ['status', '--porcelain=v1', '-z', '-uall'], {
      cwd: this.projectPath,
      stdio: 'pipe',
      maxBuffer: 1024 * 1024 * 50,
    }).toString();

    return this.parseGitStatusZ(output);
  }

  private getGitStatus(): Array<{ file: string; status: string }> {
    try {
      return this.getUncommittedChanges();
    } catch {
      return [];
    }
  }


  private parseGitDiffZ(output: string): Array<{ file: string; status: string }> {
    const changes: Array<{ file: string; status: string }> = [];
    const parts = output.split('\0').filter(Boolean);

    for (let index = 0; index < parts.length;) {
      const status = parts[index++];
      const code = status[0];
      if (!code) continue;
      if (code === 'R' || code === 'C') {
        const oldFile = parts[index++];
        const newFile = parts[index++];
        if (oldFile) changes.push({ status: 'D', file: oldFile });
        if (newFile) changes.push({ status: 'A', file: newFile });
        continue;
      }
      const file = parts[index++];
      if (file) changes.push({ status: code, file });
    }

    return changes;
  }


  private parseGitStatusZ(output: string): Array<{ file: string; status: string }> {
    const changes: Array<{ file: string; status: string }> = [];
    const parts = output.split('\0').filter(Boolean);

    for (let index = 0; index < parts.length;) {
      const entry = parts[index++];
      if (!entry || entry.length < 4) continue;
      const staged = entry[0];
      const unstaged = entry[1];
      const file = entry.substring(3);

      if (staged === 'R' || staged === 'C') {
        const oldFile = parts[index++];
        if (oldFile) changes.push({ status: 'D', file: oldFile });
        if (file) changes.push({ status: 'A', file });
        continue;
      }

      if (staged === '?' || unstaged === '?') {
        changes.push({ status: '?', file });
      } else if (staged !== ' ') {
        changes.push({ status: staged, file });
      } else if (unstaged !== ' ') {
        changes.push({ status: unstaged, file });
      }
    }

    return changes;
  }

  private async detectByHash(
    mtimeCandidates: string[],
    previousState: IncrementalState
  ): Promise<ChangeSet> {
    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];

    const allCurrentFiles = new Set(
      (this.lastSourceFileScan || await this.getAllSourceFiles()).map(f => path.relative(this.projectPath, f))
    );

    for (const filePath of Object.keys(previousState.files)) {
      if (!allCurrentFiles.has(filePath)) {
        if (!(await fs.pathExists(path.join(this.projectPath, filePath)))) {
          deleted.push(filePath);
        }
      }
    }

    for (const filePath of mtimeCandidates) {
      const previousRecord = previousState.files[filePath];
      if (!previousRecord) {
        added.push(filePath);
        continue;
      }

      const fullPath = path.join(this.projectPath, filePath);
      const currentHash = await this.computeFileHash(fullPath);

      if (currentHash !== previousRecord.contentHash) {
        modified.push(filePath);
      }
    }

    const coreConfigChanged = this.checkCoreConfigChanges([...added, ...modified, ...deleted]);
    if (coreConfigChanged && this.shouldFullRebuildForCoreConfigChange()) {
      return {
        added,
        modified,
        deleted,
        affectedFiles: [],
        affectedNodeIds: new Set<string>(),
        requiresFullRebuild: true,
        reason: `Core configuration changed: ${coreConfigChanged}`,
        detectionMethod: 'hash',
      };
    }

    const projectScopeTrigger = this.checkProjectScopeTrigger([...added, ...modified, ...deleted]);
    if (projectScopeTrigger) {
      return {
        added,
        modified,
        deleted,
        affectedFiles: [],
        affectedNodeIds: new Set<string>(),
        requiresFullRebuild: true,
        reason: `project-scope trigger changed: ${projectScopeTrigger}`,
        detectionMethod: 'hash',
      };
    }

    return this.enrichWithDependencies({
      added,
      modified,
      deleted,
      affectedFiles: [],
      affectedNodeIds: new Set<string>(),
      requiresFullRebuild: false,
      detectionMethod: 'hash',
    }, previousState);
  }

  private async enrichWithDependencies(
    changeSet: ChangeSet,
    previousState: IncrementalState
  ): Promise<ChangeSet> {
    const affectedFiles = new Set<string>();
    const affectedNodeIds = new Set<string>();

    const changedFiles = new Set([
      ...changeSet.added,
      ...changeSet.modified,
      ...changeSet.deleted,
    ]);

    for (const file of computeAffectedFileClosure(changedFiles, previousState.files)) {
      affectedFiles.add(file);
    }

    for (const file of changedFiles) {
      const record = previousState.files[file];
      if (!record) continue;
      for (const nodeId of record.nodeIds) affectedNodeIds.add(nodeId);
    }

    for (const file of affectedFiles) {
      const record = previousState.files[file];
      if (record) {
        for (const nodeId of record.nodeIds) {
          affectedNodeIds.add(nodeId);
        }
      }
    }

    return {
      ...changeSet,
      affectedFiles: Array.from(affectedFiles),
      affectedNodeIds,
    };
  }

  private mergeChangeSets(primary: ChangeSet, secondary: ChangeSet): ChangeSet {
    const added = this.uniquePaths([...primary.added, ...secondary.added]);
    const deleted = this.uniquePaths([...primary.deleted, ...secondary.deleted]);
    const modified = this.uniquePaths([...primary.modified, ...secondary.modified])
      .filter(file => !added.includes(file) && !deleted.includes(file));
    const affectedFiles = this.uniquePaths([
      ...(primary.affectedFiles || []),
      ...(secondary.affectedFiles || []),
    ]);
    const affectedNodeIds = new Set<string>([
      ...(primary.affectedNodeIds || []),
      ...(secondary.affectedNodeIds || []),
    ]);

    return {
      added,
      modified,
      deleted,
      affectedFiles,
      affectedNodeIds,
      requiresFullRebuild: primary.requiresFullRebuild || secondary.requiresFullRebuild,
      reason: [primary.reason, secondary.reason].filter(Boolean).join('; ') || undefined,
      detectionMethod: primary.detectionMethod === secondary.detectionMethod
        ? primary.detectionMethod
        : 'hybrid',
    };
  }

  private isEmptyChangeSet(changeSet: ChangeSet): boolean {
    return !changeSet.requiresFullRebuild &&
      changeSet.added.length === 0 &&
      changeSet.modified.length === 0 &&
      changeSet.deleted.length === 0;
  }

  private uniquePaths(paths: string[]): string[] {
    return [...new Set(paths.map(file => file.replace(/\\/g, '/')))];
  }

  private toProjectRelativeGitPath(file: string): string | null {
    const normalizedFile = file.replace(/\\/g, '/');
    if (!this.gitRoot) {
      return normalizedFile;
    }

    const absolute = path.resolve(this.gitRoot, normalizedFile);
    const relativeToProject = path.relative(this.projectRealPath, absolute).replace(/\\/g, '/');
    if (!relativeToProject || relativeToProject.startsWith('../') || path.isAbsolute(relativeToProject)) {
      return null;
    }
    return relativeToProject;
  }

  private shouldTriggerFullRebuild(changeSet: ChangeSet, state: IncrementalState): boolean {
    if (changeSet.requiresFullRebuild) {
      return true;
    }

    const totalFiles = Object.keys(state.files).length;
    if (totalFiles === 0) {
      return true;
    }

    const changedCount =
      changeSet.added.length + changeSet.modified.length + changeSet.deleted.length;
    const threshold = state.config?.rebuildThreshold ?? FULL_REBUILD_THRESHOLD;

    if (totalFiles >= 10 && changedCount / totalFiles > threshold) {
      changeSet.reason = `${Math.round((changedCount / totalFiles) * 100)}% of files changed (threshold: ${threshold * 100}%)`;
      return true;
    }

    return false;
  }

  private checkCoreConfigChanges(changedFiles: string[]): string | null {
    for (const file of changedFiles) {
      const basename = path.basename(file);
      if (CORE_CONFIG_FILES.includes(basename)) {
        return basename;
      }
      for (const pattern of CORE_CONFIG_FILES) {
        if (pattern.includes('*')) {
          const regex = new RegExp('^' + pattern.replace('*', '.*') + '$');
          if (regex.test(basename)) {
            return basename;
          }
        }
      }
    }
    return null;
  }

  private shouldFullRebuildForCoreConfigChange(): boolean {
    const configured = process.env.KLAURO_FULL_REBUILD_ON_CONFIG_CHANGE?.toLowerCase();
    if (configured === 'false' || configured === '0' || configured === 'no') {
      return false;
    }
    if (configured === 'true' || configured === '1' || configured === 'yes') {
      return true;
    }
    return process.env.KLAURO_ANALYSIS_FOCUS !== 'agent-fast';
  }

  private isSourceFile(file: string): boolean {
    return isRegisteredSourceExtension(file);
  }

  private isTrackedAnalysisFile(file: string): boolean {
    return this.isSourceFile(file) ||
      this.checkCoreConfigChanges([file]) !== null ||
      matchesProjectScopeTrigger(file);
  }

  private checkProjectScopeTrigger(changedFiles: string[]): string | null {
    for (const file of changedFiles) {
      if (matchesProjectScopeTrigger(file)) return file;
    }
    return null;
  }

  private async computeFileHash(filePath: string): Promise<string> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
    } catch {
      return '';
    }
  }

  private createEmptyChangeSet(): ChangeSet {
    return {
      added: [],
      modified: [],
      deleted: [],
      affectedFiles: [],
      affectedNodeIds: new Set<string>(),
      requiresFullRebuild: false,
      detectionMethod: 'git',
    };
  }

  private createFullRebuildChangeSet(reason: string): ChangeSet {
    return {
      added: [],
      modified: [],
      deleted: [],
      affectedFiles: [],
      affectedNodeIds: new Set<string>(),
      requiresFullRebuild: true,
      reason,
      detectionMethod: 'git',
    };
  }

  getCurrentGitCommit(): string | undefined {
    if (!this.isGitRepo) {
      return undefined;
    }
    try {
      return execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: this.projectPath,
        stdio: 'pipe',
      })
        .toString()
        .trim();
    } catch {
      return undefined;
    }
  }

  isGitAvailable(): boolean {
    return this.isGitRepo;
  }
}
