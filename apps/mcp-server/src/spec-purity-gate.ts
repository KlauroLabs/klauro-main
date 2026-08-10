/**
 * Spec-purity gate — evidence-derived forbidden-name set, not a hand-maintained
 * literal list (open item #71).
 *
 * Klauro's specs and shipped product source (comments included) must read as
 * repo-agnostic: they explain the ANALYZER's behavior, not any one customer's
 * or benchmark's codebase. The previous gate was a single hand-typed
 * BENCHMARK_CORPUS_NAMES string in deploy.sh — it only ever caught a name
 * someone remembered to add. A brand-new customer or corpus repo sailed
 * through silently, and already had, once.
 *
 * This module derives the forbidden set from evidence instead of a list:
 *
 *   (a) ACCOUNT EVIDENCE — the real, non-fixture project/workspace names this
 *       machine's account has actually analyzed (same discovery logic the
 *       gauntlet's corpus-sweep uses to separate genuine repos from fixtures
 *       and transient artifacts). That IS "the set of client/benchmark
 *       products" — read from the account, never typed by hand.
 *   (b) EVIDENCE-PATH NAMES — names that already appear, legitimately, inside
 *       this repo's own excluded evidence paths (tests / fixtures / gauntlet /
 *       bench / corpus). Those paths are excluded from the gate specifically
 *       because naming corpus repos is their job — so any repo-shaped literal
 *       found there is, by construction, a corpus name, and is folded into
 *       the forbidden set automatically instead of being re-typed elsewhere.
 *   (c) SHAPE/CONTEXT HEURISTIC (fail-closed) — prose that grammatically
 *       reads as naming a customer/benchmark repo ("the <x> repo", "customer
 *       <x>", "benchmarked against <x>", "client <x>'s codebase") is flagged
 *       even when <x> is in neither (a) nor (b), because a name nobody has
 *       seen yet is exactly the case a static list can never catch. This is
 *       "fail closed on a name it cannot classify": an unrecognized name in
 *       one of these contexts is treated as a violation, not silently passed.
 *
 * Existing exclusions are preserved: test/fixture/gauntlet/bench/corpus paths
 * are still allowed to name real corpora — only shipped product source and
 * doctrine/spec docs are gated.
 */

import * as fs from 'fs-extra';
import * as path from 'path';

export interface SpecPurityViolation {
  file: string;
  line: number;
  text: string;
  name: string;
  reason: 'known-corpus-name' | 'unclassified-name-shape';
}

export interface SpecPurityResult {
  ok: boolean;
  forbiddenNames: string[];
  violations: SpecPurityViolation[];
}

// --- path classification -----------------------------------------------

/** Paths whose whole job is to reference real corpus/benchmark repos by name. */
export const EXCLUDED_EVIDENCE_PATH_RE =
  /\/(test|tests|fixture|fixtures|__tests__|gauntlet|bench|benchmark|corpus)\//i;
export const EXCLUDED_EVIDENCE_FILE_RE =
  /(\.test|\.spec|-test|benchmark|-bench|gauntlet|-corpus|-eval|-fixture)[^/]*\.[jt]sx?$/i;
// A short, explicit list of files that are allowed to narrate corpus-adjacent
// detail even though they aren't in one of the path/name shapes above (kept
// from the original deploy.sh exclusion — these are dogfood-measurement
// scripts, not doctrine).
export const ALLOWED_MEASUREMENT_FILES = [
  'agent-scratch-dogfood-build.ts',
  'agent-adoption-measurement.ts',
  'agent-task-family-coverage.ts',
];

export function isExcludedEvidencePath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  if (EXCLUDED_EVIDENCE_PATH_RE.test(`/${normalized}/`)) return true;
  if (EXCLUDED_EVIDENCE_FILE_RE.test(normalized)) return true;
  return ALLOWED_MEASUREMENT_FILES.some(name => normalized.endsWith(`/${name}`) || normalized === name);
}

const GATED_SOURCE_ROOTS = ['packages/analyzer-core/src', 'apps/mcp-server/src'];
const GATED_DOC_GLOBS = [
  'docs/ARCHITECTURE.md',
  'docs/UNDERSTANDING-MODEL.md',
  'docs/COVERAGE-INTELLIGENCE.md',
];

// --- name shape ----------------------------------------------------------

/** A plausible repo/project-name token: kebab-case, 3+ chars, starts with a letter. */
const NAME_TOKEN = `[a-z][a-z0-9]*(?:-[a-z0-9]+){0,4}`;
const NAME_TOKEN_RE = new RegExp(`^${NAME_TOKEN}$`);

