import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs-extra';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { CAS_VERSION } from '../../../packages/analyzer-core/src/types/cas.types';
import {
  getAnalysisLogDir,
  getAnalysisRunLogPath,
} from '../../../packages/analyzer-core/src/analyzer/core/run-log';
import { getAnalysisEntry, loadAnalysis, MINIMUM_COMPATIBLE_CAS_VERSION } from './storage';
import { getBuildIdentity } from '../../../packages/analyzer-core/src/analyzer/core/build-identity';
import { partitionAnalysisDiagnostics } from '../../../packages/analyzer-core/src/analyzer/core/analysis-diagnostics';

const execFileAsync = promisify(execFile);

const SECRET_ENV_NAME_PATTERN = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

const PRIVACY_EXCLUSIONS = [
  'Source code text and node.source.raw snippets',
  'CAS graph nodes, edges, entry points, and exit points',
  'File contents from the analyzed project',
  'AI prompt contents and AI response text',
  'API keys, tokens, and other secret environment variable values (names only, values redacted)',
  'Embedding vectors and embedding documents',
  'Git history, commit messages, and author names',
];

export interface SupportBundleFile {
  file: string;
  description: string;
}

export interface SupportBundleResult {
  bundle_path: string;
  included: SupportBundleFile[];
  excluded: string[];
  warnings: string[];
}

export interface SupportBundleOptions {
  projectPath?: string;
  outputPath?: string;
}

interface EnvironmentSnapshot {
  generated_at: string;
  klauro_version: string;
  klauro_git_sha: string;
  klauro_build_time?: string;
  klauro_build_channel: 'bundle' | 'dev';
  cas_version: string;
  minimum_compatible_cas_version: string;
  node_version: string;
  platform: string;
  arch: string;
  os_release: string;
  cpu_count: number;
  total_memory_mb: number;
  storage_path: string;
  log_dir: string;
  run_log_path: string;
  env: Record<string, string>;
}

function snapshotEnvironment(): EnvironmentSnapshot {
  const env: Record<string, string> = {};
  const interestingNames = Object.keys(process.env)
    .filter(name => name.startsWith('KLAURO_'))
    .sort();
  for (const name of interestingNames) {
    env[name] = SECRET_ENV_NAME_PATTERN.test(name) ? '[set]' : String(process.env[name]);
  }
  for (const providerKey of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) {
    env[providerKey] = process.env[providerKey] ? '[set]' : '[unset]';
  }

  const build = getBuildIdentity();
  return {
    generated_at: new Date().toISOString(),
    klauro_version: build.version,
    klauro_git_sha: build.git_sha,
    klauro_build_time: build.build_time,
    klauro_build_channel: build.channel,
    cas_version: CAS_VERSION,
    minimum_compatible_cas_version: MINIMUM_COMPATIBLE_CAS_VERSION,
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
    os_release: os.release(),
    cpu_count: os.cpus().length,
    total_memory_mb: Math.round(os.totalmem() / (1024 * 1024)),
    storage_path: process.env.KLAURO_STORAGE_PATH || path.join(os.homedir(), '.klauro', 'analyses'),
    log_dir: getAnalysisLogDir(),
    run_log_path: getAnalysisRunLogPath(),
    env,
  };
}

function buildAnalysisMetadata(projectPath: string, cas: CASOutput): Record<string, unknown> {
  const diagnostics = partitionAnalysisDiagnostics(cas.analysis_errors);
  return {
    project_path: projectPath,
    analysis_id: cas.analysis_id,
    cas_version: cas.cas_version,
    analysis_timestamp: cas.analysis_timestamp,
    system: cas.system ? {
      id: cas.system.id,
      name: cas.system.name,
      type: cas.system.type,
      root_path: cas.system.root_path,
      technologies: cas.system.technologies,
      quality: cas.system.quality,
    } : undefined,
    counts: {
      nodes: cas.nodes?.length || 0,
      edges: cas.edges?.length || 0,
      entry_points: cas.entry_points?.length || 0,
      exit_points: cas.exit_points?.length || 0,
      external_services: cas.external_services?.length || 0,
      test_suites: cas.test_suites?.length || 0,
      call_chains: cas.call_chains?.length || 0,
      entryPointFlows: cas.flows?.length || 0,
      analysis_errors: diagnostics.errors.length,
      analysis_warnings: diagnostics.warnings.length,
      analysis_information: diagnostics.information.length,
    },
    analysis_phases: cas.analysis_phases,
    analyzer_contributions: cas.analyzer_contributions,
    analysis_errors: cas.analysis_errors,
    validation: cas.validation,
  };
}

