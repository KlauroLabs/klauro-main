import { BaseAnalyzer, AnalysisContext } from '../core/base-analyzer';
import { CASNode, CASEdge, CASEntryPoint, CASContribution, CASExitPoint } from '../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../core/glob-cache';

type CronLibrary = 'cron' | 'node-cron' | 'nestjs-schedule';

interface ScheduledJob {
  library: CronLibrary;
  schedule: string;
  handler: string;
  file: string;
  line: number;
  decoratorKind?: 'Cron' | 'Interval' | 'Timeout';
}

/**
 * CronAnalyzer
 *
 * Detects scheduled-job entry points — real flow roots that a route/CLI-only view
 * of a codebase misses entirely. Covers three real-world scheduling libraries:
 *
 *   - `cron` (the `cron` npm package): `new CronJob(schedule, fn, ...)` /
 *     `CronJob.from({ cronTime, onTick })`
 *   - `node-cron`: `cron.schedule(schedule, fn)`
 *   - `@nestjs/schedule`: `@Cron(schedule)` / `@Interval(ms)` / `@Timeout(ms)`
 *     decorators on a class method
 *
 * Each detected job becomes a `schedule`-type entry point whose handler resolves
 * to the real function/method node, carrying the schedule expression as metadata
 * (`trigger.schedule`) so `get_flow_concepts` can root a flow at it exactly like an
 * HTTP route or CLI command.
 */
