import * as os from 'node:os';
import * as path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { analyzeCodebaseRemotely, syncWorkingTreeRemotely } from './remote-sync-client';
import { formatRemoteResult, withAnalysisState } from './remote-result-format';
import { buildUploadManifest } from './remote-source';
import { assessUploadScope, confirmUploadScope } from './upload-scope-guard';
import { clearStoredConnectorSession, connectorToken, listStoredAccounts, loadStoredConnectorAuth, normalizeServerUrl, resolveAuthStatus, saveStoredConnectorSession, switchStoredAccount, warnIfSessionExpiringSoon } from './connector-auth';
import { writeDefaultKlauroConfig } from './klauro-config';
import { formatBuildIdentity, resolveManifestProjectName } from './installed-client-runtime';
import { KLAURO_INSTALL_ONELINER, SELF_UPDATE_COMMANDS, runSelfUpdate } from './self-update';
import { renderStatusReport } from './status-report';
import { formatClientDoctor, runClientDoctor } from './client-doctor';
import { buildSupportBundle, formatSupportBundleResult } from './support-bundle';
import { promptLine, promptPassword, readAllStdin } from './password-prompt';
// §AUTH-LIFECYCLE — admin-mint-reset-token talks to the account store
// directly (no HTTP hop, no site-wide admin role to gate an endpoint with —
// see AccountStore.mintPasswordResetToken's doc comment). account-store.ts
// has no dependency on any hosted-only module (analyzer.ts, orchestrator,
// etc.), so it is safe to pull into the installed-client bundle the same way
// every other shared module here is.
import { AccountStore } from './account-store';

function value(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/**
 * What `klauro install` registers as the MCP server launch command — differs
 * by distribution channel:
 *
 *  - npm-installed client: `node <package>/dist/index.cjs` (unchanged,
 *    exactly what every registration up to and including 1.0.131 wrote).
 *  - self-contained (Node SEA) binary, from `curl .../install | sh`: there is
 *    no `dist/` directory beside a single embedded executable, so the
 *    registered command is the binary ITSELF (`process.execPath` inside a
 *    SEA build IS the klauro binary's own path) invoked with the
 *    `__mcp_server` sentinel argv that installed-sea-entry.ts dispatches on
 *    to start the same server logic instead of the CLI.
 *
 * `node:sea` (stable Node 21.7+/22+) is the documented way to tell these
 * apart at runtime; it is absent from older Node, so failure to load it is
 * read as "not running inside a SEA binary" rather than an error.
 */
export function resolveMcpRegistrationCommand(): string[] {
  let isSea = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    isSea = (require('node:sea') as { isSea(): boolean }).isSea();
  } catch {
    isSea = false;
  }
  if (isSea) return [process.execPath, '__mcp_server'];
  return [process.execPath, path.join(__dirname, 'index.cjs')];
}

// ---------------------------------------------------------------------------
// Flag validation + `--help`, generalised across every subcommand.
//
// The defect this closes: `target` below was computed by treating anything
// NOT starting with `-` as the positional path, and anything else (including
// an unrecognized or misspelled flag, and `--help`/`-h` themselves) was
// silently dropped. `klauro analyze --help` therefore never printed usage —
// `--help` vanished, the positional slot fell back to `.`, and a real
// analysis of the current directory ran. Task #49 fixed one shape of this
// (an unknown flag silently becoming the path) for `init` in the developer
// CLI's parseArgs (cli.ts); it was never ported to this file, which is the
// one actually shipped (dist/cli.cjs, built from this file — see
// scripts/build-bundle.mjs). Fixed generally here: every subcommand honours
// `--help`/`-h`, and every subcommand rejects a flag it does not recognize
// instead of swallowing it.
// ---------------------------------------------------------------------------

const HELP_FLAGS = new Set(['--help', '-h']);

/** Flags that consume the next argv slot as their value, so flag validation
 *  below does not misread that value as a second, unrecognized flag. */
const FLAGS_WITH_VALUES = new Set([
  '--server-url', '--project-id', '--organization-id', '--workspace', '--output',
  '--email', '--password', '--token', '--new-password', '--current-password',
  '--data-dir', '--minted-by', '--claude-scope', '--use',
]);

/** The flags each subcommand actually reads (via `value()` or
 *  `argv.includes()` above/below). A command absent from this map is not
 *  flag-validated here — it either isn't a real command (falls through to
 *  the usage block, unchanged) or its flags are validated elsewhere. */
