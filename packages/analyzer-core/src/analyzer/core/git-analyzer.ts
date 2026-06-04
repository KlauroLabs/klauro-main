import { execFileSync } from 'child_process';
import * as path from 'path';

export interface GitFileMetrics {
  filePath: string;
  commits30d: number;
  commits90d: number;
  commitsTotal: number;
  uniqueAuthors30d: number;
  linesChanged30d: number;
  bugFixCommits30d: number;
  bugFixRate: number;
  fileAgeDays: number;
  lastModified: string | null;
  lastMajorChange: string | null;
  hasRecentRegression: boolean;
  isHighChurn: boolean;
}

export interface GitCommitInfo {
  hash: string;
  author: string;
  date: string;
  message: string;
  filesChanged: string[];
  linesAdded: number;
  linesDeleted: number;
}

const BUG_FIX_PATTERNS = [
  /\bfix(es|ed|ing)?\b/i,
  /\bbug\b/i,
  /\bpatch\b/i,
  /\bissue\b/i,
  /\bhotfix\b/i,
  /\bresolve[sd]?\b/i,
  /\bcorrect(s|ed|ing)?\b/i,
  /\brepair(s|ed|ing)?\b/i
];

const REGRESSION_PATTERNS = [
  /\bregression\b/i,
  /\brevert\b/i,
  /\brollback\b/i,
  /\bundo\b/i,
  /\bre-?fix\b/i
];

const REFACTOR_PATTERNS = [
  /\brefactor\b/i,
  /\brestructure\b/i,
  /\breorganize\b/i,
  /\bcleanup\b/i,
  /\bclean up\b/i,
  /\bsimplify\b/i,
  /\bmodernize\b/i
];

export class GitAnalyzer {
  private projectPath: string;
  private isGitRepo: boolean;
  private commitCache: Map<string, GitCommitInfo[]> = new Map();
  private fileMetricsCache: Map<string, GitFileMetrics> = new Map();
  private fileAgeCache: Map<string, number> = new Map();

  constructor(projectPath: string) {
    this.projectPath = projectPath;
    this.isGitRepo = this.checkGitRepo();
  }

  private checkGitRepo(): boolean {
    try {
      execFileSync('git', ['rev-parse', '--git-dir'], {
        cwd: this.projectPath,
        stdio: 'pipe'
      });
      return true;
    } catch {
      return false;
    }
  }

  isAvailable(): boolean {
    return this.isGitRepo;
  }

  preloadAllFileMetrics(filePaths: string[]): void {
    if (!this.isGitRepo || filePaths.length === 0) {
      return;
    }

    try {
      const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      const since = ninetyDaysAgo.toISOString().split('T')[0];

      const output = execFileSync(
        'git',
        ['log', `--since=${since}`, '--format=%H|%an|%aI|%s', '--numstat'],
        {
          cwd: this.projectPath,
          stdio: 'pipe',
          maxBuffer: 100 * 1024 * 1024
        }
      ).toString();

      const commits = this.parseGitLog(output);

      const commitsByFile = new Map<string, GitCommitInfo[]>();

      for (const commit of commits) {
        for (const changedFile of commit.filesChanged) {
          if (!commitsByFile.has(changedFile)) {
            commitsByFile.set(changedFile, []);
          }
          const fileCommit: GitCommitInfo = {
            hash: commit.hash,
            author: commit.author,
            date: commit.date,
            message: commit.message,
            filesChanged: [changedFile],
            linesAdded: 0,
            linesDeleted: 0
          };
          commitsByFile.get(changedFile)!.push(fileCommit);
        }
      }

      this.parseNumstatPerFile(output, commitsByFile);

      for (const [relativePath, fileCommits] of commitsByFile) {
        if (!this.commitCache.has(relativePath)) {
          this.commitCache.set(relativePath, fileCommits);
        }
      }

      this.preloadFileAges(filePaths);

    } catch {
    }
  }

  private parseNumstatPerFile(output: string, commitsByFile: Map<string, GitCommitInfo[]>): void {
    const lines = output.split('\n');
    let currentHash: string | null = null;

    for (const line of lines) {
      if (!line.trim()) continue;

      if (line.includes('|')) {
        const parts = line.split('|');
        if (parts.length >= 4 && parts[0].length === 40) {
          currentHash = parts[0];
        }
        continue;
      }

      if (currentHash) {
        const statMatch = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
        if (statMatch) {
          const added = statMatch[1] === '-' ? 0 : parseInt(statMatch[1], 10);
          const deleted = statMatch[2] === '-' ? 0 : parseInt(statMatch[2], 10);
          const filePath = statMatch[3];

          const fileCommits = commitsByFile.get(filePath);
          if (fileCommits) {
            const commitEntry = fileCommits.find(c => c.hash === currentHash);
            if (commitEntry) {
              commitEntry.linesAdded += added;
              commitEntry.linesDeleted += deleted;
            }
          }
        }
      }
    }
  }

