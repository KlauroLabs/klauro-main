const FILE_AWARE_RUNNER = /^(?:jest(?: --runInBand)?|vitest run|mocha|ava|node --test)$/;

export function resolveFileAwareTestScript(scripts: Record<string, string>): string | null {
  const resolve = (name: string, visited: Set<string>): string | null => {
    if (visited.has(name)) return null;
    visited.add(name);
    const script = scripts[name]?.trim();
    if (!script) return null;
    if (FILE_AWARE_RUNNER.test(script)) return name;
    const alias = /^(?:npm run ([a-zA-Z0-9:_-]+)|npm (test))$/.exec(script);
    return alias ? resolve(alias[1] || alias[2], visited) : null;
  };
  for (const name of ['test:unit', 'unit', 'test']) {
    const resolved = resolve(name, new Set());
    if (resolved) return name;
  }
  return null;
}
