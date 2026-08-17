import { AnalysisContext, BaseAnalyzer, FileAnalysisContext, FileAnalysisResult } from '../core/base-analyzer';
import { CASEdge, CASEntryPoint, CASExitPoint, CASNode } from '../../types/cas.types';
import * as fs from 'fs-extra';
import * as path from 'path';
import { cachedGlob as glob } from '../core/glob-cache';
import * as yaml from 'js-yaml';

























interface ProxyRoute {

  host?: string;

  matchPath?: string;

  listenPorts: string[];

  upstream?: string;

  directive: string;
  line: number;
}


interface ProxyUpstream {
  name: string;
  servers: string[];
  line: number;
}

interface ProxyConfig {
  routes: ProxyRoute[];
  upstreams: ProxyUpstream[];
}






abstract class ReverseProxyAnalyzer extends BaseAnalyzer {

  protected static readonly SURFACE = 'reverse-proxy';

  supportsIncrementalAnalysis(): boolean {
    return true;
  }


  protected abstract dialect(): string;


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



      const resolvedPool = target ? resolvePool(target, upstreams) : undefined;
      const resolvedUpstreamNodeId = resolvedPool ? upstreamNodeIdByName.get(resolvedPool.name) : undefined;


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




          deployment_service_name: proxiedService,
          service_aliases: dedupe([proxiedService, target, ...(route.host ? [route.host] : [])].filter(Boolean) as string[]),
          ports: targetPort ? [targetPort] : [],
          subcategories: ['reverse-proxy', 'public-route'],
        }
      ));





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
      '**/nginx/**/*.conf.template',
    ]);
  }

  protected parseConfig(content: string): ProxyConfig {
    return parseNginx(content);
  }
}





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