// Generic English/prose words that shape-match a kebab-case name but are
// never themselves a repo. This is a noise filter, not a customer-name
// list — the two are categorically different (one hides doctrine violations,
// the other keeps ordinary engineering prose like "the whole repo" or "the
// analyzed codebase" from tripping a shape heuristic built to catch proper
// nouns). Also includes "soon" specifically: it is both a real internal
// workspace name AND an extremely common English adverb, so literal
// single-word matching on it is unsafe — the context-shape heuristic below
// still catches it correctly in an actually suspicious sentence ("the
// customer repo soon", "benchmarked against soon") regardless of this list.
const GENERIC_STOPWORDS = new Set([
  'customer', 'customers', 'client', 'clients', 'benchmark', 'benchmarks',
  'repo', 'repos', 'repository', 'codebase', 'project', 'projects', 'same',
  'this', 'that', 'above', 'given', 'target', 'source', 'corpus',
  'whole', 'best', 'analyzed', 'dominant', 'real', 'whose', 'hardcoded',
  'short', 'selected', 'full', 'primary', 'mounted', 'every', 'names',
  'intended', 'wrong', 'current', 'git', 'owning', 'flat', 'generic',
  'sanitized', 'entire', 'proposed', 'core', 'synthetic', 'compact', 'must',
  'identical', 'self', 'soon', 'other', 'another', 'affected', 'underlying',
  'resulting', 'final', 'original', 'local', 'remote', 'shared', 'common',
  'specific', 'particular', 'relevant', 'matching', 'changed', 'modified',
  'existing', 'host', 'main',
]);

// Compound tokens whose FIRST segment is a generic engineering/role noun
// (admin-api, orders-api, client-ui, mobile-app, frontend-app, single-api) —
// illustrative example service names, not proper nouns. A real corpus name
// following this same <word>-<suffix> shape (acme-api, acme-ui) has a
// non-generic first segment and is unaffected.
const GENERIC_FIRST_SEGMENT = new Set([
  'admin', 'orders', 'order', 'client', 'clients', 'mobile', 'frontend',
  'backend', 'user', 'users', 'payment', 'payments', 'billing', 'auth',
  'gateway', 'worker', 'workers', 'single', 'product', 'products', 'web',
  'desktop', 'internal', 'external', 'public', 'shared', 'common', 'service',
  'services', 'app', 'apps', 'api', 'core',
]);

function isPlausibleName(token: string): boolean {
  if (token.length < 3 || token.length > 40) return false;
  if (GENERIC_STOPWORDS.has(token)) return false;
  if (!NAME_TOKEN_RE.test(token)) return false;
  const firstSegment = token.split('-', 1)[0];
  if (token.includes('-') && GENERIC_FIRST_SEGMENT.has(firstSegment)) return false;
  return true;
}

// --- (a) account evidence -------------------------------------------------

/**
 * Real analyzed project/workspace names known to this account, via the same
 * fixture/transient-filtering discovery the gauntlet's corpus tooling uses.
 * Best-effort: a clean checkout with no local storage yields an empty set,
 * which is fine — sources (b) and (c) still apply.
 */
export async function collectAccountCorpusNames(): Promise<Set<string>> {
  const names = new Set<string>();
  try {
    const { listAnalyses } = await import('./storage');
    const { discoverAllRealRepoEntries } = await import('./gauntlet/corpus');
    const entries = await listAnalyses();
    for (const entry of discoverAllRealRepoEntries(entries)) {
      const token = entry.name.toLowerCase();
      if (isPlausibleName(token)) names.add(token);
    }
  } catch {
    // No reachable local storage (fresh checkout, CI, isolated worktree) —
    // account evidence is simply empty; this must never throw the gate.
  }
  return names;
}

// --- (b) evidence-path names ----------------------------------------------

// `~/dev/<name>` is a real, specific convention (this repo's own corpus
// tooling lists actual workspace roots this way, e.g. LEAD_WORKSPACES in
// corpus-sweep.ts) — single-word real repo names (acme, soon) are common
// here, so no extra shape requirement.
const DEV_PATH_NAME_RE = new RegExp(`~\\/dev\\/(?:[\\w.-]+\\/)?(${NAME_TOKEN})`, 'g');

// `/tmp/<name>` and `analysis:<name>` are ALSO how ordinary unit-test mocks
// spell an arbitrary placeholder root_path/analysis_id (e.g. `root_path:
// '/tmp/high-fanout'`, `'machine-analysis:agent-context-ready'` — descriptive
// mock ids picked for the test's own purpose, not real repo names; even
// hyphenation doesn't reliably tell these apart from a real
// `/tmp/acme-api`). So these two contexts are trusted only when the token's
// FIRST segment cross-validates against a name already confirmed via the
// more specific `~/dev/` convention above (e.g. `/tmp/acme-api` is trusted
// because `acme` independently shows up in a real `~/dev/acme` reference;
// `/tmp/high-fanout` is not, because nothing ever references `~/dev/high`).
// `analysis:` additionally requires a quote or string-start immediately
// before it, so a label like `'machine-analysis:quality'` (analysis: as a
// mid-string suffix, not a real analysis-id convention) never matches.
const HYPHENATED_TMP_OR_ANALYSIS_RE = new RegExp(
  `(?:\\/tmp\\/|(?<![\\w-])analysis:)([a-z][a-z0-9]*(?:-[a-z0-9]+){1,4})`,
  'g',
);

