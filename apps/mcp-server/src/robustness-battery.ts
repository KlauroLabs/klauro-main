import * as fs from 'fs-extra';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';

const FUZZ_ROOT = '/tmp/klauro-fuzz';
const CASE_TIMEOUT_SECONDS = 120;
const APP_DIR = path.resolve(__dirname, '..');

interface FuzzCase {
  name: string;
  description: string;
  expectHonestSignal?: boolean;
  generate: (dir: string) => Promise<void>;
}

interface CaseVerdict {
  name: string;
  pass: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  nodes: number | null;
  edges: number | null;
  failures: string[];
  honestSignals: string[];
}

const SUPPORTED_EXTENSIONS = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'java', 'cs', 'go', 'rs', 'php', 'rb', 'dart', 'vue', 'tf',
];

function repeatToBytes(line: string, targetBytes: number): string {
  const chunk = `${line}\n`;
  const count = Math.ceil(targetBytes / Buffer.byteLength(chunk));
  return chunk.repeat(count);
}

async function writeLargeFile(filePath: string, chunk: Buffer | string, totalBytes: number): Promise<void> {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const stream = fs.createWriteStream(filePath);
  let written = 0;
  await new Promise<void>((resolve, reject) => {
    stream.on('error', reject);
    const writeMore = () => {
      while (written < totalBytes) {
        written += buffer.length;
        if (!stream.write(buffer)) {
          stream.once('drain', writeMore);
          return;
        }
      }
      stream.end(() => resolve());
    };
    writeMore();
  });
}

