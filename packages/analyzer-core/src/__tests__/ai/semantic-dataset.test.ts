import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  recordSemanticDecision,
  readSemanticDataset,
  semanticDatasetEnabled,
  resolveSemanticDatasetDir,
  SEMANTIC_DATASET_SCHEMA_VERSION,
  type SemanticDecisionRecord,
} from '../../ai/semantic-dataset';

describe('E1 semantic-dataset (observational instrumentation)', () => {
  const ORIGINAL_ENV = { ...process.env };
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-semantic-dataset-'));
    delete process.env.KLAURO_SEMANTIC_DATASET;
    delete process.env.KLAURO_SEMANTIC_DATASET_DIR;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup failure */
    }
  });

  const sampleRecord = (ts: number): SemanticDecisionRecord => ({
    ts,
    decision_type: 'system_description',
    prompt_version: 'system_description.v1',
    provider: 'test-provider',
    model: 'test-model',
    input_evidence_digest: { systemName: 'demo', frameworks: 2, entities: 5 },
    raw_output_excerpt: 'A grounded product description.',
    parse_ok: true,
    gate_verdict: 'accepted',
    mechanical_corrections: [],
    final_outcome: 'ai',
    confidence: 0.8,
  });

  it('is env-gated OFF by default (no-op, writes nothing)', () => {
    expect(semanticDatasetEnabled()).toBe(false);
    // Point the resolver at tmp so we can assert nothing is written even if the
    // gate leaked — but the DIR env would itself enable it, so assert via the
    // default (no dir) path: no file appears anywhere we can see.
    const ts = Date.parse('2026-07-13T12:00:00Z');
    recordSemanticDecision(sampleRecord(ts));
    // With no env set, enabled() is false and nothing is written to the tmp dir.
    expect(readSemanticDataset(ts, tmpDir)).toEqual([]);
  });

  it('enables when KLAURO_SEMANTIC_DATASET=1', () => {
    process.env.KLAURO_SEMANTIC_DATASET = '1';
    expect(semanticDatasetEnabled()).toBe(true);
  });

  it('enables and targets the dir when KLAURO_SEMANTIC_DATASET_DIR is set', () => {
    process.env.KLAURO_SEMANTIC_DATASET_DIR = tmpDir;
    expect(semanticDatasetEnabled()).toBe(true);
    expect(resolveSemanticDatasetDir()).toBe(tmpDir);
  });

  it('appends a schema-versioned record and reads it back (roundtrip)', () => {
    process.env.KLAURO_SEMANTIC_DATASET_DIR = tmpDir;
    const ts = Date.parse('2026-07-13T09:30:00Z');
    recordSemanticDecision(sampleRecord(ts));

    const rows = readSemanticDataset(ts, tmpDir);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.schema_version).toBe(SEMANTIC_DATASET_SCHEMA_VERSION);
    expect(row.decision_type).toBe('system_description');
    expect(row.gate_verdict).toBe('accepted');
    expect(row.final_outcome).toBe('ai');
    expect(row.input_evidence_digest).toEqual({ systemName: 'demo', frameworks: 2, entities: 5 });
    // Persisted under the YYYY-MM-DD partition derived from the caller ts.
    expect(fs.existsSync(path.join(tmpDir, '2026-07-13.jsonl'))).toBe(true);
  });

  it('partitions records by the caller-supplied day (UTC)', () => {
    process.env.KLAURO_SEMANTIC_DATASET_DIR = tmpDir;
    const day1 = Date.parse('2026-07-13T23:59:00Z');
    const day2 = Date.parse('2026-07-14T00:01:00Z');
    recordSemanticDecision(sampleRecord(day1));
    recordSemanticDecision(sampleRecord(day2));
    recordSemanticDecision(sampleRecord(day2));

    expect(readSemanticDataset(day1, tmpDir)).toHaveLength(1);
    expect(readSemanticDataset(day2, tmpDir)).toHaveLength(2);
    expect(fs.existsSync(path.join(tmpDir, '2026-07-13.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '2026-07-14.jsonl'))).toBe(true);
  });

  it('truncates oversized output excerpts (no unbounded blobs)', () => {
    process.env.KLAURO_SEMANTIC_DATASET_DIR = tmpDir;
    const ts = Date.parse('2026-07-13T10:00:00Z');
    const huge = 'x'.repeat(5000);
    recordSemanticDecision({ ...sampleRecord(ts), raw_output_excerpt: huge });
    const [row] = readSemanticDataset(ts, tmpDir);
    expect(row.raw_output_excerpt!.length).toBeLessThan(1000);
    expect(row.raw_output_excerpt).toContain('…[+');
  });

  it('swallows logging failures — never throws into the caller', () => {
    // Point the dir at a path whose parent is a FILE, so mkdir/append fails.
    const filePath = path.join(tmpDir, 'not-a-dir');
    fs.writeFileSync(filePath, 'blocker');
    process.env.KLAURO_SEMANTIC_DATASET_DIR = path.join(filePath, 'nested');
    const ts = Date.parse('2026-07-13T11:00:00Z');
    expect(() => recordSemanticDecision(sampleRecord(ts))).not.toThrow();
  });

  it('does NOT change comprehension output or mutate the evidence with logging ON', () => {
    // A stand-in for a comprehension gate: computes an output and logs a decision.
    const evidence = { systemName: 'demo', frameworks: 3 };
    const frozenEvidence = Object.freeze({ ...evidence });
    const comprehend = (): string => {
      const output = `${frozenEvidence.systemName}:${frozenEvidence.frameworks}`;
      recordSemanticDecision({
        ts: 1_700_000_000_000,
        decision_type: 'system_description',
        input_evidence_digest: { ...frozenEvidence },
        raw_output_excerpt: output,
        gate_verdict: 'accepted',
        final_outcome: 'ai',
      });
      return output;
    };

    // Logging OFF
    delete process.env.KLAURO_SEMANTIC_DATASET;
    delete process.env.KLAURO_SEMANTIC_DATASET_DIR;
    const outputOff = comprehend();

    // Logging ON
    process.env.KLAURO_SEMANTIC_DATASET_DIR = tmpDir;
    const outputOn = comprehend();

    // Byte-identical output regardless of logging state; evidence untouched.
    expect(outputOn).toBe(outputOff);
    expect(frozenEvidence).toEqual({ systemName: 'demo', frameworks: 3 });
    // And the ON run actually recorded (proving the logger ran, not that it was skipped).
    expect(readSemanticDataset(1_700_000_000_000, tmpDir)).toHaveLength(1);
  });
});
