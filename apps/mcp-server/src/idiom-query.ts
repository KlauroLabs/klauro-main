import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type {
  CASCodebaseIdiom,
  CASIdiomCategory,
  CASIdiomViolation,
  CASOutput,
} from '../../../packages/analyzer-core/src/types/cas.types';

type GateStatus = 'pass' | 'warn' | 'fail';

export interface IdiomQueryOptions {
  category?: CASIdiomCategory | string;
  target?: string;
  limit?: number;
  offset?: number;
  minConfidence?: number;
}

export interface IdiomValidationOptions extends IdiomQueryOptions {
  files?: string[];
  diffText?: string;
  includeWorkingTree?: boolean;
  allowFileReads?: boolean;
}

interface DiffCollection {
  changedFiles: string[];
  diffText: string;
  warnings: string[];
}

const SOURCE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|cs|java|php|dart)$/i;
const TEST_PATH = /(^|\/)(__tests__|tests?|spec|e2e|cypress)(\/|$)|(\.|_|-)(test|spec|cy)\.[a-z0-9]+$/i;
const MIGRATION_PATH = /(^|\/)(migrations?|db\/migrate|prisma\/migrations)(\/|$)|migration/i;
const SCHEMA_PATH = /(^|\/)(schema|models?|entities?|database|prisma)(\/|$)|(\.prisma|schema\.sql)$/i;

export function getCodebaseIdioms(cas: CASOutput, opts: IdiomQueryOptions = {}) {
  const idioms = selectIdioms(cas, opts);
  const limit = opts.limit || 25;
  const offset = opts.offset || 0;
  return {
    total: idioms.length,
    offset,
    limit,
    summary: cas.idiom_summary || summarizeSelectedIdioms(idioms),
    idioms: idioms.slice(offset, offset + limit).map(compactIdiom),
  };
}

export function getIdiomExamples(cas: CASOutput, opts: IdiomQueryOptions & { idiomId?: string } = {}) {
  const idioms = opts.idiomId
    ? (cas.codebase_idioms || []).filter(idiom => idiom.id === opts.idiomId)
    : selectIdioms(cas, opts);
  const idiomIds = new Set(idioms.map(idiom => idiom.id));
  let examples = (cas.idiom_examples || [])
    .filter(example => idiomIds.has(example.idiom_id) || !opts.idiomId);

  if (opts.target) {
    const target = opts.target.toLowerCase();
    examples = examples.filter(example =>
      [example.file, example.name, example.explanation, example.node_id].filter(Boolean).join(' ').toLowerCase().includes(target)
    );
  }

  const limit = opts.limit || 25;
  const offset = opts.offset || 0;
  return {
    total: examples.length,
    offset,
    limit,
    examples: examples.slice(offset, offset + limit),
  };
}

export function buildIdiomContextForAgent(
  cas: CASOutput,
  opts: IdiomQueryOptions & { files?: string[]; maxTokens?: number } = {}
) {
  const selectedByTarget = selectIdioms(cas, opts);
  const idiomPool = selectedByTarget.length > 0 || !opts.target
    ? selectedByTarget
    : selectIdioms(cas, { ...opts, target: undefined });
  const idioms = idiomPool
    .sort((left, right) => right.confidence - left.confidence || right.prevalence - left.prevalence)
    .slice(0, opts.limit || 8);
  const files = (opts.files || []).map(normalizePath);
  const relevant = files.length > 0
    ? idioms.filter(idiom => idiomMatchesAnyFile(idiom, files) || idiom.category === 'testing')
    : idioms;
  const selected = relevant.length > 0 ? relevant : idioms.slice(0, 5);
  const examples = selected.flatMap(idiom => idiom.positive_examples.slice(0, 2).map(example => ({
    idiom_id: idiom.id,
    category: idiom.category,
    file: example.file,
    line: example.line,
    explanation: example.explanation,
  }))).slice(0, 10);
  const guidanceById = new Map(selected.map(idiom => [idiom.id, guidanceForIdiom(idiom)]));

  return {
    total_idioms: cas.codebase_idioms?.length || 0,
    target_resolution_note: selectedByTarget.length === 0 && opts.target && idioms.length > 0
      ? `No idioms matched target "${opts.target}" directly; returned file/global idioms instead.`
      : undefined,
    selected_idioms: selected.map(idiom => ({
      id: idiom.id,
      category: idiom.category,
      name: idiom.name,
      confidence: idiom.confidence,
      prevalence: idiom.prevalence,
      do: guidanceById.get(idiom.id)!.do.slice(0, 3),
      avoid: guidanceById.get(idiom.id)!.avoid.slice(0, 3),
      validation: guidanceById.get(idiom.id)!.validation.slice(0, 3),
    })),
    local_examples: examples,
    do: unique(selected.flatMap(idiom => guidanceById.get(idiom.id)!.do)).slice(0, 12),
    avoid: unique(selected.flatMap(idiom => guidanceById.get(idiom.id)!.avoid)).slice(0, 12),
    validation: unique([
      ...selected.flatMap(idiom => guidanceById.get(idiom.id)!.validation),
      'After edits, call validate_codebase_idioms for changed files or the working diff.',
    ]).slice(0, 12),
    likely_violations: selected.flatMap(idiom => (idiom.deviations || []).slice(0, 2)).slice(0, 8),
  };
}

