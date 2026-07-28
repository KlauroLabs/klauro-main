/**
 * Full declared-dependency manifest extraction (Camp-B structural FACT).
 *
 * Repo-AGNOSTIC. For ANY repository, recursively finds every dependency manifest
 * (package.json / requirements*.txt / Cargo.toml / go.mod / pyproject.toml) under
 * the project root and extracts the COMPLETE list of declared dependency names.
 *
 * This exists because the framework/library detectors only surface the subset of
 * dependencies they recognize (nestjs, mikro-orm, ...), which silently drops the
 * DEFINING dependencies of a system — e.g. a repo that depends on `ccxt`/`web3`
 * has those names nowhere in the analysis, so the AI comprehension pass writes
 * from thin air. The manifest is the ground truth of what a system pulls in.
 *
 * ABSOLUTE RULES honored here:
 *  - FACTS ONLY. We emit raw dependency names + which manifest declared them +
 *    the scope + declared version. We NEVER interpret what a dependency MEANS,
 *    never categorize by keyword, never brand-match. Interpretation ("this reads
 *    as a crypto-exchange system because it depends on ccxt/web3") is the AI
 *    comprehension pass's job downstream — it reads these facts as grounding.
 *  - Deterministic: same source tree -> byte-identical manifest (sorted names,
 *    sorted manifests, sorted scopes), so this is a valid Camp-B fact.
 */
import * as fs from 'fs';
import * as path from 'path';
import type {
  CASDependencyManifest,
  CASDeclaredDependency,
} from '../../types/cas.types';

type Scope = 'runtime' | 'dev' | 'peer' | 'optional' | 'build';
type Ecosystem = 'npm' | 'pypi' | 'cargo' | 'go' | 'unknown';

const IGNORED_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'vendors',
  'target', '.git', '.next', '.turbo', '.cache', '.terraform', '__pycache__',
  'venv', '.venv', 'env', '.worktrees',
]);

interface DepAccumulator {
  ecosystem: Ecosystem;
  version?: string;
  scopes: Set<Scope>;
  declaredIn: Set<string>;
}

/**
 * Walk the project tree (bounded depth) collecting manifest file paths. Skips
 * dependency/build/vcs directories and any dot-directory (worktrees, caches).
 */
function collectManifestFiles(projectPath: string, maxDepth = 8): string[] {
  const found: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: projectPath, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    if (depth > maxDepth) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
        stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (manifestEcosystem(entry.name) !== null) {
        found.push(path.join(dir, entry.name));
      }
    }
  }
  return found;
}

/** Which ecosystem a manifest filename belongs to (null = not a manifest). */
function manifestEcosystem(basename: string): Ecosystem | null {
  const lower = basename.toLowerCase();
  if (lower === 'package.json') return 'npm';
  if (lower === 'cargo.toml') return 'cargo';
  if (lower === 'go.mod') return 'go';
  if (lower === 'pyproject.toml') return 'pypi';
  if (lower === 'requirements.txt' || /^requirements[-.].*\.txt$/.test(lower)) return 'pypi';
  return null;
}

function ensureDep(
  map: Map<string, DepAccumulator>,
  name: string,
  ecosystem: Ecosystem,
): DepAccumulator {
  let acc = map.get(name);
  if (!acc) {
    acc = { ecosystem, scopes: new Set(), declaredIn: new Set() };
    map.set(name, acc);
  }
  return acc;
}

function parsePackageJson(text: string, rel: string, map: Map<string, DepAccumulator>): void {
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    return;
  }
  const sections: Array<[string, Scope]> = [
    ['dependencies', 'runtime'],
    ['devDependencies', 'dev'],
    ['peerDependencies', 'peer'],
    ['optionalDependencies', 'optional'],
  ];
  for (const [key, scope] of sections) {
    const block = json?.[key];
    if (!block || typeof block !== 'object') continue;
    for (const [name, version] of Object.entries(block)) {
      if (!name) continue;
      const acc = ensureDep(map, name, 'npm');
      acc.scopes.add(scope);
      acc.declaredIn.add(rel);
      if (typeof version === 'string' && version && !acc.version) acc.version = version;
    }
  }
}

