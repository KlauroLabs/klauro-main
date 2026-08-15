import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import * as fs from 'fs-extra';
import { runVocabShapeGate } from './spec-purity-vocab-shapes';

const vocabulary = Array.from({ length: 12 }, (_, index) => `'term-${index}'`).join(', ');

async function fixture(
  baselineEntries: Array<{ file: string; name: string }>,
  allowlistEntries: Array<{ file: string; name: string; category: string; reason: string }>,
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-vocab-shape-'));
  const source = 'apps/mcp-server/src/example.ts';
  await fs.outputFile(path.join(root, source), `const TECHNICAL_TERMS = [${vocabulary}];\n`);
  await fs.outputJson(path.join(root, 'apps/mcp-server/src/spec-purity-vocab-baseline.json'), { entries: baselineEntries });
  await fs.outputJson(path.join(root, 'apps/mcp-server/src/spec-purity-vocab-allowlist.json'), { entries: allowlistEntries });
  return root;
}

test('unreviewed vocabulary shapes fail', async () => {
  const root = await fixture([], []);
  try {
    const result = await runVocabShapeGate(root);
    assert.equal(result.ok, false);
    assert.equal(result.newViolations.length, 1);
  } finally {
    await fs.remove(root);
  }
});

test('external reasoned attestations preserve comment-free production source', async () => {
  const file = 'apps/mcp-server/src/example.ts';
  const root = await fixture([], [{
    file,
    name: 'TECHNICAL_TERMS',
    category: 'closed-technical-taxonomy',
    reason: 'The protocol defines these values.',
  }]);
  try {
    const result = await runVocabShapeGate(root);
    assert.equal(result.ok, true);
    assert.equal(result.newViolations.length, 0);
  } finally {
    await fs.remove(root);
  }
});

test('deleted vocabulary shapes must be removed from the grandfathered baseline', async () => {
  const root = await fixture([{ file: 'apps/mcp-server/src/deleted.ts', name: 'OLD_TERMS' }], [{
    file: 'apps/mcp-server/src/example.ts',
    name: 'TECHNICAL_TERMS',
    category: 'closed-technical-taxonomy',
    reason: 'The protocol defines these values.',
  }]);
  try {
    const result = await runVocabShapeGate(root);
    assert.equal(result.ok, false);
    assert.deepEqual(result.staleBaselineEntries, ['apps/mcp-server/src/deleted.ts::OLD_TERMS']);
  } finally {
    await fs.remove(root);
  }
});
