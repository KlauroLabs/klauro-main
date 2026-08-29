import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { FastAPIAnalyzer } from './fastapi-analyzer';

test('FastAPIAnalyzer.canAnalyze detects a real FastAPI app (FastAPI() + @app.get)', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fastapi-analyzer-'));
  await fs.writeFile(
    path.join(root, 'main.py'),
    [
      'from fastapi import FastAPI',
      '',
      'app = FastAPI()',
      '',
      '@app.get("/users")',
      'def list_users():',
      '    return {"users": []}',
    ].join('\n')
  );
  const analyzer = new FastAPIAnalyzer();
  assert.equal(await analyzer.canAnalyze(root), true);
  await fs.remove(root);
});

test('FastAPIAnalyzer.canAnalyze rejects a pyproject.toml [project.optional-dependencies] extras group named "fastapi" (self-detection defect: Klauro\'s own packages/klauro-sdk-py/pyproject.toml lists fastapi as an instrumentation-target extra with an empty real dependencies array)', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fastapi-analyzer-extras-'));
  await fs.writeFile(
    path.join(root, 'pyproject.toml'),
    [
      '[project]',
      'name = "klauro-telemetry"',
      'dependencies = []',
      '',
      '[project.optional-dependencies]',
      'fastapi = ["starlette>=0.27"]',
    ].join('\n')
  );
  const analyzer = new FastAPIAnalyzer();
  assert.equal(await analyzer.canAnalyze(root), false);
  await fs.remove(root);
});

test('FastAPIAnalyzer.canAnalyze rejects a bare, comment-only "FastAPI" mention with no application/router construction (duck-typed integration-helper shape, e.g. an ASGI middleware that only comments about "Starlette/FastAPI" scope conventions without importing or constructing either)', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fastapi-analyzer-bare-mention-'));
  await fs.writeFile(
    path.join(root, 'middleware.py'),
    [
      'def _route_of_asgi(scope):',
      '    # Starlette/FastAPI put the matched route object under scope["route"].',
      '    return scope.get("route")',
    ].join('\n')
  );
  const analyzer = new FastAPIAnalyzer();
  assert.equal(await analyzer.canAnalyze(root), false);
  await fs.remove(root);
});

test('FastAPIAnalyzer.canAnalyze rejects a project without fastapi', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fastapi-analyzer-neg-'));
  await fs.writeFile(path.join(root, 'requirements.txt'), 'django==5.0.0\n');
  const analyzer = new FastAPIAnalyzer();
  assert.equal(await analyzer.canAnalyze(root), false);
  await fs.remove(root);
});

test('FastAPIAnalyzer scopes dependency identities and preserves unresolved dependency references as nodes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fastapi-analyzer-dependencies-'));
  await fs.writeFile(path.join(root, 'main.py'), [
    'from fastapi import FastAPI, Depends',
    'def verify_token():',
    '    return True',
    'app = FastAPI(dependencies=[Depends(verify_token), Depends(dynamic_dependency("tenant"))])',
    '@app.get("/users")',
    'def list_users():',
    '    return {"users": []}',
  ].join('\n'));

  const contribution = await new FastAPIAnalyzer().analyze({ projectPath: root } as any);
  const nodeIds = new Set((contribution.nodes || []).map(node => node.id));
  const dependencyEdges = (contribution.edges || []).filter(edge => edge.type === 'depends_on');

  assert.equal(dependencyEdges.length > 0, true);
  assert.equal(dependencyEdges.every(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target)), true);
  assert.equal((contribution.nodes || []).some(node => node.metadata?.attributes?.resolution === 'unresolved-reference'), true);
  await fs.remove(root);
});

test('FastAPIAnalyzer extracts multiline route decorators and multiline handler signatures', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fastapi-analyzer-multiline-route-'));
  await fs.writeFile(path.join(root, 'main.py'), [
    'from fastapi import APIRouter, Depends',
    'router = APIRouter(prefix="/articles")',
    '@router.post(',
    '    "/{slug}/comments",',
    '    response_model=Comment,',
    '    name="comments:create",',
    ')',
    'async def create_comment(',
    '    slug: str,',
    '    user = Depends(get_current_user),',
    '):',
    '    return {"slug": slug}',
  ].join('\n'));

  const contribution = await new FastAPIAnalyzer().analyze({ projectPath: root } as any);
  const entryPoint = (contribution.entry_points || []).find(entry => entry.handler?.method_name === 'create_comment');

  assert.ok(entryPoint);
  assert.equal(entryPoint.name, 'POST /articles/{slug}/comments');
  assert.equal(entryPoint.trigger?.method, 'POST');
  assert.equal(entryPoint.trigger?.path, '/articles/{slug}/comments');
  assert.equal(entryPoint.handler?.line, 8);
  await fs.remove(root);
});