/**
 * requirements.txt: one dependency per non-comment line. We take the package
 * name up to the first version specifier / extras / env marker. Lines that are
 * flags (-r, -e, --hash) or URLs are skipped — we want declared package names.
 */
function parseRequirementsTxt(text: string, rel: string, map: Map<string, DepAccumulator>): void {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    if (/^[a-z]+:\/\//i.test(line)) continue; // URL/VCS line
    const match = line.match(/^([A-Za-z0-9._-]+)/);
    if (!match) continue;
    const name = match[1];
    const versionMatch = line.slice(name.length).match(/^\s*(?:\[[^\]]*\])?\s*([=<>!~]=?[^;#\s]+)/);
    const acc = ensureDep(map, name, 'pypi');
    acc.scopes.add('runtime');
    acc.declaredIn.add(rel);
    if (versionMatch && !acc.version) acc.version = versionMatch[1];
  }
}

/**
 * Cargo.toml: read [dependencies] / [dev-dependencies] / [build-dependencies]
 * (and target-scoped variants) tables. Line-based TOML parse — sufficient to
 * pull declared crate names + inline version, without a TOML dependency.
 */
function parseCargoToml(text: string, rel: string, map: Map<string, DepAccumulator>): void {
  let scope: Scope | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('#') || line === '') continue;
    const tableMatch = line.match(/^\[([^\]]+)\]/);
    if (tableMatch) {
      const table = tableMatch[1].trim();
      if (/(^|\.)dev-dependencies$/.test(table)) scope = 'dev';
      else if (/(^|\.)build-dependencies$/.test(table)) scope = 'build';
      else if (/(^|\.)dependencies$/.test(table)) scope = 'runtime';
      else scope = null;
      continue;
    }
    if (scope === null) continue;
    // `name = "1.0"` or `name = { version = "1.0", ... }`
    const depMatch = line.match(/^([A-Za-z0-9_-]+)\s*=/);
    if (!depMatch) continue;
    const name = depMatch[1];
    const acc = ensureDep(map, name, 'cargo');
    acc.scopes.add(scope);
    acc.declaredIn.add(rel);
    const inlineVersion = line.match(/version\s*=\s*"([^"]+)"/) || line.match(/=\s*"([^"]+)"\s*$/);
    if (inlineVersion && !acc.version) acc.version = inlineVersion[1];
  }
}

/**
 * go.mod: `require` lines / `require (...)` blocks. The module path (first
 * token) is the dependency name; the version follows.
 */
function parseGoMod(text: string, rel: string, map: Map<string, DepAccumulator>): void {
  let inBlock = false;
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line.startsWith('//') || line === '') continue;
    if (line.startsWith('require (')) { inBlock = true; continue; }
    if (inBlock && line === ')') { inBlock = false; continue; }
    if (!inBlock) {
      if (!line.startsWith('require ')) continue;
      line = line.slice('require '.length).trim();
    }
    const match = line.match(/^([^\s]+)\s+([^\s]+)/);
    if (!match) continue;
    const name = match[1];
    if (!name.includes('.') && !name.includes('/')) continue; // not a module path
    const acc = ensureDep(map, name, 'go');
    acc.scopes.add(line.includes('// indirect') ? 'build' : 'runtime');
    acc.declaredIn.add(rel);
    if (!acc.version) acc.version = match[2];
  }
}

/**
 * pyproject.toml: PEP 621 `[project] dependencies = [...]` and
 * `[project.optional-dependencies]`, plus poetry `[tool.poetry.dependencies]`.
 * Line-based extraction of declared names.
 */
