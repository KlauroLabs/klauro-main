import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { KtorAnalyzer } from './ktor-analyzer';

function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ktor-analyzer-test-'));
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });

  const app = [
    'package demo',
    '',
    'import io.ktor.server.application.*',
    'import io.ktor.server.routing.*',
    'import io.ktor.server.plugins.contentnegotiation.*',
    'import io.ktor.server.auth.*',
    '',
    'fun Application.module() {',
    '    install(ContentNegotiation) {}',
    '    routing {',
    '        get("/health") {',
    '            call.respond("ok")',
    '        }',
    '        route("/api") {',
    '            authenticate("auth") {',
    '                post("/users") {',
    '                    val body = call.receive<String>()',
    '                }',
    '            }',
    '        }',
    '    }',
    '}',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(srcDir, 'Application.kt'), app);

  return dir;
}

test('KtorAnalyzer.canAnalyze returns true for a Ktor project', async () => {
  const dir = makeTempProject();
  try {
    const analyzer = new KtorAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('KtorAnalyzer.analyze extracts module, routes, auth, plugins', async () => {
  const dir = makeTempProject();
  try {
    const analyzer = new KtorAnalyzer();
    const cas = await analyzer.analyze({ projectPath: dir });

    // Application module entry point.
    const moduleEntry = cas.entry_points.find(ep => ep.metadata?.kind === 'module');
    assert.ok(moduleEntry, 'module entry point exists');
    assert.equal(moduleEntry!.metadata?.function, 'module', 'module function name is module');

    // Route GET /health.
    const health = cas.entry_points.find(
      ep => ep.metadata?.method === 'GET' && ep.metadata?.path === '/health'
    );
    assert.ok(health, 'GET /health route exists');
    assert.equal(health!.security?.authenticated, false, 'GET /health is not auth-gated');

    // Nested authenticated POST /api/users.
    const users = cas.entry_points.find(
      ep => ep.metadata?.method === 'POST' && ep.metadata?.path === '/api/users'
    );
    assert.ok(users, 'POST /api/users route exists with resolved prefix');
    assert.equal(users!.security?.authenticated, true, 'POST /api/users is auth-gated');
    assert.deepEqual(users!.security?.guards, ['auth'], 'auth name resolved from authenticate("auth")');

    // The route node for the authenticated route is tagged.
    const usersNode = cas.nodes.find(
      n => n.type === 'route' && n.metadata?.attributes?.path === '/api/users'
    );
    assert.ok(usersNode, 'POST /api/users route node exists');
    assert.ok(usersNode!.tags?.includes('auth-gated'), 'authenticated route node tagged auth-gated');

    // ContentNegotiation plugin node.
    const plugin = cas.nodes.find(n => n.type === 'plugin' && n.name === 'ContentNegotiation');
    assert.ok(plugin, 'ContentNegotiation plugin node exists');
    assert.equal(plugin!.metadata?.attributes?.security, false, 'ContentNegotiation is not a security plugin');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
