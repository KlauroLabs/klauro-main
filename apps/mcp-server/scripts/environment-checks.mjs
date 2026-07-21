import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const MINIMUM_NODE_MAJOR = 20;
export const DEFAULT_HANDSHAKE_LIMIT_MS = 600;
export const DEFAULT_PRODUCT_BUNDLE_BUDGET_BYTES = 75 * 1024 * 1024;
export const DEFAULT_PRODUCT_INSTALL_BUDGET_BYTES = 350 * 1024 * 1024;
export const DEFAULT_PRODUCT_STORAGE_BUDGET_BYTES = 512 * 1024 * 1024;
export const OPERATING_LOOP_MARKER = '## Klauro Agent Rule';
export const OPERATING_LOOP_BEGIN_MARKER = '<!-- klauro:operating-loop:begin -->';
export const OPERATING_LOOP_END_MARKER = '<!-- klauro:operating-loop:end -->';

export function checkResult(id, status, detail, fix) {
  return fix ? { id, status, detail, fix } : { id, status, detail };
}

export function formatCheck(check) {
  const lines = [`${check.status.toUpperCase().padEnd(4)} ${check.id}: ${check.detail}`];
  if (check.fix && check.status !== 'pass') lines.push(`     fix: ${check.fix}`);
  return lines.join('\n');
}

export function evaluateNodeVersion(versionString, minimumMajor = MINIMUM_NODE_MAJOR) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(versionString || '').trim());
  if (!match) {
    return checkResult('node-version', 'fail', `Could not parse Node.js version from ${JSON.stringify(versionString)}`,
      `Install Node.js ${minimumMajor}+ from https://nodejs.org and re-run.`);
  }
  const major = Number(match[1]);
  if (major < minimumMajor) {
    return checkResult('node-version', 'fail',
      `Node.js ${match[0].replace(/^v?/, 'v')} is below the required Node.js ${minimumMajor}+ (the bundle targets node${minimumMajor}).`,
      `Install Node.js ${minimumMajor}+ (for example: brew install node@${minimumMajor}, nvm install ${minimumMajor}) and re-run.`);
  }
  return checkResult('node-version', 'pass', `Node.js v${match[1]}.${match[2]}.${match[3]} (minimum: ${minimumMajor})`);
}

export function evaluateBundleState(input) {
  const { bundleExists, serverExists, cliExists, handshakeExists, workerExists, parserWorkerExists, bundleMtimeMs, newestSourceMtimeMs, packageRoot } = input;
  const buildFix = `Run: npm --prefix ${packageRoot} run build (skip while a live run is using dist/).`;
  if (!bundleExists || !serverExists || cliExists === false || !handshakeExists || workerExists === false || parserWorkerExists === false) {
    const missing = [
      !bundleExists ? 'dist/index.cjs' : null,
      !serverExists ? 'dist/server.cjs' : null,
      cliExists === false ? 'dist/cli.cjs' : null,
      !handshakeExists ? 'dist/handshake.json' : null,
      workerExists === false ? 'dist/analysis-worker.cjs' : null,
      parserWorkerExists === false ? 'dist/tree-sitter-ts-worker.cjs' : null,
    ].filter(Boolean).join(', ');
    return checkResult('bundle', 'fail', `Bundle incomplete: missing ${missing}.`, buildFix);
  }
  if (typeof newestSourceMtimeMs === 'number' && typeof bundleMtimeMs === 'number' && newestSourceMtimeMs > bundleMtimeMs) {
    const ageMinutes = Math.round((newestSourceMtimeMs - bundleMtimeMs) / 60000);
    return checkResult('bundle', 'warn',
      `dist/index.cjs is older than the newest source file by ~${ageMinutes} minute(s); the bundle may not include recent changes.`,
      buildFix);
  }
  return checkResult('bundle', 'pass', 'dist/index.cjs, dist/server.cjs, dist/cli.cjs, and dist/handshake.json are present and newer than the sources.');
}

export function newestMtimeMs(rootDir) {
  let newest = null;
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        try {
          const mtime = fs.statSync(fullPath).mtimeMs;
          if (newest === null || mtime > newest) newest = mtime;
        } catch {
        }
      }
    }
  }
  return newest;
}

