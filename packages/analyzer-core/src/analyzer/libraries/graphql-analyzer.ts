import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, FileAnalysisResult } from '../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../core/glob-cache';

type GraphQLTypeKind = 'type' | 'input' | 'interface' | 'enum';
const ROOT_TYPES = new Set(['Query', 'Mutation', 'Subscription']);

interface GraphQLField {
  name: string;
  type: string;
  args: Array<{ name: string; type: string }>;
  /** 0-based line offset of this field within the enclosing block body. */
  lineOffset?: number;
}

interface GraphQLType {
  name: string;
  kind: GraphQLTypeKind;
  fields: GraphQLField[];
  filePath: string;
}

interface GraphQLOperation {
  name: string;
  rootType: 'Query' | 'Mutation' | 'Subscription' | 'Field';
  returnType: string;
  args: Array<{ name: string; type: string }>;
  filePath: string;
  /** 1-based line of the declaration (SDL field, or the decorated/receiver method). */
  line?: number;
  /**
   * For a field resolver (rootType 'Field'), the object type the field hangs off —
   * taken from the enclosing resolver class's type argument. Absent for root
   * Query/Mutation/Subscription operations, whose parent IS the root type.
   */
  objectType?: string;
}

interface GraphQLResolver {
  rootType: string;
  field: string;
  filePath: string;
  /**
   * The name of the code symbol that fulfils the field, which is NOT always the
   * field name: Graphene uses `resolve_<field>`, gqlgen a PascalCase method,
   * schema-first binders name the field in a decorator arg while the function is
   * named separately. Reported so a caller can jump straight to the implementation.
   */
  method?: string;
  /** 1-based line of the resolver implementation. */
  line?: number;
  /** For a field resolver, the object type whose field this fulfils (see GraphQLOperation.objectType). */
  objectType?: string;
}

/**
 * GraphQL API-contract analyzer.
 *
 * The SDL (type/input/interface/enum + Query/Mutation/Subscription) IS the API
 * contract: root-type fields are the callable operations consumer repos depend
 * on, and the object/input types are the shared data shapes. Resolver maps /
 * type-graphql decorators link each operation to the code that fulfils it.
 */
