import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { loadKlauroConfig, type LoadedKlauroConfig } from './klauro-config';
import { detectRemoteProvider, type RemoteProviderInfo } from './remote-provider';
import { isRegisteredManifest, isRegisteredSourceExtension } from '../../../packages/analyzer-core/src/analyzer/core/language-registry';

export interface RemoteSourceFile {
  path: string;
  content: string;
  hash: string;
}

/** A single file entry (path + content + hash) carried in a diff-only payload. */
export type RemoteFileEntry = RemoteSourceFile;

export interface BranchDiffContext {
  base_branch: string;
  target_branch: string;
  base_commit?: string;
  head_commit?: string;
  changed_files: string[];
  files: RemoteFileEntry[];
}

export interface RemoteChangedFile extends RemoteSourceFile {
  status: 'added' | 'modified';
}

export interface RemoteDeletedFile {
  path: string;
  status: 'deleted';
}

export type RemoteFileChange = RemoteChangedFile | RemoteDeletedFile;

export interface SourceSnapshot {
  project_name: string;
  base_commit?: string;
  /**
   * Where the snapshot content was read from:
   * - 'committed-head': file contents read from the HEAD commit's git objects
   *   (git-archive semantics) — the working tree may be dirty, but none of the
   *   dirty content is in this snapshot.
   * - 'working-tree': file contents read from disk (clean tree, or not a git repo).
   */
  snapshot_source: 'committed-head' | 'working-tree';
  files: RemoteSourceFile[];
  manifest: SourceManifest;
}

export interface WorkingTreeChangeContext {
  project_name: string;
  base_commit?: string;
  git_diff?: string;
  changed_files: RemoteFileChange[];
  manifest: SourceManifest;
}

export interface SourceManifest {
  generated_at: string;
  root: string;
  git_remote?: string;
  remote_provider?: RemoteProviderInfo;
  branch?: string;
  base_commit?: string;
  dirty?: boolean;
  transfer_recommendation?: SourceTransferRecommendation;
  file_count: number;
  total_bytes: number;
  excluded_directories: string[];
  config_file?: string;
  ignore_file?: string;
  upload_mode?: string;
  policy?: {
    require_manifest_review: boolean;
    allow_dirty_tree_sync: boolean;
    send_git_diff: boolean;
    send_deleted_paths: boolean;
  };
}

export interface UploadManifestFile {
  path: string;
  bytes: number;
  hash: string;
}

export interface UploadManifestExclusion {
  path: string;
  reason: string;
}

export interface UploadManifest {
  generated_at: string;
  root: string;
  config_file?: string;
  ignore_file?: string;
  mode: 'full' | 'dirty-tree';
  branch?: string;
  commit?: string;
  dirty?: boolean;
  summary: {
    included_files: number;
    included_bytes: number;
    excluded_files: number;
    changed_files?: number;
    deleted_files?: number;
  };
  remote_provider?: RemoteProviderInfo;
  transfer_recommendation?: SourceTransferRecommendation;
  workspace_recommendation?: WorkspaceRecommendation;
  included_files: UploadManifestFile[];
  excluded: UploadManifestExclusion[];
}

export interface SourceTransferRecommendation {
  operation: 'submit_commit_analysis' | 'prepare_local_working_copy_context' | 'use_self_hosted_analyzer';
  status: 'active' | 'available' | 'fallback';
  reason: string;
  next_action?: string;
}

export interface WorkspaceCandidate {
  path: string;
  kind: 'git-repo' | 'klauro-project';
  name?: string;
  project_id?: string;
  organization_id?: string;
  remote_provider?: RemoteProviderInfo;
}

export interface WorkspaceRecommendation {
  recommended: boolean;
  reason: string;
  rule: 'workspace-cannot-contain-workspace';
  candidates: WorkspaceCandidate[];
}

// Exported so other blackbox-client code (e.g. the gauntlet's bench staging step)
// can align its own directory filtering with what the snapshot walk excludes,
// instead of maintaining a second, potentially-divergent ignore list.
export const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.klauro',
  '.klauro-agent-idiom-benchmark',
  '.klauro-agent-proof-machine',
  '.claude',
  '.codex',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.vite',
  'target',
  'vendor',
  'vendors',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.venv',
  'venv',
  'env',
  '.tox',
  '.dart_tool',
  '.gradle',
  'Pods',
  // NOTE: 'bin' is intentionally NOT excluded — it holds real source in several
  // ecosystems (OCaml/Dune `bin/main.ml`, Rust `src/bin`, shell scripts). Compiled
  // artifacts there (.dll/.exe/.o) are dropped anyway by the registered-source-ext
  // gate below, so excluding the whole dir only lost legitimate source.
  'obj',
]);

// Doctrine: EXCLUDED_DIRECTORIES above matches exact segment names only, so a
// vendored build-output dir whose name embeds a project/service name (e.g.
// `build-out-drop-server/`) slips through and gets uploaded wholesale — seen for
// real as a 14,140-file vendored dump on a first-session customer repo. This list
// adds a small set of PATTERNS for output *shapes*, not name guesses: every entry
// here is a directory shape that build tooling produces and that nobody hand-names
// a source directory after. Keep additions conservative and anchored — a miss
// (some vendored dir slips through) is recoverable via .klauroignore; a false
// positive (real source silently dropped) is not.
export const EXCLUDED_DIRECTORY_PATTERNS: RegExp[] = [
  // Generic "build-out" drop dirs, e.g. `build-out-drop-server/`, `build-out/`.
  // Anchored at the start so `building-blocks/` and `buildings/` (real source
  // dir names that merely start with "build") do NOT match.
  /^build-out(-|$)/,
  // Vendored-artifact staging dirs distinct from the already-excluded plain
  // `build`/`dist` (which some ecosystems also use as a *source* dir name).
  /^\.?build-artifacts?$/,
  // CMake out-of-source build dirs, e.g. `cmake-build-debug`, `cmake-build-release`.
  /^cmake-build-[a-z]+$/,
  // Xcode's derived-data cache (build products, indexes, logs) — never source.
  /^DerivedData$/,
];

