import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { EchoAnalyzer } from './echo-analyzer';

async function makeFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-analyzer-'));
  await fs.writeFile(
    path.join(root, 'go.mod'),
    `module echo-app\n\ngo 1.21\n\nrequire github.com/labstack/echo/v4 v4.11.4\n`
  );
  await fs.writeFile(
    path.join(root, 'main.go'),
    `package main

import "github.com/labstack/echo/v4"

func main() {
	e := echo.New()
	e.GET("/health", HealthHandler)
	e.POST("/login", LoginHandler, AuthMiddleware)

	api := e.Group("/api")
	api.Use(AuthMiddleware)
	{
		api.GET("/users", ListUsers)
		api.POST("/users", CreateUser)

		admin := api.Group("/admin")
		admin.Use(RequireAdmin)
		{
			admin.DELETE("/users/:id", DeleteUser)
		}
	}

	e.Logger.Fatal(e.Start(":1323"))
}

func HealthHandler(c echo.Context) error { return nil }
func LoginHandler(c echo.Context) error  { return nil }
func ListUsers(c echo.Context) error     { return nil }
func CreateUser(c echo.Context) error    { return nil }
func DeleteUser(c echo.Context) error    { return nil }
func AuthMiddleware(next echo.HandlerFunc) echo.HandlerFunc { return next }
func RequireAdmin(next echo.HandlerFunc) echo.HandlerFunc   { return next }
`
  );
  return root;
}

test('EchoAnalyzer.canAnalyze detects an echo dependency + route usage', async () => {
  const root = await makeFixture();
  const analyzer = new EchoAnalyzer();
  assert.equal(await analyzer.canAnalyze(root), true);
  await fs.remove(root);
});

test('EchoAnalyzer.canAnalyze rejects a project without echo', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-analyzer-neg-'));
  await fs.writeFile(path.join(root, 'go.mod'), `module x\n\ngo 1.21\n`);
  const analyzer = new EchoAnalyzer();
  assert.equal(await analyzer.canAnalyze(root), false);
  await fs.remove(root);
});

test('EchoAnalyzer extracts routes, resolves nested Group() prefixes and Use() guards', async () => {
  const root = await makeFixture();
  const analyzer = new EchoAnalyzer();
  const contribution = await analyzer.analyze({ projectPath: root, filters: [] } as any);
  const routes = (contribution.entry_points || []).map(ep => ({
    method: ep.metadata?.method,
    path: ep.metadata?.path,
    handler: ep.metadata?.handler,
    guards: ep.metadata?.guards,
    authenticated: ep.security?.authenticated,
  }));

  assert.equal(routes.length, 5);

  const health = routes.find(r => r.path === '/health');
  assert.deepEqual(health, { method: 'GET', path: '/health', handler: 'HealthHandler', guards: [], authenticated: false });

  const login = routes.find(r => r.path === '/login');
  assert.equal(login?.authenticated, true);
  assert.deepEqual(login?.guards, ['AuthMiddleware']);

  const listUsers = routes.find(r => r.path === '/api/users' && r.method === 'GET');
  assert.equal(listUsers?.handler, 'ListUsers');
  assert.deepEqual(listUsers?.guards, ['AuthMiddleware']);

  const deleteUser = routes.find(r => r.path === '/api/admin/users/:id');
  assert.equal(deleteUser?.handler, 'DeleteUser');
  assert.deepEqual(deleteUser?.guards, ['AuthMiddleware', 'RequireAdmin']);
  assert.equal(deleteUser?.authenticated, true);

  await fs.remove(root);
});

test('EchoAnalyzer returns an empty-but-valid contribution when no routes are found', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-analyzer-empty-'));
  await fs.writeFile(path.join(root, 'go.mod'), `module x\n\ngo 1.21\n\nrequire github.com/labstack/echo/v4 v4.11.4\n`);
  await fs.writeFile(path.join(root, 'main.go'), `package main\n\nfunc main() {}\n`);
  const analyzer = new EchoAnalyzer();
  const contribution = await analyzer.analyze({ projectPath: root, filters: [] } as any);
  assert.equal((contribution.entry_points || []).length, 0);
  await fs.remove(root);
});
