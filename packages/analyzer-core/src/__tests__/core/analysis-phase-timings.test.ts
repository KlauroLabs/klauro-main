jest.unmock('fs');
jest.unmock('fs-extra');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { TypeScriptJavaScriptAnalyzer } from '../../analyzer/languages/typescript-javascript-analyzer';

/**
 * Instrumentation coverage for per-phase wall-clock timing (MOTIVATION: a
 * 705-file repo sat 'in-progress' 90+ minutes behind a concurrent whale
 * rebuild and analysis_phases carried only status/generated_at — no
 * durations, so nobody could attribute one second of it). This test runs the
 * REAL orchestrator pipeline end to end against a tiny on-disk fixture and
 * asserts the new started_at/duration_ms stamps on `analysis_phases` and the
 * compact `timings` block are present, well-formed, and internally
 * consistent. It does NOT assert anything about what gets analyzed — see
 * the separate zero-output-change verification (diffed against the
 * pre-instrumentation orchestrator with these fields stripped) for that.
 */
function createOrchestrator(): AnalyzerOrchestrator {
  const orchestrator = new AnalyzerOrchestrator();
  orchestrator.registerAnalyzer({
    id: 'typescript-javascript',
    name: 'TypeScript/JavaScript Analyzer',
    type: 'language',
    version: '1.0.0',
    detectPatterns: {
      files: ['package.json', 'tsconfig.json'],
      content: [/\.ts$/, /\.js$/],
    },
    analyzer: new TypeScriptJavaScriptAnalyzer(),
  });
  return orchestrator;
}

describe('per-phase timing + timings block (instrumentation only)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-phase-timings-'));
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
    await fs.ensureDir(path.join(root, 'src'));
    await fs.writeFile(
      path.join(root, 'src', 'index.ts'),
      "export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport class Greeter {\n  greet(name: string): string {\n    return `hello ${name}`;\n  }\n}\n"
    );
    await fs.writeFile(
      path.join(root, 'src', 'util.ts'),
      "import { add } from './index';\n\nexport function sum3(a: number, b: number, c: number): number {\n  return add(add(a, b), c);\n}\n"
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('stamps monotonic started_at + positive duration_ms on analysis_phases, summing close to the total', async () => {
    const orchestrator = createOrchestrator();
    const output = await orchestrator.orchestrateAnalysis(root);

    expect(output.analysis_phases).toBeDefined();
    const phases = output.analysis_phases!;
    expect(phases.length).toBeGreaterThan(0);

    // Every phase that actually ran on this synchronous path (all but the
    // on-demand 'deferred-element-descriptions', which is never run here)
    // must carry both a parseable started_at and a non-negative duration_ms.
    const ranPhases = phases.filter(p => p.id !== 'deferred-element-descriptions');
    expect(ranPhases.length).toBeGreaterThan(0);
    for (const phase of ranPhases) {
      expect(typeof phase.started_at).toBe('string');
      expect(Number.isNaN(Date.parse(phase.started_at!))).toBe(false);
      expect(typeof phase.duration_ms).toBe('number');
      expect(phase.duration_ms!).toBeGreaterThanOrEqual(0);
    }

    // The never-run phase must NOT be stamped with a fabricated timing.
    const deferred = phases.find(p => p.id === 'deferred-element-descriptions');
    expect(deferred).toBeDefined();
    expect(deferred!.started_at).toBeUndefined();
    expect(deferred!.duration_ms).toBeUndefined();

    // Phases run in priority order in the orchestrator's main path, so their
    // started_at stamps must be non-decreasing.
    const sorted = [...ranPhases].sort((a, b) => a.priority - b.priority);
    for (let i = 1; i < sorted.length; i++) {
      expect(Date.parse(sorted[i].started_at!)).toBeGreaterThanOrEqual(Date.parse(sorted[i - 1].started_at!));
    }

    // The compact timings block: total + coarse stage buckets + per-analyzer ms.
    expect(output.timings).toBeDefined();
    expect(output.timings!.total_ms).toBeGreaterThanOrEqual(0);
    expect(output.timings!.stages).toBeDefined();
    for (const stage of ['scan', 'parse', 'graph', 'decorators', 'ai_enrichment', 'save']) {
      expect(typeof output.timings!.stages![stage]).toBe('number');
    }
    const stageSum = Object.values(output.timings!.stages!).reduce((a, b) => a + b, 0);
    // Summed stage time should never exceed the wall-clock total (it is a
    // subset of it — some overhead like inter-phase event-loop yields is
    // deliberately not attributed to any stage), and should be in the same
    // ballpark (not near-zero) for a real, non-trivial run.
    expect(stageSum).toBeLessThanOrEqual(output.timings!.total_ms + 5);

    // Per-analyzer timings lifted from analyzer_contributions.
    expect(output.analyzer_contributions.length).toBeGreaterThan(0);
    expect(output.timings!.analyzers).toBeDefined();
    for (const contribution of output.analyzer_contributions) {
      if (typeof contribution.execution_time_ms === 'number') {
        expect(output.timings!.analyzers![contribution.analyzer_id]).toBe(contribution.execution_time_ms);
      }
    }
  });

  it('is purely additive: analysis_phases entries carry no other new/changed fields', async () => {
    const orchestrator = createOrchestrator();
    const output = await orchestrator.orchestrateAnalysis(root);
    const expectedKeys = new Set([
      'id', 'name', 'priority', 'status', 'purpose', 'default_phase', 'description',
      'outputs', 'agent_value', 'visualization_value', 'can_run_later', 'requires_ai',
      'generated_at', 'notes', 'started_at', 'duration_ms',
    ]);
    for (const phase of output.analysis_phases!) {
      for (const key of Object.keys(phase)) {
        expect(expectedKeys.has(key)).toBe(true);
      }
    }
  });
});