export function inspectBundle({ packageRoot, sourceDirs }) {
  const bundlePath = path.join(packageRoot, 'dist', 'index.cjs');
  const serverPath = path.join(packageRoot, 'dist', 'server.cjs');
  const handshakePath = path.join(packageRoot, 'dist', 'handshake.json');
  const bundleExists = fs.existsSync(bundlePath);
  let newestSourceMtimeMs = null;
  for (const dir of sourceDirs) {
    const newest = newestMtimeMs(dir);
    if (newest !== null && (newestSourceMtimeMs === null || newest > newestSourceMtimeMs)) newestSourceMtimeMs = newest;
  }
  return evaluateBundleState({
    bundleExists,
    serverExists: fs.existsSync(serverPath),
    cliExists: fs.existsSync(path.join(packageRoot, 'dist', 'cli.cjs')),
    handshakeExists: fs.existsSync(handshakePath),
    workerExists: fs.existsSync(path.join(packageRoot, 'dist', 'analysis-worker.cjs')),
    parserWorkerExists: fs.existsSync(path.join(packageRoot, 'dist', 'tree-sitter-ts-worker.cjs')),
    bundleMtimeMs: bundleExists ? fs.statSync(bundlePath).mtimeMs : null,
    newestSourceMtimeMs,
    packageRoot,
  });
}

export function storageAnalysesDir(env = process.env) {
  if (env.KLAURO_STORAGE_PATH) return env.KLAURO_STORAGE_PATH;
  return path.join(env.HOME || env.USERPROFILE || os.homedir(), '.klauro', 'analyses');
}

export function storageRoot(env = process.env) {
  const analysesDir = storageAnalysesDir(env);
  return path.basename(analysesDir) === 'analyses' ? path.dirname(analysesDir) : analysesDir;
}

export function evaluateStorageState(input) {
  const { analysesDir, created, writable, usageBytes, writeError } = input;
  if (!writable) {
    return checkResult('storage', 'fail',
      `${analysesDir} is not writable${writeError ? ` (${writeError})` : ''}.`,
      `Fix permissions: chown/chmod the directory, or point KLAURO_STORAGE_PATH at a writable location.`);
  }
  const usage = typeof usageBytes === 'number' ? `, ${formatBytes(usageBytes)} used` : '';
  return checkResult('storage', 'pass',
    `${analysesDir} is writable${created ? ' (created)' : ''}${usage}.`);
}

export function inspectStorage(env = process.env) {
  const analysesDir = storageAnalysesDir(env);
  let created = false;
  let writable = true;
  let writeError;
  try {
    if (!fs.existsSync(analysesDir)) {
      fs.mkdirSync(analysesDir, { recursive: true });
      created = true;
    }
    const probePath = path.join(analysesDir, `.klauro-write-probe-${process.pid}`);
    fs.writeFileSync(probePath, 'ok');
    fs.unlinkSync(probePath);
  } catch (error) {
    writable = false;
    writeError = error instanceof Error ? error.message : String(error);
  }
  return evaluateStorageState({
    analysesDir,
    created,
    writable,
    writeError,
    usageBytes: writable ? directorySizeBytes(storageRoot(env)) : undefined,
  });
}

export function directorySizeBytes(rootDir) {
  const du = spawnSync('du', ['-sk', rootDir], { encoding: 'utf8' });
  if (du.status === 0) {
    const kilobytes = Number(du.stdout.trim().split(/\s+/)[0]);
    if (Number.isFinite(kilobytes)) return kilobytes * 1024;
  }
  let total = 0;
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile()) {
        try {
          total += fs.statSync(fullPath).size;
        } catch {
        }
      }
    }
  }
  return total;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function productFootprintBudgets(env = process.env) {
  return {
    bundleBytes: parseByteBudget(env.KLAURO_PRODUCT_BUNDLE_MAX_BYTES, DEFAULT_PRODUCT_BUNDLE_BUDGET_BYTES),
    installBytes: parseByteBudget(env.KLAURO_PRODUCT_INSTALL_MAX_BYTES, DEFAULT_PRODUCT_INSTALL_BUDGET_BYTES),
    storageBytes: parseByteBudget(env.KLAURO_PRODUCT_STORAGE_WARN_BYTES, DEFAULT_PRODUCT_STORAGE_BUDGET_BYTES),
  };
}

