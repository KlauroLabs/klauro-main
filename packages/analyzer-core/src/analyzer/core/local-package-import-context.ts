import * as path from 'path';
import * as fs from 'fs-extra';

export const LOCAL_PACKAGE_IMPORT_CONTEXT_PATH = '.klauro/local-package-imports.json';

export interface LocalPackageImportIdentity {
  source_file: string;
  specifier: string;
  package_name: string;
}

export interface LocalPackageImportContext {
  imports: LocalPackageImportIdentity[];
}

const localPackageNamesByRoot = new Map<string, Promise<Set<string>>>();

export async function deriveLocalPackageImportContext(
  resolutionRoot: string,
  sources: Array<{ path?: string; content: string }>
): Promise<LocalPackageImportContext> {
  const imports: LocalPackageImportIdentity[] = [];
  for (const source of sources) {
    if (!source.path || source.path === LOCAL_PACKAGE_IMPORT_CONTEXT_PATH) continue;
    for (const specifier of relativeImportSpecifiers(source.content)) {
      const target = path.resolve(resolutionRoot, path.dirname(source.path), specifier);
      const packageName = await resolvedPackageName(target);
      if (!packageName) continue;
      imports.push({ source_file: normalizePath(source.path), specifier, package_name: packageName });
    }
  }
  imports.sort((left, right) =>
    left.source_file.localeCompare(right.source_file) ||
    left.specifier.localeCompare(right.specifier) ||
    left.package_name.localeCompare(right.package_name)
  );
  return { imports };
}

export async function importsLocalPackage(
  projectRoot: string,
  sourceFile: string,
  content: string,
  packageName: string
): Promise<boolean> {
  const specifiers = relativeImportSpecifiers(content);
  for (const specifier of specifiers) {
    const target = path.resolve(path.dirname(sourceFile), specifier);
    if (await resolvedPackageName(target) === packageName) return true;
  }
  const context = await readLocalPackageImportContext(projectRoot);
  if (!context) return false;
  const sourceRelative = normalizePath(path.relative(projectRoot, sourceFile));
  return context.imports.some(identity =>
    identity.source_file === sourceRelative &&
    identity.package_name === packageName &&
    specifiers.includes(identity.specifier)
  );
}

export async function readLocalPackageImportContext(projectRoot: string): Promise<LocalPackageImportContext | undefined> {
  const contextPath = path.join(projectRoot, LOCAL_PACKAGE_IMPORT_CONTEXT_PATH);
  if (!await fs.pathExists(contextPath)) return undefined;
  try {
    const parsed = await fs.readJson(contextPath);
    if (!Array.isArray(parsed?.imports)) return undefined;
    return { imports: parsed.imports.filter(isLocalPackageImportIdentity) };
  } catch {
    return undefined;
  }
}

export async function localPackageImportsAny(projectRoot: string, packageNames: string[]): Promise<boolean> {
  const cacheKey = path.resolve(projectRoot);
  let namesPromise = localPackageNamesByRoot.get(cacheKey);
  if (!namesPromise) {
    namesPromise = readLocalPackageImportContext(cacheKey).then(context =>
      new Set((context?.imports || []).map(identity => identity.package_name.toLowerCase()))
    );
    localPackageNamesByRoot.set(cacheKey, namesPromise);
  }
  const names = await namesPromise;
  return packageNames.some(packageName => {
    const wanted = packageName.toLowerCase();
    return names.has(wanted) || names.has(wanted.replace(/^@[^/]+\//, ''));
  });
}

export function invalidateLocalPackageImportContext(projectRoot: string): void {
  localPackageNamesByRoot.delete(path.resolve(projectRoot));
}

function isLocalPackageImportIdentity(value: unknown): value is LocalPackageImportIdentity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as Record<string, unknown>;
  return typeof identity.source_file === 'string' &&
    typeof identity.specifier === 'string' &&
    typeof identity.package_name === 'string';
}

function relativeImportSpecifiers(content: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /\brequire\s*\(\s*['"](\.{1,2}\/[^'"]*)['"]\s*\)/g,
    /\bfrom\s+['"](\.{1,2}\/[^'"]*)['"]/g,
    /\bimport\s*\(\s*['"](\.{1,2}\/[^'"]*)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) specifiers.add(match[1]);
  }
  return [...specifiers];
}

async function resolvedPackageName(target: string): Promise<string | undefined> {
  const manifest = await findPackageManifest(target);
  if (!manifest) return undefined;
  try {
    const metadata = await fs.readJson(manifest);
    return typeof metadata?.name === 'string' && metadata.name ? metadata.name : undefined;
  } catch {
    return undefined;
  }
}

async function findPackageManifest(target: string): Promise<string | undefined> {
  let directory = target;
  try {
    if ((await fs.stat(target)).isFile()) directory = path.dirname(target);
  } catch {
    const extension = path.extname(target);
    if (extension) directory = path.dirname(target);
  }
  for (let depth = 0; depth < 3; depth++) {
    const manifest = path.join(directory, 'package.json');
    if (await fs.pathExists(manifest)) return manifest;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

function normalizePath(value: string): string {
  return value.split(path.sep).join('/');
}
