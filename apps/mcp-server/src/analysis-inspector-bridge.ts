import * as fs from 'fs-extra';
import * as http from 'http';
import * as path from 'path';
import { spawn } from 'child_process';
import { analyzeProject } from './analyzer';

const port = Number(process.env.KLAURO_INSPECTOR_BRIDGE_PORT || '48731');
const analysesRoot = process.env.KLAURO_STORAGE_PATH || path.join(process.env.HOME || '', '.klauro', 'analyses');
const generatorPath = process.env.KLAURO_INSPECTOR_GENERATOR ||
  path.join(analysesRoot, 'create-analysis-inspector.js');

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
  const previous = {
    interpretation: process.env.KLAURO_AI_INTERPRETATION,
    interpretationForce: process.env.KLAURO_AI_INTERPRETATION_FORCE,
    deterministicKeep: process.env.KLAURO_AI_INTERPRETATION_ALLOW_DETERMINISTIC_KEEP,
    interpretationBudget: process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS,
    elementBudget: process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BUDGET_MS,
    elementBatchSize: process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BATCH_SIZE,
    elementLimit: process.env.KLAURO_AI_ELEMENT_DESCRIPTION_LIMIT,
    elements: process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS,
    embeddings: process.env.KLAURO_EMBEDDING_ENABLED,
    ollamaAuto: process.env.KLAURO_OLLAMA_AUTO,
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
    ollamaModel: process.env.OLLAMA_MODEL,
  };
  try {
    process.env.KLAURO_AI_INTERPRETATION = process.env.KLAURO_AI_INTERPRETATION || 'true';
    process.env.KLAURO_AI_INTERPRETATION_FORCE = process.env.KLAURO_AI_INTERPRETATION_FORCE || 'true';
    process.env.KLAURO_AI_INTERPRETATION_ALLOW_DETERMINISTIC_KEEP = 'false';
    process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS = process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS || '90000';
    process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BUDGET_MS = process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BUDGET_MS || '150000';
    process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BATCH_SIZE = process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BATCH_SIZE || '4';
    process.env.KLAURO_AI_ELEMENT_DESCRIPTION_LIMIT = process.env.KLAURO_AI_ELEMENT_DESCRIPTION_LIMIT || '8';
    process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS = process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS || 'true';
    process.env.KLAURO_EMBEDDING_ENABLED = 'false';
    process.env.KLAURO_OLLAMA_AUTO = process.env.KLAURO_OLLAMA_AUTO || 'true';
    process.env.OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
    process.env.OLLAMA_MODEL = process.env.OLLAMA_MODEL || process.env.KLAURO_LOCAL_AI_MODEL || 'qwen3:8b';

    await appendLog(job.logPath, `$ klauro analyze ${job.projectPath} --analysis-focus ui-overview\n`);
    const result = await analyzeProject(job.projectPath);
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
    restoreEnv('KLAURO_AI_INTERPRETATION', previous.interpretation);
    restoreEnv('KLAURO_AI_INTERPRETATION_FORCE', previous.interpretationForce);
    restoreEnv('KLAURO_AI_INTERPRETATION_ALLOW_DETERMINISTIC_KEEP', previous.deterministicKeep);
    restoreEnv('KLAURO_AI_INTERPRETATION_BUDGET_MS', previous.interpretationBudget);
    restoreEnv('KLAURO_AI_ELEMENT_DESCRIPTION_BUDGET_MS', previous.elementBudget);
    restoreEnv('KLAURO_AI_ELEMENT_DESCRIPTION_BATCH_SIZE', previous.elementBatchSize);
    restoreEnv('KLAURO_AI_ELEMENT_DESCRIPTION_LIMIT', previous.elementLimit);
    restoreEnv('KLAURO_AI_ELEMENT_DESCRIPTIONS', previous.elements);
    restoreEnv('KLAURO_EMBEDDING_ENABLED', previous.embeddings);
    restoreEnv('KLAURO_OLLAMA_AUTO', previous.ollamaAuto);
    restoreEnv('OLLAMA_BASE_URL', previous.ollamaBaseUrl);
    restoreEnv('OLLAMA_MODEL', previous.ollamaModel);
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
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
