import * as path from 'node:path';
import { getBuildIdentity } from '../../../packages/analyzer-core/src/analyzer/core/build-identity';
import { checkMcpRegistration, type EnvironmentCheck } from './mcp-registration-doctor';
import { checkNodeVersionForUpdate, fetchReleaseManifest, isRunningAsSeaBinary, type ReleaseManifest } from './self-update';
import { loadStoredConnectorAuth, normalizeServerUrl } from './connector-auth';
import { REMOTE_ANALYSIS_PROTOCOL_VERSION } from './remote-analyzer-protocol';

























export const SESSION_TOKEN_TTL_DAYS = 14;



const TOKEN_EXPIRY_WARN_DAYS = 11;

export interface ClientDoctorReport {
  generated_at: string;
  status: 'pass' | 'warn' | 'fail';
  server_url: string;
  checks: EnvironmentCheck[];
}

function checkResult(id: string, status: EnvironmentCheck['status'], detail: string, fix?: string): EnvironmentCheck {
  return { id, status, detail, ...(fix ? { fix } : {}) };
}

export function evaluateAuthState(
  auth: ReturnType<typeof loadStoredConnectorAuth>,
  serverUrl: string,
  now: Date = new Date(),
): EnvironmentCheck {
  const account = auth.accounts[serverUrl];
  if (!account) {
    return checkResult(
      'auth-state', 'warn',
      `Not signed in to ${serverUrl}.`,
      'Run `klauro login --email you@example.com --register` (or `--register` omitted if you already have an account).',
    );
  }
  const updatedAt = new Date(account.updated_at);
  const ageDays = Number.isNaN(updatedAt.getTime())
    ? null
    : (now.getTime() - updatedAt.getTime()) / (24 * 60 * 60 * 1000);
  if (ageDays === null) {
    return checkResult('auth-state', 'warn', `Signed in to ${serverUrl}${account.email ? ` as ${account.email}` : ''}, but the stored session has no readable timestamp.`);
  }
  if (ageDays >= SESSION_TOKEN_TTL_DAYS) {
    return checkResult(
      'auth-state', 'fail',
      `Signed in to ${serverUrl}${account.email ? ` as ${account.email}` : ''}, but the session is ${ageDays.toFixed(1)} days old — server sessions expire at ${SESSION_TOKEN_TTL_DAYS} days, so this token has very likely expired.`,
      'Run `klauro login` to refresh the session.',
    );
  }
  if (ageDays >= TOKEN_EXPIRY_WARN_DAYS) {
    return checkResult(
      'auth-state', 'warn',
      `Signed in to ${serverUrl}${account.email ? ` as ${account.email}` : ''}; session is ${ageDays.toFixed(1)} days old and will expire around day ${SESSION_TOKEN_TTL_DAYS}.`,
      'Run `klauro login` soon to avoid an expired-session interruption.',
    );
  }
  return checkResult('auth-state', 'pass', `Signed in to ${serverUrl}${account.email ? ` as ${account.email}` : ''}; session is ${ageDays.toFixed(1)} days old.`);
}

interface HealthResponse {
  status?: string;
  service?: string;
  version?: string;
  required_protocol_version?: number;
  build?: { git_sha?: string; channel?: string };
}

export async function checkServerHealth(serverUrl: string, fetchImpl: typeof fetch = fetch): Promise<EnvironmentCheck> {
  let response: Response;
  try {
    response = await fetchImpl(`${serverUrl}/health`, { signal: AbortSignal.timeout(8000) });
  } catch (error) {
    return checkResult(
      'server-reachability', 'fail',
      `Could not reach ${serverUrl}/health: ${error instanceof Error ? error.message : String(error)}`,
      'Check your network connection and --server-url / KLAURO_URL. If the URL is correct, the service may be down.',
    );
  }
  if (!response.ok) {
    return checkResult('server-reachability', 'fail', `${serverUrl}/health responded with HTTP ${response.status}.`, 'Retry shortly; if it persists this is a service-side problem, not something to fix locally.');
  }
  const body = await response.json().catch(() => ({})) as HealthResponse;
  const reachDetail = `Reachable: ${serverUrl} (${body.service || 'klauro-api'} ${body.version || 'unknown version'}${body.build?.git_sha ? `, ${body.build.git_sha}` : ''}).`;
  if (typeof body.required_protocol_version !== 'number') {


    return checkResult('server-reachability', 'pass', `${reachDetail} Server does not report a protocol version on /health (older build); protocol match unconfirmed.`);
  }
  if (body.required_protocol_version !== REMOTE_ANALYSIS_PROTOCOL_VERSION) {
    return checkResult(
      'server-reachability', 'fail',
      `${reachDetail} Protocol mismatch: this CLI speaks analysis protocol ${REMOTE_ANALYSIS_PROTOCOL_VERSION}, the server requires ${body.required_protocol_version}.`,
      'Run `klauro update` and restart the MCP client.',
    );
  }
  return checkResult('server-reachability', 'pass', `${reachDetail} Protocol ${REMOTE_ANALYSIS_PROTOCOL_VERSION} matches the server.`);
}

