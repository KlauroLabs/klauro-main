import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

import { missingEmailMessage, missingPasswordMessage } from './password-prompt';
import { getStaleClientUpdateHint, isNewerVersion, updateCheckCachePath } from './stale-client-hint';

/**
 * Regression coverage for the 2026-08-09 first-run incident:
 *  - `klauro login --register` with nothing else must PROMPT, never demand
 *    flags up front.
 *  - A non-interactive/CI invocation must fail fast with an instruction to
 *    use --password-stdin, and must never hang waiting on stdin that will
 *    never arrive.
 *  - A client older than the published release must say so, alongside (not
 *    instead of) the real error, without ever blocking a normal invocation
 *    on a network call.
 *  - Help text must describe the actual (prompting) behavior, not the old
 *    flag-required behavior.
 *
 * No test here uses a real credential, real email, or creates a real
 * account — every server-url points at an unroutable/local address, and
 * every login attempt fails at the network hop (fetch error / refused
 * connection), which is exactly the point: we are proving the CLI's own
 * input handling, not exercising a live auth backend.
 */

const packageRoot = path.join(__dirname, '..');
const shippedCli = path.join(packageRoot, 'dist', 'cli.cjs');
const devCli = path.join(__dirname, '..', 'src', 'cli.ts');

test('the built dist/cli.cjs exists (build it with `npm run build` in apps/mcp-server before running this file)', () => {
  assert.ok(fs.existsSync(shippedCli), `${shippedCli} is missing — run \`npm run build\` in apps/mcp-server first`);
});

function tmpAuthDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-firstrun-auth-'));
}

function runShippedCli(args: string[], extraEnv: NodeJS.ProcessEnv = {}, timeoutMs = 8_000): Promise<{ status: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [shippedCli, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr, timedOut }); });
  });
}

// ---------------------------------------------------------------------------
// Non-TTY: must fail fast, must name --password-stdin, must never hang.
// ---------------------------------------------------------------------------

test('non-TTY `klauro login --register` with no flags fails fast with a --password-stdin instruction, never hangs', async () => {
  const authDir = tmpAuthDir();
  try {
    const start = Date.now();
    const result = await runShippedCli(
      ['login', '--register', '--server-url', 'https://127.0.0.1:1'],
      { KLAURO_AUTH_CONFIG_PATH: path.join(authDir, 'auth.json') },
    );
    const elapsedMs = Date.now() - start;
    assert.equal(result.timedOut, false, 'the command hung waiting on stdin instead of failing fast');
    assert.ok(elapsedMs < 5_000, `took ${elapsedMs}ms — should fail near-instantly on non-TTY stdin`);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /--password-stdin/, 'must name --password-stdin as the non-interactive path');
    assert.match(result.stdout + result.stderr, /email address/i);
    // Not a raw validator complaint anymore.
    assert.doesNotMatch(result.stdout + result.stderr, /login requires --email/);
  } finally {
    fs.rmSync(authDir, { recursive: true, force: true });
  }
});

