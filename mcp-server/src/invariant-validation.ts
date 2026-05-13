import { execFileSync } from 'child_process';
import * as path from 'path';
import type { CASBehavioralInvariant, CASOutput } from '../../backend/src/types/cas.types';

type GateStatus = 'pass' | 'warn' | 'fail';

export interface InvariantValidationOptions {
  target?: string;
  invariantType?: string;
  files?: string[];
  diffText?: string;
  includeWorkingTree?: boolean;
  limit?: number;
}

interface DiffCollection {
  changedFiles: string[];
  diffText: string;
  warnings: string[];
}

export interface InvariantImpact {
  invariant_id: string;
  name: string;
  invariant_type: string;
  confidence: string;
  status: GateStatus;
  impact_score: number;
  matched_files: string[];
  matched_terms: string[];
  touched_tests: string[];
  touched_migrations: string[];
  gaps: string[];
  required_checks: string[];
  evidence: unknown[];
}

export function assessBehavioralInvariantImpact(
  cas: CASOutput,
  opts: { target?: string; files?: string[]; diffText?: string; invariantType?: string; limit?: number } = {}
) {
  const changedFiles = normalizeFiles(opts.files || parseFilesFromDiff(opts.diffText || ''));
  const diffText = opts.diffText || '';
  const invariants = selectInvariants(cas, opts);
  const impacts = invariants
    .map(invariant => buildInvariantImpact(invariant, changedFiles, diffText, opts.target))
    .filter(impact => impact.impact_score > 0)
    .sort((left, right) => right.impact_score - left.impact_score)
    .slice(0, opts.limit || 25);

  return {
    status: aggregateStatus(impacts.map(impact => impact.status)),
    target: opts.target || null,
    changed_files: changedFiles,
    impacted_count: impacts.length,
    impacted_invariants: impacts,
    required_checks: uniqueStrings(impacts.flatMap(impact => impact.required_checks)),
  };
}

export function validateBehavioralInvariants(
  cas: CASOutput,
  projectPath: string,
  opts: InvariantValidationOptions = {}
) {
  const workingTree = opts.includeWorkingTree === false
    ? { changedFiles: normalizeFiles(opts.files || parseFilesFromDiff(opts.diffText || '')), diffText: opts.diffText || '', warnings: [] }
    : collectWorkingTreeDiff(projectPath, opts);
  const impact = assessBehavioralInvariantImpact(cas, {
    target: opts.target,
    files: workingTree.changedFiles,
    diffText: opts.diffText || workingTree.diffText,
    invariantType: opts.invariantType,
    limit: opts.limit,
  });
  const changedFiles = workingTree.changedFiles;
  const testFiles = changedFiles.filter(isTestPath);
  const migrationFiles = changedFiles.filter(isMigrationPath);
  const schemaFiles = changedFiles.filter(isSchemaPath);
  const sourceFiles = changedFiles.filter(file => !isTestPath(file) && !isMigrationPath(file));
  const extraFailures: string[] = [];
  const extraWarnings: string[] = [...workingTree.warnings];

  const dbImpacted = impact.impacted_invariants.some(invariant =>
    ['db-constraint', 'migration-contract', 'tenant-scope'].includes(invariant.invariant_type)
  );
  if (dbImpacted && schemaFiles.length > 0 && migrationFiles.length === 0) {
    extraFailures.push('Database/schema files changed without a migration file in the same diff.');
  }

  const behaviorImpacted = impact.impacted_invariants.some(invariant =>
    ['tenant-scope', 'auth-boundary', 'authorization', 'business-rule'].includes(invariant.invariant_type)
  );
  if (behaviorImpacted && sourceFiles.length > 0 && testFiles.length === 0) {
    extraWarnings.push('Behavioral invariant impacted but no test file changed in the diff.');
  }

  const status: GateStatus = extraFailures.length > 0
    ? 'fail'
    : aggregateStatus([...impact.impacted_invariants.map(invariant => invariant.status), ...extraWarnings.map(() => 'warn' as GateStatus)]);

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
    invariant_impact: impact,
    failures: extraFailures,
    warnings: extraWarnings,
    required_checks: uniqueStrings([
      ...impact.required_checks,
      ...extraFailures.map(failure => `Resolve: ${failure}`),
      ...extraWarnings.map(warning => `Review: ${warning}`),
    ]),
    next_steps: nextSteps(status, impact.impacted_invariants.length, testFiles.length, migrationFiles.length, schemaFiles.length, extraWarnings.length),
  };
}

