import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { analyzeForBench } from '../src/gauntlet/product-analysis';
import {
  generateTerminalPublicCorpusReceipts,
  resolveTerminalReceiptSourceIdentity,
} from '../src/gauntlet/terminal-public-corpus-receipt-generator';

const packageRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(packageRoot, '../..');
const answerRoot = process.env.KLAURO_AI_CACHE_PATH;
if (!answerRoot) throw new Error('KLAURO_AI_CACHE_PATH is required');

void generateTerminalPublicCorpusReceipts({
  repoRoot,
  fixturePath: path.join(packageRoot, 'src/gauntlet/fixtures/terminality-public-corpus.json'),
  answerRoot,
  dependencies: {
    analyze: root => analyzeForBench(root, { readinessRequirement: 'complete' }),
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
