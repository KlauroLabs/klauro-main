/**
 * Guard against uploading an unintended directory to the hosted service —
 * task #134. `klauro init` / `klauro analyze` with no explicit path argument
 * both default to `process.cwd()`. If a session's cwd is a parent folder
 * full of unrelated repos (a whole `~/dev` tree, a home directory, a mounted
 * volume) rather than a single project, one path-less or mistyped invocation
 * starts uploading all of it — silently, since neither command previously
 * carried any size/scope/multi-repo signal or confirmation step. Hit live
 * 2026-08-09: an `analyze` with no path argument began uploading the
 * session's entire `~/dev/personal` folder before being killed within
 * seconds.
 *
 * The discriminator is structural, not name- or size-based (no hardcoded
 * directory-name vocabulary — see the spec-purity gate): a folder containing
 * several SIBLING Git repositories (or bound `.klaurorc` projects) beneath
 * it, with no project manifest and no `.git` of its own AT THE ROOT, is a
 * *container* of projects, not a project. `detectWorkspaceRecommendation`
 * (remote-source.ts) already walks the tree for exactly this shape — it was
 * built for the `upload-manifest` preview's advisory workspace hint. This
 * module reuses that same walk as a hard gate in front of the two calls that
 * actually put bytes on the wire (`analyzeCodebaseRemotely` /
 * `syncWorkingTreeRemotely`, both in remote-sync-client.ts), instead of only
 * advising a caller who happens to read `upload-manifest` first.
 *
 * A normal single-repo project (root has its own `.git`, or a manifest file
 * like package.json/Cargo.toml/go.mod sitting directly in it, or an explicit
 * bound `.klaurorc`) is always "safe" and never prompts — see
 * `rootLooksLikeProject` below. This preserves the one-command
 * `cd myrepo && klauro analyze` happy path.
 */
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isRegisteredManifest } from '../../../packages/analyzer-core/src/analyzer/core/language-registry';
import { loadKlauroConfig } from './klauro-config';
import { detectWorkspaceRecommendation, type WorkspaceRecommendation } from './remote-source';
import { promptLine } from './password-prompt';

/** Below this many sibling repo/project candidates, don't treat the folder
 *  as a suspicious container even without a root manifest — a single nested
 *  submodule or vendored dependency repo is common and not the failure mode
 *  this guard exists to catch (an accidental upload of a whole `~/dev`
 *  tree). Two or more is the "this is a parent folder of projects" shape. */
const SUSPICIOUS_NESTED_REPO_THRESHOLD = 2;

export interface UploadScopeAssessment {
  root: string;
  /** false = refuse by default; the caller must pass `--yes`/confirm. */
  safe: boolean;
  /** Human-readable explanation, present only when `safe` is false. */
  reason?: string;
  nestedRepoCount: number;
  rootLooksLikeProject: boolean;
  workspaceRecommendation?: WorkspaceRecommendation;
}

async function rootHasRegisteredManifest(root: string): Promise<boolean> {
  let entries: Array<import('node:fs').Dirent>;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some(entry => entry.isFile() && isRegisteredManifest(entry.name));
}

/**
 * Computes whether `projectPath` looks like a single project (safe to
 * analyze/upload without confirmation) or a container of unrelated projects
 * (refuse by default). Pure/read-only — never writes anything, never
 * uploads. Cheap: a bounded directory-name walk (depth <= 5, capped
 * candidates), not a file-content read.
 */
export async function assessUploadScope(projectPath: string): Promise<UploadScopeAssessment> {
  const root = path.resolve(projectPath);
  const [workspaceRecommendation, loaded, rootHasManifest] = await Promise.all([
    detectWorkspaceRecommendation(root),
    loadKlauroConfig(root),
    rootHasRegisteredManifest(root),
  ]);
  const nestedRepoCount = workspaceRecommendation?.candidates.length ?? 0;
  const rootHasGit = existsSync(path.join(root, '.git'));
  // An explicitly bound .klaurorc AT THE ROOT is the user's own statement
  // "this directory is a project" — see the SPEC note on requiring a bound
  // config; here it only counts toward "safe", it is not itself required.
  const rootIsBoundProject = Boolean(loaded.configPath);
  const rootLooksLikeProject = rootHasGit || rootHasManifest || rootIsBoundProject;
  const safe = !(nestedRepoCount >= SUSPICIOUS_NESTED_REPO_THRESHOLD && !rootLooksLikeProject);
  const sampleNames = (workspaceRecommendation?.candidates ?? [])
    .slice(0, 5)
    .map(candidate => candidate.path || candidate.name || '.')
    .join(', ');
  return {
    root,
    safe,
    reason: safe ? undefined : (
      `${root} looks like a folder containing ${nestedRepoCount} separate projects` +
      `${sampleNames ? ` (e.g. ${sampleNames}${nestedRepoCount > 5 ? ', ...' : ''})` : ''}, ` +
      'not a single project to analyze: it has no Git repository and no project manifest ' +
      '(package.json, Cargo.toml, go.mod, pyproject.toml, ...) of its own at the root. ' +
      'Uploading it would send every project underneath it to the hosted service in one snapshot. ' +
      'Point the command at the specific project directory instead, or re-run with --yes if this really is what you intend to upload.'
    ),
    nestedRepoCount,
    rootLooksLikeProject,
    workspaceRecommendation,
  };
}

/**
 * CLI-facing gate: given an assessment, decide whether to proceed. Safe
 * scope or an already-supplied `--yes` proceeds silently (no prompt — the
 * `cd myrepo && klauro analyze` happy path must stay one command). An unsafe
 * scope on an interactive TTY prints the reason and asks; `promptLine`
 * itself returns '' immediately on non-TTY stdin, so a scripted/CI run can
 * never hang here — it falls through to `proceed: false`, and the caller
 * (analyzeCodebaseRemotely / syncWorkingTreeRemotely) then fails loudly with
 * the same reason rather than silently uploading. Every prompt/message here
 * goes to STDERR so it never corrupts a `--json` caller's stdout.
 */
export async function confirmUploadScope(
  assessment: UploadScopeAssessment,
  opts: { yes: boolean; stdin?: NodeJS.ReadStream; stdout?: NodeJS.WriteStream } = { yes: false },
): Promise<{ proceed: boolean; confirmScope: boolean }> {
  if (assessment.safe || opts.yes) return { proceed: true, confirmScope: opts.yes };
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? (process.stderr as unknown as NodeJS.WriteStream);
  stdout.write(`${assessment.reason}\n`);
  const answer = await promptLine('Proceed and upload this entire directory anyway? [y/N] ', stdin, stdout);
  const confirmed = /^y(es)?$/i.test(answer.trim());
  if (!confirmed) stdout.write('Aborted; nothing was uploaded. Re-run with --yes to skip this prompt in a script.\n');
  return { proceed: confirmed, confirmScope: confirmed };
}
