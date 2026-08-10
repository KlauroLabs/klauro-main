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
// Registration is intentionally an explicit, hand-maintained allowlist
// (TIER_REGISTRY below) rather than a directory-glob: orchestrator.ts still
// holds tier-1/2/3 logic undifferentiated (this is task #121's whole
// premise), so a glob over the directory would either wrongly tier
// orchestrator.ts's not-yet-extracted code or silently exempt it. Every
// file extracted out of orchestrator.ts along the tier boundary should be
// added to this registry in the SAME commit as its extraction — that is
// what keeps the gate meaningful as the decomposition proceeds.
import * as fs from 'fs';
import * as path from 'path';

const CORE_DIR = path.resolve(__dirname, '../../analyzer/core');

type Tier = 1 | 2 | 3 | 4;

// tier 1: index / graph / ICELOT (nodes, edges, entry/exit points, raw
//          declared facts)
// tier 2: framework / architecture / library (framework identity, node
//          roles, dependency roles, paradigms) — reads tier 1 only
// tier 3: comprehension (capabilities, flows, steps, entities) — reads
//          tier 1 and 2 only
// tier 4: telemetry attachment — reads tier 1-3 only (lives in
//          apps/mcp-server, checked separately; see note at bottom)
const TIER_REGISTRY: Record<string, Tier> = {
  // --- tier 1 ---
  'base-analyzer.ts': 1,
  'deployable-evidence.ts': 1,
  'dependency-manifest.ts': 1,
  'reachability-index.ts': 1,

  // --- tier 2 ---
  'system-type.ts': 2,
  'framework-identity.ts': 2,
  'dependency-roles.ts': 2,
  'paradigm-conformance.ts': 2,
  'node-roles.ts': 2,
  // Re-tiered 3 -> 2 in the same commit that registered node-roles.ts: its
  // own imports are a single tier-1 TYPE (CASGuardKind) and it classifies a
  // wrapper NAME by structural convention (auth/rate-limit/validation
  // vocabulary) — the textbook tier-2 "convention" shape, not a
  // comprehension (capability/flow/entity) concept. It was reachable only
  // from journey-builder.ts (tier 3) before this commit, which is presumably
  // why it landed there; it is already imported directly by ~25 tier-1
  // language/framework analyzers (go-analyzer.ts among them) and by
  // node-roles.ts (tier 2) here, both of which the tier-1-importing-tier-3
  // shape would have made illegal reads. Moving it to its actual tier fixes
  // the registry rather than working around it.
  'guard-classification.ts': 2,

  // --- tier 3 ---
  'capability-detector.ts': 3,
  'capability-naming.ts': 3,
  'capability-dependency-builder.ts': 3,
  'entity-relations.ts': 3,
  'flow-graph-builder.ts': 3,
  'flow-concepts.ts': 3,
  'journey-builder.ts': 3,
};

function extractLocalImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  // Matches `import ... from '...'`, `export ... from '...'`, and bare
  // `import '...'` — deliberately not a full parser: this file set is
  // small, hand-registered, and reviewed at registration time, and a
  // regex over `from '(...)'`/`from "(...)"` is what every import/export
  // form in this codebase's style actually uses.
  const re = /(?:from|import)\s+['"](\.[^'"]*)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    specifiers.push(m[1]);
  }
  return specifiers;
}

function resolveToRegistryKey(fromFile: string, specifier: string): string | null {
  const resolved = path.resolve(path.dirname(fromFile), specifier);
  const withExt = resolved.endsWith('.ts') ? resolved : `${resolved}.ts`;
  const rel = path.relative(CORE_DIR, withExt);
  // Only resolve specifiers that land directly in CORE_DIR (one path
  // segment, no further subdirectory) — that's the shape every entry in
  // TIER_REGISTRY has today.
  if (rel.includes(path.sep) || rel.startsWith('..')) return null;
  return rel;
}

describe('tier-boundary gate (docs/SPEC-ABSTRACTION-TIERS.md dependency rule)', () => {
  const registeredFiles = Object.keys(TIER_REGISTRY);

  it('every registered file exists (registry is not stale)', () => {
    for (const file of registeredFiles) {
      const full = path.join(CORE_DIR, file);
      expect(fs.existsSync(full)).toBe(true);
    }
  });

  it.each(registeredFiles)('%s does not import a higher tier', (file) => {
    const tier = TIER_REGISTRY[file];
    const full = path.join(CORE_DIR, file);
    const source = fs.readFileSync(full, 'utf8');
    const specifiers = extractLocalImportSpecifiers(source);

    const violations: string[] = [];
    for (const spec of specifiers) {
      const key = resolveToRegistryKey(full, spec);
      if (!key || !(key in TIER_REGISTRY)) continue; // unregistered import: not this gate's concern
      const importedTier = TIER_REGISTRY[key];
      if (importedTier > tier) {
        violations.push(`${file} (tier ${tier}) imports ${key} (tier ${importedTier})`);
      }
    }

    expect(violations).toEqual([]);
  });
});