  private preloadFileAges(filePaths: string[]): void {
    try {
      const output = execFileSync(
        'git',
        ['log', '--diff-filter=A', '--format=%H|%aI', '--name-only'],
        {
          cwd: this.projectPath,
          stdio: 'pipe',
          maxBuffer: 100 * 1024 * 1024
        }
      ).toString();

      const lines = output.split('\n');
      let currentDate: string | null = null;
      const fileCreationDates = new Map<string, string>();

      for (const line of lines) {
        if (!line.trim()) continue;

        if (line.includes('|')) {
          const parts = line.split('|');
          if (parts.length >= 2 && parts[0].length === 40) {
            currentDate = parts[1];
          }
          continue;
        }

        if (currentDate && line.trim()) {
          fileCreationDates.set(line.trim(), currentDate);
        }
      }

      const now = new Date();
      for (const filePath of filePaths) {
        const relativePath = this.getRelativePath(filePath);
        const creationDateStr = fileCreationDates.get(relativePath);
        if (creationDateStr) {
          const creationDate = new Date(creationDateStr);
          const ageDays = Math.floor((now.getTime() - creationDate.getTime()) / (24 * 60 * 60 * 1000));
          this.fileAgeCache.set(relativePath, ageDays);
        }
      }
    } catch {
    }
  }

  getFileMetrics(filePath: string): GitFileMetrics | null {
    if (!this.isGitRepo) {
      return null;
    }

    const cacheKey = filePath;
    if (this.fileMetricsCache.has(cacheKey)) {
      return this.fileMetricsCache.get(cacheKey)!;
    }

    try {
      const relativePath = this.getRelativePath(filePath);
      const commits = this.getCommitsForFile(relativePath);

      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

      const commits30d = commits.filter(c => new Date(c.date) >= thirtyDaysAgo);
      const commits90d = commits.filter(c => new Date(c.date) >= ninetyDaysAgo);

      const bugFixCommits30d = commits30d.filter(c =>
        BUG_FIX_PATTERNS.some(p => p.test(c.message))
      );

      const regressionCommits = commits30d.filter(c =>
        REGRESSION_PATTERNS.some(p => p.test(c.message))
      );

      const refactorCommits90d = commits90d.filter(c =>
        REFACTOR_PATTERNS.some(p => p.test(c.message))
      );

      const uniqueAuthors = new Set(commits30d.map(c => c.author));
      const linesChanged = commits30d.reduce((sum, c) => sum + c.linesAdded + c.linesDeleted, 0);

      const fileAge = this.getFileAge(relativePath);
      const lastModified = commits.length > 0 ? commits[0].date : null;
      const lastMajorChange = refactorCommits90d.length > 0 ? refactorCommits90d[0].date : null;

      const metrics: GitFileMetrics = {
        filePath,
        commits30d: commits30d.length,
        commits90d: commits90d.length,
        commitsTotal: commits.length,
        uniqueAuthors30d: uniqueAuthors.size,
        linesChanged30d: linesChanged,
        bugFixCommits30d: bugFixCommits30d.length,
        bugFixRate: commits30d.length > 0 ? bugFixCommits30d.length / commits30d.length : 0,
        fileAgeDays: fileAge,
        lastModified,
        lastMajorChange,
        hasRecentRegression: regressionCommits.length > 0,
        isHighChurn: commits30d.length > 10 || (commits30d.length > 5 && bugFixCommits30d.length > 1)
      };

      this.fileMetricsCache.set(cacheKey, metrics);
      return metrics;
    } catch (error) {
      return null;
    }
  }

  private getRelativePath(filePath: string): string {
    if (path.isAbsolute(filePath)) {
      return path.relative(this.projectPath, filePath);
    }
    return filePath;
  }

  private getCommitsForFile(relativePath: string): GitCommitInfo[] {
    if (this.commitCache.has(relativePath)) {
      return this.commitCache.get(relativePath)!;
    }

    try {
      const output = execFileSync(
        'git',
        ['log', '--format=%H|%an|%aI|%s', '--numstat', '--', relativePath],
        {
          cwd: this.projectPath,
          stdio: 'pipe',
          maxBuffer: 10 * 1024 * 1024
        }
      ).toString();

      const commits = this.parseGitLog(output);
      this.commitCache.set(relativePath, commits);
      return commits;
    } catch {
      return [];
    }
  }