const CASES: FuzzCase[] = [
  {
    name: 'empty-dir',
    description: 'Completely empty directory',
    generate: async () => {},
  },
  {
    name: 'binaries-only',
    description: 'Directory containing only binary files with random bytes',
    generate: async dir => {
      for (let i = 0; i < 4; i++) {
        await fs.writeFile(path.join(dir, `image-${i}.png`), crypto.randomBytes(1024 * 1024));
        await fs.writeFile(path.join(dir, `blob-${i}.bin`), crypto.randomBytes(2 * 1024 * 1024));
      }
    },
  },
  {
    name: 'symlink-cycle',
    description: 'Directory symlink cycle a -> b -> a',
    generate: async dir => {
      await fs.mkdirp(path.join(dir, 'a'));
      await fs.mkdirp(path.join(dir, 'b'));
      await fs.symlink(path.join(dir, 'b'), path.join(dir, 'a', 'to-b'));
      await fs.symlink(path.join(dir, 'a'), path.join(dir, 'b', 'to-a'));
      await fs.writeFile(path.join(dir, 'index.ts'), 'export function entry(): number { return 1; }\n');
    },
  },
  {
    name: 'symlink-to-root',
    description: 'Symlink pointing at the filesystem root',
    generate: async dir => {
      await fs.symlink('/', path.join(dir, 'escape'));
      await fs.symlink('/etc', path.join(dir, 'etc-link'));
      await fs.writeFile(path.join(dir, 'index.ts'), 'export const value = 42;\n');
    },
  },
  {
    name: 'giant-text-300mb',
    description: 'Single 300MB text file',
    generate: async dir => {
      const chunk = Buffer.from('the quick brown fox jumps over the lazy dog 0123456789\n'.repeat(2048));
      await writeLargeFile(path.join(dir, 'notes.txt'), chunk, 300 * 1024 * 1024);
    },
  },
  {
    name: 'giant-ts-50mb',
    description: 'Single 50MB TypeScript source file',
    expectHonestSignal: true,
    generate: async dir => {
      const lines: string[] = [];
      for (let i = 0; i < 1000; i++) {
        lines.push(`export function generated${i}(input: number): number { return input + ${i}; }`);
      }
      const block = `${lines.join('\n')}\n`;
      await writeLargeFile(path.join(dir, 'big.ts'), block, 50 * 1024 * 1024);
    },
  },
  {
    name: 'flat-30k-files',
    description: 'Flat directory with 30000 files',
    generate: async dir => {
      for (let i = 0; i < 29000; i++) {
        await fs.writeFile(path.join(dir, `data-${i}.txt`), `record ${i}\n`);
      }
      for (let i = 0; i < 1000; i++) {
        await fs.writeFile(path.join(dir, `module-${i}.ts`), `export const value${i} = ${i};\n`);
      }
    },
  },
  {
    name: 'non-utf8-sources',
    description: 'Latin-1 bytes and embedded NUL bytes in source files',
    generate: async dir => {
      const latin1Py = Buffer.concat([
        Buffer.from('def caf', 'utf8'),
        Buffer.from([0xe9]),
        Buffer.from('():\n    return "caf', 'utf8'),
        Buffer.from([0xe9, 0xff, 0xfe]),
        Buffer.from('"\n', 'utf8'),
      ]);
      await fs.writeFile(path.join(dir, 'latin.py'), latin1Py);
      const latin1Ts = Buffer.concat([
        Buffer.from('export const city = "M', 'utf8'),
        Buffer.from([0xfc]),
        Buffer.from('nchen";\n', 'utf8'),
      ]);
      await fs.writeFile(path.join(dir, 'latin.ts'), latin1Ts);
      const nulTs = Buffer.concat([
        Buffer.from('export const start = 1;\n', 'utf8'),
        Buffer.from([0x00, 0x00, 0x00]),
        Buffer.from('\nexport const end = 2;\n', 'utf8'),
      ]);
      await fs.writeFile(path.join(dir, 'embedded-nul.ts'), nulTs);
    },
  },
  {
    name: 'long-lines',
    description: 'Source files with 10k-character lines',
    generate: async dir => {
      const longString = 'a'.repeat(10_000);
      const tsLines: string[] = [];
      for (let i = 0; i < 50; i++) {
        tsLines.push(`export const text${i} = "${longString}";`);
      }
      await fs.writeFile(path.join(dir, 'long-lines.ts'), `${tsLines.join('\n')}\n`);
      const statements: string[] = [];
      for (let i = 0; i < 2000; i++) statements.push(`var v${i}=${i};`);
      await fs.writeFile(path.join(dir, 'minified.js'), `${statements.join('')}\n`);
    },
  },
  {
    name: 'deep-nesting-200',
    description: '200-level deep directory nesting',
    generate: async dir => {
      let current = dir;
      for (let i = 0; i < 200; i++) {
        current = path.join(current, `d${i}`);
      }
      await fs.mkdirp(current);
      await fs.writeFile(path.join(current, 'leaf.ts'), 'export const depth = 200;\n');
      await fs.writeFile(path.join(dir, 'index.ts'), 'export const shallow = true;\n');
    },
  },
  {
    name: 'permission-denied-subdir',
    description: 'Subdirectory with mode 000',
    expectHonestSignal: true,
    generate: async dir => {
      await fs.writeFile(path.join(dir, 'readable.ts'), 'export function readable(): string { return "ok"; }\n');
      const secret = path.join(dir, 'secret');
      await fs.mkdirp(secret);
      await fs.writeFile(path.join(secret, 'hidden.ts'), 'export const hidden = true;\n');
      await fs.chmod(secret, 0o000);
    },
  },
  {
    name: 'broken-syntax',
    description: 'Broken syntax in every parsed language',
    expectHonestSignal: true,
    generate: async dir => {
      const garbage: Record<string, string> = {
        'broken.ts': 'export function ((( {{{ const class =>\n}}}}',
        'broken.tsx': 'const App = () => <div><span></div>;\nexport default function ((',
        'broken.js': 'function f( { if (true { return; }\n)))',
        'broken.jsx': 'export default () => <><div </>;',
        'broken.py': 'def broken(:\n    return (((\nclass :::',
        'broken.java': 'public class Broken { void method( { if } }}}',
        'broken.cs': 'namespace Broken { class { void ( } }',
        'broken.go': 'package main\nfunc broken( { if } }}}',
        'broken.rs': 'fn broken( -> { match }}}',
        'broken.php': '<?php function broken( { if ( } }}}',
        'broken.rb': 'def broken(\n  if\nend end end',
        'broken.dart': 'class Broken { void method( { if } }}}',
      };
      for (const [name, content] of Object.entries(garbage)) {
        await fs.writeFile(path.join(dir, name), content);
      }
    },
  },
  {
    name: 'invalid-package-json',
    description: 'package.json that is invalid JSON',
    expectHonestSignal: true,
    generate: async dir => {
      await fs.writeFile(path.join(dir, 'package.json'), '{ "name": "broken", "dependencies": { "left-pad": ');
      await fs.writeFile(path.join(dir, 'index.ts'), 'export const ok = true;\n');
    },
  },
  {
    name: 'corrupt-git',
    description: '.git that is a corrupt regular file',
    generate: async dir => {
      await fs.writeFile(path.join(dir, '.git'), crypto.randomBytes(4096));
      await fs.writeFile(path.join(dir, 'index.ts'), 'export function main(): void {}\n');
    },
  },
  {
    name: 'sanitization-collisions',
    description: 'File names that collide with object prototype members',
    generate: async dir => {
      await fs.writeFile(path.join(dir, '__proto__.ts'), 'export const proto = 1;\n');
      await fs.writeFile(path.join(dir, 'constructor.py'), 'def constructor():\n    return 1\n');
      await fs.writeFile(path.join(dir, 'prototype.js'), 'module.exports = { prototype: 1 };\n');
      await fs.writeFile(path.join(dir, 'hasOwnProperty.ts'), 'export const owned = true;\n');
      await fs.writeFile(path.join(dir, 'toString.py'), 'def to_string():\n    return ""\n');
    },
  },
  {
    name: 'zero-byte-files',
    description: 'Zero-byte files for every supported extension',
    generate: async dir => {
      for (const extension of SUPPORTED_EXTENSIONS) {
        await fs.writeFile(path.join(dir, `empty.${extension}`), '');
      }
      await fs.writeFile(path.join(dir, 'package.json'), '{ "name": "zero-byte-fixture", "version": "1.0.0" }\n');
    },
  },
];

