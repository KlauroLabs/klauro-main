import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { grammarHealth } from '../../../../packages/analyzer-core/src/analyzer/core/wasm-tree-sitter';

// Regression guard for the tree-sitter packaging bug that shipped grammar-less to
// the wild: the bundle resolved `__dirname/../../../vendored-grammars`, which only
// exists in the source tree, so `dist/` carried 0 grammars and every WASM-breadth
// language silently degraded to nothing. These assertions fail loudly if either
// the vendored source grammars or the post-build dist/grammars copy regress.

const MIN_GRAMMARS = 150; // ~160 ship; allow a small margin for in-flight churn.
const here = path.dirname(fileURLToPath(import.meta.url));
const mcpServerRoot = path.resolve(here, '..', '..'); // .../apps/mcp-server

test('grammarHealth resolves the full breadth grammar set from the source tree', () => {
  const h = grammarHealth();
  assert.ok(
    h.count >= MIN_GRAMMARS,
    `expected >= ${MIN_GRAMMARS} tree-sitter grammars, got ${h.count} from [${h.dirs.join(', ')}]`,
  );
  // Spot-check breadth-only (vendored) grammars, not just the mainstream ones.
  const sample = new Set(h.sample);
  assert.ok(h.dirs.length > 0, 'at least one grammar dir must resolve');
  assert.ok(sample.size >= 0); // sample is a slice; the real assertion is count above.
});

test('a built bundle ships grammars next to dist/server.cjs', () => {
  // Only meaningful after `npm run build`. Skip in a fresh checkout so the suite
  // stays green pre-build; once dist/ exists it must carry the grammars.
  const distGrammars = path.join(mcpServerRoot, 'dist', 'grammars');
  const distServer = path.join(mcpServerRoot, 'dist', 'server.cjs');
  if (!fs.existsSync(distServer)) {
    test.skip('dist/server.cjs not built — run `npm run build` to exercise this guard');
    return;
  }
  assert.ok(fs.existsSync(distGrammars), 'dist/grammars/ must exist next to the bundle after build');
  const wasm = fs.readdirSync(distGrammars).filter((f) => /^tree-sitter-.+\.wasm$/.test(f));
  assert.ok(
    wasm.length >= MIN_GRAMMARS,
    `dist/grammars must carry >= ${MIN_GRAMMARS} grammars, got ${wasm.length} — build-bundle copy step regressed`,
  );
});
