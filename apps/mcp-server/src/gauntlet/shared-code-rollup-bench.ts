/**
 * Shared-code rollup bench — validates the cross-deployable shared-code rollup
 * built in cross-codebase-analysis.ts (`buildSharedCodeRollup`, surfaced as
 * `WorkspaceAnalysisGraph.shared_code_rollup`).
 *
 * THE GAP (docs/SPEC-ENTITY-MODEL.md, dogfooded on zerac-api): a monorepo's
 * `libs/*` shared code is detected as usage (cross-repo/cross-app import
 * volume) but was never rolled up into a queryable field answering "which
 * shared lib does each deployable depend on, and what surface does it use."
 *
 * This bench runs a REAL analysis (via analyzeForBench, the same blackbox
 * entry point used elsewhere in gauntlet/ — no engine internals imported) on
 * a small fixture monorepo with one shared lib (`libs/auth`) consumed by two
 * deployables (`apps/service-a`, `apps/service-b`) with a partially
 * overlapping symbol surface, then asserts the rollup composes correctly:
 * both consumers appear, usage/consumed-surface is non-empty, and blast
 * radius correctly attributes each symbol to the deployables using it.
 */

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
