import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { getAnalysis } from './analyzer';
import { formatEnvironmentDoctor, runEnvironmentDoctor } from './environment-doctor';
import { formatClientDoctor, runClientDoctor } from './client-doctor';
import { getAgentBootstrap } from './agent-bootstrap';
import { writeAgentDefaultConfig } from './agent-defaults';
import { getAgentDoctor } from './agent-doctor';
import { buildCASGoldenSnapshot } from './cas-contract';
import { listCrossCodebaseSystemGraphs, loadCrossCodebaseSystemGraph, saveCrossCodebaseSystemGraph, saveGoldenSnapshot } from './storage';
import * as query from './query';
import { buildNodeRuntimeMetrics } from './product';
import { loadTelemetryObservations } from './telemetry-ingestion';
import { getAgentContext } from './agent-adoption';
import type { AgentTask, AgentTaskType } from './agent-adoption';
import { analyzeCodebaseRemotely, syncWorkingTreeRemotely } from './remote-sync-client';
import { getAgentRevisionTracks } from './agent-revision-tracks';
import { createRemoteAnalyzerHttpServer } from './remote-analyzer-service';
import { AccountStore } from './account-store';
import { buildUploadManifest } from './remote-source';
import { loadKlauroConfig, writeDefaultKlauroConfig, writeProjectBindingIntoConfig, isUnboundHostedProjectId, probeHostedProjectBinding } from './klauro-config';
import { buildGithubImportPlan } from './github-import';
import { compareAnalysisIterations, getPreviewAnalysis, previewCodebaseIteration, previewGreenfieldCodebase, type ProposedFileInput } from './proposal-preview';
import { buildGreenfieldArchitectureGuidance, type GreenfieldReferenceAnalysis } from './greenfield-guidance';
import { buildGreenfieldBuildContext } from './greenfield-build-session';
import { buildSupportBundle, formatSupportBundleResult } from './support-bundle';
import { formatFullPurgeReport, formatProjectPurgeReport, purgeAll, purgeProject, resolvePurgeRoots } from './purge';
import { getAnalysisRunLogPath } from '../../../packages/analyzer-core/src/analyzer/core/run-log';
import { formatBuildIdentity, getBuildIdentity } from '../../../packages/analyzer-core/src/analyzer/core/build-identity';
import { resolveManifestProjectName } from '../../../packages/analyzer-core/src/analyzer/core/deployable-evidence/util';
import { runSelfUpdate } from './self-update';
import { withAnalysisFocus, type AnalysisFocus } from './analysis-focus';
import { decideInitFlow, resolveNamedChoice, type RecognizedRemote } from './init-resolution';
import { buildCrossCodebaseSystemGraph, selectWorkspaceAnalysisDetail, summarizeCrossCodebaseSystemGraph, type WorkspaceDetailLevel } from './cross-codebase-analysis';
import { clearStoredConnectorSession, connectorToken, isNetworkUnreachableError, loadStoredConnectorAuth, normalizeServerUrl, requireConnectorEntitlement, resolveAuthStatus, saveStoredConnectorSession, unreachableServerError } from './connector-auth';
import { detectRemoteProvider } from './remote-provider';
import { detectWorkspaceIdentity, findFabricProjectRoot, resolveFabricSettings, resolveFabricToken, writeFabricSection } from './coordination/fabric-config';
import { remoteActive } from './coordination/remote-transport';
import { getActiveClaims } from './coordination/local-store';
import * as fs from 'fs-extra';
import * as readline from 'readline';
import { promptLine, promptPassword, readAllStdin } from './password-prompt';
import {
  buildAnalysisStatusLine,
  buildConnectionReport,
  countDirtyFiles,
  detectClaudeMcpRegistration,
  fetchHostedAnalysisState,
  formatConnectionReportLines,
  listDirtyFiles,
  remoteJson,
  renderStatusReport,
  type HostedAnalysisState,
} from './status-report';

export type { HostedAnalysisState };
export { buildAnalysisStatusLine };

interface ParsedArgs {
  command?: string;
  path?: string;
  task: AgentTask;
  json: boolean;
  refresh: boolean;
  compact: boolean;
  quiet: boolean;
  serverUrl?: string;
  analysisId?: string;
  force: boolean;
  dirtyTree: boolean;
  analysisFocus?: AnalysisFocus;
  projectId?: string;
  organizationId?: string;
  planText?: string;
  planFile?: string;
  diffText?: string;
  diffFile?: string;
  proposedFilesFile?: string;
  referencePaths: string[];
  previewId?: string;
  baselinePath?: string;
  proposedPath?: string;
  outputPath?: string;
  host?: string;
  port?: number;
  dataDir?: string;
  detailLevel?: WorkspaceDetailLevel;
  all: boolean;
  allAiCache: boolean;
  yes: boolean;
  email?: string;
  password?: string;
  passwordStdin: boolean;
  register: boolean;
  // §AUTH-LIFECYCLE — reset-password / change-password / admin-mint-reset-token.
  resetToken?: string;
  resetTokenStdin: boolean;
  currentPassword?: string;
  currentPasswordStdin: boolean;
  newPassword?: string;
  newPasswordStdin: boolean;
  mintedBy?: string;
  // Read-subcommand filters (cicd / seams / product-map / node-metrics).
  provider?: string;
  deployOnly: boolean;
  modality?: 'sync' | 'async' | 'passive';
  level?: 'node' | 'deployable' | 'workspace';
  section?: string;
  format?: 'json' | 'mermaid';
  markdown: boolean;
  limit?: number;
  offset?: number;
  /** Fabric workspace override for `klauro init` (same semantics as `klauro fabric on --workspace`). */
  workspace?: string;
}