  private parseGitLog(output: string): GitCommitInfo[] {
    const commits: GitCommitInfo[] = [];
    const lines = output.split('\n');

    let currentCommit: Partial<GitCommitInfo> | null = null;

    for (const line of lines) {
      if (!line.trim()) continue;

      if (line.includes('|')) {
        const parts = line.split('|');
        if (parts.length >= 4 && parts[0].length === 40) {
          if (currentCommit && currentCommit.hash) {
            commits.push(currentCommit as GitCommitInfo);
          }
          currentCommit = {
            hash: parts[0],
            author: parts[1],
            date: parts[2],
            message: parts.slice(3).join('|'),
            filesChanged: [],
            linesAdded: 0,
            linesDeleted: 0
          };
        }
      } else if (currentCommit) {
        const statMatch = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
        if (statMatch) {
          const added = statMatch[1] === '-' ? 0 : parseInt(statMatch[1], 10);
          const deleted = statMatch[2] === '-' ? 0 : parseInt(statMatch[2], 10);
          currentCommit.linesAdded = (currentCommit.linesAdded || 0) + added;
          currentCommit.linesDeleted = (currentCommit.linesDeleted || 0) + deleted;
          currentCommit.filesChanged = currentCommit.filesChanged || [];
          currentCommit.filesChanged.push(statMatch[3]);
        }
      }
    }

    if (currentCommit && currentCommit.hash) {
      commits.push(currentCommit as GitCommitInfo);
    }

    return commits;
  }

  private getFileAge(relativePath: string): number {
    if (this.fileAgeCache.has(relativePath)) {
      return this.fileAgeCache.get(relativePath)!;
    }

    try {
      const output = execFileSync(
        'git',
        ['log', '--diff-filter=A', '--format=%aI', '--', relativePath],
        {
          cwd: this.projectPath,
          stdio: 'pipe'
        }
      ).toString().trim();

      const lines = output.split('\n').filter(Boolean);
      const creationDateStr = lines[lines.length - 1];

      if (!creationDateStr) {
        return 0;
      }

      const creationDate = new Date(creationDateStr);
      const now = new Date();
      const ageDays = Math.floor((now.getTime() - creationDate.getTime()) / (24 * 60 * 60 * 1000));
      this.fileAgeCache.set(relativePath, ageDays);
      return ageDays;
    } catch {
      return 0;
    }
  }

  getRecentHotspots(limit: number = 20): Array<{ file: string; commitCount: number }> {
    if (!this.isGitRepo) {
      return [];
    }

    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const since = thirtyDaysAgo.toISOString().split('T')[0];

      const output = execFileSync(
        'git',
        ['log', `--since=${since}`, '--name-only', '--format='],
        {
          cwd: this.projectPath,
          stdio: 'pipe',
          maxBuffer: 50 * 1024 * 1024
        }
      ).toString();

      const fileCounts = new Map<string, number>();
      for (const line of output.split('\n')) {
        const file = line.trim();
        if (file) {
          fileCounts.set(file, (fileCounts.get(file) || 0) + 1);
        }
      }

      return Array.from(fileCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([file, commitCount]) => ({ file, commitCount }));
    } catch {
      return [];
    }
  }

  getBugFixDensityForDirectory(dirPath: string): number {
    if (!this.isGitRepo) {
      return 0;
    }

    try {
      const relativePath = this.getRelativePath(dirPath);
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const since = thirtyDaysAgo.toISOString().split('T')[0];

      const totalOutput = execFileSync(
        'git',
        ['log', `--since=${since}`, '--oneline', '--', relativePath],
        {
          cwd: this.projectPath,
          stdio: 'pipe'
        }
      ).toString();

      const bugFixOutput = execFileSync(
        'git',
        ['log', `--since=${since}`, '--oneline', '--grep=fix', '--grep=bug', '--grep=patch', '--', relativePath],
        {
          cwd: this.projectPath,
          stdio: 'pipe'
        }
      ).toString();

      const total = totalOutput.split('\n').filter(Boolean).length;
      const bugFixes = bugFixOutput.split('\n').filter(Boolean).length;

      return total > 0 ? bugFixes / total : 0;
    } catch {
      return 0;
    }
  }

  clearCache(): void {
    this.commitCache.clear();
    this.fileMetricsCache.clear();
    this.fileAgeCache.clear();
  }
}
