#!/usr/bin/env tsx
import * as path from 'path';
import { analyzeProjectIncremental, getAnalysis } from './analyzer';
import { getAgentBootstrap } from './agent-bootstrap';
import { writeAgentDefaultConfig } from './agent-defaults';
import { getAgentDoctor } from './agent-doctor';
import { buildCASGoldenSnapshot } from './cas-contract';
import { saveGoldenSnapshot } from './storage';
import { getAgentWorkPacket } from './agent-adoption';
import type { AgentTask, AgentTaskType } from './agent-adoption';
import { analyzeCodebaseRemotely, syncWorkingTreeRemotely } from './remote-sync-client';
import { buildUploadManifest } from './remote-source';
import { loadKlauroConfig, writeDefaultKlauroConfig } from './klauro-config';
import { buildGithubImportPlan } from './github-import';
import { compareAnalysisIterations, getPreviewAnalysis, previewCodebaseIteration, previewGreenfieldCodebase, type ProposedFileInput } from './proposal-preview';
import * as fs from 'fs-extra';

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
  mode?: 'local' | 'remote';
  dirtyTree: boolean;
  projectId?: string;
  organizationId?: string;
  planText?: string;
  planFile?: string;
  diffText?: string;
  diffFile?: string;
  proposedFilesFile?: string;
  previewId?: string;
  baselinePath?: string;
  proposedPath?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.command || args.command === 'help' || args.command === '--help' || args.command === '-h') {
    printHelp();
    return;
  }

  if (![
    'init',
    'analyze',
    'upload-manifest',
    'install-agent',
    'github-import-plan',
    'agent-start',
    'agent-work-packet',
    'agent-install',
    'doctor',
    'save-golden',
    'remote-analyze',
    'remote-sync',
    'proposal-preview',
    'greenfield-preview',
    'preview-get',
    'compare-iterations',
  ].includes(args.command)) {
    throw new Error(`Unknown command: ${args.command}`);
  }
  if (!args.path && ['init', 'analyze', 'upload-manifest', 'install-agent', 'github-import-plan'].includes(args.command)) {
    args.path = '.';
  }
  if (!args.path && !['greenfield-preview', 'preview-get', 'compare-iterations'].includes(args.command)) {
    throw new Error(`${args.command} requires a project path`);
  }

  const projectPath = args.path ? path.resolve(args.path) : '';

  if (args.command === 'init') {
    const result = await writeDefaultKlauroConfig(projectPath, {
      force: args.force,
      mode: args.mode,
      serverUrl: args.serverUrl,
      projectId: args.projectId,
      organizationId: args.organizationId,
    });
    process.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : formatInitResult(result));
    return;
  }

  if (args.command === 'upload-manifest') {
    const manifest = await buildUploadManifest(projectPath, args.dirtyTree ? 'dirty-tree' : 'full');
    process.stdout.write(args.json ? `${JSON.stringify(manifest, null, 2)}\n` : formatUploadManifest(manifest));
    return;
  }

  if (args.command === 'github-import-plan') {
    const loaded = await loadKlauroConfig(projectPath);
    const plan = buildGithubImportPlan(projectPath, loaded.config);
    process.stdout.write(args.json ? `${JSON.stringify(plan, null, 2)}\n` : formatGithubImportPlan(plan));
    return;
  }

  if (args.command === 'analyze') {
    const loaded = await loadKlauroConfig(projectPath);
    if (loaded.config.analyzer.mode === 'remote') {
      const result = await withLogHandling(args.json, args.quiet, () => analyzeCodebaseRemotely({
        projectPath,
        serverUrl: args.serverUrl,
        analysisId: args.analysisId,
      }));
      process.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : formatRemoteResult(result));
    } else {
      const result = await withLogHandling(args.json, args.quiet, () => analyzeProjectIncremental(projectPath));
      process.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : formatLocalAnalyzeResult(result));
    }
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

  if (args.command === 'agent-work-packet') {
    const packet = await getAgentWorkPacket(cas, projectPath, args.task);
    const output = args.compact ? compactWorkPacket(packet) : packet;
    process.stdout.write(args.json ? `${JSON.stringify(output, null, 2)}\n` : formatWorkPacket(packet));
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
  }
}

async function loadOrAnalyze(projectPath: string, refresh: boolean) {
  if (refresh) return (await analyzeProjectIncremental(projectPath)).output;

  try {
    return await getAnalysis(projectPath);
  } catch {
    return (await analyzeProjectIncremental(projectPath)).output;
  }
}

