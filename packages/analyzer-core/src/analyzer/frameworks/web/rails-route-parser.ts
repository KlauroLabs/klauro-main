export interface RailsRoute {
  method: string;
  path: string;
  controller: string;
  action: string;
  source: 'resources' | 'resource' | 'verb' | 'root';
}

interface RailsRouteScope {
  path: string;
  module: string;
}

const RESTFUL_ACTIONS = [
  { action: 'index', method: 'GET', suffix: '' },
  { action: 'create', method: 'POST', suffix: '' },
  { action: 'new', method: 'GET', suffix: '/new' },
  { action: 'edit', method: 'GET', suffix: '/:id/edit' },
  { action: 'show', method: 'GET', suffix: '/:id' },
  { action: 'update', method: 'PATCH', suffix: '/:id' },
  { action: 'destroy', method: 'DELETE', suffix: '/:id' },
];

const SINGULAR_ACTIONS = [
  { action: 'show', method: 'GET', suffix: '' },
  { action: 'create', method: 'POST', suffix: '' },
  { action: 'new', method: 'GET', suffix: '/new' },
  { action: 'edit', method: 'GET', suffix: '/edit' },
  { action: 'update', method: 'PATCH', suffix: '' },
  { action: 'destroy', method: 'DELETE', suffix: '' },
];

const TRAILING_DO = /\bdo\s*$/;

export function extractRailsRoutes(content: string): RailsRoute[] {
  const routes: RailsRoute[] = [];
  const scopeStack: RailsRouteScope[] = [];
  const blockStack: Array<'scope' | 'other'> = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^end\b/.test(line)) {
      if (blockStack.pop() === 'scope') scopeStack.pop();
      continue;
    }
    const namespace = line.match(/^namespace\s+:(\w+)\s+do\b/);
    if (namespace) {
      scopeStack.push({ path: namespace[1], module: namespace[1] });
      blockStack.push('scope');
      continue;
    }
    const scope = extractRouteScope(line);
    if (scope) {
      scopeStack.push(scope);
      blockStack.push('scope');
      continue;
    }
    const pathPrefix = joinScope(scopeStack.map(item => item.path), true);
    const controllerPrefix = joinScope(scopeStack.map(item => item.module), false);
    const resources = line.match(/^resources\s+:(\w+)(.*)$/);
    if (resources) {
      emitResources(routes, resources[1], resources[2] || '', pathPrefix, controllerPrefix, false);
      if (TRAILING_DO.test(line)) blockStack.push('other');
      continue;
    }
    const resource = line.match(/^resource\s+:(\w+)(.*)$/);
    if (resource) {
      emitResources(routes, resource[1], resource[2] || '', pathPrefix, controllerPrefix, true);
      if (TRAILING_DO.test(line)) blockStack.push('other');
      continue;
    }
    const root = line.match(/^root\s+(?:to:\s*)?['"]([\w\/]+)#(\w+)['"]/);
    if (root) {
      routes.push({ method: 'GET', path: pathPrefix || '/', controller: `${controllerPrefix}${root[1]}`, action: root[2], source: 'root' });
      continue;
    }
    const verb = line.match(/^(get|post|put|patch|delete)\s+['"]([^'"]+)['"]\s*(?:,\s*to:\s*|\s*=>\s*)['"]([\w\/]+)#(\w+)['"]/);
    if (verb) {
      const routePath = verb[2].startsWith('/') ? verb[2] : `/${verb[2]}`;
      routes.push({ method: verb[1].toUpperCase(), path: `${pathPrefix}${routePath}`, controller: `${controllerPrefix}${verb[3]}`, action: verb[4], source: 'verb' });
      continue;
    }
    if (TRAILING_DO.test(line)) blockStack.push('other');
  }
  return routes;
}

function emitResources(routes: RailsRoute[], resource: string, options: string, pathPrefix: string, controllerPrefix: string, singular: boolean): void {
  const only = extractSymbolList(options, 'only');
  const except = extractSymbolList(options, 'except');
  const controller = `${controllerPrefix}${singular ? pluralize(resource) : resource}`;
  for (const item of singular ? SINGULAR_ACTIONS : RESTFUL_ACTIONS) {
    if ((only.length && !only.includes(item.action)) || except.includes(item.action)) continue;
    routes.push({ method: item.method, path: `${pathPrefix}/${resource}${item.suffix}`, controller, action: item.action, source: singular ? 'resource' : 'resources' });
    if (!singular && item.action === 'update') routes.push({ method: 'PUT', path: `${pathPrefix}/${resource}${item.suffix}`, controller, action: item.action, source: 'resources' });
  }
}

function extractRouteScope(line: string): RailsRouteScope | undefined {
  if (!/^scope\b/.test(line) || !TRAILING_DO.test(line)) return undefined;
  const positional = line.match(/^scope\s+(?:['"]([^'"]+)['"]|:(\w+))/);
  const pathOption = line.match(/\bpath:\s*(?:['"]([^'"]*)['"]|:(\w+))/);
  const moduleOption = line.match(/\bmodule:\s*(?:['"]([^'"]*)['"]|:(\w+))/);
  return {
    path: normalizeSegment(pathOption?.[1] || pathOption?.[2] || positional?.[1] || positional?.[2] || ''),
    module: normalizeSegment(moduleOption?.[1] || moduleOption?.[2] || '')
  };
}

function extractSymbolList(options: string, key: string): string[] {
  const match = options.match(new RegExp(`${key}:\\s*(?:%i\\[([^\\]]*)\\]|\\[([^\\]]*)\\])`));
  if (!match) return [];
  return match[1] !== undefined ? match[1].split(/\s+/).filter(Boolean) : (match[2].match(/:(\w+)/g) || []).map(symbol => symbol.slice(1));
}

function joinScope(parts: string[], pathPrefix: boolean): string {
  const value = parts.filter(Boolean).join('/');
  return value ? `${pathPrefix ? '/' : ''}${value}${pathPrefix ? '' : '/'}` : '';
}

function normalizeSegment(value: string): string {
  return value.replace(/^\/+|\/+$/g, '');
}

function pluralize(value: string): string {
  if (/y$/.test(value) && !/[aeiou]y$/.test(value)) return value.replace(/y$/, 'ies');
  return /(s|x|ch|sh)$/.test(value) ? `${value}es` : `${value}s`;
}
