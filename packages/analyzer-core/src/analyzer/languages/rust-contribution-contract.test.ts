import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { isRefreshableContribution } from '../core/incremental-contribution-refresh';
import { RustAnalyzer } from './rust-analyzer';

test('Rust project analysis returns non-graph fields that require a full rebuild when refreshed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-rust-contribution-'));
  try {
    await fs.ensureDir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'Cargo.toml'), '[package]\nname = "proof"\nversion = "0.1.0"\n');
    await fs.writeFile(path.join(root, 'src', 'lib.rs'), 'pub fn ready() -> bool { true }\n');
    const contribution = await new RustAnalyzer().analyze({ projectPath: root });
    assert.equal('cas_version' in contribution, false);
    assert.equal('analysis_id' in contribution, false);
    assert.equal('analysis_timestamp' in contribution, false);
    assert.equal('analyzer_contributions' in contribution, false);
    assert.ok((contribution.perspectives || []).length > 0);
    assert.equal(isRefreshableContribution(contribution), false);
  } finally {
    await fs.remove(root);
  }
});
