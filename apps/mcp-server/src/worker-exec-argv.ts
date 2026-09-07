const VALUE_FLAGS = new Set(['-e', '--eval', '-p', '--print', '--max-old-space-size', '--max_old_space_size']);
const LOADER_FLAGS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader']);
const DROPPED_PREFIXES = ['--eval=', '--print=', '--max-old-space-size=', '--max_old_space_size=', '--test=', '--test-', '--experimental-test'];

function isTypeScriptLoader(value: string | undefined): boolean {
  return value !== undefined && /(?:^|[\\/])(?:tsx|ts-node)(?:[\\/]|$)/.test(value);
}

function loaderFlagOf(argument: string): { flag: string; inline: boolean } | undefined {
  if (LOADER_FLAGS.has(argument)) return { flag: argument, inline: false };
  const separator = argument.indexOf('=');
  if (separator > 0 && LOADER_FLAGS.has(argument.slice(0, separator))) return { flag: argument.slice(0, separator), inline: true };
  return undefined;
}

export function workerExecArgvForEntry(execArgv: readonly string[], entry: string): string[] {
  const keepTypeScriptLoaders = /\.[cm]?ts$/.test(entry);
  const safe: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const argument = execArgv[index];
    if (VALUE_FLAGS.has(argument)) {
      index += 1;
      continue;
    }
    if (argument === '--test' || DROPPED_PREFIXES.some(prefix => argument.startsWith(prefix))) continue;
    const loader = loaderFlagOf(argument);
    if (loader) {
      const value = loader.inline ? argument.slice(loader.flag.length + 1) : execArgv[index + 1];
      if (!loader.inline) index += 1;
      if (isTypeScriptLoader(value) && !keepTypeScriptLoaders) continue;
      if (loader.inline) safe.push(argument);
      else safe.push(loader.flag, value ?? '');
      continue;
    }
    safe.push(argument);
  }
  return safe;
}
