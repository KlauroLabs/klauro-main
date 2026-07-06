import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * GUARD against the "three analyzer registration lists" footgun
 * (~/.klauro/agent-feedback/2026-07-04-fastify-cron.md,
 * ~/.klauro/agent-feedback/2026-07-04-registration-consolidation.md).
 *
 * There is exactly ONE live registration path: createOrchestrator() in
 * apps/mcp-server/src/analyzer.ts. It is the only list wired into the
 * deployed product (Dockerfile.analyzer -> `npm run analyzer-server` ->
 * remote-analyzer-service.ts -> getOrchestrator()/createOrchestrator()) and
 * into analyzeForBench. Two other analyzer-registration-shaped lists exist in
 * this codebase for non-product reasons:
 *
 *   - packages/analyzer-core/src/analyzer/frameworks/index.ts
 *     (FRAMEWORK_ANALYZERS) — benchmark-grid metadata only
 *     (apps/mcp-server/src/gauntlet/full-grid.ts), never drives real analysis.
 *   - packages/analyzer-core/src/analyzer/services/cas-analyzer.service.ts
 *     (CASAnalyzerService.registerAnalyzers()) — belongs to a NestJS app
 *     (packages/analyzer-core/src/main.ts -> AppModule) that is never
 *     bootstrapped in production or CI.
 *
 * A new analyzer implementation added to disk but never wired into
 * apps/mcp-server/src/analyzer.ts's createOrchestrator() will *look* done
 * (file exists, may even have its own passing unit tests) while silently
 * never running against a real repo. This test makes that impossible to miss:
 * it enumerates every concrete `*Analyzer` class file under
 * analyzer/{languages,frameworks,libraries} and asserts each one is
 * instantiated (`new ClassName(`) somewhere in the live registration file.
 *
 * This is a static-source-text check, not a runtime one: parsing the live
 * file's registration arrays into structured data isn't necessary — a
 * textual `new ClassName(` occurrence is sufficient evidence the class is
 * reachable from createOrchestrator(), including indirect registration via
 * architectureLibraryAnalyzerDefinitions().map(...) for the
 * *LibraryAnalyzer family (those are on the ALLOWLIST below because they're
 * registered by iterating a function's return value, not by a literal
 * `new ClassName(` call site).
 */

const REPO_ROOT = path.resolve(__dirname, '../../..');
const ANALYZER_CORE_SRC = path.join(REPO_ROOT, 'packages/analyzer-core/src/analyzer');
const LIVE_REGISTRATION_FILE = path.join(REPO_ROOT, 'apps/mcp-server/src/analyzer.ts');

const SCAN_DIRS = ['languages', 'frameworks', 'libraries'].map(d => path.join(ANALYZER_CORE_SRC, d));

/**
 * Classes registered indirectly (not via a literal `new ClassName(` in the
 * live file) because they're constructed inside
 * architectureLibraryAnalyzerDefinitions() and registered by spreading that
 * function's return value. Verified separately below by asserting the live
 * file actually spreads architectureLibraryAnalyzerDefinitions() into its
 * library registrations.
 */
const INDIRECTLY_REGISTERED_VIA_ARCHITECTURE_DEFINITIONS = new Set([
  'ArchitecturalLibraryAnalyzer', // abstract-ish base used by the concrete ones below; not itself instantiated
  'ActorSystemLibraryAnalyzer',
  'AuthPaymentBoundaryLibraryAnalyzer',
  'DependencyInjectionLibraryAnalyzer',
  'MediatorCqrsLibraryAnalyzer',
  'MessageBrokerLibraryAnalyzer',
  'PersistenceLibraryAnalyzer',
  'QueueLibraryAnalyzer',
  'RuntimeSupportLibraryAnalyzer',
  'ServiceSdkLibraryAnalyzer',
  'StateMachineLibraryAnalyzer',
  'WorkflowEngineLibraryAnalyzer',
]);

function listTsFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFilesRecursive(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.integration.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

interface DiscoveredAnalyzerClass {
  className: string;
  file: string;
}

function discoverAnalyzerClasses(): DiscoveredAnalyzerClass[] {
  const found: DiscoveredAnalyzerClass[] = [];
  const classDeclRe = /^export class ([A-Za-z0-9_]+Analyzer)\b.*extends\s+BaseAnalyzer/m;
  for (const dir of SCAN_DIRS) {
    for (const file of listTsFilesRecursive(dir)) {
      const content = fs.readFileSync(file, 'utf8');
      // A file may define multiple analyzer classes (e.g. architectural-library-analyzer.ts).
      const re = /^export class ([A-Za-z0-9_]+Analyzer)\b[^\n]*extends\s+BaseAnalyzer/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content))) {
        found.push({ className: m[1], file: path.relative(REPO_ROOT, file) });
      }
    }
  }
  return found;
}

test('every concrete analyzer class is wired into the live createOrchestrator() registration in apps/mcp-server/src/analyzer.ts', () => {
  const liveSource = fs.readFileSync(LIVE_REGISTRATION_FILE, 'utf8');

  // Sanity-check the indirect-registration escape hatch is still real: if this
  // ever stops being true, the *LibraryAnalyzer allowlist below would be
  // hiding a real dead-registration bug.
  assert.ok(
    /architectureLibraryAnalyzerDefinitions\(\)\.map\(/.test(liveSource),
    'expected createOrchestrator() to still spread architectureLibraryAnalyzerDefinitions() ' +
    '(the *LibraryAnalyzer family is allowlisted below on the assumption this indirect ' +
    'registration path is exercised — if it was removed, those analyzers would now be silently dead)'
  );

  const discovered = discoverAnalyzerClasses();
  assert.ok(discovered.length > 20, `expected to discover a substantial number of analyzer classes, found ${discovered.length} — the scan globs may be broken`);

  const silentlyDead: DiscoveredAnalyzerClass[] = [];
  for (const { className, file } of discovered) {
    if (INDIRECTLY_REGISTERED_VIA_ARCHITECTURE_DEFINITIONS.has(className)) continue;
    const instantiated = new RegExp(`\\bnew ${className}\\s*\\(`).test(liveSource);
    if (!instantiated) {
      silentlyDead.push({ className, file });
    }
  }

  assert.deepEqual(
    silentlyDead,
    [],
    `Found analyzer class(es) implemented on disk but NEVER instantiated in the live ` +
    `registration path (apps/mcp-server/src/analyzer.ts createOrchestrator()). These analyzers ` +
    `silently never run against a real repo, even though they may have their own passing unit ` +
    `tests: ${JSON.stringify(silentlyDead, null, 2)}. Fix: import the class and add a ` +
    `registerAnalyzer()-shaped entry in createOrchestrator(), or if the class is genuinely not ` +
    `meant to run standalone (e.g. an internal helper class), rename it to not match ` +
    `*Analyzer-extends-BaseAnalyzer, or add it to the documented allowlist in this test with a ` +
    `comment explaining why.`
  );
});

test('inline registration ids equal the analyzer instance self-id (no id drift)', async () => {
  // Drift class from docs/CORPUS-DEPTH-SWEEP.md #5: a registration `{ id: 'x',
  // ... analyzer: new Foo() }` where `new Foo().id === 'y'`. The orchestrator
  // keys its map on the registration id, but every node/tag/contribution stamps
  // the analyzer's OWN id (analyzer_id / `analyzer:<id>` / source_analyzer), so a
  // mismatch makes node-level consumers unable to correlate the analyzer's
  // output back to its registration. Guard: for every inline `{ id: '...',
  // ... analyzer: new ClassName() }` in the live file, the two must be equal.
  const liveSource = fs.readFileSync(LIVE_REGISTRATION_FILE, 'utf8');
  // className -> absolute source file, from the same on-disk scan used above.
  const classFile = new Map<string, string>();
  for (const { className, file } of discoverAnalyzerClasses()) {
    if (!classFile.has(className)) classFile.set(className, path.join(REPO_ROOT, file));
  }

  // Match inline registration objects: capture the string id and the class of
  // the no-arg `analyzer: new ClassName()`. (Indirect registrations via
  // architectureLibraryAnalyzerDefinitions() already share one id source and are
  // out of scope here.)
  const inlineRe = /\{\s*id:\s*'([^']+)'[\s\S]*?analyzer:\s*new\s+([A-Za-z0-9_]+)\s*\(\s*\)/g;
  const mismatches: Array<{ registrationId: string; className: string; selfId: string }> = [];
  let m: RegExpExecArray | null;
  let checked = 0;
  while ((m = inlineRe.exec(liveSource)) !== null) {
    const [, registrationId, className] = m;
    const file = classFile.get(className);
    if (!file) continue; // not a BaseAnalyzer class discovered on disk
    const mod = await import(file);
    const Ctor = (mod as Record<string, any>)[className];
    if (typeof Ctor !== 'function') continue;
    let instance: any;
    try {
      instance = new Ctor();
    } catch {
      continue; // constructor needs args — not an inline no-arg registration
    }
    if (typeof instance?.id !== 'string') continue;
    checked += 1;
    if (instance.id !== registrationId) {
      mismatches.push({ registrationId, className, selfId: instance.id });
    }
  }

  assert.ok(checked > 5, `expected to check several inline registrations, only checked ${checked} — the parse may be broken`);
  assert.deepEqual(
    mismatches,
    [],
    `Registration id(s) drift from the analyzer instance's own id (super() id). The orchestrator ` +
    `keys on the registration id while nodes carry the self-id, so these analyzers' nodes cannot be ` +
    `correlated to their registration: ${JSON.stringify(mismatches, null, 2)}. Fix: make the ` +
    `registration \`id:\` in apps/mcp-server/src/analyzer.ts equal the id passed to super() in the ` +
    `analyzer class.`
  );
});