const COMMAND_FLAGS: Record<string, Set<string>> = {
  ...Object.fromEntries(SELF_UPDATE_COMMANDS.map(name => [name, new Set(['--server-url', '--check', '--force', '--json'])])),
  version: new Set(['--json']),
  '--version': new Set(['--json']),
  '-v': new Set(['--json']),
  // --force (task #132): was documented in cli.ts's usage text but never
  // even ACCEPTED here — the installed (customer-shipped) CLI threw "Unknown
  // option" for it, a loud failure rather than the dev CLI's silent no-op,
  // but still not the feature. Now wired through to analyzeCodebaseRemotely.
  // --yes (task #134): confirms an upload whose resolved root looks like a
  // folder containing several unrelated projects rather than one project —
  // see upload-scope-guard.ts. Without it, an unsafe scope on a non-TTY
  // (scripted/CI) run refuses instead of uploading; on a TTY it prompts.
  analyze: new Set(['--json', '--force', '--yes']),
  'remote-analyze': new Set(['--json', '--force', '--yes']),
  'remote-sync': new Set(['--json', '--yes']),
  sync: new Set(['--json', '--yes']),
  'upload-manifest': new Set(['--json', '--dirty-tree']),
  index: new Set(['--json', '--dirty-tree']),
  status: new Set(['--server-url', '--json']),
  doctor: new Set(['--server-url', '--json']),
  'support-bundle': new Set(['--output', '--json']),
  init: new Set(['--server-url', '--project-id', '--organization-id', '--workspace', '--force', '--json']),
  install: new Set(['--claude-scope', '--json']),
  'auth-status': new Set(['--server-url', '--json']),
  whoami: new Set(['--server-url', '--json']),
  logout: new Set(['--server-url', '--json']),
  login: new Set(['--server-url', '--email', '--password', '--password-stdin', '--register', '--json']),
  accounts: new Set(['--server-url', '--use', '--json']),
  'reset-password': new Set(['--server-url', '--token', '--token-stdin', '--new-password', '--new-password-stdin', '--json']),
  'change-password': new Set(['--server-url', '--current-password', '--current-password-stdin', '--new-password', '--new-password-stdin', '--json']),
  'admin-mint-reset-token': new Set(['--email', '--data-dir', '--minted-by', '--json']),
};

/** Commands that read `target` as a real filesystem path (as opposed to
 *  ignoring it, e.g. `login`). An explicitly-given path that doesn't exist,
 *  or isn't a directory, must fail here with a clear message rather than
 *  fail deep inside git/upload plumbing with a confusing error — or, worse,
 *  silently fall back to `.` the way a swallowed `--help` used to. Path
 *  omitted (defaulting to cwd) is always valid, so it is not checked. */
const PATH_COMMANDS = new Set([
  'analyze', 'remote-analyze', 'remote-sync', 'sync', 'upload-manifest', 'index',
  'init', 'status', 'doctor', 'support-bundle',
]);

/** Throws by flag name instead of letting an unrecognized `--flag` fall
 *  through to the positional path slot or get silently ignored. */
function validateFlags(command: string, argv: string[]): void {
  const allowed = COMMAND_FLAGS[command];
  if (!allowed) return;
  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('-') || HELP_FLAGS.has(arg)) continue;
    if (!allowed.has(arg)) {
      throw new Error(`Unknown option for \`klauro ${command}\`: ${arg} (run \`klauro ${command} --help\` for supported flags)`);
    }
    if (FLAGS_WITH_VALUES.has(arg)) i += 1;
  }
}

/** Finds the positional path argument regardless of where it falls relative
 *  to flags — `klauro init --force /some/path` and `klauro init /some/path
 *  --force` must resolve identically. The naive version of this (`argv[3]`)
 *  only worked for the second ordering: with a flag first, argv[3] is the
 *  flag itself, which starts with `-`, so the target silently fell back to
 *  cwd instead of the given path — no error, no path field on the config
 *  that matched what was asked for, just a `.klaurorc` written into (and a
 *  hosted project bound to) whatever directory the command happened to run
 *  from. Skips every recognized flag, and — critically — skips the VALUE
 *  slot of any flag in FLAGS_WITH_VALUES too, so `klauro init --project-id
 *  p_123 /some/path` resolves path=/some/path, not path=p_123. Relies on
 *  validateFlags() having already run and rejected any unrecognized flag,
 *  so every `-`-prefixed token reaching this loop is a known flag. */
