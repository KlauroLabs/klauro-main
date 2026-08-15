import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

// --- P0 (live comprehension audit) -------------------------------------------
// Every MCP tool call returned the string `fetch failed` for an entire session
// while raw HTTPS to the same host from the same machine returned 200. The
// whole hosted tool surface — the product's primary interface for agents — was
// dead, and ~3,700 tests saw none of it: they exercise the server's HTTP
// handlers and the library functions directly, never the MCP transport a
// client actually speaks, and never the failure text an agent actually reads.
//
// This file closes both halves of that blind spot:
//
//   1. TRANSPARENCY (deterministic, no network). Drive the BUILT bundle over
//      stdio exactly as a registered MCP client does, force a transport
//      failure, and assert the message names the cause, the target, and a real
//      remediation command. `fetch failed` reaching an agent is a product
//      defect whatever caused it: it leaves the agent with no next step.
//
//   2. REACHABILITY (live). Drive the same bundle against the real deployed
//      server and assert representative tools return structured success. This
//      is the assertion whose absence let "the MCP surface is down while HTTP
//      is fine" ship unnoticed.
//
// Both halves run the built artifact, never the sources: the client that
// customers and agents run is dist/index.cjs, and a source-level test cannot
// observe a bundle that no longer matches its sources. This file is registered
// in scripts/test-suite.mjs's artifactTestFiles so the bundle is built first.

const packageRoot = path.join(__dirname, '..');
const bundleEntry = path.join(packageRoot, 'dist', 'index.cjs');

// The suite isolates HOME per test file, which hides the real credential
// store. os.userInfo() reads the account database rather than the environment,
// so it still resolves the operator's actual home — the only place a live
// credential can legitimately come from.
function realHome(): string {
  try {
    return os.userInfo().homedir;
  } catch {
    return process.env.KLAURO_REAL_HOME || '';
  }
}

interface LiveCredential { serverUrl: string; home: string }

function findLiveCredential(): LiveCredential | null {
  const home = realHome();
  if (!home) return null;
  try {
    const store = JSON.parse(fs.readFileSync(path.join(home, '.klauro', 'auth.json'), 'utf8')) as {
      accounts?: Record<string, { token?: string }>;
      defaultServerUrl?: string;
    };
    const accounts = store.accounts || {};
    const preferred = store.defaultServerUrl && accounts[store.defaultServerUrl] ? store.defaultServerUrl : undefined;
    const serverUrl = preferred || Object.keys(accounts).find(url => accounts[url]?.token);
    if (!serverUrl || !accounts[serverUrl]?.token) return null;
    return { serverUrl: serverUrl.replace(/\/+$/, ''), home };
  } catch {
    return null;
  }
}

/** A repo bound to a hosted project, written into a temp dir so the fixture
 *  cannot inherit this repo's own configuration by walking upward. */
function writeBoundRepo(serverUrl: string, projectId: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-mcp-e2e-'));
  fs.writeFileSync(path.join(root, '.klaurorc'), JSON.stringify({
    version: 1,
    kind: 'project',
    project: { name: 'mcp-surface-e2e', id: projectId },
    analyzer: { serverUrl, selfHosted: false },
    policy: { allowRemoteAnalyzer: true },
  }, null, 2));
  return root;
}

/** Minimal MCP stdio client: the transport under test is the one a registered
 *  client speaks, so the test speaks it too rather than importing the server. */
class McpStdioClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, (message: any) => void>();
  private buffer = '';
  private nextId = 0;
  stderr = '';

  constructor(environment: NodeJS.ProcessEnv) {
    this.child = spawn(process.execPath, [bundleEntry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: environment,
    }) as ChildProcessWithoutNullStreams;
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk.toString();
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        let message: any;
        try { message = JSON.parse(line); } catch { continue; }
        const resolve = this.pending.get(message.id);
        if (resolve) { this.pending.delete(message.id); resolve(message); }
      }
    });
    this.child.stderr.on('data', chunk => { this.stderr += chunk.toString(); });
  }

  request(method: string, params?: unknown, timeoutMs = 120_000): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out after ${timeoutMs}ms. stderr: ${this.stderr.slice(-500) || '(none)'}`));
      }, timeoutMs);
      this.pending.set(id, message => { clearTimeout(timer); resolve(message); });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method: string): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }

  async initialize(): Promise<any> {
    const result = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'klauro-mcp-surface-gate', version: '1' },
    });
    this.notify('notifications/initialized');
    // The entry point answers `initialize` from a captured handshake and hands
    // stdio to the real server a moment later; a tool call issued in that
    // window is queued, not lost, but the settle keeps failures attributable.
    await new Promise(resolve => setTimeout(resolve, 1_500));
    return result;
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<{ isError: boolean; text: string }> {
    const message = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    const text = (message.result?.content || []).map((part: any) => part?.text ?? '').join('');
    return { isError: Boolean(message.result?.isError) || Boolean(message.error), text: text || JSON.stringify(message.error ?? {}) };
  }

  close(): void {
    this.child.kill();
  }
}

async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

test('a transport failure on the MCP surface never reaches an agent as an opaque message', async () => {
  assert.ok(fs.existsSync(bundleEntry), `${bundleEntry} does not exist — the bundle must be built before this gate runs`);
  const port = await closedPort();
  const repo = writeBoundRepo(`http://127.0.0.1:${port}`, 'prj_transport_gate');
  const client = new McpStdioClient({
    ...process.env,
    // Keep the retry ladder from dominating the fast tier; the ladder itself
    // is covered by hosted-transport.test.ts.
    KLAURO_HOSTED_RETRY_DELAY_MS: '0',
    KLAURO_HOSTED_REQUEST_TIMEOUT_MS: '5000',
  });
  try {
    const initialized = await client.initialize();

    // The handshake's serverInfo.version is the ONLY version an agent-side
    // user or a bug report can read off the MCP connection — it must carry
    // the real build identity, not a hardcoded placeholder. installed-client-
    // server.ts used to construct its McpServer with a literal '1.0.0',
    // meaning every issue filed against the MCP surface carried a meaningless
    // version regardless of what `klauro version` actually reported.
    const reportedVersion = initialized.result?.serverInfo?.version;
    assert.ok(reportedVersion, `initialize returned no serverInfo.version: ${JSON.stringify(initialized).slice(0, 400)}`);
    assert.notEqual(reportedVersion, '1.0.0', 'serverInfo.version is the hardcoded placeholder, not the real build identity');
    assert.match(reportedVersion, /^\d+\.\d+\.\d+\+[0-9a-f]+(-dirty)?$/, `serverInfo.version does not look like a real build identity (version+sha): ${reportedVersion}`);

    // Both hosted call shapes: the read path and the query path. They are
    // separate functions, and the defect was that BOTH reported nothing.
    for (const [tool, args] of [
      ['get_summary', { path: repo }],
      ['search_nodes', { path: repo, query: 'anything' }],
    ] as const) {
      const response = await client.callTool(tool, args as Record<string, unknown>, 60_000);
      assert.ok(response.isError, `${tool} against a closed port must report an error`);
      const text = response.text;

      assert.notEqual(text.trim(), 'fetch failed', `${tool} reported the bare string "fetch failed" — an agent receiving this has no next step`);
      assert.ok(
        /ECONNREFUSED|ECONNRESET|connect|refused/i.test(text),
        `${tool} error names no underlying cause; an agent cannot tell a misconfiguration from an outage. Got: ${text}`,
      );
      assert.ok(text.includes(`127.0.0.1:${port}`), `${tool} error names no target URL. Got: ${text}`);
      assert.ok(/`klauro [a-z-]+`/.test(text), `${tool} error names no remediation command. Got: ${text}`);
    }
  } finally {
    client.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

const liveTest = process.env.KLAURO_RUN_LIVE_TESTS === '1' ? test : test.skip;

liveTest('the MCP surface answers representative hosted tools against the deployed server', async () => {
  const credential = findLiveCredential();
  assert.ok(credential, 'no installed Klauro account is available for the explicit live MCP gate');
  assert.ok(fs.existsSync(bundleEntry), `${bundleEntry} does not exist — the bundle must be built before this gate runs`);

  // A repo already bound to a hosted project on that server. This test proves
  // reachability of the MCP surface, not analysis quality, so it uses this
  // package's own binding rather than uploading anything.
  const boundRepoRoot = path.resolve(packageRoot, '..', '..');
  const configPath = path.join(boundRepoRoot, '.klaurorc');
  assert.ok(fs.existsSync(configPath), `${boundRepoRoot} has no .klaurorc project binding for the explicit live MCP gate`);
  const bound = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { project?: { id?: string }; analyzer?: { serverUrl?: string } };
  assert.ok(bound.project?.id, `${configPath} has no hosted project id`);
  assert.equal(
    (bound.analyzer?.serverUrl || '').replace(/\/+$/, ''),
    credential.serverUrl,
    `${configPath} is bound to a different hosted server than the installed account`,
  );

  const client = new McpStdioClient({ ...process.env, HOME: credential.home, USERPROFILE: credential.home });
  try {
    const initialized = await client.initialize();
    assert.ok(initialized.result?.serverInfo?.name, `initialize returned no serverInfo: ${JSON.stringify(initialized).slice(0, 400)}`);

    const listed = await client.request('tools/list');
    const tools: Array<{ name: string }> = listed.result?.tools || [];
    assert.ok(tools.length > 0, 'the MCP surface advertised zero tools');

    // One tool per hosted call shape. If the surface is dead, all of these
    // fail together — which is exactly the shape of the outage this gates.
    const probes: Array<[string, Record<string, unknown>]> = [
      ['resolve_agent_analysis', { path: boundRepoRoot }],
      ['get_summary', { path: boundRepoRoot }],
      ['search_nodes', { path: boundRepoRoot, query: 'server', limit: 3 }],
    ];
    for (const [tool, args] of probes) {
      const response = await client.callTool(tool, args, 180_000);
      assert.ok(
        !response.isError,
        `${tool} failed against ${credential.serverUrl}: ${response.text.slice(0, 600)}`,
      );
      let parsed: unknown;
      assert.doesNotThrow(() => { parsed = JSON.parse(response.text); }, `${tool} returned a non-JSON payload: ${response.text.slice(0, 300)}`);
      assert.equal(typeof parsed, 'object', `${tool} returned no structured payload`);
      assert.notEqual(parsed, null, `${tool} returned null`);
    }
  } finally {
    client.close();
  }
});
