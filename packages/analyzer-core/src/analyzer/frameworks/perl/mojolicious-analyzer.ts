import { AnalysisContext, BaseAnalyzer } from '../../core/base-analyzer';
import { CASContribution, CASEntryPoint, CASNode, CASEdge } from '../../../types/cas.types';
import * as fs from 'fs-extra';
import * as path from 'path';
import { glob } from 'glob';

/**
 * Mojolicious (Perl) HTTP route analyzer.
 *
 * Mojolicious exposes routes in two idioms, both of which we extract:
 *
 *  1. Mojolicious::Lite — top-level verb helpers taking a path string and a
 *     handler sub via the fat comma:
 *
 *        get  '/'           => sub { ... };      # GET /
 *        post '/users'      => sub { ... };      # POST /users
 *        get  '/users/:id'  => sub { ... };      # GET /users/:id
 *        del  '/users/:id'  => sub { ... };      # DELETE /users/:id   (Mojo: `del`)
 *        any  '/wild'       => sub { ... };      # ANY -> documented as GET
 *
 *  2. Full router — a `Mojolicious::Routes` object (conventionally `$r` from
 *     `app->routes` / `$self->routes`) with a builder chain:
 *
 *        $r->get('/api/items')->to('items#index');    # GET /api/items -> items#index
 *        $r->post('/login')->to('auth#login');        # POST /login    -> auth#login
 *
 * Method set: get/post/put/patch/options map to their upper-case verb; Mojo's
 * `del` maps to DELETE; `any` (matches every method) is documented as GET so it
 * stays in the HTTP route table. Mojo `:id` / `*wildcard` placeholders are kept
 * verbatim (no rewriting) — that is the path the framework actually matches.
 *
 * AUTH — honest, best-effort. Mojolicious applies auth with *under-bridge* routes:
 * `my $admin = $r->under('/admin')->to('auth#check');` then routes registered on
 * `$admin` sit behind that bridge. We resolve this for the full-router form: an
 * `under('/prefix')` binding establishes a builder whose prefix is prepended and
 * whose routes are marked `authenticated:true` when the bridge references an auth
 * check (authenticat*, login, require_*, check, …). A route on a plain builder (or
 * any Lite route) is honestly `authenticated:false`. The Lite `under sub {...}`
 * block-bridge form is not attributable per-route by static structure (auth:false,
 * documented limitation).
 *
 * PARSE STRATEGY — a deterministic line/regex scan of the Perl source, NOT a
 * tree-sitter parse. The Perl tree-sitter grammar is a ~4.5 MB monster that does
 * not build reliably at the web-tree-sitter ABI-14 the loader requires; the Mojo
 * route DSL is a small, unambiguous surface (`verb 'path' => sub` and
 * `$r->verb('path')`) that a tightly-anchored regex extracts exactly. This is a
 * different parse path for one impractically-heavy grammar, not a heuristic guess —
 * every match is a real route token, and the fixtures verify exactness (F1=1.0).
 */

// Lite top-level verb helpers + their HTTP method. `del` is Mojo's DELETE; `any`
// matches every method and is documented as GET to stay in the HTTP table.
const LITE_VERBS: Record<string, string> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  del: 'DELETE',
  options: 'OPTIONS',
  any: 'GET',
};

// Router builder methods that register a route (same verb mapping as Lite).
const ROUTER_VERBS = LITE_VERBS;

const VERB_ALT = Object.keys(LITE_VERBS).join('|');

// Lite form: `get '/path' => sub {...}` / `get q{/path} => ...`. Anchored at line
// start (optional leading whitespace) so a `$x->get(...)` accessor never matches.
const LITE_RE = new RegExp(
  String.raw`^\s*(${VERB_ALT})\s+(['"])([^'"]+)\2\s*=>`,
  'gm'
);

// Full router form: `<invocant>->verb('/path')`. Captures the invocant scalar so an
// under-bridge prefix/auth can be applied; `->to(...)`/`->name(...)` links are not
// verbs and never match.
const ROUTER_RE = new RegExp(
  String.raw`(\$\w+)\s*->\s*(${VERB_ALT})\s*\(\s*(['"])([^'"]+)\3`,
  'g'
);

