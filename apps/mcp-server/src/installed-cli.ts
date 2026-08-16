import * as os from 'node:os';
import * as path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { analyzeCodebaseRemotely, syncWorkingTreeRemotely } from './remote-sync-client';
import { formatRemoteResult, formatUploadManifest, withAnalysisState } from './remote-result-format';
import { buildUploadManifest } from './remote-source';
import { summarizeUploadManifest } from './upload-manifest-summary';
import { assessUploadScope, confirmUploadScope } from './upload-scope-guard';
import { clearStoredConnectorSession, connectorToken, listStoredAccounts, loadStoredConnectorAuth, normalizeServerUrl, resolveAuthStatus, saveStoredConnectorSession, switchStoredAccount, warnIfSessionExpiringSoon } from './connector-auth';
import { isUnboundHostedProjectId, loadKlauroConfig, writeDefaultKlauroConfig, writeProjectBindingIntoConfig } from './klauro-config';
import { formatBuildIdentity, getBuildIdentity, resolveManifestProjectName } from './installed-client-runtime';
import { KLAURO_INSTALL_ONELINER, SELF_UPDATE_COMMANDS, runSelfUpdate } from './self-update';
import { renderStatusReport } from './status-report';
import { formatClientDoctor, runClientDoctor } from './client-doctor';
import { buildSupportBundle, formatSupportBundleResult } from './support-bundle';
import { missingEmailMessage, missingPasswordMessage, promptLine, promptPassword, readAllStdin } from './password-prompt';
import { extractServerUrlFlag, getStaleClientUpdateHint } from './stale-client-hint';






import { AccountStore } from './account-store';
import { isAnalysisFocus, type AnalysisFocus } from './analysis-focus';

function value(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}


















export function resolveMcpRegistrationCommand(): string[] {
  let isSea = false;
  try {

    isSea = (require('node:sea') as { isSea(): boolean }).isSea();
  } catch {
    isSea = false;
  }
  if (isSea) return [process.execPath, '__mcp_server'];
  return [process.execPath, path.join(__dirname, 'index.cjs')];
}


















const HELP_FLAGS = new Set(['--help', '-h']);



const FLAGS_WITH_VALUES = new Set([
  '--server-url', '--project-id', '--organization-id', '--workspace', '--output',
  '--email', '--password', '--token', '--new-password', '--current-password',
  '--data-dir', '--minted-by', '--claude-scope', '--use',
  '--analysis-id', '--analysis-focus',
]);





const COMMAND_FLAGS: Record<string, Set<string>> = {
  ...Object.fromEntries(SELF_UPDATE_COMMANDS.map(name => [name, new Set(['--server-url', '--check', '--force', '--json'])])),
  version: new Set(['--json']),
  '--version': new Set(['--json']),
  '-v': new Set(['--json']),








  analyze: new Set(['--server-url', '--analysis-id', '--analysis-focus', '--json', '--quiet', '--force', '--yes', '--wait']),
  'remote-analyze': new Set(['--server-url', '--analysis-id', '--analysis-focus', '--json', '--quiet', '--force', '--yes', '--wait']),
  'remote-sync': new Set(['--server-url', '--analysis-id', '--json', '--quiet', '--yes', '--wait']),
  sync: new Set(['--server-url', '--analysis-id', '--json', '--quiet', '--yes', '--wait']),
  'upload-manifest': new Set(['--json', '--dirty-tree']),
  index: new Set(['--json', '--dirty-tree']),
  status: new Set(['--server-url', '--json']),
  doctor: new Set(['--server-url', '--json']),
  'support-bundle': new Set(['--output', '--json']),
  init: new Set(['--server-url', '--project-id', '--organization-id', '--workspace', '--force', '--json']),
  install: new Set(['--claude-scope', '--json']),
  uninstall: new Set(['--no-deregister', '--json']),
  'auth-status': new Set(['--server-url', '--json']),
  whoami: new Set(['--server-url', '--json']),
  logout: new Set(['--server-url', '--json']),
  login: new Set(['--server-url', '--email', '--password', '--password-stdin', '--register', '--json']),
  accounts: new Set(['--server-url', '--use', '--json']),
  'reset-password': new Set(['--server-url', '--token', '--token-stdin', '--new-password', '--new-password-stdin', '--json']),
  'change-password': new Set(['--server-url', '--current-password', '--current-password-stdin', '--new-password', '--new-password-stdin', '--json']),
  'admin-mint-reset-token': new Set(['--email', '--data-dir', '--minted-by', '--json']),
};







