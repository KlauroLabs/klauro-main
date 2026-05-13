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
  '.rb',
  '.swift',
  '.c', '.cpp', '.h', '.hpp',
];

const IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.git/**',
  '**/coverage/**',
  '**/.nyc_output/**',
  '**/__pycache__/**',
  '**/.pytest_cache/**',
  '**/target/**',
  '**/vendor/**',
  '**/.venv/**',
  '**/venv/**',
];

export class ChangeDetector {
  private projectPath: string;
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
      return true;
    } catch {
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
        const enriched = await this.enrichWithDependencies(gitChanges, previousState);
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
        if (stat.mtimeMs > lastAnalysisTimestamp) {
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

      const processChange = (file: string, status: string) => {
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
          detectionMethod: 'git',
        };
      }

      return {
        added: added.filter(f => this.isSourceFile(f)),
        modified: modified.filter(f => this.isSourceFile(f)),
        deleted: deleted.filter(f => this.isSourceFile(f)),
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
        ['diff', '--name-status', `${previousCommit}..HEAD`],
        { cwd: this.projectPath, stdio: 'pipe' }
      ).toString();

      return this.parseGitDiff(output);
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

  private getUncommittedChanges(): Array<{ file: string; status: string }> {
    const output = execFileSync('git', ['status', '--porcelain'], {
      cwd: this.projectPath,
      stdio: 'pipe',
    }).toString();

    return this.parseGitStatus(output);
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
        deleted.push(filePath);
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

    for (const filePath of allCurrentFiles) {
      if (!previousState.files[filePath] && !added.includes(filePath)) {
        added.push(filePath);
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

    if (changedCount / totalFiles > threshold) {
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