function parseByteBudget(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function evaluateSizeBudget({ id, label, bytes, maxBytes, overStatus = 'fail', fix }) {
  if (bytes <= maxBytes) {
    return checkResult(id, 'pass', `${label} is ${formatBytes(bytes)} (budget ${formatBytes(maxBytes)}).`);
  }
  return checkResult(id, overStatus,
    `${label} is ${formatBytes(bytes)}, over the ${formatBytes(maxBytes)} budget.`,
    fix);
}

export function inspectProductFootprint({ packageRoot, env = process.env, includeStorage = true } = {}) {
  const root = packageRoot || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const budgets = productFootprintBudgets(env);
  const distDir = path.join(root, 'dist');
  const nodeModulesDir = path.join(root, 'node_modules');
  const shippedScriptFiles = [
    path.join(root, 'scripts', 'install.mjs'),
    path.join(root, 'scripts', 'uninstall.mjs'),
    path.join(root, 'scripts', 'environment-checks.mjs'),
  ];
  const packageFiles = [
    path.join(root, 'package.json'),
    path.join(root, 'package-lock.json'),
    ...shippedScriptFiles,
  ];

  const bundleBytes = fs.existsSync(distDir) ? directorySizeBytes(distDir) : 0;
  const installBytes = bundleBytes
    + packageFiles.filter(file => fs.existsSync(file)).reduce((sum, file) => sum + fs.statSync(file).size, 0)
    + (fs.existsSync(nodeModulesDir) ? directorySizeBytes(nodeModulesDir) : 0);

  const checks = [
    evaluateSizeBudget({
      id: 'product-bundle-footprint',
      label: 'Bundled MCP/runtime dist',
      bytes: bundleBytes,
      maxBytes: budgets.bundleBytes,
      fix: `Run npm --prefix ${root} run build and inspect dist/. Gauntlet, tests, and legacy source must stay out of the product bundle.`,
    }),
    evaluateSizeBudget({
      id: 'product-install-footprint',
      label: 'Local install footprint estimate',
      bytes: installBytes,
      maxBytes: budgets.installBytes,
      fix: 'Move heavy analyzer/test/gauntlet dependencies out of the local product package, or ship them only in hosted analyzer/gauntlet packages.',
    }),
  ];

  if (includeStorage) {
    const rootStorage = storageRoot(env);
    const storageBytes = fs.existsSync(rootStorage) ? directorySizeBytes(rootStorage) : 0;
    checks.push(evaluateSizeBudget({
      id: 'product-storage-footprint',
      label: 'Local Klauro storage',
      bytes: storageBytes,
      maxBytes: budgets.storageBytes,
      overStatus: 'warn',
      fix: `Run storage pruning for generated artifacts: npm --prefix ${root} run storage-prune -- --include-ephemeral-analyses --include-temp-artifacts --max-bytes ${budgets.storageBytes} --confirm`,
    }));
  }

  return checks;
}

export function summarizeAiProviders(env = process.env) {
  const configured = [];
  if (env.DEEPINFRA_API_KEY) configured.push(`deepinfra (${env.DEEPINFRA_BASE_URL || 'https://api.deepinfra.com/v1/openai'}; model ${env.DEEPINFRA_MODEL || env.OPENAI_MODEL || 'default'})`);
  if (env.OPENAI_API_KEY) configured.push('openai (OPENAI_API_KEY)');
  if (env.ANTHROPIC_API_KEY) configured.push('anthropic (ANTHROPIC_API_KEY)');
  if (env.OPENAI_BASE_URL && !/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])/i.test(env.OPENAI_BASE_URL)) {
    configured.push(`openai-compatible endpoint (${env.OPENAI_BASE_URL})`);
  }
  return configured;
}