const PATH_COMMANDS = new Set([
  'analyze', 'remote-analyze', 'remote-sync', 'sync', 'upload-manifest', 'index',
  'init', 'status', 'doctor', 'support-bundle',
]);



function validateFlags(command: string, argv: string[]): void {
  const allowed = COMMAND_FLAGS[command];
  if (!allowed) return;
  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('-') || HELP_FLAGS.has(arg)) continue;
    if (!allowed.has(arg)) {
      throw new Error(`Unknown option for \`klauro ${command}\`: ${arg} (run \`klauro ${command} --help\` for supported flags)`);
    }
    if (FLAGS_WITH_VALUES.has(arg)) {
      const optionValue = argv[i + 1];
      if (!optionValue || optionValue.startsWith('-')) throw new Error(`Option ${arg} for \`klauro ${command}\` requires a value`);
      if (arg === '--analysis-focus' && !isAnalysisFocus(optionValue)) {
        throw new Error('--analysis-focus must be agent-fast, ui-overview, deep-context, or full');
      }
      i += 1;
    }
  }
}














function resolvePositionalArg(argv: string[]): string | undefined {
  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('-')) {
      if (FLAGS_WITH_VALUES.has(arg)) i += 1;
      continue;
    }
    return arg;
  }
  return undefined;
}





function validateTargetPath(command: string, rawArg: string | undefined, resolved: string): void {
  if (!PATH_COMMANDS.has(command)) return;
  if (!rawArg || rawArg.startsWith('-')) return;
  if (!existsSync(resolved)) throw new Error(`\`klauro ${command}\`: path does not exist: ${resolved}`);
  if (!statSync(resolved).isDirectory()) throw new Error(`\`klauro ${command}\`: path is not a directory: ${resolved}`);
}

const USAGE_TEXT = [
  'Usage: klauro <command> [path] [options]', '',
  '  init [path]                 Configure a project for hosted Klauro analysis',
  '  install                     Register the lightweight MCP with Claude and Codex',
  '  uninstall [--no-deregister] Remove Klauro MCP registrations; keep account and analysis data',
  '  analyze [path] [--server-url url] [--analysis-id id] [--analysis-focus agent-fast|ui-overview|deep-context|full] [--json] [--quiet] [--force] [--yes] [--wait]',
  '                               Upload a committed source snapshot for hosted analysis',
  '                               --force bypasses BOTH the server\'s reuse-of-unchanged-snapshot shortcut AND the',
  '                               AI response cache, so structure and AI-generated names/descriptions are freshly',
  '                               produced instead of served from a prior run.',
  '                               --yes confirms uploading a root that looks like it contains several unrelated',
  '                               projects instead of one (no Git repo/manifest of its own, multiple nested repos',
  '                               beneath it) — without it this refuses (scripted) or prompts (interactive).',
  '                               --wait blocks until the hosted analysis is complete and returns its CAS.',
  '                               Alias: remote-analyze',
  '  remote-sync [path] [--yes] [--wait]',
  '                               Upload in-flight changes; --wait returns the completed incremental CAS',
  '                               Alias: sync',
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
  '  auth-status | whoami | logout | version',
  '  accounts [--server-url URL] [--use EMAIL]',
  '                               List every account signed into this server on this machine, or switch the active one (no password needed if already logged in as EMAIL)',
  '  change-password [--current-password-stdin] [--new-password-stdin]',
  '                               Requires an existing session + current password; invalidates every other session',
  '  reset-password --token TOKEN [--token-stdin] [--new-password-stdin]',
  '                               Redeems a single-use token an operator minted with admin-mint-reset-token',
  '  admin-mint-reset-token --email EMAIL [--data-dir PATH] [--minted-by LABEL]',
  '                               OPERATOR-ONLY: mints a 30-minute single-use reset token directly against the account store',
  '',
  `If \`klauro update\` cannot run, reinstall from scratch: ${KLAURO_INSTALL_ONELINER}`, '',
  'Analysis, CAS construction at every level, graphs, proposals, embeddings, and AI execute only on Klauro infrastructure.',
  '',
  'Every subcommand accepts --help/-h to print this usage instead of running.',
].join('\n') + '\n';

