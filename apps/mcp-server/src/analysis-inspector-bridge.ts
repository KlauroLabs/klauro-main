import * as fs from 'fs-extra';
import * as http from 'http';
import * as path from 'path';
import { spawn } from 'child_process';
import { analyzeProject } from './analyzer';
import { withAnalysisFocus } from './analysis-focus';

const port = Number(process.env.KLAURO_INSPECTOR_BRIDGE_PORT || '48731');
const analysesRoot = process.env.KLAURO_STORAGE_PATH || path.join(process.env.HOME || '', '.klauro', 'analyses');
const repoGeneratorPath = path.join(__dirname, '..', 'scripts', 'create-analysis-inspector.js');
const generatorPath = process.env.KLAURO_INSPECTOR_GENERATOR ||
  (fs.existsSync(repoGeneratorPath) ? repoGeneratorPath : path.join(analysesRoot, 'create-analysis-inspector.js'));

type JobStatus = 'queued' | 'running' | 'complete' | 'failed';

interface ReanalysisJob {
  ok: true;
  id: string;
  status: JobStatus;
  projectPath: string;
  logPath: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

const jobs = new Map<string, ReanalysisJob>();

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function appendLog(filePath: string, text: string): Promise<void> {
  await fs.ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, text);
}

function runGenerator(logPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(generatorPath)) {
      resolve();
      return;
    }

    const child = spawn(process.execPath, [generatorPath], {
      cwd: path.dirname(generatorPath),
      env: process.env,
    });
    child.stdout.on('data', chunk => void appendLog(logPath, chunk.toString()));
    child.stderr.on('data', chunk => void appendLog(logPath, chunk.toString()));
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`inspector generator exited ${code}`));
    });
  });
}

async function runJob(job: ReanalysisJob): Promise<void> {
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  try {
    await appendLog(job.logPath, `$ klauro analyze ${job.projectPath} --analysis-focus ui-overview\n`);
    const result = await withAnalysisFocus('ui-overview', () => analyzeProject(job.projectPath), {
      interpretationBudgetMs: '90000',
      elementDescriptionBudgetMs: '150000',
      elementDescriptionLimit: '8',
    });
    await appendLog(job.logPath, `project=${result.system.root_path}\nnodes=${result.nodes.length}\nedges=${result.edges.length}\nfull_rebuild=true\n`);
    await appendLog(job.logPath, `$ node ${generatorPath}\n`);
    await runGenerator(job.logPath);
    job.status = 'complete';
  } catch (error) {
    job.status = 'failed';
    job.error = error instanceof Error ? error.message : String(error);
    await appendLog(job.logPath, `ERROR: ${job.error}\n`);
  } finally {
    job.finishedAt = new Date().toISOString();
  }
}

function validAbsoluteProjectPath(projectPath: string): boolean {
  return path.isAbsolute(projectPath) && fs.existsSync(projectPath);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    writeJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    writeJson(res, 200, {
      ok: true,
      port,
      analysesRoot,
      generatorPath,
      analyzer: 'local-mcp-app',
    });
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/jobs/')) {
    const id = decodeURIComponent(req.url.split('/').pop() || '');
    const job = jobs.get(id);
    writeJson(res, job ? 200 : 404, job || { ok: false, error: 'job not found' });
    return;
  }

  if (req.method === 'POST' && req.url === '/analyze') {
    try {
      const body = JSON.parse(await readBody(req) || '{}') as { path?: string };
      const projectPath = String(body.path || '');
      if (!validAbsoluteProjectPath(projectPath)) {
        writeJson(res, 400, { ok: false, error: 'path must be an existing absolute path' });
        return;
      }

      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const job: ReanalysisJob = {
        ok: true,
        id,
        status: 'queued',
        projectPath,
        logPath: path.join(analysesRoot, `reanalysis-${id}.log`),
      };
      jobs.set(id, job);
      writeJson(res, 202, job);
      void runJob(job);
    } catch (error) {
      writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  writeJson(res, 404, { ok: false, error: 'not found' });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Klauro analysis inspector bridge listening on http://127.0.0.1:${port}`);
});
