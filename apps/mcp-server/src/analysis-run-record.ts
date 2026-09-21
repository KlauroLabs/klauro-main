import { AnalysisRunLog } from '../../../packages/analyzer-core/src/analyzer/core/run-log';
import { CAS_VERSION, type CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

function runId(): string {
  return `analysis_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

export async function recorded(
  projectPath: string,
  analyze: () => Promise<CASOutput>
): Promise<CASOutput> {
  const log = new AnalysisRunLog(projectPath, runId(), CAS_VERSION);
  let analyzed: CASOutput;
  try {
    analyzed = await analyze();
  } catch (error) {
    log.fail(error);
    throw error;
  }
  log.complete({
    nodes: analyzed.nodes.length,
    edges: analyzed.edges.length,
    entry_points: analyzed.entry_points?.length ?? 0,
    exit_points: analyzed.exit_points?.length ?? 0,
    files: analyzed.analyzer_contributions[0]?.analysis_scope?.files_analyzed ?? 0,
    errors: 0,
    warnings: 0,
  });
  return analyzed;
}
