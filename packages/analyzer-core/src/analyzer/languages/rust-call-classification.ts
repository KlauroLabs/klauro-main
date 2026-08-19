export interface RustCallParameter {
  name: string;
  type: string;
}

export function normalizeRustDependencyName(name: string): string {
  return name.replace(/-/g, '_');
}

export function externalRustReceiverNames(
  body: string,
  parameters: RustCallParameter[],
  directDependencyNames: Set<string>
): Set<string> {
  const names = new Set<string>();
  for (const parameter of parameters) {
    const dependency = [...directDependencyNames].some(name => new RegExp(`\\b${name}\\b`).test(parameter.type));
    if (!dependency) continue;
    for (const match of parameter.name.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) names.add(match[0]);
  }
  for (const match of body.matchAll(/\blet\s+(?:mut\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)::/g)) {
    if (directDependencyNames.has(match[2])) names.add(match[1]);
  }
  return names;
}
