#!/usr/bin/env node
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  DEFAULT_HANDSHAKE_LIMIT_MS,
  callBundleTool,
  claudeRegisterCommand,
  codexInstructions,
  decideBuildAction,
  evaluateNodeVersion,
  formatCheck,
  inspectClientBundle,
  inspectStorage,
  mcpJsonSnippet,
  operatingLoopSnippet,
  probeHandshake,
  shouldAppendOperatingLoop,
} from './environment-checks.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = path.join(packageRoot, 'dist', 'index.cjs');
const cliPath = path.join(packageRoot, 'dist', 'cli.cjs');

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}

const failures = [];
let stepNumber = 0;
const totalSteps = options.firstValue ? 8 : 7;

function step(title) {
  stepNumber += 1;
  print(`\n[${stepNumber}/${totalSteps}] ${title}`);
}

function print(line = '') {
  process.stdout.write(`${line}\n`);
}

function report(check) {
  print(formatCheck(check));
  if (check.status === 'fail') failures.push(check);
}

function run(command, args, opts = {}) {
  print(`     running: ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: packageRoot, stdio: 'inherit', ...opts });
  return result.status === 0;
}

print('Klauro install');
print(`Server package: ${packageRoot}`);

step('Checking prerequisites');
const nodeCheck = evaluateNodeVersion(process.version);
report(nodeCheck);
if (nodeCheck.status === 'fail') {
  finish();
}
const npmVersion = spawnSync('npm', ['--version'], { encoding: 'utf8' });
if (npmVersion.status === 0) {
  report({ id: 'npm', status: 'pass', detail: `npm ${npmVersion.stdout.trim()} available` });
} else {
  report({ id: 'npm', status: 'fail', detail: 'npm not found on PATH.', fix: 'Install Node.js (which includes npm) from https://nodejs.org and re-run.' });
  finish();
}

step('Installing dependencies');
const depsPresent = fs.existsSync(path.join(packageRoot, 'node_modules', '.bin', 'tsx'));
if (depsPresent) {
  report({ id: 'dependencies', status: 'pass', detail: 'node_modules already installed; skipping npm install.' });
} else if (run('npm', ['install'])) {
  report({ id: 'dependencies', status: 'pass', detail: 'npm install completed.' });
} else {
  report({ id: 'dependencies', status: 'fail', detail: 'npm install failed (see output above).', fix: `Run npm install manually in ${packageRoot} and re-run this installer.` });
  finish();
}

step('Locating the server bundle');
let bundleInspection = inspectClientBundle(path.join(packageRoot, 'dist'));
const buildAction = decideBuildAction({ distComplete: bundleInspection.complete, rebuildRequested: options.rebuild });
if (!buildAction.build) {
  report({ id: 'bundle', status: 'pass', detail: `Using ${bundlePath}: ${buildAction.reason}.` });
} else {
  print(`     building bundle: ${buildAction.reason}`);
  print('     note: do not rebuild while another process is actively serving from dist/.');
  if (run('npm', ['run', 'build'])) {
    bundleInspection = inspectClientBundle(path.join(packageRoot, 'dist'));
    if (bundleInspection.complete) {
      report({ id: 'bundle', status: 'pass', detail: `Built and verified ${bundlePath}.` });
    } else {
      report({
        id: 'bundle',
        status: 'fail',
        detail: `Build completed but the client bundle is incomplete: ${bundleInspection.missing.join(', ')}.`,
        fix: `Run npm run build in ${packageRoot} and verify the installed-client dist files.`,
      });
      finish();
    }
  } else {
    report({ id: 'bundle', status: 'fail', detail: 'npm run build failed (see output above).', fix: `Run npm run build manually in ${packageRoot} and re-run this installer.` });
    finish();
  }
}

step('Preparing local storage');
report(inspectStorage(process.env));

step('Registering with Claude Code');
const registerCommand = claudeRegisterCommand(bundlePath, options.claudeScope);
const claudeAvailable = spawnSync('claude', ['--version'], { encoding: 'utf8' }).status === 0;
if (!options.register) {
  report({ id: 'claude-register', status: 'warn', detail: 'Registration skipped (--no-register).', fix: `Register later with: ${registerCommand}` });
} else if (!claudeAvailable) {
  report({
    id: 'claude-register',
    status: 'warn',
    detail: 'claude CLI not found on PATH; could not register automatically.',
    fix: `Install Claude Code, then run: ${registerCommand}`,
  });
} else {
  const existing = spawnSync('claude', ['mcp', 'get', 'klauro'], { encoding: 'utf8' });
  if (existing.status === 0) {
    report({ id: 'claude-register', status: 'pass', detail: 'klauro MCP server already registered with Claude Code.' });
  } else {
    const added = spawnSync('claude', ['mcp', 'add', '--scope', options.claudeScope, 'klauro', '--', 'node', bundlePath], { encoding: 'utf8' });
    if (added.status === 0) {
      report({ id: 'claude-register', status: 'pass', detail: `Registered klauro with Claude Code (scope: ${options.claudeScope}). Verify with /mcp in a Claude Code session.` });
    } else {
      report({
        id: 'claude-register',
        status: 'fail',
        detail: `claude mcp add failed: ${(added.stderr || added.stdout || '').trim().slice(0, 300) || 'unknown error'}`,
        fix: `Run manually: ${registerCommand}`,
      });
    }
  }
}
print('');
print('Project-scoped alternative (.mcp.json in the target repository):');
print(indent(mcpJsonSnippet(bundlePath, packageRoot)));
print('');
print(codexInstructions(bundlePath));

step('Workspace instructions (CLAUDE.md operating loop)');
if (options.claudeMdRepo) {
  const repoPath = path.resolve(options.claudeMdRepo);
  const claudeMdPath = path.join(repoPath, 'CLAUDE.md');
  if (!fs.existsSync(repoPath)) {
    report({ id: 'claude-md', status: 'fail', detail: `Repository path does not exist: ${repoPath}`, fix: 'Pass an existing repository path to --claude-md.' });
  } else {
    const existingContent = fs.existsSync(claudeMdPath) ? fs.readFileSync(claudeMdPath, 'utf8') : '';
    if (shouldAppendOperatingLoop(existingContent)) {
      const separator = existingContent && !existingContent.endsWith('\n\n') ? (existingContent.endsWith('\n') ? '\n' : '\n\n') : '';
      fs.writeFileSync(claudeMdPath, `${existingContent}${separator}${operatingLoopSnippet()}\n`);
      report({ id: 'claude-md', status: 'pass', detail: `Appended the Klauro operating loop to ${claudeMdPath}.` });
    } else {
      report({ id: 'claude-md', status: 'pass', detail: `${claudeMdPath} already contains the Klauro operating loop; left unchanged.` });
    }
  }
} else {
  report({ id: 'claude-md', status: 'pass', detail: 'No --claude-md <repo> given; printing the operating-loop snippet to copy into your project CLAUDE.md.' });
  print('');
  print(indent(operatingLoopSnippet()));
}

step('Self-check');
if (options.selfCheck) {
  const maxMs = Number(process.env.KLAURO_SMOKE_MAX_STARTUP_MS || DEFAULT_HANDSHAKE_LIMIT_MS);
  const handshake = await probeHandshake({ bundlePath, profile: 'core', maxMs });
  report({
    id: 'handshake',
    status: handshake.ok ? 'pass' : 'fail',
    detail: handshake.detail,
    fix: handshake.ok ? undefined : `Rebuild the bundle (npm run build in ${packageRoot}) and check that node ${bundlePath} starts cleanly.`,
  });

  const smokePath = path.resolve(options.smokePath || process.cwd());
  const smoke = await callBundleTool({ bundlePath, tool: 'resolve_agent_analysis', args: { path: smokePath } });
  if (!smoke.ok) {
    report({ id: 'resolve-smoke', status: 'fail', detail: smoke.detail, fix: 'The MCP server failed to answer resolve_agent_analysis; run klauro doctor for environment details.' });
  } else if (smoke.payload?.selected_path) {
    report({ id: 'resolve-smoke', status: 'pass', detail: `resolve_agent_analysis answered in ${smoke.ms}ms; selected analysis: ${smoke.payload.selected_path}` });
  } else {
    report({ id: 'resolve-smoke', status: 'pass', detail: `resolve_agent_analysis answered in ${smoke.ms}ms. No analyses yet for ${smokePath} — that is expected on a fresh install.` });
    print(`     next: npm --prefix ${packageRoot} --silent run analyze -- ${smokePath} --analysis-focus agent-fast`);
  }
} else {
  report({ id: 'self-check', status: 'warn', detail: 'Self-check skipped (--skip-self-check).', fix: `Run later: npm --prefix ${packageRoot} run doctor` });
}

if (options.firstValue) {
  step('Producing first value');
  const repoPath = path.resolve(options.smokePath || process.cwd());
  if (!fs.existsSync(repoPath)) {
    report({ id: 'first-value', status: 'fail', detail: `Repository path does not exist: ${repoPath}`, fix: 'Pass an existing repository path as [repo-path].' });
  } else if (!fs.existsSync(cliPath)) {
    report({ id: 'first-value', status: 'fail', detail: `Bundled CLI missing: ${cliPath}`, fix: `Run npm --prefix ${packageRoot} run build and re-run with --first-value.` });
  } else {
    const firstValue = runFirstValue(repoPath);
    report(firstValue.analysisCheck);
    report(firstValue.contextCheck);
    if (firstValue.summary) {
      print('');
      print('First value summary:');
      print(indent(firstValue.summary));
    }
  }
}

finish();

function finish() {
  print('');
  if (failures.length > 0) {
    print(`Klauro install: FAIL (${failures.length} blocking issue(s))`);
    for (const failure of failures) {
      print(`- ${failure.id}: ${failure.fix || failure.detail}`);
    }
    process.exit(1);
  }
  print('Klauro install: OK');
  if (options.firstValue) {
    print('Next steps:');
    print(`  1. Ask your agent to use Klauro before broad source reads.`);
    print(`  2. Environment health: npm --prefix ${packageRoot} run doctor`);
    print('  3. In Claude Code, confirm the klauro server with /mcp, then start with resolve_agent_analysis.');
  } else {
    print('Next steps:');
    print(`  1. Get first value now: node ${path.join(packageRoot, 'scripts', 'install.mjs')} /path/to/repo --first-value --no-register`);
    print(`  2. Analyze a repository: npm --prefix ${packageRoot} --silent run analyze -- /path/to/repo --analysis-focus agent-fast`);
    print(`  3. Environment health: npm --prefix ${packageRoot} run doctor`);
    print('  4. In Claude Code, confirm the klauro server with /mcp, then start with resolve_agent_analysis.');
  }
  process.exit(failures.length > 0 ? 1 : 0);
}

function runFirstValue(repoPath) {
  const startedAt = Date.now();
  const analyze = spawnSync(process.execPath, [
    cliPath,
    'analyze',
    repoPath,
    '--analysis-focus',
    'agent-fast',
    '--quiet',
    '--json',
  ], { cwd: packageRoot, encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024 });
  if (analyze.status !== 0) {
    return {
      analysisCheck: {
        id: 'first-value-analysis',
        status: 'fail',
        detail: `agent-fast analysis failed: ${trimCommandOutput(analyze.stderr || analyze.stdout)}`,
        fix: `Run manually: node ${cliPath} analyze ${repoPath} --analysis-focus agent-fast --json`,
      },
      contextCheck: { id: 'first-value-agent-context', status: 'fail', detail: 'Skipped because analysis failed.' },
    };
  }

  let analyzePayload;
  try {
    analyzePayload = JSON.parse(analyze.stdout);
  } catch {
    analyzePayload = undefined;
  }

  const contextResult = spawnSync(process.execPath, [
    cliPath,
    'agent-context',
    repoPath,
    '--task-type',
    'orient',
    '--target',
    'system overview',
    '--response-profile',
    'capsule-only',
    '--quiet',
    '--json',
  ], { cwd: packageRoot, encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024 });
  if (contextResult.status !== 0) {
    return {
      analysisCheck: {
        id: 'first-value-analysis',
        status: 'pass',
        detail: `agent-fast analysis completed in ${Date.now() - startedAt}ms (${analyzePayload?.output?.nodes?.length || 0} nodes).`,
      },
      contextCheck: {
        id: 'first-value-agent-context',
        status: 'fail',
        detail: `agent context failed: ${trimCommandOutput(contextResult.stderr || contextResult.stdout)}`,
        fix: `Run manually: node ${cliPath} agent-context ${repoPath} --task-type orient --target "system overview" --response-profile capsule-only --json`,
      },
    };
  }

  let contextPayload;
  try {
    contextPayload = JSON.parse(contextResult.stdout);
  } catch {
    contextPayload = undefined;
  }

  const output = analyzePayload?.output || {};
  const firstFiles = contextPayload?.first_files_to_read || contextPayload?.file_plan?.first_files_to_read || [];
  const totalMs = Date.now() - startedAt;
  return {
    analysisCheck: {
      id: 'first-value-analysis',
      status: 'pass',
      detail: `agent-fast analysis completed in ${totalMs}ms (${output.nodes?.length || 0} nodes, ${output.edges?.length || 0} edges, ${output.entry_points?.length || 0} entry points).`,
    },
    contextCheck: {
      id: 'first-value-agent-context',
      status: contextPayload ? 'pass' : 'warn',
      detail: contextPayload
        ? `Generated agent context with ${Array.isArray(firstFiles) ? firstFiles.length : 0} first file(s) and ${contextPayload.token_budget?.estimated_tokens || contextPayload.budget?.estimated_tokens || 'compact'} token budget.`
        : 'Agent context completed but JSON output could not be parsed.',
    },
    summary: [
      `Repo: ${repoPath}`,
      `System: ${output.system?.name || path.basename(repoPath)}`,
      `Graph: ${output.nodes?.length || 0} nodes, ${output.edges?.length || 0} edges, ${output.entry_points?.length || 0} entry points`,
      `Agent context: ${contextPayload?.task?.task_type || 'orient'} / ${contextPayload?.task?.target || 'system overview'}`,
      firstFiles.length ? `First files: ${firstFiles.slice(0, 5).map(file => typeof file === 'string' ? file : file.path || file.file).filter(Boolean).join(', ')}` : 'First files: none reported',
    ].join('\n'),
  };
}

function trimCommandOutput(output) {
  return String(output || 'unknown error').trim().replace(/\s+/g, ' ').slice(0, 600);
}

function indent(text) {
  return text.split('\n').map(line => `  ${line}`).join('\n');
}

function parseArgs(argv) {
  const parsed = {
    register: true,
    rebuild: false,
    selfCheck: true,
    firstValue: false,
    claudeScope: 'user',
    claudeMdRepo: undefined,
    smokePath: undefined,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-register') parsed.register = false;
    else if (arg === '--rebuild') parsed.rebuild = true;
    else if (arg === '--skip-self-check') parsed.selfCheck = false;
    else if (arg === '--first-value') parsed.firstValue = true;
    else if (arg === '--claude-scope') parsed.claudeScope = argv[++i];
    else if (arg === '--claude-md') parsed.claudeMdRepo = argv[++i];
    else if (arg === '--smoke-path') parsed.smokePath = argv[++i];
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (!parsed.smokePath && !arg.startsWith('--')) parsed.smokePath = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function printHelp() {
  print([
    'Usage: node scripts/install.mjs [repo-path] [options]',
    '',
    'Installs the Klauro MCP server end to end: verifies prerequisites, installs',
    'dependencies, locates or builds the bundled server, prepares ~/.klauro storage,',
    'registers the server with Claude Code, prints Codex registration instructions,',
    'offers the CLAUDE.md operating loop, and runs a startup self-check.',
    'Idempotent: safe to re-run.',
    '',
    'Options:',
    '  [repo-path]            Repository used for the resolve_agent_analysis self-check (default: cwd)',
    '  --claude-md <repo>     Append the Klauro operating loop to <repo>/CLAUDE.md (idempotent)',
    '  --claude-scope <s>     Scope for claude mcp add: user (default), project, or local',
    '  --no-register          Skip claude mcp add; print the command instead',
    '  --rebuild              Force npm run build even when dist/ exists',
    '  --skip-self-check      Skip the handshake and resolve_agent_analysis self-check',
    '  --first-value          Analyze [repo-path] with the fast agent layer and print an agent context summary',
    '  -h, --help             Show this help',
  ].join('\n'));
}
