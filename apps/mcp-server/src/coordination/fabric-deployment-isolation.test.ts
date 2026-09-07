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
  assert.match(fabricService, /KLAURO_COORDINATION_ONLY: "1"/);
  const fabricLimit = Number(fabricService.match(/mem_limit: (\d+)m/)?.[1]);
  const fabricHeap = Number(fabricService.match(/--max-old-space-size=(\d+)/)?.[1]);
  assert.ok(fabricLimit >= 512, 'fabric runs under its own memory limit');
  assert.ok(fabricHeap > 0 && fabricHeap <= fabricLimit - Math.max(256, Math.floor(fabricLimit / 4)), 'fabric heap leaves the deploy lint headroom inside its limit');
  assert.match(fabricService, /memswap_limit: (\d+)m/);
  assert.equal(fabricService.match(/memswap_limit: (\d+)m/)?.[1], String(fabricLimit), 'no swap beyond the limit');
  assert.match(fabricService, /KLAURO_FABRIC_PORT: "8788"/);
  assert.doesNotMatch(entrypoint, /prewarmAnalysisWorker/);

  const mcpSite = caddy.indexOf('\nmcp.klauro.com {');
  const fabricRoute = caddy.indexOf('@fabric path /v1/coordination/*', mcpSite);
  const apiFallback = caddy.indexOf('name api', mcpSite);
  assert.ok(fabricRoute >= 0 && fabricRoute < apiFallback);
  assert.match(caddy.slice(fabricRoute, apiFallback), /name fabric[\s\S]*port 8788/);
});