async function withLogHandling<T>(json: boolean, quiet: boolean, fn: () => Promise<T>): Promise<T> {
  if (!json && !quiet) return fn();
  const originalLog = console.log;
  console.log = quiet ? () => undefined : (...args: unknown[]) => console.error(...args);
  try {
    return await fn();
  } finally {
    console.log = originalLog;
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
    mode: undefined,
    dirtyTree: false,
    projectId: undefined,
    organizationId: undefined,
    planText: undefined,
    planFile: undefined,
    diffText: undefined,
    diffFile: undefined,
    proposedFilesFile: undefined,
    previewId: undefined,
    baselinePath: undefined,
    proposedPath: undefined,
  };

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--refresh') {
      parsed.refresh = true;
    } else if (arg === '--compact') {
      parsed.compact = true;
    } else if (arg === '--quiet') {
      parsed.quiet = true;
    } else if (arg === '--server-url') {
      parsed.serverUrl = argv[++i];
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
    } else if (arg === '--preview-id') {
      parsed.previewId = argv[++i];
    } else if (arg === '--baseline-path') {
      parsed.baselinePath = path.resolve(argv[++i]);
    } else if (arg === '--proposed-path') {
      parsed.proposedPath = path.resolve(argv[++i]);
    } else if (arg === '--mode') {
      parsed.mode = argv[++i] as 'local' | 'remote';
    } else if (arg === '--force') {
      parsed.force = true;
    } else if (arg === '--dirty-tree') {
      parsed.dirtyTree = true;
    } else if (arg === '--task-type') {
      parsed.task.task_type = argv[++i] as AgentTaskType;
    } else if (arg === '--target') {
      parsed.task.target = argv[++i];
    } else if (arg === '--instructions') {
      parsed.task.instructions = argv[++i];
    } else if (arg === '--success-criterion') {
      parsed.task.success_criteria = [...(parsed.task.success_criteria || []), argv[++i]];
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
    'Usage:',
    '  klauro init [/path/to/repo] [--mode local|remote] [--server-url url] [--project-id id] [--organization-id id] [--force] [--json]',
    '  klauro upload-manifest [/path/to/repo] [--dirty-tree] [--json]',
    '  klauro analyze [/path/to/repo] [--server-url http://127.0.0.1:8787] [--analysis-id id] [--json]',
    '  klauro install-agent [/path/to/repo] [--json]',
    '  klauro github-import-plan [/path/to/repo] [--json]',
    '  klauro agent-start /path/to/repo [--task-type orient|modify|debug|review|trace|cross-repo|runtime] [--target query] [--json] [--refresh]',
    '  klauro agent-work-packet /path/to/repo [--task-type orient|modify|debug|review|trace|cross-repo|runtime] [--target query] [--instructions text] [--success-criterion text] [--json] [--compact] [--quiet] [--refresh]',
    '  klauro agent-install /path/to/repo [--task-type orient|modify|debug|review|trace|cross-repo|runtime] [--target query] [--json] [--refresh]',
    '  klauro doctor /path/to/repo [--json] [--refresh]',
    '  klauro save-golden /path/to/repo [--json] [--refresh]',
    '  klauro remote-analyze /path/to/repo [--server-url http://127.0.0.1:8787] [--analysis-id id] [--json]',
    '  klauro remote-sync /path/to/repo [--server-url http://127.0.0.1:8787] [--analysis-id id] [--json]',
    '  klauro proposal-preview /path/to/repo --plan-file plan.md [--diff-file changes.patch] [--proposed-files files.json] [--server-url app-url] [--json]',
    '  klauro greenfield-preview --plan-file plan.md --proposed-files files.json [--server-url app-url] [--json]',
    '  klauro preview-get [--preview-id id] [--json]',
    '  klauro compare-iterations [--preview-id id] [--baseline-path /repo] [--proposed-path /repo-copy] [--json]',
    '',
    'Examples:',
    '  klauro init . --mode remote --server-url https://analyzer.klauro.dev',
    '  klauro upload-manifest .',
    '  klauro analyze .',
    '  klauro install-agent .',
    '  klauro agent-start .',
    '  klauro agent-work-packet . --task-type modify --target auth --json',
    '  klauro agent-install .',
    '  klauro doctor .',
    '  klauro save-golden .',
    '  klauro remote-analyze . --server-url http://127.0.0.1:8787',
    '  klauro remote-sync . --server-url http://127.0.0.1:8787',
    '  klauro proposal-preview . --plan "Add a health endpoint" --proposed-files proposed-files.json',
    '  klauro greenfield-preview --plan-file plan.md --proposed-files proposed-files.json',
    '  klauro agent-start ~/dev/klauro/proof-of-concept --task-type debug --target auth',
    '  npm --silent run agent-start -- . --json',
    '  npm --silent run agent-install -- . --json',
  ].join('\n') + '\n');
}

