/**
 * The ONE way the gauntlet/harness gets a Klauro analysis — through the product,
 * as a blackbox client. The harness never imports the analyzer engine, never knows
 * AI exists, never sets a model. It asks the product to analyze and reads the result.
 *
 * Transport: the product's analyzer-server over HTTP.
 *   - Default (offline/CI): an in-process analyzer-server on localhost (the product's
 *     own server, which internally decides what runs where — that seam is invisible
 *     here). Started once, reused.
 *   - KLAURO_BENCH_ANALYZER_URL set: route to that server instead (e.g. the live VPS
 *     for a real product run).
 *
 * Whatever AI the product does happens inside the server with the server's own config;
 * if it degrades, the product still returns an analysis and the harness simply measures
 * what it got. See docs/KLAURO-PRODUCT-MODEL.md and the blackbox-testing principle.
 */

import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs-extra';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { createRemoteAnalyzerHttpServer } from '../remote-analyzer-service';
import { buildSourceSnapshot } from '../remote-source';
import { saveAnalysis } from '../storage';
import type { CASOutput } from '../../../../packages/analyzer-core/src/types/cas.types';

let localServerUrl: string | null = null;

async function ensureProductServer(): Promise<string> {
  const override = process.env.KLAURO_BENCH_ANALYZER_URL;
  if (override) return override.replace(/\/$/, '');
  if (localServerUrl) return localServerUrl;
  // The product's own analyzer-server, in-process, no shared token (open) — the
  // harness talks to it over HTTP exactly like any client. It is the product, not
  // the engine: the harness does not reach inside it.
  const dataDir = path.join(os.tmpdir(), `klauro-bench-analyzer-${process.pid}`);
  const server = createRemoteAnalyzerHttpServer({ dataDir });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  server.unref?.();
  localServerUrl = `http://127.0.0.1:${port}`;
  return localServerUrl;
}

function postJson(url: string, body: unknown): Promise<any> {
  const payload = Buffer.from(JSON.stringify(body));
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': payload.length } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode || 0) >= 400) return reject(new Error(`analyze ${res.statusCode}: ${text.slice(0, 200)}`));
          try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Ask the product to analyze a directory and return its CAS. Blackbox: builds the
 * source snapshot the product client would send, posts it to the product's analyzer
 * server, and returns what comes back. No engine, no AI, no model — ever.
 */
export async function analyzeForBench(dir: string): Promise<CASOutput> {
  const serverUrl = await ensureProductServer();
  // The product analyzes committed source. Fixtures aren't standalone git repos, so
  // stage them in a throwaway git repo first (the customer always has a git repo);
  // the checked-in fixture is never mutated.
  const staged = await stageAsGitRepo(dir);
  try {
    const snapshot = await buildSourceSnapshot(staged);
    const response = await postJson(`${serverUrl}/v1/analyze`, {
      // Unique per source dir: the shared in-process server keys its incremental
      // cache/workspace on project_id, so sibling repos with the same basename
      // (was-bench ui/api/worker) must NOT collide, or one poisons the other's CAS.
      project_id: crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 16),
      project_path: dir,
      snapshot,
    });
    const cas = response.cas as CASOutput;
    // Cache locally exactly as the real product client does (analyze -> server ->
    // local cache), keyed by the ORIGINAL dir so getAnalysis(dir)/the MCP find it.
    await saveAnalysis(dir, cas).catch(() => undefined);
    return cas;
  } finally {
    if (staged !== dir) await fs.remove(staged).catch(() => undefined);
  }
}

/** If dir is already a clean git repo, use it; else copy to a temp git repo + commit. */
async function stageAsGitRepo(dir: string): Promise<string> {
  const tmp = path.join(os.tmpdir(), `klauro-bench-src-${process.pid}-${Math.random().toString(36).slice(2)}`);
  await fs.copy(dir, tmp, { filter: (src) => !/(^|\/)\.git(\/|$)/.test(src) });
  const git = (args: string[]) => execFileSync('git', args, { cwd: tmp, stdio: 'ignore' });
  git(['init', '-q']);
  git(['add', '-A']);
  git(['-c', 'user.email=bench@klauro', '-c', 'user.name=bench', 'commit', '-qm', 'bench fixture']);
  return tmp;
}

/** True when the harness is pointed at an external product server (e.g. the live VPS). */
export function benchProductMode(): boolean {
  return Boolean(process.env.KLAURO_BENCH_ANALYZER_URL);
}
