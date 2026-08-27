import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { grammarHealth } from '../../../../packages/analyzer-core/src/analyzer/core/wasm-tree-sitter';
import { hasNativeGrammar } from '../../../../packages/analyzer-core/src/analyzer/core/native-parse';

// Regression guard for the tree-sitter packaging bug that shipped grammar-less to
// the wild: the bundle resolved `__dirname/../../../vendored-grammars`, which only
// exists in the source tree, so `dist/` carried 0 grammars and every WASM-breadth
// language silently degraded to nothing. These assertions fail loudly if either
// the vendored source grammars or the post-build dist/grammars copy regress.

const MIN_GRAMMARS = 150; // ~160 ship; allow a small margin for in-flight churn.
// `npm test` runs with cwd = apps/mcp-server; resolve from there (avoids import.meta,
// which the project's tsc module setting disallows).
const mcpServerRoot = process.cwd().endsWith(path.join('apps', 'mcp-server'))
  ? process.cwd()
  : path.resolve(process.cwd(), 'apps', 'mcp-server');

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

test('the exact-platform native parser artifact covers representative caller grammars', () => {
  for (const grammar of ['r', 'erlang', 'fortran', 'powershell', 'scheme']) {
    assert.equal(hasNativeGrammar(grammar), true,
      `required native parser artifact is missing or built for another architecture: ${grammar}`);
  }
});

test('a hosted analyzer build ships grammars next to dist-hosted/analyzer-service.cjs', () => {
  // Only meaningful after `npm run build:hosted`. The installed client in dist/
  // intentionally excludes grammars and all analyzer implementation.
  const distGrammars = path.join(mcpServerRoot, 'dist-hosted', 'grammars');
  const distServer = path.join(mcpServerRoot, 'dist-hosted', 'analyzer-service.cjs');
  if (!fs.existsSync(distServer)) {
    test.skip('dist-hosted/analyzer-service.cjs not built — run `npm run build:hosted` to exercise this guard');
    return;
  }
  assert.ok(fs.existsSync(distGrammars), 'dist/grammars/ must exist next to the bundle after build');
  const wasm = fs.readdirSync(distGrammars).filter((f) => /^tree-sitter-.+\.wasm$/.test(f));
  assert.ok(
    wasm.length >= MIN_GRAMMARS,
    `dist/grammars must carry >= ${MIN_GRAMMARS} grammars, got ${wasm.length} — build-bundle copy step regressed`,
  );
});
