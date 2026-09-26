import { execFile } from 'child_process';
import { promisify } from 'util';

const run = promisify(execFile);

const LISTING_LIMIT = 64 * 1024 * 1024;

export async function gitIgnoredPaths(root: string): Promise<Set<string> | undefined> {
  try {
    const { stdout } = await run(
      'git',
      ['-C', root, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
      { maxBuffer: LISTING_LIMIT, encoding: 'utf8' },
    );
    return new Set(stdout.split('\0').filter(Boolean));
  } catch {
    return undefined;
  }
}

export function isGitIgnored(relativePath: string, ignored: Set<string> | undefined): boolean {
  if (!ignored || ignored.size === 0) return false;
  if (ignored.has(relativePath) || ignored.has(`${relativePath}/`)) return true;
  let at = relativePath.indexOf('/');
  while (at > 0) {
    if (ignored.has(relativePath.slice(0, at + 1))) return true;
    at = relativePath.indexOf('/', at + 1);
  }
  return false;
}