test('the two non-live analyzer-registration-shaped lists are not silently consumed as if they were live', () => {
  // packages/analyzer-core/src/analyzer/frameworks/index.ts: FRAMEWORK_ANALYZERS must only be
  // imported by the benchmark grid, not by any production entry point.
  const frameworksIndexConsumers = grepRepoForImportersOf('FRAMEWORK_ANALYZERS');
  const unexpectedFrameworksConsumers = frameworksIndexConsumers.filter(
    f => !f.includes('gauntlet/full-grid.ts') &&
      !f.includes('frameworks/index.ts') &&
      !f.includes('live-analyzer-registration.test.ts') &&
      // doc-comment mention only ("aligns with FRAMEWORK_ANALYZERS `languages`"), not an import/usage
      !f.includes('core/language-registry.ts')
  );
  assert.deepEqual(
    unexpectedFrameworksConsumers,
    [],
    `FRAMEWORK_ANALYZERS (packages/analyzer-core/src/analyzer/frameworks/index.ts) is meant to be ` +
    `benchmark-grid-only metadata, consumed only by full-grid.ts. New consumer(s) found: ` +
    `${JSON.stringify(unexpectedFrameworksConsumers)} — if this is a real product code path, it ` +
    `must instead read from apps/mcp-server/src/analyzer.ts's createOrchestrator()/` +
    `listRegisteredAnalyzers(), not this dead list.`
  );

  // CASAnalyzerService: must only be consumed by the never-bootstrapped legacy NestJS app
  // (analysis/analyzer modules) and its own tests, not by any live analyzer.ts / MCP entry point.
  const casServiceConsumers = grepRepoForImportersOf('CASAnalyzerService');
  const unexpectedCasServiceConsumers = casServiceConsumers.filter(
    f => f.startsWith('apps/mcp-server/src/') && !f.includes('.test.ts')
  );
  assert.deepEqual(
    unexpectedCasServiceConsumers,
    [],
    `CASAnalyzerService (packages/analyzer-core/src/analyzer/services/cas-analyzer.service.ts) is ` +
    `legacy/dead-path code (never-bootstrapped NestJS app). Found it imported from a live ` +
    `apps/mcp-server production file: ${JSON.stringify(unexpectedCasServiceConsumers)} — if the MCP ` +
    `product now depends on it, this test's assumptions are stale and need updating; otherwise this ` +
    `is a real registration-path bug.`
  );
});

function grepRepoForImportersOf(symbol: string): string[] {
  const hits: string[] = [];
  const roots = [
    path.join(REPO_ROOT, 'apps/mcp-server/src'),
    path.join(REPO_ROOT, 'packages/analyzer-core/src'),
  ];
  for (const root of roots) {
    for (const file of listTsFilesRecursiveIncludingTests(root)) {
      const content = fs.readFileSync(file, 'utf8');
      if (content.includes(symbol)) {
        hits.push(path.relative(REPO_ROOT, file));
      }
    }
  }
  return hits;
}

function listTsFilesRecursiveIncludingTests(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...listTsFilesRecursiveIncludingTests(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}