export function evaluateCliVersion(current: string, manifest: ReleaseManifest | null): EnvironmentCheck {
  if (!manifest?.version) {
    return checkResult('cli-version', 'warn', `Running ${current}; could not fetch the published latest version to compare against.`);
  }
  if (manifest.version === current) {
    return checkResult('cli-version', 'pass', `Running ${current}, which is the latest published version.`);
  }
  return checkResult(
    'cli-version', 'warn',
    `Running ${current}; ${manifest.version} is available.`,
    'Run `klauro update`.',
  );
}

export function evaluateNodeVersionForClient(nodeVersion: string, _manifest: ReleaseManifest | null): EnvironmentCheck {



  if (isRunningAsSeaBinary()) {
    return checkResult('node-version', 'pass', `Running the self-contained klauro binary (embedded Node ${nodeVersion}); no machine Node install required.`);
  }
  const major = Number.parseInt(nodeVersion.replace(/^v/, '').split('.')[0], 10);
  const result = checkNodeVersionForUpdate(major);
  if (result.ok) {
    return checkResult('node-version', 'pass', `Node ${nodeVersion} (minimum: ${result.min}). No upper bound — the installed client has no native dependencies to compile.`);
  }
  return checkResult('node-version', 'warn', result.message || `Node ${nodeVersion} is below the declared minimum (${result.min}), unverified.`);
}

export async function runClientDoctor(options: {
  serverUrl?: string;
  projectPath?: string;
  packageRoot?: string;
  probeMcpBoot?: boolean;
  fetchImpl?: typeof fetch;
} = {}): Promise<ClientDoctorReport> {
  const auth = loadStoredConnectorAuth();
  const serverUrl = normalizeServerUrl(options.serverUrl || auth.defaultServerUrl);
  const identity = getBuildIdentity();
  const packageRoot = options.packageRoot ?? path.resolve(__dirname, '..');

  const [health, manifest] = await Promise.all([
    checkServerHealth(serverUrl, options.fetchImpl),
    fetchReleaseManifest(serverUrl),
  ]);

  const checks: EnvironmentCheck[] = [
    checkResult('build-identity', 'pass', `klauro ${identity.version} (${identity.channel})`),
    evaluateNodeVersionForClient(process.version, manifest),
    evaluateAuthState(auth, serverUrl),
    health,
    evaluateCliVersion(identity.base_version, manifest),
    await checkMcpRegistration({
      packageRoot,
      projectPath: options.projectPath,
      probeBoot: options.probeMcpBoot ?? true,
    }),
  ];

  const status: ClientDoctorReport['status'] = checks.some(c => c.status === 'fail')
    ? 'fail'
    : checks.some(c => c.status === 'warn') ? 'warn' : 'pass';

  return { generated_at: new Date().toISOString(), status, server_url: serverUrl, checks };
}

export function formatClientDoctor(report: ClientDoctorReport): string {
  return [
    `Klauro doctor: ${report.status.toUpperCase()}`,
    `Server: ${report.server_url}`,
    '',
    ...report.checks.map(check => {
      const marker = check.status === 'pass' ? 'OK  ' : check.status === 'warn' ? 'WARN' : 'FAIL';
      return [`[${marker}] ${check.id}: ${check.detail}`, check.fix ? `        fix: ${check.fix}` : undefined].filter(Boolean).join('\n');
    }),
  ].join('\n');
}