function guidanceForIdiom(idiom: CASCodebaseIdiom): { do: string[]; avoid: string[]; validation: string[] } {
  const localFiles = [
    ...(idiom.affected_scopes.files || []),
    ...idiom.positive_examples.map(example => example.file).filter(Boolean) as string[],
  ];
  const exampleHint = localFiles.length > 0
    ? ` Use local example ${compactPathTail(localFiles[0])} first.`
    : '';
  const fallback = fallbackGuidanceForCategory(idiom.category, idiom.name, exampleHint);
  return {
    do: unique([...(idiom.agent_guidance?.do || []), fallback.do]).filter(Boolean),
    avoid: unique([...(idiom.agent_guidance?.avoid || []), fallback.avoid]).filter(Boolean),
    validation: unique([...(idiom.agent_guidance?.validation || []), fallback.validation]).filter(Boolean),
  };
}

function compactPathTail(file: string): string {
  return normalizePath(file)
    .split('/')
    .filter(Boolean)
    .slice(-5)
    .join('/');
}

function fallbackGuidanceForCategory(
  category: CASIdiomCategory,
  name: string,
  exampleHint: string
): { do: string; avoid: string; validation: string } {
  const label = name || `${category} idiom`;
  switch (category) {
    case 'naming':
      return {
        do: `Match the local naming idiom: ${label}.${exampleHint}`,
        avoid: 'Do not introduce alternate names for the same role when local suffix/prefix examples exist.',
        validation: 'Check changed declarations against nearby naming examples.',
      };
    case 'file-organization':
      return {
        do: `Place new code beside related feature/module files in the existing source layout.${exampleHint}`,
        avoid: 'Do not create a parallel folder structure for adjacent behavior.',
        validation: 'Check changed files against affected idiom scopes.',
      };
    case 'module-boundary':
      return {
        do: `Keep imports and ownership inside the local boundary implied by ${label}.${exampleHint}`,
        avoid: 'Do not reach across module boundaries when a local export/owner exists.',
        validation: 'Review imports and changed files for boundary drift.',
      };
    case 'dependency-injection':
      return {
        do: `Construct collaborators the way the local dependency-injection idiom does.${exampleHint}`,
        avoid: 'Do not new-up services or repositories inside handlers when local code injects them.',
        validation: 'Check constructor/provider/module wiring after edits.',
      };
    case 'data-access':
      return {
        do: `Use the local data-access boundary for persistence changes.${exampleHint}`,
        avoid: 'Do not add direct database calls from unrelated presentation or controller layers.',
        validation: 'Check repository/ORM usage and related tests.',
      };
    case 'error-handling':
      return {
        do: `Use the local error-handling style for failures.${exampleHint}`,
        avoid: 'Do not introduce generic thrown errors when local framework/domain errors exist.',
        validation: 'Review new error paths and tests for local error contracts.',
      };
    case 'validation':
      return {
        do: `Put input validation where this repo normally validates data.${exampleHint}`,
        avoid: 'Do not scatter ad hoc validation into unrelated business logic.',
        validation: 'Check DTO/schema/request validation and focused tests.',
      };
    case 'auth-tenant-scope':
      return {
        do: `Preserve auth, permission, and tenant/org scope boundaries.${exampleHint}`,
        avoid: 'Do not add bypass paths around guards, scoped repositories, or tenant filters.',
        validation: 'Run or add focused auth/tenant-scope checks for touched behavior.',
      };
    case 'logging':
      return {
        do: `Use the local logging abstraction and event shape.${exampleHint}`,
        avoid: 'Do not commit console/print debugging where logger usage exists.',
        validation: 'Check new logs for local logger usage and useful context.',
      };
    case 'testing':
      return {
        do: `Use the local test placement and style for behavior changes.${exampleHint}`,
        avoid: 'Do not skip focused tests when matching test files or patterns exist.',
        validation: 'Run the nearest focused tests before finalizing.',
      };
    case 'migrations':
      return {
        do: `Use the repo-local migration path for schema/model changes.${exampleHint}`,
        avoid: 'Do not edit persisted schema/model files without migration review.',
        validation: 'Check migration files whenever schema/entity/model files change.',
      };
    case 'async-style':
      return {
        do: `Follow the local async/concurrency style.${exampleHint}`,
        avoid: 'Do not mix callbacks, unawaited promises, or blocking calls into async paths without local precedent.',
        validation: 'Check async error handling and completion semantics.',
      };
    case 'configuration':
      return {
        do: `Use the repo-local configuration surface for runtime settings.${exampleHint}`,
        avoid: 'Do not hard-code runtime settings inside feature logic.',
        validation: 'Check config files, env parsing, and defaults after edits.',
      };
    default:
      return {
        do: `Follow the local idiom: ${label}.${exampleHint}`,
        avoid: 'Do not introduce an alternate convention without a local example or explicit reason.',
        validation: 'Run validate_codebase_idioms after edits.',
      };
  }
}

