import fs from 'node:fs';
import path from 'node:path';
import { verifyAgentSourceInputs } from './agent-source-input-verification';

const CITATION_CHECK_LIMIT = 20;
const EXAMPLE_LIMIT = 5;

type UnverifiedCitation = { file: string; reason: string; error_code?: string };

function insideRoot(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === 'string' ? code : 'UNKNOWN';
}

function analysisAge(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return 'unknown';
  const ageMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  const days = Math.floor(ageMinutes / 1440);
  const hours = Math.floor((ageMinutes % 1440) / 60);
  const minutes = ageMinutes % 60;
  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function buildAgentContextFreshness(
  analyzedAt: string | undefined,
  projectPath: string,
  files: string[],
  targetFile?: string,
  contributions: unknown[] = [],
  identityContext?: { table?: unknown; root_path?: string; current_root?: string },
) {
  const startedAt = performance.now();
  const analyzedAtMs = Date.parse(analyzedAt || '');
  const citations = [...new Set([targetFile, ...files].filter((file): file is string => Boolean(file)))];
  const missing: string[] = [];
  const newerMtime: string[] = [];
  const unverified: UnverifiedCitation[] = [];
  const root = path.resolve(projectPath);
  let realRoot: string | undefined;
  let rootError: string | undefined;
  try {
    realRoot = fs.realpathSync(root);
    if (!fs.statSync(realRoot).isDirectory()) rootError = 'ENOTDIR';
  } catch (error) {
    rootError = errorCode(error);
  }

  for (const file of citations.slice(0, CITATION_CHECK_LIMIT)) {
    if (rootError || !realRoot) {
      unverified.push({ file, reason: 'workspace-unavailable', error_code: rootError });
      continue;
    }
    const absolute = path.resolve(root, file);
    if (!insideRoot(root, absolute) || (path.win32.isAbsolute(file) && !path.isAbsolute(file))) {
      unverified.push({ file, reason: 'outside-workspace' });
      continue;
    }
    try {
      const realFile = fs.realpathSync(absolute);
      if (!insideRoot(realRoot, realFile)) {
        unverified.push({ file, reason: 'outside-workspace' });
        continue;
      }
      const stat = fs.statSync(realFile);
      if (!stat.isFile()) {
        unverified.push({ file, reason: 'not-a-regular-file' });
        continue;
      }
      if (Number.isFinite(analyzedAtMs) && stat.mtimeMs > analyzedAtMs) newerMtime.push(file);
      unverified.push({ file, reason: 'analyzed-content-identity-unavailable' });
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') missing.push(file);
      else unverified.push({ file, reason: 'file-check-error', error_code: code });
    }
  }

  const identityPrefix = identityContext?.root_path && identityContext.current_root
    ? path.relative(path.resolve(identityContext.root_path), path.resolve(identityContext.root_path, identityContext.current_root)).split(path.sep).join('/')
    : '';
  const sourceInputs = verifyAgentSourceInputs(projectPath, citations.slice(0, CITATION_CHECK_LIMIT), contributions, {}, identityContext?.table, identityPrefix);
  const mismatched = sourceInputs.results.filter(item => item.status === 'mismatched');
  for (const item of unverified) {
    if (item.reason !== 'analyzed-content-identity-unavailable') continue;
    const comparison = sourceInputs.results.find(result => result.file === item.file);
    if (comparison?.status === 'matched') item.reason = 'observed-inputs-matched-incomplete-provenance';
    else if (comparison?.status === 'mismatched') item.reason = 'differs-from-captured-inputs';
    else if (comparison?.reason) item.reason = comparison.reason;
  }
  const unchecked = citations.slice(CITATION_CHECK_LIMIT);
  const missingTarget = targetFile && missing.includes(targetFile);
  const unverifiedTarget = targetFile && unverified.find(item => item.file === targetFile);
  const mismatchedTarget = targetFile && mismatched.some(item => item.file === targetFile);
  const warning = mismatched.length > 0
    ? `${mismatched.length} cited file(s) differ from captured analysis inputs. Citation content is invalid; remaining provenance may be incomplete. Inspect cited source before relying on file/line references or risk assessments.`
    : sourceInputs.summary.matched.count > 0 && missing.length === 0
      ? `${sourceInputs.summary.matched.count} cited file(s) matched recorded captured inputs. Complete analyzer provenance is unverified. Inspect cited source before relying on file/line references or risk assessments.`
      : missing.length > 0
    ? `${missing.length} cited file(s) are missing now; deletion timing is unknown. Remaining citation content is unverified. Inspect cited source before relying on file/line references or risk assessments.`
    : 'Analyzed-content identity is unavailable; citation freshness is unverified. Timestamps do not prove changed or unchanged content. Inspect cited source before relying on file/line references or risk assessments.';
  return {
    summary: {
      analyzed_at: analyzedAt || null,
      age: analysisAge(analyzedAtMs),
      staleness: missing.length > 0 || mismatched.length > 0 ? 'stale' as const : 'unknown' as const,
      citation_verification: missing.length > 0 || mismatched.length > 0 ? 'invalid' as const : 'unverified' as const,
      source_input_comparison: sourceInputs.summary,
      files_changed_since_analysis: { count: null, examples: [] as string[] },
      files_deleted_since_analysis: { count: null, examples: [] as string[] },
      files_missing_now: { count: missing.length, examples: missing.slice(0, EXAMPLE_LIMIT) },
      unverified_files: { count: unverified.length + unchecked.length, examples: unverified.slice(0, EXAMPLE_LIMIT) },
      unchecked_files: { count: unchecked.length, examples: unchecked.slice(0, EXAMPLE_LIMIT) },
      newer_mtime_hints: { count: newerMtime.length, examples: newerMtime.slice(0, EXAMPLE_LIMIT) },
      recommendation: 'Inspect the cited source before edits. Content verification requires identities captured from analyzed inputs; rerunning the same identity-less analysis does not establish freshness.',
      warning,
      scan: {
        method: sourceInputs.summary.scan.files_compared > 0 ? 'stat+sha256-observed-inputs' as const : 'stat' as const,
        scope: 'cited-files' as const,
        bounded: true,
        duration_ms: Math.round((performance.now() - startedAt) * 1000) / 1000,
        cited_files: citations.length,
        check_limit: CITATION_CHECK_LIMIT,
        note: 'Bounded citation metadata check with recorded-input comparison when available; no Git comparison or complete provenance certification. Unknown change/deletion counts are null.',
      },
    },
    requires_verification: true,
    target_file_note: mismatchedTarget
      ? `${targetFile} differs from captured analysis inputs; this risk assessment requires source verification.`
      : missingTarget
      ? `${targetFile} is missing from the current workspace; deletion timing is unknown and this risk assessment cites an unavailable location.`
      : unverifiedTarget
        ? unverifiedTarget.reason === 'observed-inputs-matched-incomplete-provenance'
          ? `${targetFile} matches recorded inputs, but complete analyzer provenance and this risk assessment still require verification.`
          : `Analyzed-content identity for ${targetFile} is unavailable; citation freshness and this risk assessment require source verification (${unverifiedTarget.reason}).`
        : undefined,
  };
}
