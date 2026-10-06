import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

export interface AnalysisPhaseTimings {
  queue_wait_ms: number;
  structural_ms?: number;
  ai_ms?: number;
  ai_concurrency: number;
  engine_ms?: number;
  engine_save_ms?: number;
  landing_ms: number;
  total_ms: number;
}

export interface PhaseTimingInput {
  queuedAt: string;
  startedAt?: string;
  workerFinishedAtMs: number;
  finishedAtMs: number;
  stageTimingsMs?: Record<string, number>;
}

const STRUCTURAL_STAGES = ['scan', 'parse', 'graph', 'decorators', 'structural'];
const DEFAULT_HOSTED_AI_CONCURRENCY = 16;

export function hostedAiConcurrency(): number {
  const configured = Number(process.env.KLAURO_AI_CONCURRENCY || '');
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_HOSTED_AI_CONCURRENCY;
}

function sumStages(stages: Record<string, number>, names: string[]): number {
  return names.reduce((total, name) => total + (stages[name] ?? 0), 0);
}

export function buildPhaseTimings(input: PhaseTimingInput): AnalysisPhaseTimings {
  const queuedAtMs = Date.parse(input.queuedAt);
  const startedAtMs = input.startedAt ? Date.parse(input.startedAt) : queuedAtMs;
  const stages = input.stageTimingsMs;
  return {
    queue_wait_ms: Math.max(0, startedAtMs - queuedAtMs),
    ...(stages ? {
      structural_ms: sumStages(stages, STRUCTURAL_STAGES),
      ai_ms: sumStages(stages, ['comprehension']),
      engine_ms: sumStages(stages, ['engine']),
      engine_save_ms: sumStages(stages, ['save']),
    } : {}),
    ai_concurrency: hostedAiConcurrency(),
    landing_ms: Math.max(0, input.finishedAtMs - input.workerFinishedAtMs),
    total_ms: Math.max(0, input.finishedAtMs - queuedAtMs),
  };
}

export function recordAnalysisStage(output: CASOutput, stage: string, durationMs: number | undefined): void {
  if (durationMs === undefined) return;
  const held = output.timings ?? { total_ms: 0 };
  output.timings = {
    ...held,
    total_ms: held.total_ms + durationMs,
    stages: { ...held.stages, [stage]: (held.stages?.[stage] ?? 0) + durationMs },
  };
}

export async function timeAnalysisStage(output: CASOutput, stage: string, run: () => Promise<void>): Promise<void> {
  const startedAt = Date.now();
  await run();
  recordAnalysisStage(output, stage, Date.now() - startedAt);
}