function selectInvariants(
  cas: CASOutput,
  opts: { target?: string; invariantType?: string }
): CASBehavioralInvariant[] {
  let invariants = cas.behavioral_invariants || [];
  if (opts.invariantType) {
    invariants = invariants.filter(invariant => invariant.invariant_type === opts.invariantType);
  }
  if (!opts.target) return invariants;

  const targetInput = opts.target;
  const target = targetInput.toLowerCase();
  const targetNode = cas.nodes.find(node => node.id === targetInput);
  return invariants.filter(invariant => {
    const scope = invariant.scope || {};
    const scopedFiles = [
      ...(scope.file_paths || []),
      ...(invariant.related_tests || []),
      ...invariant.enforcement.map(point => point.file).filter((file): file is string => Boolean(file)),
      ...invariant.evidence.map(evidence => evidence.file).filter((file): file is string => Boolean(file)),
    ];
    const targetFile = targetNode?.source?.file;
    const targetText = [
      invariant.id,
      invariant.name,
      invariant.description,
      ...(scope.entity_names || []),
      ...(scope.field_names || []),
      ...(scope.node_ids || []),
      ...scopedFiles,
    ].join(' ').toLowerCase();
    return Boolean(
      scope.node_ids?.includes(targetInput) ||
      (targetFile && scopedFiles.some(file => pathsCompatible(file, targetFile))) ||
      targetText.includes(target)
    );
  });
}

function buildInvariantImpact(
  invariant: CASBehavioralInvariant,
  changedFiles: string[],
  diffText: string,
  target?: string
): InvariantImpact {
  const scopedFiles = uniqueStrings([
    ...(invariant.scope.file_paths || []),
    ...(invariant.related_tests || []),
    ...invariant.enforcement.map(point => point.file).filter((file): file is string => Boolean(file)),
    ...invariant.evidence.map(evidence => evidence.file).filter((file): file is string => Boolean(file)),
  ]);
  const matchedFiles = changedFiles.filter(file => scopedFiles.some(scoped => pathsCompatible(file, scoped)));
  const terms = uniqueStrings([
    invariant.name,
    ...(invariant.scope.entity_names || []),
    ...(invariant.scope.field_names || []),
    ...invariant.name.split(/\s+/),
  ].map(term => term.toLowerCase()).filter(term => term.length >= 3));
  const matchedTerms = terms.filter(term => {
    const normalized = term.replace(/[^a-z0-9]+/g, '').toLowerCase();
    const text = diffText.toLowerCase();
    return text.includes(term) || (normalized.length >= 4 && text.replace(/[^a-z0-9]+/g, '').includes(normalized));
  });
  const targetMatch = Boolean(target && (
    invariant.scope.node_ids?.includes(target) ||
    invariant.scope.file_paths?.some(file => pathsCompatible(file, target)) ||
    [
      invariant.id,
      invariant.name,
      invariant.description,
      ...(invariant.scope.entity_names || []),
      ...(invariant.scope.field_names || []),
      ...(invariant.scope.file_paths || []),
    ].join(' ').toLowerCase().includes(target.toLowerCase())
  ));
  const touchedTests = changedFiles.filter(file =>
    isTestPath(file) && (invariant.related_tests || []).some(testFile => pathsCompatible(file, testFile))
  );
  const touchedMigrations = changedFiles.filter(isMigrationPath);
  const impactScore = Math.min(100,
    matchedFiles.length * 35 +
    matchedTerms.length * 12 +
    (targetMatch ? 35 : 0) +
    (invariant.gaps?.length ? 10 : 0)
  );
  const checks = checksForInvariant(invariant, touchedTests, touchedMigrations);
  const status = statusForInvariant(invariant, impactScore, touchedTests, touchedMigrations, changedFiles);
  return {
    invariant_id: invariant.id,
    name: invariant.name,
    invariant_type: invariant.invariant_type,
    confidence: invariant.confidence,
    status,
    impact_score: impactScore,
    matched_files: matchedFiles,
    matched_terms: matchedTerms.slice(0, 12),
    touched_tests: touchedTests,
    touched_migrations: touchedMigrations,
    gaps: invariant.gaps || [],
    required_checks: checks,
    evidence: invariant.evidence.slice(0, 8),
  };
}

function statusForInvariant(
  invariant: CASBehavioralInvariant,
  impactScore: number,
  touchedTests: string[],
  touchedMigrations: string[],
  changedFiles: string[]
): GateStatus {
  if (impactScore === 0) return 'pass';
  const schemaTouched = changedFiles.some(isSchemaPath);
  if (schemaTouched && ['db-constraint', 'migration-contract'].includes(invariant.invariant_type) && touchedMigrations.length === 0) {
    return 'fail';
  }
  if (['tenant-scope', 'auth-boundary', 'authorization', 'business-rule'].includes(invariant.invariant_type) && touchedTests.length === 0) {
    return 'warn';
  }
  if ((invariant.gaps || []).some(gap => gap.toLowerCase().includes('unique field')) && touchedTests.length === 0) {
    return 'warn';
  }
  return 'pass';
}

function checksForInvariant(
  invariant: CASBehavioralInvariant,
  touchedTests: string[],
  touchedMigrations: string[]
): string[] {
  const checks = [`Preserve invariant: ${invariant.name}`];
  if (invariant.invariant_type === 'tenant-scope') {
    checks.push('Verify tenant/org scope is included in reads, writes, uniqueness checks, and authorization decisions.');
  }
  if (invariant.invariant_type === 'auth-boundary' || invariant.invariant_type === 'authorization') {
    checks.push('Verify auth/authorization enforcement points are still invoked and bypass paths are covered.');
  }
  if (invariant.invariant_type === 'db-constraint') {
    checks.push('Verify ORM/database constraints are preserved and migrations reflect schema changes.');
  }
  if (invariant.invariant_type === 'migration-contract') {
    checks.push(touchedMigrations.length > 0 ? 'Review migration file changes against schema changes.' : 'Add or verify migration coverage for database schema changes.');
  }
  if (touchedTests.length > 0) {
    checks.push(`Run focused invariant tests: ${touchedTests.join(', ')}`);
  } else if (invariant.related_tests?.length) {
    checks.push(`Run or update related tests: ${invariant.related_tests.slice(0, 5).join(', ')}`);
  }
  for (const gap of invariant.gaps || []) {
    checks.push(`Resolve invariant gap: ${gap}`);
  }
  return uniqueStrings(checks);
}

