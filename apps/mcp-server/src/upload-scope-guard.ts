





























import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isRegisteredManifest } from '../../../packages/analyzer-core/src/analyzer/core/language-registry';
import { loadKlauroConfig } from './klauro-config';
import { detectWorkspaceRecommendation, type WorkspaceRecommendation } from './remote-source';
import { promptLine } from './password-prompt';






const SUSPICIOUS_NESTED_REPO_THRESHOLD = 2;

export interface UploadScopeAssessment {
  root: string;

  safe: boolean;

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








export async function assessUploadScope(projectPath: string): Promise<UploadScopeAssessment> {
  const root = path.resolve(projectPath);
  const [workspaceRecommendation, loaded, rootHasManifest] = await Promise.all([
    detectWorkspaceRecommendation(root),
    loadKlauroConfig(root),
    rootHasRegisteredManifest(root),
  ]);
  const nestedRepoCount = workspaceRecommendation?.candidates.length ?? 0;
  const rootHasGit = existsSync(path.join(root, '.git'));



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
