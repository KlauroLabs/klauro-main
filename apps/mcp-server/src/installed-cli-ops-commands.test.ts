import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

// --- P0 follow-up (2026-07-28) ------------------------------------------
// installed-cli-update-command.test.ts pinned the ORIGINAL defect: `klauro
// update` was missing from the shipped CLI while the server's 426 told every
// customer to run it. The audit that fixed it found the SAME class in three
// more places — `status`, `doctor`, `support-bundle` were all told to
// customers (18 / 7 / 4 mentions respectively across product text) but never
// registered in installed-cli.ts, so each fell through to the usage block
// and exited 0.
//
// This file is the REGRESSION GATE for the whole class, not just those three
// commands: it scans the product's user-facing text surface for every
// `klauro <command>` mention and asserts installed-cli.ts actually registers
// it. A future change that adds a new "run `klauro whatever`" remediation
// without also registering `whatever` in installed-cli.ts fails this test —
// that is the point; the same defect must not need a fourth audit to find.

const packageRoot = path.join(__dirname, '..');
const installedCliSource = readFileSync(path.join(__dirname, 'installed-cli.ts'), 'utf8');
const shippedCli = path.join(packageRoot, 'dist', 'cli.cjs');

/**
 * The commands installed-cli.ts actually registers, derived mechanically
 * from its own source rather than hand-maintained here (a hand-maintained
 * list would itself rot the day someone adds a command and forgets to
 * update the list). Matches `command === 'foo'` / `command === "foo"` and
 * the SELF_UPDATE_COMMANDS spread.
 */
