import * as path from 'node:path';

function jsonEscaped(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

export function localizeHostedWorkspacePath<T>(result: T, localPath: string): T {
  const hostedPath = (result as { path?: unknown } | null | undefined)?.path;
  if (typeof hostedPath !== 'string' || hostedPath === localPath || !path.isAbsolute(hostedPath)) return result;
  const serialized = JSON.stringify(result).split(jsonEscaped(hostedPath)).join(jsonEscaped(localPath));
  return JSON.parse(serialized) as T;
}
