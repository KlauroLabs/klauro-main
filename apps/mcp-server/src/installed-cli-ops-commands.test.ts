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
  const result = runInstalledCliSync(['support-bundle', '--json']);
  assert.doesNotMatch(result.stdout, /Usage: klauro <command>/, '`klauro support-bundle` printed the usage block — the command is not registered in installed-cli.ts');
  const payload = JSON.parse(result.stdout) as { bundle_path: string; included: unknown[]; excluded: string[] };
  assert.equal(typeof payload.bundle_path, 'string');
  assert.ok(Array.isArray(payload.excluded) && payload.excluded.length > 0, 'support bundle must document what it deliberately excludes');
  // Redaction: no secret-shaped value should ever appear in the manifest text.
  assert.doesNotMatch(JSON.stringify(payload), /sk-[a-zA-Z0-9]{10,}/, 'support bundle must not leak an API-key-shaped value');
});

test('the shipped help text advertises status, doctor, and support-bundle', () => {
  const help = runInstalledCliSync([]).stdout;
  assert.match(help, /status \[path\]/);
  assert.match(help, /doctor \[path\]/);
  assert.match(help, /support-bundle \[path\]/);
});
