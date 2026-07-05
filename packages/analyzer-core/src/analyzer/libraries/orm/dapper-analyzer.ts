import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../../core/base-analyzer';
import { CASNode, CASContribution, FileAnalysisResult } from '../../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { glob } from 'glob';

interface DapperQuerySite {
  method: string;
  resultType?: string;
  table?: string;
  operation: 'read' | 'write';
  filePath: string;
  line: number;
}

const WRITE_KEYWORDS = /^\s*(insert|update|delete)\b/i;
const TABLE_KEYWORDS = /\b(?:from|into|update|join)\s+\[?(\w+)\]?/i;

/**
 * Dapper analyzer (C#).
 *
 * Dapper is a raw-SQL micro-ORM extension over `IDbConnection` — there is no
 * entity/model declaration, only extension-method call sites:
 * `conn.Query<User>("SELECT ...")`, `conn.QueryFirstOrDefault<User>(...)`,
 * `conn.Execute("INSERT ...")`, `conn.QueryAsync<User>(...)`. This mirrors
 * sqlx: the whole contribution is `database` exit points per call site with
 * the mapped result type (when generic), the target table parsed out of the
 * embedded SQL, and read/write direction — enough for get_data_lineage to see
 * Dapper access sites even without a schema model to anchor on.
 */
export class DapperAnalyzer extends BaseAnalyzer {
  constructor() {
    super('dapper', 'Dapper Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    const csprojFiles = await glob('**/*.csproj', {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      absolute: true,
      nodir: true,
    });
    for (const file of csprojFiles) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        if (/PackageReference\s+Include="Dapper"/.test(content)) {
          return true;
        }
      } catch {
        // ignore unreadable files
      }
    }

    const sourceFiles = await glob('**/*.cs', {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      absolute: true,
      nodir: true,
    });

    for (const file of sourceFiles.slice(0, 400)) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        if (/using\s+Dapper\s*;/.test(content) && /\.(Query|Execute)(?:Async|First|FirstOrDefault|Single|SingleOrDefault)?\s*[<(]/.test(content)) {
          return true;
        }
      } catch {
        // ignore unreadable files
      }
    }

    return false;
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const sourceFiles = await glob('**/*.cs', {
      cwd: context.projectPath,
      ignore: this.getIgnorePatterns(context),
      absolute: true,
      nodir: true,
    });

    const sites: DapperQuerySite[] = [];
    for (const file of sourceFiles) {
      let content: string;
      try {
        content = await fs.readFile(file, 'utf-8');
      } catch {
        continue;
      }
      if (!/using\s+Dapper\s*;/.test(content)) continue;
      const relativePath = path.relative(context.projectPath, file);
      sites.push(...this.parseQuerySites(content, relativePath));
    }

    const nodes: CASNode[] = [];
    const exitPoints = this.emitExitPoints(sites, nodes);

    return this.createContribution(nodes, [], [], exitPoints, {
      orm: 'Dapper',
      querySitesFound: sites.length,
    });
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    let sourceFiles: string[] = [];
    try {
      sourceFiles = await glob('**/*.cs', {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true,
      });
    } catch {
      return [];
    }

    const relevant: string[] = [];
    for (const file of sourceFiles) {
      let content: string;
      try {
        content = await fs.readFile(path.join(projectPath, file), 'utf-8');
      } catch {
        continue;
      }
      if (/using\s+Dapper\s*;/.test(content)) {
        relevant.push(file);
      }
    }
    return relevant.sort();
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);

    const sites: DapperQuerySite[] = /using\s+Dapper\s*;/.test(content)
      ? this.parseQuerySites(content, context.relativePath)
      : [];

    const nodes: CASNode[] = [];
    const exitPoints = this.emitExitPoints(sites, nodes);

    return this.createFileAnalysisResult(
      context.filePath,
      context.relativePath,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      nodes,
      [],
      [],
      exitPoints,
      [],
      []
    );
  }

  private emitExitPoints(sites: DapperQuerySite[], nodes: CASNode[]): NonNullable<CASContribution['exit_points']> {
    return sites.slice(0, 40).map((site, index) => {
      const nodeId = `query_dapper_${this.sanitizeId(site.filePath)}_${site.line}_${index}`;
      const label = site.resultType ? `Dapper ${site.method}<${site.resultType}>` : `Dapper ${site.method}`;
      nodes.push(this.createNode(
        nodeId,
        site.table ? `${label} (${site.table})` : label,
        'database_query',
        4,
        site.filePath,
        site.line,
        undefined,
        {
          orm: 'Dapper',
          source: 'dapper_call_site',
          method: site.method,
          resultType: site.resultType,
          table: site.table,
          operation: site.operation,
          subcategories: ['query', 'dapper'],
        }
      ));
      return this.createExitPoint(
        `exit_dapper_${this.sanitizeId(site.filePath)}_${site.line}_${index}`,
        nodeId,
        'database',
        `${label}${site.table ? ` on ${site.table}` : ''}`,
        `Dapper ${site.method} call${site.table ? ` against table '${site.table}'` : ' with an unparsed table target'}.`,
        { resource: site.table },
        { action: site.operation },
        { orm: 'Dapper', table: site.table, method: site.method, resultType: site.resultType, file: site.filePath, line: site.line }
      );
    });
  }

  /**
   * Parse `conn.Query<User>("SELECT * FROM Users WHERE Id = @Id", ...)`,
   * `conn.QueryFirstOrDefault<User>(...)`, `conn.Execute("INSERT INTO ...")`,
   * and their `Async` variants.
   */
  private parseQuerySites(content: string, filePath: string): DapperQuerySite[] {
    const sites: DapperQuerySite[] = [];
    const callRegex = /\.(Query(?:First|FirstOrDefault|Single|SingleOrDefault)?(?:Async)?|Execute(?:ScalarAsync|Async)?)\s*(?:<(\w+)>)?\s*\(\s*(?:@)?"((?:[^"\\]|\\.)*)"/g;
    let match: RegExpExecArray | null;
    while ((match = callRegex.exec(content)) !== null) {
      const method = match[1];
      const resultType = match[2];
      const sql = match[3];
      const line = content.slice(0, match.index).split('\n').length;
      const tableMatch = TABLE_KEYWORDS.exec(sql);
      sites.push({
        method,
        resultType,
        table: tableMatch?.[1],
        operation: WRITE_KEYWORDS.test(sql) || /^Execute/.test(method) ? 'write' : 'read',
        filePath,
        line,
      });
    }
    return sites;
  }

  protected getCapabilities(): string[] {
    return ['dapper-query-sites'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'system';
      case 2: return 'architectural';
      case 3: return 'code';
      case 4: return 'member';
      case 5: return 'implementation';
      default: return 'unknown';
    }
  }
}
