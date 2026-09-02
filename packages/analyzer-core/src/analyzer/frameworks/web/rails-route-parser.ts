export interface RailsRoute {
  method: string;
  path: string;
  controller: string;
  action: string;
  source: 'resources' | 'resource' | 'verb' | 'root';
  resource?: string;
  restAction?: string;
  routeRole?: 'collection-read' | 'member-read' | 'create-form' | 'update-form' | 'mutation';
}

interface RailsRouteScope {
  path: string;
  module: string;
  resource?: string;
  controller?: string;
  singular?: boolean;
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
  const blockStack: Array<'scope' | 'member' | 'collection' | 'other'> = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^end\b/.test(line)) {
      const closedBlock = blockStack.pop();
      if (closedBlock === 'scope') scopeStack.pop();
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
    const actionBlock = [...blockStack].reverse().find(block => block === 'member' || block === 'collection');
    const actionScope = line.match(/^(member|collection)\s+do\b/);
    if (actionScope) {
      blockStack.push(actionScope[1] as 'member' | 'collection');
      continue;
    }
    const pathPrefix = joinScope(scopeStack.map(item => item.path), true);
    const controllerPrefix = joinScope(scopeStack.map(item => item.module), false);
    const resources = line.match(/^resources\s+:(\w+)(.*)$/);
    if (resources) {
      emitResources(routes, resources[1], resources[2] || '', pathPrefix, controllerPrefix, false);
      if (TRAILING_DO.test(line)) {
        scopeStack.push(resourceBlockScope(resources[1], resources[2] || '', false));
        blockStack.push('scope');
      }
      continue;
    }
    const resource = line.match(/^resource\s+:(\w+)(.*)$/);
    if (resource) {
      emitResources(routes, resource[1], resource[2] || '', pathPrefix, controllerPrefix, true);
      if (TRAILING_DO.test(line)) {
        scopeStack.push(resourceBlockScope(resource[1], resource[2] || '', true));
        blockStack.push('scope');
      }
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
    const symbolicVerb = line.match(/^(get|post|put|patch|delete)\s+:(\w+)(.*)$/);
    const resourceScope = [...scopeStack].reverse().find(item => item.resource && item.controller);
    if (symbolicVerb && resourceScope) {
      const explicitScope = symbolicVerb[3].match(/\bon:\s*:(member|collection)/)?.[1];
      const routeScope = explicitScope || actionBlock;
      let actionPathPrefix = pathPrefix;
      if (!resourceScope.singular) {
        const nestedParameter = `/:${singularize(resourceScope.resource!)}_id`;
        if (routeScope === 'member' && actionPathPrefix.endsWith(nestedParameter)) {
          actionPathPrefix = `${actionPathPrefix.slice(0, -nestedParameter.length)}/:id`;
        } else if (routeScope === 'collection' && actionPathPrefix.endsWith(nestedParameter)) {
          actionPathPrefix = actionPathPrefix.slice(0, -nestedParameter.length);
        }
      }
      routes.push({
        method: symbolicVerb[1].toUpperCase(),
        path: `${actionPathPrefix}/${symbolicVerb[2]}`,
        controller: `${controllerPrefix}${resourceScope.controller}`,
        action: symbolicVerb[2],
        source: 'verb',
        resource: resourceScope.resource,
        routeRole: 'mutation',
      });
      continue;
    }
    if (TRAILING_DO.test(line)) blockStack.push('other');
  }
  return routes;
}

function emitResources(routes: RailsRoute[], resource: string, options: string, pathPrefix: string, controllerPrefix: string, singular: boolean): void {
  const only = extractSymbolList(options, 'only');
  const except = extractSymbolList(options, 'except');
  const controllerOption = options.match(/\bcontroller:\s*(?:['"]([^'"]+)['"]|:(\w+))/);
  const moduleOption = options.match(/\bmodule:\s*(?:['"]([^'"]+)['"]|:(\w+))/);
  const localModule = normalizeSegment(moduleOption?.[1] || moduleOption?.[2] || '');
  const routePath = extractStringOrSymbolOption(options, 'path') || resource;
  const controllerName = normalizeSegment(controllerOption?.[1] || controllerOption?.[2] || (singular ? pluralize(resource) : resource));
  const controller = `${controllerPrefix}${localModule ? `${localModule}/` : ''}${controllerName}`;
  for (const item of singular ? SINGULAR_ACTIONS : RESTFUL_ACTIONS) {
    if ((only.length && !only.includes(item.action)) || except.includes(item.action)) continue;
    const routeRole: NonNullable<RailsRoute['routeRole']> = item.action === 'index' ? 'collection-read'
      : item.action === 'show' ? 'member-read'
        : item.action === 'new' ? 'create-form'
          : item.action === 'edit' ? 'update-form'
            : 'mutation';
    const route = {
      method: item.method, path: `${pathPrefix}/${routePath}${item.suffix}`, controller, action: item.action,
      source: singular ? 'resource' as const : 'resources' as const,
      resource, restAction: item.action, routeRole,
    };
    routes.push(route);
    if (!singular && item.action === 'update') routes.push({ ...route, method: 'PUT' });
  }
}

function resourceBlockScope(resource: string, options: string, singular: boolean): RailsRouteScope {
  const routePath = extractStringOrSymbolOption(options, 'path') || resource;
  const localModule = extractStringOrSymbolOption(options, 'module');
  const explicitController = extractStringOrSymbolOption(options, 'controller');
  return {
    path: singular ? routePath : `${routePath}/:${singularize(resource)}_id`,
    module: localModule,
    resource,
    controller: explicitController || (singular ? pluralize(resource) : resource),
    singular,
  };
}

function extractStringOrSymbolOption(options: string, key: string): string {
  const match = options.match(new RegExp(`\\b${key}:\\s*(?:['"]([^'"]*)['"]|:(\\w+))`));
  return normalizeSegment(match?.[1] || match?.[2] || '');
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
  const match = options.match(new RegExp(`${key}:\\s*(?:%i\\[([^\\]]*)\\]|\\[([^\\]]*)\\]|:(\\w+))`));
  if (!match) return [];
  if (match[1] !== undefined) return match[1].split(/\s+/).filter(Boolean);
  if (match[2] !== undefined) return (match[2].match(/:(\w+)/g) || []).map(symbol => symbol.slice(1));
  return [match[3]];
}

function joinScope(parts: string[], pathPrefix: boolean): string {
  const value = parts.filter(Boolean).join('/');
  return value ? `${pathPrefix ? '/' : ''}${value}${pathPrefix ? '' : '/'}` : '';
}

function normalizeSegment(value: string): string {
  return value.replace(/^\/+|\/+$/g, '');
}

function singularize(value: string): string {
  if (/ies$/.test(value)) return value.replace(/ies$/, 'y');
  if (/(?:ches|shes|xes)$/.test(value)) return value.replace(/es$/, '');
  return /s$/.test(value) ? value.slice(0, -1) : value;
}

function pluralize(value: string): string {
  if (/[^s]s$/.test(value) && !/(?:us|ss)$/.test(value)) return value;
  if (/y$/.test(value) && !/[aeiou]y$/.test(value)) return value.replace(/y$/, 'ies');
  return /(s|x|ch|sh)$/.test(value) ? `${value}es` : `${value}s`;
}
