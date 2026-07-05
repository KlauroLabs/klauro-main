import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { ChiAnalyzer } from './chi-analyzer';

async function makeFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chi-analyzer-'));
  await fs.writeFile(
    path.join(root, 'go.mod'),
    `module chi-app\n\ngo 1.21\n\nrequire github.com/go-chi/chi/v5 v5.0.11\n`
  );
  await fs.writeFile(
    path.join(root, 'main.go'),
    `package main

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

func main() {
	r := chi.NewRouter()
	r.Get("/health", HealthHandler)
	r.Post("/login", LoginHandler)

	r.Route("/api", func(r chi.Router) {
		r.Use(AuthMiddleware)
		r.Get("/users", ListUsers)
		r.Post("/users", CreateUser)

		r.Route("/admin", func(r chi.Router) {
			r.Use(RequireAdmin)
			r.Delete("/users/{id}", DeleteUser)
		})
	})
}

func HealthHandler(w http.ResponseWriter, r *http.Request) {}
func LoginHandler(w http.ResponseWriter, r *http.Request)  {}
func ListUsers(w http.ResponseWriter, r *http.Request)     {}
func CreateUser(w http.ResponseWriter, r *http.Request)    {}
func DeleteUser(w http.ResponseWriter, r *http.Request)    {}
func AuthMiddleware(next http.Handler) http.Handler { return next }
func RequireAdmin(next http.Handler) http.Handler   { return next }
`
  );
  return root;
}

test('ChiAnalyzer.canAnalyze detects a chi dependency + route usage', async () => {
  const root = await makeFixture();
  const analyzer = new ChiAnalyzer();
  assert.equal(await analyzer.canAnalyze(root), true);
  await fs.remove(root);
});

test('ChiAnalyzer.canAnalyze rejects a project without chi', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chi-analyzer-neg-'));
  await fs.writeFile(path.join(root, 'go.mod'), `module x\n\ngo 1.21\n`);
  const analyzer = new ChiAnalyzer();
  assert.equal(await analyzer.canAnalyze(root), false);
  await fs.remove(root);
});

test('ChiAnalyzer extracts routes, resolves nested Route() prefixes and Use() guards without double-counting', async () => {
  const root = await makeFixture();
  const analyzer = new ChiAnalyzer();
  const contribution = await analyzer.analyze({ projectPath: root, filters: [] } as any);
  const routes = (contribution.entry_points || []).map(ep => ({
    method: ep.metadata?.method,
    path: ep.metadata?.path,
    handler: ep.metadata?.handler,
    guards: ep.metadata?.guards,
    authenticated: ep.security?.authenticated,
  }));

  // Exactly 5 — a prior bug double-counted the innermost /admin.Route() scope
  // because the nested-call finder matched Route()/Group() calls transitively
  // (regex over flattened text, not respecting brace nesting), yielding 6.
  assert.equal(routes.length, 5);

  const health = routes.find(r => r.path === '/health');
  assert.deepEqual(health, { method: 'GET', path: '/health', handler: 'HealthHandler', guards: [], authenticated: false });

  const login = routes.find(r => r.path === '/login');
  assert.deepEqual(login?.guards, []);
  assert.equal(login?.authenticated, false);

  const listUsers = routes.find(r => r.path === '/api/users' && r.method === 'GET');
  assert.equal(listUsers?.handler, 'ListUsers');
  assert.deepEqual(listUsers?.guards, ['AuthMiddleware']);

  const deleteUser = routes.find(r => r.path === '/api/admin/users/{id}');
  assert.equal(deleteUser?.handler, 'DeleteUser');
  assert.deepEqual(deleteUser?.guards, ['AuthMiddleware', 'RequireAdmin']);
  assert.equal(deleteUser?.authenticated, true);

  await fs.remove(root);
});

test('ChiAnalyzer returns an empty-but-valid contribution when no routes are found', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chi-analyzer-empty-'));
  await fs.writeFile(path.join(root, 'go.mod'), `module x\n\ngo 1.21\n\nrequire github.com/go-chi/chi/v5 v5.0.11\n`);
  await fs.writeFile(path.join(root, 'main.go'), `package main\n\nfunc main() {}\n`);
  const analyzer = new ChiAnalyzer();
  const contribution = await analyzer.analyze({ projectPath: root, filters: [] } as any);
  assert.equal((contribution.entry_points || []).length, 0);
  await fs.remove(root);
});
