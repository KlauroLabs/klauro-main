import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, FileAnalysisResult
} from '../../types/cas.types';
import * as fs from 'fs-extra';
import { glob } from 'glob';
import * as path from 'path';

// C# scalar/value types that should be treated as fields, not relations.
const SCALAR_TYPES = new Set([
  'int', 'long', 'short', 'byte', 'bool', 'string', 'char', 'float', 'double',
  'decimal', 'datetime', 'datetimeoffset', 'timespan', 'guid', 'object', 'uint',
  'ulong', 'ushort', 'sbyte', 'int32', 'int64', 'int16', 'boolean', 'datetimeoffset',
]);
const COLLECTION_GENERICS = new Set([
  'list', 'icollection', 'ienumerable', 'ilist', 'hashset', 'iset', 'collection',
  'observablecollection', 'ireadonlylist', 'ireadonlycollection',
]);

interface EFField {
  name: string;
  type: string;
  isKey: boolean;
  isRequired: boolean;
  maxLength?: number;
  isForeignKey: boolean;
  line: number;
}

interface EFNavigation {
  name: string;
  targetType: string;     // entity type referenced
  isCollection: boolean;  // List<T> / ICollection<T> -> one-to-many
  isForeignKey: boolean;
  line: number;
}

interface EFEntity {
  name: string;
  fields: EFField[];
  navigations: EFNavigation[];
  filePath: string;
  line: number;
}

interface EFDbSet {
  property: string;
  entityType: string;
}

interface EFFluentRelation {
  fromEntity: string;
  toEntity: string;
  kind: string; // HasMany/WithOne, HasOne/WithMany etc.
}

interface EFContext {
  name: string;
  dbSets: EFDbSet[];
  fluentRelations: EFFluentRelation[];
  filePath: string;
  line: number;
}

interface EFFileResult {
  contexts: EFContext[];
  entities: EFEntity[];
}

