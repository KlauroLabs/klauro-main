import * as path from 'path';
import * as fs from 'fs-extra';
import { parse } from '@typescript-eslint/typescript-estree';

export interface ResolvedAngularRoute {
  fullPath: string;
  segment: string;
  pathResolved: boolean;
  component?: string;
  componentFile?: string;
  lazyComponent: boolean;
  lazyChildren: boolean;
  loadChildrenFile?: string;
  redirectTo?: string;
  guards: string[];
  inheritedGuards: string[];
  guardKinds: Record<string, string[]>;
  resolve?: Record<string, string>;
  data?: Record<string, unknown>;
  sourceFile: string;
  line: number;
}

export interface AngularRouteResolution {
  routes: ResolvedAngularRoute[];
  routeFiles: string[];
}

interface ModuleInfo {
  filePath: string;
  content: string;
  declarations: Map<string, any>;
  functions: Map<string, any>;
  enums: Map<string, any>;
  imports: Map<string, { source: string; imported: string }>;
  program: any;
}

interface Scope {
  bindings: Map<string, unknown>;
  parent?: Scope;
}

interface EvalContext {
  module: ModuleInfo;
  scope?: Scope;
  steps: { count: number };
  depth: number;
}

interface ClosureValue {
  __closure: true;
  params: any[];
  body: any;
  module: ModuleInfo;
  scope?: Scope;
}

interface RouteArrayDefinition {
  module: ModuleInfo;
  name: string;
  node: any;
}

const EVAL_FAILED = Symbol('angular-route-eval-failed');
const MAX_EVAL_STEPS = 50000;
const MAX_EVAL_DEPTH = 64;
const MAX_LAZY_DEPTH = 12;
const GUARD_PROPERTIES = ['canActivate', 'canActivateChild', 'canMatch', 'canLoad', 'canDeactivate'];
const ROUTE_FILE_HINT = /(RouterModule|provideRouter|\bRoutes\b|\bRoute\[\])/;

function isClosure(value: unknown): value is ClosureValue {
  return typeof value === 'object' && value !== null && (value as any).__closure === true;
}

export class AngularRouteResolver {
  private readonly projectPath: string;
  private readonly moduleCache = new Map<string, ModuleInfo | null>();
  private readonly aliasPatterns: Array<{ prefix: string; suffix: string; targets: string[] }> = [];
  private baseUrl = '.';

  constructor(projectPath: string) {
    this.projectPath = projectPath;
  }

  async resolve(files: string[]): Promise<AngularRouteResolution> {
    await this.loadPathAliases();

    const definitions: RouteArrayDefinition[] = [];
    const rootKeys = new Set<string>();
    const routeFiles = new Set<string>();

    for (const file of files) {
      const fullPath = path.join(this.projectPath, file);
      let content: string;
      try {
        content = await fs.readFile(fullPath, 'utf-8');
      } catch {
        continue;
      }
      if (!ROUTE_FILE_HINT.test(content)) continue;

      const module = this.getModule(fullPath, content);
      if (!module) continue;

      const fileDefinitions = this.collectRouteArrayDefinitions(module);
      if (fileDefinitions.length === 0) continue;

      routeFiles.add(file);
      definitions.push(...fileDefinitions);
    }

    for (const file of files) {
      const fullPath = path.join(this.projectPath, file);
      const module = this.moduleCache.get(fullPath) || this.getModuleIfRouterConfig(fullPath);
      if (!module) continue;
      for (const rootKey of this.collectRootRouteKeys(module)) {
        rootKeys.add(rootKey);
      }
    }

    const consumed = new Set<string>();
    const routes: ResolvedAngularRoute[] = [];
    const ordered = [
      ...definitions.filter(def => rootKeys.has(this.definitionKey(def.module.filePath, def.name))),
      ...definitions.filter(def => !rootKeys.has(this.definitionKey(def.module.filePath, def.name))),
    ];

    for (const definition of ordered) {
      const key = this.definitionKey(definition.module.filePath, definition.name);
      if (consumed.has(key)) continue;
      consumed.add(key);
      this.expandRouteArray(definition.node, definition.module, '', [], routes, consumed, 0);
    }

    return { routes, routeFiles: [...routeFiles] };
  }

  private definitionKey(filePath: string, name: string): string {
    return `${filePath}::${name}`;
  }