function collectWorkingTreeDiff(projectPath: string, opts: InvariantValidationOptions): DiffCollection {
  if (opts.files?.length || opts.diffText) {
    return {
      changedFiles: normalizeFiles(opts.files || parseFilesFromDiff(opts.diffText || '')),
      diffText: opts.diffText || '',
      warnings: [],
    };
  }
  if (!isGitWorkTree(projectPath)) {
    return {
      changedFiles: [],
      diffText: '',
      warnings: ['Could not read a git working tree. Provide files or diff_text to validate explicit changes.'],
    };
  }
  const unstaged = gitOutput(projectPath, ['diff', '--name-only', '--relative']);
  const staged = gitOutput(projectPath, ['diff', '--cached', '--name-only', '--relative']);
  const untracked = gitOutput(projectPath, ['ls-files', '--others', '--exclude-standard']);
  const diffText = [
    gitOutput(projectPath, ['diff', '--no-ext-diff', '--relative']),
    gitOutput(projectPath, ['diff', '--cached', '--no-ext-diff', '--relative']),
  ].filter(Boolean).join('\n');
  return {
    changedFiles: normalizeFiles([...unstaged.split('\n'), ...staged.split('\n'), ...untracked.split('\n')]),
    diffText,
    warnings: [],
  };
}

function isGitWorkTree(cwd: string): boolean {
  return gitOutput(cwd, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
}

function gitOutput(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 * 20, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

function parseFilesFromDiff(diffText: string): string[] {
  const files: string[] = [];
  for (const line of diffText.split('\n')) {
    const diffMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (diffMatch) {
      files.push(diffMatch[1], diffMatch[2]);
      continue;
    }
    const markerMatch = line.match(/^(?:\+\+\+|---) [ab]\/(.+)$/);
    if (markerMatch) files.push(markerMatch[1]);
  }
  return files;
}

function normalizeFiles(files: string[]): string[] {
  return uniqueStrings(files
    .map(file => file.trim())
    .filter(Boolean)
    .filter(file => file !== '/dev/null')
    .map(file => file.replace(/\\/g, '/').replace(/^\.\//, '')));
}

function isTestPath(file: string): boolean {
  return /(\.(spec|test)\.[cm]?[jt]sx?|_test\.(py|go|rs)|\.test\.py)$/i.test(file);
}

function isMigrationPath(file: string): boolean {
  const normalized = file.replace(/\\/g, '/').toLowerCase();
  return normalized.includes('/migrations/') ||
    normalized.includes('/migration/') ||
    normalized.includes('prisma/migrations') ||
    /(^|\/)migrations\/.+\.(ts|js|sql|php|py)$/.test(normalized);
}

function isSchemaPath(file: string): boolean {
  const normalized = file.replace(/\\/g, '/').toLowerCase();
  return normalized.includes('/entities/') ||
    normalized.includes('/models/') ||
    normalized.includes('/schema') ||
    normalized.endsWith('schema.prisma') ||
    normalized.endsWith('.entity.ts') ||
    normalized.endsWith('.model.ts');
}

function pathsCompatible(left: string, right: string): boolean {
  const normalizedLeft = normalizePathForCompare(left);
  const normalizedRight = normalizePathForCompare(right);
  return normalizedLeft === normalizedRight ||
    normalizedLeft.endsWith(`/${normalizedRight}`) ||
    normalizedRight.endsWith(`/${normalizedLeft}`);
}

function normalizePathForCompare(filePath: string): string {
  return path.normalize(filePath).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function aggregateStatus(statuses: GateStatus[]): GateStatus {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'warn';
  return 'pass';
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function nextSteps(status: GateStatus, impactedCount: number, testCount: number, migrationCount: number, schemaCount: number, warningCount: number): string[] {
  if (impactedCount === 0) {
    return warningCount > 0
      ? ['Resolve validation warnings or provide explicit files/diff_text before relying on this result.']
      : ['No behavioral invariants are impacted by the supplied diff/files.'];
  }
  const steps = ['Review each impacted invariant before finalizing the change.'];
  if (testCount === 0) steps.push('Add or run focused tests for impacted behavioral invariants.');
  if (schemaCount > 0 && migrationCount === 0) steps.push('If schema semantics changed, add or verify a migration.');
  if (warningCount > 0 && status !== 'fail') steps.push('Resolve validation warnings before relying on this result.');
  if (status === 'fail') steps.push('Resolve failed invariant gates before shipping.');
  return steps;
}