export async function collectEvidencePathCorpusNames(repoRoot: string): Promise<Set<string>> {
  const names = new Set<string>();
  const candidateCompounds = new Set<string>();
  const files = await walkFiles(repoRoot, relPath => isExcludedEvidencePath(relPath));
  for (const file of files) {
    let content: string;
    try {
      content = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    for (const match of content.matchAll(DEV_PATH_NAME_RE)) {
      const token = match[1].toLowerCase();
      if (isPlausibleName(token)) names.add(token);
    }
    for (const match of content.matchAll(HYPHENATED_TMP_OR_ANALYSIS_RE)) {
      const token = match[1].toLowerCase();
      if (isPlausibleName(token)) candidateCompounds.add(token);
    }
  }
  for (const compound of candidateCompounds) {
    const firstSegment = compound.split('-', 1)[0];
    if (names.has(firstSegment) || names.has(compound)) names.add(compound);
  }
  return names;
}

// --- (c) shape/context heuristic (fail-closed) ----------------------------

// Grammatical contexts where prose is naming a customer/benchmark repo,
// regardless of whether that name is in the forbidden set yet. This is what
// lets the gate catch a NEW name the very first time it appears — the whole
// point of item #71. Deliberately scoped to phrasing that specifically
// signals "this is someone else's repo" (customer/client framing,
// "benchmarked against") rather than a bare "the X repo/codebase" — English
// is full of adjectives before "repo" ("the whole repo", "the analyzed repo",
// "the current repo"), and a bare pattern like `the (\w+) repo` flags nearly
// every one of them. Kept as independent patterns (rather than one
// alternation) so that one pattern's match cannot consume the text a
// different pattern needed further along the same line.
const CONTEXT_SHAPE_PATTERNS = [
  new RegExp(`\\b(?:customer|client)(?:'s)?\\s+(?:repo|repository|codebase|project)\\b[^.\\n]{0,40}?['"\`]?(${NAME_TOKEN})['"\`]?`, 'gi'),
  new RegExp(`\\bbenchmarked\\s+(?:against|on|with)\\s+['"\`]?(${NAME_TOKEN})`, 'gi'),
];

/**
 * Does this token, AS WRITTEN, carry a signal that it is a NAME rather than prose?
 *
 * The context patterns above locate the phrase ("a client repo …") and then capture
 * the first word-shaped token within 40 characters. That lazy window is why the
 * phrase alone is not enough evidence: on the real comment
 *
 *     // deadline was supplied, so a real client repo (4,810 files/85,652 nodes)
 *
 * it matched "client repo", skipped " (4,810 ", and captured `files` — blocking a
 * deploy over ordinary English. `bounded` tripped it the same way on another line.
 * Both comments were already correctly generic: they describe a subject repo
 * without naming it, which is exactly what the rule asks for.
 *
 * Filtering that by extending GENERIC_STOPWORDS would be the wrong fix twice over:
 * it is unbounded (every English word that can follow the phrase), and a hardcoded
 * word list deciding a classification is the precise defect class this project has
 * spent the day removing from the product. So use STRUCTURE instead of vocabulary.
 *
 * A product/repo name appearing in prose is essentially always marked as a name —
 * quoted, backticked, capitalised, or multi-segment (`spring-petclinic`,
 * `acme.widgets`). Bare lowercase single-word English is prose. Requiring one of
 * those signals keeps every real case the detector exists for (`the client repo
 * "acme-widgets"`, `the client's codebase AcmeCorp`) while prose stops blocking
 * deploys — which matters because a gate that cries wolf gets bypassed, and then
 * it protects nothing.
 */
function hasNameSignal(raw: string, line: string, tokenIndex: number): boolean {
  if (/[-_.]/.test(raw)) return true;                       // multi-segment: spring-petclinic
  if (/^[A-Z]/.test(raw)) return true;                       // proper noun: AcmeCorp
  const preceding = tokenIndex > 0 ? line[tokenIndex - 1] : '';
  return preceding === '"' || preceding === "'" || preceding === '`';
}

function findContextShapeMatches(line: string): string[] {
  const found: string[] = [];
  for (const pattern of CONTEXT_SHAPE_PATTERNS) {
    for (const match of line.matchAll(pattern)) {
      const raw = match[1] || '';
      if (!raw) continue;
      const tokenIndex = line.indexOf(raw, match.index ?? 0);
      if (!hasNameSignal(raw, line, tokenIndex)) continue;
      const token = raw.toLowerCase();
      if (isPlausibleName(token)) found.push(token);
    }
  }
  return found;
}

// --- scanning --------------------------------------------------------------

// Tokenizes a line into every maximal kebab-case run so it can be checked
// against the forbidden set by O(1) membership rather than compiling one
// `\bname\b` RegExp per forbidden name per line — the forbidden set is
// evidence-derived and can run into the hundreds of names on a real repo, and
// this gate runs over every gated source file on every deploy.
const LINE_TOKEN_RE = new RegExp(`\\b${NAME_TOKEN}\\b`, 'gi');

function tokenizeLine(lower: string): string[] {
  return [...lower.matchAll(LINE_TOKEN_RE)].map(m => m[0]);
}

export function scanContentForViolations(
  file: string,
  content: string,
  forbiddenNames: Set<string>,
): SpecPurityViolation[] {
  const violations: SpecPurityViolation[] = [];
  const lines = content.split('\n');
  lines.forEach((line, index) => {
    const lower = line.toLowerCase();
    const seenOnLine = new Set<string>();
    for (const token of tokenizeLine(lower)) {
      if (seenOnLine.has(token) || !forbiddenNames.has(token)) continue;
      seenOnLine.add(token);
      violations.push({ file, line: index + 1, text: line.trim(), name: token, reason: 'known-corpus-name' });
    }
    for (const name of findContextShapeMatches(line)) {
      if (seenOnLine.has(name)) continue;
      seenOnLine.add(name);
      violations.push({ file, line: index + 1, text: line.trim(), name, reason: 'unclassified-name-shape' });
    }
  });
  return violations;
}

// --- filesystem walk -------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-hosted', '.git', '.cache', 'coverage', 'build']);

async function walkFiles(root: string, includeRelPath: (relPath: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  async function recurse(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs);
      if (entry.isDirectory()) {
        await recurse(abs);
      } else if (/\.[jt]sx?$|\.md$/.test(entry.name)) {
        if (includeRelPath(rel)) out.push(abs);
      }
    }
  }
  await recurse(root);
  return out;
}

