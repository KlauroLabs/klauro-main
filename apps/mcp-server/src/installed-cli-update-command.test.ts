import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { REMOTE_ANALYSIS_PROTOCOL_VERSION, clientUpgradeRequiredMessage } from './remote-analyzer-protocol';
import { KLAURO_INSTALL_ONELINER, SELF_UPDATE_COMMANDS, resolveTarballUrl } from './self-update';

// --- P0 (2026-07-27 live comprehension audit) --------------------------------
// The hosted server started rejecting protocol-1 clients with HTTP 426 and the
// remediation "Run klauro update and restart the MCP client". No released CLI
// had an `update` command: the customer binary is built from installed-cli.ts
// (build-bundle.mjs), the command only ever existed in the developer entry
// point cli.ts, so `klauro update` printed the usage block and exited 0. Every
// installed client was bricked behind an instruction that did nothing.
//
// These tests pin BOTH halves: the shipped entry point implements the command,
// and the server's remediation text only names commands that exist.

const installedCliSource = path.join(__dirname, 'installed-cli.ts');
// Exercise the BUILT customer artifact, not the source: the whole defect was
// that dist/cli.cjs is produced from a different entry point than the CLI the
// team develops against. This file is registered in scripts/test-suite.mjs's
// artifactTestFiles so the bundle is built before it runs.
const shippedCli = path.join(__dirname, '..', 'dist', 'cli.cjs');

/** Synchronous form — safe only when the CLI needs no in-process server. */
function runInstalledCliSync(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [shippedCli, ...args], { encoding: 'utf8', timeout: 60_000 });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

/** Async form — REQUIRED whenever the CLI talks to the manifest server below:
 *  spawnSync blocks this process's event loop, so an in-process http server
 *  could never answer the child and both sides would deadlock. */
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

async function withManifestServer<T>(
  manifest: unknown,
  body: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = http.createServer((request, response) => {
    if (request.url === '/dist/latest.json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(manifest));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    return await body(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test('the SHIPPED cli entry point implements `update` — it must not fall through to the usage block', async () => {
  await withManifestServer({ version: '9.9.9', tarball_path: '/dist/klauro-latest.tgz' }, async baseUrl => {
    const result = await runInstalledCli(['update', '--check', '--json', '--server-url', baseUrl]);
    assert.equal(result.status, 0, `update exited ${result.status}: ${result.stderr}`);
    assert.doesNotMatch(
      result.stdout,
      /Usage: klauro <command>/,
      'klauro update printed the usage block — the command is not registered in installed-cli.ts',
    );
    const payload = JSON.parse(result.stdout) as { latest: string; current: string; up_to_date: boolean };
    assert.equal(payload.latest, '9.9.9');
    assert.equal(payload.up_to_date, false);
    assert.equal(typeof payload.current, 'string');
  });
});

test('every self-update alias is registered in the shipped CLI', async () => {
  await withManifestServer({ version: '9.9.9' }, async baseUrl => {
    for (const command of SELF_UPDATE_COMMANDS) {
      const result = await runInstalledCli([command, '--check', '--json', '--server-url', baseUrl]);
      assert.doesNotMatch(result.stdout, /Usage: klauro <command>/, `\`klauro ${command}\` fell through to usage`);
      assert.equal(JSON.parse(result.stdout).latest, '9.9.9');
    }
  });
});

test('the shipped help text advertises update and the reinstall fallback', () => {
  const help = runInstalledCliSync([]).stdout;
  assert.match(help, /^\s+update /m);
  assert.ok(help.includes(KLAURO_INSTALL_ONELINER), 'help must name the reinstall one-liner');
});

test('the HTTP 426 remediation only names commands the shipped CLI implements', () => {
  const message = clientUpgradeRequiredMessage();
  assert.match(message, new RegExp(`protocol ${REMOTE_ANALYSIS_PROTOCOL_VERSION}`));

  const source = readFileSync(installedCliSource, 'utf8');
  const named = [...message.matchAll(/`klauro ([a-z-]+)/g)].map(match => match[1]);
  assert.ok(named.length > 0, 'the remediation must name at least one command');
  for (const command of named) {
    const registered = (SELF_UPDATE_COMMANDS as readonly string[]).includes(command)
      ? source.includes('SELF_UPDATE_COMMANDS')
      : source.includes(`command === '${command}'`);
    assert.ok(registered, `426 remediation names \`klauro ${command}\`, which installed-cli.ts does not implement`);
  }
  // And the escape hatch for clients too old to have the command at all.
  assert.ok(message.includes(KLAURO_INSTALL_ONELINER), '426 remediation must include the reinstall one-liner');
});

test('resolveTarballUrl honours the hosted manifest tarball_path instead of always defaulting', () => {
  assert.equal(
    resolveTarballUrl('https://mcp.klauro.com', { version: '1', tarball_path: '/dist/klauro-latest.tgz' }),
    'https://mcp.klauro.com/dist/klauro-latest.tgz',
  );
  assert.equal(
    resolveTarballUrl('https://mcp.klauro.com/', { version: '1', tarball_path: '/dist/klauro-1.2.3.tgz' }),
    'https://mcp.klauro.com/dist/klauro-1.2.3.tgz',
  );
  assert.equal(
    resolveTarballUrl('https://mcp.klauro.com', { version: '1', tarball: 'https://cdn.example/klauro.tgz' }),
    'https://cdn.example/klauro.tgz',
  );
  assert.equal(
    resolveTarballUrl('https://mcp.klauro.com', null),
    'https://mcp.klauro.com/dist/klauro-latest.tgz',
  );
});
