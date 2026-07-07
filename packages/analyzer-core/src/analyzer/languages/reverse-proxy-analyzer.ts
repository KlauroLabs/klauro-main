import { AnalysisContext, BaseAnalyzer, FileAnalysisContext, FileAnalysisResult } from '../core/base-analyzer';
import { CASEdge, CASEntryPoint, CASExitPoint, CASNode } from '../../types/cas.types';
import * as fs from 'fs-extra';
import * as path from 'path';
import { cachedGlob as glob } from '../core/glob-cache';
import * as yaml from 'js-yaml';

/**
 * REVERSE-PROXY / WEB-SERVER CONFIG ANALYZERS — the "how public traffic routes
 * to services" layer of infra topology. These parse the checked-in config files
 * that sit in front of the app (Caddy, Nginx, Apache, HAProxy, Traefik) and turn
 * their site/route blocks into topology facts: a PUBLIC host/path that fronts an
 * UPSTREAM target (service name / host:port), plus the upstream pools those
 * targets resolve to.
 *
 * They mirror the container-topology-analyzer siblings exactly — one file, one
 * abstract base with shared file/glob helpers, one concrete analyzer per config
 * dialect, node/edge emission via the same BaseAnalyzer builders. They emit the
 * SAME join vocabulary those analyzers use (topology_surface,
 * deployment_service_name, service_aliases, ports) so the infra-topology-linker
 * joins a proxy route's upstream to a known compose/k8s service or a deployable
 * port with no proxy-specific hardcoding — completing the topology edge
 * public URL -> proxy -> service:port -> route -> handler.
 *
 * EVIDENCE-GATED (the cardinal rule): every upstream, port, and route is parsed
 * from a directive actually present in the config — never inferred, never
 * fabricated. A route with no resolvable upstream target still records the
 * public host/path, but no PROXIES_TO edge is asserted without a concrete target.
 */

/** A single parsed public route: a listen/host+path matcher fronting an upstream. */
interface ProxyRoute {
  /** Public host (site address / server_name / router rule host). */
  host?: string;
  /** Path matcher, when the route is path-scoped. */
  matchPath?: string;
  /** Listen port(s) the route is served on. */
  listenPorts: string[];
  /** The upstream target as written (service name, host:port, or upstream pool name). */
  upstream?: string;
  /** Directive kind that produced the route (reverse_proxy, proxy_pass, ProxyPass, …). */
  directive: string;
  line: number;
}

/** A named upstream/backend pool and the concrete servers it balances across. */
interface ProxyUpstream {
  name: string;
  servers: string[];
  line: number;
}

interface ProxyConfig {
  routes: ProxyRoute[];
  upstreams: ProxyUpstream[];
}

/**
 * Shared base for the five reverse-proxy config dialects. Holds the glob/read
 * helpers and the node/edge/entry-point emission that is identical across
 * dialects — each subclass only supplies its file patterns and its parser.
 */
abstract class ReverseProxyAnalyzer extends BaseAnalyzer {
  /** Surface tag every proxy node carries — recognized by the infra linker. */
  protected static readonly SURFACE = 'reverse-proxy';

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  /** Human-readable dialect label used in node names ('Caddy', 'Nginx', …). */
  protected abstract dialect(): string;

  /** Parse one config file's raw text into routes + upstreams. */
  protected abstract parseConfig(content: string, relativeFile: string): ProxyConfig;

  protected async readFiles(projectPath: string, patterns: string[]): Promise<string[]> {
    return glob(patterns, {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true,
      absolute: false,
    });
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    return (await this.getRelevantFiles(projectPath)).length > 0;
  }

  async analyze(context: AnalysisContext) {
    const files = await this.getRelevantFiles(context.projectPath);
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    for (const relativeFile of files) {
      const parsed = await this.analyzeConfigFile(context.projectPath, relativeFile);
      nodes.push(...parsed.nodes);
      edges.push(...parsed.edges);
      entryPoints.push(...parsed.entryPoints);
      exitPoints.push(...parsed.exitPoints);
    }
    return this.createContribution(nodes, edges, entryPoints, exitPoints, {
      topology_surface: ReverseProxyAnalyzer.SURFACE,
      proxy_dialect: this.dialect().toLowerCase(),
      config_files: files.length,
    });
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const parsed = await this.analyzeConfigFile(context.projectPath, context.relativePath);
    const content = await fs.readFile(context.filePath, 'utf8');
    const stat = await fs.stat(context.filePath);
    return this.createFileAnalysisResult(
      context.filePath,
      context.relativePath,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      parsed.nodes,
      parsed.edges,
      parsed.entryPoints,
      parsed.exitPoints,
      [],
      []
    );
  }