export function validateCodebaseIdioms(
  cas: CASOutput,
  projectPath: string,
  opts: IdiomValidationOptions = {}
) {
  const workingTree = opts.includeWorkingTree === false
    ? { changedFiles: normalizeFiles(opts.files || parseFilesFromDiff(opts.diffText || '')), diffText: opts.diffText || '', warnings: [] }
    : collectWorkingTreeDiff(projectPath, opts);
  const changedFiles = normalizeFiles(workingTree.changedFiles);
  const sourceFiles = changedFiles.filter(file => SOURCE_EXTENSIONS.test(file) && !isTestPath(file) && !isMigrationPath(file));
  const testFiles = changedFiles.filter(isTestPath);
  const migrationFiles = changedFiles.filter(isMigrationPath);
  const schemaFiles = changedFiles.filter(isSchemaPath);
  const idioms = selectIdioms(cas, opts);
  const impacts = idioms.map(idiom => idiomImpact(
    idiom,
    changedFiles,
    workingTree.diffText,
    projectPath,
    opts.allowFileReads !== false,
  ));
  const matched = impacts.filter(impact => impact.impact_score > 0);
  const violations = [
    ...workingTree.warnings.map((warning, index) => validationViolation('working-tree-warning', 'file-organization', 'warning', undefined, warning, 'Review the working tree warning before trusting idiom validation.', index)),
    ...matched.flatMap(impact => impact.violations),
    ...crossCuttingViolations(idioms, sourceFiles, testFiles, migrationFiles, schemaFiles, workingTree.diffText),
  ];
  const status = aggregateStatus(violations.map(item => item.severity === 'error' ? 'fail' : item.severity === 'warning' ? 'warn' : 'pass'));

  return {
    status,
    generated_at: new Date().toISOString(),
    path: projectPath,
    target: opts.target || null,
    diff_source: opts.diffText ? 'provided-diff' : opts.files?.length || opts.includeWorkingTree === false ? 'explicit-files' : 'working-tree',
    changed_files: changedFiles,
    diff_summary: {
      changed_files: changedFiles.length,
      source_files: sourceFiles.length,
      test_files: testFiles.length,
      migration_files: migrationFiles.length,
      schema_files: schemaFiles.length,
    },
    idiom_summary: cas.idiom_summary || null,
    impacted_idioms: matched.map(impact => ({
      idiom_id: impact.idiom.id,
      category: impact.idiom.category,
      name: impact.idiom.name,
      confidence: impact.idiom.confidence,
      impact_score: impact.impact_score,
      matched_files: impact.matched_files,
      required_checks: impact.required_checks,
    })),
    violations,
    required_checks: unique([
      ...matched.flatMap(impact => impact.required_checks),
      ...violations.map(item => item.recommendation),
    ]),
    next_steps: nextSteps(status, matched.length, violations.length, testFiles.length, migrationFiles.length),
  };
}