export async function probeOllama(baseUrl = 'http://127.0.0.1:11434', timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`, { signal: controller.signal });
    if (!response.ok) return { reachable: false, detail: `HTTP ${response.status}` };
    const payload = await response.json().catch(() => ({}));
    const models = Array.isArray(payload.models) ? payload.models.length : 0;
    return { reachable: true, models };
  } catch (error) {
    return { reachable: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

export function evaluateAiProviders({ configured }) {
  if (configured.length === 0) {
    return checkResult('ai-providers', 'pass',
      'No hosted AI provider configured; analysis runs deterministic and hosted narrative layers are disabled. Optional on the hosted analyzer only: set DEEPINFRA_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, or a hosted OPENAI_BASE_URL.');
  }
  return checkResult('ai-providers', 'pass', `Configured hosted AI provider(s): ${configured.join('; ')}.`);
}

export function evaluateZstd({ zstdAvailable, compressedFiles }) {
  if (zstdAvailable) return checkResult('zstd', 'pass', 'zstd binary available for compressed analysis storage.');
  if (compressedFiles > 0) {
    return checkResult('zstd', 'fail',
      `${compressedFiles} stored analysis file(s) use zstd compression but the zstd binary is missing; those analyses cannot be loaded.`,
      'Install zstd (macOS: brew install zstd; Debian/Ubuntu: apt-get install zstd) and re-run.');
  }
  return checkResult('zstd', 'warn',
    'zstd binary not found; storage falls back to brotli (slower compression, fully functional).',
    'Optional: install zstd (macOS: brew install zstd) for faster analysis storage.');
}

export function hasZstdBinary() {
  return spawnSync('zstd', ['--version'], { stdio: 'ignore' }).status === 0;
}

export function countZstdAnalysisFiles(analysesDir) {
  let count = 0;
  let entries;
  try {
    entries = fs.readdirSync(analysesDir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.endsWith('.zst')) count += 1;
  }
  return count;
}

export function findKlauroProcesses() {
  const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (ps.status !== 0 || !ps.stdout) return [];
  return ps.stdout
    .split('\n')
    .filter(line => /dist\/(index|server)\.cjs/.test(line))
    .map(line => {
      const trimmed = line.trim();
      const pid = Number(trimmed.split(/\s+/)[0]);
      return { pid, command: trimmed.slice(String(pid).length).trim() };
    })
    .filter(item => Number.isFinite(item.pid) && item.pid !== process.pid);
}

export function evaluateWatches(processes) {
  if (processes.length === 0) {
    return checkResult('watches', 'pass',
      'No Klauro MCP server processes running; no active watch sessions (watch sessions live inside a running server process).');
  }
  return checkResult('watches', 'pass',
    `${processes.length} Klauro MCP server process(es) running (pids: ${processes.map(item => item.pid).join(', ')}). Watch sessions, if any, are in-process; query list_watches via MCP for details.`);
}

function jsonRpcLines(messages) {
  return messages.map(message => JSON.stringify(message)).join('\n') + '\n';
}

export function probeHandshake({ bundlePath, profile = 'core', maxMs = DEFAULT_HANDSHAKE_LIMIT_MS, timeoutMs = 20000, env = process.env, nodePath = process.execPath }) {
  return new Promise(resolve => {
    const startedAt = process.hrtime.bigint();
    const child = spawn(nodePath, [bundlePath], {
      env: { ...env, KLAURO_TOOL_PROFILE: profile },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, ms: null, detail: `No initialize response within ${timeoutMs}ms. stderr: ${stderrBuffer.trim().slice(0, 300) || 'none'}` }), timeoutMs);
    child.on('error', error => finish({ ok: false, ms: null, detail: `Failed to spawn ${nodePath}: ${error.message}` }));
    child.stderr.on('data', chunk => { stderrBuffer += chunk.toString(); });
    child.stdout.on('data', chunk => {
      stdoutBuffer += chunk.toString();
      let newlineIndex;
      while ((newlineIndex = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          finish({ ok: false, ms: null, detail: `Non-JSON line on stdout: ${line.slice(0, 200)}` });
          return;
        }
        if (message.id === 1) {
          const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
          finish({
            ok: ms <= maxMs && Boolean(message.result),
            ms,
            limitMs: maxMs,
            serverInfo: message.result?.serverInfo,
            detail: message.result
              ? `initialize answered in ${ms.toFixed(0)}ms (limit ${maxMs}ms)`
              : `initialize returned an error: ${JSON.stringify(message.error).slice(0, 200)}`,
          });
          return;
        }
      }
    });
    child.stdin.write(jsonRpcLines([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'klauro-environment-check', version: '1.0.0' } } },
    ]));
  });
}

export function callBundleTool({ bundlePath, tool, args = {}, profile = 'core', timeoutMs = 120000, env = process.env, nodePath = process.execPath }) {
  return new Promise(resolve => {
    const child = spawn(nodePath, [bundlePath], {
      env: { ...env, KLAURO_TOOL_PROFILE: profile },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let settled = false;
    const startedAt = Date.now();
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, detail: `No ${tool} response within ${timeoutMs}ms. stderr: ${stderrBuffer.trim().slice(0, 300) || 'none'}` }), timeoutMs);
    child.on('error', error => finish({ ok: false, detail: `Failed to spawn ${nodePath}: ${error.message}` }));
    child.stderr.on('data', chunk => { stderrBuffer += chunk.toString(); });
    child.stdout.on('data', chunk => {
      stdoutBuffer += chunk.toString();
      let newlineIndex;
      while ((newlineIndex = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id !== 2) continue;
        if (message.error) {
          finish({ ok: false, ms: Date.now() - startedAt, detail: `${tool} returned a protocol error: ${JSON.stringify(message.error).slice(0, 300)}` });
          return;
        }
        const text = message.result?.content?.[0]?.text;
        let payload;
        try {
          payload = text ? JSON.parse(text) : message.result;
        } catch {
          payload = { raw: text };
        }
        finish({ ok: !message.result?.isError, ms: Date.now() - startedAt, payload, detail: `${tool} answered in ${Date.now() - startedAt}ms` });
        return;
      }
    });
    child.stdin.write(jsonRpcLines([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'klauro-environment-check', version: '1.0.0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } },
    ]));
  });
}

export function decideBuildAction({ distComplete, rebuildRequested }) {
  if (rebuildRequested) return { build: true, reason: 'rebuild requested with --rebuild' };
  if (!distComplete) return { build: true, reason: 'dist/ bundle missing or incomplete' };
  return { build: false, reason: 'existing dist/ bundle found (pass --rebuild to force a rebuild)' };
}

export function claudeRegisterCommand(bundlePath, scope = 'user') {
  return `claude mcp add --scope ${scope} klauro -- node ${bundlePath}`;
}

export function mcpJsonSnippet(bundlePath, packageRoot) {
  return JSON.stringify({
    mcpServers: {
      klauro: {
        command: 'node',
        args: [bundlePath],
        cwd: packageRoot,
      },
    },
  }, null, 2);
}

export function codexInstructions(bundlePath) {
  return [
    'Codex CLI:',
    `  codex mcp add klauro -- node ${bundlePath}`,
    '',
    'Or add to ~/.codex/config.toml:',
    '  [mcp_servers.klauro]',
    '  command = "node"',
    `  args = ["${bundlePath}"]`,
  ].join('\n');
}

function operatingLoopBody() {
  return [
    OPERATING_LOOP_MARKER,
    '',
    'Before broad file reads, use the Klauro MCP server for this repository.',
    '',
    '1. Call resolve_agent_analysis with the repository path and the current task; use the selected path when it differs.',
    '2. Call get_agent_start_context with the selected path before broad file reads.',
    '3. Call get_agent_tool_plan with the task type (orient, modify, debug, review, trace, cross-repo, or runtime).',
    '4. Call get_agent_context for real work so CAS resolves the target, risk, tests, call context, and first files to inspect.',
    '5. If no analysis exists, run analyze_codebase with analysis_focus "agent-fast" first.',
    '6. Read source files after MCP narrows the target to specific files, nodes, or explicit CAS gaps.',
    '7. After edits, call validate_behavioral_invariants and validate_codebase_idioms before finalizing.',
    '8. If CAS/MCP errors or readiness fails, report that as a blocker and fall back to direct code reading.',
  ].join('\n');
}

export function operatingLoopSnippet() {
  return [OPERATING_LOOP_BEGIN_MARKER, operatingLoopBody(), OPERATING_LOOP_END_MARKER].join('\n');
}

export function legacyOperatingLoopSnippet() {
  return operatingLoopBody();
}

export function shouldAppendOperatingLoop(existingContent) {
  return !String(existingContent || '').includes(OPERATING_LOOP_MARKER);
}

export function removeOperatingLoop(existingContent) {
  const original = String(existingContent || '');
  let content = original;

  const markedBlock = new RegExp(
    `${escapeRegExp(OPERATING_LOOP_BEGIN_MARKER)}[\\s\\S]*?${escapeRegExp(OPERATING_LOOP_END_MARKER)}`,
    'g',
  );
  content = content.replace(markedBlock, '');

  // Legacy installs wrote the bare snippet without markers; remove the exact
  // block. Tolerate trailing-list drift by also matching from the heading to
  // the end of the numbered list when the exact text is absent.
  const legacy = legacyOperatingLoopSnippet();
  if (content.includes(legacy)) {
    content = content.replace(legacy, '');
  } else if (content.includes(OPERATING_LOOP_MARKER)) {
    const headingPattern = new RegExp(
      `${escapeRegExp(OPERATING_LOOP_MARKER)}\\n[\\s\\S]*?(?:\\n\\d+\\..*)+`,
    );
    content = content.replace(headingPattern, '');
  }

  content = content.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n{2,}$/, '\n');
  if (content.trim().length === 0) {
    content = '';
  } else if (!content.endsWith('\n')) {
    content = `${content}\n`;
  }
  return { content, removed: content !== original };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
