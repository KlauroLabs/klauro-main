















import * as http from 'http';
import * as fs from 'fs-extra';
import * as path from 'path';
import { URL } from 'url';
import { gauntletHomeDir, runGauntlet } from './runner';
import { buildTestInventory } from './test-inventory';
import { SCENARIOS, ARMS } from './report-schema';
import { overview, listRepos, repoDetail, listWorkspaces, workspaceDetail, runHistory } from './data';
import { buildCoverageReport, reposUsingStack } from './coverage';
import { listUserScenarios, addUserScenario, listProjectBuilds, requestProjectBuild } from './proposals';
import { latestTestRun, testRunHistory, testStatusIndex, runTestSuite } from './test-runs';
import { listIncrementalRecords, incrementalSeries, runIncrementalGauntlet } from './incremental-gauntlet';
import { listGauntletWatchers, installGauntletWatcher, stopGauntletWatcher, startInstalledWatchers } from './gauntlet-watcher';
import { buildCampsReport } from './camps-bench';
import { buildFullGrid } from './full-grid';

const UI_DIR = path.join(__dirname, 'ui');
const DASHBOARD = path.join(UI_DIR, 'dashboard.html');

async function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function num(v: string | null, def?: number): number | undefined {
  if (v == null) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function sendJson(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

interface UiOptions {
  port?: number;
}

type SseClient = http.ServerResponse;

export async function startUiServer(opts: UiOptions = {}): Promise<void> {
  const port = opts.port ?? 7878;
  const reportPath = path.join(gauntletHomeDir(), 'latest.json');
  await fs.ensureDir(gauntletHomeDir());

  const clients = new Set<SseClient>();

  const pushReport = async () => {
    let payload = '{}';
    try { payload = await fs.readFile(reportPath, 'utf8'); } catch {   }
    for (const res of clients) {
      res.write(`event: report\ndata: ${payload.replace(/\n/g, ' ')}\n\n`);
    }
  };


  let watchTimer: NodeJS.Timeout | undefined;
  try {
    fs.watch(gauntletHomeDir(), (_evt, file) => {
      if (file !== 'latest.json') return;
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => { void pushReport(); }, 120);
    });
  } catch {   }

  const server = http.createServer(async (req, res) => {
    const url = req.url || '/';
    try {
      if (url === '/' || url.startsWith('/index')) {
        const html = await fs.readFile(DASHBOARD, 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      if (url.startsWith('/api/report')) {
        let payload = '{}';
        try { payload = await fs.readFile(reportPath, 'utf8'); } catch {   }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(payload);
        return;
      }
      if (url.startsWith('/api/tests')) {
        const inventory = await buildTestInventory();


        const status = await testStatusIndex().catch(() => ({} as Record<string, any>));
        const latest = await latestTestRun().catch(() => null);
        for (const area of inventory.areas) {
          for (const file of area.files) {
            for (const t of file.tests as any[]) {
              const s = status[`${file.file}::${t.name}`] || status[`unknown::${t.name}`];
              if (s) { t.status = s.status; t.history = s.history; }
            }
          }
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...inventory, last_run: latest ? { run_id: latest.run_id, started_at: latest.started_at, total: latest.total, passed: latest.passed, failed: latest.failed, skipped: latest.skipped } : null }));
        return;
      }
      if (url.startsWith('/api/catalog')) {


        const userScenarios = await listUserScenarios();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ scenarios: [...SCENARIOS, ...userScenarios], arms: ARMS }));
        return;
      }
      const u = new URL(url, 'http://localhost');
      const p = u.pathname;
      const qp = u.searchParams;

      if (p === '/api/coverage') { return sendJson(res, await buildCoverageReport()); }


      if (p === '/api/camps') { return sendJson(res, await buildCampsReport(new Date().toISOString())); }



      if (p === '/api/grid') { return sendJson(res, await buildFullGrid()); }
      if (p === '/api/coverage/stack') { return sendJson(res, await reposUsingStack(qp.get('stack') || qp.get('framework') || '')); }
      if (p === '/api/overview') { return sendJson(res, await overview()); }
      if (p === '/api/workspaces') { return sendJson(res, await listWorkspaces()); }
      if (p === '/api/workspace') { return sendJson(res, await workspaceDetail(qp.get('name') || '')); }
      if (p === '/api/repos') {
        return sendJson(res, await listRepos({
          q: qp.get('q') || undefined,
          framework: qp.get('framework') || undefined,
          sort: (qp.get('sort') as any) || undefined,
          limit: num(qp.get('limit')),
          offset: num(qp.get('offset')),
        }));
      }
      if (p === '/api/repo') { return sendJson(res, await repoDetail(qp.get('name') || '')); }
      if (p === '/api/runs') { return sendJson(res, { runs: await runHistory(num(qp.get('limit'), 50)) }); }
      if (p === '/api/run' && req.method === 'GET' && qp.get('id')) {
        const file = path.join(gauntletHomeDir(), `gauntlet-${qp.get('id')}.json`);
        try { return sendJson(res, await fs.readJson(file)); } catch { res.writeHead(404); return res.end('{}'); }
      }
      if (p === '/api/project-builds' && req.method === 'GET') { return sendJson(res, { builds: await listProjectBuilds() }); }
      if (p === '/api/project-builds' && req.method === 'POST') {
        const body = await readBody(req);
        const build = await requestProjectBuild(body, new Date().toISOString(), Math.random().toString(36).slice(2, 7));
        await pushReport();
        return sendJson(res, build, 201);
      }
      if (p === '/api/scenarios' && req.method === 'POST') {
        const body = await readBody(req);
        const result = await addUserScenario(body, new Date().toISOString());
        return sendJson(res, result, result.ok ? 201 : 400);
      }

      if (p === '/api/test-runs') {
        return sendJson(res, { latest: await latestTestRun(), history: await testRunHistory(num(qp.get('limit'), 20)) });
      }
      if (p === '/api/test-status') { return sendJson(res, await testStatusIndex()); }
      if (p === '/api/run-tests' && req.method === 'POST') {
        sendJson(res, { started: true }, 202);
        void runTestSuite().then(() => pushReport()).catch(err => console.error('[gauntlet-ui] test run failed:', err));
        return;
      }

      if (p === '/api/incremental') {
        return sendJson(res, { records: await listIncrementalRecords(qp.get('repo') || undefined, num(qp.get('limit'), 100)) });
      }
      if (p === '/api/incremental-series') {
        return sendJson(res, { series: await incrementalSeries(qp.get('repo') || '') });
      }
      if (p === '/api/incremental' && req.method === 'POST') {
        const body = await readBody(req);
        return sendJson(res, await runIncrementalGauntlet({ repoName: body.repoName, change: body.change }), 201);
      }

      if (p === '/api/watchers' && req.method === 'GET') { return sendJson(res, { watchers: await listGauntletWatchers() }); }
      if (p === '/api/watchers' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.repoPath) return sendJson(res, { error: 'repoPath required' }, 400);
        try { return sendJson(res, await installGauntletWatcher(body.repoPath), 201); }
        catch (e) { return sendJson(res, { error: e instanceof Error ? e.message : String(e) }, 400); }
      }
      if (p === '/api/watchers/stop' && req.method === 'POST') {
        const body = await readBody(req);
        return sendJson(res, await stopGauntletWatcher(body.id || ''));
      }
      if (url.startsWith('/api/events')) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write('retry: 2000\n\n');
        clients.add(res);
        await pushReport();
        req.on('close', () => clients.delete(res));
        return;
      }
      if (url.startsWith('/api/run') && req.method === 'POST') {
        const body = await readBody(req);
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ started: true }));

        void runGauntlet({
          scenarioIds: Array.isArray(body.scenarioIds) && body.scenarioIds.length ? body.scenarioIds : undefined,
          live: body.live === true,
          targetRepo: body.targetRepo || undefined,
          targetWorkspace: body.targetWorkspace || undefined,
          onProgress: () => { void pushReport(); },
        }).catch(err => {
          console.error('[gauntlet-ui] run failed:', err);
        });
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(err));
    }
  });

  await new Promise<void>(resolve => server.listen(port, resolve));

  try { const started = await startInstalledWatchers(); if (started.started) console.log(`[gauntlet-ui] resumed ${started.started} gauntlet watcher(s)`); }
  catch (err) { console.error('[gauntlet-ui] watcher resume failed:', err); }
  console.log(`[gauntlet-ui] http://localhost:${port}  (report: ${reportPath})`);
}

import { isDirectCliInvocation } from '../cli-invocation';
if (isDirectCliInvocation('ui-server')) {
  const portArg = process.argv.indexOf('--port');
  const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 7878;
  startUiServer({ port }).catch(err => { console.error(err); process.exit(1); });
}