export class EFCoreAnalyzer extends BaseAnalyzer {
  constructor() {
    super('efcore', 'EF Core Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      // 1. Microsoft.EntityFrameworkCore referenced in any .csproj
      const csprojs = await glob('**/*.csproj', {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true,
      });
      for (const rel of csprojs) {
        const content = await fs.readFile(path.join(projectPath, rel), 'utf-8').catch(() => '');
        if (/Microsoft\.EntityFrameworkCore/i.test(content)) return true;
      }
      // 2. Any class extending DbContext
      const csFiles = await glob('**/*.cs', {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true,
      });
      for (const rel of csFiles.slice(0, 500)) {
        const content = await fs.readFile(path.join(projectPath, rel), 'utf-8').catch(() => '');
        if (/class\s+\w+\s*:\s*[^{]*\bDbContext\b/.test(content)) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const files = await glob('**/*.cs', {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true,
    });
    return files.sort();
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);

    const parsed = this.parseFile(context.relativePath, content);
    // Single-file: DbSet entity types resolve against entities defined in this file only.
    const entityNames = new Set(parsed.entities.map(e => e.name));
    this.emitFile(parsed, entityNames, nodes, edges);

    const exports = [
      ...parsed.contexts.map(c => c.name),
      ...parsed.entities.map(e => e.name),
    ];

    return this.createFileAnalysisResult(
      context.filePath,
      context.relativePath,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      nodes,
      edges,
      entryPoints,
      exitPoints,
      [],
      exports
    );
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    this.resetAnalysisWarnings();
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];

    let csFiles = await glob('**/*.cs', {
      cwd: context.projectPath,
      ignore: this.getIgnorePatterns(context),
      nodir: true,
    });
    csFiles.sort();
    csFiles = this.capAndPrioritizeSourceFiles(csFiles, 'C# files');

    const allContexts: EFContext[] = [];
    const allEntities: EFEntity[] = [];

    for (const rel of csFiles) {
      const content = await fs.readFile(path.join(context.projectPath, rel), 'utf-8').catch(() => '');
      if (!content) continue;
      const parsed = this.parseFile(rel, content);
      allContexts.push(...parsed.contexts);
      allEntities.push(...parsed.entities);
    }

    // Resolve relations against the full entity set across the repo.
    const entityNames = new Set(allEntities.map(e => e.name));
    this.emitFile({ contexts: allContexts, entities: allEntities }, entityNames, nodes, edges);

    const warnings = this.collectAnalysisWarnings();
    return this.createContribution(nodes, edges, [], [], {
      ...(warnings.length > 0 ? { warnings } : {}),
      framework_specific: {
        orm: 'EF Core',
        contextsFound: allContexts.length,
        entitiesFound: allEntities.length,
        relationshipsFound: edges.filter(e => e.type === 'references').length,
      }
    });
  }

  // --- shared emit helper ------------------------------------------------------------

  private emitFile(
    parsed: EFFileResult,
    entityNames: Set<string>,
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    const entityNodeId = (name: string) => `efcore_entity_${this.sanitizeId(name)}`;

    // DbContext nodes
    for (const ctx of parsed.contexts) {
      const ctxId = `efcore_context_${this.sanitizeId(ctx.name)}`;
      nodes.push(this.createNode(
        ctxId,
        ctx.name,
        'db-context',
        3,
        ctx.filePath,
        ctx.line,
        undefined,
        {
          orm: 'EF Core',
          source: 'efcore_dbcontext',
          dbSets: ctx.dbSets.map(s => ({ property: s.property, entity: s.entityType })),
          annotations: ['DbContext'],
          subcategories: ['context', 'efcore'],
        }
      ));

      // context -> entity (exposes) edges via DbSet<T>
      for (const set of ctx.dbSets) {
        if (entityNames.has(set.entityType)) {
          edges.push(this.createEdge(
            `efcore_dbset_${this.sanitizeId(ctx.name)}_${this.sanitizeId(set.entityType)}`,
            ctxId,
            entityNodeId(set.entityType),
            'exposes',
            'database',
            { attributes: { kind: 'dbset', property: set.property, entity: set.entityType } }
          ));
        }
      }

      // Fluent API relations from OnModelCreating
      for (const rel of ctx.fluentRelations) {
        if (entityNames.has(rel.fromEntity) && entityNames.has(rel.toEntity)) {
          edges.push(this.createEdge(
            `efcore_fluent_${this.sanitizeId(rel.fromEntity)}_${this.sanitizeId(rel.toEntity)}_${this.sanitizeId(rel.kind)}`,
            entityNodeId(rel.fromEntity),
            entityNodeId(rel.toEntity),
            'references',
            'database',
            { attributes: { kind: 'fluent', relation: rel.kind, source: 'OnModelCreating' } }
          ));
        }
      }
    }

    // Entity nodes
    for (const entity of parsed.entities) {
      const fields = entity.fields.map(f => ({
        name: f.name,
        type: f.type,
        primary: f.isKey,
        required: f.isRequired,
        maxLength: f.maxLength,
        foreignKey: f.isForeignKey,
      }));
      nodes.push(this.createNode(
        entityNodeId(entity.name),
        entity.name,
        'entity',
        3,
        entity.filePath,
        entity.line,
        undefined,
        {
          orm: 'EF Core',
          source: 'efcore_entity',
          fields,
          annotations: ['EFCoreEntity'],
          subcategories: ['entity', 'efcore'],
        }
      ));

      // Navigation-property relations
      for (const nav of entity.navigations) {
        if (entityNames.has(nav.targetType)) {
          edges.push(this.createEdge(
            `efcore_rel_${this.sanitizeId(entity.name)}_${this.sanitizeId(nav.name)}_${this.sanitizeId(nav.targetType)}`,
            entityNodeId(entity.name),
            entityNodeId(nav.targetType),
            'references',
            'database',
            {
              attributes: {
                kind: 'navigation',
                relationType: nav.isCollection ? 'OneToMany' : 'ManyToOne',
                property: nav.name,
                targetEntity: nav.targetType,
                foreignKey: nav.isForeignKey,
              }
            }
          ));
        }
      }
    }
  }

  // --- parsing -----------------------------------------------------------------------

  private parseFile(relativePath: string, content: string): EFFileResult {
    const contexts: EFContext[] = [];
    const entities: EFEntity[] = [];

    const classes = this.extractClasses(content);
    for (const cls of classes) {
      if (/\bDbContext\b/.test(cls.bases)) {
        contexts.push({
          name: cls.name,
          dbSets: this.parseDbSets(cls.body),
          fluentRelations: this.parseFluentRelations(cls.body),
          filePath: relativePath,
          line: cls.line,
        });
      } else {
        const { fields, navigations } = this.parseEntityMembers(cls.body);
        // Treat as an entity only if it has at least one property.
        if (fields.length > 0 || navigations.length > 0) {
          entities.push({
            name: cls.name,
            fields,
            navigations,
            filePath: relativePath,
            line: cls.line,
          });
        }
      }
    }

    return { contexts, entities };
  }

  private extractClasses(content: string): Array<{ name: string; bases: string; body: string; line: number }> {
    const results: Array<{ name: string; bases: string; body: string; line: number }> = [];
    const classRegex = /(?:public|internal|sealed|abstract|partial|\s)*\bclass\s+(\w+)(?:<[^>]*>)?\s*(?::\s*([^{]+))?\{/g;
    let match: RegExpExecArray | null;
    while ((match = classRegex.exec(content)) !== null) {
      const name = match[1];
      const bases = (match[2] || '').trim();
      const bodyStart = classRegex.lastIndex; // position just after '{'
      const body = this.extractBalancedBody(content, bodyStart - 1);
      const line = content.slice(0, match.index).split('\n').length;
      results.push({ name, bases, body, line });
    }
    return results;
  }

  // Given index of an opening '{', return the substring up to the matching '}'.
  private extractBalancedBody(content: string, openBraceIdx: number): string {
    let depth = 0;
    for (let i = openBraceIdx; i < content.length; i++) {
      const ch = content[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          return content.slice(openBraceIdx + 1, i);
        }
      }
    }
    return content.slice(openBraceIdx + 1);
  }

  private parseDbSets(body: string): EFDbSet[] {
    const sets: EFDbSet[] = [];
    const re = /\bDbSet<\s*(\w+)\s*>\s+(\w+)\s*\{\s*get\s*;\s*set\s*;\s*\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      sets.push({ entityType: m[1], property: m[2] });
    }
    return sets;
  }

  private parseFluentRelations(body: string): EFFluentRelation[] {
    const relations: EFFluentRelation[] = [];
    // modelBuilder.Entity<User>().HasMany(u => u.Orders).WithOne(o => o.User)
    const chainRe = /Entity<\s*(\w+)\s*>\s*\(\)\s*((?:\.\w+\([^;]*?\))+)\s*;/g;
    let m: RegExpExecArray | null;
    while ((m = chainRe.exec(body)) !== null) {
      const fromEntity = m[1];
      const chain = m[2];
      // Pull navigation lambdas like u => u.Orders to discover target via property type is hard;
      // instead capture HasMany/HasOne target entity through WithOne/WithMany lambda param types is unavailable.
      // We record the relation kinds; target entity resolution falls back to lambda member names.
      const kindMatch = chain.match(/\b(HasMany|HasOne)\b/);
      const withMatch = chain.match(/\b(WithOne|WithMany)\b/);
      const kind = `${kindMatch ? kindMatch[1] : ''}${withMatch ? '/' + withMatch[1] : ''}`;
      // Try to resolve target entity from the navigation member: .HasMany(x => x.Orders)
      const navMember = chain.match(/Has(?:Many|One)\(\s*\w+\s*=>\s*\w+\.(\w+)/);
      if (navMember) {
        // Best-effort: singularize collection member to entity name (Orders -> Order).
        const member = navMember[1];
        const target = member.endsWith('s') ? member.slice(0, -1) : member;
        relations.push({ fromEntity, toEntity: target, kind: kind || 'Fluent' });
      }
    }
    return relations;
  }

  private parseEntityMembers(body: string): { fields: EFField[]; navigations: EFNavigation[] } {
    const fields: EFField[] = [];
    const navigations: EFNavigation[] = [];

    const lines = body.split(/\r?\n/);
    let pendingAttrs: string[] = [];

    const propRe = /^\s*public\s+(?:virtual\s+)?([A-Za-z0-9_<>?.,\s]+?)\s+(\w+)\s*\{\s*get\s*;\s*(?:set\s*;|private\s+set\s*;)?\s*\}/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const attrMatch = line.match(/\[([^\]]+)\]/g);
      if (attrMatch && !propRe.test(line)) {
        pendingAttrs.push(...attrMatch.map(a => a.slice(1, -1)));
        continue;
      }

      const pm = line.match(propRe);
      if (!pm) {
        if (line.trim() !== '' && !line.trim().startsWith('//')) {
          pendingAttrs = [];
        }
        continue;
      }

      const rawType = pm[1].trim();
      const propName = pm[2];
      const attrs = pendingAttrs.slice();
      pendingAttrs = [];

      const attrStr = attrs.join(' ');
      const isKey = /\bKey\b/.test(attrStr) || propName.toLowerCase() === 'id';
      const isRequired = /\bRequired\b/.test(attrStr) || (!rawType.includes('?') && this.isScalar(rawType));
      const maxLenMatch = attrStr.match(/MaxLength\s*\(\s*(\d+)\s*\)/);
      const maxLength = maxLenMatch ? parseInt(maxLenMatch[1], 10) : undefined;
      const isForeignKey = /\bForeignKey\b/.test(attrStr);

      const collGeneric = rawType.match(/^([A-Za-z]+)\s*<\s*(\w+)\s*>/);
      if (collGeneric && COLLECTION_GENERICS.has(collGeneric[1].toLowerCase())) {
        const inner = collGeneric[2];
        if (!this.isScalar(inner)) {
          navigations.push({
            name: propName,
            targetType: inner,
            isCollection: true,
            isForeignKey,
            line: 0,
          });
          continue;
        }
      }

      const baseType = rawType.replace('?', '').trim();
      if (!this.isScalar(baseType) && /^[A-Z]\w*$/.test(baseType) && !baseType.includes('<')) {
        // reference navigation property (public User User { get; set; })
        navigations.push({
          name: propName,
          targetType: baseType,
          isCollection: false,
          isForeignKey,
          line: 0,
        });
        continue;
      }

      fields.push({
        name: propName,
        type: rawType,
        isKey,
        isRequired,
        maxLength,
        isForeignKey,
        line: 0,
      });
    }

    return { fields, navigations };
  }

  private isScalar(type: string): boolean {
    const base = type.replace(/\?|\[\]/g, '').trim().toLowerCase();
    return SCALAR_TYPES.has(base);
  }

  protected getCapabilities(): string[] {
    return ['efcore-dbcontext', 'efcore-entities', 'efcore-relations'];
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