  protected getCapabilities(): string[] {
    return ['reverse-proxy-route-topology', 'reverse-proxy-upstream-detection', 'public-traffic-routing'];
  }

  protected getLevelName(level: number): string {
    return level <= 3 ? 'proxy topology' : 'proxy route detail';
  }

  /**
   * Emit topology nodes/edges for one config file. Upstream pools become
   * `upstream` nodes; each public route becomes a `proxy_route` node. Where the
   * route's upstream resolves — to a declared upstream pool OR a bare
   * service:port target — a PROXIES_TO edge is drawn from the route to that
   * target. The route also carries a `proxied_service` on its metadata (the
   * bare service name) so the infra linker can join it to a compose/k8s service.
   */
  private async analyzeConfigFile(projectPath: string, relativeFile: string) {
    const content = await fs.readFile(path.join(projectPath, relativeFile), 'utf8');
    const { routes, upstreams } = this.parseConfig(content, relativeFile);
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    const surface = ReverseProxyAnalyzer.SURFACE;
    const dialect = this.dialect();
    const upstreamNodeIdByName = new Map<string, string>();

    for (const upstream of upstreams) {
      const nodeId = `proxy_upstream_${this.sanitizeId(relativeFile)}_${this.sanitizeId(upstream.name)}`;
      upstreamNodeIdByName.set(upstream.name, nodeId);
      const firstTarget = upstream.servers[0];
      const port = firstTarget ? extractPort(firstTarget) : undefined;
      nodes.push(this.createNode(
        nodeId,
        `${dialect} upstream: ${upstream.name}`,
        'proxy_upstream',
        3,
        relativeFile,
        upstream.line,
        upstream.line,
        {
          topology_surface: surface,
          proxy_dialect: dialect.toLowerCase(),
          deployment_service_name: upstream.name,
          service_aliases: dedupe([upstream.name, ...upstream.servers.map(hostOf).filter(Boolean) as string[]]),
          servers: upstream.servers,
          ports: port ? [port] : [],
          subcategories: ['reverse-proxy', 'upstream-pool'],
        }
      ));
    }

    for (const route of routes) {
      const target = route.upstream;
      // An upstream target may be written with a scheme (`http://ui`) while the
      // declared pool is named `ui` — resolve the pool by the scheme/port/path-
      // stripped host so `proxy_pass http://ui;` binds to `upstream ui { … }`.
      const resolvedPool = target ? resolvePool(target, upstreams) : undefined;
      const resolvedUpstreamNodeId = resolvedPool ? upstreamNodeIdByName.get(resolvedPool.name) : undefined;
      // The bare service name the upstream points at (drop scheme/port) — this is
      // the token the infra linker joins to a compose/k8s service or deployable.
      const proxiedService = target ? serviceNameOf(target, upstreams) : undefined;
      const targetPort = target ? extractPort(target) || upstreamPort(target, upstreams) : undefined;
      const listenPorts = route.listenPorts.length ? route.listenPorts : [];
      const label = routeLabel(route);
      const routeNodeId = `proxy_route_${this.sanitizeId(relativeFile)}_${this.sanitizeId(label)}_${route.line}`;

      nodes.push(this.createNode(
        routeNodeId,
        `${dialect} route: ${label}`,
        'proxy_route',
        3,
        relativeFile,
        route.line,
        route.line,
        {
          topology_surface: surface,
          proxy_dialect: dialect.toLowerCase(),
          public_host: route.host,
          match_path: route.matchPath,
          listen_ports: listenPorts,
          directive: route.directive,
          upstream_target: target,
          proxied_service: proxiedService,
          // Present the resolved upstream as the route's own join identity so the
          // infra linker (which reads deployment_service_name / service_aliases /
          // ports off any topology node) can join this route to the service it
          // fronts without any proxy-specific code.
          deployment_service_name: proxiedService,
          service_aliases: dedupe([proxiedService, target, ...(route.host ? [route.host] : [])].filter(Boolean) as string[]),
          ports: targetPort ? [targetPort] : [],
          subcategories: ['reverse-proxy', 'public-route'],
        }
      ));

      // PROXIES_TO: the public route -> its upstream. Evidence-gated — only drawn
      // when the config names a concrete target (a declared upstream pool, or a
      // bare service:port). A route with no upstream (a static file_server /
      // respond block) records the public host but asserts no edge.
      if (resolvedUpstreamNodeId) {
        edges.push(this.createEdge(
          `edge_proxy_to_${this.sanitizeId(relativeFile)}_${this.sanitizeId(label)}_${route.line}`,
          routeNodeId,
          resolvedUpstreamNodeId,
          'PROXIES_TO',
          'runtime',
          { topology_surface: surface, host: route.host, path: route.matchPath, upstream: target }
        ));
      }

      // A route that fronts a real upstream target is an outbound dependency on
      // that service — record it as an exit point so the dependency is visible
      // even before the infra linker joins it to a first-party deployable.
      if (proxiedService) {
        const endpoint = targetPort ? `http://${proxiedService}:${targetPort}` : `http://${proxiedService}`;
        exitPoints.push(this.createExitPoint(
          `exit_proxy_${this.sanitizeId(relativeFile)}_${this.sanitizeId(label)}_${route.line}`,
          routeNodeId,
          'api',
          `${dialect} proxies ${label} -> ${proxiedService}${targetPort ? `:${targetPort}` : ''}`,
          `${dialect} route ${label} forwards public traffic to ${proxiedService}${targetPort ? ` on port ${targetPort}` : ''}.`,
          { service_id: proxiedService, endpoint, resource: proxiedService },
          { action: 'reverse-proxy', async: false },
          {
            topology_surface: surface,
            proxy_dialect: dialect.toLowerCase(),
            deployment_service_name: proxiedService,
            service_aliases: dedupe([proxiedService, target].filter(Boolean) as string[]),
            port: targetPort,
          }
        ));
      }
    }

    return { nodes, edges, entryPoints, exitPoints };
  }