function selectIdioms(cas: CASOutput, opts: IdiomQueryOptions): CASCodebaseIdiom[] {
  let idioms = cas.codebase_idioms || [];
  if (opts.category) idioms = idioms.filter(idiom => idiom.category === opts.category);
  if (typeof opts.minConfidence === 'number') idioms = idioms.filter(idiom => idiom.confidence >= opts.minConfidence!);
  if (opts.target) {
    const target = opts.target.toLowerCase();
    const targetNode = cas.nodes.find(node => node.id === opts.target);
    idioms = idioms.filter(idiom => {
      const text = [
        idiom.id,
        idiom.name,
        idiom.description,
        idiom.category,
        ...(idiom.affected_scopes.files || []),
        ...(idiom.affected_scopes.file_globs || []),
        ...(idiom.affected_scopes.node_ids || []),
        ...(idiom.affected_scopes.node_types || []),
        ...(idiom.agent_guidance.do || []),
        ...(idiom.agent_guidance.avoid || []),
      ].join(' ').toLowerCase();
      const targetFile = targetNode?.source?.file;
      return text.includes(target) ||
        Boolean(targetFile && idiomMatchesAnyFile(idiom, [targetFile])) ||
        idiomMatchesAnyFile(idiom, [opts.target!]);
    });
  }
  return idioms;
}

function compactIdiom(idiom: CASCodebaseIdiom) {
  return {
    id: idiom.id,
    category: idiom.category,
    name: idiom.name,
    description: idiom.description,
    confidence: idiom.confidence,
    prevalence: idiom.prevalence,
    evidence_count: idiom.evidence.length,
    evidence: idiom.evidence.slice(0, 6),
    examples: idiom.positive_examples.slice(0, 4),
    affected_scopes: idiom.affected_scopes,
    agent_guidance: idiom.agent_guidance,
    deviation_count: idiom.deviations?.length || 0,
    deviations: idiom.deviations?.slice(0, 5) || [],
  };
}

function summarizeSelectedIdioms(idioms: CASCodebaseIdiom[]) {
  const byCategory: Record<string, number> = {};
  for (const idiom of idioms) byCategory[idiom.category] = (byCategory[idiom.category] || 0) + 1;
  return {
    total: idioms.length,
    high_confidence: idioms.filter(idiom => idiom.confidence >= 0.8).length,
    violations: idioms.reduce((total, idiom) => total + (idiom.deviations?.length || 0), 0),
    by_category: byCategory,
    top_idioms: idioms.slice(0, 8).map(idiom => idiom.id),
  };
}

