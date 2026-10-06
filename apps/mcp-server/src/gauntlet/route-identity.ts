const PARAMETER = /\{(?:[^}:]+:)?([^}]+)\}|<(?:[^>:]+:)?([^>]+)>|:([A-Za-z_][A-Za-z0-9_]*)/g;

export function routeIdentity(route: string): string {
  return route.replace(PARAMETER, (_match, braced, angled, prefixed) => `:${braced ?? angled ?? prefixed}`);
}

export function routeIdentities(routes: string[]): string[] {
  return routes.map(routeIdentity);
}