export class GraphQLAnalyzer extends BaseAnalyzer {
  constructor() {
    super('graphql', 'GraphQL API Contract Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const packageJsonPath = path.join(projectPath, 'package.json');
      if (await fs.pathExists(packageJsonPath)) {
        const packageJson = await fs.readJson(packageJsonPath);
        const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
        const markers = [
          'graphql', '@apollo/server', 'apollo-server', 'type-graphql', 'graphql-yoga', 'nexus',
          // Code-first server frameworks that own the decorators but do not
          // necessarily list `graphql` as a direct dependency themselves.
          '@nestjs/graphql', 'mercurius'
        ];
        if (Object.keys(deps).some(d => markers.includes(d) || d.startsWith('@apollo/') || d.startsWith('@nexus/'))) {
          return true;
        }
      }

      const sdlFiles = await glob(['**/*.{graphql,gql}'], {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true
      });
      if (sdlFiles.length > 0) return true;

      const codeFiles = await glob(['**/*.{ts,tsx,js,jsx}'], {
        cwd: projectPath,
        ignore: [...this.getIgnorePatterns({ projectPath }), '**/*.test.*', '**/*.spec.*'],
        nodir: true
      });
      for (const file of codeFiles) {
        const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
        if (/\bgql\s*`/.test(content) || /\bbuildSchema\s*\(/.test(content)) return true;
      }

      // Python: a strawberry-graphql dependency or `import strawberry` in source.
      for (const manifest of ['requirements.txt', 'pyproject.toml', 'Pipfile']) {
        const mp = path.join(projectPath, manifest);
        if (await fs.pathExists(mp) && /strawberry|graphene|ariadne/.test(await fs.readFile(mp, 'utf-8'))) return true;
      }
      const pyFiles = await glob(['**/*.py'], {
        cwd: projectPath,
        ignore: [...this.getIgnorePatterns({ projectPath }), '**/*_test.py', '**/test_*.py'],
        nodir: true
      });
      for (const file of pyFiles) {
        if (/\bimport\s+strawberry\b/.test(await fs.readFile(path.join(projectPath, file), 'utf-8'))) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];

    const types: GraphQLType[] = [];
    const operations: GraphQLOperation[] = [];
    const resolvers: GraphQLResolver[] = [];

    // 1. SDL from .graphql/.gql files
    const sdlFiles = await glob(['**/*.{graphql,gql}'], {
      cwd: context.projectPath,
      ignore: this.getIgnorePatterns(context),
      absolute: false,
      nodir: true
    });
    for (const file of sdlFiles) {
      const content = await fs.readFile(path.join(context.projectPath, file), 'utf-8');
      this.collectFromFile(file, content, true, types, operations, resolvers);
    }

    // 2. SDL embedded in gql`` template literals + resolver maps / decorators
    //    (.py too, for Python Strawberry/Graphene decorator schemas; .go for
    //    gqlgen resolvers; .java for Spring-for-GraphQL @QueryMapping resolvers).
    const codeFiles = await glob(['**/*.{ts,tsx,js,jsx,py,go,java}'], {
      cwd: context.projectPath,
      ignore: [...this.getIgnorePatterns(context), '**/*.test.*', '**/*.spec.*'],
      nodir: true
    });
    for (const file of codeFiles) {
      const content = await fs.readFile(path.join(context.projectPath, file), 'utf-8');
      this.collectFromFile(file, content, false, types, operations, resolvers);
    }

    this.emitGraphQLGraph(types, operations, resolvers, nodes, edges, entryPoints);

    return this.createContribution(nodes, edges, entryPoints, [], {
      api: 'GraphQL',
      typesFound: types.length,
      operationsFound: operations.length,
      resolversFound: resolvers.length,
      sdlFilesFound: sdlFiles.length
    });
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const relevant = new Set<string>();
    try {
      const sdlFiles = await glob(['**/*.{graphql,gql}'], {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true
      });
      for (const f of sdlFiles) relevant.add(f);

      const codeFiles = await glob(['**/*.{ts,tsx,js,jsx}'], {
        cwd: projectPath,
        ignore: [...this.getIgnorePatterns({ projectPath }), '**/*.test.*', '**/*.spec.*'],
        nodir: true
      });
      for (const file of codeFiles) {
        let content: string;
        try {
          content = await fs.readFile(path.join(projectPath, file), 'utf-8');
        } catch {
          continue;
        }
        if (/\bgql\s*`/.test(content) || /@(Query|Mutation|Subscription)\b/.test(content) ||
            /\b(Query|Mutation|Subscription)\s*:\s*\{/.test(content) || /\bbuildSchema\s*\(/.test(content)) {
          relevant.add(file);
        }
      }
    } catch {
      return [];
    }
    return [...relevant].sort();
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);

    const types: GraphQLType[] = [];
    const operations: GraphQLOperation[] = [];
    const resolvers: GraphQLResolver[] = [];
    const ext = path.extname(context.relativePath).toLowerCase();
    const isSdl = ext === '.graphql' || ext === '.gql';
    this.collectFromFile(context.relativePath, content, isSdl, types, operations, resolvers);

    // Single-file scope: field/return-type reference edges and operation->resolver
    // links to definitions in other files under-populate; re-derive on full analysis.
    this.emitGraphQLGraph(types, operations, resolvers, nodes, edges, entryPoints);

    const exports = [
      ...types.map(t => t.name),
      ...operations.map(o => `${o.rootType}.${o.name}`)
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

  /** Collect SDL types/operations and (for code files) resolvers from one file. */
  private collectFromFile(
    file: string,
    content: string,
    isSdl: boolean,
    types: GraphQLType[],
    operations: GraphQLOperation[],
    resolvers: GraphQLResolver[]
  ): void {
    if (isSdl) {
      this.parseSDL(content, file, types, operations, 1);
      return;
    }
    for (const { sdl, startLine } of this.extractGqlTemplates(content)) {
      this.parseSDL(sdl, file, types, operations, startLine);
    }
    this.parseTypeGraphQL(content, file, operations, resolvers);
    this.parseResolverMaps(content, file, resolvers);
    this.parseStrawberry(content, file, operations, resolvers);
    this.parseGraphene(content, file, operations, resolvers);
    this.parseGqlgen(content, file, operations, resolvers);
    this.parseSpringGraphQL(content, file, operations, resolvers);
    this.parseAriadne(content, file, operations, resolvers);
  }

  /**
   * Python Ariadne (schema-first): `query = QueryType()` then `@query.field("user")`
   * binds a resolver to the named SDL field. The decorator ARG is the field name
   * (not the function name); the bound-object's type names the root.
   */
  private parseAriadne(content: string, filePath: string, operations: GraphQLOperation[], resolvers: GraphQLResolver[]): void {
    if (!/\bariadne\b/.test(content)) return;
    const typeToRoot: Record<string, GraphQLOperation['rootType']> = {
      QueryType: 'Query', MutationType: 'Mutation', SubscriptionType: 'Subscription',
    };
    // Map binder variable -> root type, e.g. `query = QueryType()`.
    const varToRoot = new Map<string, GraphQLOperation['rootType']>();
    for (const v of content.matchAll(/(\w+)\s*=\s*(QueryType|MutationType|SubscriptionType)\s*\(/g)) {
      varToRoot.set(v[1], typeToRoot[v[2]]);
    }
    for (const m of content.matchAll(/@(\w+)\.field\(\s*["']([^"']+)["']\s*\)([\s\S]{0,200}?\bdef\s+(\w+))?/g)) {
      const rootType = varToRoot.get(m[1]);
      if (!rootType) continue;
      const field = m[2];
      const line = this.lineAt(content, m.index!);
      if (!operations.some(o => o.rootType === rootType && o.name === field)) {
        operations.push({ name: field, rootType, returnType: 'Unknown', args: [], filePath, line });
      }
      if (!resolvers.some(r => r.rootType === rootType && r.field === field)) {
        resolvers.push({ rootType, field, filePath, method: m[4], line });
      }
    }
  }

  /**
   * Python Graphene: a `class Query(graphene.ObjectType)` declares fields as
   * attributes (`user = graphene.Field(...)`) fulfilled by `resolve_<field>`
   * methods. We read the resolver methods (and the field attrs they back).
   */
  private parseGraphene(content: string, filePath: string, operations: GraphQLOperation[], resolvers: GraphQLResolver[]): void {
    if (!/\bgraphene\b/.test(content)) return;
    // resolve_<field> methods resolve a Query/Subscription field.
    for (const m of content.matchAll(/\bdef\s+resolve_(\w+)\s*\(/g)) {
      const field = m[1];
      const line = this.lineAt(content, m.index!);
      if (!operations.some(o => o.rootType === 'Query' && o.name === field)) {
        operations.push({ name: field, rootType: 'Query', returnType: 'Unknown', args: [], filePath, line });
      }
      if (!resolvers.some(r => r.rootType === 'Query' && r.field === field)) {
        resolvers.push({ rootType: 'Query', field, filePath, method: `resolve_${field}`, line });
      }
    }
  }

  /**
   * Python Strawberry: `@strawberry.field`/`@strawberry.mutation`/`@strawberry.subscription`
   * decorated methods are the resolvers; the decorator kind names the root type.
   */
  private parseStrawberry(content: string, filePath: string, operations: GraphQLOperation[], resolvers: GraphQLResolver[]): void {
    if (!/\bstrawberry\b/.test(content)) return;
    const kindToRoot: Record<string, GraphQLOperation['rootType']> = {
      field: 'Query', mutation: 'Mutation', subscription: 'Subscription',
    };
    const re = /@strawberry\.(field|mutation|subscription)\b[\s\S]{0,200}?\bdef\s+(\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const rootType = kindToRoot[m[1]];
      const method = m[2];
      const line = this.lineAt(content, m.index);
      if (!operations.some(o => o.rootType === rootType && o.name === method)) {
        operations.push({ name: method, rootType, returnType: 'Unknown', args: [], filePath, line });
      }
      if (!resolvers.some(r => r.rootType === rootType && r.field === method)) {
        resolvers.push({ rootType, field: method, filePath, method, line });
      }
    }
  }

  /**
   * Go gqlgen: resolver methods hang off `*queryResolver` / `*mutationResolver` /
   * `*subscriptionResolver` receivers; the receiver names the root type and the
   * method name is the (PascalCase) field — lower-cased to match the SDL field.
   */
  private parseGqlgen(content: string, filePath: string, operations: GraphQLOperation[], resolvers: GraphQLResolver[]): void {
    if (!/gqlgen|(?:query|mutation|subscription)Resolver\b/i.test(content)) return;
    const kindToRoot: Record<string, GraphQLOperation['rootType']> = {
      query: 'Query', mutation: 'Mutation', subscription: 'Subscription',
    };
    const re = /func\s*\(\s*\w+\s+\*?(query|mutation|subscription)Resolver\s*\)\s*(\w+)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const rootType = kindToRoot[m[1].toLowerCase()];
      const field = m[2].charAt(0).toLowerCase() + m[2].slice(1);
      const line = this.lineAt(content, m.index);
      if (!operations.some(o => o.rootType === rootType && o.name === field)) {
        operations.push({ name: field, rootType, returnType: 'Unknown', args: [], filePath, line });
      }
      if (!resolvers.some(r => r.rootType === rootType && r.field === field)) {
        resolvers.push({ rootType, field, filePath, method: m[2], line });
      }
    }
  }

  /**
   * Java Spring for GraphQL: `@QueryMapping` / `@MutationMapping` /
   * `@SubscriptionMapping` methods are root resolvers; the (camelCase) method name
   * is the field. Annotation args (e.g. `@QueryMapping(name="x")`) are skipped.
   */
  private parseSpringGraphQL(content: string, filePath: string, operations: GraphQLOperation[], resolvers: GraphQLResolver[]): void {
    if (!/@(Query|Mutation|Subscription)Mapping\b/.test(content)) return;
    const kindToRoot: Record<string, GraphQLOperation['rootType']> = {
      Query: 'Query', Mutation: 'Mutation', Subscription: 'Subscription',
    };
    const re = /@(Query|Mutation|Subscription)Mapping\b\s*(?:\([^)]*\))?\s*(?:public|private|protected|static|final|\s)*[\w.<>\[\],\s]*?\b(\w+)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const rootType = kindToRoot[m[1]];
      const field = m[2];
      const line = this.lineAt(content, m.index);
      if (!operations.some(o => o.rootType === rootType && o.name === field)) {
        operations.push({ name: field, rootType, returnType: 'Unknown', args: [], filePath, line });
      }
      if (!resolvers.some(r => r.rootType === rootType && r.field === field)) {
        resolvers.push({ rootType, field, filePath, method: field, line });
      }
    }
  }

  private emitGraphQLGraph(
    types: GraphQLType[],
    operations: GraphQLOperation[],
    resolvers: GraphQLResolver[],
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): void {
    // Nodes for data-entity-like type definitions.
    for (const t of types) {
      const typeId = `graphql_type_${this.sanitizeId(t.name)}`;
      nodes.push(this.createNode(
        typeId,
        t.name,
        t.kind === 'enum' ? 'enum' : 'entity',
        3,
        t.filePath,
        undefined,
        undefined,
        {
          api: 'GraphQL',
          source: 'graphql_sdl',
          graphqlKind: t.kind,
          fields: t.fields.map(f => ({ name: f.name, type: f.type, args: f.args })),
          subcategories: ['entity', 'graphql', t.kind, 'api-contract'],
          tags: ['graphql:type', `graphql:${t.kind}`]
        }
      ));

      // Field-type reference edges to other declared types.
      for (const field of t.fields) {
        const target = this.baseTypeName(field.type);
        if (types.some(o => o.name === target) && target !== t.name) {
          edges.push(this.createEdge(
            `graphql_ref_${this.sanitizeId(t.name)}_${this.sanitizeId(field.name)}_${this.sanitizeId(target)}`,
            typeId,
            `graphql_type_${this.sanitizeId(target)}`,
            'references',
            'api',
            { attributes: { field: field.name, targetType: target } }
          ));
        }
      }
    }

    const resolverIndex = new Set(resolvers.map(r => `${r.rootType}.${r.field}`));

    // Nodes + entry points for root operations (the API contract).
    for (const op of operations) {
      // Field resolvers are namespaced by their object type: two types may each
      // declare a `posts` field, and a bare `field_posts` id would merge them.
      const opScope = op.rootType === 'Field' && op.objectType
        ? `field_${this.sanitizeId(op.objectType)}`
        : op.rootType.toLowerCase();
      const opId = `graphql_operation_${opScope}_${this.sanitizeId(op.name)}`;
      const hasResolver = resolverIndex.has(`${op.rootType}.${op.name}`);

      nodes.push(this.createNode(
        opId,
        op.name,
        'operation',
        3,
        op.filePath,
        undefined,
        undefined,
        {
          api: 'GraphQL',
          source: 'graphql_operation',
          operationType: op.rootType,
          returnType: op.returnType,
          args: op.args,
          hasResolver,
          subcategories: ['operation', 'graphql', op.rootType.toLowerCase(), 'api-contract', 'endpoint'],
          tags: ['graphql:operation', `graphql:${op.rootType.toLowerCase()}`]
        }
      ));

      // Link operation -> resolver function when present. A field resolver must
      // match on object type too, else two types' same-named fields cross-link.
      const resolver = resolvers.find(r =>
        r.rootType === op.rootType &&
        r.field === op.name &&
        (op.rootType !== 'Field' || r.objectType === op.objectType)
      );
      if (resolver) {
        const resolverId = `graphql_resolver_${opScope}_${this.sanitizeId(op.name)}`;
        nodes.push(this.createNode(
          resolverId,
          `${op.rootType}.${op.name} resolver`,
          'resolver',
          4,
          resolver.filePath,
          undefined,
          undefined,
          {
            api: 'GraphQL',
            source: 'graphql_resolver',
            rootType: op.rootType,
            field: op.name,
            subcategories: ['resolver', 'graphql'],
            tags: ['graphql:resolver']
          }
        ));
        edges.push(this.createEdge(
          `graphql_resolves_${opScope}_${this.sanitizeId(op.name)}`,
          opId,
          resolverId,
          'resolved_by',
          'api',
          { attributes: { rootType: op.rootType, field: op.name } }
        ));
      }

      // Return-type contract edge.
      const retBase = this.baseTypeName(op.returnType);
      if (types.some(t => t.name === retBase)) {
        edges.push(this.createEdge(
          `graphql_returns_${opId}_${this.sanitizeId(retBase)}`,
          opId,
          `graphql_type_${this.sanitizeId(retBase)}`,
          'returns',
          'api',
          { attributes: { returnType: op.returnType } }
        ));
      }

      // A field resolver's addressable parent is the object type it hangs off;
      // a root operation's is the root type itself.
      const parentType = op.rootType === 'Field' ? (op.objectType || 'Field') : op.rootType;
      const operationPath = `${parentType}.${op.name}`;
      // Emitted as its own kind, not as a route: a GraphQL operation is addressed
      // by name over one transport endpoint, so it has no path+verb to route on.
      entryPoints.push(this.createEntryPoint(
        `entry_${opId}`,
        opId,
        'graphql',
        op.name,
        op.rootType === 'Field'
          ? `GraphQL field resolver: ${operationPath}`
          : `GraphQL ${op.rootType}: ${op.name}`,
        {
          pattern: operationPath,
          method: op.rootType,
          parameters: op.args.map(a => ({ name: a.name, type: a.type, required: a.type.includes('!') }))
        },
        { authenticated: false, guards: [], authorized_roles: [] },
        {
          api: 'GraphQL',
          operationType: op.rootType,
          operation: op.name,
          operationPath,
          parentType,
          returnType: op.returnType,
          hasResolver,
          // The code symbol that fulfils the operation, which is not always the
          // field name (Graphene resolve_x, gqlgen PascalCase, bound decorators).
          resolverMethod: resolver?.method,
          declaredAt: op.line != null ? `${op.filePath}:${op.line}` : op.filePath
        },
        resolver
          ? {
              node_id: opId,
              method_name: resolver.method || op.name,
              file: resolver.filePath,
              line: resolver.line ?? op.line
            }
          : { node_id: opId, method_name: op.name, file: op.filePath, line: op.line }
      ));
      const ep = entryPoints[entryPoints.length - 1];
      ep.output = { type: op.returnType };
      if (op.args.length > 0) {
        ep.input = { type: 'graphql-args', schema: op.args.map(a => `${a.name}: ${a.type}`).join(', ') };
      }
    }
  }

  /**
   * Extract bodies of gql`...` template literals, each with the line the body
   * starts on in the host file so SDL parsed out of embedded schemas still
   * reports a real file:line rather than a line relative to the template.
   */
  private extractGqlTemplates(content: string): Array<{ sdl: string; startLine: number }> {
    const out: Array<{ sdl: string; startLine: number }> = [];
    // gql`` or graphql`` tagged templates.
    const tagged = /\b(?:gql|graphql)\s*`/g;
    let m: RegExpExecArray | null;
    while ((m = tagged.exec(content)) !== null) {
      const start = m.index + m[0].length;
      const end = content.indexOf('`', start);
      if (end === -1) break;
      out.push({ sdl: content.slice(start, end), startLine: this.lineAt(content, start) });
      tagged.lastIndex = end + 1;
    }
    // Modern Apollo convention: `#graphql`-magic-commented template literals
    // (e.g. `const typeDefs = \`#graphql ... \``), which carry no gql tag.
    const magic = /`\s*#graphql\b/g;
    while ((m = magic.exec(content)) !== null) {
      const start = m.index + 1; // just past the opening backtick
      const end = content.indexOf('`', start);
      if (end === -1) break;
      out.push({ sdl: content.slice(start, end), startLine: this.lineAt(content, start) });
      magic.lastIndex = end + 1;
    }
    return out;
  }