function printUsage(): void {
  process.stdout.write(USAGE_TEXT);
}










async function resolveUploadScopeConfirmation(target: string): Promise<{ proceed: boolean; confirmScope: boolean }> {
  process.stderr.write(`Resolved project root: ${target}\n`);
  const yes = process.argv.includes('--yes');
  const assessment = await assessUploadScope(target);
  return confirmUploadScope(assessment, { yes });
}

async function main() {
  const command = process.argv[2] || 'help';




  if (HELP_FLAGS.has(command) || process.argv.slice(3).some(arg => HELP_FLAGS.has(arg))) {
    printUsage();
    return;
  }
  validateFlags(command, process.argv);
  const rawPathArg = resolvePositionalArg(process.argv);
  const target = path.resolve(rawPathArg ?? '.');
  validateTargetPath(command, rawPathArg, target);
  const json = process.argv.includes('--json');










  if (command === 'version' || command === '--version' || command === '-v') return output(json ? { version: formatBuildIdentity() } : formatBuildIdentity(), json);





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















  if (command === 'analyze' || command === 'remote-analyze') {
    const scope = await resolveUploadScopeConfirmation(target);
    if (!scope.proceed) { process.exitCode = 1; return; }
    const result = await analyzeCodebaseRemotely({
      projectPath: target,
      serverUrl: value('--server-url'),
      analysisId: value('--analysis-id'),
      analysisFocus: value('--analysis-focus') as AnalysisFocus | undefined,
      requireBoundProject: true,
      force: process.argv.includes('--force'),
      confirmScope: scope.confirmScope,
      wait: process.argv.includes('--wait'),
    });
    return output(json ? withAnalysisState(result) : formatRemoteResult(result), json);
  }
  if (command === 'remote-sync' || command === 'sync') {
    const scope = await resolveUploadScopeConfirmation(target);
    if (!scope.proceed) { process.exitCode = 1; return; }
    const result = await syncWorkingTreeRemotely({ projectPath: target, serverUrl: value('--server-url'), analysisId: value('--analysis-id'), requireBoundProject: true, confirmScope: scope.confirmScope, wait: process.argv.includes('--wait') });
    return output(json ? withAnalysisState(result) : formatRemoteResult(result), json);
  }
  if (command === 'upload-manifest' || command === 'index') {
    const manifest = await buildUploadManifest(target, process.argv.includes('--dirty-tree') ? 'dirty-tree' : 'full');
    return output(json ? summarizeUploadManifest(manifest) : formatUploadManifest(manifest), json);
  }








  if (command === 'status') {




    const { report, lines } = await renderStatusReport({ repoPath: target, serverUrl: value('--server-url'), fabricCliAvailable: false });
    return output(json ? report : lines.join('\n'), json);
  }
  if (command === 'doctor') {




    const report = await runClientDoctor({ projectPath: target, serverUrl: value('--server-url') });
    if (json) { process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); } else { process.stdout.write(`${formatClientDoctor(report)}\n`); }
    process.exitCode = report.status === 'fail' ? 1 : 0;
    return;
  }
  if (command === 'support-bundle') {
    const result = await buildSupportBundle({
      projectPath: rawPathArg ? target : undefined,
      outputPath: value('--output'),
    });
    return output(json ? result : formatSupportBundleResult(result), json);
  }
  if (command === 'init') {
    const existing = await loadKlauroConfig(target);
    const force = process.argv.includes('--force');
    const serverUrl = normalizeServerUrl(value('--server-url') || existing.config.analyzer.serverUrl);
    let projectId = value('--project-id');
    let workspaceId = value('--organization-id') || (!force ? existing.config.project.workspaceId : undefined);
    let projectName = !force ? existing.config.project.name : undefined;
    if (!projectId && !force) projectId = existing.config.project.id;
    const token = connectorToken(undefined, serverUrl);
    if (token) warnIfSessionExpiringSoon(serverUrl, loadStoredConnectorAuth().accounts[serverUrl]);
    const requestedWorkspace = value('--workspace');
    const hostedProject = token && projectId && !isUnboundHostedProjectId(projectId)
      ? await getHostedProject(serverUrl, token, projectId)
      : undefined;
    if (token && (!projectId || isUnboundHostedProjectId(projectId) || force || requestedWorkspace || !hostedProject)) {
      const placement = await ensureHostedPlacement(target, serverUrl, token, value('--workspace'));
      projectId = placement.project.id;
      workspaceId = placement.workspace.id;
      projectName = placement.project.name;
    } else if (hostedProject) {
      workspaceId = hostedProject.workspace_id;
      projectName = hostedProject.name;
    }
    let configPath: string;
    if (existing.configPath && !force) {
      const bindingChanged = Boolean(projectId && (
        projectId !== existing.config.project.id
        || workspaceId !== existing.config.project.workspaceId
        || projectName !== existing.config.project.name
      ));
      const serverChanged = serverUrl !== normalizeServerUrl(existing.config.analyzer.serverUrl);
      if (bindingChanged || serverChanged) {
        await writeProjectBindingIntoConfig(target, {
          projectId,
          workspaceId,
          organizationId: workspaceId,
          projectName,
          kind: 'project',
          serverUrl,
        });
      }
      configPath = existing.configPath;
    } else {
      configPath = (await writeDefaultKlauroConfig(target, {
        serverUrl,
        projectId,
        workspaceId,
        organizationId: workspaceId,
        projectName,
        kind: 'project',
        force,
      })).configPath;
    }
    const initResult = { status: 'ready' as const, path: target, config_file: configPath, project_id: projectId, workspace_id: workspaceId, idempotent: Boolean(existing.configPath && !force), next: `klauro analyze ${target}` };
    return output(json ? initResult : [
      `Ready: ${target}`,
      `${existing.configPath && !force ? 'Config verified at' : 'Config written to'} ${configPath}`,
      projectId ? `Bound to hosted project ${projectId}${workspaceId ? ` (workspace ${workspaceId})` : ''}.` : 'Not signed in — no hosted project was bound. Run `klauro login` then `klauro init` again to bind one, or `klauro analyze` will fail with a sign-in prompt.',
      `Next: klauro analyze ${target}`,
    ].join('\n'), json);
  }
  if (command === 'install') {
    const mcpCommand = resolveMcpRegistrationCommand();
    const scope = value('--claude-scope') || 'user';
    const results: Record<string, unknown> = {};









    spawnSync('claude', ['mcp', 'remove', '--scope', scope, 'klauro'], { encoding: 'utf8' });
    spawnSync('codex', ['mcp', 'remove', 'klauro'], { encoding: 'utf8' });
    const claude = spawnSync('claude', ['mcp', 'add', '--scope', scope, 'klauro', '--', ...mcpCommand], { encoding: 'utf8' });
    results.claude = claude.error?.message || claude.stderr?.trim() || claude.stdout?.trim() || `exit ${claude.status}`;
    const codex = spawnSync('codex', ['mcp', 'add', 'klauro', '--', ...mcpCommand], { encoding: 'utf8' });
    results.codex = codex.error?.message || codex.stderr?.trim() || codex.stdout?.trim() || `exit ${codex.status}`;
    const installStatus = claude.status === 0 || codex.status === 0 ? 'installed' as const : 'manual-registration-required' as const;
    return output(json ? { status: installStatus, command: mcpCommand.join(' '), results } : [
      installStatus === 'installed' ? 'Registered the Klauro MCP server.' : `Could not auto-register with either client — register manually: ${mcpCommand.join(' ')}`,
      `Claude Code: ${claude.status === 0 ? 'registered' : results.claude}`,
      `Codex: ${codex.status === 0 ? 'registered' : results.codex}`,
    ].join('\n'), json);
  }
  if (command === 'uninstall') {
    const deregister = !process.argv.includes('--no-deregister');
    const removals = deregister ? removeMcpRegistrations() : [];
    const payload = {
      status: 'uninstalled' as const,
      registrations_removed: deregister,
      removals,
      data_preserved: true,
      package_removal: 'If installed with npm, run `npm uninstall -g @klauro/mcp-server`. If installed as a standalone binary, remove that binary after this command exits.',
    };
    return output(json ? payload : [
      deregister ? 'Removed Klauro MCP registrations from Claude Code and Codex where present.' : 'MCP deregistration skipped.',
      'Account sessions and analysis data under ~/.klauro were preserved.',
      payload.package_removal,
    ].join('\n'), json);
  }
  if (command === 'auth-status' || command === 'whoami') {





    const status = await resolveAuthStatus({ serverUrl: value('--server-url') });
    return output(json
      ? { ...status, signed_in: status.state === 'signed-in', email: status.email ?? null }
      : status.detail,
      json);
  }
  if (command === 'logout') {
    const cleared = clearStoredConnectorSession(value('--server-url'));
    return output(json ? cleared : (cleared.removed ? `Signed out of ${cleared.serverUrl}.${cleared.switched_to ? ` Active account is now ${cleared.switched_to}.` : ''}` : `Not signed in to ${cleared.serverUrl}; nothing to do.`), json);
  }
  if (command === 'accounts') {
    const serverUrl = normalizeServerUrl(value('--server-url'));
    const useEmail = value('--use');
    if (useEmail) {
      const switched = switchStoredAccount(serverUrl, useEmail);
      return output(json ? { status: 'switched', ...switched } : `Active account for ${switched.serverUrl} is now ${switched.email}.`, json);
    }
    const accounts = listStoredAccounts(serverUrl);
    if (json) return output({ server_url: serverUrl, accounts }, json);
    if (accounts.length === 0) {
      return output(`No accounts signed in on ${serverUrl}. Run \`klauro login\`.`, json);
    }
    return output(
      accounts.map(a => `${a.active ? '* ' : '  '}${a.email}${a.active ? '  (active)' : ''}  — last used ${a.updated_at}`).join('\n'),
      json,
    );
  }
  if (command === 'login') {
    const serverUrl = normalizeServerUrl(value('--server-url'));

    if (!/^https:\/\//i.test(serverUrl) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(serverUrl)) {
      throw new Error(`Refusing to send credentials over a non-HTTPS server URL: ${serverUrl}`);
    }
    const email = value('--email') || await promptLine('Email: ');









    const legacyPassword = value('--password');
    const passwordStdin = process.argv.includes('--password-stdin');
    if (legacyPassword && !passwordStdin) {
      process.stderr.write(
        'Warning: --password on the command line is visible in your shell history and to other processes on this machine (via `ps`). Prefer the interactive prompt (omit --password) or --password-stdin for scripts.\n',
      );
    }
    const password = passwordStdin ? await readAllStdin() : (legacyPassword || await promptPassword('Password: '));
    const interactive = Boolean(process.stdin.isTTY);
    const register = process.argv.includes('--register');
    if (!email) throw new Error(missingEmailMessage({ interactive, register }));
    if (!password) throw new Error(missingPasswordMessage({ interactive, register }));
    const route = register ? '/api/auth/register' : '/api/auth/login';
    const response = await fetch(`${serverUrl}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const payload = await response.json().catch(() => ({})) as any;
    if (!response.ok) throw new Error(payload.error || `Login failed with HTTP ${response.status}`);
    const token = payload.token || payload.access_token || payload.accessToken;
    if (!token) throw new Error('Login response did not include an access token');
    const saved = saveStoredConnectorSession({ serverUrl, token, email });
    return output(json ? { status: 'signed-in', ...saved } : `Signed in as ${email} to ${serverUrl}. Session saved to ${saved.file}.`, json);
  }







  if (command === 'reset-password') {
    const serverUrl = normalizeServerUrl(value('--server-url'));
    if (!/^https:\/\//i.test(serverUrl) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(serverUrl)) {
      throw new Error(`Refusing to send a reset token over a non-HTTPS server URL: ${serverUrl}`);
    }
    const tokenStdin = process.argv.includes('--token-stdin');
    const resetToken = tokenStdin ? await readAllStdin() : (value('--token') || await promptLine('Reset token: '));
    if (!resetToken) throw new Error('reset-password requires --token, --token-stdin, or an entered token');
    const legacyNewPassword = value('--new-password');
    const newPasswordStdin = process.argv.includes('--new-password-stdin');
    if (legacyNewPassword && !newPasswordStdin) {
      process.stderr.write('Warning: --new-password on the command line is visible in your shell history and to other processes on this machine (via `ps`). Prefer the interactive prompt (omit --new-password) or --new-password-stdin.\n');
    }
    const newPassword = newPasswordStdin ? await readAllStdin() : (legacyNewPassword || await promptPassword('New password: '));
    if (!newPassword) throw new Error('reset-password requires --new-password, --new-password-stdin, or an entered password');
    const response = await fetch(`${serverUrl}/api/auth/reset-password/redeem`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: resetToken, new_password: newPassword }) });
    const payload = await response.json().catch(() => ({})) as any;
    if (!response.ok) throw new Error(payload.error || `Password reset failed with HTTP ${response.status}`);
    return output(json
      ? { status: 'success', server_url: serverUrl, email: payload.email ?? null }
      : `Password reset. Every previous session for ${payload.email || 'this account'} has been signed out.\nRun \`klauro login --email ${payload.email || '<email>'}\` to sign in with the new password.`,
      json);
  }





  if (command === 'change-password') {
    const serverUrl = normalizeServerUrl(value('--server-url'));
    if (!/^https:\/\//i.test(serverUrl) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(serverUrl)) {
      throw new Error(`Refusing to send credentials over a non-HTTPS server URL: ${serverUrl}`);
    }
    const token = connectorToken(undefined, serverUrl);
    if (!token) throw new Error('change-password requires an existing session — run `klauro login` first.');
    const legacyCurrentPassword = value('--current-password');
    const currentPasswordStdin = process.argv.includes('--current-password-stdin');
    if (legacyCurrentPassword && !currentPasswordStdin) {
      process.stderr.write('Warning: --current-password on the command line is visible in shell history and to other processes. Prefer the interactive prompt or --current-password-stdin.\n');
    }
    const legacyNewPassword = value('--new-password');
    const newPasswordStdin = process.argv.includes('--new-password-stdin');
    if (legacyNewPassword && !newPasswordStdin) {
      process.stderr.write('Warning: --new-password on the command line is visible in shell history and to other processes. Prefer the interactive prompt or --new-password-stdin.\n');
    }
    const currentPassword = currentPasswordStdin ? await readAllStdin() : (legacyCurrentPassword || await promptPassword('Current password: '));
    const newPassword = newPasswordStdin ? await readAllStdin() : (legacyNewPassword || await promptPassword('New password: '));
    if (!currentPassword) throw new Error('change-password requires --current-password, --current-password-stdin, or an entered password');
    if (!newPassword) throw new Error('change-password requires --new-password, --new-password-stdin, or an entered password');
    const response = await fetch(`${serverUrl}/api/auth/change-password`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }) });
    const payload = await response.json().catch(() => ({})) as any;
    if (!response.ok || !payload?.token) throw new Error(payload.error || `Password change failed with HTTP ${response.status}`);
    const stored = saveStoredConnectorSession({ serverUrl, token: payload.token, email: payload.user?.email });
    return output(json
      ? { status: 'success', server_url: stored.serverUrl, user: payload.user }
      : `Password changed for ${payload.user?.email || 'your account'}. Every other session was signed out; this session's token was rotated and saved to ${stored.file}.`,
      json);
  }











  if (command === 'admin-mint-reset-token') {
    const email = value('--email');
    if (!email) throw new Error('admin-mint-reset-token requires --email <account-email>');
    const dataDir = path.resolve(
      value('--data-dir')
        || process.env.KLAURO_REMOTE_ANALYZER_DATA
        || path.join(os.tmpdir(), `klauro-remote-analyzer-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`),
    );
    const accounts = new AccountStore(dataDir);
    const mintedBy = value('--minted-by') || `operator:${os.userInfo().username}@${os.hostname()}`;
    const minted = await accounts.mintPasswordResetToken({ email, mintedBy });
    return output(json
      ? { status: 'success', data_dir: dataDir, email, user_id: minted.userId, token: minted.token, expires_at: minted.expiresAt }
      : [
        `Minted a password reset token for ${email} (data dir: ${dataDir}).`,
        `Token (relay this to the account owner out-of-band — it is shown ONLY here, and it is single-use):`,
        `  ${minted.token}`,
        `Expires at ${minted.expiresAt} (30 minutes from now).`,
        `The account owner redeems it with:`,
        `  klauro reset-password --server-url <server-url> --token ${minted.token}`,
        `Redeeming invalidates every existing session for the account.`,
      ].join('\n'),
      json);
  }








  if (command !== 'help') {
    process.exitCode = 1;
  }
  printUsage();
}

