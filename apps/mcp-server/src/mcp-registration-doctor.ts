import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface EnvironmentCheck {
  id: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
  fix?: string;
}

export interface RegisteredMcpEntry {
  configPath: string;
  scope: string;
  command?: string;
  args?: string[];
}

export interface McpConfigProbeResult {
  configPath: string;
  scope: string;
  exists: boolean;
  registered: boolean;
  entry?: RegisteredMcpEntry;
  error?: string;
}






function readJsonFile(filePath: string): unknown {
  try {
    if (!fs.existsSync(filePath)) return undefined;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function extractKlauroEntry(mcpServers: unknown): { command?: string; args?: string[] } | undefined {
  if (!mcpServers || typeof mcpServers !== 'object') return undefined;
  const entry = (mcpServers as Record<string, unknown>).klauro;
  if (!entry || typeof entry !== 'object') return undefined;
  const record = entry as Record<string, unknown>;
  const command = typeof record.command === 'string' ? record.command : undefined;
  const args = Array.isArray(record.args) ? record.args.filter((a): a is string => typeof a === 'string') : undefined;
  return { command, args };
}






export function probeClaudeJson(options: {
  homeDir?: string;
  projectPath?: string;
} = {}): McpConfigProbeResult {
  const homeDir = options.homeDir ?? os.homedir();
  const configPath = path.join(homeDir, '.claude.json');
  const data = readJsonFile(configPath);
  if (data === undefined) {
    return { configPath, scope: 'user', exists: fs.existsSync(configPath), registered: false };
  }
  const record = data as Record<string, unknown>;

  const topLevel = extractKlauroEntry(record.mcpServers);
  if (topLevel) {
    return {
      configPath,
      scope: 'user (top-level mcpServers)',
      exists: true,
      registered: true,
      entry: { configPath, scope: 'user', command: topLevel.command, args: topLevel.args },
    };
  }

  if (options.projectPath && record.projects && typeof record.projects === 'object') {
    const projects = record.projects as Record<string, unknown>;
    const project = projects[options.projectPath];
    if (project && typeof project === 'object') {
      const projectEntry = extractKlauroEntry((project as Record<string, unknown>).mcpServers);
      if (projectEntry) {
        return {
          configPath,
          scope: `project (${options.projectPath})`,
          exists: true,
          registered: true,
          entry: { configPath, scope: `project (${options.projectPath})`, command: projectEntry.command, args: projectEntry.args },
        };
      }
    }
  }

  return { configPath, scope: 'user', exists: true, registered: false };
}





export function probeCursorMcpJson(options: { homeDir?: string } = {}): McpConfigProbeResult {
  const homeDir = options.homeDir ?? os.homedir();
  const configPath = path.join(homeDir, '.cursor', 'mcp.json');
  const data = readJsonFile(configPath);
  if (data === undefined) {
    return { configPath, scope: 'cursor', exists: fs.existsSync(configPath), registered: false };
  }
  const record = data as Record<string, unknown>;
  const entry = extractKlauroEntry(record.mcpServers);
  if (entry) {
    return {
      configPath,
      scope: 'cursor',
      exists: true,
      registered: true,
      entry: { configPath, scope: 'cursor', command: entry.command, args: entry.args },
    };
  }
  return { configPath, scope: 'cursor', exists: true, registered: false };
}

export interface UncheckedClientConfig {
  client: string;
  configPath: string;
}






export function listUncheckedClientConfigs(homeDir: string = os.homedir()): UncheckedClientConfig[] {
  return [
    { client: 'Codex CLI', configPath: path.join(homeDir, '.codex', 'config.toml') },
    {
      client: 'VS Code',
      configPath: path.join(homeDir, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'),
    },
  ];
}

export interface BootProbeResult {
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}








export function probeMcpBoot(options: {
  entryPath: string;
  maxMs?: number;
  nodePath?: string;
  env?: NodeJS.ProcessEnv;



  spawnArgs?: string[];
}): Promise<BootProbeResult> {
  const { entryPath, maxMs = 4000, nodePath = process.execPath, env = process.env, spawnArgs } = options;
  return new Promise(resolve => {
    if (!fs.existsSync(entryPath)) {
      resolve({ status: 'fail', detail: `Entry point does not exist: ${entryPath}` });
      return;
    }

    let settled = false;
    let stderrBuffer = '';
    let stdoutBuffer = '';





    const child = spawnArgs
      ? spawn(entryPath, spawnArgs, { env: { ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(nodePath, [entryPath], { env: { ...env }, stdio: ['pipe', 'pipe', 'pipe'] });

    const finish = (result: BootProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {

      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish(classifyBootOutput(stderrBuffer, 'timeout', answeredInitialize(stdoutBuffer)));
    }, maxMs);

    child.on('error', error => {
      finish({ status: 'fail', detail: `Failed to spawn ${nodePath} ${entryPath}: ${error.message}` });
    });

    child.stderr.on('data', chunk => {
      stderrBuffer += chunk.toString();
      if (/grammars available|grammar self-check failed|tree-sitter grammars/.test(stderrBuffer)) {
        finish(classifyBootOutput(stderrBuffer, 'stderr-signal', answeredInitialize(stdoutBuffer)));
      }
    });

    child.stdout.on('data', chunk => {
      stdoutBuffer += chunk.toString();
    });

    child.stdin.on('error', () => undefined);
    child.stdin.write(`${JSON.stringify(INITIALIZE_REQUEST)}\n`);

    child.on('exit', code => {
      finish(classifyBootOutput(stderrBuffer, `exit-${code}`, answeredInitialize(stdoutBuffer)));
    });






    const stdinCloseDelayMs = Math.min(1500, Math.floor(maxMs / 2));
    const stdinTimer = setTimeout(() => {
      try {
        child.stdin.end();
      } catch {

      }
    }, stdinCloseDelayMs);
    child.on('exit', () => clearTimeout(stdinTimer));
  });
}

const INITIALIZE_REQUEST = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'klauro-doctor', version: '1' } },
};

function answeredInitialize(stdoutBuffer: string): boolean {
  return stdoutBuffer.split('\n').some(line => {
    try {
      const message = JSON.parse(line);
      return message?.id === INITIALIZE_REQUEST.id && message.result !== undefined;
    } catch {
      return false;
    }
  });
}

function classifyBootOutput(stderrBuffer: string, reason: string, answeredMcp = false): BootProbeResult {
  const trimmed = stderrBuffer.trim();
  if (/grammar self-check failed/.test(trimmed)) {
    return { status: 'fail', detail: `Entry point threw during grammar self-check: ${trimmed.slice(0, 300)}` };
  }
  if (/WARNING: 0 tree-sitter grammars/.test(trimmed)) {
    return { status: 'warn', detail: `Entry point started but resolved 0 tree-sitter grammars: ${trimmed.slice(0, 300)}` };
  }
  if (/WARNING: only \d+ tree-sitter grammars/.test(trimmed)) {
    return { status: 'warn', detail: `Entry point started with degraded grammar coverage: ${trimmed.slice(0, 300)}` };
  }
  if (/\d+ tree-sitter grammars available/.test(trimmed)) {
    return { status: 'ok', detail: trimmed.slice(0, 300) };
  }
  if (answeredMcp) {
    return { status: 'ok', detail: 'Entry point answered the MCP initialize handshake.' };
  }
  if (reason === 'timeout') {
    return {
      status: trimmed ? 'warn' : 'fail',
      detail: trimmed
        ? `No grammar-health signal within the timeout, but the process produced output: ${trimmed.slice(0, 300)}`
        : 'Entry point produced no output before the boot-probe timeout (process may be hanging or crashed silently).',
    };
  }
  if (/^exit-0$/.test(reason)) {
    return { status: 'warn', detail: 'Entry point exited cleanly before emitting a grammar-health line.' };
  }
  return {
    status: 'fail',
    detail: `Entry point exited unexpectedly (${reason}). stderr: ${trimmed.slice(0, 300) || 'none'}`,
  };
}








export async function checkMcpRegistration(options: {
  packageRoot: string;
  projectPath?: string;
  homeDir?: string;
  probeBoot?: boolean;
  bootMaxMs?: number;
} = { packageRoot: '' }): Promise<EnvironmentCheck> {
  const homeDir = options.homeDir ?? os.homedir();
  const packagedEntry = path.join(options.packageRoot, 'dist', 'index.cjs');

  const claudeProbe = probeClaudeJson({ homeDir, projectPath: options.projectPath });
  const cursorProbe = probeCursorMcpJson({ homeDir });
  const unchecked = listUncheckedClientConfigs(homeDir);

  const registeredIn: McpConfigProbeResult[] = [claudeProbe, cursorProbe].filter(p => p.registered);

  const uncheckedNote = `Not checked in this pass: ${unchecked.map(u => `${u.client} (${u.configPath})`).join(', ')}.`;

  if (registeredIn.length === 0) {
    const scannedPaths = [claudeProbe, cursorProbe].map(p => p.configPath).join(', ');
    return {
      id: 'mcp-registration',
      status: 'warn',
      detail: `No 'klauro' MCP server entry found in scanned client configs (${scannedPaths}). ${uncheckedNote}`,
      fix: 'Run `klauro install --claude-scope user` then restart your client. If you use another MCP client, register klauro there manually and restart it.',
    };
  }



  const primary = registeredIn[0];






  const binaryMode = isBinaryModeMcpEntry(primary.entry);
  const configuredEntryPoint = binaryMode ? primary.entry?.command : resolveConfiguredEntryPoint(primary.entry);
  const entryPointToCheck = configuredEntryPoint ?? packagedEntry;
  const entryExists = fs.existsSync(entryPointToCheck);

  const registrationSummary = registeredIn
    .map(r => `${r.scope}: command=${r.entry?.command ?? 'unknown'} args=${JSON.stringify(r.entry?.args ?? [])}`)
    .join('; ');

  if (!entryExists) {
    return {
      id: 'mcp-registration',
      status: 'fail',
      detail: `Registered in ${registeredIn.map(r => r.configPath).join(', ')} (${registrationSummary}), but the configured entry point does not exist on disk: ${entryPointToCheck}. ${uncheckedNote}`,
      fix: `Run \`npm --prefix ${options.packageRoot} run build\` to regenerate the bundle, or reinstall with \`klauro install --claude-scope user\` if the config points at a stale path.`,
    };
  }

  if (options.probeBoot === false) {
    return {
      id: 'mcp-registration',
      status: 'pass',
      detail: `Registered in ${registeredIn.map(r => r.configPath).join(', ')} (${registrationSummary}); entry point exists at ${entryPointToCheck}. Boot probe skipped. ${uncheckedNote}`,
    };
  }

  const bootResult = await probeMcpBoot({
    entryPath: entryPointToCheck,
    maxMs: options.bootMaxMs ?? 4000,
    ...(binaryMode ? { spawnArgs: ['__mcp_server'] } : {}),
  });
  const bootStatus: 'pass' | 'warn' | 'fail' = bootResult.status === 'ok' ? 'pass' : bootResult.status;

  return {
    id: 'mcp-registration',
    status: bootStatus,
    detail: `Registered in ${registeredIn.map(r => r.configPath).join(', ')} (${registrationSummary}); entry point exists at ${entryPointToCheck}. Boot probe: ${bootResult.detail} ${uncheckedNote}`,
    fix: bootStatus === 'pass'
      ? undefined
      : binaryMode
        ? `Re-run \`${entryPointToCheck} __mcp_server\` manually to see full stderr output, or reinstall: curl -fsSL https://mcp.klauro.com/install | sh`
        : `Rebuild the bundle (npm --prefix ${options.packageRoot} run build) and re-run \`node ${entryPointToCheck}\` manually to see full stderr output.`,
  };
}

function resolveConfiguredEntryPoint(entry: RegisteredMcpEntry | undefined): string | undefined {
  if (!entry || !entry.args) return undefined;


  const candidate = entry.args.find(a => /\.(cjs|mjs|js)$/.test(a));
  return candidate;
}










function isBinaryModeMcpEntry(entry: RegisteredMcpEntry | undefined): boolean {
  if (!entry?.args?.length) return false;
  return entry.args.includes('__mcp_server') && !entry.args.some(a => /\.(cjs|mjs|js)$/.test(a));
}