  /** Parse SDL: type/input/interface/enum definitions + Query/Mutation/Subscription operations. */
  private parseSDL(
    sdl: string,
    filePath: string,
    types: GraphQLType[],
    operations: GraphQLOperation[],
    /** 1-based line in the host file that `sdl` starts on (1 for a whole .graphql file). */
    sdlStartLine: number = 1
  ): void {
    const blockRe = /\b(type|input|interface|enum)\s+(\w+)(?:\s+implements\s+[\w\s&]+)?\s*\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = blockRe.exec(sdl)) !== null) {
      const kind = m[1] as GraphQLTypeKind;
      const name = m[2];
      const body = m[3];
      // Line the body opens on, in host-file coordinates.
      const bodyLine = sdlStartLine - 1 + this.lineAt(sdl, m.index + m[0].indexOf('{'));

      if (ROOT_TYPES.has(name) && kind === 'type') {
        for (const field of this.parseFields(body, kind)) {
          operations.push({
            name: field.name,
            rootType: name as GraphQLOperation['rootType'],
            returnType: field.type,
            args: field.args,
            filePath,
            line: bodyLine + (field.lineOffset ?? 0)
          });
        }
        continue;
      }

      const fields = kind === 'enum'
        ? body.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(v => ({ name: v, type: 'enum', args: [] }))
        : this.parseFields(body, kind);

      // Merge duplicate declarations (extend type) instead of duplicating nodes.
      const existing = types.find(t => t.name === name);
      if (existing) {
        existing.fields.push(...fields);
      } else {
        types.push({ name, kind, fields, filePath });
      }
    }
  }

  private parseFields(body: string, kind: GraphQLTypeKind): GraphQLField[] {
    const fields: GraphQLField[] = [];
    const lines = body.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const line = raw.replace(/#.*/, '').trim();
      if (!line) continue;
      // name(arg: Type, ...): ReturnType  OR  name: Type
      const fm = line.match(/^(\w+)\s*(?:\(([^)]*)\))?\s*:\s*([^\s]+(?:\s*[![\]]*)?)/);
      if (!fm) continue;
      const name = fm[1];
      const argsRaw = fm[2];
      const type = fm[3].replace(/[,]+$/, '');
      const args: Array<{ name: string; type: string }> = [];
      if (argsRaw) {
        for (const a of argsRaw.split(',')) {
          const am = a.trim().match(/^(\w+)\s*:\s*(.+)$/);
          if (am) args.push({ name: am[1], type: am[2].trim() });
        }
      }
      fields.push({ name, type, args, lineOffset: i });
    }
    return fields;
  }

  /** type-graphql decorators: @Query/@Mutation/@Subscription on resolver methods. */
  private parseTypeGraphQL(
    content: string,
    filePath: string,
    operations: GraphQLOperation[],
    resolvers: GraphQLResolver[]
  ): void {
    // The decorator arg list may carry a nested arrow `() => Type` (the type-graphql
    // explicit-type idiom, `@Query(() => [User])`). Allow one level of nested parens
    // so the inner `()` doesn't terminate the arg capture before the method name.
    // @ResolveField / @FieldResolver wire a field on an object type to a method —
    // captured as a 'Field' operation so the schema-field -> resolver edge forms,
    // same as @Query/@Mutation roots.
    // A field resolver's field belongs to the object type named by the ENCLOSING
    // `@Resolver(() => User)` class, so record where each resolver class opens and
    // attribute later field resolvers to the nearest preceding one. Without that,
    // every field resolver in a service collapses to the same anonymous "Field"
    // parent and two types' `posts` fields become indistinguishable.
    const resolverClasses: Array<{ index: number; objectType?: string }> = [];
    for (const rc of content.matchAll(/@Resolver\s*\(((?:[^()]|\([^()]*\))*)\)/g)) {
      const arg = rc[1] || '';
      const typeMatch = arg.match(/=>\s*\[?\s*(\w+)/) || arg.match(/\bof\s*:\s*\(\)\s*=>\s*\[?\s*(\w+)/);
      resolverClasses.push({ index: rc.index!, objectType: typeMatch ? typeMatch[1] : undefined });
    }
    const enclosingObjectType = (index: number): string | undefined => {
      let found: string | undefined;
      for (const rc of resolverClasses) {
        if (rc.index > index) break;
        found = rc.objectType;
      }
      return found;
    };

    const re = /@(Query|Mutation|Subscription|ResolveField|FieldResolver)\s*\(((?:[^()]|\([^()]*\))*)\)\s*(?:async\s+)?(\w+)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const isFieldResolver = /Field/.test(m[1]);
      const rootType = (isFieldResolver ? 'Field' : m[1]) as GraphQLOperation['rootType'];
      const method = m[3];
      const line = this.lineAt(content, m.index);
      // Return type from either `() => Type` (explicit) or `returns: () => Type`.
      const returnTypeMatch = m[2].match(/=>\s*\[?\s*([\w]+)/);
      const returnType = returnTypeMatch ? returnTypeMatch[1] : 'Unknown';
      const objectType = isFieldResolver ? enclosingObjectType(m.index) : undefined;
      // Field resolvers are keyed by object type as well as name: two resolver
      // classes may both declare a `posts` field, and a name-only key would drop
      // the second one entirely.
      if (!operations.some(o => o.rootType === rootType && o.name === method && o.objectType === objectType)) {
        operations.push({ name: method, rootType, returnType, args: [], filePath, line, objectType });
      }
      resolvers.push({ rootType, field: method, filePath, method, line, objectType });
    }
  }

  /** Apollo-style resolver maps: { Query: { user() {} }, Mutation: { createUser: () => {} } }. */
  private parseResolverMaps(content: string, filePath: string, resolvers: GraphQLResolver[]): void {
    for (const root of ROOT_TYPES) {
      const re = new RegExp(`\\b${root}\\s*:\\s*\\{`, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        const blockOpen = content.indexOf('{', m.index);
        const block = this.extractBraceBlock(content, blockOpen);
        if (block === null) continue;
        // Offset of the block body within the file, so a field's line inside the
        // resolver map resolves to a real file line.
        const bodyOffset = blockOpen + 1;
        const fieldRe = /(\w+)\s*(?::\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|async\s*\([^)]*\)\s*=>)|\s*\([^)]*\)\s*\{)/g;
        let fm: RegExpExecArray | null;
        while ((fm = fieldRe.exec(block)) !== null) {
          const field = fm[1];
          if (!resolvers.some(r => r.rootType === root && r.field === field)) {
            resolvers.push({
              rootType: root, field, filePath, method: field,
              line: this.lineAt(content, bodyOffset + fm.index)
            });
          }
        }
        // Property shorthand: `Query: { user, users }` references named resolver
        // functions. An identifier bounded by `{`/`,` and `,`/`}` (not followed by
        // `:` or `(`) is a field bound to a same-named resolver.
        const shorthandRe = /(?:^|,)\s*(\w+)\s*(?=,|$)/g;
        let sm: RegExpExecArray | null;
        while ((sm = shorthandRe.exec(block)) !== null) {
          const field = sm[1];
          if (!resolvers.some(r => r.rootType === root && r.field === field)) {
            resolvers.push({
              rootType: root, field, filePath, method: field,
              line: this.lineAt(content, bodyOffset + sm.index)
            });
          }
        }
      }
    }
  }

  private extractBraceBlock(content: string, openIndex: number): string | null {
    if (content[openIndex] !== '{') return null;
    let depth = 0;
    for (let i = openIndex; i < content.length; i++) {
      const ch = content[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return content.slice(openIndex + 1, i);
      }
    }
    return null;
  }

  /** Strip GraphQL type wrappers ([], !) down to the base type name. */
  private baseTypeName(type: string): string {
    return type.replace(/[![\]\s]/g, '');
  }

  /**
   * 1-based line of a character offset. The newline index is memoised for the
   * text most recently asked about, because every parser below resolves many
   * offsets against the same file body and a per-call rescan would be quadratic.
   */
  private lineIndexCache: { text: string; offsets: number[] } | null = null;
  private lineAt(text: string, index: number): number {
    if (this.lineIndexCache?.text !== text) {
      const offsets: number[] = [];
      for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) offsets.push(i);
      }
      this.lineIndexCache = { text, offsets };
    }
    const offsets = this.lineIndexCache!.offsets;
    let lo = 0;
    let hi = offsets.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid] < index) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  }

  protected getCapabilities(): string[] {
    return ['graphql-schema', 'graphql-operations', 'graphql-resolvers', 'graphql-types'];
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
