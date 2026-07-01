import * as path from 'path';
import { pathToFileURL } from 'url';
import { formatBuildIdentity } from '../../../packages/analyzer-core/src/analyzer/core/build-identity';
import {
  MINIMUM_ANALYSIS_HEAP_MB,
  describeAnalysisHeap,
  resolveAnalysisHeapMb,
} from './analysis-heap';
import {
  MINIMUM_COMPATIBLE_CAS_VERSION,
  describeAnalysisVersion,
  listAnalyses,
  type AnalysisEntry,
  type AnalysisVersionInfo,
} from './storage';

type ChecksModule = typeof import('../scripts/environment-checks.mjs');
type EnvironmentCheck = import('../scripts/environment-checks.mjs').EnvironmentCheck;

let checksModulePromise: Promise<ChecksModule> | undefined;

function loadChecks(): Promise<ChecksModule> {
  if (!checksModulePromise) {
    const modulePath = path.join(__dirname, '..', 'scripts', 'environment-checks.mjs');
    checksModulePromise = import(pathToFileURL(modulePath).href) as Promise<ChecksModule>;
  }
  return checksModulePromise;
}

export interface EnvironmentDoctorReport {
  generated_at: string;
  status: 'pass' | 'warn' | 'fail';
  server_package: string;
  bundle_path: string;
  checks: EnvironmentCheck[];
}

export function summarizeAnalysisVersions(
  entries: Array<Pick<AnalysisEntry, 'path' | 'cas_version'>>,
  describe: (storedVersion: string | undefined) => AnalysisVersionInfo = describeAnalysisVersion,
): EnvironmentCheck {
  if (entries.length === 0) {
    return {
      id: 'analysis-versions',
      status: 'pass',
      detail: `No stored analyses yet (version floor: ${MINIMUM_COMPATIBLE_CAS_VERSION}). Run klauro analyze on a repository to create one.`,
    };
  }
  const recorded = entries.filter(entry => entry.cas_version);
  const unrecorded = entries.length - recorded.length;
  const blocked = recorded
    .map(entry => ({ entry, info: describe(entry.cas_version) }))
    .filter(item => item.info.status === 'unsupported' || item.info.status === 'newer-major');
  if (blocked.length > 0) {
    const examples = blocked.slice(0, 5)
      .map(item => `${item.entry.path} (cas_version ${item.info.stored_version}, ${item.info.status})`)
      .join('; ');
    return {
      id: 'analysis-versions',
      status: 'fail',
      detail: `${blocked.length} of ${entries.length} stored analysis(es) are outside the supported range (floor ${MINIMUM_COMPATIBLE_CAS_VERSION}): ${examples}`,
      fix: 'Re-run klauro analyze on each listed path with this server to regenerate the analysis (newer-major entries need a server upgrade instead).',
    };
  }
  if (unrecorded > 0) {
    return {
      id: 'analysis-versions',
      status: 'warn',
      detail: `${recorded.length} of ${entries.length} stored analysis(es) record a cas_version at or above the ${MINIMUM_COMPATIBLE_CAS_VERSION} floor; ${unrecorded} predate version tracking in the index and are version-gated when loaded.`,
      fix: 'Re-run klauro analyze on paths you still use to record their version; unsupported ones fail loudly at load with the same fix.',
    };
  }
  return {
    id: 'analysis-versions',
    status: 'pass',
    detail: `${entries.length} stored analysis(es), all at or above the ${MINIMUM_COMPATIBLE_CAS_VERSION} compatibility floor.`,
  };
}

export async function runEnvironmentDoctor(options: {
  handshakeLimitMs?: number;
  skipHandshake?: boolean;
} = {}): Promise<EnvironmentDoctorReport> {
  const checks = await loadChecks();
  const packageRoot = path.resolve(__dirname, '..');
  const bundlePath = path.join(packageRoot, 'dist', 'index.cjs');
  const results: EnvironmentCheck[] = [];

  results.push(checks.checkResult('build-identity', 'pass', `klauro ${formatBuildIdentity()}`));
  results.push(checks.evaluateNodeVersion(process.version));

  const bundleCheck = checks.inspectBundle({
    packageRoot,
    sourceDirs: [
      path.join(packageRoot, 'src'),
      path.resolve(packageRoot, '..', '..', 'packages', 'analyzer-core', 'src'),
    ],
  });
  results.push(bundleCheck);
  results.push(...checks.inspectProductFootprint({ packageRoot, env: process.env }));

  if (options.skipHandshake) {
    results.push(checks.checkResult('handshake-latency', 'warn', 'Handshake probe skipped.', 'Run klauro doctor without --skip-handshake.'));
  } else if (bundleCheck.status === 'fail') {
    results.push(checks.checkResult('handshake-latency', 'fail', 'Cannot probe handshake: bundle is missing.', `Run: npm --prefix ${packageRoot} run build`));
  } else {
    const limit = options.handshakeLimitMs ?? Number(process.env.KLAURO_SMOKE_MAX_STARTUP_MS || checks.DEFAULT_HANDSHAKE_LIMIT_MS);
    const probe = await checks.probeHandshake({ bundlePath, profile: 'core', maxMs: limit });
    results.push(checks.checkResult(
      'handshake-latency',
      probe.ok ? 'pass' : 'fail',
      probe.detail,
      probe.ok ? undefined : `Rebuild the bundle (npm --prefix ${packageRoot} run build) and check that node ${bundlePath} starts cleanly.`,
    ));
  }

  results.push(checks.inspectStorage(process.env));

  const heap = resolveAnalysisHeapMb();
  results.push(checks.checkResult(
    'analysis-heap',
    heap.envInvalid ? 'warn' : 'pass',
    describeAnalysisHeap(heap),
    heap.envInvalid
      ? `Set KLAURO_ANALYSIS_HEAP_MB to a number of megabytes >= ${MINIMUM_ANALYSIS_HEAP_MB}, or unset it to use the default.`
      : undefined,
  ));

  const configured = checks.summarizeAiProviders(process.env);
  results.push(checks.evaluateAiProviders({ configured }));

  const analysesDir = checks.storageAnalysesDir(process.env);
  results.push(checks.evaluateZstd({
    zstdAvailable: checks.hasZstdBinary(),
    compressedFiles: checks.countZstdAnalysisFiles(analysesDir),
  }));

  let entries: AnalysisEntry[] = [];
  try {
    entries = await listAnalyses();
  } catch {
    entries = [];
  }
  results.push(summarizeAnalysisVersions(entries));

  results.push(checks.evaluateWatches(checks.findKlauroProcesses()));

  const status: EnvironmentDoctorReport['status'] = results.some(item => item.status === 'fail')
    ? 'fail'
    : results.some(item => item.status === 'warn') ? 'warn' : 'pass';

  return {
    generated_at: new Date().toISOString(),
    status,
    server_package: packageRoot,
    bundle_path: bundlePath,
    checks: results,
  };
}

export async function formatEnvironmentDoctor(report: EnvironmentDoctorReport): Promise<string> {
  const checks = await loadChecks();
  return [
    `Klauro environment doctor: ${report.status.toUpperCase()}`,
    `Server package: ${report.server_package}`,
    '',
    ...report.checks.map(check => checks.formatCheck(check)),
    '',
    'For a per-repository analysis readiness report, run: klauro doctor /path/to/repo',
  ].join('\n');
}