function registeredCommands(source: string): Set<string> {
  const commands = new Set<string>();
  for (const match of source.matchAll(/command === ['"]([a-zA-Z][a-zA-Z-]*)['"]/g)) commands.add(match[1]);
  // SELF_UPDATE_COMMANDS = ['update', 'upgrade', 'self-update'] is checked
  // via `.includes(command)`, not a literal `command === `, so the regex
  // above can't see it — read it from self-update.ts directly instead of
  // hardcoding the alias list a second time here.
  const selfUpdateSource = readFileSync(path.join(__dirname, 'self-update.ts'), 'utf8');
  const selfUpdateMatch = selfUpdateSource.match(/SELF_UPDATE_COMMANDS = \[([^\]]+)\]/);
  if (selfUpdateMatch) {
    for (const alias of selfUpdateMatch[1].matchAll(/'([a-zA-Z-]+)'/g)) commands.add(alias[1]);
  }
  // version has extra spellings (--version/-v) that aren't `command === 'x'`
  // shaped; they're not commands product text ever names as `klauro --version`,
  // so no extra handling is needed here.
  return commands;
}

/**
 * Extracts `klauro <command>` mentions that are plausibly directives to a
 * CUSTOMER (backtick- or backtick-adjacent code-styled, e.g. `` `klauro
 * update` `` or `` `klauro fabric on` ``), skipping comment lines (// and *
 * prefixed) so JSDoc discussion of internals doesn't produce false
 * positives. This is a text heuristic, not a parser — it intentionally
 * errs toward over-matching (more candidates to check) rather than
 * under-matching (a real dead end slipping through silently).
 */
function extractCommandMentions(source: string): Set<string> {
  const commands = new Set<string>();
  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/**')) continue;
    for (const match of line.matchAll(/`klauro ([a-zA-Z][a-zA-Z-]*)/g)) commands.add(match[1]);
  }
  return commands;
}

/**
 * The user-facing text surface this gate scans, and why each file is in
 * scope. Deliberately NOT "everything the bundler pulls into dist/cli.cjs":
 * some bundled modules (e.g. coordination/fabric-config.ts) carry string
 * CONSTANTS that are only ever consumed by server.ts's fab_* MCP tool
 * handlers — server.ts is not part of the customer bundle (see
 * installed-client-boundary.test.ts / bundle-metafile.json), so that text
 * never reaches a customer today even though the module itself is bundled
 * for other reasons (fabric detection in `klauro status`'s Fabric: line,
 * which builds its OWN note text and does not surface that constant). If
 * fab_* tools are ever wired into the installed MCP server without also
 * restoring a `klauro fabric` command, THAT change should add
 * coordination/fabric-config.ts to this list and let the gate catch it —
 * scanning it unconditionally today would fail this test for a string no
 * customer can currently see, which would just train people to ignore it.
 */
// status-report.ts is DELIBERATELY not in this list even though it's shared
// with the installed client: its fabric note text is entry-point-conditional
// (buildConnectionReport's `fabricCliAvailable` flag — cli.ts gets the
// `klauro fabric off` wording since that command really exists there,
// installed-cli.ts gets a command-free rewording since it does not). A flat
// text scan can't see which branch a given caller takes, so it would either
// false-positive on cli.ts's legitimate string or miss a real regression in
// installed-cli.ts's branch. The runtime test below checks the ACTUAL
// installed-cli.ts output instead, which is unambiguous.
const SCANNED_FILES = [
  'src/installed-cli.ts', // the shipped CLI's own help/usage/error text
  'src/client-doctor.ts', // `klauro doctor`, shared with cli.ts
  'src/support-bundle.ts', // `klauro support-bundle`, shared with cli.ts
  'src/self-update.ts', // `klauro update`/`upgrade`/`self-update`
  'src/connector-auth.ts', // login/auth remediation
  'src/klauro-config.ts', // init/login remediation from config loading
  'src/installed-client-runtime.ts', // installed-client bundle shim (getBuildIdentity, checkServerStaleness, ...)
  'src/installed-client-server.ts', // the installed MCP server's own tool text
  'src/hosted-transport.ts', // transport/HTTP failure remediation on every hosted MCP tool
  'src/bundle-staleness.ts', // stale-client-build remediation surfaced at startup and on orientation
  'src/index.ts', // installed MCP server entry point
  'src/mcp-registration-doctor.ts', // MCP-registration remediation
  'src/remote-analyzer-protocol.ts', // client-side protocol constants + the 426 message builder
  'src/remote-analyzer-service.ts', // SERVER text (426/401/etc.) the customer receives over HTTP — never bundled into the CLI itself, but its strings reach the customer just the same
  'scripts/install.sh', // the public curl|sh installer
  'scripts/install.ps1', // the public Windows installer
];

test('every `klauro <command>` mentioned in customer-facing text is registered in installed-cli.ts', () => {
  const registered = registeredCommands(installedCliSource);
  const allMentioned = new Map<string, string[]>();

  for (const relativePath of SCANNED_FILES) {
    const source = readFileSync(path.join(packageRoot, relativePath), 'utf8');
    for (const command of extractCommandMentions(source)) {
      const locations = allMentioned.get(command) ?? [];
      locations.push(relativePath);
      allMentioned.set(command, locations);
    }
  }

  assert.ok(allMentioned.size > 0, 'the scan found zero `klauro <command>` mentions — the extraction regex or SCANNED_FILES list is broken, not that there is nothing to check');

  const deadEnds: string[] = [];
  for (const [command, locations] of allMentioned) {
    if (!registered.has(command)) {
      deadEnds.push(`\`klauro ${command}\` — mentioned in ${[...new Set(locations)].join(', ')}, but installed-cli.ts does not register it`);
    }
  }
  assert.deepEqual(deadEnds, [], `Dead-end command(s) found — product text tells a customer to run a command the shipped CLI does not implement:\n${deadEnds.join('\n')}`);
});

test('installed-cli.ts registers status, doctor, and support-bundle (the 2026-07-28 audit fix)', () => {
  const registered = registeredCommands(installedCliSource);
  for (const command of ['status', 'doctor', 'support-bundle']) {
    assert.ok(registered.has(command), `installed-cli.ts must register \`${command}\``);
  }
});

// --- P0 follow-up #2 (2026-08-08) -----------------------------------------
// SAME class again: `reset-password`, `change-password`, and
// `admin-mint-reset-token` were built entirely in cli.ts (the dev CLI) and
// never ported to installed-cli.ts (the ONLY file build-bundle.mjs puts in
// the customer tarball) — the endpoints worked, but no shipped binary could
// reach them, discovered by a coordinator diffing `grep -c` counts across
// the two files immediately after merge. This is now the SECOND time a
// command landed in cli.ts only: the text-mention gate above did not catch
// it because nothing in the SCANNED_FILES text surface happened to mention
// these commands by name in backticks (cli.ts itself, where they WERE
// documented, is deliberately excluded from that scan — it carries a much
// larger developer-only surface that must NOT all be required in
// installed-cli.ts).
//
// This gate closes that hole from a different, stronger angle: rather than
// depending on incidental prose mentioning a command, it reads the actual
// SERVER CONTRACT (every `/api/auth/...` route literal in
// remote-analyzer-service.ts — the real, mechanical source of truth for
// what auth capabilities exist) and asserts BOTH client entry points contain
// client code that reaches each one. A future auth route added server-side
// with no reachable path from EITHER cli.ts or installed-cli.ts fails this
// test immediately, with no dependency on anyone remembering to also write
// a "run `klauro whatever`" remediation string somewhere.
test('every /api/auth/* route the server exposes is reachable from BOTH cli.ts and installed-cli.ts', () => {
  const serviceSource = readFileSync(path.join(__dirname, 'remote-analyzer-service.ts'), 'utf8');
  const cliSource = readFileSync(path.join(__dirname, 'cli.ts'), 'utf8');

  const routes = new Set<string>();
  for (const match of serviceSource.matchAll(/route === '(\/api\/auth\/[a-zA-Z0-9/_-]+)'/g)) routes.add(match[1]);
  assert.ok(routes.size > 0, 'the scan found zero /api/auth/* routes — the extraction regex or remote-analyzer-service.ts route shape changed; fix the regex, not this assertion');

  const missing: string[] = [];
  for (const route of routes) {
    if (!installedCliSource.includes(route)) missing.push(`${route} — not referenced anywhere in installed-cli.ts (unreachable from the shipped CLI)`);
    if (!cliSource.includes(route)) missing.push(`${route} — not referenced anywhere in cli.ts`);
  }
  assert.deepEqual(missing, [], `Auth route(s) the server exposes but a client entry point cannot reach:\n${missing.join('\n')}`);
});

// admin-mint-reset-token has no HTTP route (by design — see its doc comment
// in both files: there is no site-wide admin role to gate an endpoint with,
// so it talks to the AccountStore directly). The route-literal gate above
// can't see it, so it needs its own explicit, mechanically-checked pin —
// same shape as the status/doctor/support-bundle test above.
test('installed-cli.ts registers reset-password, change-password, and admin-mint-reset-token (the 2026-08-08 audit fix)', () => {
  const registered = registeredCommands(installedCliSource);
  for (const command of ['reset-password', 'change-password', 'admin-mint-reset-token']) {
    assert.ok(registered.has(command), `installed-cli.ts must register \`${command}\``);
  }
});

/** Synchronous form — safe only when the CLI needs no in-process server. */
function runInstalledCliSync(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [shippedCli, ...args], { encoding: 'utf8', timeout: 60_000 });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function runInstalledCli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [shippedCli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

test('the SHIPPED cli entry point implements `status` — it must not fall through to the usage block', async () => {
  const result = await runInstalledCli(['status', '--json', '--server-url', 'http://127.0.0.1:1']);
  assert.doesNotMatch(result.stdout, /Usage: klauro <command>/, '`klauro status` printed the usage block — the command is not registered in installed-cli.ts');
  const payload = JSON.parse(result.stdout) as { version: string; server_url: string };
  assert.equal(typeof payload.version, 'string');
  assert.equal(payload.server_url, 'http://127.0.0.1:1');
});

test('`klauro status` never tells a customer to run `klauro fabric` (fabric is a cli.ts-only developer command)', async () => {
  // Reproduces the ONLY branch that used to say `klauro fabric off`:
  // fabric explicitly disabled in .klaurorc. Everywhere else defaults to a
  // command-free note, so this fixture is required to actually exercise it.
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'klauro-status-fabric-'));
  try {
    writeFileSync(path.join(fixtureDir, '.klaurorc'), JSON.stringify({ fabric: { enabled: false } }), 'utf8');
    const result = await runInstalledCli(['status', fixtureDir, '--server-url', 'http://127.0.0.1:1']);
    assert.doesNotMatch(result.stdout, /klauro fabric/, '`klauro status` must never reference `klauro fabric` — that command is not registered in installed-cli.ts');
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('the SHIPPED cli entry point implements `doctor` — it must not fall through to the usage block', async () => {
  const result = await runInstalledCli(['doctor', '--json', '--server-url', 'http://127.0.0.1:1']);
  assert.doesNotMatch(result.stdout, /Usage: klauro <command>/, '`klauro doctor` printed the usage block — the command is not registered in installed-cli.ts');
  const payload = JSON.parse(result.stdout) as { status: string; checks: unknown[] };
  assert.ok(['pass', 'warn', 'fail'].includes(payload.status));
  assert.ok(Array.isArray(payload.checks) && payload.checks.length > 0);
});

test('the SHIPPED cli entry point implements `support-bundle` — it must not fall through to the usage block', async () => {
  // --output into a temp dir: without it the bundle lands in process.cwd(),
  // littering the package root with untracked tarballs that can trip
  // infrastructure/vps/deploy.sh's dirty-working-tree guard.
  const outputDir = mkdtempSync(path.join(os.tmpdir(), 'klauro-support-bundle-'));
  try {
    const outputPath = path.join(outputDir, 'support-bundle.tar.gz');
    const result = runInstalledCliSync(['support-bundle', '--output', outputPath, '--json']);
    assert.doesNotMatch(result.stdout, /Usage: klauro <command>/, '`klauro support-bundle` printed the usage block — the command is not registered in installed-cli.ts');
    const payload = JSON.parse(result.stdout) as { bundle_path: string; included: unknown[]; excluded: string[] };
    assert.equal(payload.bundle_path, outputPath);
    assert.ok(Array.isArray(payload.excluded) && payload.excluded.length > 0, 'support bundle must document what it deliberately excludes');
    // Redaction: no secret-shaped value should ever appear in the manifest text.
    assert.doesNotMatch(JSON.stringify(payload), /sk-[a-zA-Z0-9]{10,}/, 'support bundle must not leak an API-key-shaped value');
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('the shipped help text advertises status, doctor, and support-bundle', () => {
  const help = runInstalledCliSync([]).stdout;
  assert.match(help, /status \[path\]/);
  assert.match(help, /doctor \[path\]/);
  assert.match(help, /support-bundle \[path\]/);
});

test('the shipped help text advertises reset-password, change-password, and admin-mint-reset-token', () => {
  const help = runInstalledCliSync([]).stdout;
  assert.match(help, /reset-password --token TOKEN/);
  assert.match(help, /change-password/);
  assert.match(help, /admin-mint-reset-token --email EMAIL/);
});

// Live functional proof against the BUILT bundle (not source): each command
// must actually reach account-store.ts / the network, never silently fall
// through to the generic usage block the way `update`/`status`/`doctor`/
// `support-bundle` all once did. Using an unreachable server-url / a scratch
// data dir means these assert on a REAL attempt-and-fail, not a mocked path.
test('the SHIPPED cli entry point implements `reset-password` — it must not fall through to the usage block', async () => {
  const result = await runInstalledCli(['reset-password', '--token', 'krt_fake', '--new-password', 'irrelevant-password-1', '--server-url', 'http://127.0.0.1:1']);
  assert.doesNotMatch(result.stdout + result.stderr, /Usage: klauro <command>/, '`klauro reset-password` printed the usage block — the command is not registered in installed-cli.ts');
  assert.notEqual(result.status, 0, 'an unreachable server must fail the command, not silently succeed');
});

test('the SHIPPED cli entry point implements `change-password` — it must not fall through to the usage block', async () => {
  // No stored session and no reachable server: must fail on "no session" or
  // a network error, never print the generic usage text.
  const result = await runInstalledCli(['change-password', '--current-password', 'irrelevant-1', '--new-password', 'irrelevant-2', '--server-url', 'http://127.0.0.1:1']);
  assert.doesNotMatch(result.stdout + result.stderr, /Usage: klauro <command>/, '`klauro change-password` printed the usage block — the command is not registered in installed-cli.ts');
  assert.notEqual(result.status, 0);
});

test('the SHIPPED cli entry point implements `admin-mint-reset-token` and it really talks to AccountStore — proven against a scratch data dir', async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'klauro-admin-mint-'));
  try {
    // No account exists yet at this scratch dir: the command must reach
    // AccountStore.mintPasswordResetToken and get its real 404, not the
    // generic usage block (which would also exit non-zero, but for the
    // wrong reason — the assertion on stdout below tells them apart).
    const noAccount = await runInstalledCli(['admin-mint-reset-token', '--email', 'nobody@example.com', '--data-dir', dataDir, '--json']);
    assert.doesNotMatch(noAccount.stdout + noAccount.stderr, /Usage: klauro <command>/, '`klauro admin-mint-reset-token` printed the usage block — the command is not registered in installed-cli.ts');
    assert.match(noAccount.stdout + noAccount.stderr, /No account exists with that email/);

    // Seed a real account directly with the source-level AccountStore (this
    // test file already runs under tsx, so importing it here costs nothing
    // and keeps the seeding step out of the artifact-under-test), then mint
    // for real against the SAME scratch dir via the BUILT binary.
    const { AccountStore } = await import('./account-store');
    const store = new AccountStore(dataDir);
    const seeded = await store.register({ email: 'owner@example.com', password: 'seed-password-1234', workspaceName: 'Seed' });

    const minted = await runInstalledCli(['admin-mint-reset-token', '--email', 'owner@example.com', '--data-dir', dataDir, '--json']);
    assert.equal(minted.status, 0, `admin-mint-reset-token failed against a real account: ${minted.stderr}`);
    const payload = JSON.parse(minted.stdout) as { token: string; user_id: string; expires_at: string };
    assert.match(payload.token, /^krt_/);
    assert.equal(payload.user_id, seeded.user.id);
    assert.ok(Date.parse(payload.expires_at) > Date.now());

    // And the minted token is real: it redeems successfully against the store directly.
    const redeemed = await store.redeemPasswordResetToken({ token: payload.token, newPassword: 'post-mint-password-2' });
    assert.equal(redeemed.userId, seeded.user.id);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P0 follow-up (2026-08-07): `klauro analyze --help` printed no usage and
// instead ran a REAL analysis of the current directory (28,393 files /
// 307MB). The positional-path fallthrough treated `--help` as "not a path"
// (it starts with `-`) and silently dropped it, leaving `target` defaulted
// to `.` — the same class task #49 fixed for `init`'s flag parsing in the
// developer CLI (cli.ts), never ported to this file, the one actually
// shipped as dist/cli.cjs. Fixed generally: every subcommand honours
// `--help`/`-h` and rejects an unrecognized flag instead of swallowing it.
// ---------------------------------------------------------------------------

test('`klauro analyze --help` prints usage and performs no analysis (the incident this class caused)', async () => {
  const result = await runInstalledCli(['analyze', '--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: klauro <command>/);
  // The regression signature: a real run prints an `accepted`/`success`
  // status JSON-ish payload or a network/binding error, never bare usage.
  assert.doesNotMatch(result.stdout, /"status"/, 'a real analysis ran instead of printing help');
});

test('--help/-h prints usage for every subcommand instead of running it', async () => {
  for (const args of [['init', '--help'], ['status', '-h'], ['doctor', '--help'], ['upload-manifest', '-h'], ['login', '--help'], ['--help'], ['-h']]) {
    const result = await runInstalledCli(args);
    assert.equal(result.status, 0, `\`klauro ${args.join(' ')}\` exited ${result.status}: ${result.stderr}`);
    assert.match(result.stdout, /Usage: klauro <command>/, `\`klauro ${args.join(' ')}\` did not print usage`);
  }
});

test('an unrecognized flag is rejected by name, on every subcommand, instead of silently becoming the path or being dropped', async () => {
  const analyze = await runInstalledCli(['analyze', '--headless']);
  assert.notEqual(analyze.status, 0);
  assert.match(analyze.stdout + analyze.stderr, /Unknown option for `klauro analyze`: --headless/);
  assert.doesNotMatch(analyze.stdout, /Usage: klauro <command>/, 'an unknown flag must name itself, not fall back to the generic usage block');

  const init = await runInstalledCli(['init', '--not-a-real-flag']);
  assert.notEqual(init.status, 0);
  assert.match(init.stdout + init.stderr, /Unknown option for `klauro init`: --not-a-real-flag/);
});

test('an explicit path that does not exist, or is not a directory, fails with a clear message instead of proceeding', async () => {
  const missing = await runInstalledCli(['analyze', '/no/such/klauro-cli-test-path']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stdout + missing.stderr, /path does not exist/);

  const notADir = await runInstalledCli(['analyze', __filename]);
  assert.notEqual(notADir.status, 0);
  assert.match(notADir.stdout + notADir.stderr, /path is not a directory/);
});
