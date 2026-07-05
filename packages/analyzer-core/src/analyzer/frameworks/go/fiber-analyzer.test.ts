import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { FiberAnalyzer } from './fiber-analyzer';

async function makeFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fiber-analyzer-'));
  await fs.writeFile(
    path.join(root, 'go.mod'),
    `module fiber-app\n\ngo 1.21\n\nrequire github.com/gofiber/fiber/v2 v2.52.0\n`
  );
  await fs.writeFile(
    path.join(root, 'main.go'),
    `package main

import "github.com/gofiber/fiber/v2"

func main() {
	app := fiber.New()
	app.Get("/health", HealthHandler)
	app.Post("/login", AuthMiddleware, LoginHandler)

	api := app.Group("/api")
	api.Use(AuthMiddleware)
	{
		api.Get("/users", ListUsers)
		api.Post("/users", CreateUser)

		admin := api.Group("/admin")
		admin.Use(RequireAdmin)
		{
			admin.Delete("/users/:id", DeleteUser)
		}
	}

	app.Listen(":3000")
}

func HealthHandler(c *fiber.Ctx) error  { return nil }
func LoginHandler(c *fiber.Ctx) error   { return nil }
func ListUsers(c *fiber.Ctx) error      { return nil }
func CreateUser(c *fiber.Ctx) error     { return nil }
func DeleteUser(c *fiber.Ctx) error     { return nil }
func AuthMiddleware(c *fiber.Ctx) error { return c.Next() }
func RequireAdmin(c *fiber.Ctx) error   { return c.Next() }
`
  );
  return root;
}

test('FiberAnalyzer.canAnalyze detects a fiber dependency + route usage', async () => {
  const root = await makeFixture();
  const analyzer = new FiberAnalyzer();
  assert.equal(await analyzer.canAnalyze(root), true);
  await fs.remove(root);
});

test('FiberAnalyzer.canAnalyze rejects a project without fiber', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fiber-analyzer-neg-'));
  await fs.writeFile(path.join(root, 'go.mod'), `module x\n\ngo 1.21\n`);
  const analyzer = new FiberAnalyzer();
  assert.equal(await analyzer.canAnalyze(root), false);
  await fs.remove(root);
});

test('FiberAnalyzer extracts routes, resolves nested Group() prefixes and Use() guards', async () => {
  const root = await makeFixture();
  const analyzer = new FiberAnalyzer();
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

test('FiberAnalyzer returns an empty-but-valid contribution when no routes are found', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fiber-analyzer-empty-'));
  await fs.writeFile(path.join(root, 'go.mod'), `module x\n\ngo 1.21\n\nrequire github.com/gofiber/fiber/v2 v2.52.0\n`);
  await fs.writeFile(path.join(root, 'main.go'), `package main\n\nfunc main() {}\n`);
  const analyzer = new FiberAnalyzer();
  const contribution = await analyzer.analyze({ projectPath: root, filters: [] } as any);
  assert.equal((contribution.entry_points || []).length, 0);
  await fs.remove(root);
});