/**
 * Single point of truth for "is this directory NAME a default exclusion" —
 * exact-name set first, then the vendored-output-shape patterns above. Returns
 * which rule matched so callers can surface a precise manifest/exclusion reason
 * instead of collapsing both classes into one generic message.
 */
function matchExcludedDirectoryName(name: string): { excluded: boolean; matchedPattern?: string } {
  if (EXCLUDED_DIRECTORIES.has(name)) return { excluded: true };
  const matched = EXCLUDED_DIRECTORY_PATTERNS.find(pattern => pattern.test(name));
  return matched ? { excluded: true, matchedPattern: matched.source } : { excluded: false };
}

/** Collapse a verbose per-file inclusion reason into the coarse category the
 * upload manifest surfaces to the customer — 'vendored-output-shape' gets its
 * own label (so it's visibly distinct from an ordinary ignore-pattern miss)
 * instead of disappearing into the generic 'excluded by source policy' bucket. */
function manifestExclusionReason(verboseReason: string): string {
  return verboseReason.startsWith('vendored-output-shape') ? 'vendored-output-shape' : 'excluded by source policy';
}

const EXCLUDED_FILES = new Set([
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.npmrc',
  '.pypirc',
]);

// Extensions carried into the remote snapshot even though they aren't a registered
// programming-language source extension or a named manifest in language-registry.ts.
// Several framework analyzers read plain, non-manifest-named config files by glob
// (e.g. Symfony's config/routes*.yaml + config/packages/security.yaml for route-prefix
// and access_control composition; container/CI YAML for topology). Without this
// allowlist those files are silently dropped from every remote (analyzeForBench /
// production) analysis even though a direct, on-disk analyzer run picks them up fine —
// found via a route composition audit on a benchmarked Symfony repo: its config/routes.yaml prefix mapping
// never reached the server, so Symfony route paths reported only the local fragment
// (e.g. "/{id}/api-token" instead of "/api/customer/{id}/api-token").
const EXTRA_INCLUDED_EXTENSIONS = new Set([
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  // Play Framework sub-router include files (conf/api.routes etc.) — see the
  // 'routes' entry in IMPORTANT_EXTENSIONLESS for the base conf/routes file.
  '.routes',
  // Jupyter notebooks: JSON documents holding an ordered cell sequence, not
  // registered-language source — JupyterNotebookAnalyzer parses this format
  // directly (see analyzer/frameworks/dataml/jupyter-notebook-analyzer.ts).
  '.ipynb',
  // Reverse-proxy / web-server configs: nginx.conf / Apache *.conf (VirtualHost
  // + ProxyPass) and HAProxy haproxy.cfg — the "how public traffic routes to
  // services" topology layer parsed by reverse-proxy-analyzer.ts. Not a
  // registered language extension, so without this the routing config is
  // silently dropped from every remote/analyzeForBench analysis even though a
  // direct on-disk run reads it (same defect class as the routes/.yaml notes).
  '.conf',
  '.cfg',
  // SOAP/WSDL contracts: service definitions and referenced schemas are parsed
  // directly by SoapWsdlAnalyzer, not by a programming-language parser.
  '.wsdl',
  '.xsd',
  // Product documentation (README/PRD/docs): the analyzer's TOP-DOWN naming and
  // description grounding read these — resolveSystemDisplayName takes the
  // README/PRD H1 as the strongest self-naming evidence, and
  // extractProjectTextSignal seeds description/concept grounding from product
  // docs. Because markdown is not a registered SOURCE extension, every hosted
  // snapshot silently dropped it — so hosted analyses could never see a README
  // and content-first naming was dead on arrival server-side (measured twice on
  // real projects, 2026-07-16: Klauro-self "no README in prod snapshot", and
  // rpg/server named "server" hosted while the same repo resolved
  // "Sundered World - Simulation Server" from its README locally).
  '.md',
  '.markdown',
  '.rst',
]);

// Platform MANIFEST files that a framework analyzer reads directly by exact
// basename, not by extension — deliberately NOT a blanket ".xml" inclusion.
// Blanket .xml would flood every hosted snapshot with build-tool/IDE/generated
// XML (a Java/Gradle monorepo's own module descriptors, Maven site reports,
// Android build intermediates, etc.) that no analyzer consumes, recreating
// the same "vendored dump reaches the server" defect class EXCLUDED_DIRECTORY_PATTERNS
// exists to prevent. Named by exact basename instead: kotlin-analyzer.ts globs
// **/AndroidManifest.xml and resolves its <activity>/<service>/<receiver>/
// <provider> declarations to entry points — same defect class as the
// routes/.yaml/.md notes above: canAnalyze()/the glob reads this file directly
// on disk, but the remote snapshot walker had no rule keeping it, so every
// hosted analysis of an Android app silently lost service/receiver/provider
// entry points (found 2026-07-17: a real Android/Compose repo's
// NodeForegroundService + InstallResultReceiver never reached the hosted CAS —
// zero manifest entry points, zero warnings — while local on-disk analysis of
// the identical repo found both). Add to this set ONLY when a specific
// analyzer is confirmed to read the file by exact name; do not widen to a
// pattern or extension.
const PLATFORM_MANIFEST_BASENAMES = new Set([
  'AndroidManifest.xml',
]);

