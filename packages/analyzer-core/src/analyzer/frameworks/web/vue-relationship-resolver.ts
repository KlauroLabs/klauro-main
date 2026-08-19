import * as path from 'path';

export interface VueRelationshipComponent {
  name: string;
  filePath: string;
  imports: string[];
}

export interface VueRelationshipRoute {
  path: string;
  component: string;
  filePath: string;
  nodeId?: string;
}

export function resolveVueComponentImports(components: VueRelationshipComponent[]): Array<{ source: VueRelationshipComponent; target: VueRelationshipComponent; importPath: string }> {
  const byFile = new Map(components.map(component => [withoutExtension(normalize(component.filePath)), component]));
  const resolved: Array<{ source: VueRelationshipComponent; target: VueRelationshipComponent; importPath: string }> = [];
  for (const source of components) {
    for (const importPath of source.imports) {
      if (!importPath.startsWith('./') && !importPath.startsWith('../')) continue;
      const targetPath = withoutExtension(path.posix.normalize(path.posix.join(path.posix.dirname(normalize(source.filePath)), importPath)));
      const target = byFile.get(targetPath);
      if (target && target.filePath !== source.filePath) resolved.push({ source, target, importPath });
    }
  }
  return resolved;
}

export function resolveVueRouteComponents(routes: VueRelationshipRoute[], components: VueRelationshipComponent[]): Array<{ route: VueRelationshipRoute; target: VueRelationshipComponent }> {
  const byName = new Map<string, VueRelationshipComponent | undefined>();
  for (const component of components) {
    byName.set(component.name, byName.has(component.name) ? undefined : component);
  }
  return routes.flatMap(route => {
    const targetName = path.posix.basename(route.component).replace(/\.vue$/i, '');
    const target = byName.get(targetName);
    return target ? [{ route, target }] : [];
  });
}

function normalize(value: string): string {
  return value.replace(/\\/g, '/');
}

function withoutExtension(value: string): string {
  return value.replace(/\.[^/.]+$/, '');
}
