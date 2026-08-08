import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { analyzeCodebaseRemotely, syncWorkingTreeRemotely } from './remote-sync-client';
import { buildUploadManifest } from './remote-source';
import { clearStoredConnectorSession, connectorToken, loadStoredConnectorAuth, normalizeServerUrl, resolveAuthStatus, saveStoredConnectorSession, warnIfSessionExpiringSoon } from './connector-auth';
import { writeDefaultKlauroConfig } from './klauro-config';
import { formatBuildIdentity, resolveManifestProjectName } from './installed-client-runtime';
import { KLAURO_INSTALL_ONELINER, SELF_UPDATE_COMMANDS, runSelfUpdate } from './self-update';
import { renderStatusReport } from './status-report';
import { formatClientDoctor, runClientDoctor } from './client-doctor';
import { buildSupportBundle, formatSupportBundleResult } from './support-bundle';
import { promptLine, promptPassword, readAllStdin } from './password-prompt';

function value(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const command = process.argv[2] || 'help';
  const target = path.resolve(process.argv[3] && !process.argv[3].startsWith('-') ? process.argv[3] : '.');
  const json = process.argv.includes('--json');
  if (command === 'version' || command === '--version' || command === '-v') return output({ version: formatBuildIdentity() }, json);
  // Self-update. This MUST exist in the shipped CLI: the hosted server's
  // protocol-mismatch remediation (HTTP 426, remote-analyzer-service.ts) tells
  // customers to run it, and through 1.0.127 it fell through to the usage text
  // below and exited 0 — bricking every installed client behind an instruction
  // that did nothing. See self-update.ts.
  if ((SELF_UPDATE_COMMANDS as readonly string[]).includes(command)) {
    const auth = loadStoredConnectorAuth();
    const serverUrl = normalizeServerUrl(value('--server-url') || auth.defaultServerUrl || process.env.KLAURO_URL);
    await runSelfUpdate({
      serverUrl,
      checkOnly: process.argv.includes('--check'),
      force: process.argv.includes('--force'),
      json,
    });
    return;
  }
  if (command === 'analyze' || command === 'remote-analyze') return output(await analyzeCodebaseRemotely({ projectPath: target }), json);
  if (command === 'remote-sync' || command === 'sync') return output(await syncWorkingTreeRemotely({ projectPath: target }), json);
  if (command === 'upload-manifest' || command === 'index') return output(await buildUploadManifest(target, process.argv.includes('--dirty-tree') ? 'dirty-tree' : 'full'), json);
  // status/doctor/support-bundle: the same class of dead end `update` was
  // (see the comment above SELF_UPDATE_COMMANDS) — the product's own text
  // tells customers to run all three (server error remediations, `klauro
  // init`'s "check any time with `klauro status`", the 401 remediation's
  // "if it recurs, run `klauro support-bundle`"), and none of them were ever
  // registered in this file, so each fell through to the usage block and
  // exited 0. All three share their logic with cli.ts via status-report.ts /
  // client-doctor.ts / support-bundle.ts — see installed-cli-ops-commands.test.ts.
  if (command === 'status') {
    // fabricCliAvailable: false — `klauro fabric` is a cli.ts-only developer
    // command, never registered below; see status-report.ts's
    // buildConnectionReport comment for why this must be threaded through
    // rather than left at the (cli.ts-appropriate) default.
    const { report, lines } = await renderStatusReport({ repoPath: target, serverUrl: value('--server-url'), fabricCliAvailable: false });
    return output(json ? report : lines.join('\n'), json);
  }
  if (command === 'doctor') {
    // Always the lightweight customer environment/connection check — never
    // the local-CAS-backed "agent doctor" cli.ts's `doctor <path>` also
    // answers, which requires a local analysis this client never performs
    // ("Analysis... execute only on Klauro infrastructure").
    const report = await runClientDoctor({ projectPath: target, serverUrl: value('--server-url') });
    if (json) { process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); } else { process.stdout.write(`${formatClientDoctor(report)}\n`); }
    process.exitCode = report.status === 'fail' ? 1 : 0;
    return;
  }
  if (command === 'support-bundle') {
    const result = await buildSupportBundle({
      projectPath: process.argv[3] && !process.argv[3].startsWith('-') ? target : undefined,
      outputPath: value('--output'),
    });
    return output(json ? result : formatSupportBundleResult(result), json);
  }
  if (command === 'init') {
    const serverUrl = normalizeServerUrl(value('--server-url'));
    let projectId = value('--project-id');
    let workspaceId = value('--organization-id');
    let projectName: string | undefined;
    const token = connectorToken(undefined, serverUrl);
    // Warn BEFORE the placement calls below if the token is close to (or
    // past) the server's TTL — init is the very first authenticated command
    // most sessions run, so this is the earliest point to catch a session
    // that's about to strand the rest of the first-session flow.
    if (token) warnIfSessionExpiringSoon(serverUrl, loadStoredConnectorAuth().accounts[serverUrl]);
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
    // Round-trips to GET /api/me instead of only checking that a token FILE
    // exists — see resolveAuthStatus's doc comment in connector-auth.ts. The
    // old version here answered "signed_in: true" purely from
    // ~/.klauro/auth.json's presence, which is exactly the lie that let a
    // dead (server-rejected) session report as healthy.
    const status = await resolveAuthStatus({ serverUrl: value('--server-url') });
    return output(json
      ? { ...status, signed_in: status.state === 'signed-in', email: status.email ?? null }
      : status.detail,
      json);
  }
  if (command === 'logout') return output(clearStoredConnectorSession(value('--server-url')), json);
  if (command === 'login') {
    const serverUrl = normalizeServerUrl(value('--server-url'));
    // Credentials must travel over HTTPS only — never send a password in the clear.
    if (!/^https:\/\//i.test(serverUrl) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(serverUrl)) {
      throw new Error(`Refusing to send credentials over a non-HTTPS server URL: ${serverUrl}`);
    }
    const email = value('--email') || await promptLine('Email: ');
    // Password read, in priority order — see password-prompt.ts:
    //  1. --password-stdin  (scriptable; read the piped/redirected stdin stream)
    //  2. --password VALUE  (legacy; DEPRECATED — visible in shell history and
    //     to other processes on this machine via `ps`; kept working for
    //     existing scripted/CI callers, but flagged on every use)
    //  3. interactive no-echo TTY prompt (characters are never echoed)
    // This is the actual fix for the dead end this command used to hit with
    // no arguments ("login requires --email and --password or
    // --password-stdin") — it now prompts instead of demanding flags.
    const legacyPassword = value('--password');
    const passwordStdin = process.argv.includes('--password-stdin');
    if (legacyPassword && !passwordStdin) {
      process.stderr.write(
        'Warning: --password on the command line is visible in your shell history and to other processes on this machine (via `ps`). Prefer the interactive prompt (omit --password) or --password-stdin for scripts.\n',
      );
    }
    const password = passwordStdin ? await readAllStdin() : (legacyPassword || await promptPassword('Password: '));
    if (!email) throw new Error('login requires --email or an entered email');
    if (!password) throw new Error('login requires --password, --password-stdin, or an entered password');
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
    '  status [path] [--server-url URL]',
    '                               One-glance report: account, release, project connection, analysis, MCP',
    '  doctor [path] [--server-url URL]',
    '                               Diagnose node version, auth/token age, server reachability, MCP registration',
    '  support-bundle [path] [--output FILE]',
    '                               Package redacted environment + run-log diagnostics to send to support',
    '  update [--check] [--force]  Install the latest hosted klauro release over this one',
    '  login [--email EMAIL] [--password-stdin | --register]',
    '                               Prompts for email/password (no echo) if not given; --password-stdin for scripts',
    '  auth-status | whoami | logout | version', '',
    `If \`klauro update\` cannot run, reinstall from scratch: ${KLAURO_INSTALL_ONELINER}`, '',
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

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : error}\n`); process.exit(1); });
