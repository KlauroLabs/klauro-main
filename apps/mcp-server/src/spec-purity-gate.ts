




































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




export const EXCLUDED_EVIDENCE_PATH_RE =
  /\/(test|tests|fixture|fixtures|__tests__|gauntlet|bench|benchmark|corpus)\//i;
export const EXCLUDED_EVIDENCE_FILE_RE =
  /(\.test|\.spec|-test|benchmark|-bench|gauntlet|-corpus|-eval|-fixture)[^/]*\.[jt]sx?$/i;




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




const NAME_TOKEN = `[a-z][a-z0-9]*(?:-[a-z0-9]+){0,4}`;
const NAME_TOKEN_RE = new RegExp(`^${NAME_TOKEN}$`);











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


  }
  return names;
}







const DEV_PATH_NAME_RE = new RegExp(`~\\/dev\\/(?:[\\w.-]+\\/)?(${NAME_TOKEN})`, 'g');














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














const CONTEXT_SHAPE_PATTERNS = [
  new RegExp(`\\b(?:customer|client)(?:'s)?\\s+(?:repo|repository|codebase|project)\\b[^.\\n]{0,40}?['"\`]?(${NAME_TOKEN})['"\`]?`, 'gi'),
  new RegExp(`\\bbenchmarked\\s+(?:against|on|with)\\s+['"\`]?(${NAME_TOKEN})`, 'gi'),
];


































function hasNameSignal(raw: string, line: string, tokenIndex: number): boolean {
  if (/[-_.]/.test(raw)) return true;
  if (/^[A-Z]/.test(raw)) return true;
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
