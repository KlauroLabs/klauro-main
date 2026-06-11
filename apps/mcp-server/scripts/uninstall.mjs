#!/usr/bin/env node
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { formatCheck, removeOperatingLoop } from './environment-checks.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}

const failures = [];
let stepNumber = 0;
const totalSteps = 3;

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

print('Klauro uninstall');
print(`Server package: ${packageRoot}`);

step('Removing the Claude Code MCP registration');
if (!options.deregister) {
  report({ id: 'claude-deregister', status: 'warn', detail: 'Deregistration skipped (--no-deregister).', fix: 'Remove later with: claude mcp remove klauro' });
} else {
  const claudeAvailable = spawnSync('claude', ['--version'], { encoding: 'utf8' }).status === 0;
  if (!claudeAvailable) {
    report({
      id: 'claude-deregister',
      status: 'warn',
      detail: 'claude CLI not found on PATH; could not deregister automatically.',
      fix: 'If Klauro was registered, run on a machine with Claude Code: claude mcp remove klauro',
    });
  } else if (spawnSync('claude', ['mcp', 'get', 'klauro'], { encoding: 'utf8' }).status !== 0) {
    report({ id: 'claude-deregister', status: 'pass', detail: 'klauro is not registered with Claude Code; nothing to remove.' });
  } else {
    removeClaudeRegistration();
  }
}

step('Removing the Klauro operating loop from CLAUDE.md');
if (options.claudeMdRepos.length === 0) {
  report({
    id: 'claude-md',
    status: 'pass',
    detail: 'No --claude-md <repo> given. If klauro install appended the operating loop to a project CLAUDE.md, re-run with --claude-md /path/to/repo (repeatable).',
  });
} else {
  for (const repo of options.claudeMdRepos) {
    const repoPath = path.resolve(repo);
    const claudeMdPath = path.join(repoPath, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) {
      report({ id: 'claude-md', status: 'pass', detail: `${claudeMdPath} does not exist; nothing to remove.` });
      continue;
    }
    const existing = fs.readFileSync(claudeMdPath, 'utf8');
    const result = removeOperatingLoop(existing);
    if (!result.removed) {
      report({ id: 'claude-md', status: 'pass', detail: `${claudeMdPath} does not contain the Klauro operating loop; left unchanged.` });
    } else if (result.content === '') {
      fs.unlinkSync(claudeMdPath);
      report({ id: 'claude-md', status: 'pass', detail: `Removed the Klauro operating loop from ${claudeMdPath}; the file contained nothing else, so it was deleted.` });
    } else {
      fs.writeFileSync(claudeMdPath, result.content);
      report({ id: 'claude-md', status: 'pass', detail: `Removed the Klauro operating loop block from ${claudeMdPath} (other content left untouched).` });
    }
  }
}

step('What uninstall does NOT remove');
print('  - Analyzed data under ~/.klauro (analyses, snapshots, caches, embeddings, telemetry, logs, AI cache).');
print('    Remove one project:  klauro purge /path/to/repo');
print('    Remove everything:   klauro purge --all');
print('  - A Codex CLI registration, if you added one: codex mcp remove klauro');
print('  - Project-scoped .mcp.json entries you created manually: delete the "klauro" server entry from those files.');
print(`  - This checkout and its node_modules (${packageRoot}).`);

print('');
if (failures.length > 0) {
  print(`Klauro uninstall: FAIL (${failures.length} blocking issue(s))`);
  for (const failure of failures) {
    print(`- ${failure.id}: ${failure.fix || failure.detail}`);
  }
  process.exit(1);
}
print('Klauro uninstall: OK');
process.exit(0);

function removeClaudeRegistration() {
  // claude mcp remove without --scope removes from the first scope it finds;
  // registrations can exist in several scopes, so sweep until get fails.
  const scopes = ['user', 'project', 'local'];
  let lastError = '';
  for (let attempt = 0; attempt < scopes.length + 1; attempt++) {
    if (spawnSync('claude', ['mcp', 'get', 'klauro'], { encoding: 'utf8' }).status !== 0) {
      report({ id: 'claude-deregister', status: 'pass', detail: 'Removed the klauro MCP registration from Claude Code.' });
      return;
    }
    const removed = spawnSync('claude', ['mcp', 'remove', 'klauro'], { encoding: 'utf8' });
    if (removed.status !== 0) {
      lastError = (removed.stderr || removed.stdout || '').trim().slice(0, 300);
      let removedAnyScope = false;
      for (const scope of scopes) {
        const scoped = spawnSync('claude', ['mcp', 'remove', '--scope', scope, 'klauro'], { encoding: 'utf8' });
        if (scoped.status === 0) removedAnyScope = true;
      }
      if (!removedAnyScope) break;
    }
  }
  if (spawnSync('claude', ['mcp', 'get', 'klauro'], { encoding: 'utf8' }).status !== 0) {
    report({ id: 'claude-deregister', status: 'pass', detail: 'Removed the klauro MCP registration from Claude Code.' });
    return;
  }
  report({
    id: 'claude-deregister',
    status: 'fail',
    detail: `claude mcp remove failed: ${lastError || 'registration still present after removal attempts'}`,
    fix: 'Run manually: claude mcp remove klauro (add --scope user|project|local if needed).',
  });
}

function parseArgs(argv) {
  const parsed = {
    deregister: true,
    claudeMdRepos: [],
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-deregister') parsed.deregister = false;
    else if (arg === '--claude-md') parsed.claudeMdRepos.push(argv[++i]);
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (!arg.startsWith('--')) parsed.claudeMdRepos.push(arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function printHelp() {
  print([
    'Usage: node scripts/uninstall.mjs [options]',
    '',
    'Reverses klauro install: removes the Claude Code MCP registration and the',
    'Klauro operating-loop block from CLAUDE.md files it wrote. Idempotent and',
    'safe to run when only partially installed.',
    '',
    'Does NOT delete analyzed data under ~/.klauro; use klauro purge for that.',
    '',
    'Options:',
    '  --claude-md <repo>     Remove the operating-loop block from <repo>/CLAUDE.md (repeatable)',
    '  --no-deregister        Skip claude mcp remove; print the command instead',
    '  -h, --help             Show this help',
  ].join('\n'));
}