  abstract getRelevantFiles(projectPath: string): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Caddy
// ---------------------------------------------------------------------------

export class CaddyAnalyzer extends ReverseProxyAnalyzer {
  constructor() {
    super('caddy', 'Caddy Analyzer', '1.0.0', 'language');
  }

  protected dialect(): string {
    return 'Caddy';
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    return this.readFiles(projectPath, ['Caddyfile', '**/Caddyfile', '*.Caddyfile', '**/*.Caddyfile']);
  }

  protected parseConfig(content: string): ProxyConfig {
    return parseCaddyfile(content);
  }
}

// ---------------------------------------------------------------------------
// Nginx
// ---------------------------------------------------------------------------

export class NginxAnalyzer extends ReverseProxyAnalyzer {
  constructor() {
    super('nginx', 'Nginx Analyzer', '1.0.0', 'language');
  }

  protected dialect(): string {
    return 'Nginx';
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    return this.readFiles(projectPath, [
      'nginx.conf',
      '**/nginx.conf',
      '**/sites-available/*',
      '**/sites-enabled/*',
      '**/conf.d/*.conf',
    ]);
  }

  protected parseConfig(content: string): ProxyConfig {
    return parseNginx(content);
  }
}

// ---------------------------------------------------------------------------
// Apache httpd
// ---------------------------------------------------------------------------

export class ApacheAnalyzer extends ReverseProxyAnalyzer {
  constructor() {
    super('apache', 'Apache Analyzer', '1.0.0', 'language');
  }

  protected dialect(): string {
    return 'Apache';
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    return this.readFiles(projectPath, [
      'httpd.conf',
      'apache2.conf',
      '**/httpd.conf',
      '**/apache2.conf',
      '**/sites-available/*.conf',
      '**/conf.d/*.conf',
      '**/.htaccess',
    ]);
  }

