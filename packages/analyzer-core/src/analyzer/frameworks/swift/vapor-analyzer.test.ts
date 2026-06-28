import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { VaporAnalyzer } from './vapor-analyzer';

/** Write a throwaway Vapor project and return its path. */
async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vapor-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await fs.ensureDir(path.dirname(full));
    await fs.writeFile(full, content);
  }
  return dir;
}

async function routesOf(files: Record<string, string>) {
  const dir = await fixture(files);
  try {
    const analyzer = new VaporAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true, 'analyzer should detect the Vapor project');
    const contribution = await analyzer.analyze({ projectPath: dir } as any);
    return (contribution.entry_points || []).map(ep => ({
      key: `${ep.trigger?.method} ${ep.trigger?.path}`,
      auth: ep.security?.authenticated,
      handler: ep.metadata?.handler as string,
      type: ep.type,
    }));
  } finally {
    await fs.remove(dir);
  }
}

test('vapor: extracts top-level app routes with method + path + handler', async () => {
  const routes = await routesOf({
    'Sources/App/routes.swift': `import Vapor
func routes(_ app: Application) throws {
    app.get("health", use: health)
    app.post("login", use: login)
}`,
  });
  const byKey = new Map(routes.map(r => [r.key, r]));

  assert.ok(byKey.has('GET /health'), `expected GET /health, got ${JSON.stringify([...byKey.keys()])}`);
  assert.equal(byKey.get('GET /health')!.handler, 'health');
  assert.equal(byKey.get('GET /health')!.type, 'http');
  assert.equal(byKey.get('POST /login')!.handler, 'login');
  // No auth middleware -> unauthenticated.
  assert.equal(byKey.get('GET /health')!.auth, false);
});

test('vapor: resolves grouped path prefixes and multi-segment paths', async () => {
  const routes = await routesOf({
    'Sources/App/routes.swift': `import Vapor
func routes(_ app: Application) throws {
    let users = app.grouped("users")
    users.get(use: listUsers)
    users.get(":id", use: getUser)
    app.get("api", "v1", "ping", use: ping)
}`,
  });
  const keys = new Set(routes.map(r => r.key));
  assert.ok(keys.has('GET /users'), `grouped index route, got ${JSON.stringify([...keys])}`);
  assert.ok(keys.has('GET /users/:id'), 'grouped param route');
  assert.ok(keys.has('GET /api/v1/ping'), 'multi-segment path');
});

test('vapor: marks routes behind an authenticator group as authenticated', async () => {
  const routes = await routesOf({
    'Sources/App/routes.swift': `import Vapor
func routes(_ app: Application) throws {
    app.get("open", use: open)
    let protected = app.grouped(UserAuthenticator()).grouped(User.guardMiddleware())
    protected.get("me", use: me)
    let admin = app.grouped("admin").grouped(Token.authenticator())
    admin.delete("users", ":id", use: deleteUser)
}`,
  });
  const byKey = new Map(routes.map(r => [r.key, r]));

  assert.equal(byKey.get('GET /open')!.auth, false, 'ungrouped route is open');
  assert.equal(byKey.get('GET /me')!.auth, true, 'authenticator group route is authenticated');
  // Auth + path prefix compose: admin group has both "admin" prefix and a token authenticator.
  assert.equal(byKey.get('DELETE /admin/users/:id')!.auth, true, 'prefixed authenticator group');
});

test('vapor: handles .on(.METHOD, path) explicit-method form and inline closures', async () => {
  const routes = await routesOf({
    'Sources/App/routes.swift': `import Vapor
func routes(_ app: Application) throws {
    app.on(.GET, "stream", use: stream)
    app.post("echo") { req in return "hi" }
}`,
  });
  const byKey = new Map(routes.map(r => [r.key, r]));
  assert.equal(byKey.get('GET /stream')!.handler, 'stream');
  assert.ok(byKey.has('POST /echo'), 'inline trailing-closure route is captured');
  assert.equal(byKey.get('POST /echo')!.handler, 'closure');
});
