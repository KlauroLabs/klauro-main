import * as fs from 'node:fs';
import * as path from 'node:path';
import { isBuildArtifactDirectoryName } from './build-artifact-paths';
import { SCAFFOLD_DIR_NAMES } from './scaffold-paths';
import { isRegisteredManifest, isRegisteredSourceExtension } from './language-registry';

export type DiscoveredKind = 'source' | 'manifest' | 'config' | 'script';

export interface DiscoveredFile {
  path: string;
  kind: DiscoveredKind;
}

export interface DiscoveryResult {
  files: DiscoveredFile[];
  skippedDirectories: string[];
  nestedRepositories: string[];
}

export interface DiscoveryOptions {
  ignoredDirectories?: ReadonlySet<string>;
  isIgnoredFile?: (relativePath: string) => boolean;
  readShebang?: (absolutePath: string) => boolean;
}

export const SKIPPED_DIRECTORY_NAMES: ReadonlySet<string> = new Set<string>([
  'node_modules', 'dist', 'build', '.git', '.claude', '.codex', '.scannerwork',
  'target', 'vendor', 'vendors', 'site-packages', '__pycache__', '.venv', 'venv',
  'env', '.tox', '.terraform', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  '.dart_tool', '.gradle', 'Pods', 'obj', '.next', '.turbo', '.cache', '.vite',
  '.sourcemaps', 'out', 'build-out', 'build_out', 'cmake-build-debug',
  'cmake-build-release', 'storybook-static', 'storybook-build', 'Generated',
  'generated',
  ...SCAFFOLD_DIR_NAMES
]);

const NOTEBOOK_EXTENSIONS = new Set(['.ipynb']);

const KNOWN_EXTENSIONLESS_SOURCE: ReadonlySet<string> = new Set([
  'Jenkinsfile', 'artisan', 'console', 'Procfile', 'Vagrantfile', 'Rakefile'
]);

const CONFIG_EXTENSIONS = new Set([
  '.json', '.jsonc', '.json5', '.yaml', '.yml', '.toml',
  '.ini', '.cfg', '.conf', '.properties', '.env', '.editorconfig'
]);

const LOCK_FILE_PATTERN = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Gemfile\.lock|Cargo\.lock|composer\.lock|go\.sum|flake\.lock|Package\.resolved)$/i;

const MEDIA_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp', '.tiff',
  '.mp3', '.mp4', '.wav', '.mov', '.avi', '.webm', '.ogg', '.flac',
  '.pdf', '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.wasm', '.so', '.dylib', '.dll', '.exe', '.bin', '.dat', '.db', '.sqlite'
]);

function startsWithShebang(absolutePath: string): boolean {
  let handle: number | undefined;
  try {
    handle = fs.openSync(absolutePath, 'r');
    const buffer = Buffer.alloc(2);
    const read = fs.readSync(handle, buffer, 0, 2, 0);
    return read === 2 && buffer[0] === 0x23 && buffer[1] === 0x21;
  } catch {
    return false;
  } finally {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch { handle = undefined; }
    }
  }
}

export function isSkippedDirectoryName(directoryName: string): boolean {
  return SKIPPED_DIRECTORY_NAMES.has(directoryName) ||
    isBuildArtifactDirectoryName(directoryName) ||
    directoryName.startsWith('.klauro');
}

export function classifyFile(
  relativePath: string,
  absolutePath: string,
  readShebang: (file: string) => boolean
): DiscoveredKind | undefined {
  if (isRegisteredManifest(relativePath)) return 'manifest';
  if (isRegisteredSourceExtension(relativePath)) return 'source';
  if (KNOWN_EXTENSIONLESS_SOURCE.has(path.basename(relativePath))) return 'source';

  const extension = path.extname(relativePath).toLowerCase();
  if (NOTEBOOK_EXTENSIONS.has(extension)) return 'source';
  if (MEDIA_EXTENSIONS.has(extension)) return undefined;
  if (LOCK_FILE_PATTERN.test(relativePath)) return undefined;
  if (CONFIG_EXTENSIONS.has(extension)) return 'config';

  const basename = path.basename(relativePath);
  if (basename.startsWith('.') && CONFIG_EXTENSIONS.has(`.${basename.slice(1).toLowerCase()}`)) return 'config';
  if (extension === '') return readShebang(absolutePath) ? 'script' : undefined;
  return undefined;
}

export function discoverFiles(root: string, options: DiscoveryOptions = {}): DiscoveryResult {
  const ignoredDirectories = options.ignoredDirectories;
  const isIgnoredFile = options.isIgnoredFile;
  const readShebang = options.readShebang || startsWithShebang;

  const files: DiscoveredFile[] = [];
  const skippedDirectories: string[] = [];
  const nestedRepositories: string[] = [];
  const stack: Array<{ absolute: string; relative: string }> = [{ absolute: root, relative: '' }];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      const absolute = path.join(current.absolute, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git' && current.relative) nestedRepositories.push(current.relative);
        if (isSkippedDirectoryName(entry.name) || ignoredDirectories?.has(relative)) {
          skippedDirectories.push(relative);
          continue;
        }
        stack.push({ absolute, relative });
        continue;
      }
      if (!entry.isFile()) continue;
      if (isIgnoredFile?.(relative)) continue;
      const kind = classifyFile(relative, absolute, readShebang);
      if (kind) files.push({ path: relative, kind });
    }
  }

  nestedRepositories.sort();
  const kept = nestedRepositories.length === 0
    ? files
    : files.filter(file => !nestedRepositories.some(repository => file.path.startsWith(`${repository}/`)));

  kept.sort((left, right) => left.path.localeCompare(right.path));
  skippedDirectories.sort();
  return { files: kept, skippedDirectories, nestedRepositories };
}
