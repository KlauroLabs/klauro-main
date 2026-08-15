


















import * as path from 'path';
import { analyzeForBench } from './product-analysis';
import {
  buildCrossCodebaseSystemGraph,
  type CrossCodebaseInput,
  type CrossCodebaseSystemGraph,
  type WorkspaceSharedCodeRollup,
} from '../cross-codebase-analysis';

const FIXTURE_DIR = path.resolve(__dirname, '..', '..', 'fixtures', 'shared-code-rollup-bench', 'monorepo');
const WORKSPACE_NAME = 'shared-code-rollup-fixture';

export interface SharedCodeRollupBenchResult {
  graph: CrossCodebaseSystemGraph;
  rollup: WorkspaceSharedCodeRollup[];
  authRollup: WorkspaceSharedCodeRollup | undefined;
}

let cached: SharedCodeRollupBenchResult | null = null;

export function _resetSharedCodeRollupBenchCache(): void {
  cached = null;
}

export async function runSharedCodeRollupBench(): Promise<SharedCodeRollupBenchResult> {
  if (cached) return cached;
  const cas = await analyzeForBench(FIXTURE_DIR);
  const repository: CrossCodebaseInput = { path: FIXTURE_DIR, name: WORKSPACE_NAME, cas };
  const graph = buildCrossCodebaseSystemGraph(WORKSPACE_NAME, [repository]);
  const rollup = graph.shared_code_rollup;
  const authRollup = rollup.find(item => item.lib_name === 'auth');
  cached = { graph, rollup, authRollup };
  return cached;
}
