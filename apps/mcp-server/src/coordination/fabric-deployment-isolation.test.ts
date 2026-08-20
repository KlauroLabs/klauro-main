import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '../../../..');

test('hosted Fabric has a resource-isolated process and proxy route', () => {
  const compose = fs.readFileSync(path.join(repoRoot, 'infrastructure/vps/docker-compose.yml'), 'utf8');
  const caddy = fs.readFileSync(path.join(repoRoot, 'infrastructure/vps/Caddyfile'), 'utf8');
  const entrypoint = fs.readFileSync(path.join(repoRoot, 'apps/api/src/fabric.ts'), 'utf8');

  const fabricService = compose.match(/\n  fabric:\n([\s\S]*?)(?=\n  [a-z][a-z0-9-]*:\n)/)?.[1] ?? '';
  assert.match(fabricService, /command: \["\/app\/node_modules\/\.bin\/tsx", "src\/fabric\.ts"\]/);
  assert.match(fabricService, /KLAURO_SELF_TELEMETRY: "0"/);
  assert.match(fabricService, /mem_limit: 1536m/);
  assert.match(fabricService, /KLAURO_FABRIC_PORT: "8788"/);
  assert.doesNotMatch(entrypoint, /prewarmAnalysisWorker/);
  assert.match(entrypoint, /coordinationOnly: true/);

  const mcpSite = caddy.indexOf('\nmcp.klauro.com {');
  const fabricRoute = caddy.indexOf('@fabric path /v1/coordination/*', mcpSite);
  const apiFallback = caddy.indexOf('name api', mcpSite);
  assert.ok(fabricRoute >= 0 && fabricRoute < apiFallback);
  assert.match(caddy.slice(fabricRoute, apiFallback), /name fabric[\s\S]*port 8788/);
});