async function listGatedSourceFiles(repoRoot: string): Promise<string[]> {
  const files: string[] = [];
  for (const root of GATED_SOURCE_ROOTS) {
    const abs = path.join(repoRoot, root);
    if (!(await fs.pathExists(abs))) continue;
    const found = await walkFiles(abs, relPath => !isExcludedEvidencePath(path.join(root, relPath)));
    files.push(...found);
  }
  for (const doc of GATED_DOC_GLOBS) {
    const abs = path.join(repoRoot, doc);
    if (await fs.pathExists(abs)) files.push(abs);
  }
  const specDir = path.join(repoRoot, 'docs');
  if (await fs.pathExists(specDir)) {
    const entries = await fs.readdir(specDir);
    for (const entry of entries) {
      if (/^SPEC.*\.md$/.test(entry)) files.push(path.join(specDir, entry));
    }
  }
  for (const sub of ['was', 'cas']) {
    const abs = path.join(repoRoot, 'docs', sub);
    if (await fs.pathExists(abs)) {
      const found = await walkFiles(abs, () => true);
      files.push(...found);
    }
  }
  return [...new Set(files)];
}

// --- entry point -------------------------------------------------------

// The product's OWN name(s) are never a "client/benchmark product" leak —
// this repo, its packages, and its own directory basename all narrate
// themselves constantly and legitimately.
const SELF_PRODUCT_NAMES = new Set(['klauro', 'mcp-server', 'analyzer-core', 'proof-of-concept']);

export async function runSpecPurityGate(repoRoot: string): Promise<SpecPurityResult> {
  const [accountNames, evidencePathNames] = await Promise.all([
    collectAccountCorpusNames(),
    collectEvidencePathCorpusNames(repoRoot),
  ]);
  const forbiddenNames = new Set<string>([...accountNames, ...evidencePathNames]);
  forbiddenNames.delete(path.basename(repoRoot).toLowerCase());
  for (const self of SELF_PRODUCT_NAMES) forbiddenNames.delete(self);

  const files = await listGatedSourceFiles(repoRoot);
  const violations: SpecPurityViolation[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const relFile = path.relative(repoRoot, file);
    violations.push(...scanContentForViolations(relFile, content, forbiddenNames));
  }

  return { ok: violations.length === 0, forbiddenNames: [...forbiddenNames].sort(), violations };
}
