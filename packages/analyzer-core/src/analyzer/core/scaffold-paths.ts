/**
 * Centralized "is this the analyzed repo's OWN test/fixture scaffolding"
 * predicate — the single source of truth every evidence/entry-point/
 * framework/capability/journey collector must consult before minting
 * product-facing facts from a file.
 *
 * WHY THIS EXISTS: a directory literally named fixtures/, __fixtures__/,
 * testdata/, cas-tests/, or __tests__/ (or a co-located test-named file,
 * e.g. foo.test.ts / foo.spec.ts) ships sample manifests/servers/apps used
 * to exercise the analyzer's
 * OWN detection logic — it is never a real deployable, entry point, journey,
 * capability, or framework of the analyzed repo. Before this module existed,
 * the exclusion glob list was hand-copied across at least three places
 * (base-analyzer.ts's getIgnorePatterns, orchestrator.ts's
 * getProjectDiscoveryIgnorePatterns/isIgnoredInventoryDirectory, and
 * deployable-evidence/util.ts's IGNORE_GLOBS) and at least two real
 * collectors bypassed all of them entirely:
 *  - IacAnalyzer.getIgnorePatterns() (iac-analyzer.ts) overrode the
 *    inherited comprehensive list with a hand-rolled 8-pattern list that
 *    omitted fixtures/** — so HelmAnalyzer (a IacAnalyzer subclass) walked
 *    apps/mcp-server/fixtures/deployable-detection/helm-service/templates/**
 *    as if it were the analyzed repo's own Kubernetes topology, minting a
 *    real "Helm Service (orders-service) :80" entry point + "helm install
 *    orders-service" deployable + capability from Klauro's own test fixture.
 *  - BaseAnalyzer.getPackageDirSafeIgnorePatterns() (base-analyzer.ts)
 *    strips ANY of samples/examples/fixtures/testdata from the ignore list
 *    for JVM-family analyzers, because a real reversed-domain Java package
 *    (org.springframework.samples.<app>) can legitimately contain a
 *    directory segment named "samples". But "fixtures"/"testdata" are not a
 *    realistic JVM package segment the way "samples"/"examples" are — always
 *    stripping all four let KotlinAnalyzer walk
 *    apps/mcp-server/fixtures/component-bench/compose-tree/App.kt and mint a
 *    duplicate "Android Activity: MainActivity" entry point from Klauro's own
 *    Compose-tree test fixture.
 *
 * Test-suite-facing consumers are the deliberate exception: get_test_summary
 * must still COUNT files under these directories as tests. Only PRODUCT
 * surfaces (entry points, deployables, journeys, capabilities, framework
 * detection) consult this predicate.
 */

/** Directory basenames that are always the analyzed repo's own test/fixture
 *  scaffolding, never real product structure — regardless of language/
 *  ecosystem. Unlike samples/examples (which collide with real JVM package
 *  segments), none of these five are plausible real package/module names. */
export const SCAFFOLD_DIR_NAMES: readonly string[] = [
  'fixtures',
  '__fixtures__',
  'testdata',
  'cas-tests',
  '__tests__',
];

/** Glob ignore patterns (both root-relative and globstar-anchored) for every
 *  scaffold directory name — the shape every `glob()`/`safeGlobSync()` caller
 *  passes as its `ignore` option. */
export const SCAFFOLD_GLOBS: string[] = SCAFFOLD_DIR_NAMES.flatMap(name => [`${name}/**`, `**/${name}/**`]);

export function isScaffoldDirName(name: string): boolean {
  return SCAFFOLD_DIR_NAMES.includes(name);
}

/** True when any path segment of `relativePath` is a scaffold directory name. */
export function pathHasScaffoldSegment(relativePath: string): boolean {
  const normalized = (relativePath || '').replace(/\\/g, '/');
  return normalized.split('/').some(isScaffoldDirName);
}

/**
 * Co-located test-file naming conventions (`foo.test.ts` sitting next to
 * `foo.ts`, `test_foo.py`, `foo_test.go`, ...) — test code that lives OUTSIDE
 * any fixtures/__tests__ directory, so directory-name exclusion alone misses
 * it. This is the gap behind the open "ai-stack-analyzer scans test files
 * with no exclusion" finding: AIStackAnalyzer globs `**\/*.{ts,tsx,js,...,py}`
 * through `getIgnorePatterns()` (which only denies directory names), so a
 * co-located `foo.test.ts` that itself contains a `new ChatOpenAI(...)` call
 * (exercising the AI-stack detector) is indistinguishable from real product
 * code without this filename check.
 */
const TEST_FILE_NAME_PATTERN = /(\.(test|spec)\.[a-z0-9]+$)|(^test_[^/]*\.py$)|(_test\.(py|go|rb)$)|(\.test\.rb$)/i;

export function isTestFileName(fileName: string): boolean {
  return TEST_FILE_NAME_PATTERN.test(fileName || '');
}

/** The full predicate: true when `relativePath` is either inside a scaffold
 *  directory or is itself a co-located test file. */
export function isScaffoldOrTestPath(relativePath: string): boolean {
  const normalized = (relativePath || '').replace(/\\/g, '/');
  if (pathHasScaffoldSegment(normalized)) return true;
  const basename = normalized.split('/').pop() || '';
  return isTestFileName(basename);
}