test('non-TTY `klauro login` (no --register) with only --email still needs a password and says so with --password-stdin', async () => {
  const authDir = tmpAuthDir();
  try {
    const result = await runShippedCli(
      ['login', '--email', 'nobody@example.com', '--server-url', 'https://127.0.0.1:1'],
      { KLAURO_AUTH_CONFIG_PATH: path.join(authDir, 'auth.json') },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /--password-stdin/);
    assert.match(result.stdout + result.stderr, /password/i);
    assert.doesNotMatch(result.stdout + result.stderr, /login requires --password/);
  } finally {
    fs.rmSync(authDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Simulated TTY: `--register` alone must prompt for email then password,
// echo the email but never the password, and never demand flags up front.
// Uses `expect` (a real pty) to drive the actual shipped binary — this is
// an end-to-end proof, not a mock. The connecting server-url is
// unroutable, so the exchange always ends in a network failure rather than
// a real auth attempt; no credential used here is real and no account is
// created anywhere.
// ---------------------------------------------------------------------------

function expectAvailable(): boolean {
  try {
    execFileSync('which', ['expect'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('simulated TTY: `klauro login --register` with no other flags prompts for email then password (no echo)', { skip: !expectAvailable() ? 'expect(1) not available on this machine' : false }, async () => {
  const authDir = tmpAuthDir();
  const scriptPath = path.join(authDir, 'drive.exp');
  try {
    fs.writeFileSync(
      scriptPath,
      [
        'set timeout 10',
        `spawn env KLAURO_AUTH_CONFIG_PATH=${path.join(authDir, 'auth.json')} ${process.execPath} ${shippedCli} login --register --server-url https://127.0.0.1:1`,
        'expect "Email: "',
        'send "fixture-only-not-a-real-account@example.invalid\\r"',
        'expect "Password: "',
        'send "fixture-only-not-a-real-password\\r"',
        'expect eof',
      ].join('\n'),
      'utf8',
    );
    const result = spawnSync('expect', ['-f', scriptPath], { encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 0, `expect driver itself failed: ${result.stderr}`);
    const transcript = result.stdout;
    assert.match(transcript, /Email: /, 'must prompt for an email — --register did not demand --email up front');
    assert.match(transcript, /Password: /, 'must prompt for a password');
    // The email is echoed back by the terminal driver (normal line input);
    // the password must never appear anywhere in the transcript.
    assert.doesNotMatch(transcript, /fixture-only-not-a-real-password/, 'the password must never be echoed to the terminal');
  } finally {
    fs.rmSync(authDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Staleness-on-failure: a client older than the published release must
// surface an update hint ALONGSIDE the original error, using a local fixture
// manifest server (no dependency on the real mcp.klauro.com).
// ---------------------------------------------------------------------------

function startFixtureManifestServer(version: string): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url === '/dist/latest.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ version, install_command: 'curl -fsSL https://mcp.klauro.com/install.sh | sh' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise(r => server.close(() => r())) });
    });
  });
}

test('a failed command on a stale client surfaces an update hint alongside the original error', async () => {
  const authDir = tmpAuthDir();
  const fixture = await startFixtureManifestServer('99.0.0');
  try {
    const result = await runShippedCli(
      ['login', '--register', '--server-url', fixture.url],
      { KLAURO_AUTH_CONFIG_PATH: path.join(authDir, 'auth.json') },
    );
    assert.notEqual(result.status, 0);
    const combined = result.stdout + result.stderr;
    // The ORIGINAL error must still be present — the hint is an addition,
    // never a replacement.
    assert.match(combined, /email address/i);
    assert.match(combined, /99\.0\.0/, 'must name the newer available version');
    assert.match(combined, /klauro update/, 'must tell the user the update command to run');
  } finally {
    await fixture.close();
    fs.rmSync(authDir, { recursive: true, force: true });
  }
});

test('a failed command on a CURRENT client prints no stale-client note', async () => {
  const authDir = tmpAuthDir();
  // "0.0.1" always parses as older than any real running build, proving the
  // hint suppresses itself (rather than always firing) when nothing is stale.
  const fixture = await startFixtureManifestServer('0.0.1');
  try {
    const result = await runShippedCli(
      ['login', '--register', '--server-url', fixture.url],
      { KLAURO_AUTH_CONFIG_PATH: path.join(authDir, 'auth.json') },
    );
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout + result.stderr, /Note: this klauro client is/);
  } finally {
    await fixture.close();
    fs.rmSync(authDir, { recursive: true, force: true });
  }
});

test('an unreachable/offline server-url never hangs and never crashes the process', async () => {
  const authDir = tmpAuthDir();
  try {
    const start = Date.now();
    // A non-routable TEST-NET-1-adjacent address (RFC 5737-ish black hole);
    // chosen because it never resolves and connections stall rather than
    // fast-refuse, which is exactly the "offline" case that must stay bounded.
    const result = await runShippedCli(
      ['login', '--register', '--server-url', 'https://192.0.2.1:1'],
      { KLAURO_AUTH_CONFIG_PATH: path.join(authDir, 'auth.json') },
      8_000,
    );
    const elapsedMs = Date.now() - start;
    assert.equal(result.timedOut, false, 'the process hung instead of giving up on the offline check');
    assert.ok(elapsedMs < 8_000, `took ${elapsedMs}ms — the staleness check must be bounded`);
    assert.notEqual(result.status, 0);
    // No uncaught-exception stack trace (a crash), just the clean error text.
    assert.doesNotMatch(result.stderr, /at Object\.<anonymous>|UnhandledPromiseRejection/);
  } finally {
    fs.rmSync(authDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Help text vs behavior parity.
// ---------------------------------------------------------------------------

test('shipped help text for `login` matches actual (prompting) behavior, not the old flags-required text', () => {
  const help = spawnSync(process.execPath, [shippedCli], { encoding: 'utf8' }).stdout;
  assert.match(help, /login \[--email EMAIL\] \[--password-stdin \| --register\]/);
  assert.match(help, /Prompts for email\/password/i);
  // The pre-1.0.134 defect: help showed EMAIL/--password-stdin as bare
  // (unbracketed) required tokens on the `login` line, which is what made
  // `klauro login --register` with nothing else look invalid even though
  // the command actually prompts. Assert the specific bare/required shape
  // is gone from the `login` usage line, not just that a new line exists
  // alongside it.
  const loginUsageLine = help.split('\n').find(line => line.trim().startsWith('login '));
  assert.ok(loginUsageLine, 'no `login` line found in usage text');
  assert.doesNotMatch(loginUsageLine as string, /login --email EMAIL --password-stdin/, 'the `login` usage line must not show --email/--password-stdin as bare required tokens');
});

test('developer CLI (cli.ts) help text for `login` also reflects prompting, not a required --email', () => {
  const source = fs.readFileSync(devCli, 'utf8');
  assert.match(source, /klauro login \[--email you@example\.com\]/, 'cli.ts usage text must show --email as optional, matching runLoginCommand\'s prompting behavior');
});

// ---------------------------------------------------------------------------
// Message-builder unit tests (no process spawn — pure functions).
// ---------------------------------------------------------------------------

test('missingEmailMessage: non-interactive names --password-stdin path and threads --register', () => {
  const loginMsg = missingEmailMessage({ interactive: false, register: false });
  assert.match(loginMsg, /--password-stdin/);
  assert.match(loginMsg, /klauro login --email you@example\.com --password-stdin/);
  assert.doesNotMatch(loginMsg, /--register/);

  const registerMsg = missingEmailMessage({ interactive: false, register: true });
  assert.match(registerMsg, /klauro login --register --email you@example\.com --password-stdin/);
});

test('missingEmailMessage: interactive tells the user to enter one, not to pass a flag they already tried', () => {
  const msg = missingEmailMessage({ interactive: true, register: false });
  assert.match(msg, /Enter one/i);
});

test('missingPasswordMessage: non-interactive instructs piping, never suggests --password on the command line', () => {
  const msg = missingPasswordMessage({ interactive: false, register: true });
  assert.match(msg, /--password-stdin/);
  assert.match(msg, /pipe/i);
  assert.doesNotMatch(msg, /--password you@|--password '.*'/);
});

test('neither message is the old unshippable validator text', () => {
  for (const interactive of [true, false]) {
    for (const register of [true, false]) {
      assert.doesNotMatch(missingEmailMessage({ interactive, register }), /requires --email or an entered email/);
      assert.doesNotMatch(missingPasswordMessage({ interactive, register }), /requires --password, --password-stdin, or an entered password/);
    }
  }
});

// ---------------------------------------------------------------------------
// stale-client-hint.ts unit tests.
// ---------------------------------------------------------------------------

test('isNewerVersion: strict numeric compare, never true on malformed input', () => {
  assert.equal(isNewerVersion('1.0.136', '1.0.135'), true);
  assert.equal(isNewerVersion('1.0.135', '1.0.135'), false);
  assert.equal(isNewerVersion('1.0.134', '1.0.135'), false);
  assert.equal(isNewerVersion('2.0.0', '1.99.99'), true);
  assert.equal(isNewerVersion(null, '1.0.135'), false);
  assert.equal(isNewerVersion('not-a-version', '1.0.135'), false);
});

test('getStaleClientUpdateHint: never throws and returns null when the server is unreachable with no prior cache', async () => {
  const authDir = tmpAuthDir();
  const originalPath = process.env.KLAURO_AUTH_CONFIG_PATH;
  process.env.KLAURO_AUTH_CONFIG_PATH = path.join(authDir, 'auth.json');
  try {
    assert.equal(fs.existsSync(updateCheckCachePath()), false);
    const hint = await getStaleClientUpdateHint({
      serverUrl: 'https://192.0.2.1:1',
      currentVersion: '1.0.135',
      timeoutMs: 300,
    });
    assert.equal(hint, null);
  } finally {
    if (originalPath) process.env.KLAURO_AUTH_CONFIG_PATH = originalPath; else delete process.env.KLAURO_AUTH_CONFIG_PATH;
    fs.rmSync(authDir, { recursive: true, force: true });
  }
});

test('getStaleClientUpdateHint: caches within TTL, so a second call makes no second network request', async () => {
  const authDir = tmpAuthDir();
  const originalPath = process.env.KLAURO_AUTH_CONFIG_PATH;
  process.env.KLAURO_AUTH_CONFIG_PATH = path.join(authDir, 'auth.json');
  const fixture = await startFixtureManifestServer('1.0.200');
  let requestCount = 0;
  const server = fixture as unknown as { url: string; close: () => Promise<void> };
  // Wrap fetch to count calls to this fixture only, so the cache assertion
  // is about THIS module's behavior, not about the test's own bookkeeping.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    requestCount += 1;
    return originalFetch(...args);
  }) as typeof fetch;
  try {
    const first = await getStaleClientUpdateHint({ serverUrl: server.url, currentVersion: '1.0.100' });
    const second = await getStaleClientUpdateHint({ serverUrl: server.url, currentVersion: '1.0.100' });
    assert.match(first || '', /1\.0\.200/);
    assert.equal(first, second);
    assert.equal(requestCount, 1, 'a second call within the cache TTL must not hit the network again');
  } finally {
    globalThis.fetch = originalFetch;
    await server.close();
    if (originalPath) process.env.KLAURO_AUTH_CONFIG_PATH = originalPath; else delete process.env.KLAURO_AUTH_CONFIG_PATH;
    fs.rmSync(authDir, { recursive: true, force: true });
  }
});

test('getStaleClientUpdateHint: a client on the current version gets no hint', async () => {
  const authDir = tmpAuthDir();
  const originalPath = process.env.KLAURO_AUTH_CONFIG_PATH;
  process.env.KLAURO_AUTH_CONFIG_PATH = path.join(authDir, 'auth.json');
  const fixture = await startFixtureManifestServer('1.0.100');
  try {
    const hint = await getStaleClientUpdateHint({ serverUrl: fixture.url, currentVersion: '1.0.100' });
    assert.equal(hint, null);
  } finally {
    await fixture.close();
    if (originalPath) process.env.KLAURO_AUTH_CONFIG_PATH = originalPath; else delete process.env.KLAURO_AUTH_CONFIG_PATH;
    fs.rmSync(authDir, { recursive: true, force: true });
  }
});
