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

const SOURCE_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyw',
  '.java', '.kt', '.kts',
  '.cs', '.vb', '.fs',
  '.go',
  '.rs',
  '.php',
  '.dart',
  '.prisma',
  '.tf',
  '.tfvars',
];

const IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.git/**',
  '**/.terraform/**',
  '**/coverage/**',
  '**/.nyc_output/**',
  '**/__pycache__/**',
  '**/.pytest_cache/**',
  '**/target/**',
  '**/vendor/**',
  '**/vendors/**',
  '**/examples/**',
  '**/Examples/**',
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
  '**/Generated/**',
  '**/generated/**',
];

export class ChangeDetector {
  private projectPath: string;
  private gitRoot: string | null = null;
  private isGitRepo: boolean;
  private lastSourceFileScan: string[] | null = null;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
    this.isGitRepo = this.checkGitRepo();
  }

  private checkGitRepo(): boolean {
    try {
      execFileSync('git', ['rev-parse', '--git-dir'], {
        cwd: this.projectPath,
        stdio: 'pipe',
      });
      this.gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: this.projectPath,
        stdio: 'pipe',
      }).toString().trim();
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
        if (coreConfigChanged) {
          return this.createFullRebuildChangeSet(`Core configuration changed: ${coreConfigChanged}`);
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
    const files = await this.getAllSourceFiles();
    this.lastSourceFileScan = files;

    for (const file of files) {
      try {
        const stat = await fs.stat(file);
        if (stat.mtimeMs >= lastAnalysisTimestamp - 1000) {
          candidates.push(path.relative(this.projectPath, file));
        }
      } catch {
        candidates.push(path.relative(this.projectPath, file));
      }
    }

    return candidates;
  }

  private async getAllSourceFiles(): Promise<string[]> {
    const patterns = [
      ...SOURCE_EXTENSIONS.map(ext => `**/*${ext}`),
      ...CORE_CONFIG_PATTERNS,
    ];
    const files: string[] = [];

    for (const pattern of patterns) {
      const matches = await glob(pattern, {
        cwd: this.projectPath,
        absolute: true,
        ignore: IGNORE_PATTERNS,
        nodir: true,
      });
      files.push(...matches);
    }

    return files;
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
      execFileSync('git', ['rev-parse', '--verify', commit], {
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
    const output = execFileSync('git', ['status', '--porcelain=v1', '-z'], {
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

  private parseGitDiff(output: string): Array<{ file: string; status: string }> {
    const changes: Array<{ file: string; status: string }> = [];
    const lines = output.split('\n').filter(Boolean);

    for (const line of lines) {
      const match = line.match(/^([AMDRC])\t(.+)$/);
      if (match) {
        changes.push({ status: match[1], file: match[2] });
      }
      const renameMatch = line.match(/^R\d*\t(.+)\t(.+)$/);
      if (renameMatch) {
        changes.push({ status: 'D', file: renameMatch[1] });
        changes.push({ status: 'A', file: renameMatch[2] });
      }
    }

    return changes;
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

  private parseGitStatus(output: string): Array<{ file: string; status: string }> {
    const changes: Array<{ file: string; status: string }> = [];
    const lines = output.split('\n').filter(Boolean);

    for (const line of lines) {
      const staged = line[0];
      const unstaged = line[1];
      const file = line.substring(3).trim();

      if (file.includes(' -> ')) {
        const [oldFile, newFile] = file.split(' -> ');
        changes.push({ status: 'D', file: oldFile });
        changes.push({ status: 'A', file: newFile });
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
    if (coreConfigChanged) {
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

    return {
      added,
      modified,
      deleted,
      affectedFiles: [],
      affectedNodeIds: new Set<string>(),
      requiresFullRebuild: false,
      detectionMethod: 'hash',
    };
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

    const dependents = this.buildReverseDependencyMap(previousState);

    const queue = [...changedFiles];
    const visited = new Set(changedFiles);
    const MAX_DEPTH = 5;
    let depth = 0;

    while (queue.length > 0 && depth < MAX_DEPTH) {
      const currentBatch = [...queue];
      queue.length = 0;
      depth++;

      for (const file of currentBatch) {
        const deps = dependents.get(file);
        if (deps) {
          for (const dep of deps) {
            if (!visited.has(dep)) {
              visited.add(dep);
              affectedFiles.add(dep);
              queue.push(dep);
            }
          }
        }

        const record = previousState.files[file];
        if (record) {
          for (const nodeId of record.nodeIds) {
            affectedNodeIds.add(nodeId);
          }
        }
      }
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
    const relativeToProject = path.relative(this.projectPath, absolute).replace(/\\/g, '/');
    if (!relativeToProject || relativeToProject.startsWith('../') || path.isAbsolute(relativeToProject)) {
      return null;
    }
    return relativeToProject;
  }

  private buildReverseDependencyMap(state: IncrementalState): Map<string, Set<string>> {
    const dependents = new Map<string, Set<string>>();

    for (const [filePath, record] of Object.entries(state.files)) {
      for (const importedFile of record.importedFiles) {
        if (!dependents.has(importedFile)) {
          dependents.set(importedFile, new Set());
        }
        dependents.get(importedFile)!.add(filePath);
      }
    }

    return dependents;
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

  private isSourceFile(file: string): boolean {
    const ext = path.extname(file).toLowerCase();
    return SOURCE_EXTENSIONS.includes(ext);
  }

  private isTrackedAnalysisFile(file: string): boolean {
    return this.isSourceFile(file) || this.checkCoreConfigChanges([file]) !== null;
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