export async function buildSupportBundle(options: SupportBundleOptions = {}): Promise<SupportBundleResult> {
  const included: SupportBundleFile[] = [];
  const warnings: string[] = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const stagingDir = path.join(os.tmpdir(), `klauro-support-${stamp}-${process.pid}`);
  const stagingRoot = path.join(stagingDir, 'klauro-support-bundle');
  await fs.ensureDir(stagingRoot);

  try {
    const environment = snapshotEnvironment();
    await fs.writeJson(path.join(stagingRoot, 'environment.json'), environment, { spaces: 2 });
    included.push({ file: 'environment.json', description: 'Klauro/CAS versions, Node and OS details, redacted Klauro environment flags' });

    const runLogPath = getAnalysisRunLogPath();
    if (await fs.pathExists(runLogPath)) {
      await fs.copy(runLogPath, path.join(stagingRoot, 'analysis-runs.jsonl'));
      included.push({ file: 'analysis-runs.jsonl', description: 'Recent analysis run logs: per-phase durations, analyzer contributions, AI call outcomes, warnings' });
    } else {
      warnings.push(`No analysis run log found at ${runLogPath}; run an analysis first to capture run diagnostics.`);
    }

    if (options.projectPath) {
      const projectPath = path.resolve(options.projectPath);
      const entry = await getAnalysisEntry(projectPath);
      const cas = await loadAnalysis(projectPath);
      if (entry) {
        await fs.writeJson(path.join(stagingRoot, 'analysis-index-entry.json'), entry, { spaces: 2 });
        included.push({ file: 'analysis-index-entry.json', description: 'Stored analysis index entry: name, timestamps, node/edge counts, CAS version' });
      }
      if (cas) {
        await fs.writeJson(path.join(stagingRoot, 'analysis-metadata.json'), buildAnalysisMetadata(projectPath, cas), { spaces: 2 });
        included.push({ file: 'analysis-metadata.json', description: 'Analysis metadata: versions, counts, phases, analyzer contributions, analysis_errors (no node source text)' });
      } else {
        warnings.push(`No stored analysis found for ${projectPath}; analysis metadata not included.`);
      }
    } else {
      warnings.push('No project path given; bundle contains environment and run logs only.');
    }

    const toolCallLogPath = process.env.KLAURO_TOOL_CALL_LOG;
    if (toolCallLogPath && await fs.pathExists(toolCallLogPath)) {
      await fs.copy(toolCallLogPath, path.join(stagingRoot, 'mcp-tool-calls.jsonl'));
      included.push({ file: 'mcp-tool-calls.jsonl', description: 'MCP tool-call log: tool names and timestamps only' });
    }

    await fs.writeJson(path.join(stagingRoot, 'manifest.json'), {
      generated_at: environment.generated_at,
      included,
      deliberately_excluded: PRIVACY_EXCLUSIONS,
      warnings,
    }, { spaces: 2 });
    included.push({ file: 'manifest.json', description: 'Bundle manifest: what is included and what is deliberately excluded' });

    const bundlePath = options.outputPath
      ? path.resolve(options.outputPath)
      : path.resolve(process.cwd(), `klauro-support-bundle-${stamp}.tar.gz`);
    await fs.ensureDir(path.dirname(bundlePath));
    await execFileAsync('tar', ['-czf', bundlePath, '-C', stagingDir, 'klauro-support-bundle']);

    return {
      bundle_path: bundlePath,
      included,
      excluded: PRIVACY_EXCLUSIONS,
      warnings,
    };
  } finally {
    await fs.remove(stagingDir).catch(() => undefined);
  }
}

export function formatSupportBundleResult(result: SupportBundleResult): string {
  return [
    'Klauro support bundle created',
    `Bundle: ${result.bundle_path}`,
    '',
    'Included:',
    ...result.included.map(item => `- ${item.file}: ${item.description}`),
    '',
    'Deliberately excluded (privacy):',
    ...result.excluded.map(item => `- ${item}`),
    ...(result.warnings.length ? ['', 'Warnings:', ...result.warnings.map(warning => `- ${warning}`)] : []),
    '',
    'Send this bundle to support. It contains no source code.',
    '',
  ].join('\n');
}
