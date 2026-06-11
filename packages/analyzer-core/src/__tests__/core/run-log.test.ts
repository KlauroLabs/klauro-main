import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AnalysisRunLog,
  getAnalysisRunLogPath,
  readRecentRunRecords,
  type AnalysisRunFinalRecord,
  type AnalysisRunRecord,
} from '../../analyzer/core/run-log';
import type { CASAnalysisError } from '../../types/cas.types';

describe('AnalysisRunLog', () => {
  let tempDir: string;
  const savedEnv: Record<string, string | undefined> = {};
  const envNames = ['KLAURO_LOG_DIR', 'KLAURO_RUN_LOG', 'KLAURO_RUN_LOG_MAX_RUNS', 'KLAURO_RUN_LOG_MAX_BYTES'];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-run-log-test-'));
    for (const name of envNames) {
      savedEnv[name] = process.env[name];
      delete process.env[name];
    }
    process.env.KLAURO_LOG_DIR = tempDir;
  });

  afterEach(() => {
    for (const name of envNames) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function readRecords(): AnalysisRunRecord[] {
    const filePath = getAnalysisRunLogPath();
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line));
  }

  function sampleTotals() {
    return { nodes: 10, edges: 20, entry_points: 2, exit_points: 1, files: 5, errors: 0, warnings: 1 };
  }

  it('writes a start record and a complete record with phases, analyzers, AI outcome, and totals', () => {
    const runLog = new AnalysisRunLog('/tmp/example-project', 'analysis_run_1', '1.11.0');
    const phaseStart = Date.now() - 25;
    runLog.recordPhase('languageAnalyzers', phaseStart, 25);
    runLog.recordAnalyzers([
      { analyzer_id: 'typescript-javascript', analyzer_type: 'language', execution_time_ms: 25, nodes_created: 10, edges_created: 20, warnings: ['partial parse'] },
    ]);
    runLog.recordAi({
      provider_configured: false,
      providers: [],
      attempted: false,
      outcome: 'ai_skipped',
      reason: 'no-ai-provider-configured',
      duration_ms: 0,
      description_source: 'deterministic',
    });
    runLog.recordWarnings([
      { severity: 'warning', code: 'PARTIAL_ANALYSIS', message: 'partial parse', analyzer: 'typescript-javascript', recoverable: true },
    ]);
    runLog.complete(sampleTotals());

    const records = readRecords();
    expect(records).toHaveLength(2);
    expect(records[0].event).toBe('run-start');
    expect(records[0].run_id).toBe('analysis_run_1');
    expect(records[0].project_name).toBe('example-project');

    const final = records[1] as AnalysisRunFinalRecord;
    expect(final.event).toBe('run-complete');
    expect(final.cas_version).toBe('1.11.0');
    expect(final.phases).toEqual([
      expect.objectContaining({ phase: 'languageAnalyzers', duration_ms: 25 }),
    ]);
    expect(final.analyzers).toEqual([
      expect.objectContaining({
        analyzer_id: 'typescript-javascript',
        nodes_contributed: 10,
        edges_contributed: 20,
        warning_count: 1,
      }),
    ]);
    expect(final.ai).toEqual(expect.objectContaining({ outcome: 'ai_skipped', reason: 'no-ai-provider-configured' }));
    expect(final.warnings).toEqual([
      expect.objectContaining({ code: 'PARTIAL_ANALYSIS', severity: 'warning' }),
    ]);
    expect(final.totals).toEqual(sampleTotals());
    expect(final.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('writes a run-failed record with the error message and no totals', () => {
    const runLog = new AnalysisRunLog('/tmp/example-project', 'analysis_run_fail', '1.11.0');
    runLog.fail(new Error('EACCES: permission denied, scandir /tmp/example-project/src'));

    const records = readRecords();
    expect(records).toHaveLength(2);
    const final = records[1] as AnalysisRunFinalRecord;
    expect(final.event).toBe('run-failed');
    expect(final.error?.message).toContain('EACCES');
    expect(final.totals).toBeUndefined();
  });

  it('only writes one final record even if complete and fail are both called', () => {
    const runLog = new AnalysisRunLog('/tmp/example-project', 'analysis_run_once', '1.11.0');
    runLog.complete(sampleTotals());
    runLog.fail(new Error('late failure'));

    const records = readRecords();
    expect(records).toHaveLength(2);
    expect(records[1].event).toBe('run-complete');
  });

  it('rotates the log to the configured maximum number of runs, dropping oldest first', () => {
    process.env.KLAURO_RUN_LOG_MAX_RUNS = '5';
    for (let i = 0; i < 8; i++) {
      const runLog = new AnalysisRunLog('/tmp/example-project', `analysis_run_${i}`, '1.11.0');
      runLog.complete(sampleTotals());
    }

    const records = readRecords();
    const runIds = [...new Set(records.map(record => record.run_id))];
    expect(runIds).toEqual(['analysis_run_3', 'analysis_run_4', 'analysis_run_5', 'analysis_run_6', 'analysis_run_7']);
    expect(records).toHaveLength(10);
  });

  it('rotates the log under the configured byte cap', () => {
    process.env.KLAURO_RUN_LOG_MAX_BYTES = '2000';
    const noisyErrors: CASAnalysisError[] = Array.from({ length: 10 }, (_, i) => ({
      severity: 'warning',
      code: 'PARTIAL_ANALYSIS',
      message: `warning ${i} ${'x'.repeat(80)}`,
    }));
    for (let i = 0; i < 6; i++) {
      const runLog = new AnalysisRunLog('/tmp/example-project', `analysis_big_${i}`, '1.11.0');
      runLog.recordWarnings(noisyErrors);
      runLog.complete(sampleTotals());
    }

    const filePath = getAnalysisRunLogPath();
    expect(fs.statSync(filePath).size).toBeLessThanOrEqual(2000 + 4096);
    const records = readRecords();
    const runIds = [...new Set(records.map(record => record.run_id))];
    expect(runIds.length).toBeLessThan(6);
    expect(runIds[runIds.length - 1]).toBe('analysis_big_5');
  });

  it('truncates long warning messages and reports warning overflow', () => {
    const longMessage = 'y'.repeat(1200);
    const manyErrors: CASAnalysisError[] = Array.from({ length: 60 }, () => ({
      severity: 'warning',
      code: 'PARTIAL_ANALYSIS',
      message: longMessage,
    }));
    const runLog = new AnalysisRunLog('/tmp/example-project', 'analysis_run_trunc', '1.11.0');
    runLog.recordWarnings(manyErrors);
    runLog.complete(sampleTotals());

    const final = readRecords()[1] as AnalysisRunFinalRecord;
    expect(final.warnings).toHaveLength(50);
    expect(final.warning_overflow).toBe(10);
    expect(final.warnings[0].message.length).toBeLessThan(600);
    expect(final.warnings[0].message).toContain('[truncated]');
  });

  it('writes nothing when KLAURO_RUN_LOG=false', () => {
    process.env.KLAURO_RUN_LOG = 'false';
    const runLog = new AnalysisRunLog('/tmp/example-project', 'analysis_run_disabled', '1.11.0');
    runLog.complete(sampleTotals());
    expect(fs.existsSync(getAnalysisRunLogPath())).toBe(false);
  });

  it('readRecentRunRecords skips corrupted lines', () => {
    const runLog = new AnalysisRunLog('/tmp/example-project', 'analysis_run_read', '1.11.0');
    runLog.complete(sampleTotals());
    fs.appendFileSync(getAnalysisRunLogPath(), '{not json\n');

    const records = readRecentRunRecords();
    expect(records).toHaveLength(2);
    expect(records[1].run_id).toBe('analysis_run_read');
  });
});