export class CronAnalyzer extends BaseAnalyzer {
  constructor() {
    super('cron', 'Scheduled Job (Cron) Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const packageJsonPath = path.join(projectPath, 'package.json');
      if (!await fs.pathExists(packageJsonPath)) return false;
      const packageJson = await fs.readJson(packageJsonPath);
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      return Object.keys(deps).some(dep => dep === 'cron' || dep === 'node-cron' || dep === '@nestjs/schedule');
    } catch {
      return false;
    }
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    const deps = await this.collectDeps(context.projectPath);
    const hasCron = deps.has('cron');
    const hasNodeCron = deps.has('node-cron');
    const hasNestSchedule = deps.has('@nestjs/schedule');

    const groundedFiles = this.filesFromExistingAnalysis(
      context,
      source => source === 'cron' || source.startsWith('cron/') ||
        source === 'node-cron' || source.startsWith('node-cron/') ||
        source === '@nestjs/schedule' || source.startsWith('@nestjs/schedule/')
    );
    const jsFiles = context.existingAnalysis?.length
      ? groundedFiles
      : await glob(['**/*.{js,ts}'], {
        cwd: context.projectPath,
        ignore: [...this.getIgnorePatterns(context), '**/*.test.*', '**/*.spec.*'],
        nodir: true
      });

    const jobs: ScheduledJob[] = [];

    for (const file of jsFiles) {
      const fullPath = path.join(context.projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (hasCron) jobs.push(...this.extractCronPackageJobs(content, file));
      if (hasNodeCron) jobs.push(...this.extractNodeCronJobs(content, file));
      if (hasNestSchedule) jobs.push(...this.extractNestScheduleJobs(content, file));
    }

    jobs.forEach((job, index) => {
      const jobId = `scheduled_job_${this.sanitizeId(job.library)}_${this.sanitizeId(job.handler)}_${index}`;
      const fullPath = path.join(context.projectPath, job.file);

      const jobNode = this.createNodeBuilder(jobId, job.handler, 'scheduled_job')
        .withLevel(3, 'code')
        .withCategory('scheduled_job', ['cron', job.library])
        .withSource({ file: fullPath, line: job.line, end_line: job.line })
        .withDescription(`Scheduled job (${job.library}): ${job.handler} on schedule "${job.schedule}"`)
        .withMetadata({
          framework: job.library,
          attributes: {
            schedule: job.schedule,
            library: job.library,
            decoratorKind: job.decoratorKind
          }
        })
        .build();
      nodes.push(jobNode);

      entryPoints.push({
        id: `entry_${jobId}`,
        name: `Scheduled: ${job.handler}`,
        type: 'schedule',
        source_node: jobId,
        description: `${job.handler} runs on schedule "${job.schedule}" (${job.library}).`,
        trigger: { schedule: job.schedule },
        handler: {
          node_id: jobId,
          method_name: job.handler,
          file: job.file,
          line: job.line
        },
        metadata: {
          library: job.library,
          schedule: job.schedule,
          handler: job.handler,
          handler_file: job.file
        }
      } as CASEntryPoint);
    });

    return this.createContribution(nodes, edges, entryPoints, exitPoints, {
      framework: 'cron',
      jobsFound: jobs.length,
      librariesDetected: [
        ...(hasCron ? ['cron'] : []),
        ...(hasNodeCron ? ['node-cron'] : []),
        ...(hasNestSchedule ? ['@nestjs/schedule'] : [])
      ]
    });
  }

  private async collectDeps(projectPath: string): Promise<Set<string>> {
    try {
      const packageJson = await fs.readJson(path.join(projectPath, 'package.json'));
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      return new Set(Object.keys(deps));
    } catch {
      return new Set();
    }
  }

  /**
   * `cron` package: `new CronJob(schedule, onTick, ...)` or `new cron.CronJob(...)`,
   * and the static factory `CronJob.from({ cronTime, onTick })`.
   */
  private extractCronPackageJobs(content: string, file: string): ScheduledJob[] {
    const jobs: ScheduledJob[] = [];

    // new CronJob('<expr>', <fn>, ...) / new cron.CronJob('<expr>', <fn>, ...)
    const ctorPattern = /new\s+(?:cron\.)?CronJob\s*\(\s*(['"`])([^'"`]+)\1\s*,/g;
    let m: RegExpExecArray | null;
    while ((m = ctorPattern.exec(content)) !== null) {
      const schedule = m[2];
      const line = content.slice(0, m.index).split('\n').length;
      const args = this.parseRemainingCallArgs(content, ctorPattern.lastIndex);
      const handler = this.describeHandler(args[0] || 'anonymous', content, file, line);
      jobs.push({ library: 'cron', schedule, handler, file, line });
    }

    // CronJob.from({ cronTime: '<expr>', onTick: <fn> })
    const fromPattern = /CronJob\.from\s*\(\s*\{/g;
    while ((m = fromPattern.exec(content)) !== null) {
      const objStart = m.index + m[0].length - 1;
      const objText = this.extractBalancedBraces(content, objStart);
      if (!objText) continue;
      const cronTimeMatch = /cronTime\s*:\s*(['"`])([^'"`]+)\1/.exec(objText);
      const onTickMatch = /onTick\s*:\s*([A-Za-z_$][\w$.]*)/.exec(objText);
      if (!cronTimeMatch) continue;
      const line = content.slice(0, m.index).split('\n').length;
      jobs.push({
        library: 'cron',
        schedule: cronTimeMatch[2],
        handler: onTickMatch ? onTickMatch[1] : 'inline handler',
        file,
        line
      });
    }

    return jobs;
  }

  /** node-cron: `cron.schedule('<expr>', <fn>)` / `schedule('<expr>', <fn>)`. */
  private extractNodeCronJobs(content: string, file: string): ScheduledJob[] {
    const jobs: ScheduledJob[] = [];
    const pattern = /\b(?:cron\.)?schedule\s*\(\s*(['"`])([^'"`]+)\1\s*,/g;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
      const schedule = m[2];
      const line = content.slice(0, m.index).split('\n').length;
      const args = this.parseRemainingCallArgs(content, pattern.lastIndex);
      const handler = this.describeHandler(args[0] || 'anonymous', content, file, line);
      jobs.push({ library: 'node-cron', schedule, handler, file, line });
    }
    return jobs;
  }

  /**
   * `@nestjs/schedule` decorators on class methods:
   *   @Cron('* * * * *') method() {}
   *   @Interval(5000) method() {}
   *   @Timeout(1000) method() {}
   * The handler is the decorated method name — the decorator sits immediately
   * above the method declaration.
   */
  private extractNestScheduleJobs(content: string, file: string): ScheduledJob[] {
    const jobs: ScheduledJob[] = [];
    const pattern = /@(Cron|Interval|Timeout)\s*\(\s*([^)]*)\)\s*\n\s*(?:public\s+|private\s+|protected\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
      const decoratorKind = m[1] as 'Cron' | 'Interval' | 'Timeout';
      const rawArg = m[2].trim();
      const methodName = m[3];
      const line = content.slice(0, m.index).split('\n').length;

      // @Cron takes a cron expression (string) or CronExpression enum member;
      // @Interval/@Timeout take a millisecond number. Represent both as the
      // schedule string verbatim so the raw expression/ms value is preserved.
      const stringMatch = /^(['"`])([^'"`]+)\1$/.exec(rawArg);
      const schedule = stringMatch ? stringMatch[2] : rawArg || 'unspecified';

      jobs.push({ library: 'nestjs-schedule', schedule, handler: methodName, file, line, decoratorKind });
    }
    return jobs;
  }

  /** Resolve the handler arg to a readable name: bare identifier as-is, otherwise
   *  a generic "inline handler" marker (still navigable via file+line). */
  private describeHandler(raw: string, _content: string, _file: string, _line: number): string {
    const trimmed = raw.trim();
    if (/^[A-Za-z_$][\w$.]*$/.test(trimmed)) return trimmed;
    if (/^async\s+[A-Za-z_$][\w$.]*$/.test(trimmed)) return trimmed.replace(/^async\s+/, '');
    return 'inline handler';
  }

  /** Parse the arguments of a call starting just after the schedule string
   *  (depth 1), splitting on top-level commas while respecting nested
   *  parens/brackets/braces and string/template literals. */
  private parseRemainingCallArgs(content: string, pos: number): string[] {
    const args: string[] = [];
    let depth = 1;
    let cur = '';
    let inStr: string | null = null;
    for (let i = pos; i < content.length; i++) {
      const ch = content[i];
      if (inStr) {
        cur += ch;
        if (ch === inStr && content[i - 1] !== '\\') inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; cur += ch; continue; }
      if (ch === '(' || ch === '[' || ch === '{') { depth++; cur += ch; continue; }
      if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) { if (cur.trim()) args.push(cur.trim()); break; }
        cur += ch;
        continue;
      }
      if (ch === ',' && depth === 1) { if (cur.trim()) args.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    return args;
  }

  private extractBalancedBraces(content: string, openBraceIndex: number): string | null {
    let depth = 0;
    let inStr: string | null = null;
    for (let i = openBraceIndex; i < content.length; i++) {
      const ch = content[i];
      if (inStr) {
        if (ch === inStr && content[i - 1] !== '\\') inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) return content.slice(openBraceIndex + 1, i);
      }
    }
    return null;
  }

  protected getCapabilities(): string[] {
    return ['cron-job-detection', 'scheduled-entry-points', 'nestjs-schedule-decorators'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'system';
      case 2: return 'architectural';
      case 3: return 'code';
      case 4: return 'member';
      case 5: return 'implementation';
      default: return `level_${level}`;
    }
  }
}
