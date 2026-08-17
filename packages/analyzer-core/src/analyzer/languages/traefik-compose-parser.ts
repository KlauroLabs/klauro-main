import type { ProxyConfig, ProxyRoute, ProxyUpstream } from './reverse-proxy-analyzer';

export function parseTraefikCompose(services: Record<string, any>, lines: string[]): ProxyConfig {
  const routes: ProxyRoute[] = [];
  const upstreams: ProxyUpstream[] = [];
  const entryPointPorts = collectEntryPointPorts(services);

  for (const [serviceName, service] of Object.entries<any>(services)) {
    const routers = new Map<string, Record<string, string>>();
    const declaredServicePorts = new Map<string, string>();

    for (const [key, value] of normalizeLabels(service?.labels)) {
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
      const targetName = fields.service || serviceName;
      const targetPort = declaredServicePorts.get(targetName) || firstServicePort(services[targetName] || service);
      const upstream = targetPort ? `http://${targetName}:${targetPort}` : `http://${targetName}`;
      const entryPoints = (fields.entrypoints || '').split(',').map(value => value.trim()).filter(Boolean);
      const route: ProxyRoute = {
        host: fields.rule ? extractTraefikRuleValue(fields.rule, 'Host') : undefined,
        matchPath: fields.rule ? extractTraefikRuleValue(fields.rule, 'PathPrefix') || extractTraefikRuleValue(fields.rule, 'Path') : undefined,
        listenPorts: dedupe(entryPoints.map(name => entryPointPorts.get(name)).filter(Boolean) as string[]),
        upstream,
        directive: 'traefik-docker-router',
        line: findLabelLine(lines, routerName),
      };
      routes.push(route);
      upstreams.push({ name: targetName, servers: [upstream], line: route.line });
    }
  }

  return { routes, upstreams: dedupeUpstreams(upstreams) };
}

export function extractTraefikRuleValue(rule: string, matcher: 'Host' | 'PathPrefix' | 'Path'): string | undefined {
  const match = rule.match(new RegExp(`${matcher}\\(\\s*[\`'"]([^\`'"]+)[\`'"]`));
  return match?.[1];
}

export function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') return [value];
  return [];
}

function collectEntryPointPorts(services: Record<string, any>): Map<string, string> {
  const ports = new Map<string, string>();
  for (const service of Object.values<any>(services)) {
    for (const command of toStringArray(service?.command)) {
      const match = command.match(/^--entrypoints\.([^.]+)\.address=.*:(\d+)$/i);
      if (match) ports.set(match[1], match[2]);
    }
  }
  return ports;
}

function normalizeLabels(value: unknown): Array<[string, string]> {
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

function firstServicePort(service: any): string | undefined {
  for (const candidate of [...toStringArray(service?.expose), ...toStringArray(service?.ports)]) {
    const normalized = candidate.replace(/\/(?:tcp|udp)$/i, '').split(':').pop()?.trim();
    if (/^\d+$/.test(normalized || '')) return normalized;
  }
  return undefined;
}

function findLabelLine(lines: string[], routerName: string): number {
  const needle = `traefik.http.routers.${routerName}.`;
  const index = lines.findIndex(line => line.includes(needle));
  return index === -1 ? 1 : index + 1;
}

function dedupeUpstreams(upstreams: ProxyUpstream[]): ProxyUpstream[] {
  return [...new Map(upstreams.map(upstream => [upstream.name, upstream])).values()];
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}
