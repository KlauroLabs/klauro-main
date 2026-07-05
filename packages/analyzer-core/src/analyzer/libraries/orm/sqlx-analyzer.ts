import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../../core/base-analyzer';
import { CASNode, CASContribution, FileAnalysisResult } from '../../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { glob } from 'glob';

interface SqlxQuerySite {
  macro: string;
  table?: string;
  operation: 'read' | 'write';
  filePath: string;
  line: number;
}

const WRITE_KEYWORDS = /^\s*(insert|update|delete)\b/i;
const TABLE_KEYWORDS = /\b(?:from|into|update|join)\s+["'`]?(\w+)["'`]?/i;

/**
 * sqlx analyzer (Rust).
 *
 * sqlx is a compile-time-checked raw-SQL query library, not an ORM — it has no
 * entity/model declaration at all, only call sites: `sqlx::query!("SELECT ...")`,
 * `query_as!(User, "SELECT * FROM users WHERE id = $1", id)`, and the untyped
 * `query()`/`query_as()`/`query_scalar()` builder functions. There is nothing
 * to surface as an `entity` node, so this analyzer's whole contribution is
 * `database` exit points per call site: the target table (parsed out of the
 * embedded SQL's FROM/INTO/UPDATE/JOIN clause when present) and read/write
 * direction, so `get_data_lineage` still sees sqlx access even without a
 * schema model.
 */
export class SqlxAnalyzer extends BaseAnalyzer {
  constructor() {
    super('sqlx', 'sqlx Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    const cargoPath = path.join(projectPath, 'Cargo.toml');
    if (await fs.pathExists(cargoPath)) {
      const content = await fs.readFile(cargoPath, 'utf-8');
      if (/\bsqlx\s*=/.test(content)) {
        return true;
      }
    }

    const ignorePatterns = ['target/**', '**/target/**'];
    const sourceFiles = await glob('**/*.rs', {
      cwd: projectPath,
      ignore: ignorePatterns,
      absolute: true,
      nodir: true,
    });

    for (const file of sourceFiles.slice(0, 400)) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        if (/sqlx::query(?:_as|_scalar)?!?\s*[(!]/.test(content)) {
          return true;
        }
      } catch {
        // ignore unreadable files
      }
    }

    return false;
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const ignorePatterns = this.getIgnorePatterns(context);
    const sourceFiles = await glob('**/*.rs', {
      cwd: context.projectPath,
      ignore: ignorePatterns,
      absolute: true,
      nodir: true,
    });

    const sites: SqlxQuerySite[] = [];
    for (const file of sourceFiles) {
      let content: string;
      try {
        content = await fs.readFile(file, 'utf-8');
      } catch {
        continue;
      }
      if (!/sqlx::query/.test(content)) continue;
      const relativePath = path.relative(context.projectPath, file);
      sites.push(...this.parseQuerySites(content, relativePath));
    }

    const nodes: CASNode[] = [];
    const exitPoints = this.emitExitPoints(sites, nodes);

    return this.createContribution(nodes, [], [], exitPoints, {
      orm: 'sqlx',
      querySitesFound: sites.length,
    });
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    let sourceFiles: string[] = [];
    try {
      sourceFiles = await glob('**/*.rs', {
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
      if (/sqlx::query/.test(content)) {
        relevant.push(file);
      }
    }
    return relevant.sort();
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);

    const sites: SqlxQuerySite[] = /sqlx::query/.test(content)
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

  private emitExitPoints(sites: SqlxQuerySite[], nodes: CASNode[]): NonNullable<CASContribution['exit_points']> {
    return sites.slice(0, 40).map((site, index) => {
      const nodeId = `query_sqlx_${this.sanitizeId(site.filePath)}_${site.line}_${index}`;
      nodes.push(this.createNode(
        nodeId,
        site.table ? `sqlx ${site.macro} (${site.table})` : `sqlx ${site.macro}`,
        'database_query',
        4,
        site.filePath,
        site.line,
        undefined,
        {
          orm: 'sqlx',
          source: 'sqlx_query_macro',
          macro: site.macro,
          table: site.table,
          operation: site.operation,
          subcategories: ['query', 'sqlx'],
        }
      ));
      return this.createExitPoint(
        `exit_sqlx_${this.sanitizeId(site.filePath)}_${site.line}_${index}`,
        nodeId,
        'database',
        `sqlx ${site.macro}${site.table ? ` on ${site.table}` : ''}`,
        `sqlx ${site.macro} call${site.table ? ` against table '${site.table}'` : ' with an unparsed table target'}.`,
        { resource: site.table },
        { action: site.operation },
        { orm: 'sqlx', table: site.table, macro: site.macro, file: site.filePath, line: site.line }
      );
    });
  }

  /**
   * Parse `sqlx::query!("...")`, `sqlx::query_as!(Type, "...")`,
   * `sqlx::query_scalar!("...")`, and their non-macro (`query(...)`) siblings,
   * extracting the embedded SQL literal to classify read/write and pull the
   * target table out of FROM/INTO/UPDATE/JOIN.
   */
  private parseQuerySites(content: string, filePath: string): SqlxQuerySite[] {
    const sites: SqlxQuerySite[] = [];
    const callRegex = /sqlx::(query(?:_as|_scalar)?)!?\s*\(\s*(?:\w+\s*,\s*)?"((?:[^"\\]|\\.)*)"/g;
    let match: RegExpExecArray | null;
    while ((match = callRegex.exec(content)) !== null) {
      const macro = match[1];
      const sql = match[2];
      const line = content.slice(0, match.index).split('\n').length;
      const tableMatch = TABLE_KEYWORDS.exec(sql);
      sites.push({
        macro,
        table: tableMatch?.[1],
        operation: WRITE_KEYWORDS.test(sql) ? 'write' : 'read',
        filePath,
        line,
      });
    }
    return sites;
  }

  protected getCapabilities(): string[] {
    return ['sqlx-query-sites'];
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