function resolvePositionalArg(argv: string[]): string | undefined {
  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('-')) {
      if (FLAGS_WITH_VALUES.has(arg)) i += 1; // skip its value too
      continue;
    }
    return arg;
  }
  return undefined;
}

/** An explicit path argument must resolve to a real directory before any
 *  command acts on it — see the `klauro analyze --help` incident in the
 *  block comment above: silently proceeding on a wrong/nonexistent path is
 *  what turned a swallowed flag into a real 28k-file analysis. */
function validateTargetPath(command: string, rawArg: string | undefined, resolved: string): void {
  if (!PATH_COMMANDS.has(command)) return;
  if (!rawArg || rawArg.startsWith('-')) return; // no explicit path; cwd default is always valid
  if (!existsSync(resolved)) throw new Error(`\`klauro ${command}\`: path does not exist: ${resolved}`);
  if (!statSync(resolved).isDirectory()) throw new Error(`\`klauro ${command}\`: path is not a directory: ${resolved}`);
}

const USAGE_TEXT = [
  'Usage: klauro <command> [path] [options]', '',
  '  init [path]                 Configure a project for hosted Klauro analysis',
  '  install                     Register the lightweight MCP with Claude and Codex',
  '  analyze [path] [--force] [--yes]',
  '                               Upload a committed source snapshot for hosted analysis',
  '                               --force bypasses BOTH the server\'s reuse-of-unchanged-snapshot shortcut AND the',
  '                               AI response cache, so structure and AI-generated names/descriptions are freshly',
  '                               produced instead of served from a prior run.',
  '                               --yes confirms uploading a root that looks like it contains several unrelated',
  '                               projects instead of one (no Git repo/manifest of its own, multiple nested repos',
  '                               beneath it) — without it this refuses (scripted) or prompts (interactive).',
  '  remote-sync [path] [--yes]  Upload in-flight changes for hosted analysis',
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

/**
 * Task #134: gate before `analyze`/`remote-sync` upload anything. Always
 * prints the resolved root to STDERR first (never stdout, so it can't
 * corrupt a `--json` caller's output) — item 2 of the fix: the root must be
 * shown prominently and BEFORE the upload, not buried in the eventual
 * response. Then, only if the scope looks unsafe (assessUploadScope),
 * confirms via `--yes` or an interactive prompt; see upload-scope-guard.ts
 * for why a non-TTY/scripted run can never hang here.
 */
async function resolveUploadScopeConfirmation(target: string): Promise<{ proceed: boolean; confirmScope: boolean }> {
  process.stderr.write(`Resolved project root: ${target}\n`);
  const yes = process.argv.includes('--yes');
  const assessment = await assessUploadScope(target);
  return confirmUploadScope(assessment, { yes });
}

async function main() {
  const command = process.argv[2] || 'help';
  // `--help`/`-h` on ANY subcommand prints usage and does nothing else —
  // checked before flag validation and before any command runs, so it can
  // never be shadowed by an unknown-option error or (the original defect)
  // silently discarded into a real run of the command.
  if (HELP_FLAGS.has(command) || process.argv.slice(3).some(arg => HELP_FLAGS.has(arg))) {
    printUsage();
    return;
  }
  validateFlags(command, process.argv);
  const rawPathArg = resolvePositionalArg(process.argv);
  const target = path.resolve(rawPathArg ?? '.');
  validateTargetPath(command, rawPathArg, target);
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
  // #129 — this branch used to hand the raw result straight to `output()`,
  // which JSON.stringifies ANY non-string value even in plain-text mode: a
  // customer running `klauro analyze .` (no --json) got a full JSON dump —
  // reuse_decision, analysis_id, manifest — that reads exactly like a
  // finished result the instant the upload was merely ACCEPTED (`status:
  // 'accepted'`, seconds in, server-side analysis still running). cli.ts's
  // dev-only `analyze` always rendered this honestly via formatRemoteResult;
  // it just never shipped to customers. Both entry points now go through the
  // same shared formatter (remote-result-format.ts) so they can't diverge
  // again, and --json now also carries an explicit `analysis_state` field
  // ('running' | 'complete') so a script/harness has one unambiguous field
  // to check instead of having to already know 'accepted' means not-done.
  //
  // task #132: --force (validated above in COMMAND_FLAGS) is now actually
  // threaded through — previously this file didn't even accept the flag.
  if (command === 'analyze' || command === 'remote-analyze') {
    const scope = await resolveUploadScopeConfirmation(target);
    if (!scope.proceed) { process.exitCode = 1; return; }
    const result = await analyzeCodebaseRemotely({ projectPath: target, requireBoundProject: true, force: process.argv.includes('--force'), confirmScope: scope.confirmScope });
    return output(json ? withAnalysisState(result) : formatRemoteResult(result), json);
  }
  if (command === 'remote-sync' || command === 'sync') {
    const scope = await resolveUploadScopeConfirmation(target);
    if (!scope.proceed) { process.exitCode = 1; return; }
    const result = await syncWorkingTreeRemotely({ projectPath: target, requireBoundProject: true, confirmScope: scope.confirmScope });
    return output(json ? withAnalysisState(result) : formatRemoteResult(result), json);
  }
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
      projectPath: rawPathArg ? target : undefined,
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
    const mcpCommand = resolveMcpRegistrationCommand();
    const scope = value('--claude-scope') || 'user';
    const results: Record<string, unknown> = {};
    // Best-effort remove of any existing registration BEFORE re-adding.
    // Without this, `claude mcp add`/`codex mcp add` on an already-registered
    // name either no-ops or errors depending on client version, so re-running
    // `klauro install` after upgrading from the npm client to the
    // self-contained binary (or back) would leave the OLD command (`node
    // .../dist/index.cjs`, now possibly gone) registered forever — an MCP
    // that silently stops loading is worse than one that fails loudly, and
    // this is how that gets avoided: always re-register clean. Failure here
    // is fine (nothing registered yet) and ignored.
    spawnSync('claude', ['mcp', 'remove', '--scope', scope, 'klauro'], { encoding: 'utf8' });
    spawnSync('codex', ['mcp', 'remove', 'klauro'], { encoding: 'utf8' });
    const claude = spawnSync('claude', ['mcp', 'add', '--scope', scope, 'klauro', '--', ...mcpCommand], { encoding: 'utf8' });
    results.claude = claude.error?.message || claude.stderr?.trim() || claude.stdout?.trim() || `exit ${claude.status}`;
    const codex = spawnSync('codex', ['mcp', 'add', 'klauro', '--', ...mcpCommand], { encoding: 'utf8' });
    results.codex = codex.error?.message || codex.stderr?.trim() || codex.stdout?.trim() || `exit ${codex.status}`;
    return output({ status: claude.status === 0 || codex.status === 0 ? 'installed' : 'manual-registration-required', command: mcpCommand.join(' '), results }, json);
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
  // §AUTH-LIFECYCLE — `klauro reset-password`. Redeems a single-use token an
  // operator minted (see `admin-mint-reset-token` below); PUBLIC endpoint by
  // design (the whole point is recovering an account with no valid session,
  // so authorization is possession of the token, not a Bearer header). On
  // success every existing session for the account is dead server-side —
  // this command deliberately does not auto-login, so `klauro login`
  // exercises the new password at least once.
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
  // §AUTH-LIFECYCLE — `klauro change-password`. Requires an existing session
  // (this repo/host's stored connector auth) and the CURRENT password. On
  // success the server revokes every OTHER session and rotates this one's
  // token; the new token is saved immediately so the caller isn't logged out
  // by their own password change.
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
  // §AUTH-LIFECYCLE — `klauro admin-mint-reset-token`. OPERATOR-ONLY. Talks
  // to the AccountStore DIRECTLY against the same data directory the hosted
  // analyzer server uses (--data-dir, or KLAURO_REMOTE_ANALYZER_DATA) — not
  // an HTTP call, and deliberately so: this product has no site-wide admin
  // role (workspace roles are owner/admin/member, scoped per-workspace), so
  // rather than invent one to gate an HTTP admin-mint endpoint, the trust
  // boundary is the same one that already gates read-only inspection of
  // accounts.json — being able to run this command with access to /data IS
  // the operator authentication. Prints the raw single-use token to stdout
  // exactly once; relay it to the account owner out-of-band, never re-print
  // or log it. Redeemed via `klauro reset-password --token <token>`.
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
  printUsage();
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
