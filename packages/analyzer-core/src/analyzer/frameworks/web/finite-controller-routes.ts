export interface ControllerRouteSource {
  relativePath: string;
  content: string;
}

export interface FiniteControllerRoute {
  method: string;
  path: string;
  handler: string;
  handlerFile: string;
  middleware: string[];
}

export interface FiniteControllerRouter {
  name: string;
  filePath: string;
  prefix?: string;
  routes: FiniteControllerRoute[];
}

interface RouteTemplate {
  method: string;
  pathExpression: string;
}

export function extractFiniteControllerRouters(sources: ControllerRouteSource[]): FiniteControllerRouter[] {
  const templates = sources.flatMap(source => extractRouteTemplates(source.content));
  if (templates.length === 0) return [];
  const routers: FiniteControllerRouter[] = [];
  for (const source of sources) {
    const exportedFunctions = exportedFunctionNames(source.content);
    if (exportedFunctions.length === 0) continue;
    const name = exportedString(source.content, 'name') || controllerNameFromPath(source.relativePath);
    const prefix = exportedString(source.content, 'prefix');
    const middleware = /\bexports\.before\s*=\s*(?:async\s+)?function\b/.test(source.content) ? ['before'] : [];
    const routes = exportedFunctions.flatMap(handler => {
      const template = templates.find(candidate => candidate.handler === handler);
      if (!template) return [];
      const routePath = evaluateRouteExpression(template.pathExpression, name);
      if (routePath === undefined) return [];
      return [{
        method: template.method,
        path: routePath,
        handler,
        handlerFile: source.relativePath,
        middleware,
      }];
    });
    if (routes.length > 0) routers.push({ name, filePath: source.relativePath, prefix, routes });
  }
  return routers;
}

function extractRouteTemplates(content: string): Array<RouteTemplate & { handler: string }> {
  const iterator = content.match(/\bfor\s*\(\s*(?:var|let|const)\s+(\w+)\s+in\s+(\w+)\s*\)/);
  if (!iterator) return [];
  const [, keyName, objectName] = iterator;
  if (!new RegExp(`\\bswitch\\s*\\(\\s*${keyName}\\s*\\)`).test(content)) return [];
  if (!new RegExp(`\\w+\\s*\\[\\s*\\w+\\s*\\]\\s*\\(`).test(content)) return [];
  if (!new RegExp(`\\bhandler\\s*=\\s*${objectName}\\s*\\[\\s*${keyName}\\s*\\]`).test(content)) return [];

  const templates: Array<RouteTemplate & { handler: string }> = [];
  const cases = /\bcase\s+['"]([^'"]+)['"]\s*:\s*([\s\S]*?)(?=\bcase\s+['"]|\bdefault\s*:|\n\s*\})/g;
  let match: RegExpExecArray | null;
  while ((match = cases.exec(content)) !== null) {
    const method = match[2].match(/\bmethod\s*=\s*['"](get|post|put|delete|patch|head|options)['"]/)?.[1];
    const pathExpression = match[2].match(/\burl\s*=\s*([^;]+);/)?.[1]?.trim();
    if (method && pathExpression) templates.push({ handler: match[1], method, pathExpression });
  }
  return templates;
}

function exportedFunctionNames(content: string): string[] {
  const names: string[] = [];
  const pattern = /\bexports\.(\w+)\s*=\s*(?:async\s+)?function\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    if (match[1] !== 'before') names.push(match[1]);
  }
  return names;
}

function exportedString(content: string, property: string): string | undefined {
  return content.match(new RegExp(`\\bexports\\.${property}\\s*=\\s*['"]([^'"]+)['"]`))?.[1];
}

function controllerNameFromPath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  const file = parts[parts.length - 1].replace(/\.[^.]+$/, '');
  return file === 'index' && parts.length > 1 ? parts[parts.length - 2] : file;
}

function evaluateRouteExpression(expression: string, controllerName: string): string | undefined {
  const terms = expression.split('+').map(term => term.trim()).filter(Boolean);
  let value = '';
  for (const term of terms) {
    const literal = term.match(/^(['"])([\s\S]*)\1$/);
    if (literal) {
      value += literal[2];
      continue;
    }
    if (/^name$/.test(term)) {
      value += controllerName;
      continue;
    }
    return undefined;
  }
  return value.startsWith('/') ? value : `/${value}`;
}
