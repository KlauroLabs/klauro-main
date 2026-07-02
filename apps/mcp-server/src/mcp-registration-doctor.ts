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

/**
 * Reads a JSON file defensively; returns undefined on any read/parse failure
 * (missing file, malformed JSON, permission error) rather than throwing, since
 * this is a best-effort scan across several possible client config locations.
 */
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

/**
 * Scans ~/.claude.json for a registered `klauro` MCP server entry.
 * Checks both the top-level (user-scope) mcpServers and, if projectPath is
 * given, that project's entry under projects[projectPath].mcpServers.
 */
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

/**
 * Scans ~/.cursor/mcp.json for a `klauro` server entry (top-level `mcpServers`
 * key, same shape Cursor documents). Detection only, same as Codex/VS Code.
 */
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

/**
 * Config locations we know about but do not deeply parse (different formats:
 * Codex uses TOML, VS Code's mcp.json has its own dialect). Listed so the
 * doctor output tells the agent where else to look by hand.
 */
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

/**
 * Best-effort boot probe: spawns `node <entryPath>` with stdin closed and a
 * tight timeout, and classifies the outcome from stderr text emitted by
 * index.ts's reportGrammarHealth(). Never lets the process hang past maxMs.
 */
export function probeMcpBoot(options: {
  entryPath: string;
  maxMs?: number;
  nodePath?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<BootProbeResult> {
  const { entryPath, maxMs = 4000, nodePath = process.execPath, env = process.env } = options;
  return new Promise(resolve => {
    if (!fs.existsSync(entryPath)) {
      resolve({ status: 'fail', detail: `Entry point does not exist: ${entryPath}` });
      return;
    }

    let settled = false;
    let stderrBuffer = '';
    // Do NOT set KLAURO_DEFER_START: the grammar-health self-check only runs
    // inside startServer() (see src/index.ts), so the real server boot path
    // must execute. Closing stdin immediately below triggers index.ts's
    // `stdin.on('end', () => process.exit(0))` so the process exits promptly
    // once we've captured its stderr, instead of idling as a live MCP server.
    const child = spawn(nodePath, [entryPath], {
      env: { ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const finish = (result: BootProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // process may already be gone
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish(classifyBootOutput(stderrBuffer, 'timeout'));
    }, maxMs);

    child.on('error', error => {
      finish({ status: 'fail', detail: `Failed to spawn ${nodePath} ${entryPath}: ${error.message}` });
    });

    child.stderr.on('data', chunk => {
      stderrBuffer += chunk.toString();
      if (/grammars available|grammar self-check failed|tree-sitter grammars/.test(stderrBuffer)) {
        finish(classifyBootOutput(stderrBuffer, 'stderr-signal'));
      }
    });

    child.on('exit', code => {
      finish(classifyBootOutput(stderrBuffer, `exit-${code}`));
    });

    // Closing stdin immediately can race the async grammar-health check in
    // index.ts's startServer() path (grammar resolution does async I/O), so
    // the process can exit cleanly before it ever writes the health line.
    // Give it a short head start to boot and emit stderr, bounded well under
    // maxMs, before closing stdin to trigger the documented graceful-exit path.
    const stdinCloseDelayMs = Math.min(1500, Math.floor(maxMs / 2));
    const stdinTimer = setTimeout(() => {
      try {
        child.stdin.end();
      } catch {
        // ignore: process may already be gone
      }
    }, stdinCloseDelayMs);
    child.on('exit', () => clearTimeout(stdinTimer));
  });
}

function classifyBootOutput(stderrBuffer: string, reason: string): BootProbeResult {
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

/**
 * Builds the "mcp-registration" doctor check: is the klauro MCP registered in
 * a known client config, does its entry point resolve on disk, and does it
 * boot cleanly. Non-fatal by design (status ok maps to 'pass', never blocks
 * the rest of the doctor run) — this answers "is my Klauro MCP actually
 * registered + loadable in this client?" per SPEC-COORDINATION-FABRIC WS-J.
 */
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

  // Prefer the entry that actually points at something (real command/args) for
  // the entry-point-resolvable and boot checks below.
  const primary = registeredIn[0];
  const configuredEntryPoint = resolveConfiguredEntryPoint(primary.entry);
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

  const bootResult = await probeMcpBoot({ entryPath: entryPointToCheck, maxMs: options.bootMaxMs ?? 4000 });
  const bootStatus: 'pass' | 'warn' | 'fail' = bootResult.status === 'ok' ? 'pass' : bootResult.status;

  return {
    id: 'mcp-registration',
    status: bootStatus,
    detail: `Registered in ${registeredIn.map(r => r.configPath).join(', ')} (${registrationSummary}); entry point exists at ${entryPointToCheck}. Boot probe: ${bootResult.detail} ${uncheckedNote}`,
    fix: bootStatus === 'pass'
      ? undefined
      : `Rebuild the bundle (npm --prefix ${options.packageRoot} run build) and re-run \`node ${entryPointToCheck}\` manually to see full stderr output.`,
  };
}

function resolveConfiguredEntryPoint(entry: RegisteredMcpEntry | undefined): string | undefined {
  if (!entry || !entry.args) return undefined;
  // The launcher is invoked as `node <path-to-index.cjs>`; find the first arg
  // that looks like a path to a .cjs/.js file.
  const candidate = entry.args.find(a => /\.(cjs|mjs|js)$/.test(a));
  return candidate;
}