  protected parseConfig(content: string): ProxyConfig {
    return parseApache(content);
  }
}

// ---------------------------------------------------------------------------
// HAProxy
// ---------------------------------------------------------------------------

export class HAProxyAnalyzer extends ReverseProxyAnalyzer {
  constructor() {
    super('haproxy', 'HAProxy Analyzer', '1.0.0', 'language');
  }

  protected dialect(): string {
    return 'HAProxy';
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    return this.readFiles(projectPath, ['haproxy.cfg', '**/haproxy.cfg', '**/haproxy/*.cfg']);
  }

  protected parseConfig(content: string): ProxyConfig {
    return parseHAProxy(content);
  }
}

// ---------------------------------------------------------------------------
// Traefik (static + dynamic YAML config)
// ---------------------------------------------------------------------------

export class TraefikAnalyzer extends ReverseProxyAnalyzer {
  constructor() {
    super('traefik', 'Traefik Analyzer', '1.0.0', 'language');
  }

  protected dialect(): string {
    return 'Traefik';
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    return this.readFiles(projectPath, [
      'traefik.yml',
      'traefik.yaml',
      '**/traefik.yml',
      '**/traefik.yaml',
      '**/traefik/*.yml',
      '**/traefik/*.yaml',
      '**/dynamic/*.yml',
      '**/dynamic/*.yaml',
    ]);
  }

