import { AnalysisContext, BaseAnalyzer, FileAnalysisContext, FileAnalysisResult } from '../../core/base-analyzer';
import { CASEdge, CASEntryPoint, CASContribution, CASLibrary, CASNode } from '../../../types/cas.types';
import * as fs from 'fs-extra';
import * as path from 'path';
import { cachedGlob as glob } from '../../core/glob-cache';
import { createYieldBudget } from '../../core/event-loop-yield';

type AuthMechanismKind = 'auth_strategy' | 'auth_policy' | 'guard';
type PackageManager = 'npm' | 'pip' | 'bundler' | 'maven' | 'gradle' | 'rego';

interface AuthRule {
  name: string;
  displayName: string;
  kind: AuthMechanismKind;
  packageManagers: PackageManager[];
  packages: string[];
  importSources: RegExp[];
  sitePatterns: RegExp[];
  policyEngine?: boolean;
}

interface DependencyHit {
  name: string;
  version?: string;
  type: CASLibrary['type'];
  packageManager: PackageManager;
}

interface AuthSite {
  rule: AuthRule;
  file: string;
  line: number;
  name: string;
  route?: RouteTarget;
  edgeType: 'guards' | 'authorizes';
  excerpt: string;
}

interface RouteTarget {
  method?: string;
  path?: string;
  handler?: string;
  line: number;
  /**
   * True when `path` is a file-anchored fallback (e.g. the source file itself for a
   * Python `@api_view`, or `file#action` for a Rails action) rather than a resolved
   * URL. The owning framework analyzer (Django/Rails) resolves the real URL→auth
   * mapping via its urls.py / routes graph, so the auth analyzer must NOT synthesize a
   * standalone route into the route table from this fallback — that would duplicate the
   * protected route under a bogus file path. The auth mechanism node/edge is still
   * emitted so the guard evidence is recorded.
   */
  pathIsFile?: boolean;
}

