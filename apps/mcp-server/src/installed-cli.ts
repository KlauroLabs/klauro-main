import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { analyzeCodebaseRemotely, syncWorkingTreeRemotely } from './remote-sync-client';
import { buildUploadManifest } from './remote-source';
import { clearStoredConnectorSession, connectorToken, loadStoredConnectorAuth, normalizeServerUrl, saveStoredConnectorSession } from './connector-auth';
import { writeDefaultKlauroConfig } from './klauro-config';
import { formatBuildIdentity, resolveManifestProjectName } from './installed-client-runtime';

function value(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const command = process.argv[2] || 'help';
  const target = path.resolve(process.argv[3] && !process.argv[3].startsWith('-') ? process.argv[3] : '.');
  const json = process.argv.includes('--json');
  if (command === 'version' || command === '--version' || command === '-v') return output({ version: formatBuildIdentity() }, json);
  if (command === 'analyze' || command === 'remote-analyze') return output(await analyzeCodebaseRemotely({ projectPath: target }), json);
  if (command === 'remote-sync' || command === 'sync') return output(await syncWorkingTreeRemotely({ projectPath: target }), json);
  if (command === 'upload-manifest' || command === 'index') return output(await buildUploadManifest(target, process.argv.includes('--dirty-tree') ? 'dirty-tree' : 'full'), json);
  if (command === 'init') {
    const serverUrl = normalizeServerUrl(value('--server-url'));
    let projectId = value('--project-id');
    let workspaceId = value('--organization-id');
    let projectName: string | undefined;
    const token = connectorToken(undefined, serverUrl);
    if (token && !projectId) {
      const placement = await ensureHostedPlacement(target, serverUrl, token, value('--workspace'));
      projectId = placement.project.id;
      workspaceId = placement.workspace.id;
      projectName = placement.project.name;
    }
    const config = await writeDefaultKlauroConfig(target, {
      serverUrl,
      projectId,
      workspaceId,
      organizationId: workspaceId,
      projectName,
      kind: 'project',
      force: process.argv.includes('--force'),
    });
    return output({ status: 'ready', path: target, config_file: config.configPath, project_id: projectId, workspace_id: workspaceId, next: `klauro analyze ${target}` }, json);
  }
  if (command === 'install') {
    const bundle = path.join(__dirname, 'index.cjs');
    const scope = value('--claude-scope') || 'user';
    const results: Record<string, unknown> = {};
    const claude = spawnSync('claude', ['mcp', 'add', '--scope', scope, 'klauro', '--', process.execPath, bundle], { encoding: 'utf8' });
    results.claude = claude.error?.message || claude.stderr?.trim() || claude.stdout?.trim() || `exit ${claude.status}`;
    const codex = spawnSync('codex', ['mcp', 'add', 'klauro', '--', process.execPath, bundle], { encoding: 'utf8' });
    results.codex = codex.error?.message || codex.stderr?.trim() || codex.stdout?.trim() || `exit ${codex.status}`;
    return output({ status: claude.status === 0 || codex.status === 0 ? 'installed' : 'manual-registration-required', bundle, results }, json);
  }
  if (command === 'auth-status' || command === 'whoami') {
    const auth = loadStoredConnectorAuth();
    const serverUrl = normalizeServerUrl(auth.defaultServerUrl);
    return output({ server_url: serverUrl, signed_in: Boolean(auth.accounts[serverUrl]), email: auth.accounts[serverUrl]?.email || null }, json);
  }
  if (command === 'logout') return output(clearStoredConnectorSession(value('--server-url')), json);
  if (command === 'login') {
    const email = value('--email');
    const password = value('--password') || (process.argv.includes('--password-stdin') ? (await readStdin()).trim() : undefined);
    if (!email || !password) throw new Error('login requires --email and --password or --password-stdin');
    const serverUrl = normalizeServerUrl(value('--server-url'));
    const route = process.argv.includes('--register') ? '/api/auth/register' : '/api/auth/login';
    const response = await fetch(`${serverUrl}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const payload = await response.json().catch(() => ({})) as any;
    if (!response.ok) throw new Error(payload.error || `Login failed with HTTP ${response.status}`);
    const token = payload.token || payload.access_token || payload.accessToken;
    if (!token) throw new Error('Login response did not include an access token');
    return output({ status: 'signed-in', ...saveStoredConnectorSession({ serverUrl, token, email }) }, json);
  }
  process.stdout.write([
    'Usage: klauro <command> [path] [options]', '',
    '  init [path]                 Configure a project for hosted Klauro analysis',
    '  install                     Register the lightweight MCP with Claude and Codex',
    '  analyze [path]              Upload a committed source snapshot for hosted analysis',
    '  remote-sync [path]          Upload in-flight changes for hosted analysis',
    '  upload-manifest [path]      Preview source files selected for upload',
    '  login --email EMAIL --password-stdin [--register]',
    '  auth-status | whoami | logout | version', '',
    'Analysis, CAS/WAS construction, graphs, proposals, embeddings, and AI execute only on Klauro infrastructure.',
  ].join('\n') + '\n');
}

interface HostedChoice { id: string; name: string; repo_url?: string; local_path?: string }

async function ensureHostedPlacement(projectPath: string, serverUrl: string, token: string, requestedWorkspace?: string): Promise<{ workspace: HostedChoice; project: HostedChoice }> {
  const manifest = await buildUploadManifest(projectPath);
  const projectName = resolveManifestProjectName(projectPath, path.basename(projectPath));
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const request = async <T>(route: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${serverUrl}${route}`, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const payload = await response.json().catch(() => ({})) as any;
    if (!response.ok) throw new Error(payload.error || `Klauro account API failed with HTTP ${response.status}`);
    return payload as T;
  };
  const listed = await request<{ workspaces?: HostedChoice[] }>('/api/workspaces');
  const workspaceName = requestedWorkspace?.trim() || projectName;
  let workspace = (listed.workspaces || []).find(item => item.id === requestedWorkspace || item.name === workspaceName);
  if (!workspace) workspace = (await request<{ workspace: HostedChoice }>('/api/workspaces', { name: workspaceName })).workspace;
  const projects = await request<{ projects?: HostedChoice[] }>(`/api/workspaces/${encodeURIComponent(workspace.id)}/projects`);
  const remoteUrl = manifest.remote_provider?.repository_url;
  let project = (projects.projects || []).find(item => item.local_path === projectPath || (remoteUrl && item.repo_url === remoteUrl));
  if (!project) project = (await request<{ project: HostedChoice }>(`/api/workspaces/${encodeURIComponent(workspace.id)}/projects`, { name: projectName, local_path: projectPath, ...(remoteUrl ? { repo_url: remoteUrl } : {}) })).project;
  return { workspace, project };
}

function output(value: unknown, json: boolean) {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : error}\n`); process.exit(1); });