test('FastAPIAnalyzer composes nested include_router prefixes, aliases, multiline mounts, and literal settings', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fastapi-analyzer-router-mounts-'));
  await fs.ensureDir(path.join(root, 'app', 'api', 'routes', 'articles'));
  await fs.ensureDir(path.join(root, 'app', 'core'));
  await fs.writeFile(path.join(root, 'app', 'core', 'config.py'), [
    'class Settings:',
    '    api_prefix: str = "/api"',
    'settings = Settings()',
  ].join('\n'));
  await fs.writeFile(path.join(root, 'app', 'main.py'), [
    'from fastapi import FastAPI',
    'from app.api.routes.api import router as api_router',
    'from app.core.config import settings',
    'application = FastAPI()',
    'application.include_router(api_router, prefix=settings.api_prefix)',
  ].join('\n'));
  await fs.writeFile(path.join(root, 'app', 'api', 'routes', 'api.py'), [
    'from fastapi import APIRouter',
    'from app.api.routes import authentication, comments',
    'from app.api.routes.articles import api as articles',
    'router = APIRouter()',
    'router.include_router(authentication.router, prefix="/users")',
    'router.include_router(articles.router)',
    'router.include_router(',
    '    comments.router,',
    '    prefix="/articles/{slug}/comments",',
    ')',
  ].join('\n'));
  await fs.writeFile(path.join(root, 'app', 'api', 'routes', 'articles', 'api.py'), [
    'from fastapi import APIRouter',
    'from app.api.routes.articles import articles_resource',
    'router = APIRouter()',
    'router.include_router(articles_resource.router, prefix="/articles")',
  ].join('\n'));
  await fs.writeFile(path.join(root, 'app', 'api', 'routes', 'authentication.py'), [
    'from fastapi import APIRouter',
    'router = APIRouter()',
    '@router.post("/login")',
    'def login():',
    '    return {}',
  ].join('\n'));
  await fs.writeFile(path.join(root, 'app', 'api', 'routes', 'articles', 'articles_resource.py'), [
    'from fastapi import APIRouter',
    'router = APIRouter()',
    '@router.get("/{slug}")',
    'def read_article(slug: str):',
    '    return {}',
  ].join('\n'));
  await fs.writeFile(path.join(root, 'app', 'api', 'routes', 'comments.py'), [
    'from fastapi import APIRouter',
    'router = APIRouter()',
    '@router.delete("/{comment_id}")',
    'def delete_comment(slug: str, comment_id: int):',
    '    return {}',
  ].join('\n'));

  const contribution = await new FastAPIAnalyzer().analyze({ projectPath: root } as any);
  const paths = (contribution.entry_points || []).map(entry => entry.trigger?.path).sort();

  assert.deepEqual(paths, [
    '/api/articles/{slug}',
    '/api/articles/{slug}/comments/{comment_id}',
    '/api/users/login',
  ]);
  await fs.remove(root);
});

test('FastAPIAnalyzer preserves every public path when the same router is mounted more than once', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fastapi-analyzer-multiple-mounts-'));
  await fs.writeFile(path.join(root, 'main.py'), [
    'from fastapi import FastAPI',
    'from users import router as users_router',
    'app = FastAPI()',
    'app.include_router(users_router, prefix="/v1/users")',
    'app.include_router(users_router, prefix="/v2/users")',
  ].join('\n'));
  await fs.writeFile(path.join(root, 'users.py'), [
    'from fastapi import APIRouter',
    'router = APIRouter()',
    '@router.get("/{user_id}")',
    'def read_user(user_id: int):',
    '    return {}',
  ].join('\n'));

  const contribution = await new FastAPIAnalyzer().analyze({ projectPath: root } as any);
  const paths = (contribution.entry_points || []).map(entry => entry.trigger?.path).sort();

  assert.deepEqual(paths, ['/v1/users/{user_id}', '/v2/users/{user_id}']);
  assert.equal((contribution.nodes || []).filter(node =>
    node.id.startsWith('handler_') && node.name === 'read_user').length, 1);
  await fs.remove(root);
});