const IMPORTANT_EXTENSIONLESS = new Set([
  'Dockerfile',
  'Makefile',
  'Procfile',
  'Gemfile',
  'Rakefile',
  'artisan',
  // Caddy's config file is extensionless (`Caddyfile`) and holds site-address
  // blocks + `reverse_proxy <upstream>` — the public-traffic routing topology
  // parsed by CaddyAnalyzer (reverse-proxy-analyzer.ts). Without this it never
  // reaches the remote/analyzeForBench analyzer even though canAnalyze() reads
  // it directly on disk.
  'Caddyfile',
  // Play Framework's router: conf/routes is the actual route source of truth
  // (see PlayAnalyzer) — it has no extension and would otherwise be silently
  // dropped from the snapshot, leaving the analyzer nothing to read even
  // though canAnalyze() found it directly on disk.
  'routes',
  // .klaurorc itself: neither a registered source extension nor a
  // manifest/extensionless name the language registry knows, so without this
  // it never reaches the remote analyzer at all — meaning declared
  // conventions (conventions-applier.ts) silently could never apply in the
  // hosted/remote analysis path, only a direct on-disk local run. Found via
  // the same class of bug the routes/routes.yaml fix above documents: a file
  // canAnalyze()/the config loader reads directly on disk but the snapshot
  // walker had no rule keeping it.
  '.klaurorc',
  '.klaurorc.json',
]);

export async function buildSourceSnapshot(projectPath: string): Promise<SourceSnapshot> {
  const root = path.resolve(projectPath);
  const loaded = await loadKlauroConfig(root);
  const isGit = isGitRepository(root);
  const head = readGitHead(root);
  const dirty = isGit && head ? listGitChanges(root).length > 0 : false;
  let fellBackFromEmptyHead = false;
  if (isGit && head && dirty) {
    // Dirty working tree: the shared analysis still runs — on the COMMITTED HEAD
    // content (git-archive semantics, read straight from git objects). The dirty
    // working tree is never touched, stashed, or included; uncommitted work flows
    // through the separate in-flight track (buildWorkingTreeChangeContext).
    const headSnapshot = await buildHeadSourceSnapshot(root, loaded, head);
    // ...UNLESS the project has NO committed content at HEAD. A brand-new
    // project directory the user hasn't committed yet (very common in a first
    // session — e.g. a `server/` subdir added but never committed) yields an
    // EMPTY head snapshot, and returning it is a customer-facing dead-end
    // ("Remote analyze requires a source snapshot with files") with no hint
    // that the cause is "nothing here is committed". The committed-HEAD rule
    // exists to keep a SHARED analysis off one developer's dirty tree — but
    // when there is nothing committed to prefer, the working tree is the only
    // source of truth, so fall back to it (same path a non-git repo takes)
    // instead of refusing.
    if (headSnapshot.files.length > 0) return headSnapshot;
    fellBackFromEmptyHead = true;
  }
  const files: RemoteSourceFile[] = [];
  const diagnostics = newWalkDiagnostics();
  await walkConfiguredSourceFiles(root, loaded, async absolutePath => {
    const file = await readRemoteSourceFile(root, absolutePath, loaded);
    if (file) files.push(file);
  }, [], diagnostics);

  if (files.length === 0) {
    throw buildEmptySnapshotDiagnostic(root, loaded, {
      isGit,
      hasHead: Boolean(head),
      dirty,
      fellBackFromEmptyHead,
      diagnostics,
    });
  }

  return {
    project_name: loaded.config.project.name || path.basename(root),
    base_commit: head,
    snapshot_source: 'working-tree',
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
    manifest: buildManifest(root, loaded, files),
  };
}

/** Cheap counters accumulated DURING the existing source walk (no second scan):
 *  how many files were seen before any ignore rule applied, how many survived,
 *  and — per exclusion reason/pattern — how many files it accounted for. Used
 *  only to build a self-diagnosing error when the final snapshot is empty. */
interface WalkDiagnostics {
  candidatesBeforeIgnores: number;
  candidatesAfterIgnores: number;
  exclusionCounts: Map<string, number>;
}

function newWalkDiagnostics(): WalkDiagnostics {
  return { candidatesBeforeIgnores: 0, candidatesAfterIgnores: 0, exclusionCounts: new Map() };
}

function recordExclusion(diagnostics: WalkDiagnostics | undefined, key: string): void {
  if (!diagnostics) return;
  diagnostics.exclusionCounts.set(key, (diagnostics.exclusionCounts.get(key) || 0) + 1);
}

function topExclusions(diagnostics: WalkDiagnostics, limit = 3): Array<[string, number]> {
  return Array.from(diagnostics.exclusionCounts.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit);
}