const AUTH_RULES: AuthRule[] = [
  rule('passport', 'Passport strategy', 'auth_strategy', ['npm'], ['passport', '@nestjs/passport', '@nestjs/jwt', 'passport-jwt'], [/^passport$/, /^passport-/, /^@nestjs\/(?:passport|jwt)$/], [
    /\bpassport\.use\s*\(/,
    /\bpassport\.authenticate\s*\(/,
    // NestJS passport idioms — corpus-depth sweep: benchmarked NestJS APIs
    // use @UseGuards(AuthGuard(...)) + PassportStrategy subclasses,
    // never bare passport.use/authenticate; auth ran with ZERO nodes on them.
    // Import-gated on passport/@nestjs/passport/@nestjs/jwt.
    /@UseGuards\s*\(\s*(?:new\s+)?[A-Za-z]*AuthGuard/,
    /\bextends\s+PassportStrategy\s*\(/,
  ]),
  rule('next-auth', 'NextAuth/Auth.js session', 'auth_strategy', ['npm'], ['next-auth', '@auth/core', '@auth/nextjs'], [/^next-auth(?:\/|$)/, /^@auth\//], [
    /\bNextAuth\s*\(/,
    /\b(getServerSession|auth|handlers|signIn|signOut)\s*\(/,
  ]),
  rule('auth0', 'Auth0 guard', 'auth_strategy', ['npm'], ['@auth0/nextjs-auth0', '@auth0/auth0-react', 'express-oauth2-jwt-bearer', 'auth0'], [/^@auth0\//, /^express-oauth2-jwt-bearer$/], [
    /\b(withApiAuthRequired|withPageAuthRequired|requiresAuth|auth|claimCheck|jwtCheck)\s*\(/,
    // React SPA idioms (@auth0/auth0-react) — corpus-depth sweep: 4 real repos
    // shipped auth0-react and produced ZERO auth nodes because only the
    // server-SDK call shapes were recognized. Import-gated (/^@auth0\//), so
    // these names can't fire in unrelated code.
    /\buseAuth0\s*\(/,
    /<Auth0Provider\b/,
    /\bwithAuthenticationRequired\s*\(/,
  ]),
  rule('clerk', 'Clerk guard', 'auth_strategy', ['npm'], ['@clerk/nextjs', '@clerk/clerk-sdk-node', '@clerk/express', '@clerk/clerk-react'], [/^@clerk\//], [
    /\b(auth|currentUser|clerkClient|requireAuth|clerkMiddleware)\s*\(/,
    // React SPA idioms (@clerk/clerk-react) — same corpus-depth gap as auth0.
    /<(ClerkProvider|SignedIn|SignedOut|RedirectToSignIn)\b/,
    /\buse(Auth|User|Session|Clerk)\s*\(/,
  ]),
  rule('firebase-auth', 'Firebase Auth token verification', 'auth_strategy', ['npm', 'pip'], ['firebase-admin', 'firebase'], [/^firebase-admin(?:\/|$)/, /^firebase(?:\/|$)/], [
    /\b(verifyIdToken|getAuth|createCustomToken|signInWithEmailAndPassword)\s*\(/,
  ]),
  rule('lucia', 'Lucia session guard', 'auth_strategy', ['npm'], ['lucia'], [/^lucia(?:\/|$)/], [
    /\b(validateSession|createSession|readSessionCookie|Lucia)\s*\(/,
  ]),
  rule('jsonwebtoken', 'JWT token guard', 'auth_strategy', ['npm'], ['jsonwebtoken'], [/^jsonwebtoken$/], [
    /\bjwt\.(sign|verify)\s*\(/,
  ]),
  rule('express-jwt', 'express-jwt middleware', 'guard', ['npm'], ['express-jwt'], [/^express-jwt$/], [
    /\b(expressjwt|jwt)\s*\(/,
  ]),
  rule('spring-security', 'Spring Security policy', 'auth_policy', ['maven', 'gradle'], ['spring-security', 'spring-boot-starter-security', 'org.springframework.security:spring-security'], [/^org\.springframework\.security\./, /^jakarta\.annotation\.security\./, /^javax\.annotation\.security\./], [
    /\bSecurityFilterChain\b/,
    /@(PreAuthorize|Secured|RolesAllowed)\b/,
  ]),
  rule('django-auth', 'Django authentication guard', 'guard', ['pip'], ['Django', 'django', 'djangorestframework'], [/^django\.contrib\.auth\b/, /^rest_framework\.(permissions|decorators)\b/], [
    /\b(login_required|permission_classes|IsAuthenticated|IsAdminUser|DjangoModelPermissions)\b/,
  ]),
  rule('flask-login', 'Flask-Login guard', 'guard', ['pip'], ['Flask-Login', 'flask-login'], [/^flask_login$/], [
    /@login_required\b/,
    /\bcurrent_user\b/,
  ]),
  rule('pyjwt', 'PyJWT token guard', 'auth_strategy', ['pip'], ['PyJWT', 'jwt'], [/^jwt$/], [
    /\bjwt\.(encode|decode)\s*\(/,
  ]),
  rule('authlib', 'Authlib OAuth guard', 'auth_strategy', ['pip'], ['Authlib', 'authlib'], [/^authlib(?:\.|$)/], [
    /\b(OAuth|authorize_access_token|register)\s*\(/,
  ]),
  rule('devise', 'Devise controller guard', 'guard', ['bundler'], ['devise'], [/^devise$/], [
    /\b(before_action\s+:authenticate_\w+!|authenticate_\w+!|devise_for)\b/,
  ]),
  rule('pundit', 'Pundit policy', 'auth_policy', ['bundler'], ['pundit'], [/^pundit$/], [
    /\b(authorize|policy_scope|verify_authorized)\b/,
  ], true),
  rule('cancancan', 'CanCanCan ability policy', 'auth_policy', ['bundler'], ['cancancan'], [/^cancan/, /^cancancan$/], [
    /\b(load_and_authorize_resource|authorize!)\b/,
  ], true),
  rule('casbin', 'Casbin policy enforcement', 'auth_policy', ['npm', 'pip', 'maven', 'gradle'], ['casbin', 'node-casbin', 'jcasbin'], [/^casbin$/, /^casbin\./, /^org\.casbin\./], [
    /\b(enforce|Enforcer|newEnforcer|new_enforcer)\s*\(/,
  ], true),
  rule('opa-rego', 'OPA/Rego policy', 'auth_policy', ['rego'], ['rego'], [], [
    /^\s*(allow|deny|violation|authz)\b/,
  ], true),
  rule('casl', 'CASL ability policy', 'auth_policy', ['npm'], ['@casl/ability'], [/^@casl\/ability$/], [
    /\b(AbilityBuilder|createMongoAbility|can|cannot)\b/,
  ], true),
  rule('oso', 'Oso policy', 'auth_policy', ['npm', 'pip'], ['oso', 'django-oso'], [/^oso$/, /^django_oso\b/], [
    /\b(isAllowed|is_allowed|authorize|Oso)\s*\(/,
  ], true),
];

export class AuthAnalyzer extends BaseAnalyzer {
  constructor() {
    super(
      'auth',
      'Authentication and Authorization Analyzer',
      '1.0.0',
      'library'
    );
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    const dependencies = await this.readDependencies(projectPath);
    if (dependencies.some(dep => AUTH_RULES.some(rule => this.ruleMatchesDependency(rule, dep)))) return true;
    return (await glob('**/*.rego', {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true,
    })).length > 0;
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    return this.sourceFiles({ projectPath });
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const result = await this.analyzeAuth(context.projectPath, await this.sourceFiles(context), true);
    const contribution = this.createContribution(result.nodes, result.edges, result.entryPoints, [], {
      library_family: 'authentication-authorization',
      mechanisms_detected: result.nodes.length,
      protected_entry_points: result.entryPoints.filter(entry => entry.security?.authenticated || entry.security?.authorized_roles?.length).length,
      guard_edges: result.edges.filter(edge => edge.type === 'guards').length,
      authorization_edges: result.edges.filter(edge => edge.type === 'authorizes').length,
    });
    contribution.libraries = result.libraries;
    return contribution;
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const content = await fs.readFile(context.filePath, 'utf8');
    const stat = await fs.stat(context.filePath);
    const result = await this.analyzeAuth(context.projectPath, [context.relativePath], false);
    return this.createFileAnalysisResult(
      context.filePath,
      context.relativePath,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      result.nodes,
      result.edges,
      result.entryPoints,
      [],
      this.extractImports(content),
      result.nodes.map(node => node.name)
    );
  }

  protected getCapabilities(): string[] {
    return [
      'auth-strategy-detection',
      'authorization-policy-detection',
      'guarded-route-linkage',
      'jwt-and-session-boundary-detection',
      'policy-engine-detection',
    ];
  }

  protected getLevelName(level: number): string {
    return level <= 3 ? 'security boundary' : 'auth usage';
  }

  private async sourceFiles(context: AnalysisContext): Promise<string[]> {
    const groundedFiles = this.filesFromExistingAnalysis(
      context,
      source => AUTH_RULES.some(ruleDef => ruleDef.importSources.some(pattern => pattern.test(source))),
      true
    );
    const conventionFiles = await glob([
      '**/*{auth,guard,policy,permission,session,jwt,oauth}*.{ts,tsx,js,jsx,py,rb,java}',
      '**/*.rego',
    ], {
      cwd: context.projectPath,
      ignore: [...this.getIgnorePatterns(context), '**/*.test.*', '**/*.spec.*'],
      nodir: true,
      absolute: false,
    });
    const evidenceFiles = [...new Set([...groundedFiles, ...conventionFiles])].sort();
    if ((context.existingAnalysis?.length || 0) > 0 && evidenceFiles.length > 0) {
      return this.capAndPrioritizeSourceFiles(evidenceFiles, 'auth candidate files');
    }

    return this.capAndPrioritizeSourceFiles(await glob([
      '**/*.{ts,tsx,js,jsx,py,rb,java,rego}',
    ], {
      cwd: context.projectPath,
      ignore: [...this.getIgnorePatterns(context), '**/*.test.*', '**/*.spec.*'],
      nodir: true,
      absolute: false,
    }), 'auth candidate files');
  }

  private async analyzeAuth(projectPath: string, files: string[], includeLibraries: boolean): Promise<{ nodes: CASNode[]; edges: CASEdge[]; entryPoints: CASEntryPoint[]; libraries: CASLibrary[] }> {
    const dependencies = await this.readDependencies(projectPath);
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const libraries: CASLibrary[] = [];
    const sites: AuthSite[] = [];

    // Budget-yield per file: with the shared file-read cache warm the await
    // resolves in a microtask (no event-loop hop), so this scan ran as one
    // multi-second synchronous block on a whale repo. Results unchanged.
    const maybeYield = createYieldBudget();
    for (const file of files) {
      await maybeYield();
      const content = await this.readFile(projectPath, file);
      if (content === null) continue;
      const imports = this.extractImports(content);
      const fileRules = AUTH_RULES.filter(rule => this.fileMatchesRule(file, content, imports, dependencies, rule));
      if (fileRules.length === 0) continue;
      sites.push(...this.findSites(file, content, fileRules));
    }

    for (const site of sites) {
      const mechanismId = `auth_${this.sanitizeId(site.rule.name)}_${this.sanitizeId(site.file)}_${site.line}`;
      nodes.push(this.createNode(
        mechanismId,
        site.name,
        site.rule.kind,
        site.route ? 3 : 4,
        site.file,
        site.line,
        site.line,
        {
          library: site.rule.displayName,
          package_names: site.rule.packages,
          auth_kind: site.rule.kind,
          policy_engine: site.rule.policyEngine || false,
          excerpt: site.excerpt,
          subcategories: ['auth', site.rule.kind],
        }
      ));

      // Only synthesize a standalone protected route when the auth site carries a
      // RESOLVED URL path. When `pathIsFile` is set (Python @api_view / Rails action),
      // the path is a file-anchored fallback and the owning framework analyzer
      // (Django/Rails) already emits the real route with its auth guard — synthesizing
      // here would duplicate the protected route under a bogus file path and pollute the
      // route table. The auth mechanism node/edge above still records the guard evidence.
      if (site.route && !site.route.pathIsFile) {
        const routeId = `auth_route_${this.sanitizeId(site.file)}_${site.route.line}`;
        if (!nodes.some(node => node.id === routeId)) {
          nodes.push(this.createNode(
            routeId,
            this.routeName(site.route, site.file),
            'route',
            3,
            site.file,
            site.route.line,
            site.route.line,
            {
              method: site.route.method,
              path: site.route.path,
              handler: site.route.handler,
              security_source: site.rule.displayName,
              subcategories: ['route', 'http', 'auth-protected'],
            }
          ));
          entryPoints.push(this.createEntryPoint(
            `entry_${routeId}`,
            routeId,
            'http',
            this.routeName(site.route, site.file),
            `${site.rule.displayName} protects ${this.routeName(site.route, site.file)}`,
            {
              method: site.route.method || 'UNKNOWN',
              path: site.route.path || site.file,
            },
            {
              authenticated: site.edgeType === 'guards' || site.rule.kind === 'auth_strategy' || site.rule.kind === 'guard',
              authorized_roles: site.edgeType === 'authorizes' ? [site.name] : [],
              guards: [site.name],
            },
            {
              guards: [site.name],
              auth_library: site.rule.name,
              policy_engine: site.rule.policyEngine || false,
              handler: site.route.handler,
              source_file: site.file,
            },
            {
              node_id: routeId,
              method_name: site.route.handler || this.routeName(site.route, site.file),
              file: site.file,
              line: site.route.line,
            }
          ));
        }
        edges.push(this.createEdge(
          this.generateEdgeId(mechanismId, routeId, site.edgeType),
          mechanismId,
          routeId,
          site.edgeType,
          'security',
          {
            library: site.rule.name,
            mechanism: site.name,
            target_entry_point: `entry_${routeId}`,
          }
        ));
      }
    }

    if (includeLibraries) {
      for (const dep of dependencies) {
        const matchingRule = AUTH_RULES.find(rule => this.ruleMatchesDependency(rule, dep));
        if (!matchingRule) continue;
        libraries.push({
          id: `lib_${this.sanitizeId(dep.name)}`,
          name: dep.name,
          version: dep.version,
          type: dep.type,
          package_manager: dep.packageManager,
          category: 'auth',
          description: `${matchingRule.displayName} participates in authentication or authorization boundaries.`,
          usage_patterns: matchingRule.sitePatterns.map(pattern => ({
            pattern: String(pattern),
            occurrences: sites.filter(site => site.rule.name === matchingRule.name).length,
            example_nodes: nodes.filter(node => (node.metadata as any)?.library === matchingRule.displayName).slice(0, 5).map(node => node.id),
          })),
          connected_nodes: nodes.filter(node => (node.metadata as any)?.library === matchingRule.displayName).map(node => node.id),
          usage_statistics: {
            import_count: sites.filter(site => site.rule.name === matchingRule.name).length,
            usage_frequency: sites.some(site => site.rule.name === matchingRule.name) ? 'medium' : 'declared-only',
            critical_path: true,
          },
          metadata: { breaking_changes_risk: 'high' },
        });
      }
    }

    return { nodes, edges, entryPoints, libraries };
  }

  private findSites(file: string, content: string, rules: AuthRule[]): AuthSite[] {
    const sites: AuthSite[] = [];
    const lines = content.split(/\r?\n/);
    const routeContextByLine = this.routeContexts(file, lines);
    lines.forEach((line, index) => {
      const lineNumber = index + 1;
      const windowText = lines.slice(Math.max(0, index - 4), Math.min(lines.length, index + 5)).join('\n');
      const route = routeContextByLine.get(lineNumber) || this.extractInlineRoute(file, windowText, lineNumber);
      for (const rule of rules) {
        for (const pattern of rule.sitePatterns) {
          pattern.lastIndex = 0;
          if (!pattern.test(line)) continue;
          const edgeType = rule.kind === 'auth_policy' ? 'authorizes' : 'guards';
          sites.push({
            rule,
            file,
            line: lineNumber,
            name: this.siteName(rule, line),
            route,
            edgeType,
            excerpt: line.trim().slice(0, 180),
          });
          break;
        }
      }
    });
    return this.uniqueSites(sites);
  }

  private routeContexts(file: string, lines: string[]): Map<number, RouteTarget> {
    const contexts = new Map<number, RouteTarget>();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const expressRoute = this.extractExpressRoute(line, i + 1);
      if (expressRoute) contexts.set(i + 1, expressRoute);

      const springRoute = this.extractSpringRoute(lines, i);
      if (springRoute) {
        for (let j = Math.max(0, i - 4); j <= i + 4 && j < lines.length; j++) contexts.set(j + 1, springRoute);
      }

      const flaskRoute = line.match(/@(?:\w+\.)?route\s*\(\s*['"]([^'"]+)['"]/);
      if (flaskRoute) {
        const method = (line.match(/methods\s*=\s*\[[^\]]*['"]([A-Z]+)['"]/)?.[1] || 'GET').toUpperCase();
        const handler = this.nextFunctionName(lines, i);
        for (let j = i; j <= i + 4 && j < lines.length; j++) contexts.set(j + 1, { method, path: flaskRoute[1], handler, line: i + 1 });
      }

      const apiView = line.match(/@api_view\s*\(\s*\[([^\]]+)\]/);
      if (apiView) {
        const method = apiView[1].match(/['"]([A-Z]+)['"]/)?.[1] || 'GET';
        const handler = this.nextFunctionName(lines, i);
        // path falls back to the source file: the Django analyzer resolves the real
        // URL (urls.py) and owns the route+auth mapping. Flag so we don't emit a phantom.
        for (let j = i; j <= i + 4 && j < lines.length; j++) contexts.set(j + 1, { method, path: file, handler, line: i + 1, pathIsFile: true });
      }

      const nextHandler = line.match(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/);
      if (nextHandler) {
        for (let j = i; j <= i + 8 && j < lines.length; j++) contexts.set(j + 1, { method: nextHandler[1], path: this.nextRoutePath(file), handler: nextHandler[1], line: i + 1 });
      }

      const railsAction = line.match(/^\s*def\s+([a-zA-Z_]\w*)/);
      if (railsAction) {
        // path is a file-anchored pseudo-route (`file#action`); the Rails analyzer owns
        // the resolved routes.rb URL→auth mapping. Flag so we don't emit a phantom route.
        for (let j = i; j <= i + 12 && j < lines.length; j++) contexts.set(j + 1, { path: `${file}#${railsAction[1]}`, handler: railsAction[1], line: i + 1, pathIsFile: true });
      }
    }
    return contexts;
  }

  private extractInlineRoute(file: string, text: string, line: number): RouteTarget | undefined {
    return this.extractExpressRoute(text, line) || (file.endsWith('.java') ? this.extractSpringRoute(text.split(/\r?\n/), 0) : undefined);
  }

  private extractExpressRoute(text: string, line: number): RouteTarget | undefined {
    const match = text.match(/\b(?:app|router|route)\.(get|post|put|patch|delete|all|use)\s*\(\s*['"`]([^'"`]+)['"`]([\s\S]*)/i);
    if (!match) return undefined;
    const handler = [...match[3].matchAll(/\b([A-Za-z_$][\w$]*)\s*(?:,|\))/g)].map(m => m[1]).filter(name => !['passport', 'jwt', 'expressjwt'].includes(name)).pop();
    return { method: match[1].toUpperCase(), path: match[2], handler, line };
  }

  private extractSpringRoute(lines: string[], index: number): RouteTarget | undefined {
    const windowText = lines.slice(Math.max(0, index - 4), Math.min(lines.length, index + 5)).join('\n');
    const mapping = windowText.match(/@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\s*(?:\(\s*(?:value\s*=\s*)?["']([^"']+)["'])?/);
    if (!mapping) return undefined;
    const method = mapping[1].replace('Mapping', '').toUpperCase() || 'REQUEST';
    const handler = windowText.match(/\b(?:public|private|protected)?\s*[\w<>, ?]+\s+([A-Za-z_]\w*)\s*\(/)?.[1];
    return { method: method === 'REQUEST' ? undefined : method, path: mapping[2], handler, line: index + 1 };
  }

  private nextFunctionName(lines: string[], index: number): string | undefined {
    for (let i = index; i < Math.min(lines.length, index + 6); i++) {
      const match = lines[i].match(/\b(?:def|function)\s+([A-Za-z_]\w*)/);
      if (match) return match[1];
    }
    return undefined;
  }

  private nextRoutePath(file: string): string {
    const match = file.match(/(?:^|\/)app\/(.+)\/route\.[tj]sx?$/);
    if (!match) return file;
    return `/${match[1].replace(/\/$/, '').replace(/\/?\([^)]*\)/g, '').replace(/\[([^\]]+)\]/g, ':$1')}`;
  }

  private siteName(rule: AuthRule, line: string): string {
    const strategy = line.match(/passport\.authenticate\s*\(\s*['"]([^'"]+)['"]/)?.[1];
    if (strategy) return `${rule.displayName}: ${strategy}`;
    const annotation = line.match(/@(PreAuthorize|Secured|RolesAllowed)\s*(?:\(([^)]*)\))?/)?.[1];
    if (annotation) return `${rule.displayName}: ${annotation}`;
    const permission = line.match(/\b(IsAuthenticated|IsAdminUser|DjangoModelPermissions|login_required|authenticate_\w+!|authorize!?|policy_scope)\b/)?.[1];
    if (permission) return `${rule.displayName}: ${permission}`;
    return rule.displayName;
  }

  private routeName(route: RouteTarget, file: string): string {
    if (route.method && route.path) return `${route.method} ${route.path}`;
    if (route.path) return route.path;
    return route.handler || file;
  }

  private uniqueSites(sites: AuthSite[]): AuthSite[] {
    const seen = new Set<string>();
    return sites.filter(site => {
      const key = `${site.rule.name}:${site.file}:${site.line}:${site.name}:${site.route?.line || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private fileMatchesRule(file: string, content: string, imports: string[], dependencies: DependencyHit[], rule: AuthRule): boolean {
    if (rule.name === 'opa-rego') return file.endsWith('.rego');
    if (!dependencies.some(dep => this.ruleMatchesDependency(rule, dep))) return false;
    if (imports.some(importSource => rule.importSources.some(pattern => pattern.test(importSource)))) return true;
    if (file.endsWith('.java') && rule.name === 'spring-security' && /@(PreAuthorize|Secured|RolesAllowed)\b/.test(content)) return true;
    if (file.endsWith('.rb') && ['devise', 'pundit', 'cancancan'].includes(rule.name)) return true;
    return false;
  }

  private extractImports(content: string): string[] {
    const corpusImports = this.sourceImports(content);
    if (corpusImports) return [...corpusImports].map(value => value.replace(/::/g, '.').toLowerCase());
    const imports = new Set<string>();
    for (const line of content.split(/\r?\n/)) {
      const importMatch = line.match(/^\s*import\s+(?:.+?\s+from\s+)?['"]([^'"]+)['"]/);
      const requireMatch = line.match(/\brequire\(['"]([^'"]+)['"]\)/);
      const pythonMatch = line.match(/^\s*(?:from\s+([a-zA-Z0-9_.]+)\s+import|import\s+([a-zA-Z0-9_.]+))/);
      const rubyMatch = line.match(/^\s*(?:require|include)\s+['"]?([A-Za-z0-9_:.-]+)['"]?/);
      const javaMatch = line.match(/^\s*import\s+([a-zA-Z0-9_.]+);/);
      const value = importMatch?.[1] || requireMatch?.[1] || pythonMatch?.[1] || pythonMatch?.[2] || rubyMatch?.[1] || javaMatch?.[1];
      if (value) imports.add(value.replace(/::/g, '.').toLowerCase());
    }
    return [...imports];
  }

  private async readDependencies(projectPath: string): Promise<DependencyHit[]> {
    return [
      ...await this.readPackageJsonDependencies(projectPath),
      ...await this.readPythonDependencies(projectPath),
      ...await this.readGemfileDependencies(projectPath),
      ...await this.readJavaDependencies(projectPath),
    ];
  }

  private async readPackageJsonDependencies(projectPath: string): Promise<DependencyHit[]> {
    const packageJsonPath = path.join(projectPath, 'package.json');
    if (!await fs.pathExists(packageJsonPath)) return [];
    const pkg = await fs.readJson(packageJsonPath);
    const hits: DependencyHit[] = [];
    const add = (deps: Record<string, string> | undefined, type: CASLibrary['type']) => {
      for (const [name, version] of Object.entries(deps || {})) {
        hits.push({ name, version: String(version).replace(/^[\^~>=<]/, ''), type, packageManager: 'npm' });
      }
    };
    add(pkg.dependencies, 'production');
    add(pkg.devDependencies, 'development');
    add(pkg.peerDependencies, 'peer');
    add(pkg.optionalDependencies, 'optional');
    return hits;
  }

  private async readPythonDependencies(projectPath: string): Promise<DependencyHit[]> {
    const hits: DependencyHit[] = [];
    for (const file of ['requirements.txt', 'requirements/base.txt', 'requirements/production.txt']) {
      const reqPath = path.join(projectPath, file);
      if (!await fs.pathExists(reqPath)) continue;
      const content = await fs.readFile(reqPath, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const match = line.trim().match(/^([a-zA-Z0-9_.-]+)\s*(?:[><=!~]+\s*([^,;\s]+))?/);
        if (match) hits.push({ name: match[1], version: match[2], type: 'production', packageManager: 'pip' });
      }
    }
    return hits;
  }

  private async readGemfileDependencies(projectPath: string): Promise<DependencyHit[]> {
    const gemfile = path.join(projectPath, 'Gemfile');
    if (!await fs.pathExists(gemfile)) return [];
    const content = await fs.readFile(gemfile, 'utf8');
    return content.split(/\r?\n/)
      .map(line => line.match(/^\s*gem\s+['"]([^'"]+)['"](?:,\s*['"]([^'"]+)['"])?/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map(match => ({ name: match[1], version: match[2], type: 'production' as const, packageManager: 'bundler' as const }));
  }

  private async readJavaDependencies(projectPath: string): Promise<DependencyHit[]> {
    const hits: DependencyHit[] = [];
    const pomPath = path.join(projectPath, 'pom.xml');
    if (await fs.pathExists(pomPath)) {
      const content = await fs.readFile(pomPath, 'utf8');
      const dependencyRegex = /<dependency>[\s\S]*?<groupId>([^<]+)<\/groupId>[\s\S]*?<artifactId>([^<]+)<\/artifactId>[\s\S]*?(?:<version>([^<]+)<\/version>)?[\s\S]*?<\/dependency>/g;
      let match: RegExpExecArray | null;
      while ((match = dependencyRegex.exec(content)) !== null) {
        hits.push({ name: `${match[1]}:${match[2]}`, version: match[3], type: 'production', packageManager: 'maven' });
        hits.push({ name: match[2], version: match[3], type: 'production', packageManager: 'maven' });
      }
    }
    const gradleFiles = await glob(['build.gradle', 'build.gradle.kts', '**/build.gradle', '**/build.gradle.kts'], {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true,
    });
    for (const relativeFile of gradleFiles) {
      const content = await fs.readFile(path.join(projectPath, relativeFile), 'utf8');
      const dependencyRegex = /(?:implementation|api|compileOnly|runtimeOnly|testImplementation)\s*(?:\(?\s*)['"]([^:'"]+):([^:'"]+):?([^'"]*)['"]/g;
      let match: RegExpExecArray | null;
      while ((match = dependencyRegex.exec(content)) !== null) {
        hits.push({ name: `${match[1]}:${match[2]}`, version: match[3] || undefined, type: 'production', packageManager: 'gradle' });
        hits.push({ name: match[2], version: match[3] || undefined, type: 'production', packageManager: 'gradle' });
      }
    }
    return hits;
  }

  private async readFile(projectPath: string, relativeFile: string): Promise<string | null> {
    try {
      return await fs.readFile(path.join(projectPath, relativeFile), 'utf8');
    } catch {
      return null;
    }
  }

  private ruleMatchesDependency(rule: AuthRule, dep: DependencyHit): boolean {
    if (!rule.packageManagers.includes(dep.packageManager)) return false;
    const name = dep.name.toLowerCase();
    return rule.packages.some(pkg => name === pkg.toLowerCase() || name.startsWith(`${pkg.toLowerCase()}/`) || name.includes(pkg.toLowerCase()));
  }
}

function rule(
  name: string,
  displayName: string,
  kind: AuthMechanismKind,
  packageManagers: PackageManager[],
  packages: string[],
  importSources: RegExp[],
  sitePatterns: RegExp[],
  policyEngine?: boolean
): AuthRule {
  return { name, displayName, kind, packageManagers, packages, importSources, sitePatterns, policyEngine };
}
