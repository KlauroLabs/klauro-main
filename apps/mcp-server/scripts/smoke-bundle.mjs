import { spawn } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = path.join(packageRoot, 'dist', 'index.cjs');
const maxStartupMs = Number(process.env.KLAURO_SMOKE_MAX_STARTUP_MS || 600);

if (!existsSync(bundlePath)) {
  console.error(`Bundle not found at ${bundlePath}. Run npm run build first.`);
  process.exit(1);
}

function probeProfile(profile) {
  return new Promise((resolve, reject) => {
    const startedAt = process.hrtime.bigint();
    const child = spawn(process.execPath, [bundlePath], {
      env: { ...process.env, KLAURO_TOOL_PROFILE: profile },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const result = {
      profile,
      initializeMs: null,
      instructions: false,
      toolNames: [],
      handoverToolCount: null,
      stderr: '',
    };
    let stdoutBuffer = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`[${profile}] probe timed out after 20s; stderr: ${result.stderr}`));
    }, 20000);

    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      if (error) reject(error);
      else resolve(result);
    };

    child.stderr.on('data', chunk => {
      result.stderr += chunk.toString();
    });
    child.on('error', finish);

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
          finish(new Error(`[${profile}] non-JSON line on stdout: ${line.slice(0, 200)}`));
          return;
        }
        if (message.id === 1) {
          result.initializeMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
          result.instructions = typeof message.result?.instructions === 'string'
            && message.result.instructions.length > 0;
        }
        if (message.id === 2) {
          result.toolNames = (message.result?.tools || []).map(tool => tool.name);
          setTimeout(() => {
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' })}\n`);
          }, 3000);
        }
        if (message.id === 3) {
          result.handoverToolCount = (message.result?.tools || []).length;
          finish();
          return;
        }
      }
    });

    child.stdin.write([
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'klauro-smoke', version: '1.0.0' },
        },
      }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      '',
    ].join('\n'));
  });
}

function assertCheck(condition, label, failures) {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}`);
  if (!condition) failures.push(label);
}

const failures = [];

const core = await probeProfile('core');
assertCheck(core.initializeMs !== null && core.initializeMs <= maxStartupMs,
  `core: initialize answered in ${core.initializeMs?.toFixed(0)}ms (limit ${maxStartupMs}ms)`, failures);
assertCheck(core.instructions, 'core: instructions field present', failures);
assertCheck(core.toolNames.length === 13, `core: exactly 13 tools (got ${core.toolNames.length})`, failures);
assertCheck(core.toolNames.includes('klauro_query'), 'core: klauro_query gateway tool present', failures);
assertCheck(core.handoverToolCount === core.toolNames.length,
  `core: real server answers tools/list after handover with same count (got ${core.handoverToolCount})`, failures);
assertCheck(core.stderr.trim() === '', `core: no stderr output at startup (got: ${core.stderr.trim().slice(0, 200) || 'none'})`, failures);

const full = await probeProfile('full');
assertCheck(full.initializeMs !== null && full.initializeMs <= maxStartupMs,
  `full: initialize answered in ${full.initializeMs?.toFixed(0)}ms (limit ${maxStartupMs}ms)`, failures);
assertCheck(full.instructions, 'full: instructions field present', failures);
assertCheck(full.toolNames.length >= 150, `full: at least 150 tools (got ${full.toolNames.length})`, failures);
assertCheck(full.handoverToolCount === full.toolNames.length,
  `full: real server answers tools/list after handover with same count (got ${full.handoverToolCount})`, failures);
assertCheck(full.stderr.trim() === '', `full: no stderr output at startup (got: ${full.stderr.trim().slice(0, 200) || 'none'})`, failures);

if (failures.length > 0) {
  console.error(`\nBundle smoke failed: ${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log('\nBundle smoke passed.');