async function main(): Promise<void> {
  if (process.argv[2] === 'install' || process.argv[2] === 'uninstall') {
    const script = process.argv[2] === 'install' ? 'install.mjs' : 'uninstall.mjs';
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '..', 'scripts', script), ...process.argv.slice(3)], {
      stdio: 'inherit',
    });
    process.exit(result.status ?? 1);
  }

  if (process.argv[2] === '--version' || process.argv[2] === '-v' || process.argv[2] === 'version') {
    if (process.argv.includes('--json')) {
      const identity = getBuildIdentity();
      process.stdout.write(`${JSON.stringify({
        name: 'klauro',
        version: identity.version,
        base_version: identity.base_version,
        channel: identity.channel,
        git_sha: identity.git_sha,
        build_time: identity.build_time ?? null,
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        exec_path: process.execPath,
      }, null, 2)}\n`);
    } else {
      process.stdout.write(`klauro ${formatBuildIdentity()}\n`);
    }
    return;
  }

  if (process.argv[2] === 'fabric') {
    await runFabricCommand(process.argv.slice(3));
    return;
  }

  const args = parseArgs(process.argv.slice(2));
  if (!args.command || args.command === 'help' || args.command === '--help' || args.command === '-h') {
    printHelp();
    return;
  }

  if (args.command === 'purge') {
    await runPurgeCommand(args);
    return;
  }

  if (args.command === 'doctor' && !args.path) {
    const report = await runEnvironmentDoctor({ projectPath: process.cwd() });
    // Same one-glance subsystem view as `klauro status`: is THIS repo fully
    // connected (project identity / in-flight / MCP / fabric)?
    const connection = await buildConnectionReport(process.cwd());
    // The same customer-facing checks `klauro doctor` runs in the shipped CLI
    // (client-doctor.ts, shared with installed-cli.ts) — auth/token age,
    // server reachability + protocol match, CLI version vs latest. Run here
    // too so a developer sees exactly what a customer would, instead of only
    // the dev-package-layout checks above.
    const client = await runClientDoctor({ projectPath: process.cwd(), serverUrl: args.serverUrl });
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ ...report, connection, client }, null, 2)}\n`);
    } else {
      process.stdout.write(
        `${await formatEnvironmentDoctor(report)}\n\n` +
        `Connection (this repo):\n${formatConnectionReportLines(connection).map(line => `  ${line}`).join('\n')}\n\n` +
        `${formatClientDoctor(client)}\n`,
      );
    }
    process.exitCode = report.status === 'fail' || client.status === 'fail' ? 1 : 0;
    return;
  }

  if (args.command === 'login') {
    await runLoginCommand(args);
    return;
  }

  if (args.command === 'logout') {
    const result = clearStoredConnectorSession(args.serverUrl);
    process.stdout.write(args.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : `${result.removed ? 'Removed' : 'No stored'} Klauro login for ${result.serverUrl}\n`);
    return;
  }

  if (args.command === 'reset-password') {
    await runResetPasswordCommand(args);
    return;
  }

  if (args.command === 'change-password') {
    await runChangePasswordCommand(args);
    return;
  }

  if (args.command === 'admin-mint-reset-token') {
    await runAdminMintResetTokenCommand(args);
    return;
  }

  if (args.command === 'auth-status') {
    // Round-trips to the server (GET /api/me) rather than only checking that
    // a token FILE exists — a locally-present token can be expired or
    // server-side dropped, and this command's whole job is to say so instead
    // of reporting "signed_in: true" while every real API call 401s. See
    // resolveAuthStatus's states: no-token / signed-in / rejected /
    // unreachable. Bounded by an internal fetch timeout so an unreachable
    // server reports as such quickly rather than hanging.
    const status = await resolveAuthStatus({ serverUrl: args.serverUrl });
    process.stdout.write(args.json
      ? `${JSON.stringify({ ...status, signed_in: status.state === 'signed-in' }, null, 2)}\n`
      : `${status.detail}\n`);
    return;
  }

  if (args.command === 'analyzer-server') {
    await runAnalyzerServerCommand(args);
    return;
  }

  if (args.command === 'update' || args.command === 'upgrade' || args.command === 'self-update') {
    await runUpdateCommand(args);
    return;
  }

  if (args.command === 'whoami') {
    // Same real-state check as auth-status (see that handler's comment) —
    // whoami used to answer from the local token file alone and could say
    // "signed in" for a session the server had already rejected.
    const status = await resolveAuthStatus({ serverUrl: args.serverUrl });
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ ...status, signed_in: status.state === 'signed-in', email: status.email ?? null }, null, 2)}\n`);
    } else {
      process.stdout.write(`${status.detail}\n`);
    }
    return;
  }

  if (args.command === 'status') {
    await runStatusCommand(args);
    return;
  }

  if (![
    'analyzer-server',
    'login',
    'logout',
    'auth-status',
    'init',
    'index',
    'analyze',
    'upload-manifest',
    'install-agent',
    'github-import-plan',
    'agent-start',
    'agent-context',
    'agent-tracks',
    'agent-install',
    'doctor',
    'save-golden',
    'orient',
    'cicd',
    'seams',
    'product-map',
    'erd',
    'node-metrics',
    'remote-analyze',
    'remote-sync',
    'proposal-preview',
    'greenfield-preview',
    'greenfield-guidance',
    'greenfield-build-context',
    'preview-get',
    'compare-iterations',
    'workspace-analysis',
    'workspace-get',
    'workspace-list',
    'cross-codebase-analysis',
    'cross-codebase-get',
    'cross-codebase-list',
    'support-bundle',
    'account-workspaces',
    'account-workspace-attach',
  ].includes(args.command)) {
    throw new Error(`Unknown command: ${args.command}`);
  }
  // Track whether the caller gave an explicit path vs. the '.' default below.
  // `init` uses this to make the ambient-cwd case loud instead of silent —
  // see the 2026-07-06 cold-customer audit: a `klauro init` run with no
  // explicit path from a process whose cwd was NOT the intended repo (e.g. an
  // agent invoked without first `cd`-ing into the target fixture) silently
  // registered a hosted project under whatever directory `.` happened to
  // resolve to, name/local_path and all. Ambient cwd is fine for a human at a
  // terminal who obviously knows where they are; it is not a safe default for
  // scripted/agent invocations.
  const pathWasExplicit = Boolean(args.path);
  if (!args.path && ['init', 'index', 'analyze', 'upload-manifest', 'install-agent', 'github-import-plan', 'agent-tracks', 'account-workspace-attach'].includes(args.command)) {
    args.path = '.';
  }
  if (!args.path && !['greenfield-preview', 'greenfield-guidance', 'greenfield-build-context', 'preview-get', 'compare-iterations', 'workspace-analysis', 'workspace-get', 'workspace-list', 'cross-codebase-analysis', 'cross-codebase-get', 'cross-codebase-list', 'support-bundle', 'account-workspaces'].includes(args.command)) {
    throw new Error(`${args.command} requires a project path`);
  }

  const projectPath = args.path ? path.resolve(args.path) : '';

  if (args.command === 'init') {
    await runInitCommand(projectPath, args, { pathWasExplicit });
    return;
  }

  if (args.command === 'upload-manifest') {
    const manifest = await buildUploadManifest(projectPath, args.dirtyTree ? 'dirty-tree' : 'full');
    process.stdout.write(args.json ? `${JSON.stringify(manifest, null, 2)}\n` : formatUploadManifest(manifest));
    return;
  }

  if (args.command === 'index') {
    const loaded = await loadKlauroConfig(projectPath);
    const serverUrl = args.serverUrl || loaded.config.analyzer.serverUrl;
    const identity = await requireConnectorEntitlement({ serverUrl });
    const manifest = await buildUploadManifest(projectPath, args.dirtyTree ? 'dirty-tree' : 'full');
    const result = {
      status: 'success',
      index_type: 'source-upload-manifest',
      authoritative: false,
      visibility: 'not-published',
      account: {
        user: identity.user,
        entitlement: identity.entitlement,
      },
      manifest,
      next: [
        'Run klauro analyze to upload this source snapshot for hosted analysis.',
        'Run klauro sync while editing to publish in-flight changes for hosted incremental analysis.',
      ],
    };
    process.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : formatUploadPreparationResult(result));
    return;
  }

  if (args.command === 'agent-tracks') {
    const result = await getAgentRevisionTracks({ projectPath, serverUrl: args.serverUrl, analysisId: args.analysisId });
    process.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : formatAgentRevisionTracks(result));
    return;
  }

  if (args.command === 'github-import-plan') {
    const loaded = await loadKlauroConfig(projectPath);
    const plan = buildGithubImportPlan(projectPath, loaded.config);
    process.stdout.write(args.json ? `${JSON.stringify(plan, null, 2)}\n` : formatGithubImportPlan(plan));
    return;
  }

  if (args.command === 'analyze') {
    // One product: analysis always goes to the hosted service (heavy work + AI on the
    // VPS), production by default. No local/remote mode. serverUrl can point at a
    // Customer installs always submit analysis to the hosted Klauro service.
    const result = await withLogHandling(args.json, args.quiet, () => analyzeCodebaseRemotely({
      projectPath,
      serverUrl: args.serverUrl,
      analysisId: args.analysisId,
      requireBoundProject: true,
    }));
    process.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : formatRemoteResult(result));
    return;
  }

  if (args.command === 'remote-analyze') {
    const result = await withLogHandling(args.json, args.quiet, () => analyzeCodebaseRemotely({
      projectPath,
      serverUrl: args.serverUrl,
      analysisId: args.analysisId,
      requireBoundProject: true,
    }));
    process.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : formatRemoteResult(result));
    return;
  }

  if (args.command === 'remote-sync') {
    const result = await withLogHandling(args.json, args.quiet, () => syncWorkingTreeRemotely({
      projectPath,
      serverUrl: args.serverUrl,
      analysisId: args.analysisId,
      requireBoundProject: true,
    }));
    process.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : formatRemoteResult(result));
    return;
  }

  if (args.command === 'proposal-preview') {
    const result = await withLogHandling(args.json, args.quiet, () => previewCodebaseIteration({
      path: projectPath,
      title: args.task.target,
      planText: loadTextArg(args.planText, args.planFile, 'proposal-preview requires --plan or --plan-file'),
      diffText: loadOptionalTextArg(args.diffText, args.diffFile),
      proposedFiles: loadProposedFiles(args.proposedFilesFile),
      organizationId: args.organizationId,
      projectId: args.projectId,
      codebaseId: args.analysisId,
      previewBaseUrl: args.serverUrl,
    }));
    process.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : formatProposalPreviewResult(result));
    return;
  }

  if (args.command === 'greenfield-preview') {
    const result = await withLogHandling(args.json, args.quiet, () => previewGreenfieldCodebase({
      title: args.task.target,
      planText: loadTextArg(args.planText, args.planFile, 'greenfield-preview requires --plan or --plan-file'),
      proposedFiles: loadProposedFiles(args.proposedFilesFile),
      organizationId: args.organizationId,
      projectId: args.projectId,
      previewBaseUrl: args.serverUrl,
    }));
    process.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : formatProposalPreviewResult(result));
    return;
  }

  if (args.command === 'greenfield-guidance') {
    const references: GreenfieldReferenceAnalysis[] = [];
    for (const referencePath of args.referencePaths) {
      const absolute = path.resolve(referencePath);
      const cas = await withLogHandling(args.json, args.quiet, () => loadOrAnalyze(absolute, false));
      references.push({
        path: absolute,
        name: cas.system?.name || resolveManifestProjectName(absolute, path.basename(absolute)),
        cas,
      });
    }
    const result = buildGreenfieldArchitectureGuidance({
      planText: loadTextArg(args.planText, args.planFile, 'greenfield-guidance requires --plan or --plan-file'),
      proposedFiles: loadProposedFiles(args.proposedFilesFile),
      references,
    });
    process.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : formatGreenfieldGuidance(result));
    return;
  }

  if (args.command === 'greenfield-build-context') {
    const references: GreenfieldReferenceAnalysis[] = [];
    for (const referencePath of args.referencePaths) {
      const absolute = path.resolve(referencePath);
      const cas = await withLogHandling(args.json, args.quiet, () => loadOrAnalyze(absolute, false));
      references.push({
        path: absolute,
        name: cas.system?.name || resolveManifestProjectName(absolute, path.basename(absolute)),
        cas,
      });
    }
    const result = await withLogHandling(args.json, args.quiet, () => buildGreenfieldBuildContext({
      workspacePath: args.path ? path.resolve(args.path) : process.cwd(),
      planText: loadTextArg(args.planText, args.planFile, 'greenfield-build-context requires --plan or --plan-file'),
      proposedFiles: loadProposedFiles(args.proposedFilesFile),
      references,
    }));
    process.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : formatGreenfieldBuildContext(result));
    return;
  }

  if (args.command === 'support-bundle') {
    const result = await buildSupportBundle({
      projectPath: args.path ? projectPath : undefined,
      outputPath: args.outputPath,
    });
    process.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : formatSupportBundleResult(result));
    return;
  }

  if (args.command === 'preview-get') {
    const result = await getPreviewAnalysis(args.previewId || 'latest');
    process.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : formatPreviewPayload(result));
    return;
  }

  if (args.command === 'compare-iterations') {
    const result = await compareAnalysisIterations({
      previewId: args.previewId,
      baselinePath: args.baselinePath,
      proposedPath: args.proposedPath,
      diffText: loadOptionalTextArg(args.diffText, args.diffFile),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (args.command === 'workspace-analysis' || args.command === 'cross-codebase-analysis') {
    const selectedPaths = [...(args.path ? [projectPath] : []), ...args.referencePaths];
    if (selectedPaths.length < 1) throw new Error('workspace-analysis requires at least one analyzed path. Pass a path plus --reference-path for each associated codebase.');
    const repositories = [];
    for (const selectedPath of selectedPaths) {
      const absolute = path.resolve(selectedPath);
      const cas = await withLogHandling(args.json, args.quiet, () => loadOrAnalyze(absolute, args.refresh));
      repositories.push({ path: absolute, name: cas.system?.name || resolveManifestProjectName(absolute, path.basename(absolute)), cas });
    }
    const graph = buildCrossCodebaseSystemGraph(args.task.target || 'analyzed-system', repositories);
    const saved = await saveCrossCodebaseSystemGraph(graph);
    const result = { saved, summary: summarizeCrossCodebaseSystemGraph(graph), graph };
    process.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : formatWorkspaceAnalysisResult(result));
    return;
  }

  if (args.command === 'workspace-get' || args.command === 'cross-codebase-get') {
    const graph = await loadCrossCodebaseSystemGraph(args.previewId || args.task.target || 'analyzed-system');
    if (!graph) throw new Error(`Workspace analysis not found: ${args.previewId || args.task.target || 'analyzed-system'}`);
    const result = args.detailLevel && args.detailLevel !== 'full'
      ? selectWorkspaceAnalysisDetail(graph, args.detailLevel)
      : { summary: summarizeCrossCodebaseSystemGraph(graph), graph };
    process.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : formatWorkspaceAnalysisResult(result));
    return;
  }

  if (args.command === 'workspace-list' || args.command === 'cross-codebase-list') {
    const graphs = await listCrossCodebaseSystemGraphs();
    process.stdout.write(args.json ? `${JSON.stringify(graphs, null, 2)}\n` : formatWorkspaceAnalysisList(graphs));
    return;
  }

  // "account-workspace-*" (not "workspace-*") to avoid colliding with the
  // pre-existing local cross-codebase workspace-level-CAS graph commands above
  // (workspace-analysis/-get/-list), which are a completely different concept
  // (a locally-saved multi-repo analysis graph, no server account involved).
  // These two talk to the hosted AccountStore workspace/project model
  // (account-store.ts) instead: `id + name` listing, and attaching an
  // already-analyzed, already-`klauro init`-connected project to a different
  // hosted workspace.
  if (args.command === 'account-workspaces') {
    const auth = loadStoredConnectorAuth();
    const serverUrl = normalizeServerUrl(args.serverUrl || auth.defaultServerUrl);
    const token = connectorToken(undefined, serverUrl);
    if (!token) throw new Error(`Klauro account required for ${serverUrl}. Run \`klauro login\` first.`);
    const workspaces = await listRemoteWorkspaces(serverUrl, token);
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ workspaces }, null, 2)}\n`);
    } else if (!workspaces.length) {
      process.stdout.write('No workspaces.\n');
    } else {
      process.stdout.write(workspaces
        .map(workspace => `${workspace.id}  ${workspace.name}${workspace.project_count !== undefined ? ` (${workspace.project_count} project${workspace.project_count === 1 ? '' : 's'})` : ''}`)
        .join('\n') + '\n');
    }
    return;
  }

  if (args.command === 'account-workspace-attach') {
    if (!args.workspace) throw new Error('account-workspace-attach requires --workspace <id-or-name>');
    const loaded = await loadKlauroConfig(projectPath);
    const boundProjectId = loaded.config.project.id;
    if (!boundProjectId) {
      throw new Error(`${projectPath} is not connected to a hosted Klauro project yet. Run \`klauro init\` first, then retry account-workspace-attach.`);
    }
    const serverUrl = normalizeServerUrl(args.serverUrl || loaded.config.analyzer.serverUrl);
    const token = connectorToken(undefined, serverUrl);
    if (!token) throw new Error(`Klauro account required for ${serverUrl}. Run \`klauro login\` first.`);
    const workspaces = await listRemoteWorkspaces(serverUrl, token);
    const targetWorkspace = resolveWorkspaceTarget(workspaces, args.workspace);
    const result = await attachRemoteProject(serverUrl, token, targetWorkspace.id, boundProjectId);
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ ...result, workspace: targetWorkspace }, null, 2)}\n`);
      return;
    }
    if (result.already_attached) {
      process.stdout.write(`Project "${result.project.name}" is already attached to workspace "${targetWorkspace.name}". No change made, no rebuild scheduled.\n`);
      return;
    }
    process.stdout.write([
      `Attached project "${result.project.name}" to workspace "${targetWorkspace.name}".`,
      // Honest about the model: AccountProject.workspace_id is a single required
      // foreign key, not a join table, so this is a MOVE — the project left
      // whatever workspace it was previously in, it did not gain a second one.
      'This is a move, not an additional membership: a project belongs to exactly one workspace at a time.',
      `Workspace analysis for "${targetWorkspace.name}" is rebuilding in the background now that its membership changed (was_rebuild: ${result.was_rebuild}).`,
    ].join('\n') + '\n');
    return;
  }

  const cas = await withLogHandling(args.json, args.quiet, () => loadOrAnalyze(projectPath, args.refresh));

  if (args.command === 'agent-start') {
    const bootstrap = await getAgentBootstrap(cas, projectPath, args.task);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(bootstrap, null, 2)}\n`);
    } else {
      process.stdout.write(`${bootstrap.prompt}\n`);
    }
    return;
  }

  if (args.command === 'agent-context') {
    const context = await getAgentContext(cas, projectPath, args.task);
    const output = args.compact ? compactAgentContext(context) : context;
    process.stdout.write(args.json ? `${JSON.stringify(output, null, 2)}\n` : formatAgentContext(context));
    return;
  }

  if (args.command === 'doctor') {
    const doctor = await getAgentDoctor(cas, projectPath);
    process.stdout.write(args.json ? `${JSON.stringify(doctor, null, 2)}\n` : formatDoctor(doctor));
    return;
  }

  if (args.command === 'agent-install' || args.command === 'install-agent') {
    const config = await writeAgentDefaultConfig(cas, projectPath, args.task);
    process.stdout.write(args.json ? `${JSON.stringify(config, null, 2)}\n` : `Installed Klauro agent defaults: ${config.install?.markdown_file}\n`);
    return;
  }

  if (args.command === 'save-golden') {
    const snapshot = buildCASGoldenSnapshot(cas);
    const saved = await saveGoldenSnapshot(projectPath, snapshot);
    const output = { saved, snapshot };
    process.stdout.write(args.json ? `${JSON.stringify(output, null, 2)}\n` : `Saved CAS golden snapshot: ${saved.file}\n`);
    return;
  }

  // Thin read subcommands: engineer-facing CLI parity for the high-value MCP
  // reads. Each wraps the SAME query builder as its MCP tool (no logic fork),
  // so the CLI and MCP surfaces return byte-identical data for a given repo.
  if (args.command === 'orient') {
    const capsule = query.buildOrientCapsule(cas);
    process.stdout.write(`${JSON.stringify(capsule, null, 2)}\n`);
    return;
  }

  if (args.command === 'cicd') {
    const result = query.getCicdPipelines(cas, {
      provider: args.provider,
      deployOnly: args.deployOnly,
      limit: args.limit,
      offset: args.offset,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (args.command === 'seams') {
    const result = query.getCommunicationSeams(cas, {
      modality: args.modality,
      level: args.level,
      limit: args.limit,
      offset: args.offset,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (args.command === 'product-map') {
    const result = query.getProductMap(cas, { section: args.section, format: args.markdown ? 'markdown' : 'json' });
    process.stdout.write(args.markdown && (result as any).markdown ? `${(result as any).markdown}\n` : `${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (args.command === 'erd') {
    const result = query.getErd(cas, { format: args.format, entityName: args.task.target });
    // Print the Mermaid diagram raw so it can be piped straight into a renderer.
    if (args.format === 'mermaid') {
      process.stdout.write(`${(result as any).mermaid}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
    return;
  }

  if (args.command === 'node-metrics') {
    const observations = await loadTelemetryObservations(projectPath, { source: 'ingested', limit: 5000 }).catch(() => ({ observations: [] as any[] }));
    const nodeMetrics = buildNodeRuntimeMetrics(cas, observations.observations || [], args.limit ? { limit: args.limit } : undefined);
    process.stdout.write(`${JSON.stringify({ observation_count: observations.observations?.length || 0, node_metrics: nodeMetrics }, null, 2)}\n`);
    return;
  }
}

async function runPurgeCommand(args: ParsedArgs): Promise<void> {
  if (!args.all && !args.path) {
    throw new Error('purge requires a project path or --all');
  }
  const roots = resolvePurgeRoots();

  if (args.all) {
    const confirmed = await confirmDestructiveAction(
      `This permanently deletes ALL local Klauro data under ${roots.klauroRoot} (analyses, snapshots, caches, embeddings, telemetry, logs, AI cache).`,
      args.yes,
    );
    if (!confirmed) {
      process.stdout.write('Aborted; nothing was removed.\n');
      process.exitCode = 1;
      return;
    }
    const report = await purgeAll();
    process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : formatFullPurgeReport(report));
    return;
  }

  const projectPath = path.resolve(args.path!);
  const confirmed = await confirmDestructiveAction(
    `This permanently deletes all stored Klauro data for ${projectPath} (analysis, snapshots, file cache, embeddings, descriptions, telemetry, run-log entries, project AI cache${args.allAiCache ? ', plus the ENTIRE shared AI cache (--all-ai-cache)' : ''}).`,
    args.yes,
  );
  if (!confirmed) {
    process.stdout.write('Aborted; nothing was removed.\n');
    process.exitCode = 1;
    return;
  }
  const report = await purgeProject(projectPath, { allAiCache: args.allAiCache });
  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : formatProjectPurgeReport(report));
}

async function confirmDestructiveAction(description: string, preApproved: boolean): Promise<boolean> {
  if (preApproved) return true;
  if (!process.stdin.isTTY) {
    throw new Error(`${description}\nRe-run with --yes to confirm (non-interactive session).`);
  }
  process.stdout.write(`${description}\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>(resolve => rl.question('Proceed? [y/N] ', resolve));
  rl.close();
  return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
}

/**
 * `klauro update` implementation moved to ./self-update so the SHIPPED CLI
 * (installed-cli.ts -> dist/cli.cjs) can import the same code. It used to live
 * here, in the developer-only entry point, which is why every released CLI
 * through 1.0.127 had no `update` command while the server told users to run
 * it. Re-exported for the existing unit tests that import from './cli'.
 */
export {
  DEFAULT_MIN_NODE,
  checkNodeVersionForUpdate,
  filterNpmNoise,
  resolveSelfUpdateTarget,
  detectBuildNodeVersion,
  buildUpdateSpawnEnv,
  resolveTarballUrl,
  isRunningAsSeaBinary,
  resolveSeaPlatformId,
  type ReleaseManifest,
} from './self-update';

async function runUpdateCommand(args: ParsedArgs): Promise<void> {
  const auth = loadStoredConnectorAuth();
  const serverUrl = normalizeServerUrl(
    args.serverUrl || auth.defaultServerUrl || process.env.KLAURO_URL,
  );
  await runSelfUpdate({
    serverUrl,
    checkOnly: process.argv.includes('--check'),
    force: args.force,
    json: args.json,
  });
}

// HostedAnalysisState / fetchHostedAnalysisState / buildAnalysisStatusLine
// live in ./status-report (imported above) — shared with installed-cli.ts so
// `klauro status`'s reporting logic can never re-diverge the way `klauro
// update` did through 1.0.129 (see status-report.ts's header comment).

async function runStatusCommand(args: ParsedArgs): Promise<void> {
  // Full logic lives in ./status-report (renderStatusReport), shared with
  // installed-cli.ts's `status` handler — see that module's header comment.
  const repoPath = path.resolve(args.path || '.');
  const { report, lines } = await renderStatusReport({ repoPath, serverUrl: args.serverUrl });
  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(lines.join('\n') + '\n');
}

async function runLoginCommand(args: ParsedArgs): Promise<void> {
  const serverUrl = normalizeServerUrl(args.serverUrl);
  // Credentials must travel over HTTPS only — never send a password in the clear.
  if (!/^https:\/\//i.test(serverUrl) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(serverUrl)) {
    throw new Error(`Refusing to send credentials over a non-HTTPS server URL: ${serverUrl}`);
  }
  const email = args.email || await promptLine('Email: ');
  // Password read, in priority order:
  //  1. --password-stdin  (scriptable; read the piped/redirected stdin stream)
  //  2. --password VALUE  (legacy; DEPRECATED — see warning below)
  //  3. interactive no-echo TTY prompt (characters are never echoed)
  // The value is never echoed, logged, or persisted; only the exchanged token is stored.
  if (args.password && !args.passwordStdin) {
    // A value passed with `--password` is written into the shell's history
    // file and is visible to any other process/user on the machine via `ps`
    // for as long as this process runs — that exposure is exactly what
    // interactive prompting and --password-stdin exist to avoid. Kept
    // working (not removed) for scripted/CI callers that already use it, but
    // every use is flagged so a human at a terminal knows to stop.
    process.stderr.write(
      'Warning: --password on the command line is visible in your shell history and to other processes on this machine (via `ps`). Prefer the interactive prompt (omit --password) or --password-stdin for scripts.\n',
    );
  }
  const password = args.passwordStdin
    ? await readAllStdin()
    : (args.password || await promptPassword('Password: '));
  if (!email) throw new Error('login requires --email or an entered email');
  if (!password) throw new Error('login requires --password, --password-stdin, or an entered password');
  const endpoint = args.register ? '/api/auth/register' : '/api/auth/login';
  let response: Response;
  try {
    response = await fetch(`${serverUrl}${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args.register
        ? { email, password, workspace_name: 'Klauro' }
        : { email, password }),
    });
  } catch (error) {
    // A typo'd --server-url is a URL problem, not a credentials problem.
    if (isNetworkUnreachableError(error)) throw unreachableServerError(serverUrl, error);
    throw error;
  }
  const payload = await response.json().catch(() => ({})) as any;
  if (!response.ok || !payload?.token) {
    throw new Error(payload?.error || `Klauro login failed with HTTP ${response.status}`);
  }
  const stored = saveStoredConnectorSession({
    serverUrl,
    token: payload.token,
    email: payload.user?.email || email,
  });
  const identity = await requireConnectorEntitlement({ serverUrl, token: payload.token });
  const result = {
    status: 'success',
    server_url: stored.serverUrl,
    auth_file: stored.file,
    user: identity.user,
    entitlement: identity.entitlement,
  };
  process.stdout.write(args.json
    ? `${JSON.stringify(result, null, 2)}\n`
    : `Signed in to ${stored.serverUrl} as ${identity.user?.email || email} (${identity.entitlement.status}).\nAuth stored at ${stored.file}\n`);
}

/**
 * §AUTH-LIFECYCLE — `klauro reset-password`. Redeems a single-use reset
 * token minted by an operator (there is no self-service email flow — see
 * account-store.ts's AccountPasswordResetToken doc comment) against
 * POST /api/auth/reset-password/redeem. PUBLIC endpoint by design: the
 * whole point is recovering an account that has no valid session, so
 * authorization here is possession of the token itself, never a stored
 * login. On success the account's password is changed and every existing
 * session for it is invalidated server-side — the caller must run
 * `klauro login` afterward to get a fresh session (this command
 * deliberately does not auto-login, so the new password is exercised at
 * least once by the human/operator confirming it works).
 */
async function runResetPasswordCommand(args: ParsedArgs): Promise<void> {
  const serverUrl = normalizeServerUrl(args.serverUrl);
  if (!/^https:\/\//i.test(serverUrl) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(serverUrl)) {
    throw new Error(`Refusing to send a reset token over a non-HTTPS server URL: ${serverUrl}`);
  }
  const token = args.resetTokenStdin ? await readAllStdin() : (args.resetToken || await promptLine('Reset token: '));
  if (!token) throw new Error('reset-password requires --token, --token-stdin, or an entered token');
  if (args.newPassword && !args.newPasswordStdin) {
    process.stderr.write(
      'Warning: --new-password on the command line is visible in your shell history and to other processes on this machine (via `ps`). Prefer the interactive prompt (omit --new-password) or --new-password-stdin.\n',
    );
  }
  const newPassword = args.newPasswordStdin ? await readAllStdin() : (args.newPassword || await promptPassword('New password: '));
  if (!newPassword) throw new Error('reset-password requires --new-password, --new-password-stdin, or an entered password');

  let response: Response;
  try {
    response = await fetch(`${serverUrl}/api/auth/reset-password/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, new_password: newPassword }),
    });
  } catch (error) {
    if (isNetworkUnreachableError(error)) throw unreachableServerError(serverUrl, error);
    throw error;
  }
  const payload = await response.json().catch(() => ({})) as any;
  if (!response.ok) {
    throw new Error(payload?.error || `Klauro password reset failed with HTTP ${response.status}`);
  }
  const result = { status: 'success', server_url: serverUrl, email: payload.email ?? null };
  process.stdout.write(args.json
    ? `${JSON.stringify(result, null, 2)}\n`
    : `Password reset. Every previous session for ${payload.email || 'this account'} has been signed out.\nRun \`klauro login --email ${payload.email || '<email>'}\` to sign in with the new password.\n`);
}

/**
 * §AUTH-LIFECYCLE — `klauro change-password`. Requires an already-signed-in
 * session (the stored connector auth this repo/host is using) and the
 * CURRENT password — see AccountStore.changePassword's doc comment for why.
 * On success the server rotates the session token (every other session is
 * revoked) and this command immediately persists the new token via the same
 * stored-connector-session mechanism `klauro login` uses, so the caller is
 * not logged out by their own password change.
 */
async function runChangePasswordCommand(args: ParsedArgs): Promise<void> {
  const serverUrl = normalizeServerUrl(args.serverUrl);
  if (!/^https:\/\//i.test(serverUrl) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(serverUrl)) {
    throw new Error(`Refusing to send credentials over a non-HTTPS server URL: ${serverUrl}`);
  }
  const token = connectorToken(undefined, serverUrl);
  if (!token) throw new Error('change-password requires an existing session — run `klauro login` first.');

  if (args.currentPassword && !args.currentPasswordStdin) {
    process.stderr.write('Warning: --current-password on the command line is visible in shell history and to other processes. Prefer the interactive prompt or --current-password-stdin.\n');
  }
  if (args.newPassword && !args.newPasswordStdin) {
    process.stderr.write('Warning: --new-password on the command line is visible in shell history and to other processes. Prefer the interactive prompt or --new-password-stdin.\n');
  }
  const currentPassword = args.currentPasswordStdin ? await readAllStdin() : (args.currentPassword || await promptPassword('Current password: '));
  const newPassword = args.newPasswordStdin ? await readAllStdin() : (args.newPassword || await promptPassword('New password: '));
  if (!currentPassword) throw new Error('change-password requires --current-password, --current-password-stdin, or an entered password');
  if (!newPassword) throw new Error('change-password requires --new-password, --new-password-stdin, or an entered password');

  let response: Response;
  try {
    response = await fetch(`${serverUrl}/api/auth/change-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    });
  } catch (error) {
    if (isNetworkUnreachableError(error)) throw unreachableServerError(serverUrl, error);
    throw error;
  }
  const payload = await response.json().catch(() => ({})) as any;
  if (!response.ok || !payload?.token) {
    throw new Error(payload?.error || `Klauro password change failed with HTTP ${response.status}`);
  }
  const stored = saveStoredConnectorSession({ serverUrl, token: payload.token, email: payload.user?.email });
  const result = { status: 'success', server_url: stored.serverUrl, user: payload.user };
  process.stdout.write(args.json
    ? `${JSON.stringify(result, null, 2)}\n`
    : `Password changed for ${payload.user?.email || 'your account'}. Every other session was signed out; this session's token was rotated and saved to ${stored.file}.\n`);
}

/**
 * §AUTH-LIFECYCLE — `klauro admin-mint-reset-token`. OPERATOR-ONLY,
 * server-side/CLI command — NOT an HTTP endpoint. There is no site-wide
 * admin role in the product's authorization model (workspace roles are
 * owner/admin/member, scoped per-workspace, not a superuser concept), so
 * rather than inventing one to gate an HTTP admin-mint route, this command
 * talks to the AccountStore DIRECTLY against the same data directory the
 * `analyzer-server` process uses (--data-dir, or
 * KLAURO_REMOTE_ANALYZER_DATA). The trust boundary is the same one that
 * already gates read-only inspection of accounts.json: being able to run
 * this command on the box (or a shell with access to /data) IS the operator
 * authentication. Prints the raw single-use token to stdout exactly once —
 * this is the generated secret's only appearance; relay it to the account
 * owner out-of-band (chat/call), never re-print or log it. The token
 * expires in 30 minutes (see RESET_TOKEN_TTL_MS in account-store.ts) and is
 * consumed by `klauro reset-password --token <token>` (or
 * POST /api/auth/reset-password/redeem directly).
 */
async function runAdminMintResetTokenCommand(args: ParsedArgs): Promise<void> {
  if (!args.email) throw new Error('admin-mint-reset-token requires --email <account-email>');
  const dataDir = path.resolve(
    args.dataDir
      || process.env.KLAURO_REMOTE_ANALYZER_DATA
      || path.join(os.tmpdir(), `klauro-remote-analyzer-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`),
  );
  const accounts = new AccountStore(dataDir);
  const mintedBy = args.mintedBy || `operator:${os.userInfo().username}@${os.hostname()}`;
  const minted = await accounts.mintPasswordResetToken({ email: args.email, mintedBy });
  const result = {
    status: 'success',
    data_dir: dataDir,
    email: args.email,
    user_id: minted.userId,
    token: minted.token,
    expires_at: minted.expiresAt,
    redeem_with: `klauro reset-password --server-url <server-url> --token <token>`,
  };
  process.stdout.write(args.json
    ? `${JSON.stringify(result, null, 2)}\n`
    : [
      `Minted a password reset token for ${args.email} (data dir: ${dataDir}).`,
      `Token (relay this to the account owner out-of-band — it is shown ONLY here, and it is single-use):`,
      `  ${minted.token}`,
      `Expires at ${minted.expiresAt} (30 minutes from now).`,
      `The account owner redeems it with:`,
      `  klauro reset-password --server-url <server-url> --token ${minted.token}`,
      `or by POSTing { "token": "...", "new_password": "..." } to /api/auth/reset-password/redeem.`,
      `Redeeming invalidates every existing session for the account.`,
    ].join('\n') + '\n');
}

/**
 * `klauro fabric on|off|status` — FINE CONTROL over the coordination fabric
 * (docs/FABRIC-REMOTE.md). The happy path is `klauro init`, which enables the
 * fabric by default as part of connecting a repo; this subcommand survives for
 * the detail view (`status`), the rare explicit opt-out (`off`), and
 * re-enabling after an opt-out (`on`). `on` resolves the endpoint from the
 * repo's .klaurorc / stored login, the Bearer token from the SAME credential
 * store `klauro init`/`klauro login` maintain (~/.klauro/auth.json — never
 * prompted for, never written into the repo), autodetects a stable workspace
 * identity (project.id > git-remote hash > repo basename; --workspace
 * overrides), and persists `{fabric: {enabled, endpoint, workspace}}` into
 * .klaurorc so every fab.ts call and fab_* MCP tool in this repo is remote
 * automatically, across shells and sessions.
 */
async function runFabricCommand(argv: string[]): Promise<void> {
  let action: string | undefined;
  let workspaceFlag: string | undefined;
  let serverUrlFlag: string | undefined;
  let pathArg: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--workspace') workspaceFlag = argv[++i];
    else if (arg === '--server-url') serverUrlFlag = argv[++i];
    else if (arg === '--json') json = true;
    else if (arg === '--path') pathArg = argv[++i];
    else if (!arg.startsWith('--') && !action) action = arg;
    else if (!arg.startsWith('--') && !pathArg) pathArg = arg;
    else throw new Error(`Unexpected fabric argument: ${arg}`);
  }
  if (!action || !['on', 'off', 'status'].includes(action)) {
    throw new Error('Usage: klauro fabric on|off|status [/path/to/repo] [--workspace name] [--server-url url] [--json]');
  }
  const startDir = path.resolve(pathArg || '.');
  const found = findFabricProjectRoot(startDir);

  if (action === 'status') {
    const settings = await resolveFabricSettings({ cwd: startDir, explicitWorkspace: workspaceFlag });
    const report: Record<string, unknown> = {
      enabled: Boolean(settings.remote),
      mode: settings.remote ? 'remote' : 'local',
      source: settings.remote ? settings.remoteSource : (settings.fabric ? 'config' : 'default'),
      endpoint: settings.remote?.baseUrl ?? null,
      credentials: settings.remote ? Boolean(settings.remote.token) : null,
      workspace: settings.workspace,
      workspace_source: settings.workspaceSource,
      config: settings.configPath ?? null,
    };
    let claims: Array<{ agent_id: string; intent: string; paths: string[] }> = [];
    let claimsNote: string | undefined;
    if (settings.remote) {
      try {
        const active = await remoteActive(settings.remote, settings.workspace);
        claims = active.active.map(c => ({ agent_id: c.agent_id, intent: c.intent, paths: c.paths }));
      } catch (err) {
        claimsNote = `remote fabric unreachable (${err instanceof Error ? err.message : String(err)}) — active claims unavailable; fab commands will degrade to the local fabric.`;
      }
    } else {
      claims = (await getActiveClaims(settings.workspace)).map(c => ({ agent_id: c.agent_id, intent: c.intent, paths: c.scope.paths }));
      claimsNote = 'local fabric (same-machine peers only)';
    }
    report.active_claims = claims;
    if (claimsNote) report.note = claimsNote;
    if (args_json_write(json, report)) return;
    const lines = [
      settings.remote
        ? `Fabric:    ON (remote, via ${report.source}) -> ${settings.remote.baseUrl}${settings.remote.token ? '' : '  [NO CREDENTIALS — run `klauro login`]'}`
        : `Fabric:    OFF (local fabric only${settings.fabric ? ', disabled in .klaurorc — re-enable with `klauro fabric on`' : ' — run `klauro init` in the repo to connect it (fabric included)'})`,
      `Workspace: ${settings.workspace} (${settings.workspaceSource})`,
      `Config:    ${settings.configPath || 'none found (run `klauro init`)'}`,
      claimsNote && settings.remote ? `Note:      ${claimsNote}` : undefined,
      claims.length
        ? `Active claims (${claims.length}):\n${claims.map(c => `  ${c.agent_id} intent="${c.intent}" paths=${JSON.stringify(c.paths)}`).join('\n')}`
        : 'Active claims: none',
    ].filter(Boolean);
    process.stdout.write(lines.join('\n') + '\n');
    return;
  }

  if (action === 'off') {
    if (!found) {
      process.stdout.write(`No .klaurorc found at or above ${startDir} — the fabric here is already local-only.\n`);
      return;
    }
    const loaded = await loadKlauroConfig(found.root);
    const prior = loaded.config.fabric;
    const section = { ...(prior || {}), enabled: false };
    const { configPath } = writeFabricSection(found.root, section);
    if (args_json_write(json, { status: 'disabled', config: configPath, fabric: section })) return;
    process.stdout.write(`Fabric OFF — fab commands in this repo now use the LOCAL fabric only (${configPath}).\nRe-enable any time with: klauro fabric on\n`);
    return;
  }

  // action === 'on'
  if (!found) {
    throw new Error(
      `No .klaurorc found at or above ${startDir}. Run \`klauro init\` in the repo first, then \`klauro fabric on\`.`,
    );
  }
  const loaded = await loadKlauroConfig(found.root);
  const endpoint = normalizeServerUrl(serverUrlFlag || loaded.config.fabric?.endpoint || loaded.config.analyzer.serverUrl);
  const token = resolveFabricToken(endpoint);
  if (!token) {
    throw new Error(
      `No stored Klauro credentials for ${endpoint}. Run \`klauro init\` (or \`klauro login --server-url ${endpoint}\`) first — ` +
        'fabric reuses that stored account; it never takes raw tokens.',
    );
  }
  const identity = workspaceFlag && workspaceFlag.trim()
    ? { workspace: workspaceFlag.trim(), source: 'explicit' as const }
    : detectWorkspaceIdentity(found.root, loaded.config.project.id);
  const { configPath } = writeFabricSection(found.root, { enabled: true, endpoint, workspace: identity.workspace });

  // Reachability probe — advisory contract: an unreachable service is a loud
  // warning, not a failure; the config persists and fab degrades gracefully.
  let activeCount: number | null = null;
  let probeError: string | undefined;
  try {
    const active = await remoteActive({ baseUrl: endpoint, token }, identity.workspace);
    activeCount = active.count;
  } catch (err) {
    probeError = err instanceof Error ? err.message : String(err);
  }

  if (args_json_write(json, {
    status: 'enabled',
    config: configPath,
    endpoint,
    workspace: identity.workspace,
    workspace_source: identity.source,
    reachable: probeError === undefined,
    active_claims: activeCount,
    probe_error: probeError ?? null,
  })) return;
  process.stdout.write([
    `Fabric ON — every fab command and fab_* MCP tool in this repo now coordinates through ${endpoint}`,
    `Workspace: ${identity.workspace} (${identity.source}${identity.source !== 'explicit' ? '; override with --workspace <name>' : ''})`,
    `Config:    ${configPath}`,
    probeError === undefined
      ? `Verified:  service reachable, ${activeCount} active claim${activeCount === 1 ? '' : 's'} in this workspace`
      : `WARNING:   could not reach the service (${probeError}). Config saved anyway; fab commands will warn and degrade to the LOCAL fabric until it is reachable.`,
    '',
  ].join('\n'));
}

function args_json_write(json: boolean, payload: unknown): boolean {
  if (!json) return false;
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  return true;
}

/**
 * `klauro init` — THE one onboarding command. Run in a repo, it connects the
 * project to Klauro end to end, in order: (a) auth (reuse stored credentials,
 * never prompts for a password), (b) project identity (.klaurorc + the stable
 * workspace identity), (c) analysis (kicks off the hosted analysis when signed
 * in), (d) in-flight tracking (automatic — reported, not configured), (e) MCP
 * agent wiring (detected; offered via `klauro install` when missing), and
 * (f) the coordination fabric — ENABLED BY DEFAULT as part of connecting
 * (parallel-through-fabric is the product's default mode, not an opt-in;
 * `klauro fabric off` remains the rare explicit opt-out and is respected on
 * re-runs). Re-running init on a connected repo is idempotent: it verifies and
 * refreshes each subsystem instead of erroring.
 */
interface InitStep {
  step: 'auth' | 'project' | 'analysis' | 'in-flight' | 'mcp' | 'fabric';
  status: 'ok' | 'warn' | 'skip';
  detail: string;
}

async function runInitCommand(projectPath: string, args: ParsedArgs, options: { pathWasExplicit: boolean } = { pathWasExplicit: true }): Promise<void> {
  const steps: InitStep[] = [];
  const labels: Record<InitStep['step'], string> = {
    auth: 'Auth', project: 'Project', analysis: 'Analysis', 'in-flight': 'In-flight', mcp: 'MCP', fabric: 'Fabric',
  };
  const record = (step: InitStep['step'], status: InitStep['status'], detail: string) => {
    steps.push({ step, status, detail });
    if (!args.json) {
      const marker = status === 'ok' ? 'OK  ' : status === 'warn' ? 'WARN' : 'SKIP';
      process.stdout.write(`[${steps.length}/6] ${marker} ${labels[step]}: ${detail}\n`);
    }
  };
  // ALWAYS surface the resolved absolute path being connected, in both human
  // and --json output, and call out plainly when it came from an implicit
  // cwd default rather than an explicit --path/positional argument. This is
  // the single most consequential fact in the whole command: init writes
  // .klaurorc AND (when signed in) registers/links a hosted project using
  // this exact directory's name and absolute path (see resolveInitOptions).
  // A scripted/agent caller that didn't explicitly pass a path has no other
  // signal that it might be about to connect the wrong repo — see the
  // 2026-07-06 cold-customer audit, where exactly this silently registered
  // the operator's real repo under a brand-new account.
  if (!args.json) {
    process.stdout.write(`Connecting ${projectPath} to Klauro\n`);
    if (!options.pathWasExplicit) {
      process.stdout.write(`WARN  no --path given — using current directory (${projectPath}). Pass --path explicitly if this is not the repo you intend to connect.\n`);
    }
  }

  // (a) Auth — reuse/verify the stored credentials; login stays a separate,
  // explicit command (init never prompts for a password).
  let loaded = await loadKlauroConfig(projectPath);
  const hadConfig = Boolean(loaded.configPath);
  const auth = loadStoredConnectorAuth();
  const serverUrl = normalizeServerUrl(
    args.serverUrl || (hadConfig ? loaded.config.analyzer.serverUrl : undefined) || auth.defaultServerUrl,
  );
  const token = connectorToken(undefined, serverUrl);
  const email = auth.accounts[serverUrl]?.email;
  if (token) {
    record('auth', 'ok', `signed in to ${serverUrl}${email ? ` as ${email}` : ''}`);
  } else {
    record('auth', 'warn', `not signed in to ${serverUrl} — hosted steps are skipped (run: klauro login --email you@example.com, then re-run klauro init)`);
  }

  // (b) Project identity — resolve or register. Existing .klaurorc = keep it
  // (idempotent refresh); missing = the existing init flow (interactive when a
  // TTY, defaults otherwise). EXCEPTION: an existing config whose project.id
  // is null/non-prj_ (written by an older broken CLI) is UNBOUND — keeping it
  // verbatim just re-warns "orphaned slug" forever and forces the user to rm
  // .klaurorc and start over. When signed in, self-heal it instead: run the
  // same headless resolve-or-create placement the fresh path uses (honoring
  // --workspace), then write ONLY the real ids into the existing file so
  // source/exclude customizations survive. A bound (prj_) config is untouched
  // — re-running init stays a no-op verify.
  let projectStatus: InitStep['status'] = 'ok';
  let projectNote = hadConfig && !args.force ? ' · existing .klaurorc kept' : '';
  if (!hadConfig || args.force) {
    const initOptions = await resolveInitOptions(projectPath, args);
    await writeDefaultKlauroConfig(projectPath, {
      force: args.force,
      serverUrl: initOptions.serverUrl || (args.serverUrl ? serverUrl : undefined),
      projectId: initOptions.projectId,
      workspaceId: initOptions.workspaceId,
      organizationId: initOptions.organizationId,
      projectName: initOptions.projectName,
      kind: initOptions.kind,
    });
    loaded = await loadKlauroConfig(projectPath);
    projectNote = ` · wrote ${loaded.configPath}`;
  } else if (token && isUnboundHostedProjectId(loaded.config.project.id)) {
    try {
      const placed = await placeHostedProjectHeadless(projectPath, serverUrl, token, args);
      await writeProjectBindingIntoConfig(projectPath, {
        projectId: placed.project.id,
        workspaceId: placed.workspace.id,
        organizationId: placed.workspace.id,
        projectName: placed.project.name,
        kind: 'project',
      });
      loaded = await loadKlauroConfig(projectPath);
      projectNote = ` · healed stale unbound .klaurorc (bound to workspace ${placed.workspace.name}; your other settings were kept)`;
    } catch (error) {
      projectStatus = 'warn';
      projectNote = ` · existing .klaurorc is UNBOUND (project.id missing) and could not self-heal (${error instanceof Error ? error.message : String(error)}) — re-run klauro init, or rm .klaurorc to start fresh`;
    }
  } else if (token && args.workspace && args.workspace.trim()) {
    // The id LOOKS bound (prj_…) but the caller expressed explicit placement
    // intent (--workspace): verify it actually resolves for this account. A
    // stale .klaurorc can carry a well-formed prj_ the server no longer knows
    // (deleted project, or written under a different account) — keeping it
    // verbatim just fails every upload later. Rebind ONLY on a definite
    // server 404 AND explicit intent; a valid binding, a flaky network, or an
    // auth hiccup all leave the file untouched (never hijack a wrong-account
    // sign-in silently).
    const staleId = String(loaded.config.project.id);
    const probe = await probeHostedProjectBinding(serverUrl, token, staleId);
    if (probe === 'not_found') {
      try {
        const placed = await placeHostedProjectHeadless(projectPath, serverUrl, token, args);
        await writeProjectBindingIntoConfig(projectPath, {
          projectId: placed.project.id,
          workspaceId: placed.workspace.id,
          organizationId: placed.workspace.id,
          projectName: placed.project.name,
          kind: 'project',
        });
        loaded = await loadKlauroConfig(projectPath);
        projectNote = ` · healed stale .klaurorc: the server does not know project ${staleId} for this account — re-bound to ${placed.project.id} in workspace ${placed.workspace.name} (your other settings were kept)`;
      } catch (error) {
        projectStatus = 'warn';
        projectNote = ` · existing .klaurorc binds ${staleId}, which the server does not recognize for this account, and self-heal failed (${error instanceof Error ? error.message : String(error)}) — check you are signed in to the right account, or rm .klaurorc to start fresh`;
      }
    }
  }
  const identity = detectWorkspaceIdentity(projectPath, loaded.config.project.id);
  record('project', projectStatus,
    `${loaded.config.project.name || resolveManifestProjectName(projectPath, path.basename(projectPath))}${loaded.config.project.id ? ` (hosted project ${loaded.config.project.id})` : ''} · identity ${identity.workspace} (${identity.source})${projectNote}`);

  // (c) Analysis — kick off / refresh the hosted analysis for this repo.
  // Best-effort: a failed or slow analysis never fails the connect.
  const boundProjectId = loaded.config.project.id;
  if (!token) {
    record('analysis', 'skip', 'requires sign-in — run `klauro analyze .` after `klauro login`');
  } else if (isUnboundHostedProjectId(boundProjectId)) {
    // Signed in but the project never bound to a hosted prj_ — an upload here
    // lands under a path-hash slug and is orphaned (never appears in any
    // workspace). Fail loudly instead of printing "ok", and make --json exit
    // non-zero so a scripted caller notices.
    const workspaceName = (args.workspace && args.workspace.trim()) || path.basename(projectPath);
    record('analysis', 'warn', `project not bound — analysis would upload as an orphaned slug and will not appear in workspace ${workspaceName}; re-run with --workspace or check auth`);
    process.exitCode = 1;
  } else {
    try {
      const result = await withLogHandling(true, true, () => analyzeCodebaseRemotely({
        projectPath,
        serverUrl,
        analysisId: args.analysisId,
      }));
      record('analysis', 'ok', result.status === 'accepted'
        ? `${result.analysis_id} uploaded (${result.manifest.file_count} files) — analyzing on the server, results appear on your project shortly`
        : `${result.analysis_id} @ revision ${result.analysis_revision} (${result.cas?.nodes.length ?? 0} nodes, ${result.cas?.edges.length ?? 0} edges)`);
    } catch (error) {
      record('analysis', 'warn', `did not complete (${error instanceof Error ? error.message : String(error)}) — retry with: klauro analyze .`);
    }
  }

  // (d) In-flight — the dirty-tree track is automatic (no setup step): the
  // working tree is captured on demand (get_in_flight_changes / remote-sync)
  // and published through the fabric when remote. Report, don't configure.
  const dirtyFiles = listDirtyFiles(projectPath);
  const dirty = dirtyFiles?.length;
  // init itself just wrote .klaurorc (and possibly .klauroignore) — counting
  // them as anonymous "in flight" work reads as if init dirtied the user's
  // repo with mystery changes. Call them out explicitly instead.
  const klauroConfigDirty = (dirtyFiles || []).filter(file => /(^|\/)\.klauro(rc|ignore)$/.test(file)).length;
  record('in-flight', 'ok', dirty === undefined
    ? 'automatic — uncommitted work is tracked on demand (no git repo detected here, so the track starts with the first commit history)'
    : dirty === 0
      ? 'automatic — working tree clean; uncommitted work is tracked on demand'
      : `automatic — ${dirty} uncommitted file(s) currently in flight${klauroConfigDirty > 0 ? ' (includes the Klauro config init just wrote — commit these)' : ''}`);

  // (e) MCP — agents on this machine get the Klauro tools via the existing
  // install flow. Detected here; offered (not force-run — it builds/installs).
  const mcp = detectClaudeMcpRegistration();
  if (mcp === true) record('mcp', 'ok', 'klauro MCP server registered with Claude Code');
  else if (mcp === false) record('mcp', 'warn', 'not registered with Claude Code — run: klauro install   (wires the MCP server + agent defaults for this machine)');
  else record('mcp', 'skip', 'claude CLI not found — run `klauro install` to wire agent MCP access when a client is present');

  // (f) Fabric — enabled by default as part of connecting (same resolution
  // `klauro fabric on` used: endpoint from config/login, token from the
  // credential store, stable workspace identity). `klauro fabric off` is the
  // explicit opt-out and survives re-runs.
  const priorFabric = loaded.config.fabric;
  if (priorFabric && priorFabric.enabled === false) {
    record('fabric', 'skip', 'disabled by explicit opt-out (`klauro fabric off`) — re-enable with: klauro fabric on');
  } else if (!token) {
    record('fabric', 'skip', 'staying on the local (same-machine) fabric — sign in and re-run `klauro init` to coordinate across machines');
  } else {
    const endpoint = normalizeServerUrl(args.serverUrl || priorFabric?.endpoint || loaded.config.analyzer.serverUrl);
    const fabricWorkspace = (args.workspace && args.workspace.trim()) || priorFabric?.workspace || identity.workspace;
    writeFabricSection(projectPath, { enabled: true, endpoint, workspace: fabricWorkspace });
    let probeNote: string;
    try {
      const active = await remoteActive({ baseUrl: endpoint, token: resolveFabricToken(endpoint) }, fabricWorkspace);
      probeNote = `service reachable, ${active.count} active claim${active.count === 1 ? '' : 's'}`;
    } catch (error) {
      probeNote = `service unreachable right now (${error instanceof Error ? error.message : String(error)}) — config saved; fab commands degrade to the local fabric until it is back`;
    }
    record('fabric', 'ok', `ON — remote via ${endpoint} · workspace ${fabricWorkspace} · ${probeNote}`);
  }

  const warnSteps = steps.filter(step => step.status === 'warn');
  const skipSteps = steps.filter(step => step.status === 'skip');
  const payload = {
    status: warnSteps.length > 0 ? 'connected_with_warnings' : 'connected',
    warnings: warnSteps.length,
    skipped: skipSteps.length,
    path: projectPath,
    path_was_explicit: options.pathWasExplicit,
    config: loaded.configPath ?? path.join(projectPath, '.klaurorc'),
    server_url: serverUrl,
    signed_in: Boolean(token),
    project: {
      name: loaded.config.project.name ?? null,
      id: loaded.config.project.id ?? null,
      workspace_id: loaded.config.project.workspaceId ?? null,
      kind: loaded.config.kind ?? null,
    },
    workspace_identity: identity,
    fabric: (await loadKlauroConfig(projectPath)).config.fabric ?? null,
    steps,
    idempotent: hadConfig,
  };
  if (args.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  // The closing banner must reflect how the run actually went: a WARN/SKIP-
  // heavy init announcing a rosy "Klauro connected" buries the problems the
  // step lines just reported (2026-07 cold-customer audit).
  const displayName = payload.project.name || resolveManifestProjectName(projectPath, path.basename(projectPath));
  const banner = warnSteps.length > 0
    ? `Klauro connected with ${warnSteps.length} warning${warnSteps.length === 1 ? '' : 's'}: ${displayName}  (${warnSteps.map(step => labels[step.step]).join(', ')} above need attention)`
    : skipSteps.length > 0
      ? `Klauro connected: ${displayName}  (${skipSteps.length} step${skipSteps.length === 1 ? '' : 's'} skipped — see above)`
      : `Klauro connected: ${displayName}`;
  process.stdout.write([
    '',
    banner,
    `Config: ${payload.config}`,
    'Check any time with `klauro status`; re-running `klauro init` is idempotent (verifies and refreshes each subsystem).',
    '',
  ].join('\n'));
}

// listDirtyFiles / countDirtyFiles / detectClaudeMcpRegistration live in
// ./status-report (imported above), shared with installed-cli.ts.

/**
 * One-glance connection report for `klauro status` / `klauro doctor`: every
 * subsystem `klauro init` connects, for the current repo.
 */
// buildConnectionReport / formatConnectionReportLines live in ./status-report
// (imported above), shared with installed-cli.ts.

// isUnboundHostedProjectId / probeHostedProjectBinding now live in
// ./klauro-config (shared with remote-sync-client.ts, which uses them to
// refuse an upload up front instead of accepting source it cannot place —
// see analyzeCodebaseRemotely). Re-exported here so cli.ts stays the stable
// import path for existing tests/callers.
export { isUnboundHostedProjectId, probeHostedProjectBinding };

async function resolveInitOptions(projectPath: string, args: ParsedArgs): Promise<{
  serverUrl?: string;
  projectId?: string;
  workspaceId?: string;
  organizationId?: string;
  projectName?: string;
  kind?: 'project' | 'workspace';
}> {
  if (args.json || !process.stdin.isTTY || args.projectId || args.organizationId) {
    // An explicit --project-id (or --organization-id) is honored as-is, and a
    // caller with no stored token stays local-only (undefined ids). Otherwise a
    // non-interactive caller still gets a real hosted placement — mirror the
    // interactive branch's resolve-or-create, headlessly — so the analysis
    // lands in a workspace instead of an orphaned path-hash slug.
    const serverUrl = normalizeServerUrl(args.serverUrl);
    const token = args.projectId || args.organizationId ? undefined : connectorToken(undefined, serverUrl);
    if (token) {
      const placed = await placeHostedProjectHeadless(projectPath, serverUrl, token, args);
      return {
        serverUrl,
        kind: 'project',
        projectName: placed.project.name,
        projectId: placed.project.id,
        workspaceId: placed.workspace.id,
        organizationId: placed.workspace.id,
      };
    }
    return {
      serverUrl: args.serverUrl,
      projectId: args.projectId,
      workspaceId: args.organizationId,
      organizationId: args.organizationId,
      kind: args.projectId ? 'project' : undefined,
    };
  }

  const serverUrl = normalizeServerUrl(args.serverUrl);
  const token = connectorToken(undefined, serverUrl);
  const manifest = await buildUploadManifest(projectPath);
  const defaultKind = manifest.workspace_recommendation?.recommended ? 'workspace' : 'project';
  const remoteUrl = manifest.remote_provider?.repository_url;
  process.stdout.write(`Klauro init for ${projectPath}\n`);
  if (manifest.remote_provider) {
    const remote = manifest.remote_provider.owner && manifest.remote_provider.repository
      ? `${manifest.remote_provider.owner}/${manifest.remote_provider.repository}`
      : manifest.remote_provider.repository_url || manifest.remote_provider.provider;
    process.stdout.write(`Detected remote: ${remote}\n`);
  }

  // Prefer the ecosystem manifest's declared name (package.json/pyproject.toml/
  // Cargo.toml/go.mod) over the bare directory basename for every default-name
  // suggestion below — a checkout dir frequently doesn't match the package name.
  const defaultProjectName = resolveManifestProjectName(projectPath, path.basename(projectPath));

  if (!token) {
    process.stdout.write('Not signed in. Writing local config only; run `klauro login` to link/create hosted workspaces and projects.\n');
    const kind = await promptChoice<'project' | 'workspace'>(
      'Initialize this folder as a project or workspace?',
      ['project', 'workspace'],
      defaultKind,
    );
    const name = await promptLine(`Name [${defaultProjectName}]: `) || defaultProjectName;
    return { serverUrl, kind, projectName: name, projectId: undefined, organizationId: undefined, workspaceId: undefined };
  }

  // Recognition first: has THIS remote already been connected? If so, offer a
  // one-keystroke reconnect — the common re-init case — before asking anything.
  const recognized = remoteUrl ? await findConnectedRemote(serverUrl, token, remoteUrl) : null;
  const flow = decideInitFlow(recognized);
  if (flow.mode === 'reconnect' && recognized) {
    process.stdout.write(`${flow.recommendation}.\n`);
    const answer = await promptChoice<'yes' | 'no'>('Reconnect this folder here?', ['yes', 'no'], 'yes');
    if (answer === 'yes') {
      return {
        serverUrl,
        kind: 'project',
        projectName: recognized.project.name,
        projectId: recognized.project.id,
        workspaceId: recognized.workspace.id,
        organizationId: recognized.workspace.id,
      };
    }
    process.stdout.write('OK — setting this repo up fresh instead.\n');
  }

  // Not recognized (or declined): fresh placement. Ask project vs workspace,
  // then place BY NAME (never a bare number prompt).
  if (manifest.workspace_recommendation?.recommended) {
    process.stdout.write(`Detected child projects: ${manifest.workspace_recommendation.candidates.map(candidate => candidate.path).join(', ')}\n`);
  }
  const kind = await promptChoice<'project' | 'workspace'>(
    'Initialize this folder as a project or workspace?',
    ['project', 'workspace'],
    defaultKind,
  );

  if (kind === 'workspace') {
    const workspace = await selectOrCreateWorkspace(serverUrl, token, defaultProjectName);
    return {
      serverUrl,
      kind: 'workspace',
      projectName: workspace.name,
      workspaceId: workspace.id,
      organizationId: workspace.id,
    };
  }

  const workspace = await selectOrCreateWorkspace(serverUrl, token, undefined);
  const projects = await listRemoteProjects(serverUrl, token, workspace.id);
  let project: RemoteProjectChoice | undefined;
  // Recognition can still fire within the chosen workspace (e.g. the top-level
  // recognition was declined, or the remote had no canonical url): offer it.
  const matched = remoteUrl ? projects.find(candidate => normalizeRepoUrl(candidate.repo_url) === normalizeRepoUrl(remoteUrl)) : undefined;
  if (matched) {
    const answer = await promptChoice<'yes' | 'no'>(
      `Found matching project "${matched.name}" for this remote in "${workspace.name}". Link to it?`,
      ['yes', 'no'],
      'yes',
    );
    if (answer === 'yes') project = matched;
  }
  if (!project && projects.length > 0) {
    const answer = await promptChoice<'existing' | 'new'>('Use an existing project or create a new one?', ['existing', 'new'], 'new');
    if (answer === 'existing') project = await selectRemoteProject(projects);
  }
  if (!project) {
    const defaultName = defaultProjectName;
    const name = await promptLine(`New project name [${defaultName}]: `) || defaultName;
    project = await createRemoteProject(serverUrl, token, workspace.id, {
      name,
      repo_url: remoteUrl,
      local_path: projectPath,
    });
  }

  return {
    serverUrl,
    kind: 'project',
    projectName: project.name,
    projectId: project.id,
    workspaceId: workspace.id,
    organizationId: workspace.id,
  };
}

/** Recognition lookup — asks the backend whether this remote is already connected for this user. */
async function findConnectedRemote(serverUrl: string, token: string, repoUrl: string): Promise<RecognizedRemote | null> {
  try {
    const payload = await remoteJson<{ match?: RecognizedRemote | null }>(
      serverUrl, token, `/api/projects/by-remote?repo_url=${encodeURIComponent(repoUrl)}`,
    );
    return payload.match ?? null;
  } catch {
    // Recognition is a convenience; a lookup failure must never block init.
    return null;
  }
}

/**
 * Non-interactive equivalent of the interactive branch's resolve-or-create: pick
 * the hosted workspace named by --workspace (or the repo basename), reusing an
 * existing one with that name if present else creating it, then create the
 * project inside it. Same helpers and error handling as the TTY path — just
 * reachable with no prompts, so `--json` / scripted init binds a real prj_/wsp_.
 */
async function placeHostedProjectHeadless(
  projectPath: string,
  serverUrl: string,
  token: string,
  args: ParsedArgs,
): Promise<{ workspace: RemoteWorkspaceChoice; project: RemoteProjectChoice }> {
  const manifest = await buildUploadManifest(projectPath);
  const remoteUrl = manifest.remote_provider?.repository_url;
  const defaultProjectName = resolveManifestProjectName(projectPath, path.basename(projectPath));
  const workspaceName = (args.workspace && args.workspace.trim()) || defaultProjectName;

  const workspaces = await listRemoteWorkspaces(serverUrl, token);
  const existing = workspaces.find(candidate => candidate.name === workspaceName);
  const workspace = existing ?? await createRemoteWorkspace(serverUrl, token, workspaceName);

  // Idempotency: a repeat headless init must reuse the existing project rather
  // than mint a duplicate. With no prompt available we auto-reuse a match — by
  // canonical remote url (like the interactive path), or by local_path for a
  // standalone repo that has no remote (this project's case). Only create when
  // nothing matches.
  const projects = await listRemoteProjects(serverUrl, token, workspace.id);
  const reused = projects.find(candidate =>
    (remoteUrl && normalizeRepoUrl(candidate.repo_url) === normalizeRepoUrl(remoteUrl)) ||
    (candidate.local_path && candidate.local_path === projectPath),
  );
  const project = reused ?? await createRemoteProject(serverUrl, token, workspace.id, {
    name: defaultProjectName,
    repo_url: remoteUrl,
    local_path: projectPath,
  });
  return { workspace, project };
}

interface RemoteWorkspaceChoice {
  id: string;
  name: string;
  project_count?: number;
}

interface RemoteProjectChoice {
  id: string;
  name: string;
  repo_url?: string;
  local_path?: string;
}

async function selectOrCreateWorkspace(serverUrl: string, token: string, defaultName?: string): Promise<RemoteWorkspaceChoice> {
  const workspaces = await listRemoteWorkspaces(serverUrl, token);
  // Single workspace = no ambiguity: default to it (still name-based, one keystroke to accept).
  if (workspaces.length === 1) {
    const only = workspaces[0];
    const answer = await promptChoice<'yes' | 'new'>(
      `Use your workspace "${only.name}"${only.project_count !== undefined ? ` (${only.project_count} project${only.project_count === 1 ? '' : 's'})` : ''}?`,
      ['yes', 'new'],
      'yes',
    );
    if (answer === 'yes') return only;
    return createRemoteWorkspace(serverUrl, token, await promptWorkspaceName(defaultName));
  }
  if (workspaces.length > 1) {
    process.stdout.write('Your workspaces:\n');
    workspaces.forEach(workspace => {
      process.stdout.write(`  - ${workspace.name}${workspace.project_count !== undefined ? ` (${workspace.project_count} project${workspace.project_count === 1 ? '' : 's'})` : ''}\n`);
    });
    const action = await promptChoice<'existing' | 'new'>('Use an existing workspace or create a new one?', ['existing', 'new'], 'existing');
    if (action === 'existing') return selectByName('workspace', workspaces);
  }
  return createRemoteWorkspace(serverUrl, token, await promptWorkspaceName(defaultName));
}

async function promptWorkspaceName(defaultName?: string): Promise<string> {
  const fallback = defaultName || 'Klauro Workspace';
  return (await promptLine(`New workspace name [${fallback}]: `)) || fallback;
}

async function selectRemoteProject(projects: RemoteProjectChoice[]): Promise<RemoteProjectChoice> {
  process.stdout.write('Projects:\n');
  projects.forEach(project => {
    process.stdout.write(`  - ${project.name}${project.repo_url ? ` (${project.repo_url})` : ''}\n`);
  });
  return selectByName('project', projects);
}

/**
 * Prompt the user to pick a named entity BY NAME (a list number is accepted as
 * a shorthand, but the prompt asks for a name and never a bare "… number"). Re-
 * prompts on an ambiguous or unknown answer instead of throwing.
 */
async function selectByName<T extends { id: string; name: string }>(label: string, choices: readonly T[]): Promise<T> {
  if (!choices.length) throw new Error(`No ${label}s available`);
  for (;;) {
    const raw = await promptLine(`${label.charAt(0).toUpperCase()}${label.slice(1)} name [${choices[0].name}]: `);
    if (!raw) return choices[0];
    const result = resolveNamedChoice(choices, raw);
    if ('match' in result) return result.match;
    if ('ambiguous' in result) {
      process.stdout.write(`  "${raw}" matches ${result.ambiguous.map(c => `"${c.name}"`).join(', ')} — please be more specific.\n`);
      continue;
    }
    process.stdout.write(`  No ${label} matches "${raw}". Options: ${choices.map(c => `"${c.name}"`).join(', ')}.\n`);
  }
}

async function promptChoice<T extends string>(label: string, choices: readonly T[], defaultChoice: T): Promise<T> {
  const answer = (await promptLine(`${label} [${choices.join('/')}; default ${defaultChoice}]: `)).toLowerCase();
  if (!answer) return defaultChoice;
  const match = choices.find(choice => choice.toLowerCase() === answer || choice[0].toLowerCase() === answer);
  if (!match) throw new Error(`Invalid choice "${answer}". Expected one of: ${choices.join(', ')}`);
  return match;
}

async function listRemoteWorkspaces(serverUrl: string, token: string): Promise<RemoteWorkspaceChoice[]> {
  const payload = await remoteJson<{ workspaces?: RemoteWorkspaceChoice[] }>(serverUrl, token, '/api/workspaces');
  return payload.workspaces || [];
}

async function createRemoteWorkspace(serverUrl: string, token: string, name: string): Promise<RemoteWorkspaceChoice> {
  const payload = await remoteJson<{ workspace: RemoteWorkspaceChoice }>(serverUrl, token, '/api/workspaces', { name });
  return payload.workspace;
}

async function listRemoteProjects(serverUrl: string, token: string, workspaceId: string): Promise<RemoteProjectChoice[]> {
  const payload = await remoteJson<{ projects?: RemoteProjectChoice[] }>(serverUrl, token, `/api/workspaces/${encodeURIComponent(workspaceId)}/projects`);
  return payload.projects || [];
}

async function createRemoteProject(serverUrl: string, token: string, workspaceId: string, input: { name: string; repo_url?: string; local_path?: string }): Promise<RemoteProjectChoice> {
  const payload = await remoteJson<{ project: RemoteProjectChoice }>(serverUrl, token, `/api/workspaces/${encodeURIComponent(workspaceId)}/projects`, input);
  return payload.project;
}

interface AttachProjectResult {
  attached: boolean;
  already_attached: boolean;
  project: RemoteProjectChoice;
  semantics?: string;
  moved_from_workspace_id?: string;
  was_rebuild: string;
}

/** POSTs { project_id } to the SAME route createRemoteProject uses — the server tells the two shapes apart. */
async function attachRemoteProject(serverUrl: string, token: string, workspaceId: string, projectId: string): Promise<AttachProjectResult> {
  return remoteJson<AttachProjectResult>(serverUrl, token, `/api/workspaces/${encodeURIComponent(workspaceId)}/projects`, { project_id: projectId });
}

/**
 * Resolve `klauro account-workspace-attach --workspace <target>` where target
 * may be an id (`wsp_...`, matched exactly first since ids never collide with
 * resolveNamedChoice's name-based matching) or a name/prefix (delegated to the
 * same resolveNamedChoice ambiguity handling used for the `klauro init`
 * workspace/project prompts, so "matches 2 things" errors read the same way
 * everywhere in the CLI).
 */
export function resolveWorkspaceTarget(workspaces: RemoteWorkspaceChoice[], target: string): RemoteWorkspaceChoice {
  const byId = workspaces.find(workspace => workspace.id === target);
  if (byId) return byId;
  const resolved = resolveNamedChoice(workspaces, target);
  if ('match' in resolved) return resolved.match;
  if ('ambiguous' in resolved) {
    throw new Error(`"${target}" matches multiple workspaces: ${resolved.ambiguous.map(workspace => `"${workspace.name}"`).join(', ')} — use the workspace id instead (see \`klauro account-workspaces\`).`);
  }
  throw new Error(`No workspace found matching "${target}". Run \`klauro account-workspaces\` to list them.`);
}

// remoteJson lives in ./status-report (imported above), shared with installed-cli.ts.

function normalizeRepoUrl(value?: string): string | undefined {
  if (!value) return undefined;
  const detected = detectRemoteProvider(value);
  return (detected?.repository_url || value).replace(/\.git$/i, '').toLowerCase();
}

async function loadOrAnalyze(projectPath: string, refresh: boolean) {
  if (refresh) {
    const result = await analyzeCodebaseRemotely({ projectPath, requireBoundProject: true });
    throw new Error(`Hosted analysis ${result.analysis_id} was accepted. Retry this read after the hosted analysis is ready.`);
  }

  try {
    return await getAnalysis(projectPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`No queryable analysis is available for ${projectPath}. Run \`klauro analyze ${projectPath}\` to submit hosted analysis. ${detail}`);
  }
}

async function withLogHandling<T>(json: boolean, quiet: boolean, fn: () => Promise<T>): Promise<T> {
  if (!json && !quiet) return fn();
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const redirectToStderr = (...args: unknown[]) => originalError(...args);
  const silence = () => undefined;
  console.log = quiet ? silence : redirectToStderr;
  console.warn = quiet ? silence : redirectToStderr;
  console.error = quiet ? silence : redirectToStderr;
  try {
    return await fn();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: argv[0],
    path: undefined,
    task: {},
    json: false,
    refresh: false,
    compact: false,
    quiet: false,
    serverUrl: undefined,
    analysisId: undefined,
    force: false,
    dirtyTree: false,
    analysisFocus: undefined,
    projectId: undefined,
    organizationId: undefined,
    planText: undefined,
    planFile: undefined,
    diffText: undefined,
    diffFile: undefined,
    proposedFilesFile: undefined,
    referencePaths: [],
    previewId: undefined,
    baselinePath: undefined,
    proposedPath: undefined,
    outputPath: undefined,
    host: undefined,
    port: undefined,
    dataDir: undefined,
    all: false,
    allAiCache: false,
    yes: false,
    passwordStdin: false,
    register: false,
    deployOnly: false,
    markdown: false,
    resetTokenStdin: false,
    currentPasswordStdin: false,
    newPasswordStdin: false,
  };

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h' || arg === 'help') {
      parsed.command = 'help';
      continue;
    } else if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--refresh') {
      parsed.refresh = true;
    } else if (arg === '--compact') {
      parsed.compact = true;
    } else if (arg === '--quiet') {
      parsed.quiet = true;
    } else if (arg === '--server-url') {
      parsed.serverUrl = argv[++i];
    } else if (arg === '--email') {
      parsed.email = argv[++i];
    } else if (arg === '--password') {
      parsed.password = argv[++i];
    } else if (arg === '--password-stdin') {
      parsed.passwordStdin = true;
    } else if (arg === '--register') {
      parsed.register = true;
    } else if (arg === '--token') {
      parsed.resetToken = argv[++i];
    } else if (arg === '--token-stdin') {
      parsed.resetTokenStdin = true;
    } else if (arg === '--current-password') {
      parsed.currentPassword = argv[++i];
    } else if (arg === '--current-password-stdin') {
      parsed.currentPasswordStdin = true;
    } else if (arg === '--new-password') {
      parsed.newPassword = argv[++i];
    } else if (arg === '--new-password-stdin') {
      parsed.newPasswordStdin = true;
    } else if (arg === '--minted-by') {
      parsed.mintedBy = argv[++i];
    } else if (arg === '--path') {
      parsed.path = argv[++i];
    } else if (arg === '--analysis-id') {
      parsed.analysisId = argv[++i];
    } else if (arg === '--project-id') {
      parsed.projectId = argv[++i];
    } else if (arg === '--organization-id') {
      parsed.organizationId = argv[++i];
    } else if (arg === '--plan') {
      parsed.planText = argv[++i];
    } else if (arg === '--plan-file') {
      parsed.planFile = argv[++i];
    } else if (arg === '--diff') {
      parsed.diffText = argv[++i];
    } else if (arg === '--diff-file') {
      parsed.diffFile = argv[++i];
    } else if (arg === '--proposed-files') {
      parsed.proposedFilesFile = argv[++i];
    } else if (arg === '--reference-path') {
      parsed.referencePaths.push(path.resolve(argv[++i]));
    } else if (arg === '--preview-id') {
      parsed.previewId = argv[++i];
    } else if (arg === '--baseline-path') {
      parsed.baselinePath = path.resolve(argv[++i]);
    } else if (arg === '--proposed-path') {
      parsed.proposedPath = path.resolve(argv[++i]);
    } else if (arg === '--output') {
      parsed.outputPath = argv[++i];
    } else if (arg === '--host') {
      parsed.host = argv[++i];
    } else if (arg === '--port') {
      parsed.port = Number(argv[++i]);
    } else if (arg === '--data-dir') {
      parsed.dataDir = argv[++i];
    } else if (arg === '--detail-level') {
      const value = argv[++i] as WorkspaceDetailLevel;
      if (!['overview', 'connections', 'evidence', 'full'].includes(value)) throw new Error('--detail-level must be overview, connections, evidence, or full');
      parsed.detailLevel = value;
    } else if (arg === '--analysis-focus') {
      parsed.analysisFocus = argv[++i] as ParsedArgs['analysisFocus'];
    } else if (arg === '--force') {
      parsed.force = true;
    } else if (arg === '--all') {
      parsed.all = true;
    } else if (arg === '--all-ai-cache') {
      parsed.allAiCache = true;
    } else if (arg === '--yes' || arg === '-y') {
      parsed.yes = true;
    } else if (arg === '--dirty-tree') {
      parsed.dirtyTree = true;
    } else if (arg === '--provider') {
      parsed.provider = argv[++i];
    } else if (arg === '--deploy-only') {
      parsed.deployOnly = true;
    } else if (arg === '--modality') {
      parsed.modality = argv[++i] as ParsedArgs['modality'];
    } else if (arg === '--level') {
      parsed.level = argv[++i] as ParsedArgs['level'];
    } else if (arg === '--section') {
      parsed.section = argv[++i];
    } else if (arg === '--format') {
      const value = argv[++i];
      if (value !== 'json' && value !== 'mermaid') throw new Error('--format must be json or mermaid');
      parsed.format = value;
    } else if (arg === '--workspace') {
      parsed.workspace = argv[++i];
    } else if (arg === '--markdown') {
      parsed.markdown = true;
    } else if (arg === '--limit') {
      parsed.limit = Number(argv[++i]);
    } else if (arg === '--offset') {
      parsed.offset = Number(argv[++i]);
    } else if (arg === '--task-type') {
      parsed.task.task_type = argv[++i] as AgentTaskType;
    } else if (arg === '--target') {
      parsed.task.target = argv[++i];
    } else if (arg === '--instructions' || arg === '--task') {
      parsed.task.instructions = argv[++i];
    } else if (arg === '--success-criterion') {
      parsed.task.success_criteria = [...(parsed.task.success_criteria || []), argv[++i]];
    } else if (arg === '--response-profile') {
      parsed.task.response_profile = argv[++i] as AgentTask['response_profile'];
    } else if (arg.startsWith('-')) {
      // An unrecognized flag must never fall through to the positional-path
      // slot: `init --sometypo` would otherwise "connect" a directory literally
      // named --sometypo and die with a baffling ENOENT instead of naming the
      // real problem.
      throw new Error(`Unknown option: ${arg} (run \`klauro help\` for the supported flags)`);
    } else if (!parsed.path) {
      parsed.path = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return parsed;
}

function printHelp(): void {
  process.stdout.write([
    'Usage: klauro <command> [options]',
    '',
    'Setup:',
    '  klauro install [repo-path] [--claude-md /path/to/repo] [--claude-scope user|project|local] [--no-register] [--rebuild] [--skip-self-check]',
    '  klauro uninstall [--claude-md /path/to/repo] [--no-deregister]',
    '  klauro init [/path/to/repo] [--server-url url] [--workspace name] [--project-id id] [--organization-id id] [--force] [--json]',
    '      THE onboarding: connects the repo end to end — auth, project identity, hosted analysis,',
    '      in-flight tracking, agent MCP wiring, and the coordination fabric (on by default).',
    '      Idempotent: re-running verifies and refreshes each subsystem.',
    '',
    'Status & maintenance:',
    '  klauro version [--json]                 (build, node, platform)',
    '  klauro status [/path/to/repo] [--json]  (version, account, release, repo readiness in one view)',
    '  klauro update [--server-url url] [--check] [--force] [--json]   (upgrade to the latest hosted release)',
    '  klauro doctor [/path/to/repo] [--json] [--refresh]   (no path: machine health; with path: repo readiness)',
    '  klauro purge </path/to/repo> [--all-ai-cache] [--yes] [--json]',
    '  klauro purge --all [--yes] [--json]     (wipe all local Klauro data under ~/.klauro)',
    '  klauro support-bundle [/path/to/repo] [--output bundle.tar.gz] [--json]',
    '',
    'Account:',
    '  klauro login --email you@example.com [--password-stdin | --password value] [--server-url url] [--register]',
    '    (password is prompted with echo off; --password-stdin reads it from a pipe for scripting)',
    '  klauro whoami [--server-url url] [--json]',
    '  klauro auth-status [--server-url url] [--json]',
    '  klauro logout [--server-url url] [--json]',
    '  klauro change-password [--current-password-stdin | --current-password value] [--new-password-stdin | --new-password value] [--server-url url] [--json]',
    '      (requires an existing session; invalidates every OTHER session; rotates and saves this one)',
    '  klauro reset-password --token value [--token-stdin] [--new-password-stdin | --new-password value] [--server-url url] [--json]',
    '      (redeems a single-use token an operator minted for you — see `klauro admin-mint-reset-token`; invalidates every session)',
    '  klauro admin-mint-reset-token --email account@example.com [--data-dir /path/to/data] [--minted-by label] [--json]',
    '      (OPERATOR-ONLY, runs directly against the account store — not an HTTP call; prints a single-use 30-min token once)',
    '',
    'Coordination fabric — fine control only; `klauro init` enables it by default (docs/FABRIC-REMOTE.md):',
    '  klauro fabric status [/path/to/repo] [--json]                                     (detail view: enabled/endpoint/workspace + active claims)',
    '  klauro fabric off [/path/to/repo] [--json]                                        (rare explicit opt-out: back to the local-only fabric)',
    '  klauro fabric on [/path/to/repo] [--workspace name] [--server-url url] [--json]   (re-enable after an opt-out)',
    '',
    'Analyze:',
    '  klauro analyze [/path/to/repo] [--server-url url] [--analysis-id id] [--analysis-focus agent-fast|ui-overview|deep-context|full] [--force] [--json]',
    '  klauro index [/path/to/repo] [--dirty-tree] [--server-url url] [--json]',
    '  klauro upload-manifest [/path/to/repo] [--dirty-tree] [--json]',
    '  klauro remote-analyze /path/to/repo [--server-url url] [--analysis-id id] [--json]',
    '  klauro remote-sync /path/to/repo [--server-url url] [--analysis-id id] [--json]',
    '  klauro save-golden /path/to/repo [--json] [--refresh]',
    '  klauro analyzer-server [--host 0.0.0.0] [--port 8787] [--data-dir /path/to/data]  (hosted operator command; not shipped in the installed client; unset data-dir: tmpdir scratch)',
    '',
    'Agent context:',
    '  klauro install-agent [/path/to/repo] [--json]',
    '  klauro agent-start /path/to/repo [--task-type orient|modify|debug|review|trace|cross-repo|runtime] [--target query] [--json] [--refresh]',
    '  klauro agent-context /path/to/repo [--task-type orient|modify|debug|review|trace|cross-repo|runtime] [--target query] [--instructions text|--task text] [--success-criterion text] [--response-profile standard|minimal|first-turn|capsule-only] [--json] [--compact] [--quiet] [--refresh]',
    '  klauro agent-tracks /path/to/repo [--server-url url] [--analysis-id id] [--json]',
    '  klauro agent-install /path/to/repo [--task-type orient|modify|debug|review|trace|cross-repo|runtime] [--target query] [--json] [--refresh]',
    '  klauro github-import-plan [/path/to/repo] [--json]',
    '',
    'Read surfaces (CLI parity with the MCP reads):',
    '  klauro orient /path/to/repo               (cheap what-Klauro-knows capsule: dimensions + counts + the tool to pull each)',
    '  klauro cicd /path/to/repo [--provider github-actions] [--deploy-only] [--limit N] [--offset N]   (CI/CD pipeline→job→step→trigger→deploy + job DAG)',
    '  klauro seams /path/to/repo [--modality sync|async|passive] [--level node|deployable|workspace] [--limit N] [--offset N]',
    '  klauro product-map /path/to/repo [--section runtime_topology] [--markdown]',
    '  klauro erd /path/to/repo [--format json|mermaid] [--target EntityName]   (entity-relationship model + renderable Mermaid erDiagram, from ORM analysis)',
    '  klauro node-metrics /path/to/repo [--limit N]   (per-node runtime traffic/error-rate/latency correlated to CAS)',
    '',
    'Workspace & greenfield:',
    '  klauro workspace-analysis /path/to/repo-a [--reference-path /path/to/repo-b] [--reference-path /path/to/repo-c] [--target name] [--json] [--refresh]',
    '  klauro workspace-get --preview-id id-or-name [--detail-level overview|connections|evidence|full] [--json]',
    '  klauro workspace-list [--json]',
    '  klauro account-workspaces [--server-url url] [--json]   (hosted account workspaces you belong to: id + name)',
    '  klauro account-workspace-attach --workspace id-or-name [/path/to/repo] [--server-url url] [--json]   (attach/move an already-init\'d project into another hosted workspace)',
    '  klauro proposal-preview /path/to/repo --plan-file plan.md [--diff-file changes.patch] [--proposed-files files.json] [--server-url app-url] [--json]',
    '  klauro greenfield-guidance --plan-file plan.md [--reference-path /existing/repo] [--proposed-files files.json] [--json]',
    '  klauro greenfield-build-context [/empty/or/current/project] --plan-file plan.md [--reference-path /existing/repo] [--proposed-files files.json] [--json]',
    '  klauro greenfield-preview --plan-file plan.md --proposed-files files.json [--server-url app-url] [--json]',
    '  klauro preview-get [--preview-id id] [--json]',
    '  klauro compare-iterations [--preview-id id] [--baseline-path /repo] [--proposed-path /repo-copy] [--json]',
    '',
    'Examples:',
    '  klauro init .',
    '  klauro login --email you@example.com',
    '  klauro index . --dirty-tree',
    '  klauro upload-manifest .',
    '  klauro analyze .',
    '  klauro install-agent .',
    '  klauro agent-start .',
    '  klauro agent-context . --task-type modify --target auth --json',
    '  klauro agent-tracks .',
    '  klauro agent-install .',
    '  klauro doctor .',
    '  klauro save-golden .',
    '  klauro support-bundle . --output klauro-support.tar.gz',
    '  klauro remote-analyze .',
    '  klauro remote-sync .',
    '  klauro analyzer-server --host 127.0.0.1 --port 8787',
    '  klauro proposal-preview . --plan "Add a health endpoint" --proposed-files proposed-files.json',
    '  klauro greenfield-guidance --plan "Create a portfolio reporting service" --reference-path ~/dev/your-org/reference-repo',
    '  klauro greenfield-build-context /tmp/new-app --plan "Build an operations command center" --json',
    '  klauro greenfield-preview --plan-file plan.md --proposed-files proposed-files.json',
    '  klauro workspace-analysis ~/dev/soon/soon-ui --reference-path ~/dev/soon/soon-sync --target soon-workspace',
    '  klauro account-workspaces',
    '  klauro account-workspace-attach --workspace "Acme Team" .',
    '  klauro agent-start ~/dev/klauro/proof-of-concept --task-type debug --target auth',
    '  npm --silent run agent-start -- . --json',
    '  npm --silent run agent-install -- . --json',
  ].join('\n') + '\n');
}

async function runAnalyzerServerCommand(args: ParsedArgs): Promise<void> {
  const port = args.port || Number(process.env.PORT || process.env.KLAURO_ANALYZER_PORT || 8787);
  if (!Number.isFinite(port) || port <= 0) throw new Error(`Invalid analyzer server port: ${args.port}`);
  const host = args.host || process.env.KLAURO_ANALYZER_HOST || '0.0.0.0';
  const server = createRemoteAnalyzerHttpServer({ dataDir: args.dataDir });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const url = `http://${host}:${port}`;
      const payload = {
        status: 'ready',
        service: 'klauro-remote-analyzer',
        url,
        // Mirrors createRemoteAnalyzerHttpServer's resolution: explicit flag/env,
        // else per-user tmpdir scratch (never a cwd-relative durable dir).
        data_dir: args.dataDir || process.env.KLAURO_REMOTE_ANALYZER_DATA || path.join(os.tmpdir(), `klauro-remote-analyzer-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`),
        auth: process.env.KLAURO_ANALYZER_TOKEN ? 'bearer-token-required' : 'none',
      };
      process.stdout.write(args.json ? `${JSON.stringify(payload, null, 2)}\n` : `Klauro remote analyzer listening on ${url}\n`);
      resolve();
    });
  });

  const stop = () => server.close(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await new Promise(() => undefined);
}

function formatUploadManifest(manifest: Awaited<ReturnType<typeof buildUploadManifest>>): string {
  const largest = [...manifest.included_files]
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, 10)
    .map(file => `- ${file.path} (${file.bytes} bytes)`);
  return [
    `Klauro upload manifest: ${manifest.mode}`,
    `Root: ${manifest.root}`,
    `Config: ${manifest.config_file || 'default'}`,
    `Ignore: ${manifest.ignore_file || 'none'}`,
    manifest.branch || manifest.commit ? `Revision: ${manifest.branch || 'unknown-branch'} @ ${manifest.commit || 'uncommitted/unversioned'}${manifest.dirty ? ' (dirty)' : ''}` : undefined,
    `Included: ${manifest.summary.included_files} files, ${manifest.summary.included_bytes} bytes`,
    `Excluded sample: ${manifest.summary.excluded_files} files/directories`,
    manifest.remote_provider ? `Remote provider: ${manifest.remote_provider.provider}${manifest.remote_provider.owner && manifest.remote_provider.repository ? ` ${manifest.remote_provider.owner}/${manifest.remote_provider.repository}` : ''}` : undefined,
    manifest.remote_provider?.suggested_connection ? `Connection suggestion: ${manifest.remote_provider.suggested_connection.action}` : undefined,
    manifest.transfer_recommendation ? `Recommended action: ${manifest.transfer_recommendation.operation} (${manifest.transfer_recommendation.status}) - ${manifest.transfer_recommendation.reason}` : undefined,
    manifest.workspace_recommendation ? `Workspace recommendation: ${manifest.workspace_recommendation.recommended ? 'yes' : 'possible'} - ${manifest.workspace_recommendation.reason}` : undefined,
    manifest.workspace_recommendation?.candidates.length ? `Workspace candidates: ${manifest.workspace_recommendation.candidates.map(candidate => `${candidate.path} (${candidate.kind})`).join(', ')}` : undefined,
    manifest.summary.changed_files !== undefined ? `Dirty-tree changed files: ${manifest.summary.changed_files}` : undefined,
    manifest.summary.deleted_files !== undefined ? `Dirty-tree deleted files: ${manifest.summary.deleted_files}` : undefined,
    '',
    'Largest included files:',
    ...(largest.length ? largest : ['- none']),
    '',
  ].filter(Boolean).join('\n');
}

