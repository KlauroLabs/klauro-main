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