function parsePyprojectToml(text: string, rel: string, map: Map<string, DepAccumulator>): void {
  const lines = text.split(/\r?\n/);
  let section: 'pep621' | 'pep621-optional' | 'poetry' | 'poetry-dev' | null = null;
  let inArray = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith('#') || line === '') continue;
    const tableMatch = line.match(/^\[([^\]]+)\]/);
    if (tableMatch) {
      const table = tableMatch[1].trim();
      inArray = false;
      if (table === 'project') section = 'pep621';
      else if (table === 'project.optional-dependencies') section = 'pep621-optional';
      else if (table === 'tool.poetry.dependencies') section = 'poetry';
      else if (/^tool\.poetry\.(group\..*\.dependencies|dev-dependencies)$/.test(table)) section = 'poetry-dev';
      else section = null;
      continue;
    }
    if (section === null) continue;
    if (section === 'pep621') {
      if (/^dependencies\s*=\s*\[/.test(line)) { inArray = true; }
      if (!inArray) continue;
      addPep508Names(line, rel, map, 'runtime');
      if (line.includes(']')) inArray = false;
    } else if (section === 'pep621-optional') {
      // entries like `test = ["pytest>=7", ...]`
      addPep508Names(line, rel, map, 'optional');
    } else if (section === 'poetry' || section === 'poetry-dev') {
      // `name = "^1.0"` — skip python itself
      const depMatch = line.match(/^([A-Za-z0-9._-]+)\s*=/);
      if (!depMatch) continue;
      const name = depMatch[1];
      if (name.toLowerCase() === 'python') continue;
      const acc = ensureDep(map, name, 'pypi');
      acc.scopes.add(section === 'poetry-dev' ? 'dev' : 'runtime');
      acc.declaredIn.add(rel);
      const inlineVersion = line.match(/=\s*"([^"]+)"/) || line.match(/version\s*=\s*"([^"]+)"/);
      if (inlineVersion && !acc.version) acc.version = inlineVersion[1];
    }
  }
}

/** Extract PEP 508 requirement names from a line that may contain quoted specs. */
function addPep508Names(line: string, rel: string, map: Map<string, DepAccumulator>, scope: Scope): void {
  const quoted = line.match(/"([^"]+)"|'([^']+)'/g) || [];
  for (const raw of quoted) {
    const inner = raw.slice(1, -1).trim();
    const nameMatch = inner.match(/^([A-Za-z0-9._-]+)/);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const versionMatch = inner.slice(name.length).match(/^\s*(?:\[[^\]]*\])?\s*([=<>!~]=?[^;\s]+)/);
    const acc = ensureDep(map, name, 'pypi');
    acc.scopes.add(scope);
    acc.declaredIn.add(rel);
    if (versionMatch && !acc.version) acc.version = versionMatch[1];
  }
}

/**
 * Build the full dependency-manifest fact for a project. Returns undefined when
 * no manifest files exist (so the field is simply absent, not an empty shell).
 */
export function buildDependencyManifest(projectPath: string): CASDependencyManifest | undefined {
  const manifestFiles = collectManifestFiles(projectPath);
  if (manifestFiles.length === 0) return undefined;

  const depMap = new Map<string, DepAccumulator>();
  const relManifests: string[] = [];

  for (const file of manifestFiles) {
    const rel = path.relative(projectPath, file).replace(/\\/g, '/');
    const eco = manifestEcosystem(path.basename(file));
    if (eco === null) continue;
    let text: string;
    try {
      const stat = fs.statSync(file);
      if (stat.size > 5 * 1024 * 1024) continue; // skip absurdly large manifests
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    relManifests.push(rel);
    switch (eco) {
      case 'npm': parsePackageJson(text, rel, depMap); break;
      case 'cargo': parseCargoToml(text, rel, depMap); break;
      case 'go': parseGoMod(text, rel, depMap); break;
      case 'pypi':
        if (path.basename(file).toLowerCase().startsWith('pyproject')) parsePyprojectToml(text, rel, depMap);
        else parseRequirementsTxt(text, rel, depMap);
        break;
    }
  }

  if (depMap.size === 0 && relManifests.length === 0) return undefined;

  const scopeOrder: Scope[] = ['runtime', 'dev', 'peer', 'optional', 'build'];
  const dependencies: CASDeclaredDependency[] = [...depMap.entries()]
    .map(([name, acc]): CASDeclaredDependency => ({
      name,
      ecosystem: acc.ecosystem,
      version: acc.version,
      scopes: scopeOrder.filter(scope => acc.scopes.has(scope)),
      declared_in: [...acc.declaredIn].sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    manifests: [...new Set(relManifests)].sort(),
    dependencies,
    total: dependencies.length,
  };
}
