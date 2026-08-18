jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AxumAnalyzer } from '../../analyzer/frameworks/rust/axum-analyzer';

describe('AxumAnalyzer', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-axum-'));
    fs.writeFileSync(path.join(root, 'Cargo.toml'), '[dependencies]\naxum = "0.8"\n');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('ignores documented router examples while retaining executable routes', async () => {
    fs.writeFileSync(path.join(root, 'main.rs'), [
      'use axum::{routing::get, Router};',
      '/// ```',
      '/// Router::new().route("/ghost", get(ghost_handler))',
      '/// ```',
      'async fn real_handler() {}',
      'fn router() -> Router {',
      '  Router::new().route("/real", get(real_handler))',
      '}',
    ].join('\n'));

    const analyzer = new AxumAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: root });
    const routes = contribution.entry_points || [];
    const nodeIds = new Set((contribution.nodes || []).map(node => node.id));

    expect(routes.map(route => route.trigger?.path)).toEqual(['/real']);
    expect(routes[0].handler?.method_name).toBe('real_handler');
    expect(nodeIds.has(routes[0].source_node)).toBe(true);
    expect(nodeIds.has(routes[0].handler?.node_id || '')).toBe(true);
  });
});
