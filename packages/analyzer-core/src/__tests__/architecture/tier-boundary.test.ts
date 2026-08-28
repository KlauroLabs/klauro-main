// Boundary gate for the abstraction-tier dependency rule in
// docs/SPEC-ABSTRACTION-TIERS.md: "a tier may never consume a tier above
// it." See docs/TIER-BOUNDARY-GATE.md for how to register a new file.
//
// This is an import-boundary TEST rather than a build-time lint rule
// because no lint/dependency-cruiser tooling was already wired into this
// package (see docs/TIER-BOUNDARY-GATE.md for why that choice was made and
// how to upgrade later). It reads each registered file's own relative
// imports off disk (no bundler, no resolution ambiguity) and fails the
// suite if a lower-numbered tier imports a higher-numbered tier.
//
// The checked-in path registry is exact and exhaustive: directory defaults are
// deliberately forbidden so a newly added module cannot acquire a tier silently.
import * as fs from 'fs';
import * as path from 'path';

const ANALYZER_DIR = path.resolve(__dirname, '../../analyzer');

type Tier = 1 | 2 | 3 | 4;

// tier 1: index / graph / ICELOT (nodes, edges, entry/exit points, raw
//          declared facts)
// tier 2: framework / architecture / library (framework identity, node
//          roles, dependency roles, paradigms) — reads tier 1 only
// tier 3: comprehension (capabilities, flows, steps, entities) — reads
//          tier 1 and 2 only
// tier 4: telemetry attachment — reads tier 1-3 only (lives in
//          apps/mcp-server, checked separately; see note at bottom)
const TIER_REGISTRY = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'analyzer-tier-registry.json'), 'utf8'),
) as Record<string, Tier>;

function listProductionModules(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return listProductionModules(full);
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts') || entry.name.endsWith('.integration.test.ts')) return [];
    return [path.relative(ANALYZER_DIR, full)];
  }).sort();
}

function tierForModule(relativePath: string): Tier | undefined {
  return TIER_REGISTRY[relativePath.split(path.sep).join('/')];
}

function extractLocalImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const staticImport = /(?:from|import)\s+['"](\.[^'"]*)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = staticImport.exec(source))) specifiers.push(match[1]);
  const callImport = /(?:import|require)\s*\(\s*['"](\.[^'"]*)['"]\s*\)/g;
  while ((match = callImport.exec(source))) specifiers.push(match[1]);
  return specifiers;
}

function resolveAnalyzerModule(fromFile: string, specifier: string): string | null {
  const resolved = path.resolve(path.dirname(fromFile), specifier);
  const candidates = resolved.endsWith('.ts') ? [resolved] : [`${resolved}.ts`, path.join(resolved, 'index.ts')];
  const target = candidates.find(candidate => fs.existsSync(candidate));
  if (!target) {
    const unresolved = path.relative(ANALYZER_DIR, resolved);
    return unresolved.startsWith("..") ? null : `unresolved:${unresolved}`;
  }
  const relative = path.relative(ANALYZER_DIR, target);
  if (relative.startsWith('..')) return null;
  return relative;
}

describe('tier-boundary gate (docs/SPEC-ABSTRACTION-TIERS.md dependency rule)', () => {
  const productionFiles = listProductionModules(ANALYZER_DIR);

  it('assigns every production analyzer module exactly one deterministic tier', () => {
    expect(productionFiles.length).toBeGreaterThan(300);
    expect(productionFiles.filter(file => tierForModule(file) === undefined)).toEqual([]);
    expect(Object.keys(TIER_REGISTRY).sort()).toEqual(productionFiles);
    expect(Object.entries(TIER_REGISTRY).filter(([, tier]) => ![1, 2, 3, 4].includes(tier))).toEqual([]);
  });

  it('pins neutral nested parsers and indexes below convention-producing analyzers', () => {
    expect(tierForModule('languages/java-signature-parsing.ts')).toBe(1);
    expect(tierForModule('languages/java-source-structure.ts')).toBe(1);
    expect(tierForModule('languages/python-call-index.ts')).toBe(1);
    expect(tierForModule('languages/java-analyzer.ts')).toBe(2);
    expect(tierForModule('languages/python-analyzer.ts')).toBe(2);
    expect(tierForModule('libraries/orm/prisma-analyzer.ts')).toBe(2);
    expect(tierForModule('core/capability-detector.ts')).toBe(3);
  });

  it.each(productionFiles)('%s does not import a higher tier', (file) => {
    const tier = tierForModule(file)!;
    const full = path.join(ANALYZER_DIR, file);
    const source = fs.readFileSync(full, 'utf8');
    const specifiers = extractLocalImportSpecifiers(source);

    const violations: string[] = [];
    for (const spec of specifiers) {
      const key = resolveAnalyzerModule(full, spec);
      if (!key) continue;
      const importedTier = tierForModule(key);
      if (importedTier === undefined) {
        violations.push(`${file} imports unclassified analyzer module ${key}`);
        continue;
      }
      if (importedTier > tier) {
        violations.push(`${file} (tier ${tier}) imports ${key} (tier ${importedTier})`);
      }
    }

    expect(violations).toEqual([]);
  });
});