function formatInitResult(result: Awaited<ReturnType<typeof writeDefaultKlauroConfig>>): string {
  return [
    'Initialized Klauro project config',
    `Config: ${result.configPath}`,
    `Ignore: ${result.ignorePath}`,
    `Analyzer mode: ${result.config.analyzer.mode}`,
    `Analyzer URL: ${result.config.analyzer.serverUrl || 'not set'}`,
    '',
    'Next:',
    '  klauro upload-manifest .',
    '  klauro analyze .',
    '  klauro install-agent .',
    '',
  ].join('\n');
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
    `Included: ${manifest.summary.included_files} files, ${manifest.summary.included_bytes} bytes`,
    `Excluded sample: ${manifest.summary.excluded_files} files/directories`,
    manifest.summary.changed_files !== undefined ? `Dirty-tree changed files: ${manifest.summary.changed_files}` : undefined,
    manifest.summary.deleted_files !== undefined ? `Dirty-tree deleted files: ${manifest.summary.deleted_files}` : undefined,
    '',
    'Largest included files:',
    ...(largest.length ? largest : ['- none']),
    '',
  ].filter(Boolean).join('\n');
}

function formatLocalAnalyzeResult(result: Awaited<ReturnType<typeof analyzeProjectIncremental>>): string {
  return [
    `Klauro local analysis: SUCCESS`,
    `Type: ${result.wasFullRebuild ? 'full' : 'incremental'}`,
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

function compactWorkPacket(packet: Awaited<ReturnType<typeof getAgentWorkPacket>>) {
  const context = packet.work_context as any;
  const nextMcpCalls = packet.next_mcp_calls.filter((step: any, index: number) =>
    index < 8 || step.tool === 'validate_agent_change' || step.tool === 'validate_behavioral_invariants' || step.tool === 'validate_codebase_idioms'
  );
  return {
    path: packet.path,
    generated_at: packet.generated_at,
    task: packet.task,
    status: packet.status,
    default_use: packet.default_use,
    readiness: packet.readiness,
    selected_node: packet.selected_node,
    target_gaps: (packet.target_resolution as any)?.gaps || [],
    file_read_plan: packet.file_read_plan.slice(0, 12).map((item: any) => ({
      file: item.file,
      reason: item.reason,
      line: item.line,
      line_window: item.line_window,
      node_ids: Array.isArray(item.node_ids) ? item.node_ids.slice(0, 8) : item.node_ids,
    })),
    risk: context.risk ? {
      level: context.risk.level,
      score: context.risk.score,
      reasons: context.risk.reasons || context.risk.factors || context.risk.details,
    } : null,
    tests: summarizeTests(context.tests),
    behavioral_invariants: context.behavioral_invariants ? {
      total: context.behavioral_invariants.total,
      invariants: context.behavioral_invariants.invariants?.slice(0, 8),
    } : null,
    idiom_context: context.idiom_context ? {
      total_idioms: context.idiom_context.total_idioms,
      selected_idioms: context.idiom_context.selected_idioms?.slice(0, 8),
      local_examples: context.idiom_context.local_examples?.slice(0, 8),
      do: context.idiom_context.do?.slice(0, 10),
      avoid: context.idiom_context.avoid?.slice(0, 10),
      validation: context.idiom_context.validation?.slice(0, 10),
    } : null,
    invariant_impact: (packet as any).invariant_impact,
    validation_plan: (packet as any).validation_plan,
    next_mcp_calls: nextMcpCalls.map((step: any) => ({
      tool: step.tool,
      purpose: step.purpose,
      required: step.required,
      args: step.args,
    })),
    source_reading_rule: packet.source_reading_rule,
    gaps: packet.gaps,
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

function formatWorkPacket(packet: Awaited<ReturnType<typeof getAgentWorkPacket>>): string {
  const selected = packet.selected_node
    ? `${packet.selected_node.name || packet.selected_node.id} (${packet.selected_node.file || 'unknown file'})`
    : 'none';
  const invariantImpact = (packet as any).invariant_impact;
  const validateAgentCall = packet.next_mcp_calls.find(step => step.tool === 'validate_agent_change');
  const validateCall = packet.next_mcp_calls.find(step => step.tool === 'validate_behavioral_invariants');
  const validateIdiomCall = packet.next_mcp_calls.find(step => step.tool === 'validate_codebase_idioms');
  const idiomContext = (packet.work_context as any).idiom_context;
  const validationCommands = ((packet as any).validation_plan?.commands || []).slice(0, 5);
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
    `Klauro work packet: ${packet.status.toUpperCase()}`,
    `Default use: ${packet.default_use ? 'yes' : 'no'}`,
    `Path: ${packet.path}`,
    `Task: ${packet.task.task_type || 'orient'}${packet.task.target ? ` -> ${packet.task.target}` : ''}`,
    `Selected node: ${selected}`,
    '',
    'First files:',
    ...packet.file_read_plan.slice(0, 10).map(item => {
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
    ...(packet.gaps.length ? packet.gaps.map(gap => `- ${gap}`) : ['- none']),
  ];
  return `${lines.join('\n')}\n`;
}

function formatDoctor(doctor: Awaited<ReturnType<typeof getAgentDoctor>>): string {
  const lines = [
    `Klauro agent doctor: ${doctor.status.toUpperCase()}`,
    `Default use: ${doctor.default_use ? 'yes' : 'no'}`,
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
  process.exit(1);
});
