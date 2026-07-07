import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, FileAnalysisResult } from '../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../core/glob-cache';

interface SAField {
  name: string;
  type: string;
  isPrimary: boolean;
  isNullable: boolean;
  isUnique: boolean;
  foreignKey?: string; // e.g. "users.id"
}

interface SARelationship {
  name: string;
  target: string; // referenced model class name
}

interface SAModel {
  name: string;
  tableName?: string;
  fields: SAField[];
  relationships: SARelationship[];
  filePath: string;
  line: number;
}

interface PydField {
  name: string;
  type: string;
  hasDefault: boolean;
  nestedModel?: string; // referenced pydantic model name if any
}

interface PydModel {
  name: string;
  fields: PydField[];
  filePath: string;
  line: number;
}

const SA_DETECT = [
  'import sqlalchemy',
  'from sqlalchemy',
  'declarative_base',
  'DeclarativeBase',
];
const PYD_DETECT = ['from pydantic', 'import pydantic', 'BaseModel'];

/**
 * Analyzes SQLAlchemy ORM models (DB entities) and Pydantic models (API/DTO schemas).
 *
 * SQLAlchemy models -> 'entity' nodes (mirrors PrismaAnalyzer field/relation conventions).
 * Pydantic models   -> 'dto' nodes tagged 'pydantic-model' (cross-repo API contracts).
 * Best-effort edges link an entity to its matching Pydantic schema by name.
 */
export class SQLAlchemyPydanticAnalyzer extends BaseAnalyzer {
  constructor() {
    super('sqlalchemy-pydantic', 'SQLAlchemy/Pydantic Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    // 1. Dependency manifests
    const manifests = ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py'];
    for (const manifest of manifests) {
      const manifestPath = path.join(projectPath, manifest);
      if (await fs.pathExists(manifestPath)) {
        const content = (await fs.readFile(manifestPath, 'utf-8')).toLowerCase();
        if (content.includes('sqlalchemy') || content.includes('pydantic') || content.includes('sqlmodel')) {
          return true;
        }
      }
    }

    // 2. Import / base-class signatures in .py files
    let pythonFiles: string[] = [];
    try {
      pythonFiles = await glob(['**/*.py'], {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true,
      });
    } catch {
      pythonFiles = [];
    }

    for (const file of pythonFiles) {
      let content: string;
      try {
        content = await fs.readFile(path.join(projectPath, file), 'utf-8');
      } catch {
        continue;
      }
      if (
        SA_DETECT.some((sig) => content.includes(sig)) ||
        content.includes('from pydantic') ||
        content.includes('import pydantic') ||
        /class\s+\w+\s*\([^)]*\bBaseModel\b[^)]*\)/.test(content)
      ) {
        return true;
      }
    }