  protected parseConfig(content: string): ProxyConfig {
    return parseTraefik(content);
  }
}

// ---------------------------------------------------------------------------
// Parsers — one per dialect, all pure string/YAML functions.
// ---------------------------------------------------------------------------

/**
 * Parse a Caddyfile. Site address blocks (`host { … }`) hold `reverse_proxy
 * <upstream>` directives (and `handle`/`handle_path`/`route` path matchers).
 * The site address optionally carries a `:port` prefix (e.g. `:8080`).
 */
function parseCaddyfile(content: string): ProxyConfig {
  const lines = content.split(/\r?\n/);
  const routes: ProxyRoute[] = [];
  const upstreams: ProxyUpstream[] = [];

  let currentHost: string | undefined;
  let currentPort: string | undefined;
  let currentHandlePath: string | undefined;
  let depth = 0;
  let inGlobalBlock = false;

  lines.forEach((raw, index) => {
    const line = stripCaddyComment(raw).trim();
    if (!line) return;
    const lineNo = index + 1;

    // A site address block header: `host.example.com {` or `:8080 {` or
    // `host, host2 {`. Only recognized at top level (depth 0).
    const blockHeader = line.match(/^([^\s{][^{]*?)\s*\{$/);
    if (depth === 0 && blockHeader) {
      const addr = blockHeader[1].trim();
      // The global options block has no host — its header is a bare `{`.
      const parsed = parseCaddyAddress(addr);
      currentHost = parsed.host;
      currentPort = parsed.port;
      currentHandlePath = undefined;
      depth++;
      return;
    }
    if (depth === 0 && line === '{') {
      inGlobalBlock = true;
      depth++;
      return;
    }
    if (line.endsWith('{')) {
      // Nested directive block (handle, handle_path, route, header, log, tls, @matcher).
      const handleMatch = line.match(/^(handle_path|handle|route)\s+([^\s{]+)\s*\{$/);
      if (handleMatch) currentHandlePath = handleMatch[2];
      depth++;
      return;
    }
    if (line === '}') {
      depth--;
      if (depth <= 0) {
        depth = 0;
        currentHost = undefined;
        currentPort = undefined;
        currentHandlePath = undefined;
        inGlobalBlock = false;
      } else if (depth === 1) {
        currentHandlePath = undefined;
      }
      return;
    }
    if (inGlobalBlock) return;

    // reverse_proxy [matcher] <upstream...>
    const rp = line.match(/^reverse_proxy\s+(.+)$/);
    if (rp && currentHost !== undefined || (rp && currentPort)) {
      const args = rp![1].trim().split(/\s+/).filter(Boolean);
      // First arg may be a path matcher (starts with / or @) — skip it as the path.
      let matchPath = currentHandlePath;
      let rest = args;
      if (args[0] && (args[0].startsWith('/') || args[0].startsWith('@'))) {
        matchPath = args[0].startsWith('/') ? args[0] : matchPath;
        rest = args.slice(1);
      }
      const upstream = rest.find(a => !a.startsWith('{') && !a.startsWith('@'));
      if (upstream) {
        routes.push({
          host: currentHost,
          matchPath,
          listenPorts: currentPort ? [currentPort] : inferSchemePorts(currentHost),
          upstream,
          directive: 'reverse_proxy',
          line: lineNo,
        });
      }
      return;
    }
  });

  return { routes, upstreams };
}

function parseCaddyAddress(addr: string): { host?: string; port?: string } {
  // Take the first address in a comma list; may be `:8080`, `host:8080`, or `host`.
  const first = addr.split(',')[0].trim().replace(/^https?:\/\//, '');
  if (first.startsWith(':')) return { host: undefined, port: first.slice(1) };
  const portMatch = first.match(/^(.+?):(\d+)$/);
  if (portMatch) return { host: portMatch[1], port: portMatch[2] };
  return { host: first || undefined };
}

function stripCaddyComment(line: string): string {
  // A `#` starts a comment only when preceded by whitespace or at line start.
  return line.replace(/(^|\s)#.*$/, '$1');
}

/**
 * Parse an nginx config. `upstream <name> { server <host:port>; }` pools plus
 * `server { listen <port>; server_name <host>; location <path> { proxy_pass
 * <upstream>; } }` blocks. Brace-depth tracked so listen/server_name attach to
 * the enclosing server block and proxy_pass to the enclosing location.
 */
function parseNginx(content: string): ProxyConfig {
  const lines = content.split(/\r?\n/);
  const routes: ProxyRoute[] = [];
  const upstreams: ProxyUpstream[] = [];

  interface ServerScope { hosts: string[]; ports: string[]; }
  const serverStack: ServerScope[] = [];
  let currentUpstream: ProxyUpstream | null = null;
  const locationStack: Array<{ path?: string; startLine: number }> = [];
  const blockKindStack: Array<'server' | 'location' | 'upstream' | 'other'> = [];

  lines.forEach((raw, index) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    const lineNo = index + 1;

    // Open a named block.
    const upstreamOpen = line.match(/^upstream\s+([A-Za-z0-9_.-]+)\s*\{?/);
    if (upstreamOpen && line.includes('{')) {
      currentUpstream = { name: upstreamOpen[1], servers: [], line: lineNo };
      blockKindStack.push('upstream');
      return;
    }
    if (/^server\s*\{/.test(line)) {
      serverStack.push({ hosts: [], ports: [] });
      blockKindStack.push('server');
      return;
    }
    const locationOpen = line.match(/^location\s+(.+?)\s*\{/);
    if (locationOpen) {
      locationStack.push({ path: normalizeNginxLocation(locationOpen[1]), startLine: lineNo });
      blockKindStack.push('location');
      return;
    }
    if (line.endsWith('{')) {
      blockKindStack.push('other');
      return;
    }
    if (line === '}' || line.startsWith('}')) {
      const kind = blockKindStack.pop();
      if (kind === 'upstream' && currentUpstream) {
        upstreams.push(currentUpstream);
        currentUpstream = null;
      } else if (kind === 'location') {
        locationStack.pop();
      } else if (kind === 'server') {
        serverStack.pop();
      }
      return;
    }

    // Directives inside the current innermost blocks.
    if (currentUpstream) {
      const server = line.match(/^server\s+([^\s;]+)/);
      if (server) currentUpstream.servers.push(server[1]);
      return;
    }

    const scope = serverStack[serverStack.length - 1];
    const listen = line.match(/^listen\s+([^;]+);?/);
    if (listen && scope) {
      const port = listen[1].trim().split(/\s+/)[0].replace(/^.*:/, '');
      const digits = port.match(/^\d+$/) ? port : undefined;
      if (digits) scope.ports.push(digits);
      return;
    }
    const serverName = line.match(/^server_name\s+([^;]+);?/);
    if (serverName && scope) {
      for (const host of serverName[1].trim().split(/\s+/)) {
        if (host && host !== '_') scope.hosts.push(host);
      }
      return;
    }
    const proxyPass = line.match(/^proxy_pass\s+([^;]+);?/);
    if (proxyPass) {
      const target = proxyPass[1].trim();
      const location = locationStack[locationStack.length - 1];
      const host = scope?.hosts[0];
      routes.push({
        host,
        matchPath: location?.path,
        listenPorts: scope?.ports?.length ? dedupe(scope.ports) : [],
        upstream: target,
        directive: 'proxy_pass',
        line: lineNo,
      });
      return;
    }
  });

  return { routes, upstreams };
}

function normalizeNginxLocation(raw: string): string {
  // Strip nginx location modifiers (=, ~, ~*, ^~) and surrounding whitespace.
  return raw.replace(/^(=|~\*?|\^~)\s*/, '').trim();
}

/**
 * Parse Apache httpd config. `<VirtualHost *:port>` blocks with `ServerName`,
 * `ProxyPass <path> <url>` / `ProxyPassReverse`, and `RewriteRule`.
 */
function parseApache(content: string): ProxyConfig {
  const lines = content.split(/\r?\n/);
  const routes: ProxyRoute[] = [];

  let currentHost: string | undefined;
  let currentPorts: string[] = [];
  let inVHost = false;

  lines.forEach((raw, index) => {
    const line = raw.replace(/^\s*#.*$/, '').trim();
    if (!line) return;
    const lineNo = index + 1;

    const vhostOpen = line.match(/^<VirtualHost\s+([^>]+)>/i);
    if (vhostOpen) {
      inVHost = true;
      currentHost = undefined;
      currentPorts = vhostOpen[1].trim().split(/\s+/).map(addr => addr.replace(/^.*:/, '')).filter(p => /^\d+$/.test(p));
      return;
    }
    if (/^<\/VirtualHost>/i.test(line)) {
      inVHost = false;
      currentHost = undefined;
      currentPorts = [];
      return;
    }
    const serverName = line.match(/^ServerName\s+(\S+)/i);
    if (serverName) {
      currentHost = serverName[1].replace(/:\d+$/, '');
      return;
    }
    // ProxyPass [path] <url> — path is optional (defaults to /).
    const proxyPass = line.match(/^ProxyPass\s+(\S+)(?:\s+(\S+))?/i);
    if (proxyPass && !/^ProxyPassReverse/i.test(line)) {
      const hasPath = proxyPass[2] !== undefined;
      const matchPath = hasPath ? proxyPass[1] : '/';
      const target = hasPath ? proxyPass[2] : proxyPass[1];
      if (target && /^(https?:\/\/|balancer:\/\/|unix:)/.test(target)) {
        routes.push({
          host: inVHost ? currentHost : undefined,
          matchPath,
          listenPorts: currentPorts.length ? dedupe(currentPorts) : [],
          upstream: target,
          directive: 'ProxyPass',
          line: lineNo,
        });
      }
      return;
    }
  });

  return { routes, upstreams: [] };
}

/**
 * Parse an HAProxy config. `frontend`/`backend` sections with `bind <addr:port>`,
 * `server <name> <host:port>`, `use_backend <name> if <acl>`, `default_backend
 * <name>`. Frontend routes join to backend pools by name.
 */
function parseHAProxy(content: string): ProxyConfig {
  const lines = content.split(/\r?\n/);
  const routes: ProxyRoute[] = [];
  const upstreams: ProxyUpstream[] = [];

  interface Section { kind: 'frontend' | 'backend'; name: string; line: number; }
  let section: Section | null = null;
  let currentFrontendPorts: string[] = [];
  let currentFrontendHost: string | undefined;
  let currentBackend: ProxyUpstream | null = null;
  const pendingRoutes: Array<{ backend: string; host?: string; ports: string[]; line: number }> = [];

  const closeBackend = () => {
    if (currentBackend) {
      upstreams.push(currentBackend);
      currentBackend = null;
    }
  };

  lines.forEach((raw, index) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    const lineNo = index + 1;

    const sectionMatch = line.match(/^(frontend|backend|listen|defaults|global)\s*(\S+)?/);
    if (sectionMatch && /^(frontend|backend|listen|defaults|global)$/.test(sectionMatch[1])) {
      closeBackend();
      const kind = sectionMatch[1];
      if (kind === 'frontend' || kind === 'listen') {
        currentFrontendPorts = [];
        currentFrontendHost = undefined;
        section = { kind: 'frontend', name: sectionMatch[2] || kind, line: lineNo };
      } else if (kind === 'backend') {
        currentBackend = { name: sectionMatch[2] || 'backend', servers: [], line: lineNo };
        section = { kind: 'backend', name: currentBackend.name, line: lineNo };
      } else {
        section = null;
      }
      return;
    }
    if (!section) return;

    if (section.kind === 'frontend') {
      const bind = line.match(/^bind\s+(\S+)/);
      if (bind) {
        const port = bind[1].replace(/^.*:/, '');
        if (/^\d+$/.test(port)) currentFrontendPorts.push(port);
        return;
      }
      const aclHost = line.match(/\bhdr\(host\)\s+-i\s+(\S+)/i) || line.match(/\breq\.hdr\(host\).*?-i\s+(\S+)/i);
      if (aclHost) {
        currentFrontendHost = aclHost[1];
      }
      const useBackend = line.match(/^use_backend\s+(\S+)/);
      const defaultBackend = line.match(/^default_backend\s+(\S+)/);
      const backendName = useBackend?.[1] || defaultBackend?.[1];
      if (backendName) {
        pendingRoutes.push({ backend: backendName, host: currentFrontendHost, ports: dedupe(currentFrontendPorts), line: lineNo });
      }
      return;
    }

    if (section.kind === 'backend' && currentBackend) {
      const server = line.match(/^server\s+\S+\s+([^\s]+)/);
      if (server) currentBackend.servers.push(server[1]);
    }
  });
  closeBackend();

  // Turn each frontend use_backend/default_backend into a route pointing at the
  // named backend pool (the upstream is the backend name; resolved by the node
  // emitter to the pool node).
  for (const pending of pendingRoutes) {
    routes.push({
      host: pending.host,
      listenPorts: pending.ports,
      upstream: pending.backend,
      directive: 'use_backend',
      line: pending.line,
    });
  }

  return { routes, upstreams };
}

/**
 * Parse Traefik config (static traefik.yml + dynamic config). Routers carry a
 * `rule` (Host(`…`) / PathPrefix(`…`)) and a `service`; services carry
 * `loadBalancer.servers[].url`; entrypoints define listen addresses.
 */
function parseTraefik(content: string): ProxyConfig {
  const routes: ProxyRoute[] = [];
  const upstreams: ProxyUpstream[] = [];
  const lineLookup = content.split(/\r?\n/);

  let doc: any;
  try {
    doc = yaml.load(content);
  } catch {
    return { routes, upstreams };
  }
  if (!doc || typeof doc !== 'object') return { routes, upstreams };

  const entryPointPorts = collectTraefikEntryPointPorts(doc.entryPoints);
  const http = (doc.http && typeof doc.http === 'object') ? doc.http : doc;
  const services = (http.services && typeof http.services === 'object') ? http.services : undefined;
  const routers = (http.routers && typeof http.routers === 'object') ? http.routers : undefined;

  // Services -> upstream pools (loadBalancer.servers[].url).
  const serviceTargets = new Map<string, string[]>();
  if (services) {
    for (const [name, raw] of Object.entries<any>(services)) {
      const servers = Array.isArray(raw?.loadBalancer?.servers) ? raw.loadBalancer.servers : [];
      const urls = servers.map((s: any) => typeof s?.url === 'string' ? s.url : undefined).filter(Boolean) as string[];
      if (urls.length) {
        serviceTargets.set(name, urls);
        upstreams.push({ name, servers: urls, line: findTraefikLine(lineLookup, name) });
      }
    }
  }

  if (routers) {
    for (const [name, raw] of Object.entries<any>(routers)) {
      const rule = typeof raw?.rule === 'string' ? raw.rule : undefined;
      const service = typeof raw?.service === 'string' ? raw.service : undefined;
      const host = rule ? extractTraefikRuleValue(rule, 'Host') : undefined;
      const matchPath = rule ? (extractTraefikRuleValue(rule, 'PathPrefix') || extractTraefikRuleValue(rule, 'Path')) : undefined;
      const entryPoints = toStringArray(raw?.entryPoints);
      const ports = dedupe(entryPoints.map(ep => entryPointPorts.get(ep)).filter(Boolean) as string[]);
      // A router points at a service pool; use the first server url as the
      // resolvable target when the service resolves, else the service name.
      const targetUrls = service ? serviceTargets.get(service) : undefined;
      const upstream = targetUrls && targetUrls.length ? targetUrls[0] : service;
      routes.push({
        host,
        matchPath,
        listenPorts: ports,
        upstream,
        directive: 'traefik-router',
        line: findTraefikLine(lineLookup, name),
      });
    }
  }

  return { routes, upstreams };
}

function collectTraefikEntryPointPorts(entryPoints: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!entryPoints || typeof entryPoints !== 'object') return out;
  for (const [name, raw] of Object.entries<any>(entryPoints as Record<string, any>)) {
    const address = typeof raw?.address === 'string' ? raw.address : undefined;
    const port = address ? address.replace(/^.*:/, '').match(/^\d+$/)?.[0] : undefined;
    if (port) out.set(name, port);
  }
  return out;
}

function extractTraefikRuleValue(rule: string, matcher: 'Host' | 'PathPrefix' | 'Path'): string | undefined {
  const match = rule.match(new RegExp(`${matcher}\\(\\s*[\`'"]([^\`'"]+)[\`'"]`));
  return match?.[1];
}

function findTraefikLine(lines: string[], key: string): number {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}:`);
  const index = lines.findIndex(line => pattern.test(line));
  return index === -1 ? 1 : index + 1;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Human label for a route: host+path when available, else the upstream/directive. */
function routeLabel(route: ProxyRoute): string {
  const host = route.host || (route.listenPorts.length ? `:${route.listenPorts[0]}` : 'route');
  return route.matchPath && route.matchPath !== '/' ? `${host}${route.matchPath}` : host;
}

/** Strip scheme + path, return `host` from `http://host:port/path`, `host:port`, or a bare name. */
function hostOf(target: string): string | undefined {
  const cleaned = target.replace(/^(https?|balancer|unix):\/\//, '').replace(/\/.*$/, '');
  const host = cleaned.replace(/:\d+$/, '').trim();
  return host || undefined;
}

/** The service NAME an upstream target resolves to — the bare host with scheme,
 *  port, and path stripped. When the target is a declared upstream-pool name, we
 *  keep the pool name (its own servers carry the concrete host). */
function serviceNameOf(target: string, upstreams: ProxyUpstream[]): string | undefined {
  const pool = resolvePool(target, upstreams);
  if (pool) return pool.name;
  return hostOf(target);
}

/** Resolve a target to a declared pool, matching either the raw target
 *  (`api_servers`) or its scheme/port-stripped host (`http://ui` -> `ui`). */
function resolvePool(target: string, upstreams: ProxyUpstream[]): ProxyUpstream | undefined {
  const host = hostOf(target);
  return upstreams.find(u => u.name === target || u.name === host);
}

/** Extract a port number from a `host:port` / `http://host:port` target. */
function extractPort(target: string): string | undefined {
  const cleaned = target.replace(/^(https?|balancer|unix):\/\//, '').replace(/\/.*$/, '');
  const match = cleaned.match(/:(\d{2,5})$/);
  return match?.[1];
}

/** When the target is a named upstream pool, borrow the port off its first server. */
function upstreamPort(target: string, upstreams: ProxyUpstream[]): string | undefined {
  const pool = resolvePool(target, upstreams);
  const first = pool?.servers[0];
  return first ? extractPort(first) : undefined;
}

/** Default listen ports for a Caddy site with no explicit port (auto-HTTPS). */
function inferSchemePorts(host: string | undefined): string[] {
  if (!host) return [];
  if (/^https?:\/\//.test(host)) return host.startsWith('https') ? ['443'] : ['80'];
  return ['443', '80'];
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') return [value];
  return [];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