function formatUploadPreparationResult(result: {
  status: string;
  index_type: string;
  authoritative: boolean;
  visibility: string;
  account: { entitlement: { status: string; plan?: string } };
  manifest: Awaited<ReturnType<typeof buildUploadManifest>>;
  next: string[];
}): string {
  return [
    'Klauro source upload preparation: SUCCESS',
    `Type: ${result.index_type}`,
    `Shared project analysis: ${result.authoritative ? 'yes' : 'no'}`,
    `Visibility: ${result.visibility}`,
    `Entitlement: ${result.account.entitlement.status}${result.account.entitlement.plan ? ` (${result.account.entitlement.plan})` : ''}`,
    `Included: ${result.manifest.summary.included_files} files, ${result.manifest.summary.included_bytes} bytes`,
    result.manifest.summary.changed_files !== undefined ? `Dirty-tree changed files: ${result.manifest.summary.changed_files}` : undefined,
    result.manifest.summary.deleted_files !== undefined ? `Dirty-tree deleted files: ${result.manifest.summary.deleted_files}` : undefined,
    '',
    'Next:',
    ...result.next.map(step => `  ${step}`),
    '',
  ].filter(Boolean).join('\n');
}

function formatAgentRevisionTracks(result: Awaited<ReturnType<typeof getAgentRevisionTracks>>): string {
  return [
    'Klauro agent tracks',
    `Project: ${result.project_id}`,
    `Branch: ${result.selected_branch || 'unknown'}`,
    `Working: ${result.working_track.dirty ? `${result.working_track.changed_files} changed, ${result.working_track.deleted_files} deleted (private)` : 'clean'}`,
    `Committed: ${result.committed_track.local_commit ? result.committed_track.local_commit.slice(0, 12) : 'unversioned'}${result.committed_track.analyzed ? ' (analyzed)' : ' (not analyzed yet)'}`,
    `Incoming: ${result.incoming_track.available ? `${result.incoming_track.commits.length} analyzed commit(s) ahead` : 'none detected'}`,
    result.incoming_track.guidance,
    '',
  ].join('\n');
}