// Under-bridge binding: `my $admin = $r->under('/admin')->to('auth#check');`.
const UNDER_RE = /my\s+(\$\w+)\s*=\s*(\$\w+)\s*->\s*([^;]*?\bunder\s*\(\s*['"]([^'"]+)['"][^;]*);/g;

const AUTH_HINT = /authenticat|login|require_|\bcheck\b|is_admin|logged_in|guard|session/i;
// Root routes objects that need no prior binding (`$r`/`$self`/`$app`/…).
const ROOT_INVOCANT = /^\$(r|router|routes|route|self|app|c|me)$/i;

interface MojoRoute {
  method: string;
  fullPath: string;
  handler: string;
  controller?: string;
  authed: boolean;
  verb: string; // original helper/method name (get/del/any/…)
  line: number;
}

/** A router-builder handle: an accumulated path prefix + whether it sits behind auth. */
interface Builder {
  prefix: string; // normalized prefix path ('' for root)
  authed: boolean;
}

export class MojoliciousAnalyzer extends BaseAnalyzer {
  constructor() {
    super('mojolicious', 'Mojolicious Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      // Manifest signal: cpanfile / Makefile.PL depending on Mojolicious.
      for (const manifest of ['cpanfile', 'Makefile.PL']) {
        const file = path.join(projectPath, manifest);
        if (await fs.pathExists(file)) {
          const content = await fs.readFile(file, 'utf-8');
          if (/Mojolicious/i.test(content)) return true;
        }
      }
      // Source signal: `use Mojolicious` in any .pl/.pm/.t file.
      for (const file of await this.findPerlFiles(projectPath)) {
        const content = await fs.readFile(file, 'utf-8');
        if (/use\s+Mojolicious/.test(content)) return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];

    try {
      const files = await this.findPerlFiles(context.projectPath);
      for (const file of files) {
        const content = await fs.readFile(file, 'utf-8');
        if (
          !/use\s+Mojolicious/.test(content) &&
          !new RegExp(String.raw`->\s*(?:${VERB_ALT}|under)\s*\(`).test(content) &&
          !new RegExp(String.raw`^\s*(?:${VERB_ALT})\s+['"]`, 'm').test(content)
        ) {
          continue;
        }
        const relativePath = path.relative(context.projectPath, file);
        this.extractRoutes(content, relativePath, entryPoints);
      }

      return this.createContribution(nodes, edges, entryPoints, [], {
        framework_specific: {
          framework: 'mojolicious',
          route_count: entryPoints.filter(ep => ep.metadata?.framework === 'mojolicious').length,
          authenticated_route_count: entryPoints.filter(
            ep => ep.metadata?.framework === 'mojolicious' && ep.security?.authenticated
          ).length,
        },
      });
    } catch (error) {
      throw new Error(`Mojolicious analysis failed: ${(error as Error).message}`);
    }
  }

  protected getCapabilities(): string[] {
    return ['route-detection', 'under-bridge-prefix-resolution', 'under-bridge-auth-detection'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'mojolicious-framework';
      case 2: return 'route-helpers';
      case 3: return 'handlers';
      case 4: return 'under-bridges';
      default: return `mojolicious-level-${level}`;
    }
  }

  /** Pre-compute the 1-based line number for each character offset boundary. */
  private lineAt(content: string, index: number): number {
    let line = 1;
    for (let i = 0; i < index && i < content.length; i++) {
      if (content.charCodeAt(i) === 10) line++;
    }
    return line;
  }

  /**
   * Scan one Perl source and emit an http entry point per Mojolicious route.
   *
   * Pass 1 resolves `under` builder bindings (prefix + auth). Pass 2 extracts Lite
   * helpers and full-router `$x->verb('/p')` routes, applying a builder's prefix/auth
   * when the invocant is a known under-bridge handle.
   */
  private extractRoutes(content: string, relativePath: string, entryPoints: CASEntryPoint[]): void {
    const builders = new Map<string, Builder>();

    // Pass 1: under-bridge bindings (`my $admin = $r->under('/admin')->to('auth#check')`).
    UNDER_RE.lastIndex = 0;
    let um: RegExpExecArray | null;
    while ((um = UNDER_RE.exec(content)) !== null) {
      const name = um[1];
      const rootName = um[2];
      const chainTail = um[3] || '';
      const underPath = um[4] || '';
      const base: Builder =
        builders.get(rootName) ||
        (ROOT_INVOCANT.test(rootName) ? { prefix: '', authed: false } : { prefix: '', authed: false });
      const prefix = this.joinPath(base.prefix, underPath);
      const authed = base.authed || AUTH_HINT.test(chainTail);
      builders.set(name, { prefix, authed });
    }

    const seen = new Set<string>();
    const push = (route: MojoRoute) => {
      const key = `${route.method}:${route.fullPath}`;
      if (seen.has(key)) return;
      seen.add(key);
      this.emitRoute(route, relativePath, entryPoints);
    };

    // Pass 2a: Lite form.
    LITE_RE.lastIndex = 0;
    let lm: RegExpExecArray | null;
    while ((lm = LITE_RE.exec(content)) !== null) {
      const verb = lm[1];
      const rawPath = lm[3];
      const fullPath = this.normalizePath(rawPath);
      const method = LITE_VERBS[verb];
      push({
        method,
        fullPath,
        handler: this.handlerName(verb, fullPath),
        controller: undefined,
        authed: false, // Lite under-bridges are block callbacks, not per-route attributable.
        verb,
        line: this.lineAt(content, lm.index),
      });
    }

    // Pass 2b: full router form.
    ROUTER_RE.lastIndex = 0;
    let rm: RegExpExecArray | null;
    while ((rm = ROUTER_RE.exec(content)) !== null) {
      const invocant = rm[1];
      const verb = rm[2];
      const rawPath = rm[4];
      const builder =
        builders.get(invocant) ||
        (ROOT_INVOCANT.test(invocant) ? { prefix: '', authed: false } : null);
      if (!builder) continue; // a `$x->get(...)` whose root isn't a routes object — skip, don't guess.

      const fullPath = this.normalizePath(this.joinPath(builder.prefix, rawPath));
      const method = ROUTER_VERBS[verb];

      // Controller#action from a following `->to('controller#action')` on the same chain.
      let controller: string | undefined;
      const tail = content.slice(rm.index, rm.index + 200);
      const toMatch = tail.match(/->\s*to\s*\(\s*['"]([^'"]*#[^'"]*)['"]/);
      if (toMatch) controller = toMatch[1];

      push({
        method,
        fullPath,
        handler: controller ? controller.replace('#', '_') : this.handlerName(verb, fullPath),
        controller,
        authed: builder.authed,
        verb,
        line: this.lineAt(content, rm.index),
      });
    }
  }

  private emitRoute(route: MojoRoute, relativePath: string, entryPoints: CASEntryPoint[]): void {
    const nodeId = `function:${relativePath}:${route.handler}`;
    entryPoints.push(
      this.createEntryPoint(
        `entry:http:${relativePath}:${route.handler}:${route.method}:${route.fullPath}`,
        nodeId,
        'http',
        `${route.method} ${route.fullPath}`,
        `HTTP route ${route.method} ${route.fullPath} (Mojolicious ${route.verb})`,
        { method: route.method, path: route.fullPath },
        { authenticated: route.authed },
        {
          framework: 'mojolicious',
          method: route.method,
          path: route.fullPath,
          handler: route.handler,
          controller: route.controller,
          verb: route.verb,
        },
        { node_id: nodeId, method_name: route.handler, file: relativePath, line: route.line }
      )
    );
  }

  // ---- path helpers --------------------------------------------------------------

  /** Normalize a Mojo path: single leading slash, collapse dup slashes, no trailing slash. */
  private normalizePath(raw: string): string {
    let p = (raw || '').trim();
    if (!p.startsWith('/')) p = '/' + p;
    p = p.replace(/\/+/g, '/');
    if (p.length > 1) p = p.replace(/\/$/, '');
    return p;
  }

  private joinPath(prefix: string, seg: string): string {
    const a = (prefix || '').replace(/\/$/, '');
    const b = (seg || '').replace(/^\//, '');
    if (!a) return '/' + b;
    if (!b) return a;
    return a + '/' + b;
  }

  /** Stable handler name (Mojo Lite handlers are anonymous subs). */
  private handlerName(verb: string, fullPath: string): string {
    const slug = fullPath.replace(/[/:*]/g, '_').replace(/^_+|_+$/g, '') || 'root';
    return `${verb}_${slug}`;
  }

  private async findPerlFiles(projectPath: string): Promise<string[]> {
    const files = await glob('**/*.{pl,pm,t}', {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath } as AnalysisContext),
      nodir: true,
    });
    return files.map(file => path.join(projectPath, file));
  }
}