function collectHonestSignals(cas: any): string[] {
  const signals: string[] = [];
  for (const entry of cas?.analysis_errors || []) {
    signals.push(entry?.message ? `${entry.code || 'ANALYSIS_ERROR'}: ${entry.message}` : JSON.stringify(entry));
  }
  for (const warning of cas?.analysis_warnings || []) {
    signals.push(typeof warning === 'string' ? warning : JSON.stringify(warning));
  }
  for (const contribution of cas?.analyzer_contributions || []) {
    for (const error of contribution?.errors || []) signals.push(String(error));
    for (const warning of contribution?.warnings || []) signals.push(String(warning));
  }
  for (const warning of cas?.validation?.validation_warnings || []) {
    signals.push(warning?.message ? String(warning.message) : JSON.stringify(warning));
  }
  return signals;
}

async function makeDirectoryRemovable(target: string): Promise<void> {
  let entries: fs.Dirent[];
  try {
    await fs.chmod(target, 0o700);
    entries = await fs.readdir(target, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await makeDirectoryRemovable(path.join(target, entry.name));
    }
  }
}

async function prepareCaseDir(caseDir: string): Promise<void> {
  if (await fs.pathExists(caseDir)) {
    await makeDirectoryRemovable(caseDir);
    await fs.rm(caseDir, { recursive: true, force: true });
  }
  await fs.mkdirp(caseDir);
}

interface ChildResult {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stderr: string;
}