function idiomImpact(
  idiom: CASCodebaseIdiom,
  changedFiles: string[],
  diffText: string,
  projectPath: string,
  allowFileReads: boolean,
) {
  const scopedFiles = (idiom.affected_scopes.files || []).map(normalizePath);
  const exampleFiles = idiom.positive_examples.map(example => example.file).filter(Boolean).map(normalizePath);
  const matchedFiles = changedFiles.filter(file =>
    scopedFiles.some(scoped => pathsCompatible(file, scoped)) ||
    exampleFiles.some(example => pathsCompatible(file, example)) ||
    idiomMatchesAnyFile(idiom, [file])
  );
  const terms = unique([
    idiom.name,
    idiom.category,
    ...idiom.name.split(/\s+/),
    ...idiom.agent_guidance.do,
    ...idiom.agent_guidance.avoid,
  ].map(term => term.toLowerCase()).filter(term => term.length >= 4));
  const matchedTerms = terms.filter(term => diffText.toLowerCase().includes(term));
  const impactScore = Math.min(100, matchedFiles.length * 35 + matchedTerms.length * 5);
  const violations: CASIdiomViolation[] = [];

  for (const file of changedFiles) {
    const fileText = allowFileReads ? readFileIfSafe(projectPath, file) : addedTextForFile(diffText, file);
    if (idiom.category === 'naming') {
      violations.push(...namingViolations(idiom, file, fileText));
    }
    if (idiom.category === 'error-handling' && /\bthrow\s+new\s+Error\b/.test(diffText)) {
      violations.push(validationViolation(idiom.id, 'error-handling', 'warning', file, 'Generic Error introduced while local idiom favors framework/domain errors.', 'Use the nearby framework/domain-specific error type or justify the exception.', 0));
    }
    if (idiom.category === 'logging' && /\b(console\.log|print\(|dbg!)\b/.test(diffText)) {
      violations.push(validationViolation(idiom.id, 'logging', 'warning', file, 'Debug/console logging introduced while local idiom favors a logger abstraction.', 'Use the local logger abstraction or remove transient debugging output.', 0));
    }
  }

  return {
    idiom,
    impact_score: impactScore,
    matched_files: matchedFiles,
    required_checks: [
      ...idiom.agent_guidance.validation,
      ...(matchedFiles.length > 0 ? [`Review changed files against idiom ${idiom.id}: ${matchedFiles.join(', ')}`] : []),
    ],
    violations,
  };
}

function addedTextForFile(diffText: string, targetFile: string): string {
  const normalizedTarget = normalizePath(targetFile);
  let currentFile = '';
  const lines: string[] = [];
  for (const line of diffText.split('\n')) {
    const header = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (header) {
      currentFile = normalizePath(header[2]);
      continue;
    }
    const addedFile = line.match(/^\+\+\+ b\/(.+)$/);
    if (addedFile) {
      currentFile = normalizePath(addedFile[1]);
      continue;
    }
    if (currentFile === normalizedTarget && line.startsWith('+') && !line.startsWith('+++')) {
      lines.push(line.slice(1));
    }
  }
  return lines.join('\n');
}

function namingViolations(idiom: CASCodebaseIdiom, file: string, fileText: string): CASIdiomViolation[] {
  if (!fileText) return [];
  const suffix = suffixFromIdiom(idiom);
  if (!suffix) return [];
  if (!normalizePath(file).toLowerCase().includes(suffix.toLowerCase())) return [];
  const declarations = [...fileText.matchAll(/\b(?:class|interface|type|function)\s+([A-Za-z_][A-Za-z0-9_]*)/g)]
    .map(match => match[1])
    .filter(Boolean);
  return declarations
    .filter(name => !name.endsWith(suffix))
    .slice(0, 3)
    .map((name, index) => validationViolation(idiom.id, 'naming', 'warning', file, `${name} does not match local ${suffix} suffix naming.`, `Rename ${name} to use the ${suffix} suffix or choose a nearby established exception.`, index));
}

function suffixFromIdiom(idiom: CASCodebaseIdiom): string | null {
  const match = idiom.name.match(/\b(Controller|Service|Repository|Guard|Module|Dto|Resolver)\b/);
  return match?.[1] || null;
}

function crossCuttingViolations(
  idioms: CASCodebaseIdiom[],
  sourceFiles: string[],
  testFiles: string[],
  migrationFiles: string[],
  schemaFiles: string[],
  diffText: string
): CASIdiomViolation[] {
  const violations: CASIdiomViolation[] = [];
  if (schemaFiles.length > 0 && migrationFiles.length === 0 && idioms.some(idiom => idiom.category === 'migrations')) {
    violations.push(validationViolation('migrations-schema-changes-use-migrations', 'migrations', 'error', schemaFiles[0], 'Schema/model files changed without a migration file in the same diff.', 'Add or update the repo-local migration artifact for the schema change.', 0));
  }
  const behaviorTouched = /auth|tenant|organization|permission|role|guard|scope/i.test(diffText) || sourceFiles.some(file => /auth|tenant|organization|permission|role|guard|scope/i.test(file));
  if (behaviorTouched && testFiles.length === 0 && idioms.some(idiom => idiom.category === 'auth-tenant-scope')) {
    violations.push(validationViolation('auth-tenant-scope-preserved-through-boundaries', 'auth-tenant-scope', 'warning', sourceFiles[0], 'Auth/tenant-sensitive behavior changed without a focused test file in the same diff.', 'Update or run focused tests covering the auth/tenant boundary.', 0));
  }
  if (sourceFiles.length > 0 && testFiles.length === 0 && idioms.some(idiom => idiom.category === 'testing')) {
    violations.push(validationViolation('testing-local-focused-test-files', 'testing', 'warning', sourceFiles[0], 'Source behavior changed but no local test file changed.', 'Inspect nearby tests and update them when the behavior changed.', 0));
  }
  return violations;
}

function validationViolation(
  idiomId: string,
  category: CASIdiomCategory,
  severity: CASIdiomViolation['severity'],
  file: string | undefined,
  description: string,
  recommendation: string,
  index: number
): CASIdiomViolation {
  return {
    id: `${idiomId}-validation-${index + 1}`,
    idiom_id: idiomId,
    category,
    severity,
    file,
    description,
    recommendation,
  };
}

function collectWorkingTreeDiff(projectPath: string, opts: IdiomValidationOptions): DiffCollection {
  const warnings: string[] = [];
  let changedFiles = normalizeFiles(opts.files || []);
  let diffText = opts.diffText || '';
  try {
    if (changedFiles.length === 0) {
      const names = execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: projectPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      changedFiles = normalizeFiles(names.split('\n').filter(Boolean));
    }
    if (!diffText) {
      diffText = execFileSync('git', ['diff', '--no-ext-diff', 'HEAD'], { cwd: projectPath, encoding: 'utf8', maxBuffer: 1024 * 1024 * 20, stdio: ['ignore', 'pipe', 'pipe'] });
    }
  } catch (error) {
    warnings.push(`Could not read git working tree diff: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { changedFiles, diffText, warnings };
}

function parseFilesFromDiff(diffText: string): string[] {
  const files = new Set<string>();
  for (const line of diffText.split('\n')) {
    const match = line.match(/^\+\+\+\s+b\/(.+)$/) || line.match(/^---\s+a\/(.+)$/);
    if (match?.[1] && match[1] !== '/dev/null') files.add(match[1]);
  }
  return [...files];
}

function readFileIfSafe(projectPath: string, file: string): string {
  const absolute = path.resolve(projectPath, file);
  if (!absolute.startsWith(path.resolve(projectPath))) return '';
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > 1024 * 1024) return '';
    return fs.readFileSync(absolute, 'utf8');
  } catch {
    return '';
  }
}

function idiomMatchesAnyFile(idiom: CASCodebaseIdiom, files: string[]): boolean {
  const normalizedFiles = files.map(normalizePath);
  const scopedFiles = (idiom.affected_scopes.files || []).map(normalizePath);
  if (normalizedFiles.some(file => scopedFiles.some(scoped => pathsCompatible(file, scoped)))) return true;
  const globs = idiom.affected_scopes.file_globs || [];
  return normalizedFiles.some(file => globs.some(glob => globLikeMatch(file, glob)));
}

function globLikeMatch(file: string, glob: string): boolean {
  const normalizedGlob = normalizePath(glob)
    .replace(/\*\*\//g, '')
    .replace(/\*/g, '')
    .replace(/[{}]/g, '')
    .toLowerCase();
  const normalizedFile = normalizePath(file).toLowerCase();
  if (normalizedGlob.includes(',')) {
    return normalizedGlob.split(',').some(part => part && normalizedFile.includes(part.replace(/\./g, '')));
  }
  return normalizedFile.includes(normalizedGlob.replace(/\./g, '')) ||
    normalizedGlob.split('/').some(part => part.length > 2 && normalizedFile.includes(part));
}

function nextSteps(status: GateStatus, impacted: number, violations: number, tests: number, migrations: number): string[] {
  const steps = [`Review ${impacted} impacted idioms before finalizing.`];
  if (violations > 0) steps.push('Resolve or explicitly justify idiom violations in the final answer.');
  if (tests === 0) steps.push('If behavior changed, inspect the local test idiom and add/update focused tests.');
  if (migrations === 0) steps.push('If schema changed, add the repo-local migration artifact.');
  if (status === 'pass') steps.push('No blocking idiom violations detected.');
  return steps;
}

function aggregateStatus(statuses: GateStatus[]): GateStatus {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'warn';
  return 'pass';
}

function normalizeFiles(files: string[]): string[] {
  return unique(files.map(normalizePath).filter(Boolean));
}

function normalizePath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}

function pathsCompatible(left: string, right: string): boolean {
  const normalizedLeft = normalizePath(left).toLowerCase();
  const normalizedRight = normalizePath(right).toLowerCase();
  return normalizedLeft === normalizedRight || normalizedLeft.endsWith(`/${normalizedRight}`) || normalizedRight.endsWith(`/${normalizedLeft}`);
}

function isTestPath(file: string): boolean {
  return TEST_PATH.test(normalizePath(file));
}

function isMigrationPath(file: string): boolean {
  return MIGRATION_PATH.test(normalizePath(file));
}

function isSchemaPath(file: string): boolean {
  return SCHEMA_PATH.test(normalizePath(file));
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