function buildEmptySnapshotDiagnostic(
  root: string,
  loaded: LoadedKlauroConfig,
  info: { isGit: boolean; hasHead: boolean; dirty: boolean; fellBackFromEmptyHead: boolean; diagnostics: WalkDiagnostics }
): Error {
  const { diagnostics } = info;
  const lines: string[] = [];
  lines.push(`Remote analyze requires a source snapshot with files, but the snapshot built for "${root}" is empty. Here is exactly what was checked:`);

  // Snapshot mode chosen and why.
  let modeLine: string;
  if (!info.isGit) {
    modeLine = 'snapshot mode: working-tree (not a git repository, so there is no committed HEAD to prefer)';
  } else if (!info.hasHead) {
    modeLine = 'snapshot mode: working-tree (git repository has no HEAD commit yet)';
  } else if (!info.dirty) {
    modeLine = 'snapshot mode: working-tree (working tree is clean, so it matches HEAD)';
  } else if (info.fellBackFromEmptyHead) {
    modeLine = 'snapshot mode: working-tree (working tree is dirty; the committed-HEAD snapshot was tried first but had 0 tracked files under this path, so it fell back to the working tree)';
  } else {
    modeLine = 'snapshot mode: working-tree';
  }
  lines.push(`  - ${modeLine}`);

  if (info.isGit && info.hasHead) {
    const headCount = listGitTrackedPathsAtHead(root).length;
    lines.push(`  - committed-HEAD tracked-file count under this path: ${headCount}`);
  }

  lines.push(`  - working-tree candidates BEFORE ignores: ${diagnostics.candidatesBeforeIgnores}`);
  lines.push(`  - working-tree candidates AFTER ignores: ${diagnostics.candidatesAfterIgnores}`);

  const ignoreSources: string[] = [];
  if (loaded.ignorePath) ignoreSources.push(`.klauroignore (${loaded.ignorePath})`);
  if ((loaded.config.source.exclude || []).length > 0) ignoreSources.push('.klaurorc source.exclude');
  ignoreSources.push('default directory/file exclusions (node_modules, .git, dist, .env*, etc.)');
  lines.push(`  - ignore sources in effect: ${ignoreSources.join(', ')}`);

  const top = topExclusions(diagnostics);
  if (top.length > 0) {
    lines.push('  - top exclusion reasons:');
    for (const [reason, count] of top) {
      lines.push(`      ${reason}: ${count} file(s)`);
    }
  }

  lines.push('');
  if (diagnostics.candidatesBeforeIgnores === 0) {
    lines.push(`NEXT STEP: no files were found under "${root}" at all (before any ignore rule was applied). Check that this is the right path — an empty or wrong directory is the likely cause.`);
  } else if (diagnostics.candidatesAfterIgnores === 0) {
    const [topReason] = top;
    const hint = topReason ? ` (top excluder: ${topReason[0]}, ${topReason[1]} file(s))` : '';
    lines.push(`NEXT STEP: ${diagnostics.candidatesBeforeIgnores} file(s) were found, but every one was excluded${hint}. Loosen .klauroignore or .klaurorc source.exclude, or verify source.include covers your files.`);
  } else if (info.fellBackFromEmptyHead) {
    lines.push('NEXT STEP: this should not happen — the working-tree fallback exists specifically to avoid an empty snapshot. Please report this as a Klauro bug with this error text.');
  } else {
    lines.push('NEXT STEP: Klauro analyzes your working tree — an empty result here is unexpected. Please report this as a Klauro bug with this error text.');
  }

  return new Error(lines.join('\n'));
}

/**
 * Build a source snapshot from the COMMITTED HEAD only — `git ls-files`-at-HEAD /
 * `git archive` semantics. Every file's content is read from the HEAD commit's git
 * objects (`git show HEAD:<path>`), never from the working tree, so:
 * - dirty (uncommitted) edits to tracked files are absent,
 * - untracked files are absent,
 * - files deleted in the working tree but present at HEAD ARE included,
 * - the user's working tree is never mutated (no stash/checkout/reset).
 */
export async function buildHeadSourceSnapshot(
  projectPath: string,
  preloadedConfig?: LoadedKlauroConfig,
  headOverride?: string
): Promise<SourceSnapshot> {
  const root = path.resolve(projectPath);
  const loaded = preloadedConfig ?? await loadKlauroConfig(root);
  const head = headOverride ?? readGitHead(root);
  if (!head) {
    throw new Error('Cannot build a committed-HEAD snapshot: this repository has no HEAD commit.');
  }
  const files: RemoteSourceFile[] = [];
  for (const trackedPath of listGitTrackedPathsAtHead(root)) {
    const normalized = normalizeRelativePath(trackedPath);
    const content = readFileAtRef(root, 'HEAD', normalized);
    if (content == null) continue;
    // Use the git-blob byte size for the max-file-bytes gate: the file may not
    // exist (or may differ) in the working tree, so stat-ing disk would be wrong.
    const byteSize = Buffer.byteLength(content, 'utf8');
    if (!(await shouldIncludeRelativePath(root, normalized, loaded, byteSize))) continue;
    files.push({ path: normalized, content, hash: hashContent(content) });
  }

  return {
    project_name: loaded.config.project.name || path.basename(root),
    base_commit: head,
    snapshot_source: 'committed-head',
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
    manifest: buildManifest(root, loaded, files),
  };
}

export async function buildWorkingTreeChangeContext(projectPath: string): Promise<WorkingTreeChangeContext> {
  const root = path.resolve(projectPath);
  const loaded = await loadKlauroConfig(root);
  if (!loaded.config.upload.allowDirtyTreeSync) {
    throw new Error('Dirty-tree sync is disabled by .klaurorc upload.allowDirtyTreeSync=false');
  }
  const changes = listGitChanges(root);
  const changedFiles: RemoteFileChange[] = [];

  for (const change of changes) {
    const absolutePath = safeJoin(root, change.path);
    if (!absolutePath || !(await shouldIncludeRelativePath(root, change.path, loaded))) continue;

    if (change.status === 'deleted') {
      if (!loaded.config.upload.sendDeletedPaths) continue;
      changedFiles.push({ path: normalizeRelativePath(change.path), status: 'deleted' });
      continue;
    }
    if (loaded.config.policy.blockUntrackedFiles && change.status === 'added') continue;

    const file = await readRemoteSourceFile(root, absolutePath, loaded);
    if (file) changedFiles.push({ ...file, status: change.status });
  }

  return {
    project_name: loaded.config.project.name || path.basename(root),
    base_commit: readGitHead(root),
    git_diff: loaded.config.upload.sendGitDiff ? readGitDiff(root) : undefined,
    changed_files: changedFiles.sort((left, right) => left.path.localeCompare(right.path)),
    manifest: buildManifest(root, loaded, changedFiles.filter((file): file is RemoteChangedFile => file.status !== 'deleted')),
  };
}

/**
 * Build a light diff-only payload for a NON-default branch: only the files that
 * changed on `targetBranch` relative to its merge-base with `baseBranch`, read at
 * `targetBranch` (via `git show`, so it works without checking the branch out).
 * Deleted files and rename-sources are dropped; only registered-source files that
 * pass shouldIncludeRelativePath are carried as file entries.
 */