interface HostedChoice { id: string; name: string; repo_url?: string; local_path?: string }
interface HostedProjectChoice extends HostedChoice { workspace_id: string }

function removeMcpRegistrations(): Array<{ client: string; status: number | null; detail: string }> {
  const commands: Array<{ client: string; executable: string; args: string[] }> = [
    { client: 'claude-user', executable: 'claude', args: ['mcp', 'remove', '--scope', 'user', 'klauro'] },
    { client: 'claude-project', executable: 'claude', args: ['mcp', 'remove', '--scope', 'project', 'klauro'] },
    { client: 'claude-local', executable: 'claude', args: ['mcp', 'remove', '--scope', 'local', 'klauro'] },
    { client: 'codex', executable: 'codex', args: ['mcp', 'remove', 'klauro'] },
  ];
  return commands.map(command => {
    const result = spawnSync(command.executable, command.args, { encoding: 'utf8' });
    return {
      client: command.client,
      status: result.status,
      detail: result.error?.message || result.stderr?.trim() || result.stdout?.trim() || (result.status === 0 ? 'removed' : 'not registered'),
    };
  });
}

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

async function getHostedProject(serverUrl: string, token: string, projectId: string): Promise<HostedProjectChoice | undefined> {
  const response = await fetch(`${serverUrl}/api/projects/${encodeURIComponent(projectId)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const payload = await response.json().catch(() => ({})) as { project?: HostedProjectChoice; error?: string };
  if (response.ok) return payload.project;
  if (response.status === 404) return undefined;
  throw new Error(payload.error || `Klauro project verification failed with HTTP ${response.status}`);
}

function output(value: unknown, json: boolean) {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

main().catch(async error => {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);





  try {
    const hint = await getStaleClientUpdateHint({
      serverUrl: normalizeServerUrl(extractServerUrlFlag(process.argv) || loadStoredConnectorAuth().defaultServerUrl),
      currentVersion: getBuildIdentity().base_version,
    });
    if (hint) process.stderr.write(`${hint}\n`);
  } catch {   }
  process.exit(1);
});