  private async loadPathAliases(): Promise<void> {
    try {
      const tsconfigPath = path.join(this.projectPath, 'tsconfig.json');
      if (!await fs.pathExists(tsconfigPath)) return;
      const raw = await fs.readFile(tsconfigPath, 'utf-8');
      const sanitized = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/,\s*([}\]])/g, '$1');
      const config = JSON.parse(sanitized);
      const options = config?.compilerOptions || {};
      this.baseUrl = options.baseUrl || '.';
      const paths: Record<string, string[]> = options.paths || {};
      for (const [pattern, targets] of Object.entries(paths)) {
        if (!Array.isArray(targets) || targets.length === 0) continue;
        const starIndex = pattern.indexOf('*');
        if (starIndex === -1) {
          this.aliasPatterns.push({ prefix: pattern, suffix: '\0', targets });
        } else {
          this.aliasPatterns.push({
            prefix: pattern.slice(0, starIndex),
            suffix: pattern.slice(starIndex + 1),
            targets,
          });
        }
      }
    } catch {

    }
  }

  private getModule(fullPath: string, preloadedContent?: string): ModuleInfo | null {
    const cached = this.moduleCache.get(fullPath);
    if (cached !== undefined) return cached;

    let content = preloadedContent;
    if (content === undefined) {
      try {
        content = fs.readFileSync(fullPath, 'utf-8');
      } catch {
        this.moduleCache.set(fullPath, null);
        return null;
      }
    }

    let program: any;
    try {
      program = parse(content, { loc: true, range: true, jsx: false });
    } catch {
      this.moduleCache.set(fullPath, null);
      return null;
    }

    const module: ModuleInfo = {
      filePath: fullPath,
      content,
      declarations: new Map(),
      functions: new Map(),
      enums: new Map(),
      imports: new Map(),
      program,
    };

    const indexStatement = (statement: any) => {
      if (!statement) return;
      if (statement.type === 'ExportNamedDeclaration' && statement.declaration) {
        indexStatement(statement.declaration);
        return;
      }
      if (statement.type === 'VariableDeclaration') {
        for (const declarator of statement.declarations || []) {
          if (declarator.id?.type === 'Identifier' && declarator.init) {
            module.declarations.set(declarator.id.name, declarator);
          }
        }
        return;
      }
      if (statement.type === 'FunctionDeclaration' && statement.id?.name) {
        module.functions.set(statement.id.name, statement);
        return;
      }
      if (statement.type === 'TSEnumDeclaration' && statement.id?.name) {
        module.enums.set(statement.id.name, statement);
        return;
      }
      if (statement.type === 'ImportDeclaration' && typeof statement.source?.value === 'string') {
        for (const specifier of statement.specifiers || []) {
          if (specifier.type === 'ImportSpecifier' && specifier.local?.name) {
            const importedName = specifier.imported?.name || specifier.imported?.value || specifier.local.name;
            module.imports.set(specifier.local.name, { source: statement.source.value, imported: importedName });
          } else if (specifier.type === 'ImportDefaultSpecifier' && specifier.local?.name) {
            module.imports.set(specifier.local.name, { source: statement.source.value, imported: 'default' });
          }
        }
      }
    };

    for (const statement of program.body || []) {
      indexStatement(statement);
    }

    this.moduleCache.set(fullPath, module);
    return module;
  }

  private resolveImportFile(fromFile: string, source: string): string | null {
    let basePath: string | null = null;

    if (source.startsWith('.')) {
      basePath = path.resolve(path.dirname(fromFile), source);
    } else {
      for (const alias of this.aliasPatterns) {
        if (alias.suffix === '\0') {
          if (source !== alias.prefix) continue;
          basePath = path.resolve(this.projectPath, this.baseUrl, alias.targets[0]);
          break;
        }
        if (source.startsWith(alias.prefix) && source.endsWith(alias.suffix)) {
          const wildcard = source.slice(alias.prefix.length, source.length - alias.suffix.length);
          const target = alias.targets[0].replace('*', wildcard);
          basePath = path.resolve(this.projectPath, this.baseUrl, target);
          break;
        }
      }
    }

    if (!basePath) return null;

    const candidates = [basePath, `${basePath}.ts`, `${basePath}.tsx`, path.join(basePath, 'index.ts')];
    for (const candidate of candidates) {
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {

      }
    }
    return null;
  }

  private collectRouteArrayDefinitions(module: ModuleInfo): RouteArrayDefinition[] {
    const definitions: RouteArrayDefinition[] = [];
    for (const [name, declarator] of module.declarations) {
      if (!this.isRoutesDeclaration(declarator)) continue;
      const arrayNode = this.unwrapExpression(declarator.init);
      if (arrayNode?.type !== 'ArrayExpression') continue;
      definitions.push({ module, name, node: arrayNode });
    }
    definitions.push(...this.collectInlineRouterArrays(module));
    return definitions;
  }

  private collectInlineRouterArrays(module: ModuleInfo): RouteArrayDefinition[] {
    const definitions: RouteArrayDefinition[] = [];
    let counter = 0;
    const visit = (node: any) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      if (node.type === 'CallExpression') {
        const callee = node.callee;
        const isProvideRouter = callee?.type === 'Identifier' && callee.name === 'provideRouter';
        const isRouterModule = callee?.type === 'MemberExpression'
          && callee.object?.name === 'RouterModule'
          && (callee.property?.name === 'forRoot' || callee.property?.name === 'forChild');
        if ((isProvideRouter || isRouterModule) && node.arguments?.length > 0) {
          const arg = this.unwrapExpression(node.arguments[0]);
          if (arg?.type === 'ArrayExpression') {
            definitions.push({ module, name: `__inline_routes_${counter++}`, node: arg });
          }
        }
      }
      for (const key of Object.keys(node)) {
        if (key === 'loc' || key === 'range' || key === 'parent') continue;
        visit(node[key]);
      }
    };
    visit(module.program);
    return definitions;
  }

  private isRoutesDeclaration(declarator: any): boolean {
    const annotation = declarator.id?.typeAnnotation?.typeAnnotation;
    if (annotation) {
      if (annotation.type === 'TSTypeReference' && annotation.typeName?.name === 'Routes') return true;
      if (annotation.type === 'TSArrayType' && annotation.elementType?.typeName?.name === 'Route') return true;
    }
    const init = this.unwrapExpression(declarator.init);
    if (init?.type !== 'ArrayExpression') return false;
    return (init.elements || []).some((element: any) => {
      const unwrapped = this.unwrapExpression(element);
      if (unwrapped?.type !== 'ObjectExpression') return false;
      return (unwrapped.properties || []).some((property: any) =>
        property.type === 'Property' && this.propertyName(property) === 'path'
      );
    });
  }

  private getModuleIfRouterConfig(fullPath: string): ModuleInfo | null {
    let content: string;
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch {
      return null;
    }
    if (!content.includes('provideRouter') && !content.includes('RouterModule.forRoot')) return null;
    return this.getModule(fullPath, content);
  }

  private collectRootRouteKeys(module: ModuleInfo): string[] {
    const keys: string[] = [];
    const visit = (node: any) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      if (node.type === 'CallExpression') {
        const callee = node.callee;
        const isProvideRouter = callee?.type === 'Identifier' && callee.name === 'provideRouter';
        const isForRoot = callee?.type === 'MemberExpression'
          && callee.object?.name === 'RouterModule'
          && callee.property?.name === 'forRoot';
        if ((isProvideRouter || isForRoot) && node.arguments?.length > 0) {
          const arg = this.unwrapExpression(node.arguments[0]);
          if (arg?.type === 'Identifier') {
            const local = module.imports.get(arg.name);
            if (local) {
              const targetFile = this.resolveImportFile(module.filePath, local.source);
              if (targetFile) keys.push(this.definitionKey(targetFile, local.imported));
            } else {
              keys.push(this.definitionKey(module.filePath, arg.name));
            }
          }
        }
      }
      for (const key of Object.keys(node)) {
        if (key === 'loc' || key === 'range' || key === 'parent') continue;
        visit(node[key]);
      }
    };
    visit(module.program);
    return keys;
  }

  private expandRouteArray(
    arrayNode: any,
    module: ModuleInfo,
    parentPath: string,
    inheritedGuards: string[],
    out: ResolvedAngularRoute[],
    consumed: Set<string>,
    lazyDepth: number
  ): void {
    for (const element of arrayNode.elements || []) {
      const routeObject = this.unwrapExpression(element);
      if (routeObject?.type !== 'ObjectExpression') continue;
      this.expandRouteObject(routeObject, module, parentPath, inheritedGuards, out, consumed, lazyDepth);
    }
  }

  private expandRouteObject(
    routeObject: any,
    module: ModuleInfo,
    parentPath: string,
    inheritedGuards: string[],
    out: ResolvedAngularRoute[],
    consumed: Set<string>,
    lazyDepth: number
  ): void {
    const properties = (routeObject.properties || []).filter((p: any) => p.type === 'Property');
    const byName = new Map<string, any>();
    for (const property of properties) {
      const name = this.propertyName(property);
      if (name) byName.set(name, property.value);
    }

    let segment = '';
    let pathResolved = true;
    if (byName.has('path')) {
      const evaluated = this.evaluate(byName.get('path'), module);
      if (typeof evaluated === 'string') {
        segment = evaluated;
      } else {
        pathResolved = false;
        segment = this.sourceSnippet(module, byName.get('path'));
      }
    }

    const fullPath = this.joinPaths(parentPath, segment);

    const guards: string[] = [];
    const guardKinds: Record<string, string[]> = {};
    for (const guardProperty of GUARD_PROPERTIES) {
      if (!byName.has(guardProperty)) continue;
      const names = this.identifierNames(byName.get(guardProperty));
      if (names.length === 0) continue;
      guardKinds[guardProperty] = names;
      for (const name of names) {
        if (!guards.includes(name)) guards.push(name);
      }
    }

    let component: string | undefined;
    let componentFile: string | undefined;
    let lazyComponent = false;
    const componentNode = this.unwrapExpression(byName.get('component'));
    if (componentNode?.type === 'Identifier') {
      component = componentNode.name;
      const imported = module.imports.get(componentNode.name);
      if (imported) {
        const resolved = this.resolveImportFile(module.filePath, imported.source);
        if (resolved) componentFile = this.toProjectRelative(resolved);
      } else {
        componentFile = this.toProjectRelative(module.filePath);
      }
    }

    if (!component && byName.has('loadComponent')) {
      const lazy = this.extractLazyImport(byName.get('loadComponent'), module);
      if (lazy) {
        component = lazy.exportName;
        componentFile = lazy.file ? this.toProjectRelative(lazy.file) : undefined;
        lazyComponent = true;
      }
    }

    let redirectTo: string | undefined;
    if (byName.has('redirectTo')) {
      const evaluated = this.evaluate(byName.get('redirectTo'), module);
      if (typeof evaluated === 'string') redirectTo = evaluated;
    }

    let resolveMap: Record<string, string> | undefined;
    const resolveNode = this.unwrapExpression(byName.get('resolve'));
    if (resolveNode?.type === 'ObjectExpression') {
      resolveMap = {};
      for (const property of resolveNode.properties || []) {
        if (property.type !== 'Property') continue;
        const key = this.propertyName(property) || this.evaluatedPropertyName(property, module);
        const value = this.unwrapExpression(property.value);
        if (key && value?.type === 'Identifier') resolveMap[key] = value.name;
      }
      if (Object.keys(resolveMap).length === 0) resolveMap = undefined;
    }

    let data: Record<string, unknown> | undefined;
    const dataNode = this.unwrapExpression(byName.get('data'));
    if (dataNode?.type === 'ObjectExpression') {
      data = {};
      for (const property of dataNode.properties || []) {
        if (property.type !== 'Property') continue;
        const key = property.computed
          ? this.evaluatedPropertyName(property, module)
          : this.propertyName(property);
        if (!key) continue;
        const value = this.evaluate(property.value, module);
        if (value !== EVAL_FAILED && !isClosure(value)) data[key] = value as unknown;
      }
      if (Object.keys(data).length === 0) data = undefined;
    }

    let lazyChildren = false;
    let loadChildrenFile: string | undefined;
    let lazyTarget: { file: string | null; exportName: string } | null = null;
    if (byName.has('loadChildren')) {
      lazyTarget = this.extractLazyImport(byName.get('loadChildren'), module);
      if (lazyTarget) {
        lazyChildren = true;
        loadChildrenFile = lazyTarget.file ? this.toProjectRelative(lazyTarget.file) : undefined;
      } else {
        const literal = this.unwrapExpression(byName.get('loadChildren'));
        if (literal?.type === 'Literal' && typeof literal.value === 'string') {
          lazyChildren = true;
          loadChildrenFile = literal.value.split('#')[0];
        }
      }
    }

    out.push({
      fullPath,
      segment,
      pathResolved,
      component,
      componentFile,
      lazyComponent,
      lazyChildren,
      loadChildrenFile,
      redirectTo,
      guards,
      inheritedGuards: [...inheritedGuards],
      guardKinds,
      resolve: resolveMap,
      data,
      sourceFile: this.toProjectRelative(module.filePath),
      line: routeObject.loc?.start?.line || 1,
    });

    const childGuards = [...inheritedGuards];
    for (const guard of guards) {
      if (!childGuards.includes(guard)) childGuards.push(guard);
    }

    const childrenNode = this.unwrapExpression(byName.get('children'));
    if (childrenNode?.type === 'ArrayExpression') {
      this.expandRouteArray(childrenNode, module, fullPath, childGuards, out, consumed, lazyDepth);
    } else if (childrenNode?.type === 'Identifier') {
      const childArray = this.resolveRouteArrayReference(childrenNode.name, module, consumed);
      if (childArray) {
        this.expandRouteArray(childArray.node, childArray.module, fullPath, childGuards, out, consumed, lazyDepth);
      }
    }

    if (lazyTarget?.file && lazyDepth < MAX_LAZY_DEPTH) {
      const childModule = this.getModule(lazyTarget.file);
      if (childModule) {
        const declarator = childModule.declarations.get(lazyTarget.exportName);
        const childArrayNode = declarator ? this.unwrapExpression(declarator.init) : undefined;
        if (childArrayNode?.type === 'ArrayExpression') {
          const key = this.definitionKey(childModule.filePath, lazyTarget.exportName);
          if (!consumed.has(key)) {
            consumed.add(key);
            this.expandRouteArray(childArrayNode, childModule, fullPath, childGuards, out, consumed, lazyDepth + 1);
          }
        }
      }
    }
  }

  private resolveRouteArrayReference(
    name: string,
    module: ModuleInfo,
    consumed: Set<string>
  ): { node: any; module: ModuleInfo } | null {
    const local = module.declarations.get(name);
    if (local) {
      const arrayNode = this.unwrapExpression(local.init);
      if (arrayNode?.type === 'ArrayExpression') {
        const key = this.definitionKey(module.filePath, name);
        if (consumed.has(key)) return null;
        consumed.add(key);
        return { node: arrayNode, module };
      }
      return null;
    }
    const imported = module.imports.get(name);
    if (!imported) return null;
    const targetFile = this.resolveImportFile(module.filePath, imported.source);
    if (!targetFile) return null;
    const targetModule = this.getModule(targetFile);
    if (!targetModule) return null;
    const declarator = targetModule.declarations.get(imported.imported);
    const arrayNode = declarator ? this.unwrapExpression(declarator.init) : undefined;
    if (arrayNode?.type !== 'ArrayExpression') return null;
    const key = this.definitionKey(targetModule.filePath, imported.imported);
    if (consumed.has(key)) return null;
    consumed.add(key);
    return { node: arrayNode, module: targetModule };
  }

  private extractLazyImport(node: any, module: ModuleInfo): { file: string | null; exportName: string } | null {
    const expression = this.unwrapExpression(node);
    if (!expression || (expression.type !== 'ArrowFunctionExpression' && expression.type !== 'FunctionExpression')) {
      return null;
    }

    let bodyExpression = expression.body;
    if (bodyExpression?.type === 'BlockStatement') {
      const returnStatement = (bodyExpression.body || []).find((s: any) => s.type === 'ReturnStatement');
      bodyExpression = returnStatement?.argument;
    }
    bodyExpression = this.unwrapExpression(bodyExpression);
    if (!bodyExpression) return null;

    let importSpec: string | undefined;
    let exportName: string | undefined;

    if (
      bodyExpression.type === 'CallExpression'
      && bodyExpression.callee?.type === 'MemberExpression'
      && bodyExpression.callee.property?.name === 'then'
    ) {
      const importCall = this.unwrapExpression(bodyExpression.callee.object);
      if (importCall?.type === 'ImportExpression') {
        importSpec = importCall.source?.value;
      } else if (importCall?.type === 'CallExpression' && importCall.callee?.type === 'Import') {
        importSpec = importCall.arguments?.[0]?.value;
      }
      const thenCallback = this.unwrapExpression(bodyExpression.arguments?.[0]);
      if (thenCallback?.type === 'ArrowFunctionExpression' || thenCallback?.type === 'FunctionExpression') {
        let callbackBody = thenCallback.body;
        if (callbackBody?.type === 'BlockStatement') {
          const returnStatement = (callbackBody.body || []).find((s: any) => s.type === 'ReturnStatement');
          callbackBody = returnStatement?.argument;
        }
        callbackBody = this.unwrapExpression(callbackBody);
        if (callbackBody?.type === 'MemberExpression' && callbackBody.property?.name) {
          exportName = callbackBody.property.name;
        }
      }
    } else if (bodyExpression.type === 'ImportExpression') {
      importSpec = bodyExpression.source?.value;
      exportName = 'default';
    }

    if (!importSpec || !exportName) return null;
    const file = this.resolveImportFile(module.filePath, importSpec);
    return { file, exportName };
  }

  private identifierNames(node: any): string[] {
    const expression = this.unwrapExpression(node);
    if (expression?.type !== 'ArrayExpression') return [];
    const names: string[] = [];
    for (const element of expression.elements || []) {
      const item = this.unwrapExpression(element);
      if (item?.type === 'Identifier') {
        names.push(item.name);
      } else if (item?.type === 'MemberExpression' && item.property?.name) {
        names.push(item.property.name);
      }
    }
    return names;
  }

  private propertyName(property: any): string | undefined {
    if (property.computed) return undefined;
    if (property.key?.type === 'Identifier') return property.key.name;
    if (property.key?.type === 'Literal') return String(property.key.value);
    return undefined;
  }

  private evaluatedPropertyName(property: any, module: ModuleInfo): string | undefined {
    const value = this.evaluate(property.key, module);
    return typeof value === 'string' ? value : undefined;
  }

  private sourceSnippet(module: ModuleInfo, node: any): string {
    if (node?.range && module.content) {
      return module.content.slice(node.range[0], node.range[1]).replace(/\s+/g, ' ').trim();
    }
    return '<unresolved>';
  }

  private joinPaths(parent: string, segment: string): string {
    const cleanParent = parent.replace(/^\/+|\/+$/g, '');
    const cleanSegment = segment.replace(/^\/+|\/+$/g, '');
    if (!cleanParent) return cleanSegment;
    if (!cleanSegment) return cleanParent;
    return `${cleanParent}/${cleanSegment}`;
  }

  private toProjectRelative(filePath: string): string {
    const relative = path.relative(this.projectPath, filePath);
    return relative.startsWith('..') ? filePath : relative;
  }

  private unwrapExpression(node: any): any {
    let current = node;
    while (current) {
      if (current.type === 'TSAsExpression' || current.type === 'TSNonNullExpression'
        || current.type === 'TSSatisfiesExpression' || current.type === 'TSTypeAssertion') {
        current = current.expression;
      } else if (current.type === 'ChainExpression') {
        current = current.expression;
      } else {
        break;
      }
    }
    return current;
  }

  evaluate(node: any, module: ModuleInfo | string): unknown {
    const moduleInfo = typeof module === 'string' ? this.getModule(module) : module;
    if (!moduleInfo) return EVAL_FAILED;
    try {
      return this.evaluateExpression(node, { module: moduleInfo, steps: { count: 0 }, depth: 0 });
    } catch {
      return EVAL_FAILED;
    }
  }

  private evaluateExpression(rawNode: any, ctx: EvalContext): unknown {
    if (ctx.steps.count++ > MAX_EVAL_STEPS || ctx.depth > MAX_EVAL_DEPTH) throw new Error('budget');
    const node = this.unwrapExpression(rawNode);
    if (!node) throw new Error('empty');
    const next: EvalContext = { ...ctx, depth: ctx.depth + 1 };

    switch (node.type) {
      case 'Literal':
        return node.value;
      case 'TemplateLiteral': {
        let result = '';
        for (let i = 0; i < node.quasis.length; i++) {
          result += node.quasis[i].value.cooked ?? '';
          if (i < node.expressions.length) {
            const part = this.evaluateExpression(node.expressions[i], next);
            if (part === undefined || part === null || isClosure(part)) throw new Error('template');
            result += String(part);
          }
        }
        return result;
      }
      case 'Identifier':
        return this.resolveIdentifier(node.name, next);
      case 'MemberExpression': {
        const object = this.evaluateExpression(node.object, next);
        let key: string | number;
        if (node.computed) {
          const evaluatedKey = this.evaluateExpression(node.property, next);
          if (typeof evaluatedKey !== 'string' && typeof evaluatedKey !== 'number') throw new Error('member-key');
          key = evaluatedKey;
        } else {
          key = node.property?.name;
        }
        if (object === null || object === undefined) throw new Error('member-object');
        if (Array.isArray(object) || typeof object === 'object') {
          return (object as any)[key];
        }
        throw new Error('member');
      }
      case 'ArrayExpression': {
        const items: unknown[] = [];
        for (const element of node.elements || []) {
          if (!element) continue;
          if (element.type === 'SpreadElement') {
            const spread = this.evaluateExpression(element.argument, next);
            if (!Array.isArray(spread)) throw new Error('spread');
            items.push(...spread);
          } else {
            items.push(this.evaluateExpression(element, next));
          }
        }
        return items;
      }
      case 'ObjectExpression': {
        const result: Record<string, unknown> = {};
        for (const property of node.properties || []) {
          if (property.type === 'SpreadElement') {
            const spread = this.evaluateExpression(property.argument, next);
            if (spread === null || typeof spread !== 'object' || Array.isArray(spread)) throw new Error('obj-spread');
            Object.assign(result, spread);
            continue;
          }
          if (property.type !== 'Property') continue;
          let key: string;
          if (property.computed) {
            const evaluatedKey = this.evaluateExpression(property.key, next);
            if (typeof evaluatedKey !== 'string' && typeof evaluatedKey !== 'number') throw new Error('obj-key');
            key = String(evaluatedKey);
          } else if (property.key?.type === 'Identifier') {
            key = property.key.name;
          } else if (property.key?.type === 'Literal') {
            key = String(property.key.value);
          } else {
            throw new Error('obj-key');
          }
          result[key] = this.evaluateExpression(property.value, next);
        }
        return result;
      }
      case 'ArrowFunctionExpression':
      case 'FunctionExpression':
        return {
          __closure: true,
          params: node.params || [],
          body: node.body,
          module: ctx.module,
          scope: ctx.scope,
        } satisfies ClosureValue;
      case 'CallExpression':
        return this.evaluateCall(node, next);
      case 'UnaryExpression': {
        if (node.operator === 'typeof') {
          const value = this.evaluateExpression(node.argument, next);
          return isClosure(value) ? 'function' : typeof value;
        }
        const value = this.evaluateExpression(node.argument, next);
        if (node.operator === '!') return !value;
        if (node.operator === '-') return -(value as number);
        if (node.operator === '+') return +(value as number);
        throw new Error('unary');
      }
      case 'BinaryExpression': {
        const left = this.evaluateExpression(node.left, next);
        const right = this.evaluateExpression(node.right, next);
        switch (node.operator) {
          case '===': return left === right;
          case '!==': return left !== right;
          case '==': return left == right;
          case '!=': return left != right;
          case '+': return (left as any) + (right as any);
          case '-': return (left as number) - (right as number);
          default: throw new Error('binary');
        }
      }
      case 'LogicalExpression': {
        const left = this.evaluateExpression(node.left, next);
        if (node.operator === '||') return left ? left : this.evaluateExpression(node.right, next);
        if (node.operator === '&&') return left ? this.evaluateExpression(node.right, next) : left;
        if (node.operator === '??') return left ?? this.evaluateExpression(node.right, next);
        throw new Error('logical');
      }
      case 'ConditionalExpression': {
        const test = this.evaluateExpression(node.test, next);
        return test
          ? this.evaluateExpression(node.consequent, next)
          : this.evaluateExpression(node.alternate, next);
      }
      default:
        throw new Error(`unsupported:${node.type}`);
    }
  }

  private evaluateCall(node: any, ctx: EvalContext): unknown {
    const callee = this.unwrapExpression(node.callee);

    if (callee?.type === 'MemberExpression' && !callee.computed && callee.property?.name === 'join') {
      const target = this.evaluateExpression(callee.object, ctx);
      if (Array.isArray(target)) {
        const separator = node.arguments?.length > 0
          ? this.evaluateExpression(node.arguments[0], ctx)
          : ',';
        if (typeof separator !== 'string') throw new Error('join-sep');
        if (target.some(item => isClosure(item) || (item !== null && typeof item === 'object'))) {
          throw new Error('join-items');
        }
        return target.join(separator);
      }
      throw new Error('join');
    }

    const calleeValue = this.evaluateExpression(node.callee, ctx);
    if (!isClosure(calleeValue)) throw new Error('call');

    const args = (node.arguments || []).map((argument: any) => {
      if (argument.type === 'SpreadElement') throw new Error('call-spread');
      return this.evaluateExpression(argument, ctx);
    });

    const bindings = new Map<string, unknown>();
    calleeValue.params.forEach((param: any, index: number) => {
      if (param.type === 'Identifier') {
        bindings.set(param.name, args[index]);
      } else if (param.type === 'AssignmentPattern' && param.left?.type === 'Identifier') {
        bindings.set(
          param.left.name,
          args[index] !== undefined
            ? args[index]
            : this.evaluateExpression(param.right, { ...ctx, module: calleeValue.module, scope: calleeValue.scope })
        );
      } else {
        throw new Error('param');
      }
    });

    const callCtx: EvalContext = {
      module: calleeValue.module,
      scope: { bindings, parent: calleeValue.scope },
      steps: ctx.steps,
      depth: ctx.depth + 1,
    };

    if (calleeValue.body?.type !== 'BlockStatement') {
      return this.evaluateExpression(calleeValue.body, callCtx);
    }

    const result = this.executeBlock(calleeValue.body, callCtx);
    return result.returned ? result.value : undefined;
  }

  private executeBlock(block: any, ctx: EvalContext): { returned: boolean; value: unknown } {
    for (const statement of block.body || []) {
      const result = this.executeStatement(statement, ctx);
      if (result.returned) return result;
    }
    return { returned: false, value: undefined };
  }

  private executeStatement(statement: any, ctx: EvalContext): { returned: boolean; value: unknown } {
    if (ctx.steps.count++ > MAX_EVAL_STEPS) throw new Error('budget');
    switch (statement.type) {
      case 'VariableDeclaration': {
        for (const declarator of statement.declarations || []) {
          if (declarator.id?.type === 'Identifier') {
            ctx.scope!.bindings.set(
              declarator.id.name,
              declarator.init ? this.evaluateExpression(declarator.init, ctx) : undefined
            );
          }
        }
        return { returned: false, value: undefined };
      }
      case 'ReturnStatement':
        return {
          returned: true,
          value: statement.argument ? this.evaluateExpression(statement.argument, ctx) : undefined,
        };
      case 'IfStatement': {
        const test = this.evaluateExpression(statement.test, ctx);
        const branch = test ? statement.consequent : statement.alternate;
        if (!branch) return { returned: false, value: undefined };
        if (branch.type === 'BlockStatement') return this.executeBlock(branch, ctx);
        return this.executeStatement(branch, ctx);
      }
      case 'ThrowStatement':
        throw new Error('thrown');
      case 'ExpressionStatement':
      case 'EmptyStatement':
        return { returned: false, value: undefined };
      case 'BlockStatement':
        return this.executeBlock(statement, ctx);
      default:
        throw new Error(`statement:${statement.type}`);
    }
  }

  private resolveIdentifier(name: string, ctx: EvalContext): unknown {
    if (name === 'undefined') return undefined;

    let scope = ctx.scope;
    while (scope) {
      if (scope.bindings.has(name)) return scope.bindings.get(name);
      scope = scope.parent;
    }

    const module = ctx.module;
    const declarator = module.declarations.get(name);
    if (declarator?.init) {
      return this.evaluateExpression(declarator.init, { module, steps: ctx.steps, depth: ctx.depth + 1 });
    }

    const functionDeclaration = module.functions.get(name);
    if (functionDeclaration) {
      return {
        __closure: true,
        params: functionDeclaration.params || [],
        body: functionDeclaration.body,
        module,
      } satisfies ClosureValue;
    }

    const enumDeclaration = module.enums.get(name);
    if (enumDeclaration) return this.evaluateEnum(enumDeclaration);

    const imported = module.imports.get(name);
    if (imported) {
      const targetFile = this.resolveImportFile(module.filePath, imported.source);
      if (!targetFile) throw new Error(`import:${name}`);
      const targetModule = this.getModule(targetFile);
      if (!targetModule) throw new Error(`import:${name}`);
      return this.resolveIdentifier(imported.imported, { module: targetModule, steps: ctx.steps, depth: ctx.depth + 1 });
    }

    throw new Error(`identifier:${name}`);
  }

  private evaluateEnum(enumDeclaration: any): Record<string, string | number> {
    const result: Record<string, string | number> = {};
    let nextNumeric = 0;
    const members = enumDeclaration.body?.members || enumDeclaration.members || [];
    for (const member of members) {
      const key = member.id?.name ?? member.id?.value;
      if (key === undefined) continue;
      if (member.initializer) {
        if (member.initializer.type === 'Literal') {
          result[key] = member.initializer.value;
          if (typeof member.initializer.value === 'number') nextNumeric = member.initializer.value + 1;
        } else {
          throw new Error('enum-init');
        }
      } else {
        result[key] = nextNumeric;
        nextNumeric += 1;
      }
    }
    return result;
  }
}

export const ANGULAR_ROUTE_EVAL_FAILED = EVAL_FAILED;
