import * as path from 'path';

const SCRIPT_EXTENSION_PATTERN = /\.(mts|cts|tsx|ts|mjs|cjs|jsx|js)$/;

export function isDirectCliInvocation(scriptName: string): boolean {
  const invokedPath = process.argv[1];
  if (!invokedPath) return false;
  const invokedName = path.basename(invokedPath).replace(SCRIPT_EXTENSION_PATTERN, '');
  return invokedName === scriptName;
}