export async function buildBranchDiffContext(
  projectPath: string,
  targetBranch: string,
  baseBranch?: string
): Promise<BranchDiffContext> {
  const root = path.resolve(projectPath);
  const loaded = await loadKlauroConfig(root);
  const resolvedBase = baseBranch || detectDefaultBranch(root) || 'main';
  const baseCommit = readMergeBase(root, resolvedBase, targetBranch);
  const headCommit = readRevParse(root, targetBranch);
  const range = baseCommit ? `${baseCommit}..${targetBranch}` : targetBranch;

  const changedFiles: string[] = [];
  const files: RemoteFileEntry[] = [];
  for (const change of listBranchDiff(root, range)) {
    const normalized = normalizeRelativePath(change.path);
    // Read content from the git ref (works without checkout); use its byte size
    // for the inclusion gate since the file may not exist in the working tree.
    const content = readFileAtRef(root, targetBranch, normalized);
    if (content == null) continue;
    const byteSize = Buffer.byteLength(content, 'utf8');
    if (!(await shouldIncludeRelativePath(root, normalized, loaded, byteSize))) continue;
    changedFiles.push(normalized);
    files.push({ path: normalized, content, hash: hashContent(content) });
  }

  return {
    base_branch: resolvedBase,
    target_branch: targetBranch,
    base_commit: baseCommit,
    head_commit: headCommit,
    changed_files: changedFiles.sort((left, right) => left.localeCompare(right)),
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

export async function buildUploadManifest(projectPath: string, mode: 'full' | 'dirty-tree' = 'full'): Promise<UploadManifest> {
  const root = path.resolve(projectPath);
  const loaded = await loadKlauroConfig(root);
  const included: UploadManifestFile[] = [];
  const excluded: UploadManifestExclusion[] = [];

  if (mode === 'dirty-tree') {
    for (const change of listGitChanges(root)) {
      const normalized = normalizeRelativePath(change.path);
      const absolutePath = safeJoin(root, normalized);
      if (!absolutePath) {
        excluded.push({ path: normalized, reason: 'unsafe path' });
        continue;
      }
      const verdict = await shouldIncludeRelativePathVerbose(root, normalized, loaded);
      if (!verdict.included) {
        excluded.push({ path: normalized, reason: manifestExclusionReason(verdict.reason) });
        continue;
      }
      if (change.status === 'deleted') continue;
      const stat = await fs.stat(absolutePath);
      const content = await fs.readFile(absolutePath, 'utf8');
      included.push({ path: normalized, bytes: stat.size, hash: hashContent(content) });
    }
  } else {
    await walkConfiguredSourceFiles(root, loaded, async absolutePath => {
      const normalized = normalizeRelativePath(path.relative(root, absolutePath));
      const verdict = await shouldIncludeRelativePathVerbose(root, normalized, loaded);
      if (verdict.included) {
        const stat = await fs.stat(absolutePath);
        const content = await fs.readFile(absolutePath, 'utf8');
        included.push({ path: normalized, bytes: stat.size, hash: hashContent(content) });
      } else {
        excluded.push({ path: normalized, reason: manifestExclusionReason(verdict.reason) });
      }
    }, excluded);
  }

  const changes = mode === 'dirty-tree' ? listGitChanges(root) : [];
  const remoteProvider = detectRemoteProvider(readGitRemote(root));
  const transferRecommendation = recommendTransfer(loaded, remoteProvider, mode);
  const workspaceRecommendation = await detectWorkspaceRecommendation(root);
  return {
    generated_at: new Date().toISOString(),
    root,
    config_file: loaded.configPath,
    ignore_file: loaded.ignorePath,
    mode,
    branch: readGitBranch(root),
    commit: readGitHead(root),
    dirty: listGitChanges(root).length > 0,
    summary: {
      included_files: included.length,
      included_bytes: included.reduce((sum, file) => sum + file.bytes, 0),
      excluded_files: excluded.length,
      changed_files: mode === 'dirty-tree' ? changes.filter(change => change.status !== 'deleted').length : undefined,
      deleted_files: mode === 'dirty-tree' ? changes.filter(change => change.status === 'deleted').length : undefined,
    },
    remote_provider: remoteProvider,
    transfer_recommendation: transferRecommendation,
    workspace_recommendation: workspaceRecommendation,
    included_files: included.sort((left, right) => left.path.localeCompare(right.path)),
    excluded: excluded.sort((left, right) => left.path.localeCompare(right.path)).slice(0, 500),
  };
}

async function detectWorkspaceRecommendation(root: string): Promise<WorkspaceRecommendation | undefined> {
  const candidates: WorkspaceCandidate[] = [];
  await walkWorkspaceCandidates(root, root, candidates, 0);
  if (candidates.length === 0) return undefined;
  return {
    recommended: candidates.length > 1,
    reason: candidates.length > 1
      ? 'Multiple child Git repositories or Klauro project configs were found. Initialize this folder as a workspace and attach each child project instead of merging them into one project analysis.'
      : 'A child Git repository or Klauro project config was found. If this folder is meant to group projects, initialize it as a workspace; otherwise initialize inside the child project.',
    rule: 'workspace-cannot-contain-workspace',
    candidates: candidates.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

async function walkWorkspaceCandidates(
  root: string,
  currentDirectory: string,
  candidates: WorkspaceCandidate[],
  depth: number
): Promise<void> {
  if (depth > 5 || candidates.length >= 100) return;
  let entries: Array<import('node:fs').Dirent>;
  try {
    entries = await fs.readdir(currentDirectory, { withFileTypes: true });
  } catch {
    return;
  }

  const isRoot = currentDirectory === root;
  const names = new Set(entries.map(entry => entry.name));
  if (!isRoot && names.has('.git')) {
    candidates.push({
      path: normalizeRelativePath(path.relative(root, currentDirectory)),
      kind: 'git-repo',
      name: path.basename(currentDirectory),
      remote_provider: detectRemoteProvider(readGitRemote(currentDirectory)),
    });
    return;
  }

  const configName = names.has('.klaurorc') ? '.klaurorc' : names.has('.klaurorc.json') ? '.klaurorc.json' : undefined;
  if (!isRoot && configName) {
    candidates.push(await readKlauroProjectCandidate(root, currentDirectory, configName));
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    await walkWorkspaceCandidates(root, path.join(currentDirectory, entry.name), candidates, depth + 1);
  }
}

async function readKlauroProjectCandidate(root: string, directory: string, configName: string): Promise<WorkspaceCandidate> {
  const candidate: WorkspaceCandidate = {
    path: normalizeRelativePath(path.relative(root, directory)),
    kind: 'klauro-project',
    name: path.basename(directory),
    remote_provider: detectRemoteProvider(readGitRemote(directory)),
  };
  try {
    const raw = await fs.readFile(path.join(directory, configName), 'utf8');
    const parsed = JSON.parse(raw);
    candidate.name = parsed?.project?.name || candidate.name;
    candidate.project_id = parsed?.project?.id;
    candidate.organization_id = parsed?.project?.organizationId;
  } catch {
    // Candidate discovery should not fail the upload manifest.
  }
  return candidate;
}

async function walkConfiguredSourceFiles(
  root: string,
  loaded: LoadedKlauroConfig,
  visit: (absolutePath: string) => Promise<void>,
  exclusions: UploadManifestExclusion[] = [],
  diagnostics?: WalkDiagnostics
): Promise<void> {
  for (const sourceRoot of loaded.config.source.roots || ['.']) {
    const absoluteRoot = safeJoin(root, sourceRoot);
    if (!absoluteRoot) {
      exclusions.push({ path: sourceRoot, reason: 'unsafe source root' });
      continue;
    }
    await walkSourceFiles(root, absoluteRoot, loaded, visit, exclusions, diagnostics);
  }
}

async function walkSourceFiles(
  root: string,
  currentDirectory: string,
  loaded: LoadedKlauroConfig,
  visit: (absolutePath: string) => Promise<void>,
  exclusions: UploadManifestExclusion[],
  diagnostics?: WalkDiagnostics
): Promise<void> {
  const entries = await fs.readdir(currentDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(currentDirectory, entry.name);
    const relativePath = normalizeRelativePath(path.relative(root, absolutePath));
    if (entry.isSymbolicLink() && !loaded.config.source.followSymlinks) {
      exclusions.push({ path: relativePath, reason: 'symlink excluded' });
      recordExclusion(diagnostics, 'symlink excluded');
      continue;
    }
    if (entry.isDirectory()) {
      const dirMatch = matchExcludedDirectoryName(entry.name);
      if (dirMatch.excluded) {
        const reason = dirMatch.matchedPattern ? 'vendored-output-shape' : 'default directory exclusion';
        exclusions.push({ path: `${relativePath}/`, reason });
        recordExclusion(
          diagnostics,
          dirMatch.matchedPattern
            ? `vendored-output-shape pattern "${dirMatch.matchedPattern}": ${entry.name}/`
            : `default directory exclusion: ${entry.name}/`
        );
        continue;
      }
    }
    if (entry.isDirectory()) {
      const matchedDirPattern = findMatchingPattern(relativePath, allExcludePatterns(loaded));
      if (matchedDirPattern) {
        exclusions.push({ path: `${relativePath}/`, reason: 'excluded by pattern' });
        recordExclusion(diagnostics, `.klauroignore/source.exclude pattern "${matchedDirPattern}"`);
        continue;
      }
    }
    if (entry.isDirectory()) {
      await walkSourceFiles(root, absolutePath, loaded, visit, exclusions, diagnostics);
    } else if (entry.isFile()) {
      if (diagnostics) diagnostics.candidatesBeforeIgnores++;
      const verbose = await shouldIncludeRelativePathVerbose(root, relativePath, loaded);
      if (verbose.included) {
        if (diagnostics) diagnostics.candidatesAfterIgnores++;
        await visit(absolutePath);
      } else {
        exclusions.push({ path: relativePath, reason: 'excluded by source policy' });
        recordExclusion(diagnostics, verbose.reason);
      }
    }
  }
}

async function readRemoteSourceFile(root: string, absolutePath: string, loaded: LoadedKlauroConfig): Promise<RemoteSourceFile | null> {
  const relativePath = normalizeRelativePath(path.relative(root, absolutePath));
  if (!(await shouldIncludeRelativePath(root, relativePath, loaded))) return null;
  const content = await fs.readFile(absolutePath, 'utf8');
  return {
    path: relativePath,
    content,
    hash: hashContent(content),
  };
}

async function shouldIncludeRelativePath(
  root: string,
  relativePath: string,
  loaded: LoadedKlauroConfig,
  // When set, use this byte size instead of stat-ing the working tree. Branch-diff
  // files may not exist in the checked-out tree (they live at a git ref), so the
  // caller supplies the git-blob size to keep the max-file-bytes gate working.
  sizeOverride?: number
): Promise<boolean> {
  return (await shouldIncludeRelativePathVerbose(root, relativePath, loaded, sizeOverride)).included;
}

type IncludeVerdict = { included: true } | { included: false; reason: string };

/**
 * Same inclusion gate as shouldIncludeRelativePath, but reports WHY a file was
 * dropped (which ignore source / pattern / rule) instead of a bare boolean —
 * used to build a self-diagnosing error when a snapshot ends up empty. Kept as
 * the single source of truth (shouldIncludeRelativePath is a thin wrapper) so
 * there is exactly one inclusion-rule implementation, not two to keep in sync.
 */
async function shouldIncludeRelativePathVerbose(
  root: string,
  relativePath: string,
  loaded: LoadedKlauroConfig,
  sizeOverride?: number
): Promise<IncludeVerdict> {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized || normalized.startsWith('../') || path.isAbsolute(normalized)) {
    return { included: false, reason: 'unsafe path (outside project root)' };
  }
  const parts = normalized.split('/');
  for (const part of parts) {
    const dirMatch = matchExcludedDirectoryName(part);
    if (dirMatch.excluded) {
      return dirMatch.matchedPattern
        ? { included: false, reason: `vendored-output-shape pattern "${dirMatch.matchedPattern}": ${part}/` }
        : { included: false, reason: `default directory exclusion: ${part}/` };
    }
  }
  const base = parts[parts.length - 1];
  if (EXCLUDED_FILES.has(base)) return { included: false, reason: `default file exclusion: ${base}` };
  if (/^\.env\./.test(base)) return { included: false, reason: 'default file exclusion: .env.*' };
  if (/\.lockb$/.test(base)) return { included: false, reason: 'default file exclusion: *.lockb' };

  const matchedIgnorePattern = findMatchingPattern(normalized, loaded.ignorePatterns || []);
  if (matchedIgnorePattern) return { included: false, reason: `.klauroignore pattern "${matchedIgnorePattern}"` };
  const matchedExcludePattern = findMatchingPattern(normalized, loaded.config.source.exclude || []);
  if (matchedExcludePattern) return { included: false, reason: `.klaurorc source.exclude pattern "${matchedExcludePattern}"` };

  if (!patternListMatches(normalized, loaded.config.source.include || ['**/*'])) {
    return { included: false, reason: 'not matched by .klaurorc source.include patterns' };
  }

  if (sizeOverride != null) {
    if (sizeOverride > loaded.config.source.maxFileBytes) return { included: false, reason: 'file exceeds source.maxFileBytes' };
  } else {
    try {
      const stat = await fs.stat(path.join(root, normalized));
      if (stat.size > loaded.config.source.maxFileBytes) return { included: false, reason: 'file exceeds source.maxFileBytes' };
    } catch {
      return { included: false, reason: 'file not readable (stat failed)' };
    }
  }

  // Use the analyzer's language registry as the single source of truth for what is
  // analyzable source/manifest — so the snapshot we send to the product can never
  // drift behind the languages the analyzer supports (the stale hardcoded list
  // dropped Kotlin/.kt, Ruby/.rb, C# .csproj manifests, Swift, C++, etc.).
  if (isRegisteredSourceExtension(base) || isRegisteredManifest(base) || IMPORTANT_EXTENSIONLESS.has(base) || PLATFORM_MANIFEST_BASENAMES.has(base)) {
    return { included: true };
  }
  const ext = base.slice(base.lastIndexOf('.'));
  if (EXTRA_INCLUDED_EXTENSIONS.has(ext)) return { included: true };
  return { included: false, reason: 'not a registered source/manifest file type' };
}

/** List every file path tracked at the HEAD commit (`git ls-tree -r HEAD`) —
 *  the committed tree, regardless of working-tree state. */
function listGitTrackedPathsAtHead(root: string): string[] {
  try {
    const output = execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 64,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

function listGitChanges(root: string): Array<{ path: string; status: 'added' | 'modified' | 'deleted' }> {
  try {
    const output = execFileSync('git', ['status', '--porcelain=v1', '-z'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const entries = output.split('\0').filter(Boolean);
    const changes: Array<{ path: string; status: 'added' | 'modified' | 'deleted' }> = [];

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const code = entry.slice(0, 2);
      let filePath = entry.slice(3);
      if (code.includes('R') || code.includes('C')) {
        const newPath = entries[++i];
        if (newPath) filePath = newPath;
      }
      const status = code.includes('D') ? 'deleted' : code.includes('?') || code.includes('A') ? 'added' : 'modified';
      changes.push({ path: filePath, status });
    }
    return changes;
  } catch {
    return [];
  }
}

/** List add/modify/rename-target paths for a diff range (skips deletions and
 *  rename-source paths). Handles `--name-status -z` where R/C entries emit two
 *  NUL-separated fields (old path, new path). */
function listBranchDiff(root: string, range: string): Array<{ path: string; status: 'added' | 'modified' }> {
  try {
    const output = execFileSync('git', ['diff', '--name-status', '--no-renames', '-z', range], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 20,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const fields = output.split('\0').filter(Boolean);
    const changes: Array<{ path: string; status: 'added' | 'modified' }> = [];
    for (let i = 0; i < fields.length; i++) {
      const code = fields[i];
      // Rename/copy status codes (R100, C75...) carry two path fields; with
      // --no-renames these should not appear, but guard defensively anyway.
      if (/^[RC]\d*$/.test(code)) {
        i += 1; // skip old path
        const newPath = fields[++i];
        if (newPath) changes.push({ path: newPath, status: 'modified' });
        continue;
      }
      const filePath = fields[++i];
      if (!filePath) continue;
      if (code.startsWith('D')) continue; // deletion — nothing to read on target
      changes.push({ path: filePath, status: code.startsWith('A') ? 'added' : 'modified' });
    }
    return changes;
  } catch {
    return [];
  }
}

function readMergeBase(root: string, baseRef: string, targetRef: string): string | undefined {
  try {
    return execFileSync('git', ['merge-base', baseRef, targetRef], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function readRevParse(root: string, ref: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', ref], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function readFileAtRef(root: string, ref: string, relativePath: string): string | null {
  try {
    // `git show <ref>:<path>` resolves <path> from the REPO ROOT, but every path
    // we pass here comes from `git ls-tree`/`git diff` run with cwd=root, which
    // — when root is a SUBDIRECTORY of the repo — emits paths relative to that
    // subdir (git strips the cwd prefix). Reading those subdir-relative paths as
    // root-relative made `git show` miss every file ("path 'sub/foo' exists, but
    // not 'foo'"), so a project that is a subfolder of a larger git repo (a very
    // common shape) produced an EMPTY snapshot and a "requires a source snapshot
    // with files" dead-end. The `:./` form resolves relative to cwd, matching
    // how the paths were produced; when root IS the repo toplevel it is
    // identical to the bare form, so this is safe for both shapes.
    return execFileSync('git', ['show', `${ref}:./${relativePath}`], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 20,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/** Detect the repo's default branch (main/master), preferring an explicitly
 *  configured origin/HEAD, then a local main, then master. */
function detectDefaultBranch(root: string): string | undefined {
  try {
    const ref = execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (ref) return ref.replace(/^origin\//, '');
  } catch {
    // fall through to local branch detection
  }
  for (const candidate of ['main', 'master']) {
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', candidate], {
        cwd: root,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

function readGitHead(root: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function isGitRepository(root: string): boolean {
  try {
    return execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() === 'true';
  } catch {
    return false;
  }
}

function readGitBranch(root: string): string | undefined {
  try {
    return execFileSync('git', ['branch', '--show-current'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function readGitRemote(root: string): string | undefined {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function readGitDiff(root: string): string | undefined {
  try {
    return execFileSync('git', ['diff', '--no-ext-diff', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 20,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
}

function buildManifest(root: string, loaded: LoadedKlauroConfig, files: Array<{ content: string }>): SourceManifest {
  const gitRemote = readGitRemote(root);
  const remoteProvider = detectRemoteProvider(gitRemote);
  return {
    generated_at: new Date().toISOString(),
    root,
    git_remote: gitRemote,
    remote_provider: remoteProvider,
    branch: readGitBranch(root),
    base_commit: readGitHead(root),
    dirty: listGitChanges(root).length > 0,
    transfer_recommendation: recommendTransfer(loaded, remoteProvider, 'full'),
    file_count: files.length,
    total_bytes: files.reduce((sum, file) => sum + Buffer.byteLength(file.content, 'utf8'), 0),
    excluded_directories: Array.from(EXCLUDED_DIRECTORIES).sort(),
    config_file: loaded.configPath,
    ignore_file: loaded.ignorePath,
    upload_mode: loaded.config.upload.mode,
    policy: {
      require_manifest_review: loaded.config.upload.requireManifestReview,
      allow_dirty_tree_sync: loaded.config.upload.allowDirtyTreeSync,
      send_git_diff: loaded.config.upload.sendGitDiff,
      send_deleted_paths: loaded.config.upload.sendDeletedPaths,
    },
  };
}

function recommendTransfer(loaded: LoadedKlauroConfig, remoteProvider: RemoteProviderInfo | undefined, mode: 'full' | 'dirty-tree'): SourceTransferRecommendation {
  if (loaded.config.policy.requireSelfHosted || loaded.config.analyzer.selfHosted) {
    return {
      operation: 'use_self_hosted_analyzer',
      status: 'active',
      reason: 'This project is configured to use a self-hosted analyzer endpoint.',
    };
  }

  if (mode === 'dirty-tree') {
    return {
      operation: 'prepare_local_working_copy_context',
      status: 'active',
      reason: 'Dirty-tree contexts are private local working-copy context for the signed-in developer and are not shared project analysis.',
      next_action: remoteProvider?.suggested_connection?.action,
    };
  }

  if (remoteProvider?.connectable) {
    return {
      operation: 'submit_commit_analysis',
      status: 'active',
      reason: loaded.config.project.id
        ? 'Submit the current committed tree to the connected Klauro project for shared project analysis.'
        : 'Submit the current committed tree to Klauro for shared project analysis. The detected Git remote can also be connected later for automatic push-triggered analysis.',
      next_action: remoteProvider.suggested_connection?.action,
    };
  }

  return {
    operation: 'submit_commit_analysis',
    status: 'active',
    reason: loaded.config.project.id
      ? 'Submit the current committed tree to the connected Klauro project for shared project analysis.'
      : 'Submit the current committed tree or unversioned source snapshot to Klauro for shared project analysis.',
  };
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\/+/, '');
}

function safeJoin(root: string, relativePath: string): string | null {
  const absolutePath = path.resolve(root, relativePath);
  return absolutePath.startsWith(`${root}${path.sep}`) || absolutePath === root ? absolutePath : null;
}

function allExcludePatterns(loaded: LoadedKlauroConfig): string[] {
  return [
    ...(loaded.config.source.exclude || []),
    ...(loaded.ignorePatterns || []),
  ];
}

function patternListMatches(filePath: string, patterns: string[]): boolean {
  return patterns.some(pattern => globLikeMatches(filePath, pattern));
}

/** Same test as patternListMatches, but returns the first pattern that matched
 *  (for diagnostics) instead of a bare boolean. */
function findMatchingPattern(filePath: string, patterns: string[]): string | undefined {
  return patterns.find(pattern => globLikeMatches(filePath, pattern));
}

function globLikeMatches(filePath: string, pattern: string): boolean {
  const normalizedPath = normalizeRelativePath(filePath);
  const normalizedPattern = normalizeRelativePath(pattern);
  if (normalizedPattern === '**/*' || normalizedPattern === '**') return true;
  const directPattern = normalizedPattern.startsWith('**/')
    ? normalizedPattern.slice(3)
    : normalizedPattern;
  const regex = new RegExp(`^${globToRegex(normalizedPattern)}$`);
  if (regex.test(normalizedPath)) return true;
  if (!normalizedPattern.includes('/')) {
    return normalizedPath.split('/').some(part => new RegExp(`^${globToRegex(normalizedPattern)}$`).test(part));
  }
  if (normalizedPattern.startsWith('**/')) {
    return new RegExp(`(^|/)${globToRegex(directPattern)}$`).test(normalizedPath);
  }
  return false;
}

function globToRegex(pattern: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    const next = pattern[i + 1];
    if (char === '*' && next === '*') {
      out += '.*';
      i++;
    } else if (char === '*') {
      out += '[^/]*';
    } else if (char === '?') {
      out += '[^/]';
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return out;
}
