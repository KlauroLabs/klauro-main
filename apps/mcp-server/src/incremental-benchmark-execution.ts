import type { IncrementalAnalysisResult } from './analyzer';
import {
  captureCasGraphFingerprint,
  compareCasGraphFingerprint,
  type CasGraphEquivalence,
  type CasGraphFingerprint,
} from './incremental-graph-equivalence';

export interface IncrementalRunEvidence {
  durationMs: number;
  wasFullRebuild: boolean;
  fullRebuildReason?: string;
  changeReport: IncrementalAnalysisResult['changeReport'];
  output: {
    nodes: number;
    edges: number;
    entryPoints: number;
    exitPoints: number;
    analysisErrors: number;
  };
}

export function requiresIncrementalGitBaseline(
  useGitBaseline: boolean | undefined,
  analysisPath: 'in-process-harness' | 'klauro-product' | undefined,
): boolean {
  return Boolean(useGitBaseline || analysisPath === 'klauro-product');
}

export async function captureIncrementalRun(
  analyze: () => Promise<IncrementalAnalysisResult>,
): Promise<IncrementalRunEvidence> {
  return incrementalRunEvidence(await timed(analyze));
}

export async function captureInitialIncrementalRun(
  analyze: () => Promise<IncrementalAnalysisResult>,
  selectEdit: (output: IncrementalAnalysisResult['output']) => Promise<string | null>,
  workspace: string,
  durationOverrideMs?: number,
): Promise<{ evidence: IncrementalRunEvidence; editFile: string; editSelectionMs: number }> {
  const measured = await timed(analyze);
  const editSelectionStartedAt = Date.now();
  const editFile = await selectEdit(measured.value.output);
  const editSelectionMs = Math.max(1, Date.now() - editSelectionStartedAt);
  if (!editFile) throw new Error(`No editable source file found in copied repo: ${workspace}`);
  const evidence = incrementalRunEvidence(measured);
  if (durationOverrideMs !== undefined) evidence.durationMs = Math.max(1, durationOverrideMs);
  return { evidence, editFile, editSelectionMs };
}

export async function captureEditedIncrementalRun<TContext, TTokenProof>(
  analyze: () => Promise<IncrementalAnalysisResult>,
  buildContext: (output: IncrementalAnalysisResult['output']) => Promise<TContext>,
  buildTokenProof: (context: TContext) => Promise<TTokenProof>,
  captureFingerprint: boolean,
): Promise<{
  evidence: IncrementalRunEvidence;
  context: TContext;
  contextGenerationMs: number;
  tokenProof: TTokenProof;
  tokenProofMs: number;
  fingerprint?: CasGraphFingerprint;
}> {
  const measured = await timed(analyze);
  const contextStartedAt = Date.now();
  const context = await buildContext(measured.value.output);
  const contextGenerationMs = Math.max(1, Date.now() - contextStartedAt);
  const tokenProofStartedAt = Date.now();
  const tokenProof = await buildTokenProof(context);
  const tokenProofMs = Math.max(1, Date.now() - tokenProofStartedAt);
  const fingerprint = captureFingerprint ? captureCasGraphFingerprint(measured.value.output) : undefined;
  return {
    evidence: incrementalRunEvidence(measured),
    context,
    contextGenerationMs,
    tokenProof,
    tokenProofMs,
    fingerprint,
  };
}

export async function verifyFullGraph(
  analyze: () => Promise<IncrementalAnalysisResult['output']>,
  fingerprint: CasGraphFingerprint,
): Promise<{ durationMs: number; parity: CasGraphEquivalence }> {
  const measured = await timed(analyze);
  return {
    durationMs: measured.durationMs,
    parity: compareCasGraphFingerprint(fingerprint, measured.value),
  };
}

function incrementalRunEvidence(measured: Timed<IncrementalAnalysisResult>): IncrementalRunEvidence {
  const output = measured.value.output;
  return {
    durationMs: measured.durationMs,
    wasFullRebuild: measured.value.wasFullRebuild,
    fullRebuildReason: measured.value.fullRebuildReason,
    changeReport: measured.value.changeReport,
    output: {
      nodes: output.nodes.length,
      edges: output.edges.length,
      entryPoints: output.entry_points?.length || 0,
      exitPoints: output.exit_points?.length || 0,
      analysisErrors: output.analysis_errors?.length || 0,
    },
  };
}

interface Timed<T> {
  value: T;
  durationMs: number;
}

async function timed<T>(operation: () => Promise<T>): Promise<Timed<T>> {
  const startedAt = Date.now();
  return { value: await operation(), durationMs: Math.max(1, Date.now() - startedAt) };
}