function parseCaddyfile(content: string): ProxyConfig {
  const lines = content.split(/\r?\n/);
  const routes: ProxyRoute[] = [];
  const upstreams: ProxyUpstream[] = [];

  let currentHost: string | undefined;
  let currentPort: string | undefined;
  let currentHandlePath: string | undefined;
  let depth = 0;
  let inGlobalBlock = false;
  let pendingReverseProxy: {
    host?: string;
    matchPath?: string;
    listenPorts: string[];
    line: number;
    depth: number;
    upstream?: string;
    name?: string;
    port?: string;
  } | undefined;

  const emitPendingReverseProxy = () => {
    if (!pendingReverseProxy) return;
    const upstream = pendingReverseProxy.upstream || (pendingReverseProxy.name
      ? `${pendingReverseProxy.name}${pendingReverseProxy.port ? `:${pendingReverseProxy.port}` : ''}`
      : undefined);
    if (upstream) {
      routes.push({
        host: pendingReverseProxy.host,
        matchPath: pendingReverseProxy.matchPath,
        listenPorts: pendingReverseProxy.listenPorts,
        upstream,
        directive: 'reverse_proxy',
        line: pendingReverseProxy.line,
      });
    }
    pendingReverseProxy = undefined;
  };

  lines.forEach((raw, index) => {
    const line = stripCaddyComment(raw).trim();
    if (!line) return;
    const lineNo = index + 1;



    const blockHeader = line.match(/^([^\s{][^{]*?)\s*\{$/);
    if (depth === 0 && blockHeader) {
      const addr = blockHeader[1].trim();

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
    const unbracedAddress = depth === 0 ? parseUnbracedCaddyAddress(line) : undefined;
    if (unbracedAddress) {
      currentHost = unbracedAddress.host;
      currentPort = unbracedAddress.port;
      currentHandlePath = undefined;
      return;
    }
    if (/^reverse_proxy\s*\{$/.test(line) && (currentHost !== undefined || currentPort)) {
      depth++;
      pendingReverseProxy = {
        host: currentHost,
        matchPath: currentHandlePath,
        listenPorts: currentPort ? [currentPort] : inferSchemePorts(currentHost),
        line: lineNo,
        depth,
      };
      return;
    }
    if (line.endsWith('{')) {

      const handleMatch = line.match(/^(handle_path|handle|route)\s+([^\s{]+)\s*\{$/);
      if (handleMatch) currentHandlePath = handleMatch[2];
      depth++;
      return;
    }
    if (line === '}') {
      if (pendingReverseProxy && depth === pendingReverseProxy.depth) emitPendingReverseProxy();
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

    if (pendingReverseProxy) {
      const name = line.match(/^name\s+([^\s{]+)/)?.[1];
      const port = line.match(/^port\s+(\d+)/)?.[1];
      const target = line.match(/^(?:to|upstream)\s+([^\s{]+)/)?.[1];
      if (name) pendingReverseProxy.name = name;
      if (port) pendingReverseProxy.port = port;
      if (target) pendingReverseProxy.upstream = target;
      return;
    }


    const rp = line.match(/^reverse_proxy\s+(.+)$/);
    if (rp && (currentHost !== undefined || currentPort)) {
      const args = rp![1].trim().split(/\s+/).filter(Boolean);

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

  const first = addr.split(',')[0].trim().replace(/^https?:\/\//, '');
  if (first.startsWith(':')) return { host: undefined, port: first.slice(1) };
  const portMatch = first.match(/^(.+?):(\d+)$/);
  if (portMatch) return { host: portMatch[1], port: portMatch[2] };
  return { host: first || undefined };
}

function parseUnbracedCaddyAddress(line: string): { host?: string; port?: string } | undefined {
  const address = '(?:https?://)?(?:\\*\\.)?[A-Za-z0-9_.-]+(?::\\d+)?|:\\d+';
  if (!new RegExp(`^(?:${address})(?:\\s*,\\s*(?:${address}))*$`).test(line)) return undefined;
  return parseCaddyAddress(line);
}

function stripCaddyComment(line: string): string {

  return line.replace(/(^|\s)#.*$/, '$1');
}







function parseNginx(content: string): ProxyConfig {
  const lines = content.split(/\r?\n/);
  const routes: ProxyRoute[] = [];
  const upstreams: ProxyUpstream[] = [];

  interface ServerScope { hosts: string[]; ports: string[]; startLine: number; routeCount: number; }
  const serverStack: ServerScope[] = [];
  let currentUpstream: ProxyUpstream | null = null;
  const locationStack: Array<{ path?: string; startLine: number; routeCount: number }> = [];
  const blockKindStack: Array<'server' | 'location' | 'upstream' | 'other'> = [];

  lines.forEach((raw, index) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    const lineNo = index + 1;


    const upstreamOpen = line.match(/^upstream\s+([A-Za-z0-9_.-]+)\s*\{?/);
    if (upstreamOpen && line.includes('{')) {
      currentUpstream = { name: upstreamOpen[1], servers: [], line: lineNo };
      blockKindStack.push('upstream');
      return;
    }
    if (/^server\s*\{/.test(line)) {
      serverStack.push({ hosts: [], ports: [], startLine: lineNo, routeCount: 0 });
      blockKindStack.push('server');
      return;
    }
    const locationOpen = line.match(/^location\s+(.+?)\s*\{/);
    if (locationOpen) {
      locationStack.push({ path: normalizeNginxLocation(locationOpen[1]), startLine: lineNo, routeCount: 0 });
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
        const closedLocation = locationStack.pop();
        const server = serverStack[serverStack.length - 1];
        if (closedLocation && closedLocation.routeCount === 0) {
          routes.push({
            host: server?.hosts[0],
            matchPath: closedLocation.path,
            listenPorts: server ? dedupe(server.ports) : [],
            directive: 'serve_static',
            line: closedLocation.startLine,
          });
          if (server) server.routeCount++;
        }
      } else if (kind === 'server') {
        const closedServer = serverStack.pop();
        if (closedServer && closedServer.routeCount === 0) {
          routes.push({
            host: closedServer.hosts[0],
            matchPath: '/',
            listenPorts: dedupe(closedServer.ports),
            directive: 'serve_static',
            line: closedServer.startLine,
          });
        }
      }
      return;
    }


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
      if (scope) scope.routeCount++;
      if (location) location.routeCount++;
      return;
    }
  });

  return { routes, upstreams };
}

function normalizeNginxLocation(raw: string): string {

  return raw.replace(/^(=|~\*?|\^~)\s*/, '').trim();
}





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
  if (doc.services && typeof doc.services === 'object') {
    return parseTraefikCompose(doc.services, lineLookup);
  }

  const entryPointPorts = collectTraefikEntryPointPorts(doc.entryPoints);
  const http = (doc.http && typeof doc.http === 'object') ? doc.http : doc;
  const services = (http.services && typeof http.services === 'object') ? http.services : undefined;
  const routers = (http.routers && typeof http.routers === 'object') ? http.routers : undefined;


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

function parseTraefikCompose(services: Record<string, any>, lines: string[]): ProxyConfig {
  const routes: ProxyRoute[] = [];
  const upstreams: ProxyUpstream[] = [];
  const entryPointPorts = new Map<string, string>();

  for (const service of Object.values<any>(services)) {
    for (const command of toStringArray(service?.command)) {
      const match = command.match(/^--entrypoints\.([^.]+)\.address=.*:(\d+)$/i);
      if (match) entryPointPorts.set(match[1], match[2]);
    }
  }

  for (const [serviceName, service] of Object.entries<any>(services)) {
    const labels = normalizeTraefikLabels(service?.labels);
    const routers = new Map<string, Record<string, string>>();
    const declaredServicePorts = new Map<string, string>();

    for (const [key, value] of labels) {
      const router = key.match(/^traefik\.http\.routers\.([^.]+)\.(.+)$/i);
      if (router) {
        const fields = routers.get(router[1]) || {};
        fields[router[2].toLowerCase()] = value;
        routers.set(router[1], fields);
      }
      const servicePort = key.match(/^traefik\.http\.services\.([^.]+)\.loadbalancer\.server\.port$/i);
      if (servicePort) declaredServicePorts.set(servicePort[1], value);
    }

    for (const [routerName, fields] of routers) {
      const rule = fields.rule;
      const targetName = fields.service || serviceName;
      const targetService = services[targetName] || service;
      const targetPort = declaredServicePorts.get(targetName) || firstComposeServicePort(targetService);
      const upstream = targetPort ? `http://${targetName}:${targetPort}` : `http://${targetName}`;
      const entryPoints = (fields.entrypoints || '').split(',').map(value => value.trim()).filter(Boolean);
      const route: ProxyRoute = {
        host: rule ? extractTraefikRuleValue(rule, 'Host') : undefined,
        matchPath: rule ? extractTraefikRuleValue(rule, 'PathPrefix') || extractTraefikRuleValue(rule, 'Path') : undefined,
        listenPorts: dedupe(entryPoints.map(name => entryPointPorts.get(name)).filter(Boolean) as string[]),
        upstream,
        directive: 'traefik-docker-router',
        line: findTraefikLabelLine(lines, routerName),
      };
      routes.push(route);
      upstreams.push({ name: targetName, servers: [upstream], line: route.line });
    }
  }

  return { routes, upstreams: dedupeProxyUpstreams(upstreams) };
}

function normalizeTraefikLabels(value: unknown): Array<[string, string]> {
  if (Array.isArray(value)) {
    return value.flatMap(item => {
      if (typeof item !== 'string') return [];
      const separator = item.indexOf('=');
      return separator === -1 ? [] : [[item.slice(0, separator), item.slice(separator + 1)]];
    });
  }
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string | number | boolean] => ['string', 'number', 'boolean'].includes(typeof entry[1]))
    .map(([key, item]) => [key, String(item)]);
}

function firstComposeServicePort(service: any): string | undefined {
  const candidates = [...toStringArray(service?.expose), ...toStringArray(service?.ports)];
  for (const candidate of candidates) {
    const normalized = candidate.replace(/\/(?:tcp|udp)$/i, '').split(':').pop()?.trim();
    if (/^\d+$/.test(normalized || '')) return normalized;
  }
  return undefined;
}

function findTraefikLabelLine(lines: string[], routerName: string): number {
  const needle = `traefik.http.routers.${routerName}.`;
  const index = lines.findIndex(line => line.includes(needle));
  return index === -1 ? 1 : index + 1;
}

function dedupeProxyUpstreams(upstreams: ProxyUpstream[]): ProxyUpstream[] {
  const byName = new Map<string, ProxyUpstream>();
  for (const upstream of upstreams) byName.set(upstream.name, upstream);
  return [...byName.values()];
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






function routeLabel(route: ProxyRoute): string {
  const host = route.host || (route.listenPorts.length ? `:${route.listenPorts[0]}` : 'route');
  return route.matchPath && route.matchPath !== '/' ? `${host}${route.matchPath}` : host;
}


function hostOf(target: string): string | undefined {
  const cleaned = target.replace(/^(https?|balancer|unix):\/\//, '').replace(/\/.*$/, '');
  const host = cleaned.replace(/:\d+$/, '').trim();
  return host || undefined;
}




function serviceNameOf(target: string, upstreams: ProxyUpstream[]): string | undefined {
  const pool = resolvePool(target, upstreams);
  if (pool) return pool.name;
  return hostOf(target);
}



function resolvePool(target: string, upstreams: ProxyUpstream[]): ProxyUpstream | undefined {
  const host = hostOf(target);
  return upstreams.find(u => u.name === target || u.name === host);
}


function extractPort(target: string): string | undefined {
  const cleaned = target.replace(/^(https?|balancer|unix):\/\//, '').replace(/\/.*$/, '');
  const match = cleaned.match(/:(\d{2,5})$/);
  return match?.[1];
}


function upstreamPort(target: string, upstreams: ProxyUpstream[]): string | undefined {
  const pool = resolvePool(target, upstreams);
  const first = pool?.servers[0];
  return first ? extractPort(first) : undefined;
}


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
