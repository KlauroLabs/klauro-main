import * as path from 'path';
import { spawnSync } from 'child_process';
import { analyzeProject, analyzeProjectIncremental, getAnalysis } from './analyzer';
import { formatEnvironmentDoctor, runEnvironmentDoctor } from './environment-doctor';
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
import { buildUploadManifest } from './remote-source';
import { loadKlauroConfig, writeDefaultKlauroConfig } from './klauro-config';
import { buildGithubImportPlan } from './github-import';
import { compareAnalysisIterations, getPreviewAnalysis, previewCodebaseIteration, previewGreenfieldCodebase, type ProposedFileInput } from './proposal-preview';
import { buildGreenfieldArchitectureGuidance, type GreenfieldReferenceAnalysis } from './greenfield-guidance';
import { buildGreenfieldBuildContext } from './greenfield-build-session';
import { buildSupportBundle, formatSupportBundleResult } from './support-bundle';
import { formatFullPurgeReport, formatProjectPurgeReport, purgeAll, purgeProject, resolvePurgeRoots } from './purge';
import { getAnalysisRunLogPath } from '../../../packages/analyzer-core/src/analyzer/core/run-log';
import { formatBuildIdentity, getBuildIdentity } from '../../../packages/analyzer-core/src/analyzer/core/build-identity';
import { withAnalysisFocus, type AnalysisFocus } from './analysis-focus';
import { summarizeAnalysisFreshness } from './freshness';
import { buildCrossCodebaseSystemGraph, selectWorkspaceAnalysisDetail, summarizeCrossCodebaseSystemGraph, type WorkspaceDetailLevel } from './cross-codebase-analysis';
import { clearStoredConnectorSession, connectorToken, loadStoredConnectorAuth, normalizeServerUrl, requireConnectorEntitlement, saveStoredConnectorSession } from './connector-auth';
import { detectRemoteProvider } from './remote-provider';
import { detectWorkspaceIdentity, findFabricProjectRoot, resolveFabricSettings, resolveFabricToken, writeFabricSection } from './coordination/fabric-config';
import { remoteActive } from './coordination/remote-transport';
import { getActiveClaims } from './coordination/local-store';
import * as fs from 'fs-extra';
import * as readline from 'readline';

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
  register: boolean;
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
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ ...report, connection }, null, 2)}\n`);
    } else {
      process.stdout.write(`${await formatEnvironmentDoctor(report)}\n\nConnection (this repo):\n${formatConnectionReportLines(connection).map(line => `  ${line}`).join('\n')}\n`);
    }
    process.exitCode = report.status === 'fail' ? 1 : 0;
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

  if (args.command === 'auth-status') {
    const auth = loadStoredConnectorAuth();
    const serverUrl = normalizeServerUrl(args.serverUrl || auth.defaultServerUrl);
    const stored = auth.accounts[serverUrl];
    const result = {
      server_url: serverUrl,
      signed_in: Boolean(stored),
      email: stored?.email,
      auth_file: process.env.KLAURO_AUTH_CONFIG_PATH || '~/.klauro/auth.json',
    };
    process.stdout.write(args.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : `${result.signed_in ? `Signed in to ${serverUrl}${result.email ? ` as ${result.email}` : ''}` : `Not signed in to ${serverUrl}`}\n`);
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
    const auth = loadStoredConnectorAuth();
    const serverUrl = normalizeServerUrl(args.serverUrl || auth.defaultServerUrl);
    const stored = auth.accounts[serverUrl];
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ server_url: serverUrl, signed_in: Boolean(stored), email: stored?.email ?? null }, null, 2)}\n`);
    } else {
      process.stdout.write(stored
        ? `Signed in to ${serverUrl}${stored.email ? ` as ${stored.email}` : ''}\n`
        : `Not signed in to ${serverUrl} (run: klauro login --email you@example.com --register)\n`);
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
  ].includes(args.command)) {
    throw new Error(`Unknown command: ${args.command}`);
  }
  if (!args.path && ['init', 'index', 'analyze', 'upload-manifest', 'install-agent', 'github-import-plan', 'agent-tracks'].includes(args.command)) {
    args.path = '.';
  }
  if (!args.path && !['greenfield-preview', 'greenfield-guidance', 'greenfield-build-context', 'preview-get', 'compare-iterations', 'workspace-analysis', 'workspace-get', 'workspace-list', 'cross-codebase-analysis', 'cross-codebase-get', 'cross-codebase-list', 'support-bundle'].includes(args.command)) {
    throw new Error(`${args.command} requires a project path`);
  }

  const projectPath = args.path ? path.resolve(args.path) : '';

  if (args.command === 'init') {
    await runInitCommand(projectPath, args);
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
      index_type: 'local-working-copy-context',
      authoritative: false,
      visibility: 'private-to-this-developer',
      account: {
        user: identity.user,
        entitlement: identity.entitlement,
      },
      manifest,
      next: [
        'Use this context to help local agents understand uncommitted work without publishing it as shared project analysis.',
        'Commit changes and run klauro remote-analyze when the work should become a shared analyzed project revision.',
      ],
    };
    process.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : formatLocalIndexResult(result));
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
    // self-hosted analyzer-server for dev. See docs/KLAURO-PRODUCT-MODEL.md.
    const result = await withLogHandling(args.json, args.quiet, () => analyzeCodebaseRemotely({
      projectPath,
      serverUrl: args.serverUrl,
      analysisId: args.analysisId,
    }));
    process.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : formatRemoteResult(result));
    return;
  }

  if (args.command === 'remote-analyze') {
    const result = await withLogHandling(args.json, args.quiet, () => analyzeCodebaseRemotely({
      projectPath,
      serverUrl: args.serverUrl,
      analysisId: args.analysisId,
    }));
    process.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : formatRemoteResult(result));
    return;
  }

  if (args.command === 'remote-sync') {
    const result = await withLogHandling(args.json, args.quiet, () => syncWorkingTreeRemotely({
      projectPath,
      serverUrl: args.serverUrl,
      analysisId: args.analysisId,
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
        name: cas.system?.name || path.basename(absolute),
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
        name: cas.system?.name || path.basename(absolute),
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
      repositories.push({ path: absolute, name: cas.system?.name || path.basename(absolute), cas });
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

interface ReleaseManifest {
  version: string | null;
  tarball: string;
  tarball_path?: string;
  min_node?: number;
  published_at?: string | null;
}

async function fetchReleaseManifest(serverUrl: string): Promise<ReleaseManifest | null> {
  try {
    const response = await fetch(`${serverUrl}/dist/latest.json`, { headers: { 'cache-control': 'no-cache' } });
    if (!response.ok) return null;
    return (await response.json()) as ReleaseManifest;
  } catch {
    return null;
  }
}

async function runUpdateCommand(args: ParsedArgs): Promise<void> {
  // Resolve the server that hosts the tarball: explicit flag, then the stored
  // login default, then KLAURO_URL, then the public default.
  const auth = loadStoredConnectorAuth();
  const serverUrl = normalizeServerUrl(
    args.serverUrl || auth.defaultServerUrl || process.env.KLAURO_URL,
  );
  const current = getBuildIdentity().base_version;
  const manifest = await fetchReleaseManifest(serverUrl);
  const latest = manifest?.version || null;
  const checkOnly = process.argv.includes('--check');

  if (args.json && checkOnly) {
    process.stdout.write(`${JSON.stringify({ current, latest, server_url: serverUrl, up_to_date: latest ? latest === current : null }, null, 2)}\n`);
    return;
  }

  process.stdout.write(`Current klauro: ${current}\n`);
  process.stdout.write(latest ? `Latest available: ${latest} (${serverUrl})\n` : `Latest available: unknown (could not reach ${serverUrl}/dist/latest.json)\n`);

  if (checkOnly) {
    if (latest && latest === current && !args.force) {
      process.stdout.write('You are on the latest version.\n');
    } else if (latest && latest !== current) {
      process.stdout.write('A newer version is available. Run: klauro update\n');
    }
    return;
  }

  if (latest && latest === current && !args.force) {
    process.stdout.write('Already on the latest version. Use --force to reinstall anyway.\n');
    return;
  }

  const tarballUrl = manifest?.tarball || `${serverUrl}/dist/klauro-latest.tgz`;
  process.stdout.write(`\nInstalling ${tarballUrl} ...\n`);
  process.stdout.write('(this may take a minute -- native tree-sitter deps compile)\n\n');
  // --force reinstalls even when the version string is unchanged, so users
  // always pick up fresh bits; the server sends Cache-Control: no-cache too.
  const result = spawnSync('npm', ['install', '-g', tarballUrl, '--force'], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`npm install failed (exit ${result.status ?? 'unknown'}). See output above.`);
  }
  process.stdout.write('\nklauro updated. Restart Claude Code (or your MCP client) to load the new server.\n');
}

async function runStatusCommand(args: ParsedArgs): Promise<void> {
  const identity = getBuildIdentity();
  const auth = loadStoredConnectorAuth();
  const serverUrl = normalizeServerUrl(args.serverUrl || auth.defaultServerUrl || process.env.KLAURO_URL);
  const stored = auth.accounts[serverUrl];
  const manifest = await fetchReleaseManifest(serverUrl);
  const latest = manifest?.version || null;

  // Best-effort: is the current directory analyzed, and how fresh?
  const repoPath = path.resolve(args.path || '.');
  let repo: { analyzed: boolean; system?: string; analyzed_at?: string; staleness?: string } = { analyzed: false };
  try {
    const cas = await getAnalysis(repoPath);
    const freshness = summarizeAnalysisFreshness(repoPath, cas.analysis_timestamp);
    repo = {
      analyzed: true,
      system: (cas as any).system_name || (cas as any).summary?.system_name,
      analyzed_at: cas.analysis_timestamp,
      staleness: freshness?.staleness,
    };
  } catch {
    repo = { analyzed: false };
  }

  // Every subsystem `klauro init` connects, in one view (auth above, then
  // project identity / analysis / in-flight / MCP / fabric below).
  const connection = await buildConnectionReport(repoPath);

  const report = {
    version: identity.version,
    channel: identity.channel,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    server_url: serverUrl,
    signed_in: Boolean(stored),
    email: stored?.email ?? null,
    latest_available: latest,
    update_available: Boolean(latest && latest !== identity.base_version),
    repo: repoPath,
    repo_analyzed: repo.analyzed,
    repo_system: repo.system ?? null,
    repo_analyzed_at: repo.analyzed_at ?? null,
    repo_staleness: repo.staleness ?? null,
    project: connection.project,
    workspace_identity: connection.identity,
    in_flight: connection.in_flight,
    mcp_registered: connection.mcp_registered,
    fabric: connection.fabric,
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const lines = [
    `klauro ${report.version} (${report.channel}) · node ${report.node} · ${report.platform}`,
    report.signed_in ? `Account:  signed in to ${serverUrl}${report.email ? ` as ${report.email}` : ''}` : `Account:  not signed in to ${serverUrl}  (klauro login --email you@example.com --register)`,
    latest
      ? (report.update_available ? `Release:  ${latest} available — run: klauro update` : `Release:  up to date (${latest})`)
      : `Release:  could not reach ${serverUrl}`,
    ...formatConnectionReportLines(connection),
    report.repo_analyzed
      ? `Analysis: ${report.repo_system || 'analyzed'} · ${report.repo_staleness || 'unknown'} · ${report.repo_analyzed_at || ''}`.trim()
      : `Analysis: ${repoPath} not analyzed  (klauro analyze .)`,
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

async function runLoginCommand(args: ParsedArgs): Promise<void> {
  const serverUrl = normalizeServerUrl(args.serverUrl);
  const email = args.email || await promptLine('Email: ');
  const password = args.password || await promptLine('Password: ');
  if (!email) throw new Error('login requires --email or an entered email');
  if (!password) throw new Error('login requires --password or an entered password');
  const endpoint = args.register ? '/api/auth/register' : '/api/auth/login';
  const response = await fetch(`${serverUrl}${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args.register
      ? { email, password, workspace_name: 'Klauro' }
      : { email, password }),
  });
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

async function runInitCommand(projectPath: string, args: ParsedArgs): Promise<void> {
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
  if (!args.json) process.stdout.write(`Connecting ${projectPath} to Klauro\n`);

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
  // TTY, defaults otherwise).
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
  }
  const identity = detectWorkspaceIdentity(projectPath, loaded.config.project.id);
  record('project', 'ok',
    `${loaded.config.project.name || path.basename(projectPath)}${loaded.config.project.id ? ` (hosted project ${loaded.config.project.id})` : ''} · identity ${identity.workspace} (${identity.source})${hadConfig && !args.force ? ' · existing .klaurorc kept' : ` · wrote ${loaded.configPath}`}`);

  // (c) Analysis — kick off / refresh the hosted analysis for this repo.
  // Best-effort: a failed or slow analysis never fails the connect.
  if (!token) {
    record('analysis', 'skip', 'requires sign-in — run `klauro analyze .` after `klauro login`');
  } else {
    try {
      const result = await withLogHandling(true, true, () => analyzeCodebaseRemotely({
        projectPath,
        serverUrl,
        analysisId: args.analysisId,
      }));
      record('analysis', 'ok', `${result.analysis_id} @ revision ${result.analysis_revision} (${result.cas.nodes.length} nodes, ${result.cas.edges.length} edges)`);
    } catch (error) {
      record('analysis', 'warn', `did not complete (${error instanceof Error ? error.message : String(error)}) — retry with: klauro analyze .`);
    }
  }

  // (d) In-flight — the dirty-tree track is automatic (no setup step): the
  // working tree is captured on demand (get_in_flight_changes / remote-sync)
  // and published through the fabric when remote. Report, don't configure.
  const dirty = countDirtyFiles(projectPath);
  record('in-flight', 'ok', dirty === undefined
    ? 'automatic — uncommitted work is tracked on demand (no git repo detected here, so the track starts with the first commit history)'
    : dirty === 0
      ? 'automatic — working tree clean; uncommitted work is tracked on demand'
      : `automatic — ${dirty} uncommitted file(s) currently in flight`);

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

  const payload = {
    status: 'connected',
    path: projectPath,
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
  process.stdout.write([
    '',
    `Klauro connected: ${payload.project.name || path.basename(projectPath)}`,
    `Config: ${payload.config}`,
    'Check any time with `klauro status`; re-running `klauro init` is idempotent (verifies and refreshes each subsystem).',
    '',
  ].join('\n'));
}

/** Best-effort count of uncommitted (dirty + untracked) files; undefined = not a git repo. */
function countDirtyFiles(projectPath: string): number | undefined {
  const result = spawnSync('git', ['-C', projectPath, 'status', '--porcelain', '-uall'], { encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0 || typeof result.stdout !== 'string') return undefined;
  return result.stdout.split('\n').filter(line => line.trim()).length;
}

/** true = registered, false = claude present but klauro not registered, undefined = no claude CLI. */
function detectClaudeMcpRegistration(): boolean | undefined {
  const probe = spawnSync('claude', ['mcp', 'get', 'klauro'], { encoding: 'utf8', timeout: 10000 });
  if (probe.error || probe.status === null) return undefined;
  return probe.status === 0;
}

/**
 * One-glance connection report for `klauro status` / `klauro doctor`: every
 * subsystem `klauro init` connects, for the current repo.
 */
async function buildConnectionReport(repoPath: string): Promise<{
  project: { initialized: boolean; config: string | null; name: string | null; id: string | null; workspace_id: string | null; kind: string | null };
  identity: WorkspaceIdentityReport;
  in_flight: { tracked: 'automatic'; dirty_files: number | null };
  mcp_registered: boolean | null;
  fabric: { enabled: boolean; mode: 'remote' | 'local'; endpoint: string | null; workspace: string; active_claims: number | null; note?: string };
}> {
  const loaded = await loadKlauroConfig(repoPath).catch(() => undefined);
  const initialized = Boolean(loaded?.configPath);
  const identity = detectWorkspaceIdentity(repoPath, loaded?.config.project.id);
  const settings = await resolveFabricSettings({ cwd: repoPath });
  let activeClaims: number | null = null;
  let fabricNote: string | undefined;
  if (settings.remote) {
    try {
      activeClaims = (await remoteActive(settings.remote, settings.workspace)).count;
    } catch (error) {
      fabricNote = `remote fabric unreachable (${error instanceof Error ? error.message : String(error)})`;
    }
  } else {
    activeClaims = (await getActiveClaims(settings.workspace).catch(() => [])).length;
    fabricNote = settings.fabric && settings.fabric.enabled === false ? 'disabled by `klauro fabric off`' : 'local fabric (same-machine peers only)';
  }
  const dirty = countDirtyFiles(repoPath);
  return {
    project: {
      initialized,
      config: loaded?.configPath ?? null,
      name: loaded?.config.project.name ?? null,
      id: loaded?.config.project.id ?? null,
      workspace_id: loaded?.config.project.workspaceId ?? null,
      kind: loaded?.config.kind ?? null,
    },
    identity,
    in_flight: { tracked: 'automatic', dirty_files: dirty ?? null },
    mcp_registered: detectClaudeMcpRegistration() ?? null,
    fabric: {
      enabled: Boolean(settings.remote),
      mode: settings.remote ? 'remote' : 'local',
      endpoint: settings.remote?.baseUrl ?? null,
      workspace: settings.workspace,
      active_claims: activeClaims,
      note: fabricNote,
    },
  };
}

type WorkspaceIdentityReport = ReturnType<typeof detectWorkspaceIdentity>;

function formatConnectionReportLines(report: Awaited<ReturnType<typeof buildConnectionReport>>): string[] {
  return [
    report.project.initialized
      ? `Project:  ${report.project.name || 'unnamed'}${report.project.id ? ` (hosted project ${report.project.id})` : ''} · identity ${report.identity.workspace} (${report.identity.source}) · ${report.project.config}`
      : `Project:  not connected  (run: klauro init)`,
    `In-flight: automatic${report.in_flight.dirty_files === null ? '' : ` · ${report.in_flight.dirty_files} uncommitted file(s)`}`,
    report.mcp_registered === null
      ? 'MCP:      unknown (claude CLI not found) — klauro install wires agent access'
      : report.mcp_registered
        ? 'MCP:      klauro registered with Claude Code'
        : 'MCP:      not registered  (run: klauro install)',
    report.fabric.mode === 'remote'
      ? `Fabric:   remote via ${report.fabric.endpoint} · workspace ${report.fabric.workspace} · ${report.fabric.active_claims === null ? (report.fabric.note || 'claims unavailable') : `${report.fabric.active_claims} active claim(s)`}`
      : `Fabric:   local · workspace ${report.fabric.workspace}${report.fabric.note ? ` · ${report.fabric.note}` : ''}${report.project.initialized ? '' : '  (klauro init connects it)'}`,
  ];
}

async function resolveInitOptions(projectPath: string, args: ParsedArgs): Promise<{
  serverUrl?: string;
  projectId?: string;
  workspaceId?: string;
  organizationId?: string;
  projectName?: string;
  kind?: 'project' | 'workspace';
}> {
  if (args.json || !process.stdin.isTTY || args.projectId || args.organizationId) {
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
  process.stdout.write(`Klauro init for ${projectPath}\n`);
  if (manifest.remote_provider) {
    const remote = manifest.remote_provider.owner && manifest.remote_provider.repository
      ? `${manifest.remote_provider.owner}/${manifest.remote_provider.repository}`
      : manifest.remote_provider.repository_url || manifest.remote_provider.provider;
    process.stdout.write(`Detected remote: ${remote}\n`);
  }
  if (manifest.workspace_recommendation?.recommended) {
    process.stdout.write(`Detected child projects: ${manifest.workspace_recommendation.candidates.map(candidate => candidate.path).join(', ')}\n`);
  }

  const kind = await promptChoice<'project' | 'workspace'>(
    'Initialize this folder as a project or workspace?',
    ['project', 'workspace'],
    defaultKind,
  );

  if (!token) {
    process.stdout.write('Not signed in. Writing local config only; run `klauro login` to link/create hosted workspaces and projects.\n');
    const name = await promptLine(`Name [${path.basename(projectPath)}]: `) || path.basename(projectPath);
    return { serverUrl, kind, projectName: name, projectId: undefined, organizationId: undefined, workspaceId: undefined };
  }

  if (kind === 'workspace') {
    const workspace = await selectOrCreateWorkspace(serverUrl, token, path.basename(projectPath));
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
  const remoteUrl = manifest.remote_provider?.repository_url;
  const matched = remoteUrl ? projects.find(project => normalizeRepoUrl(project.repo_url) === normalizeRepoUrl(remoteUrl)) : undefined;
  let project: RemoteProjectChoice | undefined;
  if (matched) {
    const answer = await promptChoice<'yes' | 'no'>(
      `Found matching Klauro project "${matched.name}" for this Git remote. Link to it?`,
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
    const defaultName = path.basename(projectPath);
    const name = await promptLine(`Project name [${defaultName}]: `) || defaultName;
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
  if (workspaces.length > 0) {
    process.stdout.write('Workspaces:\n');
    workspaces.forEach((workspace, index) => {
      process.stdout.write(`  ${index + 1}. ${workspace.name}${workspace.project_count !== undefined ? ` (${workspace.project_count} projects)` : ''}\n`);
    });
  }
  const action = workspaces.length
    ? await promptChoice<'existing' | 'new'>('Use an existing workspace or create a new one?', ['existing', 'new'], 'existing')
    : 'new';
  if (action === 'existing') return selectRemoteWorkspace(workspaces);
  const fallback = defaultName || 'Klauro Workspace';
  const name = await promptLine(`Workspace name [${fallback}]: `) || fallback;
  return createRemoteWorkspace(serverUrl, token, name);
}

async function selectRemoteWorkspace(workspaces: RemoteWorkspaceChoice[]): Promise<RemoteWorkspaceChoice> {
  if (!workspaces.length) throw new Error('No workspaces available');
  const raw = await promptLine(`Workspace number [1]: `);
  const index = raw ? Number(raw) - 1 : 0;
  if (!Number.isInteger(index) || index < 0 || index >= workspaces.length) throw new Error('Invalid workspace selection');
  return workspaces[index];
}

async function selectRemoteProject(projects: RemoteProjectChoice[]): Promise<RemoteProjectChoice> {
  projects.forEach((project, index) => {
    process.stdout.write(`  ${index + 1}. ${project.name}${project.repo_url ? ` (${project.repo_url})` : ''}\n`);
  });
  const raw = await promptLine(`Project number [1]: `);
  const index = raw ? Number(raw) - 1 : 0;
  if (!Number.isInteger(index) || index < 0 || index >= projects.length) throw new Error('Invalid project selection');
  return projects[index];
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

async function remoteJson<T>(serverUrl: string, token: string, route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${serverUrl}${route}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({})) as any;
  if (!response.ok) throw new Error(payload?.error || `Klauro API request failed with HTTP ${response.status}`);
  return payload as T;
}

function normalizeRepoUrl(value?: string): string | undefined {
  if (!value) return undefined;
  const detected = detectRemoteProvider(value);
  return (detected?.repository_url || value).replace(/\.git$/i, '').toLowerCase();
}

async function promptLine(label: string): Promise<string> {
  if (!process.stdin.isTTY) return '';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>(resolve => rl.question(label, resolve));
  rl.close();
  return answer.trim();
}

async function loadOrAnalyze(projectPath: string, refresh: boolean) {
  if (refresh) return (await analyzeProjectIncremental(projectPath)).output;

  try {
    const existing = await getAnalysis(projectPath);
    const freshness = summarizeAnalysisFreshness(projectPath, existing.analysis_timestamp);
    if (freshness && freshness.staleness !== 'fresh') {
      return (await analyzeProjectIncremental(projectPath)).output;
    }
    return existing;
  } catch {
    return (await analyzeProjectIncremental(projectPath)).output;
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

function parseArgs(argv: string[]): ParsedArgs {
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
    register: false,
    deployOnly: false,
    markdown: false,
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
    } else if (arg === '--register') {
      parsed.register = true;
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
    '  klauro login --email you@example.com [--password value] [--server-url url] [--register]',
    '  klauro whoami [--server-url url] [--json]',
    '  klauro auth-status [--server-url url] [--json]',
    '  klauro logout [--server-url url] [--json]',
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
    '  klauro analyzer-server [--host 0.0.0.0] [--port 8787] [--data-dir .klauro-remote-analyzer]',
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
    '  klauro analyzer-server --host 127.0.0.1 --port 8787',
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
    '  klauro proposal-preview . --plan "Add a health endpoint" --proposed-files proposed-files.json',
    '  klauro greenfield-guidance --plan "Create a portfolio reporting service" --reference-path ~/dev/zerac/zerac-api',
    '  klauro greenfield-build-context /tmp/new-app --plan "Build an operations command center" --json',
    '  klauro greenfield-preview --plan-file plan.md --proposed-files proposed-files.json',
    '  klauro workspace-analysis ~/dev/soon/soon-ui --reference-path ~/dev/soon/soon-sync --target soon-workspace',
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
        data_dir: args.dataDir || process.env.KLAURO_REMOTE_ANALYZER_DATA || '.klauro-remote-analyzer',
        auth: process.env.KLAURO_ANALYZER_TOKEN ? 'bearer-token-required' : 'none',
      };
      process.stdout.write(args.json ? `${JSON.stringify(payload, null, 2)}\n` : `Klauro remote analyzer listening on ${url}\n`);
      resolve();
    });
  });

  const stop = () => {
    server.close(() => process.exit(0));
  };
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

function formatLocalIndexResult(result: {
  status: string;
  index_type: string;
  authoritative: boolean;
  visibility: string;
  account: { entitlement: { status: string; plan?: string } };
  manifest: Awaited<ReturnType<typeof buildUploadManifest>>;
  next: string[];
}): string {
  return [
    'Klauro local working-copy context: SUCCESS',
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

function formatLocalAnalyzeResult(result: Awaited<ReturnType<typeof analyzeProjectIncremental>>, focus?: ParsedArgs['analysisFocus']): string {
  return [
    `Klauro local analysis: SUCCESS`,
    `Type: ${result.wasFullRebuild ? 'full' : 'incremental'}`,
    `Focus: ${focus || 'full'}`,
    `Nodes: ${result.output.nodes.length}`,
    `Edges: ${result.output.edges.length}`,
    `Entry points: ${result.output.entry_points?.length || 0}`,
    '',
  ].join('\n');
}

function formatRemoteResult(result: Awaited<ReturnType<typeof analyzeCodebaseRemotely>>): string {
  const changedFiles = result.change_report
    ? result.change_report.summary.filesAdded + result.change_report.summary.filesModified + result.change_report.summary.filesDeleted
    : 0;
  return [
    `Klauro remote analysis: ${result.status.toUpperCase()}`,
    `Analysis id: ${result.analysis_id}`,
    `Revision: ${result.analysis_revision}`,
    `Type: ${result.analysis_type}`,
    `Files sent: ${result.manifest.file_count}`,
    `Bytes sent: ${result.manifest.total_bytes}`,
    `Nodes: ${result.cas.nodes.length}`,
    `Edges: ${result.cas.edges.length}`,
    `Changed files: ${changedFiles}`,
    '',
  ].join('\n');
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
    summary: risk.change_risk_summary || null,
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