function runCaseInChild(caseDir: string, outFile: string): Promise<ChildResult> {
  const tsxBin = path.join(APP_DIR, 'node_modules', '.bin', 'tsx');
  const scriptPath = path.join(APP_DIR, 'src', 'robustness-battery.ts');
  const startedAt = Date.now();

  return new Promise(resolve => {
    const child = spawn(
      'gtimeout',
      ['--kill-after=15', String(CASE_TIMEOUT_SECONDS), tsxBin, scriptPath, '--run-case', caseDir, '--out', outFile],
      {
        cwd: APP_DIR,
        env: {
          ...process.env,
          KLAURO_AI_INTERPRETATION: 'false',
          KLAURO_AI_INTERPRETATION_FORCE: 'false',
          KLAURO_AI_ELEMENT_DESCRIPTIONS: 'false',
          KLAURO_EMBEDDING_ENABLED: 'false',
          KLAURO_STORAGE_PATH: path.join(FUZZ_ROOT, '.storage'),
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );

    let stderr = '';
    child.stderr.on('data', chunk => {
      if (stderr.length < 1024 * 1024) stderr += chunk.toString();
    });
    child.on('error', error => {
      resolve({ exitCode: null, timedOut: false, durationMs: Date.now() - startedAt, stderr: String(error) });
    });
    child.on('close', code => {
      resolve({
        exitCode: code,
        timedOut: code === 124 || code === 137,
        durationMs: Date.now() - startedAt,
        stderr,
      });
    });
  });
}

const STDERR_FAILURE_MARKERS = [
  'unhandledRejection',
  'UnhandledPromiseRejection',
  'uncaughtException',
  'FATAL ERROR',
  'Segmentation fault',
  'JavaScript heap out of memory',
];

async function evaluateCase(fuzzCase: FuzzCase, result: ChildResult, outFile: string): Promise<CaseVerdict> {
  const failures: string[] = [];
  let nodes: number | null = null;
  let edges: number | null = null;
  let honestSignals: string[] = [];

  if (result.timedOut) {
    failures.push(`timed out after ${CASE_TIMEOUT_SECONDS}s (exit ${result.exitCode})`);
  } else if (result.exitCode !== 0) {
    failures.push(`exited with code ${result.exitCode}`);
  }

  for (const marker of STDERR_FAILURE_MARKERS) {
    if (result.stderr.includes(marker)) {
      failures.push(`stderr contains "${marker}"`);
    }
  }

  if (result.exitCode === 0) {
    try {
      const raw = await fs.readFile(outFile, 'utf8');
      const cas = JSON.parse(raw);
      if (!Array.isArray(cas.nodes)) failures.push('CAS nodes is not an array');
      else nodes = cas.nodes.length;
      if (!Array.isArray(cas.edges)) failures.push('CAS edges is not an array');
      else edges = cas.edges.length;
      if (nodes !== null) {
        const badNode = cas.nodes.find(
          (node: any) => !node || typeof node.id !== 'string' || node.id.length === 0,
        );
        if (badNode) failures.push(`CAS contains node without a valid string id: ${JSON.stringify(badNode).slice(0, 200)}`);
      }
      honestSignals = collectHonestSignals(cas);
      if (fuzzCase.expectHonestSignal && honestSignals.length === 0) {
        failures.push('expected an honest analysis warning/gap signal but CAS is silent');
      }
    } catch (error) {
      failures.push(`CAS output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    name: fuzzCase.name,
    pass: failures.length === 0,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    nodes,
    edges,
    failures,
    honestSignals,
  };
}

function formatReport(verdicts: CaseVerdict[]): string {
  const lines: string[] = [];
  lines.push('# Klauro Analyzer Robustness Battery Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Per-case timeout: ${CASE_TIMEOUT_SECONDS}s, AI off, isolated child process per case.`);
  lines.push('');
  lines.push('| Case | Verdict | Exit | Duration | Nodes | Edges | Notes |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const verdict of verdicts) {
    const notes = verdict.pass
      ? verdict.honestSignals.length > 0
        ? `${verdict.honestSignals.length} honest warning(s)`
        : ''
      : verdict.failures.join('; ');
    lines.push(
      `| ${verdict.name} | ${verdict.pass ? 'PASS' : 'FAIL'} | ${verdict.exitCode ?? 'spawn-error'} | ${(verdict.durationMs / 1000).toFixed(1)}s | ${verdict.nodes ?? '-'} | ${verdict.edges ?? '-'} | ${notes.replace(/\|/g, '\\|')} |`,
    );
  }
  lines.push('');
  const failed = verdicts.filter(verdict => !verdict.pass);
  lines.push(`Result: ${verdicts.length - failed.length}/${verdicts.length} cases passed.`);
  if (failed.length > 0) {
    lines.push('');
    lines.push('## Failures');
    for (const verdict of failed) {
      lines.push('');
      lines.push(`### ${verdict.name}`);
      for (const failure of verdict.failures) lines.push(`- ${failure}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

async function runChildCase(caseDir: string, outFile: string): Promise<void> {
  const { createOrchestrator } = await import('./analyzer');
  const orchestrator = createOrchestrator();
  const cas = await orchestrator.orchestrateAnalysis(caseDir);
  await fs.writeFile(outFile, JSON.stringify(cas));
}

async function runBattery(filterNames: string[]): Promise<void> {
  const selected = filterNames.length > 0
    ? CASES.filter(fuzzCase => filterNames.includes(fuzzCase.name))
    : CASES;
  if (selected.length === 0) {
    console.error(`No cases match: ${filterNames.join(', ')}`);
    console.error(`Available cases: ${CASES.map(fuzzCase => fuzzCase.name).join(', ')}`);
    process.exit(2);
  }

  await fs.mkdirp(FUZZ_ROOT);
  const verdicts: CaseVerdict[] = [];

  for (const fuzzCase of selected) {
    const caseDir = path.join(FUZZ_ROOT, fuzzCase.name);
    const outFile = path.join(FUZZ_ROOT, `${fuzzCase.name}.cas.json`);
    process.stdout.write(`[battery] ${fuzzCase.name}: generating... `);
    await prepareCaseDir(caseDir);
    await fuzzCase.generate(caseDir);
    await fs.rm(outFile, { force: true });
    process.stdout.write('analyzing... ');
    const result = await runCaseInChild(caseDir, outFile);
    const verdict = await evaluateCase(fuzzCase, result, outFile);
    verdicts.push(verdict);
    console.log(`${verdict.pass ? 'PASS' : 'FAIL'} (${(verdict.durationMs / 1000).toFixed(1)}s)${verdict.pass ? '' : ` -> ${verdict.failures.join('; ')}`}`);
    if (fuzzCase.name === 'permission-denied-subdir') {
      await makeDirectoryRemovable(caseDir);
    }
  }

  const report = formatReport(verdicts);
  const reportPath = path.join(FUZZ_ROOT, 'REPORT.md');
  await fs.writeFile(reportPath, report);
  console.log(`\nReport written to ${reportPath}`);
  const failed = verdicts.filter(verdict => !verdict.pass);
  console.log(`Battery result: ${verdicts.length - failed.length}/${verdicts.length} passed.`);
  process.exit(failed.length > 0 ? 1 : 0);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const runCaseIndex = argv.indexOf('--run-case');
  if (runCaseIndex !== -1) {
    const caseDir = argv[runCaseIndex + 1];
    const outIndex = argv.indexOf('--out');
    const outFile = outIndex !== -1 ? argv[outIndex + 1] : undefined;
    if (!caseDir || !outFile) {
      console.error('Usage: robustness-battery --run-case <dir> --out <file>');
      process.exit(2);
    }
    await runChildCase(caseDir, outFile);
    return;
  }

  const filterNames: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--case' && argv[i + 1]) filterNames.push(argv[++i]);
  }
  await runBattery(filterNames);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
