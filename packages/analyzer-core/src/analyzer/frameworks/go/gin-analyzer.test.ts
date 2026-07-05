import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { GinAnalyzer } from './gin-analyzer';

async function makeFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gin-analyzer-'));
  await fs.writeFile(
    path.join(root, 'go.mod'),
    `module gin-app\n\ngo 1.21\n\nrequire github.com/gin-gonic/gin v1.9.1\n`
  );
  await fs.writeFile(
    path.join(root, 'main.go'),
    `package main

import "github.com/gin-gonic/gin"

func main() {
	r := gin.Default()
	r.GET("/health", HealthHandler)
	r.POST("/login", AuthMiddleware, LoginHandler)

	v1 := r.Group("/api/v1")
	v1.Use(AuthMiddleware)
	{
		v1.GET("/users", ListUsers)
		v1.POST("/users", CreateUser)

		admin := v1.Group("/admin")
		admin.Use(RequireAdmin)
		{
			admin.DELETE("/users/:id", DeleteUser)
		}
	}

	r.Run(":8080")
}

func HealthHandler(c *gin.Context)  {}
func LoginHandler(c *gin.Context)   {}
func ListUsers(c *gin.Context)      {}
func CreateUser(c *gin.Context)     {}
func DeleteUser(c *gin.Context)     {}
func AuthMiddleware(c *gin.Context) {}
func RequireAdmin(c *gin.Context)   {}
`
  );
  return root;
}

test('GinAnalyzer.canAnalyze detects a gin.mod dependency + route usage', async () => {
  const root = await makeFixture();
  const analyzer = new GinAnalyzer();
  assert.equal(await analyzer.canAnalyze(root), true);
  await fs.remove(root);
});

test('GinAnalyzer.canAnalyze rejects a project without gin', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gin-analyzer-neg-'));
  await fs.writeFile(path.join(root, 'go.mod'), `module x\n\ngo 1.21\n`);
  const analyzer = new GinAnalyzer();
  assert.equal(await analyzer.canAnalyze(root), false);
  await fs.remove(root);
});

test('GinAnalyzer extracts routes, resolves nested Group() prefixes and Use() guards', async () => {
  const root = await makeFixture();
  const analyzer = new GinAnalyzer();
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

  const listUsers = routes.find(r => r.path === '/api/v1/users' && r.method === 'GET');
  assert.equal(listUsers?.handler, 'ListUsers');
  assert.deepEqual(listUsers?.guards, ['AuthMiddleware']);

  const deleteUser = routes.find(r => r.path === '/api/v1/admin/users/:id');
  assert.equal(deleteUser?.handler, 'DeleteUser');
  assert.deepEqual(deleteUser?.guards, ['AuthMiddleware', 'RequireAdmin']);
  assert.equal(deleteUser?.authenticated, true);

  await fs.remove(root);
});

test('GinAnalyzer returns an empty-but-valid contribution when no routes are found', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gin-analyzer-empty-'));
  await fs.writeFile(path.join(root, 'go.mod'), `module x\n\ngo 1.21\n\nrequire github.com/gin-gonic/gin v1.9.1\n`);
  await fs.writeFile(path.join(root, 'main.go'), `package main\n\nfunc main() {}\n`);
  const analyzer = new GinAnalyzer();
  const contribution = await analyzer.analyze({ projectPath: root, filters: [] } as any);
  assert.equal((contribution.entry_points || []).length, 0);
  await fs.remove(root);
});
