import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { analyzeProject } from '../src/analyzer';
import {
  generateTerminalPublicCorpusReceipts,
  resolveTerminalReceiptSourceIdentity,
} from '../src/gauntlet/terminal-public-corpus-receipt-generator';

const packageRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(packageRoot, '../..');

void generateTerminalPublicCorpusReceipts({
  repoRoot,
  fixturePath: path.join(packageRoot, 'src/gauntlet/fixtures/terminality-public-corpus.json'),
  semanticTraceRoot: path.join(packageRoot, '.terminal-public-corpus-semantic'),
  dependencies: {
    analyze: root => analyzeProject(root, undefined, { persist: false }),
    resolveSourceIdentity: resolveTerminalReceiptSourceIdentity,
    runTerminalGate: root => {
      execFileSync(process.execPath, [
        path.join(root, 'apps/mcp-server/scripts/test-suite.mjs'),
        '--concurrency', '1',
        '--file', 'src/gauntlet/terminal-capability-gate.test.ts',
      ], {
        cwd: path.join(root, 'apps/mcp-server'),
        env: { ...process.env, KLAURO_AI_ENABLED: 'false' },
        stdio: 'inherit',
      });
    },
  },
}).catch(error => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
