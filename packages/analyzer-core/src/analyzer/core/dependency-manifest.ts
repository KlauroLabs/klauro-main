





















import * as fs from 'fs';
import * as path from 'path';
import type {
  CASDependencyManifest,
  CASDeclaredDependency,
} from '../../types/cas.types';

type Scope = 'runtime' | 'dev' | 'peer' | 'optional' | 'build';
type Ecosystem = 'npm' | 'pypi' | 'cargo' | 'go' | 'maven' | 'gradle' | 'nuget' | 'composer' | 'pub' | 'unknown';

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





function collectManifestFiles(projectPath: string): string[] {
  const found: string[] = [];
  const stack: string[] = [projectPath];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
        stack.push(path.join(dir, entry.name));
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


function manifestEcosystem(basename: string): Ecosystem | null {
  const lower = basename.toLowerCase();
  if (lower === 'package.json') return 'npm';
  if (lower === 'cargo.toml') return 'cargo';
  if (lower === 'go.mod') return 'go';
  if (lower === 'pyproject.toml') return 'pypi';
  if (lower === 'requirements.txt' || /^requirements[-.].*\.txt$/.test(lower)) return 'pypi';
  if (lower === 'pom.xml') return 'maven';
  if (lower === 'build.gradle' || lower === 'build.gradle.kts') return 'gradle';
  if (/\.(?:cs|fs|vb)proj$/.test(lower)) return 'nuget';
  if (lower === 'composer.json') return 'composer';
  if (lower === 'pubspec.yaml' || lower === 'pubspec.yml') return 'pub';
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






function parseRequirementsTxt(text: string, rel: string, map: Map<string, DepAccumulator>): void {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    if (/^[a-z]+:\/\//i.test(line)) continue;
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
    if (!name.includes('.') && !name.includes('/')) continue;
    const acc = ensureDep(map, name, 'go');
    acc.scopes.add(line.includes('// indirect') ? 'build' : 'runtime');
    acc.declaredIn.add(rel);
    if (!acc.version) acc.version = match[2];
  }
}

function xmlValue(block: string, tag: string): string | undefined {
  return block.match(new RegExp(`<${tag}[^>]*>\\s*([^<]+?)\\s*</${tag}>`, 'i'))?.[1]?.trim();
}

function parsePomXml(text: string, rel: string, map: Map<string, DepAccumulator>): void {
  for (const match of text.matchAll(/<dependency\b[^>]*>([\s\S]*?)<\/dependency>/gi)) {
    const block = match[1];
    const name = xmlValue(block, 'artifactId');
    if (!name) continue;
    const declaredScope = (xmlValue(block, 'scope') || 'compile').toLowerCase();
    const scope: Scope = declaredScope === 'test' ? 'dev'
      : declaredScope === 'provided' || declaredScope === 'system' ? 'build'
        : declaredScope === 'optional' ? 'optional' : 'runtime';
    const acc = ensureDep(map, name, 'maven');
    acc.scopes.add(scope);
    acc.declaredIn.add(rel);
    const version = xmlValue(block, 'version');
    if (version && !acc.version) acc.version = version;
  }
}

function parseGradle(text: string, rel: string, map: Map<string, DepAccumulator>): void {
  const declaration = /^\s*(implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|annotationProcessor|kapt)\s*(?:\(|\s)\s*["']([^"']+)["']/gm;
  for (const match of text.matchAll(declaration)) {
    const configuration = match[1];
    const coordinates = match[2].split(':');
    if (coordinates.length < 2) continue;
    const name = coordinates[1];
    const scope: Scope = /^test/i.test(configuration) ? 'dev'
      : /compileOnly|annotationProcessor|kapt/i.test(configuration) ? 'build' : 'runtime';
    const acc = ensureDep(map, name, 'gradle');
    acc.scopes.add(scope);
    acc.declaredIn.add(rel);
    if (coordinates[2] && !acc.version) acc.version = coordinates.slice(2).join(':');
  }
}

function parseNugetProject(text: string, rel: string, map: Map<string, DepAccumulator>): void {
  for (const match of text.matchAll(/<PackageReference\b([^>]*?)(?:\/>|>([\s\S]*?)<\/PackageReference>)/gi)) {
    const attributes = match[1];
    const body = match[2] || '';
    const name = attributes.match(/\b(?:Include|Update)\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!name) continue;
    const version = attributes.match(/\bVersion\s*=\s*["']([^"']+)["']/i)?.[1] || xmlValue(body, 'Version');
    const isPrivate = /<PrivateAssets>\s*all\s*<\/PrivateAssets>/i.test(body);
    const acc = ensureDep(map, name, 'nuget');
    acc.scopes.add(isPrivate ? 'build' : 'runtime');
    acc.declaredIn.add(rel);
    if (version && !acc.version) acc.version = version;
  }
}

function parseComposerJson(text: string, rel: string, map: Map<string, DepAccumulator>): void {
  let json: any;
  try { json = JSON.parse(text); } catch { return; }
  for (const [section, scope] of [['require', 'runtime'], ['require-dev', 'dev']] as const) {
    const dependencies = json?.[section];
    if (!dependencies || typeof dependencies !== 'object') continue;
    for (const [name, version] of Object.entries(dependencies)) {
      if (!name || name === 'php' || name.startsWith('ext-')) continue;
      const acc = ensureDep(map, name, 'composer');
      acc.scopes.add(scope);
      acc.declaredIn.add(rel);
      if (typeof version === 'string' && version && !acc.version) acc.version = version;
    }
  }
}

function parsePubspec(text: string, rel: string, map: Map<string, DepAccumulator>): void {
  let scope: Scope | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    if (/^dependencies:\s*$/.test(rawLine)) { scope = 'runtime'; continue; }
    if (/^dev_dependencies:\s*$/.test(rawLine)) { scope = 'dev'; continue; }
    if (/^[A-Za-z_][\w-]*:\s*$/.test(rawLine)) { scope = null; continue; }
    if (!scope) continue;
    const match = rawLine.match(/^\s{2}([A-Za-z_][\w-]*):(?:\s*([^#\s]+))?/);
    if (!match) continue;
    const name = match[1];
    const acc = ensureDep(map, name, 'pub');
    acc.scopes.add(scope);
    acc.declaredIn.add(rel);
    if (match[2] && !acc.version) acc.version = match[2];
  }
}






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

      addPep508Names(line, rel, map, 'optional');
    } else if (section === 'poetry' || section === 'poetry-dev') {

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
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    relManifests.push(rel);
    switch (eco) {
      case 'npm': parsePackageJson(text, rel, depMap); break;
      case 'cargo': parseCargoToml(text, rel, depMap); break;
      case 'go': parseGoMod(text, rel, depMap); break;
      case 'maven': parsePomXml(text, rel, depMap); break;
      case 'gradle': parseGradle(text, rel, depMap); break;
      case 'nuget': parseNugetProject(text, rel, depMap); break;
      case 'composer': parseComposerJson(text, rel, depMap); break;
      case 'pub': parsePubspec(text, rel, depMap); break;
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