function formatRemoteResult(result: Awaited<ReturnType<typeof analyzeCodebaseRemotely>>): string {
  if (result.status === 'accepted') {
    // Fast path (the default): the snapshot is uploaded in seconds and the
    // analysis runs entirely on the server, landing on the project
    // progressively (deterministic layers first, AI enrichment after).
    const lines = [
      `Uploaded ${result.manifest.file_count} files (${result.manifest.total_bytes} bytes).`,
      `Analysis is running on the Klauro server (id: ${result.analysis_id}) — results appear on your project as they land.`,
    ];
    if (result.snapshot_source === 'committed-head') {
      const shortSha = (result.base_commit || '').slice(0, 7) || 'HEAD';
      lines.push(`Shared revision = committed HEAD (${shortSha}); working-tree changes ${result.in_flight?.status === 'completed' ? 'uploaded separately as in-flight context' : `in-flight pass ${result.in_flight?.status || 'skipped'}`}.`);
    }
    lines.push('');
    return lines.join('\n');
  }
  const changedFiles = result.change_report
    ? result.change_report.summary.filesAdded + result.change_report.summary.filesModified + result.change_report.summary.filesDeleted
    : 0;
  const lines = [
    `Klauro remote analysis: ${result.status.toUpperCase()}`,
    `Analysis id: ${result.analysis_id}`,
    `Revision: ${result.analysis_revision}`,
    `Type: ${result.analysis_type}`,
    `Files sent: ${result.manifest.file_count}`,
    `Bytes sent: ${result.manifest.total_bytes}`,
    `Nodes: ${result.cas?.nodes.length ?? 0}`,
    `Edges: ${result.cas?.edges.length ?? 0}`,
    `Changed files: ${changedFiles}`,
  ];
  if (result.snapshot_source === 'committed-head') {
    const shortSha = (result.base_commit || '').slice(0, 7) || 'HEAD';
    if (result.in_flight?.status === 'completed') {
      lines.push(`Analyzed committed HEAD (${shortSha}) as the shared revision; working-tree changes analyzed separately as in-flight context${result.in_flight.changed_files != null ? ` (${result.in_flight.changed_files} changed files)` : ''}.`);
    } else {
      lines.push(`Analyzed committed HEAD (${shortSha}) as the shared revision; uncommitted working-tree changes were NOT included.`);
      lines.push(`In-flight (working-tree) context pass ${result.in_flight?.status || 'skipped'}${result.in_flight?.detail ? `: ${result.in_flight.detail}` : ''}.`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function formatGithubImportPlan(plan: ReturnType<typeof buildGithubImportPlan>): string {
  return [
    'Klauro GitHub import plan',
    `Project: ${plan.project_path}`,
    `Owner: ${plan.github_app.owner || 'configure in .klaurorc github.owner'}`,
    `Repositories: ${plan.github_app.repositories.length ? plan.github_app.repositories.join(', ') : 'configure in .klaurorc github.repositories'}`,
    '',
    'Required permissions:',
    ...plan.required_permissions.map(permission => `- ${permission.scope}:${permission.access} - ${permission.reason}`),
    '',
    'Webhooks:',
    ...plan.webhooks.map(webhook => `- ${webhook.event} - ${webhook.reason}`),
    '',
    plan.local_agent_note,
    '',
  ].join('\n');
}

function loadTextArg(text: string | undefined, file: string | undefined, errorMessage: string): string {
  const value = loadOptionalTextArg(text, file);
  if (!value) throw new Error(errorMessage);
  return value;
}

function loadOptionalTextArg(text: string | undefined, file: string | undefined): string | undefined {
  if (text !== undefined) return text;
  if (file) return fs.readFileSync(path.resolve(file), 'utf8');
  return undefined;
}

function loadProposedFiles(file: string | undefined): ProposedFileInput[] | undefined {
  if (!file) return undefined;
  const payload = fs.readJsonSync(path.resolve(file));
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.files)) return payload.files;
  throw new Error('--proposed-files must point to a JSON array or an object with a files array');
}

function formatProposalPreviewResult(result: any): string {
  const preview = result.preview;
  return [
    `Klauro proposal preview: ${String(result.status || preview?.verdict?.status || 'unknown').toUpperCase()}`,
    preview ? `Preview id: ${preview.id}` : undefined,
    preview ? `Preview URL: ${preview.preview_url}` : undefined,
    preview ? `Type: ${preview.type}` : undefined,
    preview ? `Proposed analysis: ${preview.proposed_analysis_id}` : undefined,
    result.visualization_summary ? `Proposed graph: ${result.visualization_summary.proposed_nodes} nodes, ${result.visualization_summary.proposed_edges} edges` : undefined,
    result.visualization_summary ? `Changed contracts: ${result.visualization_summary.changed_contracts}` : undefined,
    '',
    'Next:',
    ...((result.next_steps || []).map((step: string) => `- ${step}`)),
    '',
  ].filter(Boolean).join('\n');
}

function formatGreenfieldGuidance(result: ReturnType<typeof buildGreenfieldArchitectureGuidance>): string {
  const overlap = result.existing_overlap.matches.slice(0, 5).map(match =>
    `- ${match.repository}: ${match.reused_or_integrated_capabilities.map(capability => capability.name).join(', ') || match.related_entities.join(', ')}`
  );
  const patterns = result.recommended_architecture.patterns.slice(0, 6).map(pattern =>
    `- ${pattern.name}: ${pattern.guidance}`
  );
  const risks = result.risks.map(risk => `- ${risk.severity}: ${risk.risk} - ${risk.recommendation}`);
  return [
    `Klauro greenfield guidance: ${String(result.status).toUpperCase()}`,
    `Intent: ${result.plan_intent.summary}`,
    `References: ${result.reference_scope.count}`,
    `Overlap: ${result.existing_overlap.status}`,
    '',
    'Existing overlap:',
    ...(overlap.length ? overlap : ['- none']),
    '',
    'Recommended patterns:',
    ...(patterns.length ? patterns : ['- none']),
    '',
    'First file plan:',
    ...result.recommended_architecture.file_plan.slice(0, 8).map(file => `- ${file.path} (${file.role})`),
    '',
    'Risks:',
    ...(risks.length ? risks : ['- none']),
    '',
    'Next:',
    '- Create the smallest proposed file bundle.',
    '- Run klauro greenfield-preview --plan-file plan.md --proposed-files files.json.',
    '',
  ].join('\n');
}

function formatGreenfieldBuildContext(result: Awaited<ReturnType<typeof buildGreenfieldBuildContext>>): string {
  const current = result.current_analysis;
  const readFirst = result.context_budget.read_first.slice(0, 8).map((item: any) => `- ${item.file}: ${item.reason}`);
  const nextFiles = result.context_budget.create_or_update_next.slice(0, 8).map((item: any) => `- ${item.file}: ${item.reason}`);
  const concepts = result.duplicate_prevention.likely_reused_concepts_for_this_slice.slice(0, 10).map((concept: string) => `- ${concept}`);
  const growth = (result as any).growth_control_plane;
  const productBehaviors = growth?.product_slice?.requested_behaviors?.slice(0, 6).map((behavior: string) => `- ${behavior}`) || [];
  const ownerFiles = growth?.concept_ownership_contract?.owner_files?.slice(0, 6).map((item: any) => `- ${item.file}: ${item.reason}`) || [];
  const stopRule = growth?.context_budget?.stop_rule;
  return [
    `Klauro greenfield build context: ${String(result.status).toUpperCase()}`,
    `Stage: ${result.stage}`,
    `Workspace: ${result.workspace_path}`,
    current ? `Current graph: ${current.graph.nodes} nodes, ${current.graph.edges} edges, ${current.graph.capabilities} capabilities, ${current.graph.files} files` : 'Current graph: none yet',
    '',
    'G1 build capsule:',
    '```text',
    (result as any).agent_build_capsule?.capsule || '',
    '```',
    '',
    'Product slice focus:',
    ...(productBehaviors.length ? productBehaviors : ['- one coherent tested vertical slice']),
    stopRule ? `Stop rule: ${stopRule}` : '',
    '',
    'Concepts to reuse for this slice:',
    ...(concepts.length ? concepts : ['- none detected yet']),
    '',
    'Owner files:',
    ...(ownerFiles.length ? ownerFiles : ['- none yet']),
    '',
    'Read first:',
    ...(readFirst.length ? readFirst : ['- empty workspace; no source files to read']),
    '',
    'Create or update next:',
    ...(nextFiles.length ? nextFiles : ['- no file plan inferred']),
    '',
    'Next:',
    ...result.next_agent_steps.map((step: string) => `- ${step}`),
    '',
  ].join('\n');
}

function formatWorkspaceAnalysisResult(result: any): string {
  const summary = result.summary || (result.graph ? summarizeCrossCodebaseSystemGraph(result.graph) : {});
  if (result.level === 'overview') {
    return [
      `Klauro workspace analysis: ${summary.name}`,
      `Detail level: overview`,
      `Projects: ${result.projects?.length || summary.codebase_count || 0}`,
      `Deployables: ${result.deployables?.length || summary.application_count || 0}`,
      `Connections: ${result.connections?.length || summary.application_link_count || summary.link_count || 0}`,
      `External dependencies: ${result.external_dependencies?.length || 0}`,
      `Isolated deployables: ${result.isolated_deployables?.length || summary.isolated_deployable_count || 0}`,
      '',
    ].filter(Boolean).join('\n');
  }
  return [
    `Klauro workspace analysis: ${summary.name}`,
    result.saved ? `Saved: ${result.saved.file}` : undefined,
    `Codebases: ${summary.codebase_count}`,
    `Applications: ${summary.application_count}`,
    `Interfaces: ${summary.interface_count}`,
    `Links: ${summary.link_count}`,
    `Data-flow paths: ${summary.data_flow_path_count}`,
    `Unmatched interfaces: ${summary.unmatched_interface_count}`,
    '',
  ].filter(Boolean).join('\n');
}

function formatWorkspaceAnalysisList(graphs: Awaited<ReturnType<typeof listCrossCodebaseSystemGraphs>>): string {
  if (graphs.length === 0) return 'No workspace analyses saved.\n';
  return graphs.map(graph => [
    `${graph.name} (${graph.id})`,
    `  saved: ${graph.saved_at || graph.generated_at || 'unknown'}`,
    `  codebases: ${graph.codebase_count || 0}, interfaces: ${graph.interface_count || 0}, links: ${graph.link_count || 0}, unmatched: ${graph.unmatched_interface_count || 0}`,
    `  file: ${graph.file}`,
  ].join('\n')).join('\n\n') + '\n';
}

function formatPreviewPayload(payload: Awaited<ReturnType<typeof getPreviewAnalysis>>): string {
  return [
    `Klauro preview: ${payload.preview.id}`,
    `Type: ${payload.preview.type}`,
    `Verdict: ${(payload.preview.verdict as any)?.status || 'unknown'}`,
    `Preview URL: ${payload.preview.preview_url}`,
    `Baseline analysis: ${payload.preview.baseline_analysis_id || 'none'}`,
    `Proposed analysis: ${payload.preview.proposed_analysis_id}`,
    '',
  ].join('\n');
}

function compactAgentContext(context: Awaited<ReturnType<typeof getAgentContext>>) {
  if ((context as any).context_profile === 'first-turn') return context;
  const workContext = context.work_context as any;
  const nextMcpCalls = context.next_mcp_calls.filter((step: any, index: number) =>
    index < 8 || step.tool === 'validate_agent_change' || step.tool === 'validate_behavioral_invariants' || step.tool === 'validate_codebase_idioms'
  );
  return {
    path: context.path,
    generated_at: context.generated_at,
    task: context.task,
    status: context.status,
    agent_context_ready: context.agent_context_ready,
    readiness: context.readiness,
    selected_node: context.selected_node,
    execution_brief: (workContext as any).execution_brief ? {
      capsule: (workContext as any).execution_brief.capsule,
      read_first: (workContext as any).execution_brief.read_first,
      edit_scope: (workContext as any).execution_brief.edit_scope,
      validate: (workContext as any).execution_brief.validate,
      stop_rule: (workContext as any).execution_brief.stop_rule,
    } : undefined,
    target_gaps: (context.target_resolution as any)?.gaps || [],
    file_read_plan: context.file_read_plan.slice(0, 12).map((item: any) => ({
      file: item.file,
      reason: item.reason,
      line: item.line,
      line_window: item.line_window,
      node_ids: Array.isArray(item.node_ids) ? item.node_ids.slice(0, 8) : item.node_ids,
    })),
    risk: summarizeRiskForCli(workContext.risk),
    risk_context: summarizeRiskContextForCli(workContext.risk_context),
    tests: summarizeTests(workContext.tests),
    architecture_context: workContext.architecture_context ? {
      system_type: workContext.architecture_context.system_type,
      architecture_budget: workContext.architecture_context.architecture_budget?.slice(0, 5),
      patterns: workContext.architecture_context.patterns?.slice(0, 5),
      inventory_counts: workContext.architecture_context.inventory_counts,
      inventory_examples: workContext.architecture_context.inventory_examples,
      relevant_inventory: workContext.architecture_context.relevant_inventory,
      pattern_decision_matrix: workContext.architecture_context.pattern_decision_matrix?.slice(0, 5),
      pattern_balance: workContext.architecture_context.pattern_balance,
      agent_rules: workContext.architecture_context.agent_rules?.slice(0, 5),
    } : null,
    behavioral_invariants: workContext.behavioral_invariants ? {
      total: workContext.behavioral_invariants.total,
      invariants: workContext.behavioral_invariants.invariants?.slice(0, 8),
    } : null,
    idiom_context: workContext.idiom_context ? {
      total_idioms: workContext.idiom_context.total_idioms,
      selected_idioms: workContext.idiom_context.selected_idioms?.slice(0, 8),
      local_examples: workContext.idiom_context.local_examples?.slice(0, 8),
      do: workContext.idiom_context.do?.slice(0, 10),
      avoid: workContext.idiom_context.avoid?.slice(0, 10),
      validation: workContext.idiom_context.validation?.slice(0, 10),
    } : null,
    invariant_impact: (workContext as any).invariant_impact,
    validation_plan: (workContext as any).validation_plan,
    next_mcp_calls: nextMcpCalls.map((step: any) => ({
      tool: step.tool,
      purpose: step.purpose,
      required: step.required,
      args: step.args,
    })),
    source_reading_rule: context.source_reading_rule,
    gaps: context.gaps,
  };
}

function summarizeTests(tests: any) {
  if (!tests) return null;
  if (Array.isArray(tests)) return tests.slice(0, 10);
  return {
    status: tests.status,
    total: tests.total ?? tests.total_tests ?? tests.tests?.length,
    tests: Array.isArray(tests.tests) ? tests.tests.slice(0, 10) : undefined,
    suites: Array.isArray(tests.suites) ? tests.suites.slice(0, 10) : undefined,
    resolution: tests.resolution,
    gaps: tests.gaps,
  };
}

function summarizeRiskForCli(risk: any) {
  if (!risk) return null;
  const selectedRisk = risk.risk || risk;
  return {
    level: selectedRisk.risk_level || selectedRisk.level || null,
    score: selectedRisk.score || selectedRisk.impact_score || null,
    reasons: selectedRisk.reasons || selectedRisk.factors || selectedRisk.risk_factors || selectedRisk.details || [],
    recommendations: selectedRisk.recommendations || [],
    // change_risk_context: assess_change_risk's per-change-scoped field
    // (defect #2 — the old change_risk_summary here was the raw repo-wide
    // list embedded under a one-node answer).
    summary: risk.change_risk_context || null,
  };
}

function summarizeRiskContextForCli(context: any) {
  if (!context) return null;
  return {
    status: context.status,
    target_risk: context.target_risk || null,
    scope: context.scope,
    summary: context.summary || null,
    top_risks: Array.isArray(context.top_risks) ? context.top_risks.slice(0, 8) : [],
    repo_top_risks: Array.isArray(context.repo_top_risks) ? context.repo_top_risks.slice(0, 5) : [],
    agent_rules: Array.isArray(context.agent_rules) ? context.agent_rules.slice(0, 6) : [],
  };
}

function formatAgentContext(context: Awaited<ReturnType<typeof getAgentContext>>): string {
  if ((context as any).context_profile === 'capsule-only') {
    const lines = [
      'Klauro capsule-only agent context',
      `Estimated tokens: ${(context as any).estimated_tokens || 'unknown'}`,
      '',
      'K15 context:',
      '```text',
      (context as any).context_capsule || '',
      '```',
      '',
      'K5 execution:',
      '```text',
      (context as any).execution_capsule || '',
      '```',
      '',
      `Rule: ${(context as any).rule || 'Read K15, execute K5, then expand only if blocked.'}`,
    ];
    return `${lines.join('\n')}\n`;
  }

  const selected = context.selected_node
    ? `${context.selected_node.name || context.selected_node.id} (${context.selected_node.file || 'unknown file'})`
    : 'none';
  const invariantImpact = (context as any).invariant_impact;
  const validateAgentCall = context.next_mcp_calls.find(step => step.tool === 'validate_agent_change');
  const validateCall = context.next_mcp_calls.find(step => step.tool === 'validate_behavioral_invariants');
  const validateIdiomCall = context.next_mcp_calls.find(step => step.tool === 'validate_codebase_idioms');
  const idiomContext = (context.work_context as any).idiom_context;
  const riskContext = (context.work_context as any).risk_context;
  const validationCommands = ((context as any).validation_plan?.commands || []).slice(0, 5);
  const validationLines = validationCommands.length > 0
    ? validationCommands.map((command: any) => `- ${command.command}: ${command.purpose}`)
    : ['- none inferred'];
  if (validateCall) {
    validationLines.push(`- MCP ${validateCall.tool}: ${validateCall.purpose}`);
  }
  if (validateIdiomCall) {
    validationLines.push(`- MCP ${validateIdiomCall.tool}: ${validateIdiomCall.purpose}`);
  }
  if (validateAgentCall) {
    validationLines.push(`- MCP ${validateAgentCall.tool}: ${validateAgentCall.purpose}`);
  }
  const lines = [
    `Klauro agent context: ${context.status.toUpperCase()}`,
    `Agent context ready: ${context.agent_context_ready ? 'yes' : 'no'}`,
    `Path: ${context.path}`,
    `Task: ${context.task.task_type || 'orient'}${context.task.target ? ` -> ${context.task.target}` : ''}`,
    `Selected node: ${selected}`,
    '',
    'Risk context:',
    ...(riskContext?.top_risks?.length
      ? riskContext.top_risks.slice(0, 5).map((risk: any) => `- ${risk.name || risk.node_id}: ${risk.risk_level}${risk.file ? ` (${risk.file})` : ''}`)
      : ['- no direct risk matched the selected target/files']),
    ...(riskContext?.repo_top_risks?.length
      ? riskContext.repo_top_risks.slice(0, 3).map((risk: any) => `- repo background: ${risk.name || risk.node_id}: ${risk.risk_level}${risk.file ? ` (${risk.file})` : ''}`)
      : []),
    ...(riskContext?.agent_rules?.length ? riskContext.agent_rules.slice(0, 3).map((rule: string) => `- ${rule}`) : []),
    '',
    'First files:',
    ...context.file_read_plan.slice(0, 10).map(item => {
      const window = item.line_window
        ? ` lines ${item.line_window.start}-${item.line_window.end}`
        : item.line
          ? ` line ${item.line}`
          : '';
      return `- ${item.file}${window}: ${item.reason}`;
    }),
    '',
    'Invariant impact:',
    invariantImpact ? `- ${invariantImpact.status}: ${invariantImpact.impacted_count} impacted invariants` : '- none',
    '',
    'Idiom context:',
    idiomContext ? `- ${idiomContext.total_idioms || 0} idioms; use ${idiomContext.selected_idioms?.map((idiom: any) => idiom.name).slice(0, 4).join(', ') || 'none'}` : '- none',
    '',
    'Validation:',
    ...validationLines,
    '',
    'Gaps:',
    ...(context.gaps.length ? context.gaps.map(gap => `- ${gap}`) : ['- none']),
  ];
  return `${lines.join('\n')}\n`;
}

function formatDoctor(doctor: Awaited<ReturnType<typeof getAgentDoctor>>): string {
  const lines = [
    `Klauro agent doctor: ${doctor.status.toUpperCase()}`,
    `Agent context ready: ${doctor.agent_context_ready ? 'yes' : 'no'}`,
    `Path: ${doctor.path}`,
    '',
    'Checks:',
    ...doctor.checks.map(check => `- ${check.status.toUpperCase()} ${check.id}: ${check.detail}`),
    '',
    'First commands:',
    ...doctor.first_commands.map(command => `- ${command}`),
  ];
  return `${lines.join('\n')}\n`;
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  const runLogPath = getAnalysisRunLogPath();
  if (fs.existsSync(runLogPath)) {
    process.stderr.write(`Analysis run log: ${runLogPath}\n`);
  }
  process.stderr.write('For diagnostics, run: klauro support-bundle <project-path> and send the bundle to support.\n');
  process.exit(1);
});