    return false;
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];

    const ignorePatterns = this.getIgnorePatterns(context);
    let pyFiles = await glob(['**/*.py'], {
      cwd: context.projectPath,
      ignore: ignorePatterns,
      absolute: true,
      nodir: true,
    });
    pyFiles = this.capAndPrioritizeSourceFiles(pyFiles, 'Python source files');

    const saModels: SAModel[] = [];
    const pydModels: PydModel[] = [];

    for (const file of pyFiles) {
      let content: string;
      try {
        content = await fs.readFile(file, 'utf-8');
      } catch (err) {
        this.addAnalysisWarning(`Failed to read ${file}: ${(err as Error).message}`);
        continue;
      }
      const relativePath = path.relative(context.projectPath, file);

      // Skip files that clearly contain neither
      if (
        !content.includes('sqlalchemy') &&
        !content.includes('SQLAlchemy') &&
        !content.includes('pydantic') &&
        !content.includes('BaseModel') &&
        !content.includes('SQLModel') &&
        !content.includes('DeclarativeBase') &&
        !content.includes('declarative_base')
      ) {
        continue;
      }

      const classified = this.classifyModels(content, relativePath);
      saModels.push(...classified.entities);
      pydModels.push(...classified.dtos);
    }

    this.emitModelNodes(saModels, pydModels, nodes, edges);

    const entityCount = saModels.length;
    const dtoCount = pydModels.length;

    return this.createContribution(nodes, edges, [], [], {
      sqlalchemyModels: entityCount,
      pydanticModels: dtoCount,
      relationshipsFound: edges.length,
      warnings: this.collectAnalysisWarnings(),
    });
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    let pyFiles: string[] = [];
    try {
      pyFiles = await glob(['**/*.py'], {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true,
      });
    } catch {
      return [];
    }

    const relevant: string[] = [];
    for (const file of pyFiles) {
      let content: string;
      try {
        content = await fs.readFile(path.join(projectPath, file), 'utf-8');
      } catch {
        continue;
      }
      if (this.fileMayContainModels(content)) {
        relevant.push(file);
      }
    }
    return relevant.sort();
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);

    let saModels: SAModel[] = [];
    let pydModels: PydModel[] = [];
    // Only files mentioning relevant tokens carry models (matches analyze() guard).
    if (this.fileMayContainModels(content)) {
      const classified = this.classifyModels(content, context.relativePath);
      saModels = classified.entities;
      pydModels = classified.dtos;
    }

    // Single-file scope: cross-file FK/relationship/schema_of edges that point at
    // models defined in other files re-derive on full analysis.
    this.emitModelNodes(saModels, pydModels, nodes, edges);

    const exports = [...saModels.map((m) => m.name), ...pydModels.map((m) => m.name)];

    return this.createFileAnalysisResult(
      context.filePath,
      context.relativePath,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      nodes,
      edges,
      [],
      [],
      [],
      exports
    );
  }

  /** Cheap content guard mirroring the per-file skip in analyze(). */
  private fileMayContainModels(content: string): boolean {
    return (
      content.includes('sqlalchemy') ||
      content.includes('SQLAlchemy') ||
      content.includes('pydantic') ||
      content.includes('BaseModel') ||
      content.includes('SQLModel') ||
      content.includes('DeclarativeBase') ||
      content.includes('declarative_base')
    );
  }

  /**
   * Emit entity/DTO nodes and their edges for a set of models. Cross-file
   * relations (FK targets, relationship() targets, entity<->schema name match)
   * resolve only against models present in `saModels`/`pydModels`; on the
   * single-file incremental path some of these will be under-populated and are
   * recomputed on full analysis.
   */
  private emitModelNodes(
    saModels: SAModel[],
    pydModels: PydModel[],
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    const saNames = new Set(saModels.map((m) => m.name));
    const saByTable = new Map<string, SAModel>();
    for (const m of saModels) {
      if (m.tableName) saByTable.set(m.tableName, m);
    }

    // FK-direction map: model -> the set of models it holds a ForeignKey to. The
    // FK-holding side of a relationship is the "many" side, so this lets a bare
    // `relationship('Post')` (no Mapped[list]/uselist) resolve to 1:N vs N:1
    // instead of defaulting to 1:1.
    const fkTargets = new Map<string, Set<string>>();
    for (const m of saModels) {
      const targets = new Set<string>();
      for (const f of m.fields) {
        if (!f.foreignKey) continue;
        const tm = saByTable.get(f.foreignKey.split('.')[0]);
        if (tm) targets.add(tm.name);
      }
      fkTargets.set(m.name, targets);
    }

    // SQLAlchemy entity nodes + relation edges
    for (const model of saModels) {
      const nodeId = `entity_sqlalchemy_${model.name.toLowerCase()}`;
      const fields = model.fields.map((f) => ({
        name: f.name,
        type: f.type,
        primary: f.isPrimary,
        unique: f.isUnique,
        optional: f.isNullable,
        relation: !!f.foreignKey,
        foreignKey: f.foreignKey,
      }));

      nodes.push(
        this.createNode(nodeId, model.name, 'entity', 3, model.filePath, model.line, undefined, {
          orm: 'SQLAlchemy',
          source: 'sqlalchemy_model',
          table: model.tableName,
          fields,
          annotations: ['SQLAlchemyModel'],
          tags: ['sqlalchemy-model'],
          subcategories: ['entity', 'sqlalchemy'],
        })
      );

      // relationship() edges
      for (const rel of model.relationships) {
        if (saNames.has(rel.target)) {
          // Cardinality from FK direction: if THIS model holds the FK to the
          // target it is the many side (N:1); if the TARGET holds a FK back it is
          // the one side (1:N). Fall back to the generic 'relationship' marker.
          const iHoldFk = fkTargets.get(model.name)?.has(rel.target);
          const targetHoldsFk = fkTargets.get(rel.target)?.has(model.name);
          const relationType = iHoldFk ? 'ManyToOne' : targetHoldsFk ? 'OneToMany' : 'relationship';
          edges.push(
            this.createEdge(
              `sqlalchemy_rel_${model.name}_${rel.name}_${rel.target}`,
              nodeId,
              `entity_sqlalchemy_${rel.target.toLowerCase()}`,
              'references',
              'database',
              {
                attributes: {
                  relationType,
                  field: rel.name,
                  targetModel: rel.target,
                  via: 'relationship',
                },
              }
            )
          );
        }
      }

      // ForeignKey edges (target table -> model)
      for (const f of model.fields) {
        if (!f.foreignKey) continue;
        const targetTable = f.foreignKey.split('.')[0];
        const targetModel = saByTable.get(targetTable);
        if (targetModel) {
          edges.push(
            this.createEdge(
              `sqlalchemy_fk_${model.name}_${f.name}_${targetModel.name}`,
              nodeId,
              `entity_sqlalchemy_${targetModel.name.toLowerCase()}`,
              'references',
              'database',
              {
                attributes: {
                  relationType: 'ManyToOne',
                  field: f.name,
                  targetModel: targetModel.name,
                  foreignKey: f.foreignKey,
                  via: 'ForeignKey',
                },
              }
            )
          );
        }
      }
    }

    // Pydantic DTO nodes + nested-model edges
    const pydNames = new Set(pydModels.map((m) => m.name));
    for (const model of pydModels) {
      const nodeId = `dto_pydantic_${model.name.toLowerCase()}`;
      const fields = model.fields.map((f) => ({
        name: f.name,
        type: f.type,
        optional: f.hasDefault,
      }));

      nodes.push(
        this.createNode(nodeId, model.name, 'dto', 3, model.filePath, model.line, undefined, {
          source: 'pydantic_model',
          schemaKind: 'pydantic',
          fields,
          annotations: ['BaseModel'],
          tags: ['pydantic-model', 'dto'],
          subcategories: ['dto', 'schema', 'pydantic'],
        })
      );

      for (const f of model.fields) {
        if (f.nestedModel && pydNames.has(f.nestedModel)) {
          edges.push(
            this.createEdge(
              `pydantic_nested_${model.name}_${f.name}_${f.nestedModel}`,
              nodeId,
              `dto_pydantic_${f.nestedModel.toLowerCase()}`,
              'references',
              'schema',
              {
                attributes: { field: f.name, targetModel: f.nestedModel, via: 'nested' },
              }
            )
          );
        }
      }
    }

    // Best-effort: link SQLAlchemy entity <-> matching Pydantic schema by name.
    for (const sa of saModels) {
      const entityId = `entity_sqlalchemy_${sa.name.toLowerCase()}`;
      const base = sa.name.toLowerCase();
      for (const pyd of pydModels) {
        const pn = pyd.name.toLowerCase();
        // Match User/UserSchema/UserCreate/UserRead/UserUpdate/UserBase/UserInDB...
        if (pn === base || pn.startsWith(base)) {
          edges.push(
            this.createEdge(
              `sa_pyd_schema_${sa.name}_${pyd.name}`,
              entityId,
              `dto_pydantic_${pyd.name.toLowerCase()}`,
              'schema_of',
              'schema',
              {
                attributes: { entity: sa.name, schema: pyd.name, match: 'name' },
              }
            )
          );
        }
      }
    }
  }

  // ---- Unified classification ---------------------------------------------

  /**
   * Walk every class in a file and classify it as a SQLAlchemy/SQLModel DB
   * entity (table) or a Pydantic/SQLModel DTO schema.
   *
   * - Classic SQLAlchemy: extends Base/DeclarativeBase/db.Model with
   *   __tablename__ or Column/mapped_column -> entity.
   * - SQLModel: `class X(..., table=True)` -> entity (table name inferred from
   *   class name); `class X(SQLModel)` (no table=True) -> DTO schema.
   * - Pydantic: extends BaseModel -> DTO schema.
   *
   * Base resolution is shallow: a class is also treated like its known
   * parent classes within the same file (e.g. UserCreate(UserBase) where
   * UserBase(SQLModel)).
   */
  private classifyModels(
    content: string,
    filePath: string
  ): { entities: SAModel[]; dtos: PydModel[] } {
    const entities: SAModel[] = [];
    const dtos: PydModel[] = [];
    const lines = content.split('\n');
    const classRegex = /^class\s+(\w+)\s*\(([^)]*)\)\s*:/;

    // First pass: collect class name + raw bases for shallow ancestry.
    const classBases = new Map<string, string[]>();
    for (const line of lines) {
      const m = classRegex.exec(line);
      if (m) {
        classBases.set(
          m[1],
          m[2].split(',').map((b) => b.trim().split('[')[0].split('=')[0].trim()).filter(Boolean)
        );
      }
    }

    const isPydanticRooted = (name: string, seen = new Set<string>()): boolean => {
      if (seen.has(name)) return false;
      seen.add(name);
      const bases = classBases.get(name) || [];
      for (const b of bases) {
        if (b === 'BaseModel' || b === 'SQLModel') return true;
        if (classBases.has(b) && isPydanticRooted(b, seen)) return true;
      }
      return false;
    };

    for (let i = 0; i < lines.length; i++) {
      const m = classRegex.exec(lines[i]);
      if (!m) continue;
      const className = m[1];
      const rawBases = m[2];
      const body = this.collectClassBody(lines, i);

      const isSQLModel = /\bSQLModel\b/.test(rawBases) || isPydanticRooted(className);
      const hasTableArg = /\btable\s*=\s*True\b/.test(rawBases);

      const looksLikeClassicSA =
        /\bBase\b/.test(rawBases) ||
        /\bDeclarativeBase\b/.test(rawBases) ||
        /db\.Model/.test(rawBases);
      const hasTablename = /__tablename__\s*=/.test(body);
      const hasColumn = /\bColumn\s*\(|\bmapped_column\s*\(/.test(body);

      // --- DB entity (table) ---
      if ((looksLikeClassicSA && (hasTablename || hasColumn)) || (isSQLModel && hasTableArg)) {
        const tableMatch = /__tablename__\s*=\s*['"]([^'"]+)['"]/.exec(body);
        const tableName = tableMatch
          ? tableMatch[1]
          : isSQLModel && hasTableArg
            ? className.toLowerCase() // SQLModel infers table from class name
            : undefined;

        entities.push({
          name: className,
          tableName,
          fields: this.parseSAFields(body),
          relationships: this.parseSARelationships(body),
          filePath,
          line: i + 1,
        });
        continue;
      }

      // --- Pydantic / SQLModel DTO schema ---
      if (/\bBaseModel\b/.test(rawBases) || isSQLModel) {
        dtos.push({
          name: className,
          fields: this.parsePydFields(body),
          filePath,
          line: i + 1,
        });
      }
    }

    return { entities, dtos };
  }

  private parseSAFields(body: string): SAField[] {
    const fields: SAField[] = [];
    const seen = new Set<string>();

    // Classic style:  id = Column(Integer, primary_key=True)
    const colRegex = /^[ \t]*(\w+)\s*=\s*Column\s*\(([\s\S]*?)\)\s*$/gm;
    // 2.0 style:      id: Mapped[int] = mapped_column(Integer, primary_key=True)
    const mappedRegex = /^[ \t]*(\w+)\s*:\s*Mapped\[([^\]]+)\]\s*(?:=\s*mapped_column\s*\(([\s\S]*?)\))?/gm;
    // SQLModel style:  id: uuid.UUID = Field(primary_key=True)  | email: str = Field(unique=True)
    //                  owner_id: uuid.UUID = Field(foreign_key="user.id")
    const sqlmodelRegex = /^[ \t]*(\w+)\s*:\s*([^\n=]+?)\s*=\s*Field\s*\(([\s\S]*?)\)\s*$/gm;

    let mc: RegExpExecArray | null;
    while ((mc = mappedRegex.exec(body)) !== null) {
      const name = mc[1];
      if (seen.has(name)) continue;
      seen.add(name);
      fields.push(this.buildSAField(name, (mc[2] || '').trim(), mc[3] || ''));
    }

    let sc: RegExpExecArray | null;
    while ((sc = sqlmodelRegex.exec(body)) !== null) {
      const name = sc[1];
      if (seen.has(name)) continue;
      // foreign_key="user.id" uses snake_case in SQLModel; normalize into args.
      const annType = (sc[2] || '').trim();
      let args = sc[3] || '';
      const fkSnake = /foreign_key\s*=\s*['"]([^'"]+)['"]/.exec(args);
      if (fkSnake) args += ` ForeignKey('${fkSnake[1]}')`;
      seen.add(name);
      fields.push(this.buildSAField(name, annType, args));
    }

    let cc: RegExpExecArray | null;
    while ((cc = colRegex.exec(body)) !== null) {
      const name = cc[1];
      if (seen.has(name)) continue;
      seen.add(name);
      const args = cc[2] || '';
      const typeMatch = /^\s*([A-Za-z_][\w]*)/.exec(args);
      const type = typeMatch ? typeMatch[1] : 'Column';
      fields.push(this.buildSAField(name, type, args));
    }

    return fields;
  }

  private buildSAField(name: string, type: string, args: string): SAField {
    const fkMatch = /ForeignKey\s*\(\s*['"]([^'"]+)['"]/.exec(args);
    const nullable =
      /nullable\s*=\s*True/.test(args) ||
      // `| None` / Optional[...] annotation implies nullable unless explicitly False
      ((/\|\s*None\b/.test(type) || /Optional\[/.test(type)) && !/nullable\s*=\s*False/.test(args));
    return {
      name,
      type: (type || 'unknown').trim(),
      isPrimary: /primary_key\s*=\s*True/.test(args),
      isNullable: nullable,
      isUnique: /unique\s*=\s*True/.test(args),
      foreignKey: fkMatch ? fkMatch[1] : undefined,
    };
  }

  private parseSARelationships(body: string): SARelationship[] {
    const rels: SARelationship[] = [];
    // SQLAlchemy:  posts = relationship('Post', back_populates='author')
    //              posts: Mapped[list['Post']] = relationship(back_populates='author')
    // SQLModel:    items: list[Item] = Relationship(back_populates='owner')
    //              owner: User | None = Relationship(back_populates='items')
    const relRegex = /^[ \t]*(\w+)\s*(:[^=\n]+)?=\s*[Rr]elationship\s*\(([\s\S]*?)\)/gm;
    let m: RegExpExecArray | null;
    while ((m = relRegex.exec(body)) !== null) {
      const name = m[1];
      const annotation = m[2] || '';
      const args = m[3] || '';
      let target: string | undefined;
      // 1. string target inside relationship('Post', ...)
      const strTarget = /['"]([A-Z]\w+)['"]/.exec(args);
      if (strTarget) target = strTarget[1];
      // 2. from the type annotation (Mapped[list['Post']], list[Item], User | None)
      if (!target && annotation) {
        const annTokens = annotation.match(/[A-Z]\w+/g) || [];
        const skip = new Set(['Mapped', 'Optional', 'List', 'Set', 'Tuple', 'None', 'Relationship']);
        target = annTokens.find((t) => !skip.has(t));
      }
      if (target) rels.push({ name, target });
    }
    return rels;
  }

  // ---- Pydantic field parsing ---------------------------------------------

  private parsePydFields(body: string): PydField[] {
    const fields: PydField[] = [];
    // name: str | age: int = 0 | items: list[Item] | tags: List[str] = []
    const fieldRegex = /^[ \t]*(\w+)\s*:\s*([^=\n]+?)\s*(=\s*(.+))?$/gm;
    let m: RegExpExecArray | null;
    while ((m = fieldRegex.exec(body)) !== null) {
      const name = m[1];
      const rawType = m[2].trim();
      // Skip method defs / config / dunder
      if (name.startsWith('__') || name === 'model_config' || name === 'Config') continue;
      if (/^def\b|^class\b|^return\b/.test(rawType)) continue;
      const hasDefault = !!m[3];
      const nested = this.extractNestedModel(rawType);
      fields.push({ name, type: rawType, hasDefault, nestedModel: nested });
    }
    return fields;
  }

  private extractNestedModel(type: string): string | undefined {
    // list[Item] / List[Item] / Optional[Item] / Item -> capitalized non-builtin
    const builtins = new Set([
      'str', 'int', 'float', 'bool', 'bytes', 'list', 'List', 'dict', 'Dict',
      'set', 'Set', 'tuple', 'Tuple', 'Optional', 'Any', 'datetime', 'date',
      'UUID', 'Decimal', 'EmailStr', 'Field', 'None',
    ]);
    const matches = type.match(/[A-Za-z_]\w*/g) || [];
    for (const tok of matches) {
      if (builtins.has(tok)) continue;
      if (/^[A-Z]/.test(tok)) return tok;
    }
    return undefined;
  }

  // ---- shared -------------------------------------------------------------

  /** Collect the indented body of a class beginning at `startLine` (the `class` line). */
  private collectClassBody(lines: string[], startLine: number): string {
    const out: string[] = [];
    const classIndent = lines[startLine].match(/^[ \t]*/)?.[0].length ?? 0;
    for (let j = startLine + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '') {
        out.push(line);
        continue;
      }
      const indent = line.match(/^[ \t]*/)?.[0].length ?? 0;
      if (indent <= classIndent) break;
      out.push(line);
    }
    return out.join('\n');
  }

  protected getCapabilities(): string[] {
    return ['sqlalchemy-models', 'sqlalchemy-relations', 'pydantic-models', 'pydantic-dtos'];
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
